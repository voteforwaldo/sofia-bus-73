import {
  loadCache,
  loadNotifiedState,
  loadSettings,
  pruneNotifiedState,
  saveCache,
  saveNotifiedState,
  saveSettings,
} from "./settings.js?v=12";
import {
  dedupeDepartures,
  filterLine73Departures,
  getConfidence,
  getStatusBadge,
  parseBoardResponse,
} from "./lib/transit.js?v=12";
import {
  formatTypicalDelay,
  getTypicalDelay,
  recordDelay,
} from "./lib/delay-history.js?v=12";
import {
  buildJourneysForRoute,
  buildTripIndex,
  getJourneyBreakdown,
  getLeaveMessageForJourney,
  getRoute,
  ROUTES,
} from "./lib/routes.js?v=12";
import { PRECIPITATION_CODES, weatherLabel } from "./lib/weather.js?v=12";
import { BUILD_VERSION } from "./lib/version.js?v=12";

const PRODUCTION_HOST = "sofia-bus-73.vercel.app";
const APP_VERSION = BUILD_VERSION;

const CONFIG = {
  apiBase: "https://api.livetransport.eu/sofia",
  lineId: "TB39",
  lineNumber: "73",
  refreshMs: 30_000,
  weatherRefreshMs: 20 * 60_000,
  limit: 40,
  stops: [
    {
      id: "tokuda",
      name: "МБАЛ Токуда",
      shortName: "Токуда",
      lat: 42.66716,
      lon: 23.32672,
      stopIds: ["0205", "0206", "2777"],
    },
    {
      id: "bulgaria",
      name: "бул. България",
      shortName: "България",
      lat: 42.67262,
      lon: 23.2937,
      stopIds: ["0290", "0291", "6564", "6275"],
    },
  ],
};

const SOFIA_TZ = "Europe/Sofia";
const STOP_BY_ID = Object.fromEntries(CONFIG.stops.map((stop) => [stop.id, stop]));

const statusEl = document.getElementById("status");
const widgetEl = document.getElementById("widget");
const routeCardEl = document.getElementById("route-card");
const routeSwitchEl = document.getElementById("route-switch");
const settingsPanel = document.getElementById("settings-panel");
const settingsToggle = document.getElementById("settings-toggle");
const installBanner = document.getElementById("install-banner");
const installButton = document.getElementById("install-button");
const installDismiss = document.getElementById("install-dismiss");
const refreshButton = document.getElementById("refresh-button");
const pullIndicator = document.getElementById("pull-indicator");

let settings = loadSettings();
let cachedJourneys = new Map();
let cachedWeather = new Map();
let lastUpdatedAt = null;
let isStale = false;
let dataSource = "live";
let deferredInstallPrompt = null;
let notifiedState = loadNotifiedState();
let refreshInFlight = null;

const SOURCE_PRIORITY = {
  livetransport: 0,
  "kv-stale": 1,
  "gtfs-rt": 2,
};

function getActiveRoute() {
  return getRoute(settings.routeId);
}

function ensureProductionUrl() {
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === PRODUCTION_HOST) return;

  if (host.endsWith(".vercel.app")) {
    location.replace(`https://${PRODUCTION_HOST}${location.pathname}${location.search}`);
  }
}

