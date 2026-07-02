const memoryCache = new Map();
const CACHE_MS = 20 * 60 * 1000;

const RAIN_CODES = new Set([
  51, 52, 53, 54, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99,
]);

function weatherLabel(code) {
  if (code === 0) return "ясно";
  if (code <= 3) return "облачно";
  if (RAIN_CODES.has(code)) return "дъжд";
  if (code >= 71 && code <= 77) return "сняг";
  if (code === 45 || code === 48) return "мъгла";
  return "променливо";
}

function analyzeForecast(payload) {
  const current = payload.current;
  const hours = payload.hourly.time.slice(0, 6).map((time, index) => ({
    time,
    precipitation: payload.hourly.precipitation[index] ?? 0,
    probability: payload.hourly.precipitation_probability[index] ?? 0,
    code: payload.hourly.weather_code[index] ?? current.weather_code,
  }));

  const willRainSoon = hours.some(
    (hour) =>
      hour.precipitation > 0.1 ||
      hour.probability >= 45 ||
      RAIN_CODES.has(hour.code),
  );

  return {
    temperature: current.temperature_2m,
    feelsLike: current.apparent_temperature,
    condition: weatherLabel(current.weather_code),
    windSpeed: current.wind_speed_10m,
    willRainSoon,
    nextHours: hours,
  };
}

async function fetchOpenMeteo(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    timezone: "Europe/Sofia",
    current: "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
    hourly: "precipitation_probability,precipitation,weather_code",
    forecast_hours: "6",
  });

  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!response.ok) {
    throw new Error("Weather provider unavailable");
  }

  return response.json();
}

async function summarizeWithGemini(stopName, analysis) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const prompt = `Ти си кратък български метео асистент. На база РЕАЛНИ данни за спирка "${stopName}" в София, напиши точно 2 кратки изречения на български:
1) какво е времето сега (температура и условия)
2) дали ЩЕ ВАЛИ СКОРО в следващите 1-3 часа (ясно кажи "да" или "не")

Данни:
${JSON.stringify(analysis, null, 2)}

Пиши само текста, без markdown и без списъци.`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 180,
        },
      }),
    },
  );

  if (!response.ok) return null;

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
}

function fallbackSummary(stopName, analysis) {
  const rainText = analysis.willRainSoon
    ? "Да, очаква се дъжд скоро — вземи чадър."
    : "Не, дъжд скоро не се очаква.";

  return `При ${stopName} сега е около ${Math.round(analysis.temperature)}°C и ${analysis.condition}. ${rainText}`;
}

export default async function handler(req, res) {
  const { stopId, lat, lon, name } = req.query;

  if (!stopId || !lat || !lon || !name) {
    res.status(400).json({ error: "Missing stop weather parameters" });
    return;
  }

  const cacheKey = `${stopId}:${lat}:${lon}`;
  const cached = memoryCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < CACHE_MS) {
    res.setHeader("Cache-Control", "public, max-age=600");
    res.status(200).json(cached.payload);
    return;
  }

  try {
    const forecast = await fetchOpenMeteo(lat, lon);
    const analysis = analyzeForecast(forecast);
    const summary =
      (await summarizeWithGemini(name, analysis)) ?? fallbackSummary(name, analysis);

    const payload = {
      summary,
      willRainSoon: analysis.willRainSoon,
      temperature: analysis.temperature,
      condition: analysis.condition,
      source: process.env.GEMINI_API_KEY ? "gemini+open-meteo" : "open-meteo",
    };

    memoryCache.set(cacheKey, { savedAt: Date.now(), payload });

    res.setHeader("Cache-Control", "public, max-age=600");
    res.status(200).json(payload);
  } catch {
    res.status(502).json({ error: "Weather unavailable" });
  }
}
