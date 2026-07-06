function decodeXml(text) {
  return text
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function parseRssTitles(xml, limit = 8) {
  if (!xml || typeof xml !== "string") return [];

  const titles = [];
  const itemRegex = /<item[\s\S]*?<\/item>/gi;
  const titleRegex = /<title>([\s\S]*?)<\/title>/i;

  for (const item of xml.match(itemRegex) ?? []) {
    const match = item.match(titleRegex);
    if (!match) continue;

    const title = decodeXml(match[1].trim());
    if (!title || title.toLowerCase() === "google news") continue;
    titles.push(title);
    if (titles.length >= limit) break;
  }

  return titles;
}

export function fallbackNewsBrief(headlines) {
  if (!headlines.length) {
    return "💡 Новините са временно недостъпни.";
  }

  const top = headlines.slice(0, 3).join("; ");
  return `💡 Днес в България: ${top}.`;
}
