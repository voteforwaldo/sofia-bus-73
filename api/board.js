export default async function handler(req, res) {
  const { stopId, limit = "40" } = req.query;

  if (!stopId) {
    res.status(400).json({ error: "Missing stopId" });
    return;
  }

  const target = `https://api.livetransport.eu/sofia/virtual-board/${encodeURIComponent(stopId)}?limit=${encodeURIComponent(limit)}`;

  try {
    const response = await fetch(target, {
      headers: { Accept: "application/json" },
    });

    const body = await response.text();

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    res.status(response.status).send(body);
  } catch {
    res.status(502).json({ error: "Upstream API unavailable" });
  }
}
