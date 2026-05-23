// Tab Heatmap — MV3 service worker scaffolding.
//
// Keep this file dependency-free and side-effect light. Feature modules
// (tracking, decay, snapshots) will register their own listeners as they
// land via the roadmap. This file only owns lifecycle plumbing.

const LOG_PREFIX = "[tab-heatmap]";

/** Stable internal message protocol between popup/options and the SW. */
const MSG = Object.freeze({
  PING: "th:ping",
  GET_LAST_ACCESSED: "th:getLastAccessed",
  GET_ACTIVATION_COUNTS: "th:getActivationCounts",
  CLOSE_IDLE: "th:closeIdle",
  GET_SETTINGS: "th:getSettings",
  SET_SETTINGS: "th:setSettings",
});

/** Default settings. Persisted in chrome.storage.local under SETTINGS_KEY. */
const SETTINGS_KEY = "th:settings";
const DEFAULT_SETTINGS = Object.freeze({
  idleCloseDays: 7, // Close tabs untouched for this many days when user triggers close-idle.
  hotThreshold: 0.5, // Heat score (0..1) at which a tab counts as "hot" in popup stats.
  recencyHalfLifeMinutes: 30, // Half-life for recency decay used by the popup heat score.
});

async function readSettings() {
  try {
    const out = await chrome.storage.local.get(SETTINGS_KEY);
    const s = out?.[SETTINGS_KEY];
    const merged = { ...DEFAULT_SETTINGS, ...(s && typeof s === "object" ? s : {}) };
    // Clamp to a sane range so the UI can't get into a bricked state.
    const d = Number(merged.idleCloseDays);
    merged.idleCloseDays = Number.isFinite(d) && d >= 1 ? Math.min(365, Math.max(1, d)) : DEFAULT_SETTINGS.idleCloseDays;
    const h = Number(merged.hotThreshold);
    merged.hotThreshold = Number.isFinite(h) ? Math.min(0.95, Math.max(0.05, h)) : DEFAULT_SETTINGS.hotThreshold;
    const r = Number(merged.recencyHalfLifeMinutes);
    merged.recencyHalfLifeMinutes = Number.isFinite(r) && r >= 1 ? Math.min(1440, Math.max(1, r)) : DEFAULT_SETTINGS.recencyHalfLifeMinutes;
    return merged;
  } catch (err) {
    console.warn(LOG_PREFIX, "readSettings failed:", err);
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(patch) {
  try {
    const cur = await readSettings();
    const next = { ...cur, ...(patch && typeof patch === "object" ? patch : {}) };
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  } catch (err) {
    console.warn(LOG_PREFIX, "writeSettings failed:", err);
    return null;
  }
}

/**
 * Compute the effective last-access timestamp for a tab.
 * Prefers our tracked map; falls back to chrome's t.lastAccessed; then 0.
 */
function effectiveStamp(tab, accessedMap) {
  const key = String(tab?.id);
  const m = accessedMap?.[key];
  if (typeof m === "number" && Number.isFinite(m)) return m;
  if (typeof tab?.lastAccessed === "number") return tab.lastAccessed;
  return 0;
}

/**
 * Close every tab idle longer than `days` days.
 * Excludes: pinned tabs, the currently-active tab in each window, tabs with audio,
 * and tabs the user is currently dragging/loading. Returns a summary.
 */
async function closeIdleTabs(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d < 1) {
    return { ok: false, error: "invalid_days", closed: 0, candidates: 0, scanned: 0 };
  }
  if (!chrome?.tabs?.query || !chrome?.tabs?.remove) {
    return { ok: false, error: "tabs_api_unavailable", closed: 0, candidates: 0, scanned: 0 };
  }
  const thresholdMs = d * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const [tabs, accessed] = await Promise.all([
    chrome.tabs.query({}),
    readLastAccessed(),
  ]);
  const toClose = [];
  for (const t of tabs) {
    if (!t || typeof t.id !== "number") continue;
    if (t.pinned) continue;
    if (t.active) continue;
    if (t.audible) continue;
    const stamp = effectiveStamp(t, accessed);
    // If we genuinely have no signal (stamp 0), don't reap — safer default.
    if (stamp <= 0) continue;
    if (now - stamp >= thresholdMs) toClose.push(t.id);
  }
  if (toClose.length === 0) {
    return { ok: true, closed: 0, candidates: 0, scanned: tabs.length, days: d };
  }
  try {
    await chrome.tabs.remove(toClose);
    // Best-effort cleanup of our maps; onRemoved listeners will catch most cases too.
    await Promise.all(toClose.map((id) => forgetTab(id)));
    return { ok: true, closed: toClose.length, candidates: toClose.length, scanned: tabs.length, days: d };
  } catch (err) {
    console.warn(LOG_PREFIX, "closeIdleTabs remove failed:", err);
    return { ok: false, error: String(err?.message || err), closed: 0, candidates: toClose.length, scanned: tabs.length, days: d };
  }
}

/** Storage key namespace for per-tab last-accessed map. */
const LAST_ACCESSED_KEY = "th:lastAccessed";
/** Storage key namespace for per-tab activation-count map. */
const ACTIVATION_COUNT_KEY = "th:activationCounts";

/** Read the persisted last-accessed map. Returns {} if uninitialized. */
async function readLastAccessed() {
  try {
    const out = await chrome.storage.session.get(LAST_ACCESSED_KEY);
    const map = out?.[LAST_ACCESSED_KEY];
    return (map && typeof map === "object") ? map : {};
  } catch (err) {
    console.warn(LOG_PREFIX, "readLastAccessed failed:", err);
    return {};
  }
}

/** Stamp a tab id with the current timestamp. */
async function stampTab(tabId, ts = Date.now()) {
  if (typeof tabId !== "number" || tabId < 0) return;
  try {
    const map = await readLastAccessed();
    map[String(tabId)] = ts;
    await chrome.storage.session.set({ [LAST_ACCESSED_KEY]: map });
  } catch (err) {
    console.warn(LOG_PREFIX, "stampTab failed:", err);
  }
}

/** Read the persisted activation-count map. Returns {} if uninitialized. */
async function readActivationCounts() {
  try {
    const out = await chrome.storage.session.get(ACTIVATION_COUNT_KEY);
    const map = out?.[ACTIVATION_COUNT_KEY];
    return (map && typeof map === "object") ? map : {};
  } catch (err) {
    console.warn(LOG_PREFIX, "readActivationCounts failed:", err);
    return {};
  }
}

/** Increment a tab's activation counter. */
async function bumpActivation(tabId) {
  if (typeof tabId !== "number" || tabId < 0) return;
  try {
    const map = await readActivationCounts();
    const key = String(tabId);
    map[key] = (typeof map[key] === "number" ? map[key] : 0) + 1;
    await chrome.storage.session.set({ [ACTIVATION_COUNT_KEY]: map });
  } catch (err) {
    console.warn(LOG_PREFIX, "bumpActivation failed:", err);
  }
}

/** Drop a tab id from the maps when it closes. */
async function forgetTab(tabId) {
  try {
    const key = String(tabId);
    const [accessed, counts] = await Promise.all([
      readLastAccessed(),
      readActivationCounts(),
    ]);
    let dirtyA = false, dirtyC = false;
    if (key in accessed) { delete accessed[key]; dirtyA = true; }
    if (key in counts) { delete counts[key]; dirtyC = true; }
    const writes = {};
    if (dirtyA) writes[LAST_ACCESSED_KEY] = accessed;
    if (dirtyC) writes[ACTIVATION_COUNT_KEY] = counts;
    if (dirtyA || dirtyC) await chrome.storage.session.set(writes);
  } catch (err) {
    console.warn(LOG_PREFIX, "forgetTab failed:", err);
  }
}

/** Seed the map with every currently-open tab on boot/install. */
async function seedFromOpenTabs() {
  try {
    if (!chrome?.tabs?.query) return;
    const tabs = await chrome.tabs.query({});
    const now = Date.now();
    const map = await readLastAccessed();
    for (const t of tabs) {
      if (typeof t.id === "number" && !(String(t.id) in map)) {
        map[String(t.id)] = typeof t.lastAccessed === "number" ? t.lastAccessed : now;
      }
    }
    await chrome.storage.session.set({ [LAST_ACCESSED_KEY]: map });
  } catch (err) {
    console.warn(LOG_PREFIX, "seedFromOpenTabs failed:", err);
  }
}

// Track activations as the canonical "accessed" signal and bump the counter.
if (chrome?.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    stampTab(tabId);
    bumpActivation(tabId);
  });
}
// A tab finishing a navigation/load also counts as access.
if (chrome?.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo?.status === "complete") stampTab(tabId);
  });
}
// Forget tabs as they close so the map doesn't drift.
if (chrome?.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => { forgetTab(tabId); });
}