function applyTheme(theme = settings.theme) {
  if (theme === "auto") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

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

function notificationKey(threshold) {
  return String(threshold);
}

function isLocalHost() {
  return location.hostname === "localhost" || location.hostname === "127.0.0.1";
}

function getBoardUrl(stopId) {
  if (isLocalHost()) {
    return `${CONFIG.apiBase}/virtual-board/${stopId}?limit=${CONFIG.limit}`;
  }

  return `/api/board?stopId=${encodeURIComponent(stopId)}&limit=${CONFIG.limit}`;
}

function buildLocalWeatherSummary(stopName, forecast) {
  const current = forecast.current;
  const hours = forecast.hourly.time.slice(0, 6).map((time, index) => ({
    precipitation: forecast.hourly.precipitation[index] ?? 0,
    probability: forecast.hourly.precipitation_probability[index] ?? 0,
    code: forecast.hourly.weather_code[index] ?? current.weather_code,
  }));

  const willRainSoon = hours.some(
    (hour) =>
      hour.precipitation > 0.1 || hour.probability >= 45 || PRECIPITATION_CODES.has(hour.code),
  );

  const temp = Math.round(current.temperature_2m);
  const condition = weatherLabel(current.weather_code);
  const rainText = willRainSoon
    ? "Да, очаква се дъжд скоро — вземи чадър."
    : "Не, дъжд скоро не се очаква.";

  return {
    summary: `При ${stopName} сега е около ${temp}°C и ${condition}. ${rainText}`,
    willRainSoon,
    temperature: current.temperature_2m,
    condition,
    source: "open-meteo",
  };
}

async function fetchLocalWeather(stop) {
  const params = new URLSearchParams({
    latitude: stop.lat,
    longitude: stop.lon,
    timezone: "Europe/Sofia",
    current: "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
    hourly: "precipitation_probability,precipitation,weather_code",
    forecast_hours: "6",
  });

  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!response.ok) throw new Error("Weather unavailable");

  const forecast = await response.json();
  return buildLocalWeatherSummary(stop.name, forecast);
}

async function fetchWeather(stop) {
  if (!isLocalHost()) {
    const response = await fetch(
      `/api/weather?stopId=${encodeURIComponent(stop.id)}&lat=${stop.lat}&lon=${stop.lon}&name=${encodeURIComponent(stop.name)}`,
    );

    if (response.ok) {
      return response.json();
    }
  }

  return fetchLocalWeather(stop);
}

async function fetchBoard(stopId) {
  const response = await fetch(getBoardUrl(stopId));
  if (!response.ok) {
    throw new Error(`API грешка ${response.status} за спирка ${stopId}`);
  }

  const raw = await response.text();
  if (!raw.trim().startsWith("{")) {
    throw new Error(
      "Сървърът върна невалиден отговор. Използвай production линка: sofia-bus-73.vercel.app",
    );
  }

  return {
    departures: parseBoardResponse(raw),
    source: response.headers.get("X-Data-Source") ?? "livetransport",
    stale: response.headers.get("X-Data-Stale") === "true",
  };
}

async function fetchAllBoards() {
  const allStopIds = [...new Set(CONFIG.stops.flatMap((stop) => stop.stopIds))];
  const results = await Promise.allSettled(allStopIds.map((stopId) => fetchBoard(stopId)));
  const cache = new Map();
  let failedBoards = 0;
  let anyStale = false;
  let dataSource = "livetransport";

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      const board = result.value;
      cache.set(allStopIds[index], board.departures);
      if (board.stale) anyStale = true;
      if ((SOURCE_PRIORITY[board.source] ?? 0) > (SOURCE_PRIORITY[dataSource] ?? 0)) {
        dataSource = board.source;
      }
    } else {
      failedBoards += 1;
    }
  });

  return { cache, failedBoards, total: allStopIds.length, isStale: anyStale, dataSource };
}

function buildJourneyData(boardCache, now = Date.now()) {
  const tripIndex = buildTripIndex(boardCache);
  const journeysByRoute = new Map();

  for (const route of Object.values(ROUTES)) {
    const boardingStop = STOP_BY_ID[route.boardingStopId];
    const destinationStop = STOP_BY_ID[route.destinationStopId];
    const rawDepartures = boardingStop.stopIds.flatMap((stopId) => boardCache.get(stopId) ?? []);
    const boardingDepartures = dedupeDepartures(
      filterLine73Departures(rawDepartures, route.matchDirection, now),
    );

    for (const departure of boardingDepartures) {
      if (departure.isLive && departure.delayMinutes !== 0) {
        recordDelay(route.boardingStopId, departure.delayMinutes);
      }
    }

    const journeys = buildJourneysForRoute(
      route,
      boardingDepartures,
      destinationStop.stopIds,
      tripIndex,
      now,
    );
    journeysByRoute.set(route.id, journeys);
  }

  return journeysByRoute;
}

function renderWeather(weather) {
  const rainEl = routeCardEl.querySelector(".weather-rain");
  const textEl = routeCardEl.querySelector(".weather-text");

  if (!weather) {
    rainEl.textContent = "—";
    rainEl.className = "weather-rain";
    textEl.textContent = "Прогнозата е временно недостъпна.";
    return;
  }

  rainEl.textContent = weather.willRainSoon ? "🌧️ Ще вали скоро" : "☀️ Без дъжд скоро";
  rainEl.className = weather.willRainSoon ? "weather-rain rain-yes" : "weather-rain rain-no";
  textEl.textContent = weather.summary;
}

