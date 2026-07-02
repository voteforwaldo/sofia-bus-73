import { describe, expect, it } from "vitest";
import {
  buildJourney,
  buildTripIndex,
  findDestinationArrival,
  getJourneyBreakdown,
  ROUTES,
} from "./routes.js";
import { matchMladost, matchOvchaKupel } from "./transit.js";

describe("route directions", () => {
  it("uses Mladost when boarding at Bulgaria for Tokuda", () => {
    expect(ROUTES["to-tokuda"].matchDirection).toBe(matchMladost);
    expect(ROUTES["to-tokuda"].directionLabel).toContain("Младост");
  });

  it("uses Ovcha Kupel when boarding at Tokuda for Bulgaria", () => {
    expect(ROUTES["to-bulgaria"].matchDirection).toBe(matchOvchaKupel);
    expect(ROUTES["to-bulgaria"].directionLabel).toContain("Овча купел");
  });
});

describe("buildTripIndex", () => {
  it("indexes departures by tripId", () => {
    const index = buildTripIndex(
      new Map([
        [
          "0290",
          [
            {
              tripId: "trip-1",
              lineId: "TB39",
              time: { scheduled: 1000, actual: 1000 },
              destination: { bg: "ж.к. Овча купел 2" },
            },
          ],
        ],
        [
          "0205",
          [
            {
              tripId: "trip-1",
              lineId: "TB39",
              time: { scheduled: 1000, actual: 1900 },
              destination: { bg: "ж.к. Овча купел 2" },
            },
          ],
        ],
      ]),
    );

    expect(index.get("trip-1")).toHaveLength(2);
  });
});

describe("findDestinationArrival", () => {
  it("finds later arrival at destination stop", () => {
    const index = new Map([
      [
        "trip-1",
        [
          { physicalStopId: "0290", arrivalTime: 1000 },
          { physicalStopId: "0205", arrivalTime: 1900 },
        ],
      ],
    ]);

    expect(findDestinationArrival("trip-1", 1000, ["0205", "0206"], index)).toBe(1900);
  });
});

describe("buildJourney", () => {
  it("uses matched destination time when available", () => {
    const route = ROUTES["to-tokuda"];
    const index = new Map([
      [
        "trip-1",
        [
          { physicalStopId: "0290", arrivalTime: 1_000_000 },
          { physicalStopId: "0205", arrivalTime: 1_840_000 },
        ],
      ],
    ]);

    const journey = buildJourney(
      {
        tripId: "trip-1",
        arrivalTime: 1_000_000,
        lineId: "TB39",
        activeTrip: true,
      },
      route,
      ["0205", "0206", "2777"],
      index,
    );

    expect(journey.destinationArrival).toBe(1_840_000);
    expect(journey.rideEstimated).toBe(false);
    expect(journey.rideMinutes).toBe(14);
  });

  it("falls back to estimated ride time", () => {
    const journey = buildJourney(
      {
        tripId: "trip-2",
        arrivalTime: 1_000_000,
        lineId: "TB39",
      },
      ROUTES["to-bulgaria"],
      ["0290"],
      new Map(),
    );

    expect(journey.rideEstimated).toBe(true);
    expect(journey.destinationArrival).toBe(1_000_000 + 14 * 60_000);
  });
});

describe("getJourneyBreakdown", () => {
  it("splits walk, wait and ride", () => {
    const now = 1_000_000;
    const breakdown = getJourneyBreakdown(
      {
        arrivalTime: now + 8 * 60_000,
        destinationArrival: now + 22 * 60_000,
        rideMinutes: 14,
        rideEstimated: false,
      },
      3,
      now,
    );

    expect(breakdown.walkMinutes).toBe(3);
    expect(breakdown.waitMinutes).toBe(5);
    expect(breakdown.rideMinutes).toBe(14);
    expect(breakdown.totalMinutes).toBe(22);
  });
});
