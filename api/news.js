import { cacheGet, cacheSet } from "../lib/server-cache.js";
import { fallbackNewsBrief, parseRssTitles } from "../lib/rss.js";

const CACHE_SECONDS = 45 * 60;
const GEMINI_MODEL = "gemini-2.5-flash-lite";

const RSS_FEEDS = [
  "https://news.google.com/rss?hl=bg&gl=BG&ceid=BG:BG",
  "https://www.mediapool.bg/rss/",
];

async function fetchHeadlines() {
  for (const feedUrl of RSS_FEEDS) {
    try {
      const response = await fetch(feedUrl, {
        headers: { "User-Agent": "sofia-bus-73/1.0" },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) continue;

      const xml = await response.text();
      const titles = parseRssTitles(xml, 10);
      if (titles.length >= 3) return titles;
    } catch {
      // try next feed
    }
  }

  return [];
}

async function summarizeWithGemini(headlines) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || headlines.length === 0) return null;

  const prompt = `Ето актуални заглавия от българските новини:
${headlines.map((title, index) => `${index + 1}. ${title}`).join("\n")}

Избери 3-те най-важни новини за България днес и ги обобщи в ТОЧНО 1 кратко изречение на български.
Без markdown, без списък, без водещи думи като "Днес". Максимум 220 знака.`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 180,
        },
      }),
    },
  );

  if (!response.ok) return null;

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) return null;

  return `💡 ${text.replace(/^💡\s*/, "")}`;
}

export default async function handler(_req, res) {
  const cacheKey = "news:bg:daily";
  const cached = await cacheGet(cacheKey);
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=900");
    res.status(200).json(cached);
    return;
  }

  try {
    const headlines = await fetchHeadlines();
    const brief =
      (await summarizeWithGemini(headlines)) ?? fallbackNewsBrief(headlines);

    const payload = {
      brief,
      headlines: headlines.slice(0, 5),
      source: process.env.GEMINI_API_KEY ? "gemini+rss" : "rss",
      updatedAt: Date.now(),
    };

    await cacheSet(cacheKey, payload, CACHE_SECONDS);

    res.setHeader("Cache-Control", "public, max-age=900");
    res.status(200).json(payload);
  } catch {
    res.status(502).json({ error: "News unavailable" });
  }
}