async function refreshWeather() {
  const route = getActiveRoute();
  const boardingStop = STOP_BY_ID[route.boardingStopId];

  try {
    const weather = await fetchWeather(boardingStop);
    cachedWeather.set(boardingStop.id, weather);
    renderWeather(weather);
  } catch {
    renderWeather(cachedWeather.get(boardingStop.id) ?? null);
  }
}

function updateRouteSwitch() {
  for (const button of routeSwitchEl.querySelectorAll("[data-route-id]")) {
    const active = button.dataset.routeId === settings.routeId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
}

function renderRouteCard() {
  const route = getActiveRoute();
  const boardingStop = STOP_BY_ID[route.boardingStopId];
  const destinationStop = STOP_BY_ID[route.destinationStopId];
  const journeys = cachedJourneys.get(route.id) ?? [];
  const now = Date.now();

  routeCardEl.dataset.routeId = route.id;
  routeCardEl.querySelector(".route-title").textContent = `${route.emoji} ${route.label}`;
  routeCardEl.querySelector(".route-boarding").textContent =
    `Качваш се: ${boardingStop.name} · посока ${route.directionLabel}`;

  const busTimeEl = routeCardEl.querySelector(".route-bus-time");
  const destinationEl = routeCardEl.querySelector(".route-destination");
  const breakdownEl = routeCardEl.querySelector(".route-breakdown");
  const leaveEl = routeCardEl.querySelector(".leave-now");
  const badgeEl = routeCardEl.querySelector(".status-badge");
  const confidenceBadgeEl = routeCardEl.querySelector(".confidence-badge");
  const confidenceHintEl = routeCardEl.querySelector(".confidence-hint");
  const historyEl = routeCardEl.querySelector(".delay-history");
  const upcomingEl = routeCardEl.querySelector(".upcoming");
  const upcomingListEl = routeCardEl.querySelector(".upcoming ul");

  if (journeys.length === 0) {
    busTimeEl.textContent = "няма данни";
    busTimeEl.className = "route-bus-time none";
    destinationEl.textContent = "—";
    breakdownEl.innerHTML = "";
    leaveEl.textContent = "";
    leaveEl.className = "leave-now";
    badgeEl.textContent = "—";
    badgeEl.className = "status-badge status-scheduled";
    confidenceBadgeEl.textContent = "—";
    confidenceHintEl.textContent = "";
    historyEl.hidden = true;
    upcomingEl.hidden = true;
    return;
  }

  const next = journeys[0];
  const walkingMinutes = settings.walkingMinutes[boardingStop.id] ?? 4;
  const breakdown = getJourneyBreakdown(next, walkingMinutes, now);
  const leave = getLeaveMessageForJourney(next.arrivalTime, walkingMinutes, now);
  const badge = getStatusBadge(next);
  const confidence = next.confidence ?? getConfidence(next);
  const totalDiff = next.destinationArrival - now;
  const busDiff = next.arrivalTime - now;

  busTimeEl.textContent = formatMinutes(busDiff);
  busTimeEl.className = busDiff <= 3 * 60_000 ? "route-bus-time soon" : "route-bus-time";

  destinationEl.textContent =
    `🏁 До ${destinationStop.shortName}: ${formatMinutes(totalDiff)} · около ${formatClock(breakdown.destinationArrival)}`;

  const rideLabel = breakdown.rideEstimated ? `~${breakdown.rideMinutes} мин` : `${breakdown.rideMinutes} мин`;
  breakdownEl.innerHTML = `
    <span class="breakdown-item">🚶 ${breakdown.walkMinutes} мин</span>
    <span class="breakdown-sep">+</span>
    <span class="breakdown-item">⏳ ${breakdown.waitMinutes} мин</span>
    <span class="breakdown-sep">+</span>
    <span class="breakdown-item">🚌 ${rideLabel}</span>
  `;

  leaveEl.textContent = leave.text;
  leaveEl.className = leave.className;
  badgeEl.textContent = badge.text;
  badgeEl.className = `status-badge ${badge.className}`;
  confidenceBadgeEl.textContent = confidence.label;
  confidenceBadgeEl.className = `confidence-badge ${confidence.className}`;
  confidenceHintEl.textContent = confidence.hint;

  const typical = getTypicalDelay(boardingStop.id);
  const typicalText = formatTypicalDelay(typical);
  if (typicalText) {
    historyEl.textContent = `📊 ${typicalText}`;
    historyEl.hidden = false;
  } else {
    historyEl.hidden = true;
  }

  const staleLabel = isStale && lastUpdatedAt ? ` · кеш от ${formatClock(lastUpdatedAt)}` : "";
  routeCardEl.querySelector(".route-meta").textContent =
    `Общо ~${breakdown.totalMinutes} мин${breakdown.rideEstimated ? " · времето в автобуса е оценка" : ""}${staleLabel}`;

  const rest = journeys.slice(1, 4);
  if (rest.length === 0) {
    upcomingEl.hidden = true;
    return;
  }

  upcomingEl.hidden = false;
  upcomingListEl.innerHTML = rest
    .map((journey) => {
      const itemBreakdown = getJourneyBreakdown(journey, walkingMinutes, now);
      const itemBadge = getStatusBadge(journey);
      return `<li>
        <span>${formatClock(itemBreakdown.destinationArrival)}</span>
        <span class="upcoming-dest">автобус ${formatClock(journey.arrivalTime)}</span>
        <span class="upcoming-badge ${itemBadge.className}">${itemBadge.text}</span>
      </li>`;
    })
    .join("");
}

function renderWidget() {
  const route = getActiveRoute();
  const journeys = cachedJourneys.get(route.id) ?? [];

  if (journeys.length === 0) {
    widgetEl.innerHTML = `<div class="widget-empty">Няма данни</div>`;
    return;
  }

  const diff = journeys[0].arrivalTime - Date.now();
  const boardingStop = STOP_BY_ID[route.boardingStopId];
  const destinationStop = STOP_BY_ID[route.destinationStopId];

  widgetEl.innerHTML = `
    <div class="widget-item widget-item--route">
      <span class="widget-stop">${route.emoji} ${boardingStop.shortName} → ${destinationStop.shortName}</span>
      <span class="widget-time ${diff <= 3 * 60_000 ? "soon" : ""}">${formatMinutes(diff)}</span>
    </div>
  `;
}

function renderAll() {
  updateRouteSwitch();
  renderRouteCard();
  renderWidget();
  syncServiceWorkerState();
}

function applyCachedData(cache) {
  if (!cache?.journeys) return false;

  cachedJourneys = new Map(Object.entries(cache.journeys));
  lastUpdatedAt = cache.savedAt;
  isStale = true;
  renderAll();
  statusEl.textContent = `Офлайн режим · данни от ${formatClock(cache.savedAt)}`;
  return true;
}

function syncServiceWorkerState() {
  if (!navigator.serviceWorker?.controller) return;

  const route = getActiveRoute();
  const boardingStop = STOP_BY_ID[route.boardingStopId];
  const next = (cachedJourneys.get(route.id) ?? [])[0] ?? null;

  navigator.serviceWorker.controller.postMessage({
    type: "SYNC_STATE",
    settings,
    stops: [
      {
        id: boardingStop.id,
        name: boardingStop.shortName,
        routeId: route.id,
        routeLabel: route.label,
        next,
      },
    ],
    notifiedState,
    updatedAt: lastUpdatedAt,
  });
}

async function maybeNotify() {
  if (!settings.notificationsEnabled || Notification.permission !== "granted") return;

  const route = getActiveRoute();
  const boardingStop = STOP_BY_ID[route.boardingStopId];
  const next = (cachedJourneys.get(route.id) ?? [])[0] ?? null;
  if (!next) return;

  const tripKey = `${route.id}-${next.tripId}`;
  const activeTripKeys = [tripKey];

  notifiedState = pruneNotifiedState(notifiedState, activeTripKeys);
  if (!notifiedState[tripKey]) {
    notifiedState[tripKey] = {};
  }

  const minutesUntil = Math.round((next.arrivalTime - Date.now()) / 60_000);
  const state = notifiedState[tripKey];

  for (const threshold of settings.alertMinutes) {
    const key = notificationKey(threshold);
    if (minutesUntil <= threshold && minutesUntil > 0 && !state[key]) {
      state[key] = true;
      const title = `Автобус 73 · ${route.label}`;
      const body = `На ${boardingStop.shortName} след ~${minutesUntil} мин (${formatClock(next.arrivalTime)})`;

      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: "SHOW_NOTIFICATION",
          title,
          body,
          tag: tripKey,
        });
      } else {
        new Notification(title, { body, icon: "/icon.svg", tag: tripKey });
      }
    }
  }

  saveNotifiedState(notifiedState);
  syncServiceWorkerState();
}

