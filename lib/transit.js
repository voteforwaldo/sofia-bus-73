export const LINE_ID = "TB39";

export function matchOvchaKupel(destination) {
  const text = `${destination?.bg ?? ""} ${destination?.en ?? ""}`.toLowerCase();
  return /овча купел|ovcha kupel/.test(text);
}

export function matchMladost(destination) {
  const text = `${destination?.bg ?? ""} ${destination?.en ?? ""}`.toLowerCase();
  return /младост|mladost/.test(text);
}

export function enrichDeparture(departure) {
  const scheduled = departure.time?.scheduled;
  const actual = departure.time?.actual ?? scheduled;
  const delayMinutes =
    typeof scheduled === "number" && typeof actual === "number"
      ? Math.round((actual - scheduled) / 60_000)
      : 0;

  const isLive = Boolean(departure.activeTrip);
  const hasGpsEstimate = Boolean(departure.estimatedPosition);

  return {
    ...departure,
    arrivalTime: actual,
    scheduledTime: scheduled,
    delayMinutes,
    isLive,
    hasGpsEstimate,
    confidence: getConfidence({ isLive, delayMinutes, hasGpsEstimate, scheduled, actual }),
  };
}

export function getConfidence({ isLive, delayMinutes, hasGpsEstimate, scheduled, actual }) {
  if (hasGpsEstimate) {
    return {
      level: "low",
      label: "оценка",
      hint: "Няма GPS — времето е пресметнато от закъснение",
      className: "confidence-low",
    };
  }

  if (isLive && typeof scheduled === "number" && typeof actual === "number") {
    return {
      level: "high",
      label: "GPS на живо",
      hint: "Прогноза от автобуса — може да изостава 1–2 мин от реалността",
      className: "confidence-high",
    };
  }

  if (isLive) {
    return {
      level: "medium",
      label: "на път",
      hint: "Автобусът е активен, но без пълни GPS данни",
      className: "confidence-medium",
    };
  }

  if (typeof scheduled === "number" && typeof actual === "number" && Math.abs(delayMinutes) >= 1) {
    return {
      level: "medium",
      label: "по разписание + закъснение",
      hint: "Обновено закъснение без активен GPS",
      className: "confidence-medium",
    };
  }

  return {
    level: "low",
    label: "по разписание",
    hint: "Само планово време — възможно отклонение",
    className: "confidence-low",
  };
}

export function getStatusBadge(departure) {
  if (!departure.isLive && departure.confidence?.level === "low") {
    return { text: "по разписание", className: "status-scheduled" };
  }

  if (departure.delayMinutes >= 3) {
    return { text: `+${departure.delayMinutes} мин`, className: "status-late" };
  }

  if (departure.delayMinutes <= -2) {
    return { text: `${Math.abs(departure.delayMinutes)} мин по-рано`, className: "status-early" };
  }

  return { text: "навреме", className: "status-ontime" };
}

export function filterLine73Departures(departures, matchDirection, now = Date.now()) {
  return departures
    .filter((departure) => {
      if (departure.lineId !== LINE_ID) return false;
      if (departure.source === "gtfs-rt") return true;
      return matchDirection(departure.destination);
    })
    .map(enrichDeparture)
    .filter((departure) => {
      if (typeof departure.arrivalTime !== "number") return false;
      const graceMs = departure.isLive ? 20_000 : 60_000;
      return departure.arrivalTime > now - graceMs;
    })
    .sort((a, b) => a.arrivalTime - b.arrivalTime);
}

export function dedupeDepartures(departures) {
  const unique = [];
  const seen = new Set();

  for (const departure of departures) {
    const key = `${departure.tripId}-${departure.arrivalTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(departure);
  }

  return unique;
}

export function parseBoardResponse(raw) {
  if (!raw.trim().startsWith("{")) {
    throw new Error("Invalid board response");
  }

  const data = JSON.parse(raw);
  return data.departures ?? [];
}
