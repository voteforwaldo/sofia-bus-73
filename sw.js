const CACHE_NAME = "bus73-v11";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/settings.js",
  "/lib/transit.js",
  "/lib/routes.js",
  "/lib/delay-history.js",
  "/lib/weather.js",
  "/manifest.json",
  "/icon.svg",
];

let swState = {
  settings: { notificationsEnabled: false, alertMinutes: [10, 5] },
  stops: [],
  notifiedState: {},
};

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
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data?.type) return;

  if (data.type === "SYNC_STATE") {
    swState = {
      settings: data.settings ?? swState.settings,
      stops: data.stops ?? [],
      notifiedState: data.notifiedState ?? swState.notifiedState,
    };
    return;
  }

  if (data.type === "SHOW_NOTIFICATION") {
    showNotification(data.title, data.body, data.tag);
  }
});

async function showNotification(title, body, tag) {
  try {
    await self.registration.showNotification(title, {
      body,
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag,
      renotify: true,
    });
  } catch {
    // Permission revoked or unsupported in this context.
  }
}

function formatClock(timestamp) {
  return new Intl.DateTimeFormat("bg-BG", {
    timeZone: "Europe/Sofia",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function notificationKey(threshold) {
  return String(threshold);
}

async function checkBackgroundNotifications() {
  if (!swState.settings.notificationsEnabled) return;

  for (const stop of swState.stops) {
    const next = stop.next;
    if (!next?.arrivalTime) continue;

    const tripKey = `${stop.routeId ?? stop.id}-${next.tripId}`;
    if (!swState.notifiedState[tripKey]) {
      swState.notifiedState[tripKey] = {};
    }

    const minutesUntil = Math.round((next.arrivalTime - Date.now()) / 60_000);
    const state = swState.notifiedState[tripKey];

    for (const threshold of swState.settings.alertMinutes ?? [10, 5]) {
      const key = notificationKey(threshold);
      if (minutesUntil <= threshold && minutesUntil > 0 && !state[key]) {
        state[key] = true;
        const title = `Автобус 73 · ${stop.routeLabel ?? stop.name}`;
        const body = `На ${stop.name} след ~${minutesUntil} мин (${formatClock(next.arrivalTime)})`;
        await showNotification(title, body, tripKey);
      }
    }
  }

  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.postMessage({ type: "NOTIFIED_STATE", state: swState.notifiedState });
  }
}

setInterval(() => {
  checkBackgroundNotifications();
}, 30_000);

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/")) {
    return;
  }

  if (url.pathname.endsWith(".js") || url.pathname === "/" || url.pathname.endsWith(".html")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request)),
  );
});
