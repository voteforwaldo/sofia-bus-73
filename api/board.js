import { cacheGet, cacheSet } from "../lib/server-cache.js";
import { fetchGtfsFallbackBoard } from "../lib/gtfs-fallback.js";

const UPSTREAM = "https://api.livetransport.eu/sofia/virtual-board";
const RETRIES = 2;

async function fetchLiveBoard(stopId, limit) {
  const target = `${UPSTREAM}/${encodeURIComponent(stopId)}?limit=${encodeURIComponent(limit)}`;
  let lastError;

  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetch(target, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });

      const body = await response.text();
      if (!response.ok) {
        lastError = new Error(`Upstream ${response.status}`);
        continue;
      }

      if (!body.trim().startsWith("{")) {
        lastError = new Error("Invalid upstream response");
        continue;
      }

      return { body, source: "livetransport" };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Upstream unavailable");
}

export default async function handler(req, res) {
  const { stopId, limit = "40" } = req.query;

  if (!stopId) {
    res.status(400).json({ error: "Missing stopId" });
    return;
  }

  const cacheKey = `board:${stopId}:${limit}`;

  try {
    const live = await fetchLiveBoard(stopId, limit);
    await cacheSet(cacheKey, { body: live.body, savedAt: Date.now() }, 1800);

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=60");
    res.setHeader("X-Data-Source", live.source);
    res.status(200).send(live.body);
  } catch {
    const cached = await cacheGet(cacheKey);
    if (cached?.body) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=30");
      res.setHeader("X-Data-Source", "kv-stale");
      res.setHeader("X-Data-Stale", "true");
      res.status(200).send(cached.body);
      return;
    }

    try {
      const fallback = await fetchGtfsFallbackBoard(stopId, limit);
      const body = JSON.stringify({ departures: fallback.departures, stale: true, source: fallback.source });
      await cacheSet(cacheKey, { body, savedAt: Date.now() }, 900);

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "public, max-age=30");
      res.setHeader("X-Data-Source", fallback.source);
      res.setHeader("X-Data-Stale", "true");
      res.status(200).send(body);
    } catch {
      res.status(502).json({ error: "Upstream API unavailable" });
    }
  }
}