async function refreshInternal() {
  try {
    const { cache, failedBoards, total, isStale: fetchedStale, dataSource: fetchedSource } =
      await fetchAllBoards();
    cachedJourneys = buildJourneyData(cache);

    const activeJourneys = cachedJourneys.get(settings.routeId) ?? [];
    const allEmpty = [...cachedJourneys.values()].every((journeys) => journeys.length === 0);

    if (failedBoards === total) {
      throw new Error("Неуспешна връзка с API. Опитайте отново след малко.");
    }

    if (allEmpty) {
      const fallbackNote =
        fetchedSource === "gtfs-rt"
          ? " API fallback данните не съвпаднаха с маршрута."
          : "";
      throw new Error(`Няма активни курсове в момента (възможно е извън работно време).${fallbackNote}`);
    }

    isStale = fetchedStale;
    dataSource = fetchedSource;
    lastUpdatedAt = Date.now();

    saveCache({
      journeys: Object.fromEntries(cachedJourneys),
    });

    renderAll();
    const staleNote = isStale ? " (кеш)" : "";
    const routeNote =
      activeJourneys.length === 0 ? ` · няма курсове за ${getActiveRoute().label}` : "";
    statusEl.textContent = `Последно обновяване: ${formatClock(lastUpdatedAt)}${staleNote}${routeNote}`;
    await maybeNotify();
  } catch (error) {
    reportError(error);

    const cache = loadCache();
    if (applyCachedData(cache)) return;

    routeCardEl.querySelector(".route-bus-time").textContent = "грешка";
    routeCardEl.querySelector(".route-bus-time").className = "route-bus-time none";
    routeCardEl.querySelector(".route-destination").textContent = "Неуспешно зареждане";
    routeCardEl.querySelector(".route-breakdown").innerHTML = "";
    routeCardEl.querySelector(".leave-now").textContent = "";
    routeCardEl.querySelector(".upcoming").hidden = true;
    statusEl.textContent = error.message;
  }
}

