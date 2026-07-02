const CACHE_NAME = "bus73-v1";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/settings.js",
  "/manifest.json",
  "/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  if (request.url.includes("api.livetransport.eu")) {
    event.respondWith(
      fetch(request)
        .then((response) => response)
        .catch(() => caches.match(request)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);

      return cached || network;
    }),
  );
});

const notifiedTrips = new Map();

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "CHECK_NOTIFICATIONS") return;

  const { arrivals, settings } = event.data;
  if (!settings?.notificationsEnabled) return;
  if (Notification.permission !== "granted") return;

  for (const item of arrivals) {
    const { stop, next } = item;
    if (!next) continue;

    const minutesUntil = Math.round((next.arrivalTime - Date.now()) / 60_000);
    const tripKey = `${stop.id}-${next.tripId}`;

    if (!notifiedTrips.has(tripKey)) {
      notifiedTrips.set(tripKey, { ten: false, five: false });
    }

    const state = notifiedTrips.get(tripKey);

    for (const threshold of settings.alertMinutes) {
      const key = threshold === 10 ? "ten" : "five";
      if (minutesUntil <= threshold && minutesUntil > 0 && !state[key]) {
        state[key] = true;
        const title = `Автобус 73 · ${stop.name}`;
        const body = `Пристига след ~${minutesUntil} мин (${formatClock(next.arrivalTime)})`;
        await self.registration.showNotification(title, {
          body,
          icon: "/icon.svg",
          badge: "/icon.svg",
          tag: tripKey,
          renotify: true,
        });
      }
    }
  }
});

function formatClock(timestamp) {
  return new Intl.DateTimeFormat("bg-BG", {
    timeZone: "Europe/Sofia",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
