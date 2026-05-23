// Tab Heatmap — MV3 service worker scaffolding.
//
// Keep this file dependency-free and side-effect light. Feature modules
// (tracking, decay, snapshots) will register their own listeners as they
// land via the roadmap. This file only owns lifecycle plumbing.

const LOG_PREFIX = "[tab-heatmap]";

/** Stable internal message protocol between popup/options and the SW. */
const MSG = Object.freeze({
  PING: "th:ping",
});

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
});

chrome.runtime.onStartup.addListener(async () => {
  console.log(LOG_PREFIX, "onStartup");
  await ensureSessionStorage();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  if (msg.type === MSG.PING) {
    sendResponse({ ok: true, ts: Date.now() });
    return true;
  }
  return false;
});

console.log(LOG_PREFIX, "service worker booted");
