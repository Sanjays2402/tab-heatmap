// Tab Heatmap — MV3 service worker scaffolding.
//
// Keep this file dependency-free and side-effect light. Feature modules
// (tracking, decay, snapshots) will register their own listeners as they
// land via the roadmap. This file only owns lifecycle plumbing.

const LOG_PREFIX = "[tab-heatmap]";

/** Stable internal message protocol between popup/options and the SW. */
const MSG = Object.freeze({
  PING: "th:ping",
  JUMP_HOTTEST: "th:jumpHottest",
  GET_LAST_ACCESSED: "th:getLastAccessed",
  MARK_HOT: "th:markHot",
  GET_ACTIVATION_COUNTS: "th:getActivationCounts",
  GET_ACTIVITY_SPARK: "th:getActivitySpark",
  GET_FIRST_OPENED: "th:getFirstOpened",
  CLOSE_IDLE: "th:closeIdle",
  SUSPEND_IDLE: "th:suspendIdle",
  GET_SETTINGS: "th:getSettings",
  SET_SETTINGS: "th:setSettings",
  RESTORE_TAB_META: "th:restoreTabMeta",
  RESET_HEAT_DATA: "th:resetHeatData",
});

/** Default settings. Persisted in chrome.storage.local under SETTINGS_KEY. */
const SETTINGS_KEY = "th:settings";
const DEFAULT_SETTINGS = Object.freeze({
  idleCloseDays: 7, // Close tabs untouched for this many days when user triggers close-idle.
  hotThreshold: 0.5, // Heat score (0..1) at which a tab counts as "hot" in popup stats.
  recencyHalfLifeMinutes: 30, // Half-life for recency decay used by the popup heat score.
  // Per-domain override map: { "github.com": 240, "news.ycombinator.com": 5 }
  // Each entry overrides recencyHalfLifeMinutes for tabs on that host.
  domainHalfLifeMinutes: {},
  // Hosts that are NEVER eligible for cold-close, regardless of idle age.
  // Stored as an array of normalized hostnames (e.g. "github.com").
  coldWhitelist: [],
  // UI theme: "auto" follows OS prefers-color-scheme; "light"/"dark" force.
  theme: "auto",
  // Daily summary notification: post "X cold tabs ready to close" once per day.
  dailySummaryEnabled: true,
  // Local hour-of-day (0..23) at which the daily summary fires.
  dailySummaryHour: 9,
  // Auto-suspend rule: when enabled, a periodic alarm discards tabs that
  // have been idle longer than `autoSuspendHours`. Same exclusions as the
  // manual suspend path (pinned, active, audible, whitelisted, no signal).
  autoSuspendEnabled: false,
  autoSuspendHours: 24,
  // Custom accent color (CSS hex) used for the liquid-glass chrome. Empty
  // string or invalid input falls back to the extension's signature accent.
  accentColor: "#ff7a3d",
});

const VALID_THEMES = new Set(["auto", "light", "dark"]);

/** Validate + normalize a CSS hex color (#rgb / #rrggbb). Returns "" on miss. */
function sanitizeHex(input) {
  if (typeof input !== "string") return "";
  const s = input.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  return "";
}

/** Lowercase + strip leading www. so user input "WWW.GitHub.com" matches "github.com". */
function normalizeHost(h) {
  if (typeof h !== "string") return "";
  return h.trim().toLowerCase().replace(/^www\./, "").replace(/\/+$/, "");
}

/** Sanitize an array/object of hostnames → deduped sorted array of normalized hosts. */
function sanitizeHostList(raw) {
  const seen = new Set();
  const src = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? Object.keys(raw) : []);
  for (const v of src) {
    const host = normalizeHost(v);
    if (!host) continue;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$|^localhost$/.test(host)) continue;
    seen.add(host);
  }
  return [...seen].sort();
}

/** Sanitize a domain → minutes map; drops invalid entries, clamps values. */
function sanitizeDomainMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    const host = normalizeHost(k);
    if (!host) continue;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$|^localhost$/.test(host)) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1) continue;
    out[host] = Math.min(1440, Math.max(1, Math.round(n)));
  }
  return out;
}

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
    merged.domainHalfLifeMinutes = sanitizeDomainMap(merged.domainHalfLifeMinutes);
    merged.coldWhitelist = sanitizeHostList(merged.coldWhitelist);
    merged.theme = VALID_THEMES.has(merged.theme) ? merged.theme : DEFAULT_SETTINGS.theme;
    merged.dailySummaryEnabled = merged.dailySummaryEnabled !== false;
    const dh = Number(merged.dailySummaryHour);
    merged.dailySummaryHour = Number.isFinite(dh) ? Math.min(23, Math.max(0, Math.round(dh))) : DEFAULT_SETTINGS.dailySummaryHour;
    merged.autoSuspendEnabled = merged.autoSuspendEnabled === true;
    const ah = Number(merged.autoSuspendHours);
    // Range: 1h .. 720h (30 days). Sub-hour discards would thrash; >30d is
    // close-territory, not suspend-territory.
    merged.autoSuspendHours = Number.isFinite(ah) && ah >= 1 ? Math.min(720, Math.max(1, Math.round(ah))) : DEFAULT_SETTINGS.autoSuspendHours;
    merged.accentColor = sanitizeHex(merged.accentColor) || DEFAULT_SETTINGS.accentColor;
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

/** Extract a normalized hostname from a tab url, or "" if it can't be parsed. */
function hostOfTab(tab) {
  if (!tab || typeof tab.url !== "string" || !tab.url) return "";
  try { return normalizeHost(new URL(tab.url).hostname); } catch { return ""; }
}

/** True if `host` is matched by the whitelist. Matches on exact host or any
 *  parent-domain suffix, so "github.com" protects "gist.github.com" too. */
