const HISTORY_KEY = "bus73-delay-history";
const MAX_SAMPLES_PER_HOUR = 40;
const SOFIA_TZ = "Europe/Sofia";

function getSofiaHour(timestamp = Date.now()) {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: SOFIA_TZ,
      hour: "numeric",
      hour12: false,
    }).format(new Date(timestamp)),
  );
}

export function recordDelay(stopId, delayMinutes, timestamp = Date.now()) {
  if (typeof delayMinutes !== "number" || Number.isNaN(delayMinutes)) return;

  const hour = getSofiaHour(timestamp);
  let history;

  try {
    history = JSON.parse(localStorage.getItem(HISTORY_KEY)) ?? {};
  } catch {
    history = {};
  }

  if (!history[stopId]) history[stopId] = {};
  if (!history[stopId][hour]) history[stopId][hour] = [];

  history[stopId][hour].push(delayMinutes);
  if (history[stopId][hour].length > MAX_SAMPLES_PER_HOUR) {
    history[stopId][hour] = history[stopId][hour].slice(-MAX_SAMPLES_PER_HOUR);
  }

  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

export function getTypicalDelay(stopId, timestamp = Date.now()) {
  const hour = getSofiaHour(timestamp);

  try {
    const history = JSON.parse(localStorage.getItem(HISTORY_KEY)) ?? {};
    const samples = history[stopId]?.[hour] ?? [];
    if (samples.length < 3) return null;

    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return { median, samples: samples.length, hour };
  } catch {
    return null;
  }
}

export function formatTypicalDelay(typical) {
  if (!typical) return null;

  if (typical.median >= 3) {
    return `Обикновено +${typical.median} мин около ${typical.hour}:00 (${typical.samples} измервания)`;
  }

  if (typical.median <= -2) {
    return `Обикновено ${Math.abs(typical.median)} мин по-рано около ${typical.hour}:00`;
  }

  return `Обикновено навреме около ${typical.hour}:00`;
}
