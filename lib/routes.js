import { enrichDeparture, LINE_ID, matchMladost, matchOvchaKupel } from "./transit.js";

export const ROUTES = {
  "to-tokuda": {
    id: "to-tokuda",
    label: "Към Токуда",
    emoji: "🏥",
    boardingStopId: "bulgaria",
    destinationStopId: "tokuda",
    directionLabel: "ж.к. Младост",
    matchDirection: matchMladost,
    fallbackRideMinutes: 14,
  },
  "to-bulgaria": {
    id: "to-bulgaria",
    label: "Към България",
    emoji: "🌇",
    boardingStopId: "tokuda",
    destinationStopId: "bulgaria",
    directionLabel: "ж.к. Овча купел 2",
    matchDirection: matchOvchaKupel,
    fallbackRideMinutes: 14,
  },
};

export function getRoute(routeId) {
  return ROUTES[routeId] ?? ROUTES["to-tokuda"];
}

export function buildTripIndex(departuresByPhysicalStop) {
  const index = new Map();

  for (const [physicalStopId, departures] of departuresByPhysicalStop) {
    for (const departure of departures) {
      if (departure.lineId !== LINE_ID || !departure.tripId) continue;

      const enriched = enrichDeparture(departure);
      if (!index.has(departure.tripId)) {
        index.set(departure.tripId, []);
      }

      index.get(departure.tripId).push({
        physicalStopId,
        arrivalTime: enriched.arrivalTime,
        departure: enriched,
      });
    }
  }

  return index;
}

export function findDestinationArrival(tripId, boardingArrival, destinationStopIds, tripIndex) {
  const entries = tripIndex.get(tripId) ?? [];
  const destinationSet = new Set(destinationStopIds);
  const candidates = entries
    .filter((entry) => destinationSet.has(entry.physicalStopId))
    .map((entry) => entry.arrivalTime)
    .filter((time) => typeof time === "number" && time > boardingArrival);

  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

export function buildJourney(boardingDeparture, route, destinationStopIds, tripIndex) {
  const boardingArrival = boardingDeparture.arrivalTime;
  const matchedDestination = findDestinationArrival(
    boardingDeparture.tripId,
    boardingArrival,
    destinationStopIds,
    tripIndex,
  );

  const rideEstimated = matchedDestination === null;
  const destinationArrival =
    matchedDestination ?? boardingArrival + route.fallbackRideMinutes * 60_000;
  const rideMs = destinationArrival - boardingArrival;

  return {
    ...boardingDeparture,
    destinationArrival,
    rideMinutes: Math.max(1, Math.round(rideMs / 60_000)),
    rideEstimated,
  };
}

export function buildJourneysForRoute(
  route,
  boardingDepartures,
  destinationStopIds,
  tripIndex,
  now = Date.now(),
) {
  return boardingDepartures
    .map((departure) => buildJourney(departure, route, destinationStopIds, tripIndex))
    .filter((journey) => journey.arrivalTime > now - 60_000);
}

export function getJourneyBreakdown(journey, walkingMinutes, now = Date.now()) {
  const walkMs = walkingMinutes * 60_000;
  const boardingArrival = journey.arrivalTime;
  const destinationArrival = journey.destinationArrival;

  const waitMs = Math.max(0, boardingArrival - now - walkMs);
  const totalMs = Math.max(0, destinationArrival - now);

  return {
    walkMinutes: walkingMinutes,
    waitMinutes: Math.round(waitMs / 60_000),
    rideMinutes: journey.rideMinutes,
    rideEstimated: journey.rideEstimated,
    destinationArrival,
    boardingArrival,
    totalMinutes: Math.max(1, Math.round(totalMs / 60_000)),
  };
}

export function getLeaveMessageForJourney(boardingArrival, walkingMinutes, now = Date.now()) {
  const leaveIn = boardingArrival - now - walkingMinutes * 60_000;

  if (leaveIn <= 0) {
    return { text: "🏃 Тръгни сега!", className: "leave-now urgent" };
  }

  return {
    text: `🚶 Тръгни след ${formatMinutesShort(leaveIn)}`,
    className: leaveIn <= 2 * 60_000 ? "leave-now soon" : "leave-now",
  };
}

function formatMinutesShort(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) return `${seconds} сек`;
  if (minutes < 60) return seconds > 0 ? `${minutes} мин ${seconds} сек` : `${minutes} мин`;
  return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}