function isHostWhitelisted(host, whitelist) {
  if (!host || !Array.isArray(whitelist) || whitelist.length === 0) return false;
  for (const w of whitelist) {
    if (!w) continue;
    if (host === w) return true;
    if (host.endsWith("." + w)) return true;
  }
  return false;
}

/**
 * Pure predicate: is this tab a valid candidate for the cold-close sweep?
 * Pinned tabs are NEVER candidates — that invariant is enforced here AND
 * re-checked immediately before chrome.tabs.remove to close the race where
 * a user pins a tab between scan and reap.
 */
function isColdCloseCandidate(tab, accessedMap, nowMs, thresholdMs, whitelist) {
  if (!tab || typeof tab.id !== "number") return false;
  if (tab.pinned === true) return false; // hard invariant — pinned is sacred.
  if (tab.active === true) return false;
  if (tab.audible === true) return false;
  if (isHostWhitelisted(hostOfTab(tab), whitelist)) return false;
  const stamp = effectiveStamp(tab, accessedMap);
  // If we genuinely have no signal (stamp 0), don't reap — safer default.
  if (stamp <= 0) return false;
  return (nowMs - stamp) >= thresholdMs;
}

/**
 * Close every tab idle longer than `days` days.
 * Excludes: pinned tabs (always), the currently-active tab in each window,
 * audible tabs, and tabs with no recorded access stamp. Pinned exclusion is
 * enforced twice: during the initial scan and again right before removal, so
 * a tab pinned mid-flight is preserved. Returns a summary.
 */
async function closeIdleTabs(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d < 1) {
    return { ok: false, error: "invalid_days", closed: 0, candidates: 0, scanned: 0, skippedPinned: 0 };
  }
  if (!chrome?.tabs?.query || !chrome?.tabs?.remove) {
    return { ok: false, error: "tabs_api_unavailable", closed: 0, candidates: 0, scanned: 0, skippedPinned: 0 };
  }
  const thresholdMs = d * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const [tabs, accessed, settings] = await Promise.all([
    chrome.tabs.query({}),
    readLastAccessed(),
    readSettings(),
  ]);
  const whitelist = sanitizeHostList(settings.coldWhitelist);
  const candidates = [];
  let skippedWhitelist = 0;
  for (const t of tabs) {
    if (isColdCloseCandidate(t, accessed, now, thresholdMs, whitelist)) candidates.push(t.id);
    else if (isHostWhitelisted(hostOfTab(t), whitelist) && t.pinned !== true && t.active !== true) skippedWhitelist++;
  }
  if (candidates.length === 0) {
    return { ok: true, closed: 0, candidates: 0, scanned: tabs.length, skippedPinned: 0, skippedWhitelist, days: d };
  }
  // Race-safe second pass: re-fetch each candidate by id and drop anything
  // that was pinned (or vanished) between the scan and now. This makes the
  // "pinned never closes" invariant robust even under user-concurrent edits.
  const verified = [];
  let skippedPinned = 0;
  await Promise.all(candidates.map(async (id) => {
    try {
      const fresh = await chrome.tabs.get(id);
      if (!fresh) return;
      if (fresh.pinned === true) { skippedPinned++; return; }
      // Re-verify whitelist post-scan: a URL change mid-flight could land the
      // tab on a protected host. Treat that the same as pinned — never close.
      if (isHostWhitelisted(hostOfTab(fresh), whitelist)) { skippedWhitelist++; return; }
      verified.push(id);
    } catch {
      // tab gone — silently skip.
    }
  }));
  if (verified.length === 0) {
    return { ok: true, closed: 0, candidates: candidates.length, scanned: tabs.length, skippedPinned, skippedWhitelist, days: d };
  }
  // Capture the soon-to-be-closed tabs' metadata BEFORE removal so the popup
  // can offer a working "Undo" toast. We need url/pinned/title and the heat
  // signals (lastAccessed, activations) to restore the prior state faithfully.
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const [counts] = await Promise.all([readActivationCounts()]);
  const closedTabs = [];
  for (const id of verified) {
    const t = byId.get(id);
    if (!t || !t.url) continue;
    closedTabs.push({
      url: t.url,
      title: t.title || "",
      pinned: !!t.pinned,
      windowId: t.windowId,
      lastAccessed: accessed[String(id)] || (typeof t.lastAccessed === "number" ? t.lastAccessed : 0),
      activations: typeof counts[String(id)] === "number" ? counts[String(id)] : 0,
    });
  }
  try {
    await chrome.tabs.remove(verified);
    // Best-effort cleanup of our maps; onRemoved listeners will catch most cases too.
    await Promise.all(verified.map((id) => forgetTab(id)));
    // Force an immediate badge recompute — onRemoved already schedules one,
    // but this collapses the visual delay after a manual cold-close burst.
    if (typeof scheduleBadgeRefresh === "function") scheduleBadgeRefresh(50);
    return { ok: true, closed: verified.length, closedTabs, candidates: candidates.length, scanned: tabs.length, skippedPinned, skippedWhitelist, days: d };
  } catch (err) {
    console.warn(LOG_PREFIX, "closeIdleTabs remove failed:", err);
    return { ok: false, error: String(err?.message || err), closed: 0, candidates: candidates.length, scanned: tabs.length, skippedPinned, skippedWhitelist, days: d };
  }
}

/**
 * Suspend (discard) every tab idle longer than `days` days, instead of
 * closing them. Discarded tabs vanish from RAM but keep their slot in the
 * tab strip and restore on click — a strictly less destructive cold-action.
 *
 * Same exclusions as closeIdleTabs: pinned, active, audible, whitelisted,
 * and tabs with no recorded access stamp. Additionally skips tabs that are
 * already discarded so the counts don't lie.
 */