/** Ensure chrome.storage.session is writable; surface fatal misconfigs early. */
async function ensureSessionStorage() {
  try {
    if (!chrome?.storage?.session) {
      console.warn(LOG_PREFIX, "storage.session unavailable on this runtime");
      return false;
    }
    // Touch a sentinel so the area is initialized for downstream features.
    await chrome.storage.session.set({ "th:boot": Date.now() });
    return true;
  } catch (err) {
    console.warn(LOG_PREFIX, "storage.session probe failed:", err);
    return false;
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(LOG_PREFIX, "onInstalled", details.reason);
  await ensureSessionStorage();
  await seedFromOpenTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log(LOG_PREFIX, "onStartup");
  await ensureSessionStorage();
  await seedFromOpenTabs();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  if (msg.type === MSG.PING) {
    sendResponse({ ok: true, ts: Date.now() });
    return true;
  }
  if (msg.type === MSG.GET_LAST_ACCESSED) {
    readLastAccessed().then((map) => sendResponse({ ok: true, map }));
    return true; // async response
  }
  if (msg.type === MSG.GET_ACTIVATION_COUNTS) {
    readActivationCounts().then((map) => sendResponse({ ok: true, map }));
    return true; // async response
  }
  if (msg.type === MSG.GET_SETTINGS) {
    readSettings().then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }
  if (msg.type === MSG.SET_SETTINGS) {
    writeSettings(msg.patch).then((settings) => sendResponse({ ok: !!settings, settings: settings || null }));
    return true;
  }
  if (msg.type === MSG.CLOSE_IDLE) {
    (async () => {
      const requested = Number(msg?.days);
      const settings = await readSettings();
      const days = Number.isFinite(requested) && requested >= 1 ? requested : settings.idleCloseDays;
      const result = await closeIdleTabs(days);
      sendResponse(result);
    })();
    return true;
  }
  return false;
});

console.log(LOG_PREFIX, "service worker booted");
