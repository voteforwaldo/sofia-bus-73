import {
  loadCache,
  loadNotifiedState,
  loadSettings,
  pruneNotifiedState,
  saveCache,
  saveNotifiedState,
  saveSettings,
} from "./settings.js";

const CONFIG = {
  apiBase: "https://api.livetransport.eu/sofia",
  lineId: "TB39",
  lineNumber: "73",
  refreshMs: 30_000,
  limit: 40,
  stops: [
    {
      id: "tokuda",
      name: "МБАЛ Токуда",
      shortName: "Токуда",
      directionLabel: "ж.к. Овча купел 2",
      stopIds: ["0205", "0206", "2777"],
      matchDirection: (destination) => {
        const text = `${destination?.bg ?? ""} ${destination?.en ?? ""}`.toLowerCase();
        return /овча купел|ovcha kupel/.test(text);
      },
    },
    {
      id: "bulgaria",
      name: "бул. България",
      shortName: "България",
      directionLabel: "ж.к. Младост",
      stopIds: ["0290", "0291", "6564", "6275"],
      matchDirection: (destination) => {
        const text = `${destination?.bg ?? ""} ${destination?.en ?? ""}`.toLowerCase();
        return /младост|mladost/.test(text);
      },
    },
  ],
};

const SOFIA_TZ = "Europe/Sofia";

const stopsRoot = document.getElementById("stops");
const statusEl = document.getElementById("status");
const widgetEl = document.getElementById("widget");
const settingsPanel = document.getElementById("settings-panel");
const settingsToggle = document.getElementById("settings-toggle");
const installBanner = document.getElementById("install-banner");
const installButton = document.getElementById("install-button");
const installDismiss = document.getElementById("install-dismiss");

let settings = loadSettings();
let cachedArrivals = new Map();
let lastUpdatedAt = null;
let isStale = false;
let deferredInstallPrompt = null;
let notifiedState = loadNotifiedState();