async function suspendIdleTabs(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d < 1) {
    return { ok: false, error: "invalid_days", suspended: 0, candidates: 0, scanned: 0, skippedPinned: 0, skippedAlready: 0 };
  }
  if (!chrome?.tabs?.query || !chrome?.tabs?.discard) {
    return { ok: false, error: "discard_api_unavailable", suspended: 0, candidates: 0, scanned: 0, skippedPinned: 0, skippedAlready: 0 };
  }
  const thresholdMs = d * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const [tabs, accessed, settings] = await Promise.all([
    chrome.tabs.query({}),
    readLastAccessed(),
    readSettings(),
  ]);
  const whitelist = sanitizeHostList(settings.coldWhitelist);
  const candidates = [];
  let skippedWhitelist = 0;
  let skippedAlready = 0;
  for (const t of tabs) {
    if (!isColdCloseCandidate(t, accessed, now, thresholdMs, whitelist)) {
      if (isHostWhitelisted(hostOfTab(t), whitelist) && t.pinned !== true && t.active !== true) skippedWhitelist++;
      continue;
    }
    if (t.discarded === true) { skippedAlready++; continue; }
    candidates.push(t.id);
  }
  if (candidates.length === 0) {
    return { ok: true, suspended: 0, candidates: 0, scanned: tabs.length, skippedPinned: 0, skippedWhitelist, skippedAlready, days: d };
  }
  // Race-safe re-verify pass, mirroring closeIdleTabs. Pinned/whitelist/
  // already-discarded all bail.
  const verified = [];
  let skippedPinned = 0;
  await Promise.all(candidates.map(async (id) => {
    try {
      const fresh = await chrome.tabs.get(id);
      if (!fresh) return;
      if (fresh.pinned === true) { skippedPinned++; return; }
      if (fresh.active === true) return;
      if (fresh.discarded === true) { skippedAlready++; return; }
      if (isHostWhitelisted(hostOfTab(fresh), whitelist)) { skippedWhitelist++; return; }
      verified.push(id);
    } catch { /* tab gone */ }
  }));
  if (verified.length === 0) {
    return { ok: true, suspended: 0, candidates: candidates.length, scanned: tabs.length, skippedPinned, skippedWhitelist, skippedAlready, days: d };
  }
  // chrome.tabs.discard accepts a single tabId per call; fire in parallel
  // and count successes. Discard can refuse certain tabs (e.g. chrome://,
  // devtools) — those reject and we just skip them.
  let suspended = 0;
  const results = await Promise.allSettled(verified.map((id) => chrome.tabs.discard(id)));
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) suspended++;
  }
  if (typeof scheduleBadgeRefresh === "function") scheduleBadgeRefresh(50);
  return { ok: true, suspended, candidates: candidates.length, scanned: tabs.length, skippedPinned, skippedWhitelist, skippedAlready, days: d };
}

/** Storage key namespace for per-tab first-opened map. */
const FIRST_OPENED_KEY = "th:firstOpened";
/** Storage key namespace for per-tab last-accessed map. */
const LAST_ACCESSED_KEY = "th:lastAccessed";
/** Storage key namespace for per-tab activation-count map. */
const ACTIVATION_COUNT_KEY = "th:activationCounts";
/** Storage key namespace for per-tab activity sparkline buffer (rolling 24h). */
const ACTIVITY_SPARK_KEY = "th:activitySpark";
/** Rolling window kept for sparkline rendering. */
const SPARK_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Hard cap per-tab to bound storage even on hyperactive tabs. */
const SPARK_MAX_SAMPLES = 240;

/** Read the persisted first-opened map. Returns {} if uninitialized. */
async function readFirstOpened() {
  try {
    const out = await chrome.storage.session.get(FIRST_OPENED_KEY);
    const map = out?.[FIRST_OPENED_KEY];
    return (map && typeof map === "object") ? map : {};
  } catch (err) {
    console.warn(LOG_PREFIX, "readFirstOpened failed:", err);
    return {};
  }
}

/** Record the first-opened timestamp for a tab; never overwrites an
 *  existing entry so re-stamps from late onCreated events stay idempotent. */
async function recordFirstOpened(tabId, ts = Date.now()) {
  if (typeof tabId !== "number" || tabId < 0) return;
  try {
    const map = await readFirstOpened();
    const key = String(tabId);
    if (typeof map[key] === "number" && map[key] > 0) return;
    map[key] = ts;
    await chrome.storage.session.set({ [FIRST_OPENED_KEY]: map });
  } catch (err) {
    console.warn(LOG_PREFIX, "recordFirstOpened failed:", err);
  }
}

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

/** Read the persisted per-tab activity-sample map. Returns {} if uninitialized. */
async function readActivitySpark() {
  try {
    const out = await chrome.storage.session.get(ACTIVITY_SPARK_KEY);
    const map = out?.[ACTIVITY_SPARK_KEY];
    return (map && typeof map === "object") ? map : {};
  } catch (err) {
    console.warn(LOG_PREFIX, "readActivitySpark failed:", err);
    return {};
  }
}

