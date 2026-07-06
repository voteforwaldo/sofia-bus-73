import { describe, expect, it } from "vitest";
import {
  dedupeDepartures,
  enrichDeparture,
  filterLine73Departures,
  getConfidence,
  matchMladost,
  matchOvchaKupel,
  parseBoardResponse,
} from "./transit.js";

describe("direction filters", () => {
  it("matches Ovcha Kupel destinations", () => {
    expect(matchOvchaKupel({ bg: "ж.к. Овча купел 2", en: "zh.k. Ovcha kupel 2" })).toBe(true);
    expect(matchOvchaKupel({ bg: "ж.к. Младост 1", en: "zh.k. Mladost 1" })).toBe(false);
  });

  it("matches Mladost destinations", () => {
    expect(matchMladost({ bg: "ж.к. Младост 1", en: "zh.k. Mladost 1" })).toBe(true);
    expect(matchOvchaKupel({ bg: "ж.к. Младост 1" })).toBe(false);
  });
});

describe("enrichDeparture", () => {
  it("computes delay from actual and scheduled", () => {
    const result = enrichDeparture({
      lineId: "TB39",
      activeTrip: true,
      time: { scheduled: 1_000_000, actual: 1_180_000 },
      destination: { bg: "ж.к. Младост 1" },
    });

    expect(result.delayMinutes).toBe(3);
    expect(result.confidence.level).toBe("high");
  });

  it("marks scheduled-only departures as low confidence", () => {
    const result = enrichDeparture({
      lineId: "TB39",
      activeTrip: false,
      time: { scheduled: 1_000_000, actual: 1_000_000 },
      destination: { bg: "ж.к. Овча купел 2" },
    });

    expect(result.confidence.level).toBe("low");
  });
});

describe("getConfidence", () => {
  it("detects GPS estimate mode", () => {
    const confidence = getConfidence({
      isLive: false,
      delayMinutes: 4,
      hasGpsEstimate: true,
      scheduled: 1,
      actual: 2,
    });

    expect(confidence.label).toBe("оценка");
  });
});

describe("filterLine73Departures", () => {
  it("filters line and direction", () => {
    const departures = filterLine73Departures(
      [
        {
          lineId: "TB39",
          tripId: "a",
          activeTrip: true,
          time: { scheduled: 100, actual: 200 },
          destination: { bg: "ж.к. Младост 1" },
        },
        {
          lineId: "TB39",
          tripId: "b",
          activeTrip: true,
          time: { scheduled: 50, actual: 60 },
          destination: { bg: "ж.к. Овча купел 2" },
        },
        {
          lineId: "OTHER",
          tripId: "c",
          time: { scheduled: 10, actual: 10 },
          destination: { bg: "ж.к. Младост 1" },
        },
      ],
      matchMladost,
      0,
    );

    expect(departures).toHaveLength(1);
    expect(departures[0].tripId).toBe("a");
  });

  it("keeps gtfs-rt departures without direction match", () => {
    const departures = filterLine73Departures(
      [
        {
          lineId: "TB39",
          tripId: "gtfs-1",
          source: "gtfs-rt",
          time: { scheduled: 1000, actual: 1000 },
          destination: { bg: "GTFS", en: "GTFS" },
        },
      ],
      matchMladost,
      0,
    );

    expect(departures).toHaveLength(1);
  });

  it("drops live departures sooner than scheduled ones", () => {
    const now = 10_000;
    const departures = filterLine73Departures(
      [
        {
          lineId: "TB39",
          tripId: "live-old",
          activeTrip: true,
          time: { scheduled: now - 25_000, actual: now - 25_000 },
          destination: { bg: "ж.к. Младост 1" },
        },
        {
          lineId: "TB39",
          tripId: "scheduled-old",
          activeTrip: false,
          time: { scheduled: now - 40_000, actual: now - 40_000 },
          destination: { bg: "ж.к. Младост 1" },
        },
      ],
      matchMladost,
      now,
    );

    expect(departures).toHaveLength(1);
    expect(departures[0].tripId).toBe("scheduled-old");
  });
});

describe("parseBoardResponse", () => {
  it("parses valid JSON board", () => {
    const departures = parseBoardResponse('{"departures":[{"lineId":"TB39"}]}');
    expect(departures).toHaveLength(1);
  });

  it("rejects HTML responses", () => {
    expect(() => parseBoardResponse("<!DOCTYPE html>")).toThrow("Invalid board response");
  });
});

describe("dedupeDepartures", () => {
  it("removes duplicate trip/time pairs", () => {
    const unique = dedupeDepartures([
      { tripId: "x", arrivalTime: 1 },
      { tripId: "x", arrivalTime: 1 },
      { tripId: "y", arrivalTime: 2 },
    ]);

    expect(unique).toHaveLength(2);
  });
});
