const TRIP_UPDATES_URL = "https://gtfs.sofiatraffic.bg/api/v1/trip-updates";

export async function fetchGtfsFallbackBoard(stopId, limit = 40) {
  const tripBuffer = await fetch(TRIP_UPDATES_URL).then((response) =>
    response.ok ? response.arrayBuffer() : null,
  );

  if (!tripBuffer) {
    throw new Error("GTFS-RT unavailable");
  }

  const { transit_realtime } = await import("gtfs-realtime-bindings");
  const departures = [];
  const feed = transit_realtime.FeedMessage.decode(new Uint8Array(tripBuffer));

  for (const entity of feed.entity) {
    const tripUpdate = entity.tripUpdate;
    if (!tripUpdate?.trip) continue;

    const routeId = tripUpdate.trip.routeId ?? "";
    if (!routeId.includes("73") && routeId !== "TB39") continue;

    for (const stopUpdate of tripUpdate.stopTimeUpdate ?? []) {
      if (stopUpdate.stopId !== stopId) continue;

      const arrival = stopUpdate.arrival ?? stopUpdate.departure;
      if (!arrival) continue;

      const arrivalTime = (arrival.time ?? arrival.Time) * 1000;
      if (!arrivalTime) continue;

      departures.push({
        tripId: tripUpdate.trip.tripId ?? entity.id,
        lineId: "TB39",
        blockId: tripUpdate.trip.tripId ?? "",
        vehicleId: tripUpdate.vehicle?.id ?? "",
        activeTrip: Boolean(tripUpdate.vehicle?.id),
        time: {
          scheduled: arrivalTime,
          actual: arrivalTime + (arrival.delay ?? 0) * 1000,
        },
        destination: { bg: "GTFS", en: "GTFS" },
        source: "gtfs-rt",
      });
    }
  }

  departures.sort((a, b) => (a.time.actual ?? 0) - (b.time.actual ?? 0));
  return { departures: departures.slice(0, Number(limit)), source: "gtfs-rt" };
}