/** Append an activity sample for a tab; prunes to the rolling 24h window. */
async function recordActivity(tabId, ts = Date.now()) {
  if (typeof tabId !== "number" || tabId < 0) return;
  try {
    const map = await readActivitySpark();
    const key = String(tabId);
    const cutoff = ts - SPARK_WINDOW_MS;
    const prev = Array.isArray(map[key]) ? map[key] : [];
    // Filter old + keep numeric; append new sample; cap length.
    const next = [];
    for (const v of prev) if (typeof v === "number" && v >= cutoff) next.push(v);
    next.push(ts);
    if (next.length > SPARK_MAX_SAMPLES) next.splice(0, next.length - SPARK_MAX_SAMPLES);
    map[key] = next;
    await chrome.storage.session.set({ [ACTIVITY_SPARK_KEY]: map });
  } catch (err) {
    console.warn(LOG_PREFIX, "recordActivity failed:", err);
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

/**
 * Manually boost a tab so it scores as the hottest in the list.
 * Stamps last-accessed to now (recency = 1.0) and raises the activation
 * count above the current max so frequency saturates too. The net heat is
 * effectively 1.0 under the popup's 0.6*recency + 0.4*frequency model.
 */
async function markTabHot(tabId, ts = Date.now()) {
  if (typeof tabId !== "number" || tabId < 0) {
    return { ok: false, error: "invalid_tab_id" };
  }
  try {
    const [accessed, counts, spark] = await Promise.all([
      readLastAccessed(),
      readActivationCounts(),
      readActivitySpark(),
    ]);
    const key = String(tabId);
    // Find the current max activation count across all tracked tabs so the
    // boosted tab lands strictly above it, regardless of prior usage.
    let maxCount = 0;
    for (const v of Object.values(counts)) {
      if (typeof v === "number" && v > maxCount) maxCount = v;
    }
    const cur = typeof counts[key] === "number" ? counts[key] : 0;
    // Boost: at least +5 over the previous max, and always +5 over the tab's
    // own prior count, so repeated boosts still notch upward.
    const boosted = Math.max(maxCount + 5, cur + 5);
    accessed[key] = ts;
    counts[key] = boosted;
    // Also append a sparkline sample so the recent-activity chart reflects
    // the manual interaction, not just background-detected events.
    const cutoff = ts - SPARK_WINDOW_MS;
    const prev = Array.isArray(spark[key]) ? spark[key] : [];
    const next = [];
    for (const v of prev) if (typeof v === "number" && v >= cutoff) next.push(v);
    next.push(ts);
    if (next.length > SPARK_MAX_SAMPLES) next.splice(0, next.length - SPARK_MAX_SAMPLES);
    spark[key] = next;
    await chrome.storage.session.set({
      [LAST_ACCESSED_KEY]: accessed,
      [ACTIVATION_COUNT_KEY]: counts,
      [ACTIVITY_SPARK_KEY]: spark,
    });
    // Boosting a tab can pull it out of the cold set, so recompute the badge
    // promptly instead of waiting for the next debounced tick.
    if (typeof scheduleBadgeRefresh === "function") scheduleBadgeRefresh(50);
    return { ok: true, tabId, activations: boosted, stamp: ts };
  } catch (err) {
    console.warn(LOG_PREFIX, "markTabHot failed:", err);
    return { ok: false, error: String(err?.message || err) };
  }
}

/** Drop a tab id from the maps when it closes. */
async function forgetTab(tabId) {
  try {
    const key = String(tabId);
    const [accessed, counts, spark, opened] = await Promise.all([
      readLastAccessed(),
      readActivationCounts(),
      readActivitySpark(),
      readFirstOpened(),
    ]);
    let dirtyA = false, dirtyC = false, dirtyS = false, dirtyO = false;
    if (key in accessed) { delete accessed[key]; dirtyA = true; }
    if (key in counts) { delete counts[key]; dirtyC = true; }
    if (key in spark) { delete spark[key]; dirtyS = true; }
    if (key in opened) { delete opened[key]; dirtyO = true; }
    const writes = {};
    if (dirtyA) writes[LAST_ACCESSED_KEY] = accessed;
    if (dirtyC) writes[ACTIVATION_COUNT_KEY] = counts;
    if (dirtyS) writes[ACTIVITY_SPARK_KEY] = spark;
    if (dirtyO) writes[FIRST_OPENED_KEY] = opened;
    if (dirtyA || dirtyC || dirtyS || dirtyO) await chrome.storage.session.set(writes);
  } catch (err) {
    console.warn(LOG_PREFIX, "forgetTab failed:", err);
  }
}

/**
 * Compute heat score for a tab using same model as the popup:
 *   heat = 0.6 * recency + 0.4 * frequency
 * recency = 0.5 ^ (ageMs / halfLifeMs); frequency = count / max(count).
 */
function computeHeat(tab, accessedMap, countsMap, maxCount, halfLifeMs, now, domainMap) {
  const key = String(tab?.id);
  const stamp = effectiveStamp(tab, accessedMap);
  const age = Math.max(0, now - stamp);
  // Per-domain override beats the global default.
  let hl = halfLifeMs;
  if (domainMap && tab?.url) {
    try {
      const host = normalizeHost(new URL(tab.url).hostname);
      const mins = domainMap[host];
      if (Number.isFinite(mins) && mins > 0) hl = mins * 60 * 1000;
    } catch { /* ignore unparseable urls */ }
  }
  const r = stamp > 0 ? Math.pow(0.5, age / hl) : 0;
  const c = typeof countsMap?.[key] === "number" ? countsMap[key] : 0;
  const f = maxCount > 0 ? Math.min(1, c / maxCount) : 0;
  return 0.6 * r + 0.4 * f;
}

/**
 * Find the hottest tab across all windows and focus it.
 * Excludes the currently-active tab in the focused window so the shortcut
 * always *moves* the user. Returns a summary.
 */
async function jumpToHottestTab() {
  if (!chrome?.tabs?.query) return { ok: false, error: "tabs_api_unavailable" };
  const settings = await readSettings();
  const halfLifeMs = Math.max(1, settings.recencyHalfLifeMinutes) * 60 * 1000;
  const [tabs, accessed, counts, currentWin] = await Promise.all([
    chrome.tabs.query({}),
    readLastAccessed(),
    readActivationCounts(),
    chrome.windows?.getLastFocused ? chrome.windows.getLastFocused({ populate: false }).catch(() => null) : Promise.resolve(null),
  ]);
  if (!tabs || tabs.length === 0) return { ok: false, error: "no_tabs" };
  const maxCount = Object.values(counts || {}).reduce((m, v) => (typeof v === "number" && v > m ? v : m), 0);
  const now = Date.now();
  const currentWinId = currentWin?.id;
  // Identify the focused window's active tab; we want to skip it so the
  // shortcut is a no-op-avoidance when the user is *on* the hottest tab.
  let activeInCurrent = null;
  for (const t of tabs) {
    if (t.windowId === currentWinId && t.active) { activeInCurrent = t.id; break; }
  }
  let best = null;
  let bestHeat = -1;
  for (const t of tabs) {
    if (!t || typeof t.id !== "number") continue;
    if (t.id === activeInCurrent) continue;
    const h = computeHeat(t, accessed, counts, maxCount, halfLifeMs, now, settings.domainHalfLifeMinutes);
    if (h > bestHeat) { bestHeat = h; best = t; }
  }
  if (!best) return { ok: false, error: "no_candidate" };
  try {
    await chrome.tabs.update(best.id, { active: true });
    if (chrome.windows?.update && typeof best.windowId === "number") {
      await chrome.windows.update(best.windowId, { focused: true });
    }
    return { ok: true, tabId: best.id, windowId: best.windowId, heat: bestHeat };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/** Seed the map with every currently-open tab on boot/install. */
async function seedFromOpenTabs() {
  try {
    if (!chrome?.tabs?.query) return;
    const tabs = await chrome.tabs.query({});
    const now = Date.now();
    const [accessed, opened] = await Promise.all([
      readLastAccessed(),
      readFirstOpened(),
    ]);
    for (const t of tabs) {
      if (typeof t.id !== "number") continue;
      const key = String(t.id);
      if (!(key in accessed)) {
        accessed[key] = typeof t.lastAccessed === "number" ? t.lastAccessed : now;
      }
      // First-opened is unknown for pre-existing tabs at SW boot; best we can
      // do is anchor to lastAccessed (or now) so the column shows *something*
      // sensible rather than "unknown". Real onCreated events take precedence.
      if (!(key in opened)) {
        opened[key] = typeof t.lastAccessed === "number" ? t.lastAccessed : now;
      }
    }
    await chrome.storage.session.set({
      [LAST_ACCESSED_KEY]: accessed,
      [FIRST_OPENED_KEY]: opened,
    });
  } catch (err) {
    console.warn(LOG_PREFIX, "seedFromOpenTabs failed:", err);
  }
}

// Stamp a tab's first-opened timestamp when it's created.
if (chrome?.tabs?.onCreated) {
  chrome.tabs.onCreated.addListener((tab) => {
    if (typeof tab?.id === "number") recordFirstOpened(tab.id);
  });
}

// Track activations as the canonical "accessed" signal and bump the counter.
if (chrome?.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    stampTab(tabId);
    bumpActivation(tabId);
    recordActivity(tabId);
  });
}
// A tab finishing a navigation/load also counts as access.
if (chrome?.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo?.status === "complete") {
      stampTab(tabId);
      recordActivity(tabId);
    }
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

// Keyboard shortcut: jump-to-hottest.
if (chrome?.commands?.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command === "jump-to-hottest") {
      const res = await jumpToHottestTab();
      if (!res.ok) console.warn(LOG_PREFIX, "jump-to-hottest:", res.error);
    }
  });
}

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
  if (msg.type === MSG.GET_ACTIVITY_SPARK) {
    readActivitySpark().then((map) => sendResponse({ ok: true, map, windowMs: SPARK_WINDOW_MS }));
    return true;
  }
  if (msg.type === MSG.GET_FIRST_OPENED) {
    readFirstOpened().then((map) => sendResponse({ ok: true, map }));
    return true;
  }
  if (msg.type === MSG.GET_SETTINGS) {
    readSettings().then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }
  if (msg.type === MSG.SET_SETTINGS) {
    writeSettings(msg.patch).then((settings) => sendResponse({ ok: !!settings, settings: settings || null }));
    return true;
  }
  if (msg.type === MSG.RESTORE_TAB_META) {
    (async () => {
      try {
        const entries = Array.isArray(msg.entries) ? msg.entries : [];
        const [accessed, counts] = await Promise.all([
          readLastAccessed(),
          readActivationCounts(),
        ]);
        let touched = 0;
        for (const e of entries) {
          if (!e || typeof e.tabId !== "number") continue;
          const key = String(e.tabId);
          if (Number.isFinite(e.lastAccessed) && e.lastAccessed > 0) {
            accessed[key] = e.lastAccessed;
            touched++;
          }
          if (Number.isFinite(e.activations) && e.activations > 0) {
            counts[key] = Math.floor(e.activations);
          }
        }
        await chrome.storage.session.set({
          [LAST_ACCESSED_KEY]: accessed,
          [ACTIVATION_COUNT_KEY]: counts,
        });
        sendResponse({ ok: true, touched });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
  if (msg.type === MSG.RESET_HEAT_DATA) {
    (async () => {
      try {
        // Wipe every tracked map so heat scores fall to zero everywhere.
        await chrome.storage.session.remove([
          LAST_ACCESSED_KEY,
          ACTIVATION_COUNT_KEY,
          ACTIVITY_SPARK_KEY,
          FIRST_OPENED_KEY,
        ]);
        // Reseed from currently-open tabs so the popup doesn't render an
        // empty list — every tab starts fresh from "now".
        await seedFromOpenTabs();
        sendResponse({ ok: true, resetAt: Date.now() });
      } catch (err) {
        console.warn(LOG_PREFIX, "resetHeatData failed:", err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
  if (msg.type === MSG.JUMP_HOTTEST) {
    jumpToHottestTab().then(sendResponse);
    return true;
  }
  if (msg.type === MSG.MARK_HOT) {
    (async () => {
      // Accept an explicit tabId; otherwise fall back to the active tab in
      // the focused window so the popup can fire-and-forget without lookups.
      let tabId = Number(msg?.tabId);
      if (!Number.isFinite(tabId) || tabId < 0) {
        try {
          const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          tabId = active?.id;
        } catch { /* ignore */ }
      }
      const res = await markTabHot(tabId);
      sendResponse(res);
    })();
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
  if (msg.type === MSG.SUSPEND_IDLE) {
    (async () => {
      const requested = Number(msg?.days);
      const settings = await readSettings();
      const days = Number.isFinite(requested) && requested >= 1 ? requested : settings.idleCloseDays;
      const result = await suspendIdleTabs(days);
      sendResponse(result);
    })();
    return true;
  }
  return false;
});

/**
 * Compute the count of cold tabs (idle > settings.idleCloseDays) and reflect
 * it on the toolbar badge. Empty string when zero so the badge stays clean.
 * Uses the same isColdCloseCandidate predicate as the bulk-close action so
 * the badge count and the close-idle action agree exactly.
 */
async function refreshColdBadge() {
  try {
    if (!chrome?.action?.setBadgeText) return;
    const [tabs, accessed, settings] = await Promise.all([
      chrome.tabs.query({}),
      readLastAccessed(),
      readSettings(),
    ]);
    const thresholdMs = Math.max(1, settings.idleCloseDays) * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const whitelist = sanitizeHostList(settings.coldWhitelist);
    let cold = 0;
    for (const t of tabs) {
      if (isColdCloseCandidate(t, accessed, now, thresholdMs, whitelist)) cold++;
    }
    const text = cold > 0 ? (cold > 999 ? "999+" : String(cold)) : "";
    await chrome.action.setBadgeText({ text });
    if (chrome.action.setBadgeBackgroundColor) {
      // Cool slate so a non-zero badge reads as informational, not alarming.
      await chrome.action.setBadgeBackgroundColor({ color: "#3b4252" });
    }
    if (chrome.action.setBadgeTextColor) {
      try { await chrome.action.setBadgeTextColor({ color: "#ffffff" }); } catch { /* older runtimes */ }
    }
    const titleBase = "Tab Heatmap";
    const title = cold > 0
      ? `${titleBase} \u2014 ${cold} cold tab${cold === 1 ? "" : "s"} (idle > ${settings.idleCloseDays}d)`
      : titleBase;
    if (chrome.action.setTitle) await chrome.action.setTitle({ title });
    return cold;
  } catch (err) {
    console.warn(LOG_PREFIX, "refreshColdBadge failed:", err);
    return -1;
  }
}

/** Debounced badge refresh — coalesces bursts of tab events. */
let _badgeTimer = null;
function scheduleBadgeRefresh(delayMs = 750) {
  if (_badgeTimer) return;
  _badgeTimer = setTimeout(() => {
    _badgeTimer = null;
    refreshColdBadge();
  }, delayMs);
}

// Refresh the badge on tab lifecycle changes so it stays roughly live.
if (chrome?.tabs?.onActivated) chrome.tabs.onActivated.addListener(() => scheduleBadgeRefresh());
if (chrome?.tabs?.onRemoved) chrome.tabs.onRemoved.addListener(() => scheduleBadgeRefresh());
if (chrome?.tabs?.onCreated) chrome.tabs.onCreated.addListener(() => scheduleBadgeRefresh());
if (chrome?.tabs?.onUpdated) chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change?.pinned !== undefined || change?.url || change?.status === "complete") {
    scheduleBadgeRefresh();
  }
});

// Periodic refresh: tabs grow colder with the clock, not just with events.
const BADGE_ALARM = "th:badgeRefresh";
if (chrome?.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((a) => {
    if (a?.name === BADGE_ALARM) refreshColdBadge();
  });
}
async function ensureBadgeAlarm() {
  try {
    if (!chrome?.alarms?.create) return;
    const existing = chrome.alarms.get ? await chrome.alarms.get(BADGE_ALARM) : null;
    if (!existing) {
      // Every 5 minutes is plenty — the threshold is measured in days.
      chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 5 });
    }
  } catch (err) {
    console.warn(LOG_PREFIX, "ensureBadgeAlarm failed:", err);
  }
}

// Re-render the badge whenever settings change (idleCloseDays / whitelist).
if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes && changes[SETTINGS_KEY]) scheduleBadgeRefresh(250);
  });
}