function refresh() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshInternal().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

function bindRouteSwitch() {
  routeSwitchEl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-route-id]");
    if (!button) return;

    settings.routeId = button.dataset.routeId;
    saveSettings(settings);
    renderAll();
    refreshWeather();
  });
}

function bindSettings() {
  const walkTokuda = document.getElementById("walk-tokuda");
  const walkBulgaria = document.getElementById("walk-bulgaria");
  const notificationsEnabled = document.getElementById("notifications-enabled");
  const enableNotifications = document.getElementById("enable-notifications");
  const themeSelect = document.getElementById("theme-select");

  walkTokuda.value = settings.walkingMinutes.tokuda;
  walkBulgaria.value = settings.walkingMinutes.bulgaria;
  notificationsEnabled.checked = settings.notificationsEnabled;
  themeSelect.value = settings.theme;
  applyTheme(settings.theme);

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

  themeSelect.addEventListener("change", () => {
    settings.theme = themeSelect.value;
    saveSettings(settings);
    applyTheme(settings.theme);
  });

  notificationsEnabled.addEventListener("change", async () => {
    settings.notificationsEnabled = notificationsEnabled.checked;
    saveSettings(settings);
    syncServiceWorkerState();

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
      syncServiceWorkerState();
    }
  });
}

function bindPullToRefresh() {
  let startY = 0;
  let pulling = false;

  document.addEventListener(
    "touchstart",
    (event) => {
      if (window.scrollY > 0) return;
      startY = event.touches[0].clientY;
      pulling = true;
    },
    { passive: true },
  );

  document.addEventListener(
    "touchmove",
    (event) => {
      if (!pulling || window.scrollY > 0) return;
      const delta = event.touches[0].clientY - startY;
      if (delta > 0 && delta < 120 && pullIndicator) {
        pullIndicator.hidden = false;
        pullIndicator.textContent = delta > 70 ? "Пусни за обновяване" : "Дръпни за обновяване";
      }
    },
    { passive: true },
  );

  document.addEventListener(
    "touchend",
    async (event) => {
      if (!pulling) return;
      pulling = false;
      const delta = event.changedTouches[0].clientY - startY;
      if (pullIndicator) pullIndicator.hidden = true;
      if (delta > 70 && window.scrollY <= 0) {
        statusEl.textContent = "Обновяване...";
        await refresh();
        await refreshWeather();
      }
    },
    { passive: true },
  );
}