function formatMinutes(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) return `${seconds} сек`;
  if (minutes < 60) return seconds > 0 ? `${minutes} мин ${seconds} сек` : `${minutes} мин`;

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours} ч ${restMinutes} мин`;
}

function formatClock(timestamp) {
  return new Intl.DateTimeFormat("bg-BG", {
    timeZone: SOFIA_TZ,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function enrichDeparture(departure) {
  const scheduled = departure.time?.scheduled;
  const actual = departure.time?.actual ?? scheduled;
  const delayMinutes =
    typeof scheduled === "number" && typeof actual === "number"
      ? Math.round((actual - scheduled) / 60_000)
      : 0;

  return {
    ...departure,
    arrivalTime: actual,
    scheduledTime: scheduled,
    delayMinutes,
    isLive: Boolean(departure.activeTrip),
  };
}

function getStatusBadge(departure) {
  if (!departure.isLive) {
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

function getLeaveMessage(arrivalTime, walkingMinutes) {
  const leaveIn = arrivalTime - Date.now() - walkingMinutes * 60_000;

  if (leaveIn <= 0) {
    return { text: "Тръгни сега!", className: "leave-now urgent" };
  }

  return {
    text: `Тръгни след ${formatMinutes(leaveIn)}`,
    className: leaveIn <= 2 * 60_000 ? "leave-now soon" : "leave-now",
  };
}

function createStopCard(stop) {
  const card = document.createElement("section");
  card.className = "stop-card";
  card.dataset.stopId = stop.id;
  card.innerHTML = `
    <div class="stop-header">
      <div>
        <h2>${stop.name}</h2>
        <p class="direction">→ ${stop.directionLabel}</p>
      </div>
      <span class="status-badge status-scheduled">—</span>
    </div>
    <div class="arrival" aria-live="polite">
      <p class="label">Следващ автобус след</p>
      <p class="time">—</p>
      <p class="leave-now">—</p>
      <p class="meta">Зареждане...</p>
    </div>
    <div class="upcoming" hidden>
      <h3>Следващи курсове</h3>
      <ul></ul>
    </div>
  `;
  stopsRoot.appendChild(card);
  return card;
}

async function fetchBoard(stopId) {
  const response = await fetch(`${CONFIG.apiBase}/virtual-board/${stopId}?limit=${CONFIG.limit}`);
  if (!response.ok) {
    throw new Error(`API грешка ${response.status} за спирка ${stopId}`);
  }
  const data = await response.json();
  return data.departures ?? [];
}

async function fetchArrivalsForStop(stop) {
  const boards = await Promise.allSettled(stop.stopIds.map((stopId) => fetchBoard(stopId)));

  const departures = boards
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value)
    .filter(
      (departure) =>
        departure.lineId === CONFIG.lineId && stop.matchDirection(departure.destination),
    )
    .map(enrichDeparture)
    .filter((departure) => typeof departure.arrivalTime === "number")
    .sort((a, b) => a.arrivalTime - b.arrivalTime);

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

function renderStopCard(card, stop, arrivals) {
  const countdownEl = card.querySelector(".time");
  const metaEl = card.querySelector(".meta");
  const leaveEl = card.querySelector(".leave-now");
  const badgeEl = card.querySelector(".status-badge");
  const upcomingEl = card.querySelector(".upcoming");
  const upcomingListEl = card.querySelector(".upcoming ul");

  if (arrivals.length === 0) {
    countdownEl.textContent = "няма данни";
    countdownEl.className = "time none";
    leaveEl.textContent = "";
    leaveEl.className = "leave-now";
    badgeEl.textContent = "—";
    badgeEl.className = "status-badge status-scheduled";
    metaEl.textContent = `Няма курсове на линия ${CONFIG.lineNumber} в посока ${stop.directionLabel}.`;
    upcomingEl.hidden = true;
    return;
  }

  const now = Date.now();
  const next = arrivals[0];
  const diff = next.arrivalTime - now;
  const destination = next.destination?.bg ?? next.destination?.en ?? "неизвестна посока";
  const badge = getStatusBadge(next);
  const walkingMinutes = settings.walkingMinutes[stop.id] ?? 4;
  const leave = getLeaveMessage(next.arrivalTime, walkingMinutes);

  countdownEl.textContent = formatMinutes(diff);
  countdownEl.className = diff <= 3 * 60_000 ? "time soon" : "time";

  leaveEl.textContent = leave.text;
  leaveEl.className = leave.className;

  badgeEl.textContent = badge.text;
  badgeEl.className = `status-badge ${badge.className}`;

  const liveLabel = next.isLive ? "на път" : "по разписание";
  const staleLabel = isStale && lastUpdatedAt ? ` · кеш от ${formatClock(lastUpdatedAt)}` : "";
  metaEl.textContent = `${liveLabel} · към ${destination} · около ${formatClock(next.arrivalTime)}${staleLabel}`;

  const rest = arrivals.slice(1, 4);
  if (rest.length === 0) {
    upcomingEl.hidden = true;
    return;
  }

  upcomingEl.hidden = false;
  upcomingListEl.innerHTML = rest
    .map((departure) => {
      const mins = formatMinutes(departure.arrivalTime - now);
      const dest = departure.destination?.bg ?? departure.destination?.en ?? "";
      const itemBadge = getStatusBadge(departure);
      return `<li><span>${mins}</span><span class="upcoming-dest">${dest}</span><span class="upcoming-badge ${itemBadge.className}">${itemBadge.text}</span></li>`;
    })
    .join("");
}

function renderWidget() {
  const items = CONFIG.stops
    .map((stop) => {
      const arrivals = cachedArrivals.get(stop.id) ?? [];
      if (arrivals.length === 0) return null;

      const diff = arrivals[0].arrivalTime - Date.now();
      return `
        <div class="widget-item">
          <span class="widget-stop">${stop.shortName}</span>
          <span class="widget-time ${diff <= 3 * 60_000 ? "soon" : ""}">${formatMinutes(diff)}</span>
        </div>
      `;
    })
    .filter(Boolean)
    .join("");

  if (!items) {
    widgetEl.hidden = true;
    return;
  }

  widgetEl.hidden = false;
  widgetEl.innerHTML = items;
}

function renderAll() {
  for (const stop of CONFIG.stops) {
    const card = document.querySelector(`[data-stop-id="${stop.id}"]`);
    const arrivals = cachedArrivals.get(stop.id) ?? [];
    if (card) renderStopCard(card, stop, arrivals);
  }
  renderWidget();
}

function applyCachedData(cache) {
  if (!cache?.arrivals) return false;

  for (const stop of CONFIG.stops) {
    cachedArrivals.set(stop.id, cache.arrivals[stop.id] ?? []);
  }

  lastUpdatedAt = cache.savedAt;
  isStale = true;
  renderAll();
  statusEl.textContent = `Офлайн режим · данни от ${formatClock(cache.savedAt)}`;
  return true;
}

async function maybeNotify() {
  if (!settings.notificationsEnabled || Notification.permission !== "granted") return;

  const payload = CONFIG.stops.map((stop) => ({
    stop,
    next: (cachedArrivals.get(stop.id) ?? [])[0] ?? null,
  }));

  const activeTripKeys = payload
    .filter((item) => item.next)
    .map((item) => `${item.stop.id}-${item.next.tripId}`);

  notifiedState = pruneNotifiedState(notifiedState, activeTripKeys);
  saveNotifiedState(notifiedState);

  for (const item of payload) {
    const { stop, next } = item;
    if (!next) continue;

    const tripKey = `${stop.id}-${next.tripId}`;
    if (!notifiedState[tripKey]) {
      notifiedState[tripKey] = { ten: false, five: false };
    }

    const minutesUntil = Math.round((next.arrivalTime - Date.now()) / 60_000);
    const state = notifiedState[tripKey];

    for (const threshold of settings.alertMinutes) {
      const key = threshold === 10 ? "ten" : "five";
      if (minutesUntil <= threshold && minutesUntil > 0 && !state[key]) {
        state[key] = true;
        const title = `Автобус 73 · ${stop.name}`;
        const body = `Пристига след ~${minutesUntil} мин (${formatClock(next.arrivalTime)})`;

        new Notification(title, { body, icon: "/icon.svg", tag: tripKey });
      }
    }
  }

  saveNotifiedState(notifiedState);
}

async function refresh() {
  try {
    const results = await Promise.all(
      CONFIG.stops.map(async (stop) => {
        const arrivals = await fetchArrivalsForStop(stop);
        cachedArrivals.set(stop.id, arrivals);
        return arrivals;
      }),
    );

    if (results.every((arrivals) => arrivals.length === 0)) {
      throw new Error("Няма налични данни за избраните спирки.");
    }

    isStale = false;
    lastUpdatedAt = Date.now();

    const cachePayload = Object.fromEntries(
      CONFIG.stops.map((stop) => [stop.id, cachedArrivals.get(stop.id)]),
    );
    saveCache(cachePayload);

    renderAll();
    statusEl.textContent = `Последно обновяване: ${formatClock(lastUpdatedAt)}`;
    await maybeNotify();
  } catch (error) {
    const cache = loadCache();
    if (applyCachedData(cache)) return;

    for (const stop of CONFIG.stops) {
      const card = document.querySelector(`[data-stop-id="${stop.id}"]`);
      if (!card) continue;

      card.querySelector(".time").textContent = "грешка";
      card.querySelector(".time").className = "time none";
      card.querySelector(".leave-now").textContent = "";
      card.querySelector(".meta").textContent = "Неуспешно зареждане.";
      card.querySelector(".upcoming").hidden = true;
    }

    statusEl.textContent = error.message;
  }
}

function bindSettings() {
  const walkTokuda = document.getElementById("walk-tokuda");
  const walkBulgaria = document.getElementById("walk-bulgaria");
  const notificationsEnabled = document.getElementById("notifications-enabled");
  const enableNotifications = document.getElementById("enable-notifications");

  walkTokuda.value = settings.walkingMinutes.tokuda;
  walkBulgaria.value = settings.walkingMinutes.bulgaria;
  notificationsEnabled.checked = settings.notificationsEnabled;

  settingsToggle.addEventListener("click", () => {
    const open = settingsPanel.hidden;
    settingsPanel.hidden = !open;
    settingsToggle.setAttribute("aria-expanded", String(open));
  });

  walkTokuda.addEventListener("change", () => {
    settings.walkingMinutes.tokuda = Number(walkTokuda.value) || 0;
    saveSettings(settings);
    renderAll();
  });

  walkBulgaria.addEventListener("change", () => {
    settings.walkingMinutes.bulgaria = Number(walkBulgaria.value) || 0;
    saveSettings(settings);
    renderAll();
  });

  notificationsEnabled.addEventListener("change", async () => {
    settings.notificationsEnabled = notificationsEnabled.checked;
    saveSettings(settings);

    if (settings.notificationsEnabled && Notification.permission === "default") {
      await Notification.requestPermission();
    }
  });

  enableNotifications.addEventListener("click", async () => {
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      settings.notificationsEnabled = true;
      notificationsEnabled.checked = true;
      saveSettings(settings);
    }
  });
}

function bindInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (!localStorage.getItem("bus73-install-dismissed")) {
      installBanner.hidden = false;
    }
  });

  installButton.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBanner.hidden = true;
  });

  installDismiss.addEventListener("click", () => {
    installBanner.hidden = true;
    localStorage.setItem("bus73-install-dismissed", "1");
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch {
    // PWA extras are optional if SW registration fails locally.
  }
}

for (const stop of CONFIG.stops) {
  createStopCard(stop);
}

bindSettings();
bindInstallPrompt();
registerServiceWorker();

const initialCache = loadCache();
if (initialCache) {
  applyCachedData(initialCache);
}

refresh();
setInterval(refresh, CONFIG.refreshMs);
setInterval(() => {
  renderAll();
  maybeNotify();
}, 1000);