// Wire badge bootstrap into the existing install/startup paths.
chrome.runtime.onInstalled.addListener(() => { ensureBadgeAlarm(); scheduleBadgeRefresh(250); });
chrome.runtime.onStartup.addListener(() => { ensureBadgeAlarm(); scheduleBadgeRefresh(250); });
// And on cold SW boot — the listeners above only fire on those lifecycle
// events, but a freshly-spawned SW (e.g. after idle eviction) also needs a
// kick to render the badge against the current tab state.
ensureBadgeAlarm();
scheduleBadgeRefresh(500);

/**
 * Context menu: "Mark tab as hot". Registered on install + startup so the
 * entry survives SW eviction. Fires markTabHot() against the clicked tab.
 */
const CTX_MARK_HOT_ID = "th:markHot";
async function ensureContextMenus() {
  try {
    if (!chrome?.contextMenus?.create) return;
    // removeAll → create avoids the "duplicate id" error that fires when both
    // onInstalled and onStartup run during the same SW lifetime.
    await new Promise((resolve) => {
      try { chrome.contextMenus.removeAll(() => resolve()); }
      catch { resolve(); }
    });
    chrome.contextMenus.create({
      id: CTX_MARK_HOT_ID,
      title: "Mark tab as hot \u2014 Tab Heatmap",
      // "page" covers the page body; "frame" picks up iframes; "link/image/
      // selection" make the entry reachable from common right-click contexts.
      contexts: ["page", "frame", "link", "image", "selection"],
    });
  } catch (err) {
    console.warn(LOG_PREFIX, "ensureContextMenus failed:", err);
  }
}
if (chrome?.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info?.menuItemId !== CTX_MARK_HOT_ID) return;
    const tabId = typeof tab?.id === "number" ? tab.id : undefined;
    if (typeof tabId !== "number") {
      console.warn(LOG_PREFIX, "context menu click with no tab id");
      return;
    }
    const res = await markTabHot(tabId);
    if (!res.ok) console.warn(LOG_PREFIX, "markTabHot via context menu:", res.error);
  });
}
chrome.runtime.onInstalled.addListener(() => { ensureContextMenus(); });
chrome.runtime.onStartup.addListener(() => { ensureContextMenus(); });
// And on cold SW boot, in case neither lifecycle event fires this tick.
ensureContextMenus();