function isInstalledPwa() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true ||
    localStorage.getItem("bus73-pwa-installed") === "1"
  );
}

function hideInstallBanner() {
  if (installBanner) {
    installBanner.hidden = true;
  }
}

function bindInstallPrompt() {
  if (isInstalledPwa()) {
    hideInstallBanner();
    return;
  }

  if (localStorage.getItem("bus73-install-dismissed")) {
    hideInstallBanner();
  }

  window.addEventListener("appinstalled", () => {
    localStorage.setItem("bus73-pwa-installed", "1");
    hideInstallBanner();
  });

  window.matchMedia("(display-mode: standalone)").addEventListener("change", (event) => {
    if (event.matches) {
      localStorage.setItem("bus73-pwa-installed", "1");
      hideInstallBanner();
    }
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;

    if (isInstalledPwa() || localStorage.getItem("bus73-install-dismissed")) {
      return;
    }

    installBanner.hidden = false;
  });

  installButton.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;

    if (choice.outcome === "accepted") {
      localStorage.setItem("bus73-pwa-installed", "1");
      hideInstallBanner();
    }
  });

  installDismiss.addEventListener("click", () => {
    localStorage.setItem("bus73-install-dismissed", "1");
    hideInstallBanner();
  });

  refreshButton?.addEventListener("click", async () => {
    statusEl.textContent = "Обновяване...";
    try {
      await refresh();
      await refreshWeather();
    } catch (error) {
      reportError(error);
    }
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  try {
    const registration = await navigator.serviceWorker.register("/sw.js");

    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "activated" && navigator.serviceWorker.controller) {
          location.reload();
        }
      });
    });

    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "NOTIFIED_STATE") {
        notifiedState = { ...notifiedState, ...event.data.state };
        saveNotifiedState(notifiedState);
      }
    });
  } catch {
    // PWA extras are optional if SW registration fails locally.
  }
}

function migrateAppVersion() {
  const previous = localStorage.getItem("bus73-version");
  if (previous === APP_VERSION) return;

  localStorage.removeItem("bus73-cache");
  localStorage.setItem("bus73-version", APP_VERSION);

  if ("caches" in window) {
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith("bus73-")).map((key) => caches.delete(key))),
    );
  }
}

function reportError(error) {
  if (window.Sentry?.captureException) {
    window.Sentry.captureException(error);
  }
}

async function initMonitoring() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) return;

    const { sentryDsn } = await response.json();
    if (!sentryDsn) return;

    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://browser.sentry-cdn.com/9.40.0/bundle.min.js";
      script.crossOrigin = "anonymous";
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });

    window.Sentry.init({
      dsn: sentryDsn,
      environment: location.hostname,
      tracesSampleRate: 0.1,
    });
  } catch {
    // Monitoring is optional.
  }
}

ensureProductionUrl();
initMonitoring();

bindRouteSwitch();
bindSettings();
bindInstallPrompt();
bindPullToRefresh();
migrateAppVersion();
registerServiceWorker();

const initialCache = loadCache();
if (initialCache) {
  applyCachedData(initialCache);
}

refresh();
refreshWeather();
setInterval(refresh, CONFIG.refreshMs);
setInterval(refreshWeather, CONFIG.weatherRefreshMs);
setInterval(() => {
  renderAll();
  maybeNotify();
}, 1000);

window.addEventListener("error", (event) => reportError(event.error ?? new Error(event.message)));
window.addEventListener("unhandledrejection", (event) => reportError(event.reason));
