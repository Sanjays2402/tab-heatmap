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
});

/** Storage key namespace for per-tab last-accessed map. */
const LAST_ACCESSED_KEY = "th:lastAccessed";

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

/** Drop a tab id from the map when it closes. */
async function forgetTab(tabId) {
  try {
    const map = await readLastAccessed();
    if (String(tabId) in map) {
      delete map[String(tabId)];
      await chrome.storage.session.set({ [LAST_ACCESSED_KEY]: map });
    }
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

// Track activations as the canonical "accessed" signal.
if (chrome?.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener(({ tabId }) => { stampTab(tabId); });
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
  return false;
});

console.log(LOG_PREFIX, "service worker booted");