console.log(LOG_PREFIX, "service worker booted");

/**
 * Daily summary notification — posts a single "X cold tabs ready to close"
 * banner once per day. Uses chrome.alarms scheduled to the user's preferred
 * local hour-of-day. Persists last-fired stamp under DAILY_SUMMARY_KEY so a
 * mid-day SW restart can't double-fire.
 */
const DAILY_SUMMARY_ALARM = "th:dailySummary";
const DAILY_SUMMARY_KEY = "th:dailySummaryLast";
const DAILY_NOTIF_ID = "th:dailySummary:notif";

/** Compute the next epoch-ms timestamp for the given local hour. */
function nextLocalHour(hour) {
  const h = Math.min(23, Math.max(0, Math.round(Number(hour) || 0)));
  const now = new Date();
  const fire = new Date(now);
  fire.setHours(h, 0, 0, 0);
  if (fire.getTime() <= now.getTime()) fire.setDate(fire.getDate() + 1);
  return fire.getTime();
}

/** Count cold tabs using the same predicate as the badge. */
async function countColdTabs() {
  try {
    if (!chrome?.tabs?.query) return 0;
    const [tabs, accessed, settings] = await Promise.all([
      chrome.tabs.query({}),
      readLastAccessed(),
      readSettings(),
    ]);
    const thresholdMs = Math.max(1, settings.idleCloseDays) * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const whitelist = sanitizeHostList(settings.coldWhitelist);
    let cold = 0;
    for (const t of tabs) {
      if (isColdCloseCandidate(t, accessed, now, thresholdMs, whitelist)) cold++;
    }
    return cold;
  } catch (err) {
    console.warn(LOG_PREFIX, "countColdTabs failed:", err);
    return 0;
  }
}

