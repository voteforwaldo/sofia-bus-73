const SETTINGS_KEY = "bus73-settings";
const CACHE_KEY = "bus73-cache";
const NOTIFIED_KEY = "bus73-notified";

const DEFAULT_SETTINGS = {
  walkingMinutes: {
    tokuda: 4,
    bulgaria: 3,
  },
  notificationsEnabled: false,
  alertMinutes: [10, 5],
  theme: "auto",
  routeId: "to-tokuda",
};

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    return { ...DEFAULT_SETTINGS, ...saved, walkingMinutes: { ...DEFAULT_SETTINGS.walkingMinutes, ...saved?.walkingMinutes } };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY));
  } catch {
    return null;
  }
}

export function saveCache(payload) {
  localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({
      savedAt: Date.now(),
      ...payload,
    }),
  );
}

export function loadNotifiedState() {
  try {
    return JSON.parse(localStorage.getItem(NOTIFIED_KEY)) ?? {};
  } catch {
    return {};
  }
}

export function saveNotifiedState(state) {
  localStorage.setItem(NOTIFIED_KEY, JSON.stringify(state));
}

export function pruneNotifiedState(state, activeTripKeys) {
  const next = {};
  for (const key of activeTripKeys) {
    if (state[key]) next[key] = state[key];
  }
  return next;
}