/** Fire the summary notification if conditions warrant. */
async function fireDailySummary() {
  try {
    const settings = await readSettings();
    if (!settings.dailySummaryEnabled) return;
    if (!chrome?.notifications?.create) return;
    // De-dupe within the same calendar day in case the alarm fires twice.
    const last = await chrome.storage.local.get(DAILY_SUMMARY_KEY);
    const lastTs = Number(last?.[DAILY_SUMMARY_KEY]) || 0;
    if (lastTs > 0) {
      const lastDay = new Date(lastTs).toDateString();
      const today = new Date().toDateString();
      if (lastDay === today) return;
    }
    const cold = await countColdTabs();
    if (cold <= 0) {
      // Nothing cold today — still mark the day so we don't re-check on every event.
      await chrome.storage.local.set({ [DAILY_SUMMARY_KEY]: Date.now() });
      return;
    }
    const title = "Tab Heatmap";
    const message = `${cold} cold tab${cold === 1 ? "" : "s"} ready to close \u2014 idle > ${settings.idleCloseDays}d.`;
    try {
      await new Promise((resolve) => {
        chrome.notifications.create(DAILY_NOTIF_ID, {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
          title,
          message,
          priority: 0,
          requireInteraction: false,
        }, () => resolve());
      });
    } catch (err) {
      console.warn(LOG_PREFIX, "notifications.create failed:", err);
    }
    await chrome.storage.local.set({ [DAILY_SUMMARY_KEY]: Date.now() });
  } catch (err) {
    console.warn(LOG_PREFIX, "fireDailySummary failed:", err);
  }
}

/** Schedule the daily summary alarm at the user's preferred hour. */
async function ensureDailySummaryAlarm() {
  try {
    if (!chrome?.alarms?.create) return;
    const settings = await readSettings();
    if (!settings.dailySummaryEnabled) {
      try { await chrome.alarms.clear(DAILY_SUMMARY_ALARM); } catch { /* noop */ }
      return;
    }
    const when = nextLocalHour(settings.dailySummaryHour);
    // periodInMinutes=1440 keeps it daily after the first fire.
    chrome.alarms.create(DAILY_SUMMARY_ALARM, { when, periodInMinutes: 1440 });
  } catch (err) {
    console.warn(LOG_PREFIX, "ensureDailySummaryAlarm failed:", err);
  }
}

if (chrome?.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((a) => {
    if (a?.name === DAILY_SUMMARY_ALARM) fireDailySummary();
  });
}

// Clicking the notification opens the popup-equivalent action page so the
// user can act on the summary immediately. Chrome doesn't let extensions
// open the action popup programmatically, so we fall back to the options
// page (which surfaces the same close-cold controls path).
if (chrome?.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener((id) => {
    if (id !== DAILY_NOTIF_ID) return;
    try { chrome.notifications.clear(DAILY_NOTIF_ID); } catch { /* noop */ }
    try {
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    } catch (err) {
      console.warn(LOG_PREFIX, "openOptionsPage failed:", err);
    }
  });
}

// Re-schedule when the user changes the hour or toggles the feature.
if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes || !changes[SETTINGS_KEY]) return;
    const prev = changes[SETTINGS_KEY].oldValue || {};
    const next = changes[SETTINGS_KEY].newValue || {};
    if (prev.dailySummaryEnabled !== next.dailySummaryEnabled ||
        prev.dailySummaryHour !== next.dailySummaryHour) {
      ensureDailySummaryAlarm();
    }
  });
}

chrome.runtime.onInstalled.addListener(() => { ensureDailySummaryAlarm(); });
chrome.runtime.onStartup.addListener(() => { ensureDailySummaryAlarm(); });
ensureDailySummaryAlarm();

/**
 * Auto-suspend rule — periodic alarm that discards tabs idle longer than
 * `settings.autoSuspendHours`. Reuses the same isColdCloseCandidate
 * predicate (with an hours-based threshold) so the auto behaviour matches
 * the manual Suspend Cold action: pinned/active/audible/whitelisted tabs
 * and tabs with no recorded access stamp are always preserved. Tabs that
 * are already discarded are skipped so the cycle is a no-op once the cold
 * tail is suspended.
 */
const AUTO_SUSPEND_ALARM = "th:autoSuspend";
/** How often the alarm wakes up. Hours is the user-visible knob; this is
 *  just the polling cadence and is intentionally fast enough that the rule
 *  feels live, but slow enough to not waste cycles. */
const AUTO_SUSPEND_PERIOD_MIN = 15;

async function runAutoSuspendCycle() {
  try {
    const settings = await readSettings();
    if (!settings.autoSuspendEnabled) return { ok: true, skipped: "disabled" };
    if (!chrome?.tabs?.query || !chrome?.tabs?.discard) {
      return { ok: false, error: "discard_api_unavailable" };
    }
    const hours = Math.max(1, Math.min(720, Math.round(Number(settings.autoSuspendHours) || 24)));
    const thresholdMs = hours * 60 * 60 * 1000;
    const now = Date.now();
    const [tabs, accessed] = await Promise.all([
      chrome.tabs.query({}),
      readLastAccessed(),
    ]);
    const whitelist = sanitizeHostList(settings.coldWhitelist);
    const candidates = [];
    for (const t of tabs) {
      if (!isColdCloseCandidate(t, accessed, now, thresholdMs, whitelist)) continue;
      if (t.discarded === true) continue;
      candidates.push(t.id);
    }
    if (candidates.length === 0) return { ok: true, suspended: 0 };
    // Race-safe re-verify, identical posture to the manual suspend path.
    const verified = [];
    await Promise.all(candidates.map(async (id) => {
      try {
        const fresh = await chrome.tabs.get(id);
        if (!fresh) return;
        if (fresh.pinned === true) return;
        if (fresh.active === true) return;
        if (fresh.discarded === true) return;
        if (isHostWhitelisted(hostOfTab(fresh), whitelist)) return;
        verified.push(id);
      } catch { /* tab gone */ }
    }));
    if (verified.length === 0) return { ok: true, suspended: 0 };
    let suspended = 0;
    const results = await Promise.allSettled(verified.map((id) => chrome.tabs.discard(id)));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) suspended++;
    }
    if (suspended > 0 && typeof scheduleBadgeRefresh === "function") scheduleBadgeRefresh(50);
    return { ok: true, suspended, candidates: candidates.length };
  } catch (err) {
    console.warn(LOG_PREFIX, "runAutoSuspendCycle failed:", err);
    return { ok: false, error: String(err?.message || err) };
  }
}

async function ensureAutoSuspendAlarm() {
  try {
    if (!chrome?.alarms?.create) return;
    const settings = await readSettings();
    if (!settings.autoSuspendEnabled) {
      try { await chrome.alarms.clear(AUTO_SUSPEND_ALARM); } catch { /* noop */ }
      return;
    }
    chrome.alarms.create(AUTO_SUSPEND_ALARM, { periodInMinutes: AUTO_SUSPEND_PERIOD_MIN });
  } catch (err) {
    console.warn(LOG_PREFIX, "ensureAutoSuspendAlarm failed:", err);
  }
}

if (chrome?.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((a) => {
    if (a?.name === AUTO_SUSPEND_ALARM) runAutoSuspendCycle();
  });
}

// Re-arm when the user flips the toggle or changes the hour threshold.
if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes || !changes[SETTINGS_KEY]) return;
    const prev = changes[SETTINGS_KEY].oldValue || {};
    const next = changes[SETTINGS_KEY].newValue || {};
    if (prev.autoSuspendEnabled !== next.autoSuspendEnabled ||
        prev.autoSuspendHours !== next.autoSuspendHours) {
      ensureAutoSuspendAlarm();
      // Fire a cycle immediately when the rule is freshly enabled so the
      // user sees the effect without waiting for the first 15-min tick.
      if (next.autoSuspendEnabled && !prev.autoSuspendEnabled) {
        runAutoSuspendCycle();
      }
    }
  });
}

chrome.runtime.onInstalled.addListener(() => { ensureAutoSuspendAlarm(); });
chrome.runtime.onStartup.addListener(() => { ensureAutoSuspendAlarm(); });
ensureAutoSuspendAlarm();
