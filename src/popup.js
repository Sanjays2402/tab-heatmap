// Tab Heatmap — popup entry point.
// Renders the open-tab list with a heat score (recency × frequency).

const LOG = "[tab-heatmap:popup]";

const MSG = Object.freeze({
  GET_LAST_ACCESSED: "th:getLastAccessed",
  JUMP_HOTTEST: "th:jumpHottest",
  GET_ACTIVATION_COUNTS: "th:getActivationCounts",
  GET_ACTIVITY_SPARK: "th:getActivitySpark",
  GET_FIRST_OPENED: "th:getFirstOpened",
  CLOSE_IDLE: "th:closeIdle",
  SUSPEND_IDLE: "th:suspendIdle",
  GET_SETTINGS: "th:getSettings",
  RESTORE_TAB_META: "th:restoreTabMeta",
});

// Recency half-life default: a tab cools to 0.5 heat after this many ms since last access.
// Effective value comes from user settings (recencyHalfLifeMinutes); this is just the fallback.
const DEFAULT_RECENCY_HALF_LIFE_MS = 30 * 60 * 1000; // 30 minutes
// Recency contribution to the overall heat score.
const RECENCY_WEIGHT = 0.6;
const FREQUENCY_WEIGHT = 0.4;
// Default "hot" cutoff used for the footer stat; user-configurable via the options page.
const DEFAULT_HOT_THRESHOLD = 0.5;

// Mutable runtime configuration, hydrated from settings on render.
let RECENCY_HALF_LIFE_MS = DEFAULT_RECENCY_HALF_LIFE_MS;
let HOT_THRESHOLD = DEFAULT_HOT_THRESHOLD;
// host -> half-life minutes override map, hydrated from settings.
let DOMAIN_HALF_LIFE = {};

/** Normalize a hostname for the per-domain map lookup. */
function normalizeHost(h) {
  if (typeof h !== "string") return "";
  return h.trim().toLowerCase().replace(/^www\./, "");
}

/** Effective half-life in ms for a given URL (falls back to global). */
function halfLifeForUrl(url) {
  if (!url) return RECENCY_HALF_LIFE_MS;
  try {
    const host = normalizeHost(new URL(url).hostname);
    const mins = DOMAIN_HALF_LIFE[host];
    if (Number.isFinite(mins) && mins > 0) return mins * 60 * 1000;
  } catch { /* fall through */ }
  return RECENCY_HALF_LIFE_MS;
}

/** Detect prefers-color-scheme and set body theme accordingly.
 * If `preference` is 'light' or 'dark', force it. Otherwise auto-follow OS
 * and subscribe to changes for the lifetime of the popup.
 */
let THEME_MEDIA = null;
let THEME_LISTENER = null;
function applyTheme(preference) {
  const pref = preference === "light" || preference === "dark" ? preference : "auto";
  // Clear any prior auto-mode listener so we don't double-bind.
  if (THEME_MEDIA && THEME_LISTENER) {
    try { THEME_MEDIA.removeEventListener("change", THEME_LISTENER); } catch { /* noop */ }
    THEME_LISTENER = null;
  }
  try {
    if (pref === "auto") {
      THEME_MEDIA = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
      const setFromMedia = () => {
        const dark = !!(THEME_MEDIA && THEME_MEDIA.matches);
        document.body.dataset.theme = dark ? "dark" : "light";
      };
      setFromMedia();
      if (THEME_MEDIA && typeof THEME_MEDIA.addEventListener === "function") {
        THEME_LISTENER = setFromMedia;
        THEME_MEDIA.addEventListener("change", THEME_LISTENER);
      }
    } else {
      document.body.dataset.theme = pref;
    }
  } catch {
    document.body.dataset.theme = "dark";
  }
}

/** Wrap chrome.runtime.sendMessage in a promise with a safe fallback. */
function sendMessage(type, payload) {
  return new Promise((resolve) => {
    try {
      const msg = Object.assign({ type }, payload && typeof payload === "object" ? payload : {});
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          console.warn(LOG, "sendMessage error:", chrome.runtime.lastError.message);
          resolve({ ok: false, map: {} });
          return;
        }
        resolve(resp || { ok: false, map: {} });
      });
    } catch (err) {
      console.warn(LOG, "sendMessage threw:", err);
      resolve({ ok: false, map: {} });
    }
  });
}

/** Query all tabs across all windows. */
async function getAllTabs() {
  try {
    return await chrome.tabs.query({});
  } catch (err) {
    console.warn(LOG, "tabs.query failed:", err);
    return [];
  }
}

/** Compute recency score in [0, 1] given last-access timestamp and a half-life. */
function recencyScore(lastAccessedMs, now, halfLifeMs) {
  if (!Number.isFinite(lastAccessedMs)) return 0;
  const age = Math.max(0, now - lastAccessedMs);
  const hl = (Number.isFinite(halfLifeMs) && halfLifeMs > 0) ? halfLifeMs : RECENCY_HALF_LIFE_MS;
  // Exponential decay with half-life hl.
  return Math.pow(0.5, age / hl);
}

/** Normalize activation count to [0,1] using the max in the set. */
function frequencyScore(count, maxCount) {
  if (!maxCount || maxCount <= 0) return 0;
  return Math.min(1, Math.max(0, (count || 0) / maxCount));
}

/** Compose a tab "row model" used for rendering and sorting. */
function buildRows(tabs, accessedMap, countsMap, sparkMap, openedMap) {
  const now = Date.now();
  const maxCount = Object.values(countsMap || {})
    .reduce((m, v) => (typeof v === "number" && v > m ? v : m), 0);

  return tabs.map((t) => {
    const key = String(t.id);
    const stamp = typeof accessedMap[key] === "number"
      ? accessedMap[key]
      : (typeof t.lastAccessed === "number" ? t.lastAccessed : 0);
    const count = typeof countsMap[key] === "number" ? countsMap[key] : 0;
    const hl = halfLifeForUrl(t.url);
    const r = recencyScore(stamp, now, hl);
    const f = frequencyScore(count, maxCount);
    const heat = RECENCY_WEIGHT * r + FREQUENCY_WEIGHT * f;
    const samples = Array.isArray(sparkMap?.[key]) ? sparkMap[key] : [];
    const opened = typeof openedMap?.[key] === "number" ? openedMap[key] : 0;
    return {
      id: t.id,
      windowId: t.windowId,
      title: t.title || t.url || "Untitled",
      url: t.url || "",
      favIconUrl: t.favIconUrl || "",
      active: !!t.active,
      pinned: !!t.pinned,
      audible: !!t.audible,
      muted: !!(t.mutedInfo && t.mutedInfo.muted),
      lastAccessed: stamp,
      firstOpened: opened,
      activations: count,
      sparkSamples: samples,
      recency: r,
      frequency: f,
      heat,
    };
  }).sort((a, b) => b.heat - a.heat);
}

/**
 * Sort row models by the chosen mode.
 * Modes: "heat" (default), "recency", "frequency", "alpha".
 * Returns a new array; never mutates the input.
 */
function sortRows(rows, mode) {
  const arr = Array.isArray(rows) ? rows.slice() : [];
  const cmpAlpha = (a, b) => {
    const at = (a.title || a.url || "").toLowerCase();
    const bt = (b.title || b.url || "").toLowerCase();
    return at.localeCompare(bt);
  };
  switch (mode) {
    case "recency":
      // Most-recently accessed first; unknowns sink to the bottom.
      arr.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0) || b.heat - a.heat);
      break;
    case "frequency":
      arr.sort((a, b) => (b.activations || 0) - (a.activations || 0) || b.heat - a.heat);
      break;
    case "alpha":
      arr.sort(cmpAlpha);
      break;
    case "heat":
    default:
      arr.sort((a, b) => b.heat - a.heat);
      break;
  }
  return arr;
}

/** Sort host groups according to the chosen mode. Children are sorted too. */
function sortGroups(groups, mode) {
  const arr = Array.isArray(groups) ? groups.slice() : [];
  for (const g of arr) g.rows = sortRows(g.rows, mode);
  switch (mode) {
    case "recency": {
      const stamp = (g) => g.rows.reduce((m, r) => Math.max(m, r.lastAccessed || 0), 0);
      arr.sort((a, b) => stamp(b) - stamp(a) || b.heat - a.heat);
      break;
    }
    case "frequency":
      arr.sort((a, b) => (b.activations || 0) - (a.activations || 0) || b.heat - a.heat);
      break;
    case "alpha":
      arr.sort((a, b) => a.host.localeCompare(b.host));
      break;
    case "heat":
    default:
      arr.sort((a, b) => b.heat - a.heat || b.rows.length - a.rows.length);
      break;
  }
  return arr;
}

/**
 * Map a heat score in [0,1] to a CSS color along the gradient:
 *   cold (≤0)   → blue   #3da3ff
 *   mid  (0.5)  → amber  #ffb547
 *   hot  (≥1)   → red    #ff3b2f
 * Linear RGB interpolation between the two anchors that bracket `heat`.
 */
function heatColor(heat) {
  const t = Math.min(1, Math.max(0, Number.isFinite(heat) ? heat : 0));
  const cold  = [0x3d, 0xa3, 0xff];
  const amber = [0xff, 0xb5, 0x47];
  const hot   = [0xff, 0x3b, 0x2f];
  const lerp = (a, b, k) => Math.round(a + (b - a) * k);
  let rgb;
  if (t <= 0.5) {
    const k = t / 0.5;
    rgb = [0, 1, 2].map((i) => lerp(cold[i], amber[i], k));
  } else {
    const k = (t - 0.5) / 0.5;
    rgb = [0, 1, 2].map((i) => lerp(amber[i], hot[i], k));
  }
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

/** Safely derive a short hostname from a URL string. */
function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

// Two-label suffixes we want to keep together when computing eTLD+1
// (so `bbc.co.uk` clusters as `bbc.co.uk`, not `co.uk`). This is a
// pragmatic heuristic, not a full Public Suffix List — good enough for
// tab clustering and ships zero network calls.
const MULTILABEL_SUFFIXES = new Set([
  "co.uk","ac.uk","gov.uk","org.uk","me.uk","net.uk","sch.uk",
  "com.au","net.au","org.au","edu.au","gov.au",
  "co.jp","ne.jp","or.jp","ac.jp","go.jp",
  "co.in","net.in","org.in","gov.in","ac.in",
  "com.br","net.br","org.br","gov.br",
  "co.nz","net.nz","org.nz","govt.nz",
  "co.kr","or.kr",
  "co.za","org.za",
  "com.mx","com.ar","com.tr","com.sg","com.hk","com.tw",
  "com.cn","net.cn","org.cn","gov.cn","ac.cn"
]);

/**
 * Compute a registrable-domain-like cluster key from a URL.
 * Examples:
 *   mail.google.com  → google.com
 *   docs.google.com  → google.com
 *   foo.bar.bbc.co.uk → bbc.co.uk
 *   localhost / file: → (local)
 *   1.2.3.4 (IP)     → 1.2.3.4
 *   chrome://...     → chrome (scheme bucket)
 */
function clusterKeyOf(url) {
  if (!url || typeof url !== "string") return "(local)";
  let u;
  try { u = new URL(url); } catch { return "(local)"; }
  const proto = u.protocol.replace(/:$/, "");
  if (proto && proto !== "http" && proto !== "https" && proto !== "ftp" && proto !== "ws" && proto !== "wss") {
    // chrome:, edge:, about:, file:, view-source:, etc.
    return proto || "(local)";
  }
  let host = u.hostname.replace(/^www\./, "");
  if (!host) return "(local)";
  // IPv4 / IPv6 → cluster as-is.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return host;
  // Single-label hosts (localhost, intranet boxes) cluster as-is.
  if (!host.includes(".")) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  if (MULTILABEL_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

/** Inline SVG fallback for tabs without a favicon (Phosphor-ish globe). */
function fallbackFaviconSVG() {
  return (
    '<span class="tab-favicon-fallback" aria-hidden="true">' +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>' +
    '</svg></span>'
  );
}

/**
 * Format a millisecond timestamp as a compact relative string
 *   ("just now", "5m ago", "3h ago", "2d ago"). Returns "never" for falsy stamps.
 */
function formatRelativeTime(stamp, now) {
  if (!Number.isFinite(stamp) || stamp <= 0) return "never";
  const ref = Number.isFinite(now) ? now : Date.now();
  const diff = Math.max(0, ref - stamp);
  const s = Math.floor(diff / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}

/** Format a millisecond timestamp as a locale string, or "" if invalid. */
function formatAbsoluteTime(stamp) {
  if (!Number.isFinite(stamp) || stamp <= 0) return "";
  try { return new Date(stamp).toLocaleString(); } catch { return ""; }
}

/**
 * Compact, fixed-width-ish age label for the tab-age column. Picks the
 * largest unit and rounds (e.g. "3m", "2h", "5d", "3w", "4mo", "1y").
 * Sub-minute ages collapse to "<1m" so the column never reads as zero.
 */
function formatCompactAge(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  const s = Math.floor(n / 1000);
  if (s < 60) return "<1m";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  const y = Math.floor(d / 365);
  return `${y}y`;
}

/** Verbose age label used in the tooltip (e.g. "3 days 4 hours"). */
function formatAbsoluteAgo(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "unknown";
  const s = Math.floor(n / 1000);
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d} day${d === 1 ? "" : "s"}`;
  const mo = Math.floor(d / 30);
  if (mo < 24) return `${mo} month${mo === 1 ? "" : "s"}`;
  const y = Math.floor(d / 365);
  return `${y} year${y === 1 ? "" : "s"}`;
}

// Heat histogram geometry. Buckets cover [0,1] heat range with one slot per bin.
const HIST_BUCKETS = 12;

/**
 * Bucketize a list of row heat scores in [0,1] into `HIST_BUCKETS` bins.
 * Returns { counts: number[HIST_BUCKETS], max, total, hot, cold, hotThreshold }.
 * `cold` is the count of rows with heat < 0.2 — that's the cold-close pool.
 */
function buildHeatHistogram(rows, hotThreshold) {
  const counts = new Array(HIST_BUCKETS).fill(0);
  let hot = 0, cold = 0;
  const cutHot = Number.isFinite(hotThreshold) ? hotThreshold : 0.5;
  for (const r of rows) {
    const h = Math.max(0, Math.min(1, Number.isFinite(r.heat) ? r.heat : 0));
    let idx = Math.floor(h * HIST_BUCKETS);
    if (idx >= HIST_BUCKETS) idx = HIST_BUCKETS - 1;
    counts[idx]++;
    if (h >= cutHot) hot++;
    if (h < 0.2) cold++;
  }
  const max = counts.reduce((m, v) => v > m ? v : m, 0);
  return { counts, max, total: rows.length, hot, cold, hotThreshold: cutHot };
}

/** Render the heat mini-map: a compact grid where each cell is one tab,
 * colored by its current heat. Clicking a cell focuses that tab. */
function renderHeatMinimap(rows) {
  const wrap = document.getElementById("heat-minimap");
  const grid = document.getElementById("hm-grid");
  const meta = document.getElementById("hm-meta");
  if (!wrap || !grid) return;
  if (!rows || rows.length === 0) {
    wrap.classList.add("hidden");
    grid.innerHTML = "";
    return;
  }
  wrap.classList.remove("hidden");
  grid.innerHTML = "";
  const frag = document.createDocumentFragment();
  let hot = 0;
  for (const row of rows) {
    const h = Math.max(0, Math.min(1, Number.isFinite(row.heat) ? row.heat : 0));
    if (h >= HOT_THRESHOLD) hot++;
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "hm-cell";
    if (row.pinned) cell.classList.add("is-pinned");
    if (row.active) cell.classList.add("is-active");
    cell.style.setProperty("--cell-color", heatColor(h));
    cell.setAttribute("role", "listitem");
    cell.setAttribute("data-tab-id", String(row.id));
    cell.setAttribute("data-window-id", String(row.windowId ?? ""));
    const title = (row.title && row.title.trim()) || (row.url ? row.url.slice(0, 64) : "Untitled");
    cell.title = `${title} — heat ${Math.round(h * 100)}%${row.pinned ? " • pinned" : ""}`;
    cell.setAttribute("aria-label", cell.title);
    cell.addEventListener("click", () => focusTab(row.id, row.windowId));
    frag.appendChild(cell);
  }
  grid.appendChild(frag);
  if (meta) meta.textContent = `${rows.length} tab${rows.length === 1 ? "" : "s"} • ${hot} hot`;
}

/** Render the heat histogram into the popup; hidden when no tabs. */
function renderHeatHistogram(rows) {
  const wrap = document.getElementById("heat-histogram");
  const bars = document.getElementById("hh-bars");
  const meta = document.getElementById("hh-meta");
  if (!wrap || !bars) return;
  if (!rows || rows.length === 0) {
    wrap.classList.add("hidden");
    return;
  }
  const hist = buildHeatHistogram(rows, HOT_THRESHOLD);
  wrap.classList.remove("hidden");
  bars.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (let i = 0; i < hist.counts.length; i++) {
    const c = hist.counts[i];
    const mid = (i + 0.5) / HIST_BUCKETS;
    const color = heatColor(mid);
    const pct = hist.max > 0 ? (c / hist.max) * 100 : 0;
    const bar = document.createElement("span");
    bar.className = "hh-bar" + (c === 0 ? " hh-bar--empty" : "");
    bar.style.setProperty("--bar-h", `${Math.max(c === 0 ? 3 : 8, pct)}%`);
    bar.style.setProperty("--bar-color", color);
    bar.title = `${c} tab${c === 1 ? "" : "s"} (heat ${Math.round(i * 100 / HIST_BUCKETS)}–${Math.round((i + 1) * 100 / HIST_BUCKETS)})`;
    bar.setAttribute("aria-label", bar.title);
    frag.appendChild(bar);
  }
  bars.appendChild(frag);
  if (meta) {
    meta.textContent = `${hist.total} tabs • ${hist.hot} hot • ${hist.cold} cold`;
  }
}

// Sparkline geometry. 24 hourly buckets covering the last 24h.
const SPARK_BUCKETS = 24;
const SPARK_WINDOW_MS = 24 * 60 * 60 * 1000;
const SPARK_W = 56;
const SPARK_H = 16;

/** Bucketize a list of millisecond timestamps into `SPARK_BUCKETS` hourly bins
 * ending at `now`. Returns a fixed-length integer array of counts (oldest→newest).
 */
function bucketizeActivity(samples, now) {
  const out = new Array(SPARK_BUCKETS).fill(0);
  if (!Array.isArray(samples) || samples.length === 0) return out;
  const ref = Number.isFinite(now) ? now : Date.now();
  const start = ref - SPARK_WINDOW_MS;
  const span = SPARK_WINDOW_MS / SPARK_BUCKETS;
  for (const ts of samples) {
    if (!Number.isFinite(ts) || ts < start || ts > ref) continue;
    let idx = Math.floor((ts - start) / span);
    if (idx < 0) idx = 0;
    if (idx >= SPARK_BUCKETS) idx = SPARK_BUCKETS - 1;
    out[idx]++;
  }
  return out;
}

/** Build an SVG path string for a smooth area sparkline. */
function sparkPath(buckets, w, h, pad) {
  const n = buckets.length;
  if (n === 0) return { line: "", area: "", max: 0 };
  const max = buckets.reduce((m, v) => v > m ? v : m, 0);
  const innerW = Math.max(1, w - pad * 2);
  const innerH = Math.max(1, h - pad * 2);
  const step = innerW / (n - 1 || 1);
  const pts = buckets.map((v, i) => {
    const x = pad + i * step;
    const k = max > 0 ? v / max : 0;
    const y = pad + innerH - k * innerH;
    return [x, y];
  });
  let line = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    line += ` L ${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)}`;
  }
  const baseY = (pad + innerH).toFixed(2);
  const area = `${line} L ${pts[n-1][0].toFixed(2)} ${baseY} L ${pts[0][0].toFixed(2)} ${baseY} Z`;
  return { line, area, max };
}

/** Compute a heat trend signal from the rolling-24h samples.
 * Returns { dir: -1|0|1, magnitude: 0..1, recent, prior }.
 *   dir =  1 → rising (recent half has more activity than prior half)
 *   dir = -1 → falling
 *   dir =  0 → flat / insufficient signal
 * The magnitude is a normalized 0..1 distance from "flat" used to scale the
 * arrow's tilt and opacity.
 */
function computeHeatTrend(samples, now) {
  const buckets = bucketizeActivity(samples, now);
  const n = buckets.length;
  if (n < 2) return { dir: 0, magnitude: 0, recent: 0, prior: 0 };
  const mid = Math.floor(n / 2);
  let prior = 0;
  let recent = 0;
  for (let i = 0; i < mid; i++) prior += buckets[i];
  for (let i = mid; i < n; i++) recent += buckets[i];
  const total = prior + recent;
  // Need at least a couple of samples to call a trend honestly.
  if (total < 2) return { dir: 0, magnitude: 0, recent, prior };
  // Signed ratio in [-1, 1]: +1 = all recent, -1 = all prior, 0 = even.
  const ratio = (recent - prior) / total;
  const FLAT_BAND = 0.15; // anything inside ±15% counts as flat
  if (Math.abs(ratio) < FLAT_BAND) return { dir: 0, magnitude: 0, recent, prior };
  const dir = ratio > 0 ? 1 : -1;
  const magnitude = Math.min(1, (Math.abs(ratio) - FLAT_BAND) / (1 - FLAT_BAND));
  return { dir, magnitude, recent, prior };
}

/** Render a tab's heat trend as an inline SVG arrow. Phosphor-style stroke. */
function renderTrendSVG(trend) {
  const dir = trend && trend.dir ? trend.dir : 0;
  const mag = trend && Number.isFinite(trend.magnitude) ? trend.magnitude : 0;
  if (dir === 0) {
    // Flat: short horizontal dash, low opacity.
    return (
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M5 12h14"/>' +
      '</svg>'
    );
  }
  // Up arrow points NE; down arrow points SE. Magnitude doesn't change the
  // glyph (kept legible) — the row's class controls color + opacity.
  if (dir > 0) {
    return (
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M7 17L17 7"/>' +
        '<path d="M9 7h8v8"/>' +
      '</svg>'
    );
  }
  return (
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M7 7L17 17"/>' +
      '<path d="M17 9v8h-8"/>' +
    '</svg>'
  );
}

/** Render a tab's spark as an inline SVG string. */
function renderSparkSVG(samples, now, accentColor) {
  const buckets = bucketizeActivity(samples, now);
  const total = buckets.reduce((s, v) => s + v, 0);
  if (total === 0) {
    const y = (SPARK_H - 2).toFixed(2);
    return (
      `<svg class="spark spark--empty" width="${SPARK_W}" height="${SPARK_H}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" aria-hidden="true">` +
        `<path d="M 1 ${y} L ${SPARK_W - 1} ${y}" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.35"/>` +
      `</svg>`
    );
  }
  const { line, area, max } = sparkPath(buckets, SPARK_W, SPARK_H, 2);
  const color = accentColor || "currentColor";
  return (
    `<svg class="spark" width="${SPARK_W}" height="${SPARK_H}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" aria-hidden="true" data-max="${max}" data-total="${total}">` +
      `<path d="${area}" fill="${color}" fill-opacity="0.18" stroke="none"/>` +
      `<path d="${line}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`
  );
}

/** Singleton hover tooltip; lazily created on first use. */
let TOOLTIP_EL = null;
let TOOLTIP_HIDE_TIMER = 0;
function ensureTooltip() {
  if (TOOLTIP_EL && document.body.contains(TOOLTIP_EL)) return TOOLTIP_EL;
  const el = document.createElement("div");
  el.className = "heat-tooltip";
  el.setAttribute("role", "tooltip");
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = (
    '<div class="tt-row tt-row--head">' +
      '<span class="tt-dot"></span>' +
      '<span class="tt-title"></span>' +
    '</div>' +
    '<div class="tt-row">' +
      '<svg class="tt-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
      '<span class="tt-label">Last active</span>' +
      '<span class="tt-value" data-field="last-rel"></span>' +
    '</div>' +
    '<div class="tt-row tt-row--sub">' +
      '<span class="tt-spacer"></span>' +
      '<span class="tt-value tt-value--dim" data-field="last-abs"></span>' +
    '</div>' +
    '<div class="tt-row">' +
      '<svg class="tt-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M5 12l4-4M5 12l4 4"/><path d="M19 6v12"/></svg>' +
      '<span class="tt-label">Activations</span>' +
      '<span class="tt-value" data-field="activations"></span>' +
    '</div>'
  );
  document.body.appendChild(el);
  TOOLTIP_EL = el;
  return el;
}

function positionTooltip(tip, anchor) {
  // Render off-screen first so we can measure, then place.
  tip.style.left = "-9999px";
  tip.style.top = "-9999px";
  tip.classList.add("is-visible");
  const margin = 8;
  const a = anchor.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let left = a.left + (a.width - t.width) / 2;
  left = Math.max(margin, Math.min(left, vw - t.width - margin));
  let top = a.bottom + margin;
  if (top + t.height > vh - margin) {
    top = Math.max(margin, a.top - t.height - margin);
  }
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function showTooltipFor(anchor, row) {
  const tip = ensureTooltip();
  if (TOOLTIP_HIDE_TIMER) { clearTimeout(TOOLTIP_HIDE_TIMER); TOOLTIP_HIDE_TIMER = 0; }
  const dot = tip.querySelector(".tt-dot");
  if (dot) dot.style.background = heatColor(row.heat);
  const titleEl = tip.querySelector(".tt-title");
  if (titleEl) titleEl.textContent = row.title || row.url || "Untitled";
  const relEl = tip.querySelector('[data-field="last-rel"]');
  const absEl = tip.querySelector('[data-field="last-abs"]');
  const actEl = tip.querySelector('[data-field="activations"]');
  if (relEl) relEl.textContent = formatRelativeTime(row.lastAccessed, Date.now());
  if (absEl) absEl.textContent = formatAbsoluteTime(row.lastAccessed) || "unknown";
  if (actEl) {
    const n = Number.isFinite(row.activations) ? row.activations : 0;
    actEl.textContent = `${n}\u00A0\u00D7`;
  }
  tip.setAttribute("aria-hidden", "false");
  positionTooltip(tip, anchor);
}

function hideTooltip(immediate) {
  if (!TOOLTIP_EL) return;
  if (TOOLTIP_HIDE_TIMER) { clearTimeout(TOOLTIP_HIDE_TIMER); TOOLTIP_HIDE_TIMER = 0; }
  const apply = () => {
    if (!TOOLTIP_EL) return;
    TOOLTIP_EL.classList.remove("is-visible");
    TOOLTIP_EL.setAttribute("aria-hidden", "true");
  };
  if (immediate) apply();
  else TOOLTIP_HIDE_TIMER = setTimeout(apply, 80);
}

/** Attach hover/focus tooltip listeners to a tab row element. */
function wireRowTooltip(li, row) {
  let showTimer = 0;
  const onEnter = () => {
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => showTooltipFor(li, row), 140);
  };
  const onLeave = () => {
    if (showTimer) { clearTimeout(showTimer); showTimer = 0; }
    hideTooltip(false);
  };
  li.addEventListener("mouseenter", onEnter);
  li.addEventListener("mouseleave", onLeave);
  li.addEventListener("focus", () => showTooltipFor(li, row));
  li.addEventListener("blur", () => hideTooltip(true));
}

/**
 * Render an inline SVG audio indicator for a tab row.
 * Shows a speaker icon for audible tabs and a muted-speaker icon for
 * tabs muted via tab-mute. Returns an empty string when neither applies.
 * Clicking the icon toggles mute; clicks don't bubble to row activation.
 */
function renderAudioIndicator(row) {
  const audible = !!row.audible;
  const muted = !!row.muted;
  if (!audible && !muted) return "";
  const state = muted ? "muted" : "audible";
  const label = muted ? "Muted — click to unmute" : "Playing audio — click to mute";
  // Phosphor-style speaker icons; stroke-width 1.5, round caps.
  const speakerPath =
    '<path d="M4 10v4h3l4 3V7L7 10H4z"/>' +
    '<path d="M15 9a4 4 0 010 6"/>' +
    '<path d="M17.5 6.5a8 8 0 010 11"/>';
  const mutedPath =
    '<path d="M4 10v4h3l4 3V7L7 10H4z"/>' +
    '<path d="M15 9l5 6M20 9l-5 6"/>';
  const path = muted ? mutedPath : speakerPath;
  return (
    `<button type="button" class="tab-audio tab-audio--${state}" data-audio-toggle="1" aria-pressed="${muted ? "true" : "false"}" aria-label="${label}" title="${label}">` +
      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>` +
    `</button>`
  );
}

/** Toggle the muted state of a tab without affecting the row click. */
async function toggleTabMute(tabId, nextMuted) {
  try {
    await new Promise((resolve) => {
      try {
        chrome.tabs.update(tabId, { muted: !!nextMuted }, () => {
          if (chrome.runtime.lastError) console.warn(LOG, "tabs.update mute:", chrome.runtime.lastError.message);
          resolve();
        });
      } catch (err) {
        console.warn(LOG, "tabs.update mute threw:", err);
        resolve();
      }
    });
  } catch (err) {
    console.warn(LOG, "toggleTabMute failed:", err);
  }
}

/** Create a single tab row element. */
function rowElement(row) {
  const li = document.createElement("li");
  li.className = "tab-row" + (row.active ? " active" : "") + (SELECT_MODE ? " is-selectable" : "") + (SELECT_MODE && SELECTED.has(row.id) ? " is-selected" : "");
  li.setAttribute("role", SELECT_MODE ? "checkbox" : "button");
  li.setAttribute("tabindex", "0");
  if (SELECT_MODE) li.setAttribute("aria-checked", SELECTED.has(row.id) ? "true" : "false");
  li.dataset.tabId = String(row.id);
  // Native title is suppressed in favor of the custom hover tooltip; keep
  // a screen-reader label so the row still announces context.
  li.setAttribute("aria-label", row.title + (row.url ? " — " + row.url : ""));

  // Favicon cell
  let faviconHTML;
  if (row.favIconUrl && /^https?:|^data:/.test(row.favIconUrl)) {
    const safe = row.favIconUrl.replace(/"/g, "&quot;");
    faviconHTML = `<img class="tab-favicon" src="${safe}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createRange().createContextualFragment('${fallbackFaviconSVG().replace(/'/g, "\\'")}'))">`;
  } else {
    faviconHTML = fallbackFaviconSVG();
  }

  const host = hostnameOf(row.url);
  const heatPct = Math.round(row.heat * 100);
  // Dot opacity grows with heat for a subtle cue.
  const dotOpacity = (0.3 + row.heat * 0.7).toFixed(2);
  // Color gradient: cold blue → warm amber → hot red.
  const heatRGB = heatColor(row.heat);

  const audioHTML = renderAudioIndicator(row);
  const trend = computeHeatTrend(row.sparkSamples, Date.now());
  const trendDirLabel = trend.dir > 0 ? "rising" : (trend.dir < 0 ? "falling" : "flat");
  const trendPct = Math.round(trend.magnitude * 100);
  const trendOpacity = trend.dir === 0 ? 0.45 : (0.55 + trend.magnitude * 0.45).toFixed(2);
  const trendClass = "tab-trend tab-trend--" + (trend.dir > 0 ? "up" : trend.dir < 0 ? "down" : "flat");
  const trendTitle = trend.dir === 0
    ? "Heat trend: flat (last 24h)"
    : `Heat trend: ${trendDirLabel} ${trendPct}% — recent ${trend.recent} vs prior ${trend.prior} (last 24h)`;
  const trendHTML = (
    `<span class="${trendClass}" style="opacity:${trendOpacity}" title="${trendTitle}" aria-label="Heat trend ${trendDirLabel}">` +
      renderTrendSVG(trend) +
    `</span>`
  );
  const ageMs = (Number.isFinite(row.firstOpened) && row.firstOpened > 0)
    ? Math.max(0, Date.now() - row.firstOpened)
    : -1;
  const ageHTML = ageMs >= 0
    ? `<span class="tab-age" title="Opened ${formatAbsoluteTime(row.firstOpened) || "unknown"} — ${formatAbsoluteAgo(ageMs)} ago" aria-label="Tab age ${formatAbsoluteAgo(ageMs)}">` +
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
        `<span>${formatCompactAge(ageMs)}</span>` +
      `</span>`
    : `<span class="tab-age tab-age--unknown" title="Opened time unknown" aria-label="Tab age unknown">` +
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' +
        '<span>—</span>' +
      `</span>`;
  const checkboxHTML = SELECT_MODE
    ? (
      '<span class="tab-check" aria-hidden="true">' +
        '<svg class="tab-check-mark" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M5 12.5l4.5 4.5L19 7.5"/>' +
        '</svg>' +
      '</span>'
    )
    : "";
  li.innerHTML =
    checkboxHTML +
    faviconHTML +
    '<div class="tab-main">' +
      `<div class="tab-title"></div>` +
      `<div class="tab-sub"></div>` +
    '</div>' +
    audioHTML +
    ageHTML +
    trendHTML +
    `<span class="tab-spark" style="color:${heatRGB}" title="Activity, last 24h (${(row.sparkSamples || []).length} samples)" aria-label="24h activity">${renderSparkSVG(row.sparkSamples, Date.now(), heatRGB)}</span>` +
    `<span class="heat-badge" style="--dot-opacity:${dotOpacity};--heat-color:${heatRGB}" title="Heat ${heatPct} — recency ${(row.recency*100).toFixed(0)}% • freq ${(row.frequency*100).toFixed(0)}%">` +
      '<span class="heat-dot"></span>' +
      `<span>${heatPct}</span>` +
    '</span>';

  // Set text via textContent to avoid HTML injection in titles/URLs.
  li.querySelector(".tab-title").textContent = row.title;
  li.querySelector(".tab-sub").textContent = host || (row.url ? row.url.slice(0, 64) : "");
  if (FILTER_QUERY) {
    highlightInto(li.querySelector(".tab-title"), row.title, FILTER_QUERY);
    highlightInto(li.querySelector(".tab-sub"), host || (row.url ? row.url.slice(0, 64) : ""), FILTER_QUERY);
  }

  const activate = () => focusTab(row.id, row.windowId);
  const toggleSelect = () => {
    if (SELECTED.has(row.id)) SELECTED.delete(row.id); else SELECTED.add(row.id);
    li.classList.toggle("is-selected", SELECTED.has(row.id));
    li.setAttribute("aria-checked", SELECTED.has(row.id) ? "true" : "false");
    updateSelectionUI();
  };
  li.addEventListener("click", (ev) => {
    const audioBtn = ev.target instanceof Element ? ev.target.closest("[data-audio-toggle]") : null;
    if (audioBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const nextMuted = !row.muted;
      // Optimistic visual flip so the click feels instant.
      audioBtn.classList.toggle("tab-audio--muted", nextMuted);
      audioBtn.classList.toggle("tab-audio--audible", !nextMuted);
      audioBtn.setAttribute("aria-pressed", nextMuted ? "true" : "false");
      toggleTabMute(row.id, nextMuted).then(() => {
        // Re-render so the indicator reflects authoritative state.
        setTimeout(() => { render().catch(() => {}); }, 80);
      });
      return;
    }
    if (SELECT_MODE) { ev.preventDefault(); toggleSelect(); }
    else activate();
  });
  li.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      if (SELECT_MODE) toggleSelect(); else activate();
    }
  });
  if (!SELECT_MODE) wireRowTooltip(li, row);

  return li;
}

/** Focus an existing tab + its window. */
async function focusTab(tabId, windowId) {
  try {
    await chrome.tabs.update(tabId, { active: true });
    if (typeof windowId === "number") {
      await chrome.windows.update(windowId, { focused: true });
    }
    window.close();
  } catch (err) {
    console.warn(LOG, "focusTab failed:", err);
  }
}

/**
 * Group rows by hostname and compute a rollup heat per host.
 * Rollup = max(child heat) — "hottest sub-tab wins". We also expose
 * avg + sum for UI subtitles. Children stay sorted hot→cold.
 * Returns groups sorted by rollup heat (hot hosts at top).
 */
function groupRowsByHost(rows, keyFn) {
  const getKey = typeof keyFn === "function" ? keyFn : (r) => hostnameOf(r.url) || "(local)";
  const map = new Map();
  for (const row of rows) {
    const host = getKey(row) || "(local)";
    let g = map.get(host);
    if (!g) {
      g = { host, rows: [], maxHeat: 0, sumHeat: 0, sumRecency: 0, sumFreq: 0, activations: 0 };
      map.set(host, g);
    }
    g.rows.push(row);
    g.maxHeat = Math.max(g.maxHeat, row.heat);
    g.sumHeat += row.heat;
    g.sumRecency += row.recency;
    g.sumFreq += row.frequency;
    g.activations += row.activations || 0;
  }
  const groups = [];
  for (const g of map.values()) {
    g.rows.sort((a, b) => b.heat - a.heat);
    g.avgHeat = g.rows.length ? g.sumHeat / g.rows.length : 0;
    g.avgRecency = g.rows.length ? g.sumRecency / g.rows.length : 0;
    g.avgFreq = g.rows.length ? g.sumFreq / g.rows.length : 0;
    g.heat = g.maxHeat; // rollup
    groups.push(g);
  }
  groups.sort((a, b) => b.heat - a.heat || b.rows.length - a.rows.length);
  return groups;
}

/** Render a single host-group header + its children into `parent`. */
function appendGroup(parent, group, expanded, storagePrefix) {
  const section = document.createElement("li");
  section.className = "tab-group" + (expanded ? " is-open" : "");
  section.dataset.host = group.host;

  const heatPct = Math.round(group.heat * 100);
  const avgPct = Math.round(group.avgHeat * 100);
  const dotOpacity = (0.3 + group.heat * 0.7).toFixed(2);
  const heatRGB = heatColor(group.heat);
  const count = group.rows.length;

  const header = document.createElement("button");
  header.type = "button";
  header.className = "group-header";
  header.setAttribute("aria-expanded", expanded ? "true" : "false");
  header.innerHTML =
    '<svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>' +
    '<span class="group-host"></span>' +
    `<span class="group-count">${count}</span>` +
    `<span class="heat-badge" style="--dot-opacity:${dotOpacity};--heat-color:${heatRGB}" title="Rollup heat ${heatPct} (avg ${avgPct})">` +
      '<span class="heat-dot"></span>' +
      `<span>${heatPct}</span>` +
    '</span>';
  header.querySelector(".group-host").textContent = group.host;

  const childList = document.createElement("ul");
  childList.className = "group-children";
  for (const row of group.rows) childList.appendChild(rowElement(row));

  header.addEventListener("click", () => {
    const open = section.classList.toggle("is-open");
    header.setAttribute("aria-expanded", open ? "true" : "false");
    // Persist per-host collapsed state best-effort.
    try {
      const key = (storagePrefix || "th:groupOpen:") + group.host;
      chrome.storage?.local?.set?.({ [key]: open });
    } catch {}
  });

  section.appendChild(header);
  section.appendChild(childList);
  parent.appendChild(section);
}

/** Top-level render. */
async function render() {
  const [tabs, accessedResp, countsResp, sparkResp, openedResp] = await Promise.all([
    getAllTabs(),
    sendMessage(MSG.GET_LAST_ACCESSED),
    sendMessage(MSG.GET_ACTIVATION_COUNTS),
    sendMessage(MSG.GET_ACTIVITY_SPARK),
    sendMessage(MSG.GET_FIRST_OPENED),
  ]);

  // Hydrate user-configurable thresholds from background settings.
  const settingsResp = await sendMessage(MSG.GET_SETTINGS);
  const settings = (settingsResp && settingsResp.settings) || {};
  if (Number.isFinite(settings.recencyHalfLifeMinutes) && settings.recencyHalfLifeMinutes > 0) {
    RECENCY_HALF_LIFE_MS = settings.recencyHalfLifeMinutes * 60 * 1000;
  }
  if (Number.isFinite(settings.hotThreshold)) {
    HOT_THRESHOLD = Math.min(0.95, Math.max(0.05, settings.hotThreshold));
  }
  DOMAIN_HALF_LIFE = (settings.domainHalfLifeMinutes && typeof settings.domainHalfLifeMinutes === "object")
    ? settings.domainHalfLifeMinutes
    : {};
  applyTheme(settings.theme);

  // Hydrate tab-group metadata so we can render the group filter and color
  // swatches. tabGroups may not exist in non-Chromium runtimes — handle gracefully.
  TAB_GROUPS_BY_ID = await getTabGroupsMap();
  populateGroupFilterOptions(tabs);

  const rows = buildRows(tabs, accessedResp.map || {}, countsResp.map || {}, sparkResp?.map || {}, openedResp?.map || {});
  // Stamp groupId on each row from the source tab list so the filter can
  // match against chrome.tabGroups membership without another round-trip.
  const tabIdToGroup = new Map();
  for (const t of tabs) if (t && typeof t.id === "number") tabIdToGroup.set(t.id, typeof t.groupId === "number" ? t.groupId : -1);
  for (const r of rows) r.groupId = tabIdToGroup.has(r.id) ? tabIdToGroup.get(r.id) : -1;
  const sortedAll = sortRows(rows, SORT_MODE);
  const allRows = sortedAll;
  renderHeatHistogram(allRows);
  renderHeatMinimap(allRows);
  const q = FILTER_QUERY;
  const groupFiltered = applyGroupFilter(sortedAll);
  const filtered = q ? groupFiltered.filter((r) => rowMatchesFilter(r, q)) : groupFiltered;
  const list = document.getElementById("tab-list");
  const empty = document.getElementById("empty-state");
  const noMatches = document.getElementById("no-matches");
  const noMatchesSub = document.getElementById("no-matches-sub");
  const stat = document.getElementById("stat");

  list.innerHTML = "";
  if (allRows.length === 0) {
    empty.classList.remove("hidden");
    if (noMatches) noMatches.classList.add("hidden");
    list.classList.add("hidden");
    if (stat) stat.textContent = "0 tabs";
    return;
  }
  empty.classList.add("hidden");
  if (filtered.length === 0) {
    list.classList.add("hidden");
    if (noMatches) {
      noMatches.classList.remove("hidden");
      if (noMatchesSub) noMatchesSub.textContent = `No matches for “${q}” among ${allRows.length} tab${allRows.length === 1 ? "" : "s"}.`;
    }
    if (stat) {
      const hot = allRows.filter((r) => r.heat >= HOT_THRESHOLD).length;
      stat.textContent = `0 of ${allRows.length} tabs • ${hot} hot`;
    }
    return;
  }
  if (noMatches) noMatches.classList.add("hidden");
  list.classList.remove("hidden");

  const frag = document.createDocumentFragment();
  if (GROUP_BY_HOST || CLUSTER_BY_DOMAIN) {
    list.classList.add("is-grouped");
    if (CLUSTER_BY_DOMAIN) list.classList.add("is-clustered"); else list.classList.remove("is-clustered");
    const keyFn = CLUSTER_BY_DOMAIN ? ((r) => clusterKeyOf(r.url)) : ((r) => hostnameOf(r.url) || "(local)");
    const groups = sortGroups(groupRowsByHost(filtered, keyFn), SORT_MODE);
    // Default: expand groups whose rollup heat ≥ HOT_THRESHOLD, collapse the rest.
    // Per-host overrides come from chrome.storage.local ("th:groupOpen:<host>").
    let overrides = {};
    try {
      const all = await new Promise((resolve) => {
        chrome.storage?.local?.get?.(null, (items) => resolve(items || {}));
      });
      overrides = all || {};
    } catch {}
    for (const g of groups) {
      const key = (CLUSTER_BY_DOMAIN ? "th:clusterOpen:" : "th:groupOpen:") + g.host;
      const expanded = key in overrides
        ? !!overrides[key]
        : (g.heat >= HOT_THRESHOLD || groups.length <= 4);
      appendGroup(frag, g, expanded, CLUSTER_BY_DOMAIN ? "th:clusterOpen:" : "th:groupOpen:");
    }
  } else {
    list.classList.remove("is-grouped");
    list.classList.remove("is-clustered");
    for (const row of filtered) frag.appendChild(rowElement(row));
  }
  list.appendChild(frag);

  if (stat) {
    const hot = allRows.filter((r) => r.heat >= HOT_THRESHOLD).length;
    if (q) {
      stat.textContent = `${filtered.length} of ${allRows.length} tabs • ${hot} hot`;
    } else {
      stat.textContent = `${allRows.length} tabs • ${hot} hot`;
    }
  }

  // Refresh quick-action chip counts from the full row set.
  LAST_ROWS = allRows;
  refreshQuickChipCounts(allRows);
  // Per-window scoreboard reflects only the focused popup window.
  renderWindowScoreboard(allRows);
}

/** Most recent allRows from render(); used by chip handlers. */
let LAST_ROWS = [];

/** Cached id of the window the popup belongs to. Resolved once on init. */
let CURRENT_WINDOW_ID = null;
async function resolveCurrentWindowId() {
  if (Number.isFinite(CURRENT_WINDOW_ID)) return CURRENT_WINDOW_ID;
  try {
    const w = await chrome.windows.getCurrent({ populate: false });
    if (w && Number.isFinite(w.id)) CURRENT_WINDOW_ID = w.id;
  } catch (err) {
    console.warn(LOG, "windows.getCurrent failed:", err);
  }
  return CURRENT_WINDOW_ID;
}

/**
 * Render the per-window heat scoreboard in the topbar.
 * Counts tabs, hot tabs (heat >= HOT_THRESHOLD), and the average heat of the
 * window the popup is anchored to. Hidden when no tabs exist in this window.
 */
function renderWindowScoreboard(allRows) {
  const board = document.getElementById("window-scoreboard");
  if (!board) return;
  const wid = CURRENT_WINDOW_ID;
  const here = (allRows || []).filter((r) => Number.isFinite(wid) ? r.windowId === wid : true);
  if (!here.length) {
    board.classList.add("hidden");
    return;
  }
  board.classList.remove("hidden");
  const hot = here.filter((r) => r.heat >= HOT_THRESHOLD).length;
  const avg = here.reduce((s, r) => s + (Number.isFinite(r.heat) ? r.heat : 0), 0) / here.length;
  const tabsEl = document.getElementById("ws-tabs-count");
  const hotEl = document.getElementById("ws-hot-count");
  const avgEl = document.getElementById("ws-avg-pct");
  const fillEl = document.getElementById("ws-bar-fill");
  const winsWrap = document.getElementById("ws-windows");
  const winsEl = document.getElementById("ws-windows-count");
  if (tabsEl) tabsEl.textContent = String(here.length);
  if (hotEl) hotEl.textContent = String(hot);
  const pct = Math.round(Math.max(0, Math.min(1, avg)) * 100);
  if (avgEl) avgEl.textContent = `${pct}%`;
  if (fillEl) fillEl.style.width = `${pct}%`;
  // "This is window N of M" indicator when multiple windows are open.
  const otherWindowIds = new Set();
  for (const r of allRows || []) {
    if (Number.isFinite(r.windowId)) otherWindowIds.add(r.windowId);
  }
  const windowCount = otherWindowIds.size;
  if (windowCount > 1 && winsWrap && winsEl) {
    winsEl.textContent = String(windowCount);
    winsWrap.classList.remove("hidden");
    winsWrap.title = `${windowCount} windows open • this is the focused one`;
  } else if (winsWrap) {
    winsWrap.classList.add("hidden");
  }
  const hotLabel = hot === 1 ? "hot tab" : "hot tabs";
  const tabLabel = here.length === 1 ? "tab" : "tabs";
  board.title = `This window: ${here.length} ${tabLabel}, ${hot} ${hotLabel}, avg heat ${pct}%`;
}
/** Last-known idleCloseDays threshold, hydrated by wireQuickChips() on init. */
let IDLE_DAYS = 7;

/** Count cold-close candidates among rows using the same predicate as the SW. */
function countColdCandidates(rows, days) {
  const now = Date.now();
  const thresholdMs = Math.max(1, days) * 24 * 60 * 60 * 1000;
  let n = 0;
  for (const r of rows || []) {
    if (!r || r.pinned || r.active || r.audible) continue;
    if (!Number.isFinite(r.lastAccessed) || r.lastAccessed <= 0) continue;
    if (now - r.lastAccessed >= thresholdMs) n++;
  }
  return n;
}

/** Count hot unpinned tabs that the pin-hot chip would act on. */
function countPinHotCandidates(rows) {
  let n = 0;
  for (const r of rows || []) {
    if (!r || r.pinned) continue;
    if (!Number.isFinite(r.heat)) continue;
    if (r.heat >= HOT_THRESHOLD) n++;
  }
  return n;
}

/** Update chip counts + disabled visuals from the current row set. */
function refreshQuickChipCounts(rows) {
  const closeEl = document.getElementById("chip-close-cold");
  const suspendEl = document.getElementById("chip-suspend-cold");
  const pinEl = document.getElementById("chip-pin-hot");
  const closeN = countColdCandidates(rows, IDLE_DAYS);
  const pinN = countPinHotCandidates(rows);
  if (closeEl) {
    const c = document.getElementById("chip-close-cold-count");
    if (c) c.textContent = String(closeN);
    closeEl.classList.toggle("is-empty", closeN === 0);
    closeEl.title = closeN === 0
      ? `No tabs idle over ${IDLE_DAYS}d`
      : `Close ${closeN} tab${closeN === 1 ? "" : "s"} idle > ${IDLE_DAYS}d`;
  }
  if (suspendEl) {
    const c = document.getElementById("chip-suspend-cold-count");
    if (c) c.textContent = String(closeN);
    suspendEl.classList.toggle("is-empty", closeN === 0);
    suspendEl.title = closeN === 0
      ? `No tabs idle over ${IDLE_DAYS}d`
      : `Suspend ${closeN} tab${closeN === 1 ? "" : "s"} idle > ${IDLE_DAYS}d`;
  }
  if (pinEl) {
    const c = document.getElementById("chip-pin-hot-count");
    if (c) c.textContent = String(pinN);
    pinEl.classList.toggle("is-empty", pinN === 0);
    pinEl.title = pinN === 0
      ? "No unpinned hot tabs"
      : `Pin ${pinN} hot tab${pinN === 1 ? "" : "s"}`;
  }
}

/**
 * Wire the quick-action chips strip: Close Cold, Suspend Cold, Pin Hot.
 * Each chip uses a brief two-step confirm pattern (consistent with the
 * toolbar's full-width buttons) to prevent accidental nukes.
 */
async function wireQuickChips() {
  const closeChip = document.getElementById("chip-close-cold");
  const suspendChip = document.getElementById("chip-suspend-cold");
  const pinChip = document.getElementById("chip-pin-hot");
  const status = document.getElementById("toolbar-status");
  if (!closeChip && !suspendChip && !pinChip) return;

  const settings = await sendMessage(MSG.GET_SETTINGS).then((r) => r?.settings || {});
  IDLE_DAYS = Number.isFinite(settings.idleCloseDays) && settings.idleCloseDays > 0
    ? settings.idleCloseDays
    : 7;
  refreshQuickChipCounts(LAST_ROWS);

  function setStatus(text, warn) {
    if (!status) return;
    status.textContent = text || "";
    status.classList.toggle("is-warn", !!warn);
  }

  /** Two-step confirm runner: first click arms (4s), second click executes. */
  function makeChipHandler(chip, computeCount, armedLabelFn, runFn) {
    if (!chip) return;
    const labelEl = chip.querySelector(".chip-label");
    const originalLabel = labelEl ? labelEl.textContent : "";
    let armed = false;
    let timer = 0;
    function disarm() {
      armed = false;
      chip.classList.remove("is-confirming");
      if (labelEl) labelEl.textContent = originalLabel;
      if (timer) { clearTimeout(timer); timer = 0; }
    }
    chip.addEventListener("click", async (ev) => {
      ev.preventDefault();
      if (chip.classList.contains("is-empty")) return;
      if (!armed) {
        const n = computeCount();
        if (n <= 0) {
          setStatus("Nothing to do", false);
          return;
        }
        armed = true;
        chip.classList.add("is-confirming");
        if (labelEl) labelEl.textContent = armedLabelFn(n);
        setStatus("Click again to confirm", true);
        timer = setTimeout(disarm, 4000);
        return;
      }
      disarm();
      chip.classList.add("is-busy");
      chip.setAttribute("disabled", "true");
      try { await runFn(); }
      finally {
        chip.removeAttribute("disabled");
        chip.classList.remove("is-busy");
      }
      setTimeout(() => { render().catch(() => {}); }, 150);
    });
  }

  makeChipHandler(
    closeChip,
    () => countColdCandidates(LAST_ROWS, IDLE_DAYS),
    (n) => `Close ${n} cold?`,
    async () => {
      setStatus("Closing\u2026", false);
      // Snapshot candidates ourselves so the undo toast has metadata even if
      // the SW doesn't pass closedTabs back.
      const ids = LAST_ROWS
        .filter((r) => !r.pinned && !r.active && !r.audible && r.lastAccessed > 0 && (Date.now() - r.lastAccessed) >= IDLE_DAYS * 86400000)
        .map((r) => r.id);
      const result = await closeTabsByIds(ids);
      const c = result?.count || 0;
      if (c === 0) {
        setStatus("Nothing to close", false);
      } else {
        setStatus("", false);
        showUndoToast(c, result.closedTabs || []);
      }
    }
  );

  makeChipHandler(
    suspendChip,
    () => countColdCandidates(LAST_ROWS, IDLE_DAYS),
    (n) => `Suspend ${n} cold?`,
    async () => {
      setStatus("Suspending\u2026", false);
      const result = await sendMessage(MSG.SUSPEND_IDLE, { days: IDLE_DAYS });
      if (result?.ok) {
        const s = result.suspended || 0;
        setStatus(s === 0 ? "Nothing suspended" : `Suspended ${s} tab${s === 1 ? "" : "s"}`, false);
      } else {
        setStatus(result?.error ? `Failed: ${result.error}` : "Failed", true);
      }
    }
  );

  makeChipHandler(
    pinChip,
    () => countPinHotCandidates(LAST_ROWS),
    (n) => `Pin ${n} hot?`,
    async () => {
      setStatus("Pinning\u2026", false);
      const targets = LAST_ROWS.filter((r) => !r.pinned && Number.isFinite(r.heat) && r.heat >= HOT_THRESHOLD);
      let pinned = 0;
      for (const r of targets) {
        try {
          await new Promise((resolve) => {
            try {
              chrome.tabs.update(r.id, { pinned: true }, () => {
                if (chrome.runtime.lastError) console.warn(LOG, "tabs.update pin:", chrome.runtime.lastError.message);
                else pinned++;
                resolve();
              });
            } catch (err) {
              console.warn(LOG, "tabs.update pin threw:", err);
              resolve();
            }
          });
        } catch { /* skip */ }
      }
      setStatus(pinned === 0 ? "Nothing pinned" : `Pinned ${pinned} hot tab${pinned === 1 ? "" : "s"}`, false);
    }
  );
}

function wireSettings() {
  const btn = document.getElementById("settings-btn");
  btn?.addEventListener("click", () => {
    // Options page lands later in the roadmap — keep this graceful.
    if (chrome?.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage().catch(() => {});
    }
  });
}

/**
 * Wire up the "Close idle" action.
 * UX: click once -> the button enters a confirm state ("Close N tabs?") for ~4s,
 * a second click within that window executes the close. This prevents an
 * accidental click from nuking a long tab list.
 */
async function wireCloseIdle() {
  const btn = document.getElementById("close-idle-btn");
  const pill = document.getElementById("idle-threshold-pill");
  const status = document.getElementById("toolbar-status");
  const labelEl = btn?.querySelector(".action-label");
  if (!btn || !labelEl) return;

  let settings = await sendMessage(MSG.GET_SETTINGS).then((r) => r?.settings || { idleCloseDays: 7 });
  let days = settings.idleCloseDays || 7;
  const originalLabel = labelEl.textContent;
  if (pill) pill.textContent = `${days}d`;

  /** Count current candidates client-side for the confirm copy. */
  async function countCandidates() {
    const now = Date.now();
    const thresholdMs = days * 24 * 60 * 60 * 1000;
    const [tabs, accessedResp] = await Promise.all([
      getAllTabs(),
      sendMessage(MSG.GET_LAST_ACCESSED),
    ]);
    const accessed = accessedResp?.map || {};
    let n = 0;
    for (const t of tabs) {
      if (!t || typeof t.id !== "number") continue;
      if (t.pinned || t.active || t.audible) continue;
      const key = String(t.id);
      const m = accessed[key];
      const stamp = typeof m === "number" ? m : (typeof t.lastAccessed === "number" ? t.lastAccessed : 0);
      if (stamp <= 0) continue;
      if (now - stamp >= thresholdMs) n++;
    }
    return n;
  }

  let confirmTimer = 0;
  let armed = false;

  function disarm() {
    armed = false;
    btn.classList.remove("is-confirming");
    labelEl.textContent = originalLabel;
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = 0; }
  }

  function setStatus(text, warn) {
    if (!status) return;
    status.textContent = text || "";
    status.classList.toggle("is-warn", !!warn);
  }

  btn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    if (!armed) {
      const n = await countCandidates();
      if (n === 0) {
        setStatus(`No tabs idle over ${days}d`, false);
        return;
      }
      armed = true;
      btn.classList.add("is-confirming");
      labelEl.textContent = `Close ${n} tab${n === 1 ? "" : "s"}?`;
      setStatus("Click again to confirm", true);
      confirmTimer = setTimeout(disarm, 4000);
      return;
    }
    // Confirmed — execute.
    btn.setAttribute("disabled", "true");
    setStatus("Closing…", false);
    const result = await sendMessage(MSG.CLOSE_IDLE, { days });
    btn.removeAttribute("disabled");
    disarm();
    if (result?.ok) {
      const c = result.closed || 0;
      const sp = result.skippedPinned || 0;
      const suffix = sp > 0 ? ` (kept ${sp} pinned)` : "";
      if (c === 0) {
        setStatus(`Nothing to close${suffix}`, false);
      } else {
        setStatus(suffix ? `Kept ${sp} pinned` : "", false);
        showUndoToast(c, Array.isArray(result.closedTabs) ? result.closedTabs : []);
      }
      // Re-render after a beat so the user sees the result, then refresh the list.
      setTimeout(() => { render().catch(() => {}); }, 150);
    } else {
      setStatus(result?.error ? `Failed: ${result.error}` : "Failed", true);
    }
  });
}

/**
 * Wire the "Suspend idle" action. Same two-step confirm UX as Close idle,
 * but uses chrome.tabs.discard server-side instead of removing tabs. Safer:
 * tabs stay in the strip and reload on click.
 */
async function wireSuspendIdle() {
  const btn = document.getElementById("suspend-idle-btn");
  const pill = document.getElementById("suspend-threshold-pill");
  const status = document.getElementById("toolbar-status");
  const labelEl = btn?.querySelector(".action-label");
  if (!btn || !labelEl) return;

  const settings = await sendMessage(MSG.GET_SETTINGS).then((r) => r?.settings || { idleCloseDays: 7 });
  const days = settings.idleCloseDays || 7;
  const originalLabel = labelEl.textContent;
  if (pill) pill.textContent = `${days}d`;

  async function countCandidates() {
    const now = Date.now();
    const thresholdMs = days * 24 * 60 * 60 * 1000;
    const [tabs, accessedResp] = await Promise.all([
      getAllTabs(),
      sendMessage(MSG.GET_LAST_ACCESSED),
    ]);
    const accessed = accessedResp?.map || {};
    let n = 0;
    for (const t of tabs) {
      if (!t || typeof t.id !== "number") continue;
      if (t.pinned || t.active || t.audible || t.discarded) continue;
      const key = String(t.id);
      const m = accessed[key];
      const stamp = typeof m === "number" ? m : (typeof t.lastAccessed === "number" ? t.lastAccessed : 0);
      if (stamp <= 0) continue;
      if (now - stamp >= thresholdMs) n++;
    }
    return n;
  }

  let confirmTimer = 0;
  let armed = false;

  function disarm() {
    armed = false;
    btn.classList.remove("is-confirming");
    labelEl.textContent = originalLabel;
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = 0; }
  }

  function setStatus(text, warn) {
    if (!status) return;
    status.textContent = text || "";
    status.classList.toggle("is-warn", !!warn);
  }

  btn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    if (!armed) {
      const n = await countCandidates();
      if (n === 0) {
        setStatus(`No idle tabs to suspend (>${days}d)`, false);
        return;
      }
      armed = true;
      btn.classList.add("is-confirming");
      labelEl.textContent = `Suspend ${n} tab${n === 1 ? "" : "s"}?`;
      setStatus("Click again to confirm", true);
      confirmTimer = setTimeout(disarm, 4000);
      return;
    }
    btn.setAttribute("disabled", "true");
    setStatus("Suspending\u2026", false);
    const result = await sendMessage(MSG.SUSPEND_IDLE, { days });
    btn.removeAttribute("disabled");
    disarm();
    if (result?.ok) {
      const s = result.suspended || 0;
      const already = result.skippedAlready || 0;
      const suffix = already > 0 ? ` (${already} already)` : "";
      setStatus(s === 0 ? `Nothing to suspend${suffix}` : `Suspended ${s} tab${s === 1 ? "" : "s"}${suffix}`, false);
      setTimeout(() => { render().catch(() => {}); }, 150);
    } else {
      setStatus(result?.error ? `Failed: ${result.error}` : "Failed", true);
    }
  });
}

/**
 * Collect URLs of cold tabs (idle longer than the configured idleCloseDays).
 * Excludes pinned, active, audible, and already-discarded tabs — same shape as
 * the close-idle candidate set so users can preview/save before nuking.
 * Returns { urls, items, days } where items mirror the closedTabs metadata.
 */
async function collectColdTabs(days) {
  const now = Date.now();
  const d = Number.isFinite(days) && days > 0 ? days : 7;
  const thresholdMs = d * 24 * 60 * 60 * 1000;
  const [tabs, accessedResp] = await Promise.all([
    getAllTabs(),
    sendMessage(MSG.GET_LAST_ACCESSED),
  ]);
  const accessed = accessedResp?.map || {};
  const items = [];
  for (const t of tabs) {
    if (!t || typeof t.id !== "number") continue;
    if (t.pinned || t.active || t.audible) continue;
    if (typeof t.url !== "string" || !/^https?:|^file:|^ftp:/.test(t.url)) continue;
    const key = String(t.id);
    const m = accessed[key];
    const stamp = typeof m === "number" ? m : (typeof t.lastAccessed === "number" ? t.lastAccessed : 0);
    if (stamp <= 0) continue;
    if (now - stamp < thresholdMs) continue;
    items.push({
      url: t.url,
      title: t.title || "",
      lastAccessed: stamp,
      pinned: !!t.pinned,
      windowId: t.windowId,
    });
  }
  return { urls: items.map((i) => i.url), items, days: d };
}

/**
 * Write text to the clipboard using the async Clipboard API with a
 * document.execCommand fallback for sandboxed extension popup contexts where
 * the Permissions API path can be flaky. Returns true on success.
 */
async function writeClipboardText(text) {
  const s = typeof text === "string" ? text : "";
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch (err) {
    console.warn(LOG, "clipboard.writeText failed, falling back:", err);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch (err) {
    console.warn(LOG, "clipboard fallback failed:", err);
    return false;
  }
}

/**
 * Wire the "Copy cold" toolbar action. Collects URLs of idle (cold-close
 * candidate) tabs and writes them to the clipboard as a newline-separated
 * list — a safety net users can save before running Close idle.
 */
async function wireCopyColdUrls() {
  const btn = document.getElementById("copy-cold-btn");
  const pill = document.getElementById("copy-cold-pill");
  const status = document.getElementById("toolbar-status");
  if (!btn) return;
  const settings = await sendMessage(MSG.GET_SETTINGS).then((r) => r?.settings || { idleCloseDays: 7 });
  const days = settings.idleCloseDays || 7;
  if (pill) pill.textContent = `${days}d`;

  function setStatus(text, warn) {
    if (!status) return;
    status.textContent = text || "";
    status.classList.toggle("is-warn", !!warn);
  }

  btn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    btn.setAttribute("disabled", "true");
    try {
      const { urls, days: d } = await collectColdTabs(days);
      if (urls.length === 0) {
        setStatus(`No idle tabs to copy (>${d}d)`, false);
        return;
      }
      const text = urls.join("\n");
      const ok = await writeClipboardText(text);
      if (ok) {
        setStatus(`Copied ${urls.length} URL${urls.length === 1 ? "" : "s"} to clipboard`, false);
      } else {
        setStatus("Copy failed — clipboard blocked", true);
      }
    } catch (err) {
      console.warn(LOG, "copy cold urls failed:", err);
      setStatus("Copy failed", true);
    } finally {
      btn.removeAttribute("disabled");
    }
  });
}

/** Wire the "Group by host" toggle. Persists state in chrome.storage.local. */
async function wireGroupToggle() {
  const btn = document.getElementById("group-toggle-btn");
  if (!btn) return;
  // Hydrate persisted toggle state.
  try {
    const stored = await new Promise((resolve) => {
      chrome.storage?.local?.get?.(["th:groupByHost"], (items) => resolve(items || {}));
    });
    GROUP_BY_HOST = !!stored["th:groupByHost"];
  } catch {}
  applyGroupToggleVisual(btn);
  btn.addEventListener("click", () => {
    GROUP_BY_HOST = !GROUP_BY_HOST;
    // Group-by-host and Cluster-by-domain are mutually exclusive: turning one on
    // turns the other off so the popup never tries to render two grouping modes.
    if (GROUP_BY_HOST && CLUSTER_BY_DOMAIN) {
      CLUSTER_BY_DOMAIN = false;
      try { chrome.storage?.local?.set?.({ "th:clusterByDomain": false }); } catch {}
      const cb = document.getElementById("cluster-toggle-btn");
      if (cb) applyClusterToggleVisual(cb);
    }
    applyGroupToggleVisual(btn);
    try { chrome.storage?.local?.set?.({ "th:groupByHost": GROUP_BY_HOST }); } catch {}
    render().catch((err) => console.warn(LOG, "re-render failed:", err));
  });
}

/**
 * Wire the "Cluster by domain" toggle. Clusters tabs by registrable domain
 * so subdomains (mail.google.com + docs.google.com) collapse together under
 * `google.com`. Mutually exclusive with the per-host grouping above.
 */
async function wireClusterToggle() {
  const btn = document.getElementById("cluster-toggle-btn");
  if (!btn) return;
  try {
    const stored = await new Promise((resolve) => {
      chrome.storage?.local?.get?.(["th:clusterByDomain"], (items) => resolve(items || {}));
    });
    CLUSTER_BY_DOMAIN = !!stored["th:clusterByDomain"];
  } catch {}
  applyClusterToggleVisual(btn);
  btn.addEventListener("click", () => {
    CLUSTER_BY_DOMAIN = !CLUSTER_BY_DOMAIN;
    if (CLUSTER_BY_DOMAIN && GROUP_BY_HOST) {
      GROUP_BY_HOST = false;
      try { chrome.storage?.local?.set?.({ "th:groupByHost": false }); } catch {}
      const gb = document.getElementById("group-toggle-btn");
      if (gb) applyGroupToggleVisual(gb);
    }
    applyClusterToggleVisual(btn);
    try { chrome.storage?.local?.set?.({ "th:clusterByDomain": CLUSTER_BY_DOMAIN }); } catch {}
    render().catch((err) => console.warn(LOG, "re-render failed:", err));
  });
}

/**
 * Build a JSON-serializable snapshot of all open tabs with heat metadata.
 * Schema is versioned so the future import path can stay backwards-compatible.
 */
async function buildSnapshot() {
  const [tabs, accessedResp, countsResp, settingsResp] = await Promise.all([
    getAllTabs(),
    sendMessage(MSG.GET_LAST_ACCESSED),
    sendMessage(MSG.GET_ACTIVATION_COUNTS),
    sendMessage(MSG.GET_SETTINGS),
  ]);
  const accessed = accessedResp?.map || {};
  const counts = countsResp?.map || {};
  const settings = settingsResp?.settings || {};
  const rows = buildRows(tabs, accessed, counts);
  const now = Date.now();
  return {
    schema: "tab-heatmap.snapshot",
    version: 1,
    exportedAt: new Date(now).toISOString(),
    exportedAtMs: now,
    settings: {
      recencyHalfLifeMinutes: settings.recencyHalfLifeMinutes,
      hotThreshold: settings.hotThreshold,
      idleCloseDays: settings.idleCloseDays,
    },
    counts: {
      tabs: rows.length,
      windows: new Set(rows.map((r) => r.windowId)).size,
      hot: rows.filter((r) => r.heat >= (settings.hotThreshold ?? HOT_THRESHOLD)).length,
      pinned: rows.filter((r) => r.pinned).length,
    },
    tabs: rows.map((r) => ({
      id: r.id,
      windowId: r.windowId,
      title: r.title,
      url: r.url,
      host: hostnameOf(r.url),
      favIconUrl: r.favIconUrl || null,
      pinned: r.pinned,
      active: r.active,
      lastAccessed: r.lastAccessed || null,
      lastAccessedIso: r.lastAccessed ? new Date(r.lastAccessed).toISOString() : null,
      activations: r.activations,
      recency: Number(r.recency.toFixed(4)),
      frequency: Number(r.frequency.toFixed(4)),
      heat: Number(r.heat.toFixed(4)),
    })),
  };
}

/** Trigger a JSON file download from the popup. */
function downloadJSON(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  // Give the browser a tick to start the download before cleanup.
  setTimeout(() => {
    try { document.body.removeChild(a); } catch {}
    try { URL.revokeObjectURL(url); } catch {}
  }, 250);
}

/** Wire the "Export" button: builds snapshot JSON and triggers a download. */
async function wireExport() {
  const btn = document.getElementById("export-btn");
  const status = document.getElementById("toolbar-status");
  if (!btn) return;
  function setStatus(text, warn) {
    if (!status) return;
    status.textContent = text || "";
    status.classList.toggle("is-warn", !!warn);
  }
  btn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    btn.setAttribute("disabled", "true");
    setStatus("Exporting…", false);
    try {
      const snapshot = await buildSnapshot();
      const stamp = new Date(snapshot.exportedAtMs).toISOString().replace(/[:.]/g, "-").replace("Z", "");
      const filename = `tab-heatmap-snapshot-${stamp}.json`;
      downloadJSON(filename, snapshot);
      setStatus(`Exported ${snapshot.counts.tabs} tab${snapshot.counts.tabs === 1 ? "" : "s"}`, false);
    } catch (err) {
      console.warn(LOG, "export failed:", err);
      setStatus("Export failed", true);
    } finally {
      btn.removeAttribute("disabled");
    }
  });
}

/** Escape a CSV cell: wrap in quotes when it contains commas, quotes, or
 * newlines, and double any embedded quotes. RFC-4180-ish — Excel-safe.
 */
function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s === "") return "";
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Build a CSV string of tab usage stats over time.
 * Columns: tabId, windowId, title, url, host, pinned, lastAccessedIso,
 * lastAccessedMs, ageMs, activations, recency, frequency, heat, plus
 * 24 hourly activity buckets (h-23 … h-0) ending at "now".
 * The hourly columns are the same buckets the in-popup sparkline uses, so an
 * external tool can re-draw the chart from the CSV alone.
 */
function buildUsageCsv(rows, now) {
  const ref = Number.isFinite(now) ? now : Date.now();
  const header = [
    "tab_id", "window_id", "title", "url", "host", "pinned",
    "last_accessed_iso", "last_accessed_ms", "first_opened_iso", "age_ms",
    "activations", "recency", "frequency", "heat",
  ];
  for (let i = SPARK_BUCKETS - 1; i >= 0; i--) header.push(`h-${i}`);
  const lines = [header.join(",")];
  for (const r of rows) {
    const buckets = bucketizeActivity(r.sparkSamples || [], ref);
    const ageMs = (Number.isFinite(r.firstOpened) && r.firstOpened > 0)
      ? Math.max(0, ref - r.firstOpened) : "";
    const cells = [
      r.id,
      r.windowId,
      csvEscape(r.title),
      csvEscape(r.url),
      csvEscape(hostnameOf(r.url)),
      r.pinned ? 1 : 0,
      r.lastAccessed ? new Date(r.lastAccessed).toISOString() : "",
      r.lastAccessed || "",
      (Number.isFinite(r.firstOpened) && r.firstOpened > 0) ? new Date(r.firstOpened).toISOString() : "",
      ageMs,
      r.activations || 0,
      Number(r.recency || 0).toFixed(4),
      Number(r.frequency || 0).toFixed(4),
      Number(r.heat || 0).toFixed(4),
    ];
    for (const v of buckets) cells.push(v);
    lines.push(cells.join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** Trigger a text-file download (CSV) from the popup. */
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try { document.body.removeChild(a); } catch {}
    try { URL.revokeObjectURL(url); } catch {}
  }, 250);
}

/** Wire the "Export CSV" button: builds a usage-stats CSV and downloads it. */
async function wireCsvExport() {
  const btn = document.getElementById("csv-export-btn");
  const status = document.getElementById("toolbar-status");
  if (!btn) return;
  function setStatus(text, warn) {
    if (!status) return;
    status.textContent = text || "";
    status.classList.toggle("is-warn", !!warn);
  }
  btn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    btn.setAttribute("disabled", "true");
    setStatus("Exporting CSV…", false);
    try {
      const [tabs, accessedResp, countsResp, sparkResp, openedResp] = await Promise.all([
        getAllTabs(),
        sendMessage(MSG.GET_LAST_ACCESSED),
        sendMessage(MSG.GET_ACTIVATION_COUNTS),
        sendMessage(MSG.GET_ACTIVITY_SPARK),
        sendMessage(MSG.GET_FIRST_OPENED),
      ]);
      const rows = buildRows(
        tabs,
        accessedResp?.map || {},
        countsResp?.map || {},
        sparkResp?.map || {},
        openedResp?.map || {},
      );
      const now = Date.now();
      const csv = buildUsageCsv(rows, now);
      const stamp = new Date(now).toISOString().replace(/[:.]/g, "-").replace("Z", "");
      const filename = `tab-heatmap-usage-${stamp}.csv`;
      downloadText(filename, csv, "text/csv;charset=utf-8");
      setStatus(`Exported ${rows.length} tab${rows.length === 1 ? "" : "s"} to CSV`, false);
    } catch (err) {
      console.warn(LOG, "csv export failed:", err);
      setStatus("CSV export failed", true);
    } finally {
      btn.removeAttribute("disabled");
    }
  });
}

/**
 * Parse and validate a Tab Heatmap snapshot JSON blob.
 * Throws on schema mismatch so the caller can surface a friendly error.
 */
function parseSnapshot(text) {
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("Not valid JSON"); }
  if (!data || typeof data !== "object") throw new Error("Empty snapshot");
  if (data.schema !== "tab-heatmap.snapshot") throw new Error("Wrong schema");
  if (!Array.isArray(data.tabs)) throw new Error("Missing tabs[]");
  return data;
}

/**
 * Restore a snapshot:
 *  - Re-open any URL from the snapshot that isn't already open in the current
 *    window-set (matched by exact URL). Pinned snapshot tabs are re-pinned.
 *  - For every restored URL (and every already-open match), patch the
 *    background's last-accessed + activation maps so heat survives the round-trip.
 * Returns a summary {opened, matched, skipped, total}.
 */
async function restoreSnapshot(snapshot) {
  const items = Array.isArray(snapshot.tabs) ? snapshot.tabs : [];
  if (items.length === 0) return { opened: 0, matched: 0, skipped: 0, total: 0 };

  const openTabs = await getAllTabs();
  const urlToTabId = new Map();
  for (const t of openTabs) {
    if (t && typeof t.id === "number" && typeof t.url === "string" && t.url) {
      // Last write wins; good enough for restore-merge semantics.
      urlToTabId.set(t.url, t.id);
    }
  }

  let opened = 0, matched = 0, skipped = 0;
  const metaEntries = [];

  for (const it of items) {
    if (!it || typeof it.url !== "string" || !/^https?:|^file:|^ftp:/.test(it.url)) {
      skipped++; continue;
    }
    const existingId = urlToTabId.get(it.url);
    if (typeof existingId === "number") {
      matched++;
      metaEntries.push({ tabId: existingId, lastAccessed: it.lastAccessed || 0, activations: it.activations || 0 });
      continue;
    }
    try {
      const created = await chrome.tabs.create({
        url: it.url,
        active: false,
        pinned: !!it.pinned,
      });
      if (created && typeof created.id === "number") {
        opened++;
        metaEntries.push({ tabId: created.id, lastAccessed: it.lastAccessed || 0, activations: it.activations || 0 });
      }
    } catch (err) {
      console.warn(LOG, "restore create failed:", err, it.url);
      skipped++;
    }
  }

  if (metaEntries.length > 0) {
    await sendMessage(MSG.RESTORE_TAB_META, { entries: metaEntries });
  }
  return { opened, matched, skipped, total: items.length };
}

/** Wire the "Import" button: pick a JSON file and restore it. */
async function wireImport() {
  const btn = document.getElementById("import-btn");
  const file = document.getElementById("import-file");
  const status = document.getElementById("toolbar-status");
  if (!btn || !file) return;
  function setStatus(text, warn) {
    if (!status) return;
    status.textContent = text || "";
    status.classList.toggle("is-warn", !!warn);
  }
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    file.value = ""; // allow re-selecting the same file
    file.click();
  });
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    btn.setAttribute("disabled", "true");
    setStatus("Importing…", false);
    try {
      const text = await f.text();
      const snapshot = parseSnapshot(text);
      const result = await restoreSnapshot(snapshot);
      const parts = [];
      if (result.opened) parts.push(`opened ${result.opened}`);
      if (result.matched) parts.push(`matched ${result.matched}`);
      if (result.skipped) parts.push(`skipped ${result.skipped}`);
      setStatus(parts.length ? `Restored: ${parts.join(", ")}` : "Nothing to restore", false);
      setTimeout(() => { render().catch(() => {}); }, 200);
    } catch (err) {
      console.warn(LOG, "import failed:", err);
      setStatus(`Import failed: ${err?.message || "unknown"}`, true);
    } finally {
      btn.removeAttribute("disabled");
    }
  });
}

/**
 * Build a JSON snapshot of every open window (with its tabs, pins, groups,
 * and heat metadata). Distinct from buildSnapshot() which only stores a flat
 * tab list — session snapshots preserve window/group topology.
 */
async function buildSessionSnapshot() {
  const [windows, accessedResp, countsResp, settingsResp] = await Promise.all([
    chrome.windows.getAll({ populate: true }).catch(() => []),
    sendMessage(MSG.GET_LAST_ACCESSED),
    sendMessage(MSG.GET_ACTIVATION_COUNTS),
    sendMessage(MSG.GET_SETTINGS),
  ]);
  const accessed = accessedResp?.map || {};
  const counts = countsResp?.map || {};
  const settings = settingsResp?.settings || {};

  // Resolve tabGroups metadata (title/color/collapsed) once per session save.
  const groupIds = new Set();
  for (const w of windows) for (const t of (w.tabs || [])) {
    if (typeof t.groupId === "number" && t.groupId > 0) groupIds.add(t.groupId);
  }
  const groupMeta = {};
  if (groupIds.size && chrome.tabGroups?.get) {
    await Promise.all([...groupIds].map(async (gid) => {
      try {
        const g = await chrome.tabGroups.get(gid);
        groupMeta[gid] = { id: gid, title: g.title || "", color: g.color || "grey", collapsed: !!g.collapsed };
      } catch {}
    }));
  }

  const now = Date.now();
  let tabCount = 0;
  const winOut = windows.map((w) => {
    const tabs = (w.tabs || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
    tabCount += tabs.length;
    return {
      id: w.id,
      focused: !!w.focused,
      incognito: !!w.incognito,
      type: w.type || "normal",
      state: w.state || "normal",
      left: w.left ?? null,
      top: w.top ?? null,
      width: w.width ?? null,
      height: w.height ?? null,
      groups: [...new Set(tabs.map((t) => t.groupId).filter((g) => typeof g === "number" && g > 0))]
        .map((gid) => groupMeta[gid] || { id: gid, title: "", color: "grey", collapsed: false }),
      tabs: tabs.map((t) => ({
        id: t.id,
        title: t.title || "",
        url: t.url || t.pendingUrl || "",
        pinned: !!t.pinned,
        active: !!t.active,
        index: t.index ?? 0,
        groupId: (typeof t.groupId === "number" && t.groupId > 0) ? t.groupId : null,
        favIconUrl: t.favIconUrl || null,
        lastAccessed: accessed[t.id] || 0,
        activations: counts[t.id] || 0,
      })),
    };
  });

  return {
    schema: "tab-heatmap.session",
    version: 1,
    exportedAt: new Date(now).toISOString(),
    exportedAtMs: now,
    settings: {
      recencyHalfLifeMinutes: settings.recencyHalfLifeMinutes,
      hotThreshold: settings.hotThreshold,
      idleCloseDays: settings.idleCloseDays,
    },
    counts: { windows: winOut.length, tabs: tabCount },
    windows: winOut,
  };
}

/** Validate session snapshot JSON. */
function parseSessionSnapshot(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Not valid JSON"); }
  if (!data || typeof data !== "object") throw new Error("Empty session");
  if (data.schema !== "tab-heatmap.session") throw new Error("Wrong schema");
  if (!Array.isArray(data.windows)) throw new Error("Missing windows[]");
  return data;
}

/**
 * Restore a full session snapshot. For each saved window, open a new browser
 * window with its first restorable URL, then append the remaining tabs in
 * order, re-pinning and re-grouping as needed. Heat metadata is patched back
 * via the SW so the restored tabs keep their warmth.
 */
async function restoreSessionSnapshot(snapshot) {
  const wins = Array.isArray(snapshot.windows) ? snapshot.windows : [];
  if (wins.length === 0) return { windows: 0, opened: 0, skipped: 0, groups: 0 };
  const isRestorable = (u) => typeof u === "string" && /^(https?:|file:|ftp:)/.test(u);

  let openedTotal = 0, skippedTotal = 0, groupsTotal = 0;
  const metaEntries = [];

  for (const w of wins) {
    const tabs = Array.isArray(w.tabs) ? w.tabs : [];
    const restorable = tabs.filter((t) => isRestorable(t.url));
    skippedTotal += tabs.length - restorable.length;
    if (restorable.length === 0) continue;

    const first = restorable[0];
    const rest = restorable.slice(1);

    const winOpts = { url: first.url, focused: false, type: "normal" };
    if (Number.isFinite(w.left)) winOpts.left = w.left;
    if (Number.isFinite(w.top)) winOpts.top = w.top;
    if (Number.isFinite(w.width)) winOpts.width = w.width;
    if (Number.isFinite(w.height)) winOpts.height = w.height;
    if (w.state === "minimized" || w.state === "maximized" || w.state === "fullscreen") winOpts.state = w.state;

    let createdWin;
    try {
      createdWin = await chrome.windows.create(winOpts);
    } catch (err) {
      console.warn(LOG, "session: window.create failed:", err);
      skippedTotal += restorable.length;
      continue;
    }
    openedTotal++;

    // The window was created with a single tab pre-loaded with `first.url`.
    const firstTabId = createdWin?.tabs?.[0]?.id;
    if (typeof firstTabId === "number") {
      if (first.pinned) {
        try { await chrome.tabs.update(firstTabId, { pinned: true }); } catch {}
      }
      metaEntries.push({ tabId: firstTabId, lastAccessed: first.lastAccessed || 0, activations: first.activations || 0 });
    }

    // Index tabs by old groupId so we can re-create groups after creation.
    const tabIdsByOldGroup = new Map();
    if (first.groupId && firstTabId) {
      if (!tabIdsByOldGroup.has(first.groupId)) tabIdsByOldGroup.set(first.groupId, []);
      tabIdsByOldGroup.get(first.groupId).push(firstTabId);
    }

    for (const t of rest) {
      try {
        const created = await chrome.tabs.create({
          windowId: createdWin.id,
          url: t.url,
          active: false,
          pinned: !!t.pinned,
        });
        openedTotal++;
        if (typeof created.id === "number") {
          metaEntries.push({ tabId: created.id, lastAccessed: t.lastAccessed || 0, activations: t.activations || 0 });
          if (t.groupId) {
            if (!tabIdsByOldGroup.has(t.groupId)) tabIdsByOldGroup.set(t.groupId, []);
            tabIdsByOldGroup.get(t.groupId).push(created.id);
          }
        }
      } catch (err) {
        console.warn(LOG, "session: tabs.create failed:", err, t.url);
        skippedTotal++;
      }
    }

    // Re-create tab groups with their saved title/color/collapsed state.
    const savedGroups = Array.isArray(w.groups) ? w.groups : [];
    if (chrome.tabs?.group && chrome.tabGroups?.update) {
      for (const sg of savedGroups) {
        const ids = tabIdsByOldGroup.get(sg.id) || [];
        if (ids.length === 0) continue;
        try {
          const newGroupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: createdWin.id } });
          await chrome.tabGroups.update(newGroupId, {
            title: sg.title || "",
            color: sg.color || "grey",
            collapsed: !!sg.collapsed,
          });
          groupsTotal++;
        } catch (err) {
          console.warn(LOG, "session: group restore failed:", err);
        }
      }
    }
  }

  if (metaEntries.length > 0) {
    await sendMessage(MSG.RESTORE_TAB_META, { entries: metaEntries });
  }
  return { windows: openedTotal > 0 ? wins.length : 0, opened: openedTotal, skipped: skippedTotal, groups: groupsTotal };
}

/** Wire the "Save session" button: downloads a full-window session snapshot. */
async function wireSaveSession() {
  const btn = document.getElementById("save-session-btn");
  const status = document.getElementById("toolbar-status");
  if (!btn) return;
  function setStatus(text, warn) {
    if (!status) return;
    status.textContent = text || "";
    status.classList.toggle("is-warn", !!warn);
  }
  btn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    btn.setAttribute("disabled", "true");
    setStatus("Saving session…", false);
    try {
      const snapshot = await buildSessionSnapshot();
      const stamp = new Date(snapshot.exportedAtMs).toISOString().replace(/[:.]/g, "-").replace("Z", "");
      const filename = `tab-heatmap-session-${stamp}.json`;
      downloadJSON(filename, snapshot);
      setStatus(`Saved ${snapshot.counts.windows} window${snapshot.counts.windows === 1 ? "" : "s"} · ${snapshot.counts.tabs} tab${snapshot.counts.tabs === 1 ? "" : "s"}`, false);
    } catch (err) {
      console.warn(LOG, "save session failed:", err);
      setStatus("Save session failed", true);
    } finally {
      btn.removeAttribute("disabled");
    }
  });
}

/** Wire the "Restore session" button: pick a session JSON and reload it. */
async function wireRestoreSession() {
  const btn = document.getElementById("restore-session-btn");
  const file = document.getElementById("restore-session-file");
  const status = document.getElementById("toolbar-status");
  if (!btn || !file) return;
  function setStatus(text, warn) {
    if (!status) return;
    status.textContent = text || "";
    status.classList.toggle("is-warn", !!warn);
  }
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    file.value = "";
    file.click();
  });
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    btn.setAttribute("disabled", "true");
    setStatus("Restoring session…", false);
    try {
      const text = await f.text();
      const snapshot = parseSessionSnapshot(text);
      const result = await restoreSessionSnapshot(snapshot);
      const parts = [];
      if (result.opened) parts.push(`opened ${result.opened}`);
      if (result.groups) parts.push(`${result.groups} group${result.groups === 1 ? "" : "s"}`);
      if (result.skipped) parts.push(`skipped ${result.skipped}`);
      setStatus(parts.length ? `Session restored: ${parts.join(", ")}` : "Nothing to restore", false);
      setTimeout(() => { render().catch(() => {}); }, 300);
    } catch (err) {
      console.warn(LOG, "restore session failed:", err);
      setStatus(`Session restore failed: ${err?.message || "unknown"}`, true);
    } finally {
      btn.removeAttribute("disabled");
    }
  });
}

/* --- Weekly digest -------------------------------------------------------
 * Modal that surfaces the top 10 hottest and top 10 coldest tabs over the
 * last 7 days. "Hot" rank uses the existing live heat score (recency ×
 * frequency) blended with how many sparkline activations the tab has logged
 * in the rolling 24h × 7 sample. "Cold" rank promotes tabs that have been
 * idle the longest, ignoring pinned tabs (they’re intentionally excluded
 * from cold-close everywhere, so they shouldn’t appear here either).
 */
const DIGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DIGEST_TOP_N = 10;

function digestHotScore(row) {
  const heat = Number.isFinite(row.heat) ? row.heat : 0;
  const samples = Array.isArray(row.sparkSamples) ? row.sparkSamples.length : 0;
  return heat + Math.min(samples, 24) * 0.005;
}

function digestColdScore(row, now) {
  const stamp = Number.isFinite(row.lastAccessed) && row.lastAccessed > 0
    ? row.lastAccessed
    : (Number.isFinite(row.firstOpened) && row.firstOpened > 0 ? row.firstOpened : 0);
  if (!stamp) return -1;
  return Math.max(0, now - stamp);
}

function buildDigestRow(row, idx, kind, now) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "digest-row";
  btn.dataset.tabId = String(row.id);
  btn.dataset.windowId = String(row.windowId);
  btn.title = row.title || row.url || "";

  const rank = document.createElement("span");
  rank.className = "digest-rank";
  rank.textContent = String(idx + 1);

  const dot = document.createElement("span");
  dot.className = "digest-dot";
  dot.style.background = heatColor(row.heat || 0);

  const body = document.createElement("span");
  body.className = "digest-body";
  const title = document.createElement("span");
  title.className = "digest-row-title";
  title.textContent = row.title || row.url || "Untitled";
  const sub = document.createElement("span");
  sub.className = "digest-row-sub";
  const host = hostnameOf(row.url) || (row.url ? row.url.slice(0, 48) : "");
  sub.textContent = host;
  body.appendChild(title);
  body.appendChild(sub);

  const stat = document.createElement("span");
  stat.className = "digest-row-stat";
  if (kind === "hot") {
    const pct = Math.round((Number.isFinite(row.heat) ? row.heat : 0) * 100);
    const acts = row.activations || 0;
    stat.textContent = `${pct}% · ${acts}×`;
    stat.title = `Heat ${pct}% · ${acts} activation${acts === 1 ? "" : "s"}`;
  } else {
    const age = digestColdScore(row, now);
    stat.textContent = age > 0 ? formatCompactAge(age) : "new";
    stat.title = age > 0 ? `Idle ${formatAbsoluteAgo(age)}` : "No recorded activity yet";
  }

  btn.appendChild(rank);
  btn.appendChild(dot);
  btn.appendChild(body);
  btn.appendChild(stat);
  btn.addEventListener("click", async () => {
    await focusTab(row.id, row.windowId);
    closeDigest();
  });
  li.appendChild(btn);
  return li;
}

async function openDigest() {
  const modal = document.getElementById("digest-modal");
  if (!modal) return;
  const [tabs, accessedResp, countsResp, sparkResp, openedResp] = await Promise.all([
    getAllTabs(),
    sendMessage(MSG.GET_LAST_ACCESSED),
    sendMessage(MSG.GET_ACTIVATION_COUNTS),
    sendMessage(MSG.GET_ACTIVITY_SPARK),
    sendMessage(MSG.GET_FIRST_OPENED),
  ]);
  const rows = buildRows(
    tabs,
    accessedResp?.map || {},
    countsResp?.map || {},
    sparkResp?.map || {},
    openedResp?.map || {}
  );
  const now = Date.now();

  // Hot pool: exclude pinned (they’re always sticky) and tabs that have
  // literally never been touched and carry zero heat.
  const hotPool = rows.filter((r) => !r.pinned && (r.activations > 0 || r.heat > 0));
  const hot = hotPool
    .slice()
    .sort((a, b) => digestHotScore(b) - digestHotScore(a))
    .slice(0, DIGEST_TOP_N);

  // Cold pool: idle longer than 5 minutes, excluding pinned.
  const minIdleMs = 5 * 60 * 1000;
  const coldPool = rows.filter((r) => {
    if (r.pinned) return false;
    const age = digestColdScore(r, now);
    return age > minIdleMs;
  });
  const cold = coldPool
    .slice()
    .sort((a, b) => digestColdScore(b, now) - digestColdScore(a, now))
    .slice(0, DIGEST_TOP_N);

  const hotList = document.getElementById("digest-hot-list");
  const coldList = document.getElementById("digest-cold-list");
  const hotEmpty = document.getElementById("digest-hot-empty");
  const coldEmpty = document.getElementById("digest-cold-empty");
  const hotMeta = document.getElementById("digest-hot-meta");
  const coldMeta = document.getElementById("digest-cold-meta");
  const winEl = document.getElementById("digest-window");

  if (hotList) {
    hotList.innerHTML = "";
    hot.forEach((r, i) => hotList.appendChild(buildDigestRow(r, i, "hot", now)));
  }
  if (coldList) {
    coldList.innerHTML = "";
    cold.forEach((r, i) => coldList.appendChild(buildDigestRow(r, i, "cold", now)));
  }
  if (hotEmpty) hotEmpty.classList.toggle("hidden", hot.length > 0);
  if (coldEmpty) coldEmpty.classList.toggle("hidden", cold.length > 0);
  if (hotMeta) hotMeta.textContent = hot.length ? `${hot.length} of ${hotPool.length}` : "";
  if (coldMeta) coldMeta.textContent = cold.length ? `${cold.length} of ${coldPool.length}` : "";
  if (winEl) winEl.textContent = `last 7 days · ${rows.length} tab${rows.length === 1 ? "" : "s"}`;

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  setTimeout(() => {
    try { document.getElementById("digest-close")?.focus(); } catch {}
  }, 30);
}

function closeDigest() {
  const modal = document.getElementById("digest-modal");
  if (!modal || modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  try { document.getElementById("digest-btn")?.focus(); } catch {}
}

function wireDigest() {
  const openBtn = document.getElementById("digest-btn");
  const modal = document.getElementById("digest-modal");
  if (!openBtn || !modal) return;
  openBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    openDigest().catch((err) => console.warn(LOG, "openDigest failed:", err));
  });
  modal.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t instanceof Element && t.closest("[data-digest-dismiss]")) {
      ev.preventDefault();
      closeDigest();
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !modal.classList.contains("hidden")) {
      ev.preventDefault();
      closeDigest();
    }
  });
}

/** Wire the "Hottest" button: asks the SW to focus the hottest tab. */
function wireJumpHottest() {
  const btn = document.getElementById("jump-hottest-btn");
  const status = document.getElementById("toolbar-status");
  if (!btn) return;
  btn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    btn.setAttribute("disabled", "true");
    const res = await sendMessage(MSG.JUMP_HOTTEST);
    btn.removeAttribute("disabled");
    if (res?.ok) {
      window.close();
    } else if (status) {
      status.textContent = "No hotter tab to jump to";
      status.classList.remove("is-warn");
    }
  });
}

/**
 * Wire the search/filter input. Debounced re-render keeps typing snappy on
 * windows with many tabs. Esc clears the filter; the small ✕ button does too.
 * Cmd/Ctrl+F focuses the field for power users.
 */
function wireSearch() {
  const input = document.getElementById("search-input");
  const clear = document.getElementById("search-clear");
  if (!input) return;

  let debounce = 0;
  function setQueryFromInput() {
    const next = normalizeQuery(input.value);
    if (next === FILTER_QUERY) return;
    FILTER_QUERY = next;
    if (clear) clear.classList.toggle("hidden", FILTER_QUERY.length === 0);
    render().catch((err) => console.warn(LOG, "filter render failed:", err));
  }

  input.addEventListener("input", () => {
    if (clear) clear.classList.toggle("hidden", input.value.length === 0);
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(setQueryFromInput, 80);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (input.value) {
        ev.preventDefault();
        input.value = "";
        if (debounce) clearTimeout(debounce);
        setQueryFromInput();
      }
    }
  });
  if (clear) {
    clear.addEventListener("click", () => {
      input.value = "";
      if (debounce) clearTimeout(debounce);
      setQueryFromInput();
      input.focus();
    });
  }
  document.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === "f" || ev.key === "F")) {
      ev.preventDefault();
      input.focus();
      input.select();
    }
  });
  // Autofocus on open so the user can just start typing.
  setTimeout(() => { try { input.focus(); } catch {} }, 30);
}

function applyGroupToggleVisual(btn) {
  btn.setAttribute("aria-pressed", GROUP_BY_HOST ? "true" : "false");
  btn.classList.toggle("is-active", GROUP_BY_HOST);
}

function applyClusterToggleVisual(btn) {
  if (!btn) return;
  btn.setAttribute("aria-pressed", CLUSTER_BY_DOMAIN ? "true" : "false");
  btn.classList.toggle("is-active", CLUSTER_BY_DOMAIN);
}

let GROUP_BY_HOST = false;
let CLUSTER_BY_DOMAIN = false;
let FILTER_QUERY = "";
let SORT_MODE = "heat";
// Chrome tab-group id to filter by, or "all" for no filter, or "none" for ungrouped tabs.
let GROUP_FILTER = "all";
// Cached map of tabGroups.Group keyed by id, refreshed on each render.
let TAB_GROUPS_BY_ID = new Map();
let SELECT_MODE = false;
/** @type {Set<number>} ids of tabs currently selected in bulk-select mode. */
const SELECTED = new Set();
let CLOSE_SELECTED_ARMED = false;
let CLOSE_SELECTED_TIMER = 0;

const VALID_SORT_MODES = new Set(["heat", "recency", "frequency", "alpha"]);

/** Wire the sort dropdown. Persists last choice in chrome.storage.local. */
async function wireSort() {
  const sel = document.getElementById("sort-select");
  if (!sel) return;
  try {
    const stored = await new Promise((resolve) => {
      chrome.storage?.local?.get?.(["th:sortMode"], (items) => resolve(items || {}));
    });
    const v = stored["th:sortMode"];
    if (typeof v === "string" && VALID_SORT_MODES.has(v)) SORT_MODE = v;
  } catch {}
  sel.value = SORT_MODE;
  sel.addEventListener("change", () => {
    const next = sel.value;
    if (!VALID_SORT_MODES.has(next)) return;
    SORT_MODE = next;
    try { chrome.storage?.local?.set?.({ "th:sortMode": SORT_MODE }); } catch {}
    render().catch((err) => console.warn(LOG, "sort re-render failed:", err));
  });
}

/** Lowercase + trim for the filter compare. */
function normalizeQuery(q) {
  return typeof q === "string" ? q.trim().toLowerCase() : "";
}

/** True if the row matches the current filter query (title or url). */
function rowMatchesFilter(row, q) {
  if (!q) return true;
  const hay = `${row.title || ""}\n${row.url || ""}`.toLowerCase();
  return hay.includes(q);
}

/**
 * Wrap occurrences of `query` in an element's text with <span class="match">.
 * `el` must contain plain text (not HTML) — we set textContent first.
 */
function highlightInto(el, text, query) {
  el.textContent = text || "";
  if (!query) return;
  const hay = (text || "").toLowerCase();
  let i = hay.indexOf(query);
  if (i < 0) return;
  // Rebuild the element with safe text nodes + <span> matches.
  el.textContent = "";
  let cursor = 0;
  while (i >= 0) {
    if (i > cursor) el.appendChild(document.createTextNode(text.slice(cursor, i)));
    const m = document.createElement("span");
    m.className = "match";
    m.textContent = text.slice(i, i + query.length);
    el.appendChild(m);
    cursor = i + query.length;
    i = hay.indexOf(query, cursor);
  }
  if (cursor < text.length) el.appendChild(document.createTextNode(text.slice(cursor)));
}

applyTheme();
wireSettings();
wireGroupFilter().catch((err) => console.warn(LOG, "wireGroupFilter failed:", err));
wireCloseIdle().catch((err) => console.warn(LOG, "wireCloseIdle failed:", err));
wireSuspendIdle().catch((err) => console.warn(LOG, "wireSuspendIdle failed:", err));
wireCopyColdUrls().catch((err) => console.warn(LOG, "wireCopyColdUrls failed:", err));
wireExport().catch((err) => console.warn(LOG, "wireExport failed:", err));
wireCsvExport().catch((err) => console.warn(LOG, "wireCsvExport failed:", err));
wireImport().catch((err) => console.warn(LOG, "wireImport failed:", err));
wireSaveSession().catch((err) => console.warn(LOG, "wireSaveSession failed:", err));
wireRestoreSession().catch((err) => console.warn(LOG, "wireRestoreSession failed:", err));
wireQuickChips().catch((err) => console.warn(LOG, "wireQuickChips failed:", err));
wireDigest();
wireJumpHottest();
wireSearch();
wireBulkSelect();
Promise.all([wireSort(), wireGroupToggle(), wireClusterToggle(), resolveCurrentWindowId()])
  .then(() => render())
  .catch((err) => console.warn(LOG, "render failed:", err));

/**
 * Update the toolbar's selection-mode visuals — selected count pill, label,
 * "All" button label (Select all ↔ Clear), and the close-selected button's
 * disarmed state when the set changes.
 */
function updateSelectionUI() {
  const pill = document.getElementById("selected-count-pill");
  const closeBtn = document.getElementById("close-selected-btn");
  const labelEl = closeBtn?.querySelector(".action-label");
  const allBtn = document.getElementById("select-all-btn");
  const status = document.getElementById("toolbar-status");
  const n = SELECTED.size;
  if (pill) pill.textContent = String(n);
  if (closeBtn) {
    closeBtn.classList.toggle("is-disabled", n === 0);
    if (n === 0) closeBtn.setAttribute("disabled", "true");
    else closeBtn.removeAttribute("disabled");
  }
  // Reset confirm state when the selection changes.
  if (CLOSE_SELECTED_ARMED) {
    CLOSE_SELECTED_ARMED = false;
    if (CLOSE_SELECTED_TIMER) { clearTimeout(CLOSE_SELECTED_TIMER); CLOSE_SELECTED_TIMER = 0; }
    if (closeBtn) closeBtn.classList.remove("is-confirming");
    if (labelEl) labelEl.textContent = "Close selected";
    if (status) { status.textContent = ""; status.classList.remove("is-warn"); }
  }
  if (allBtn) {
    const allLabel = allBtn.querySelector(".action-label");
    if (allLabel) allLabel.textContent = n > 0 ? "Clear" : "All";
  }
}

/** Toggle bulk-select mode on/off; resets selection when leaving. */
function setSelectMode(on) {
  SELECT_MODE = !!on;
  if (!SELECT_MODE) SELECTED.clear();
  const toggleBtn = document.getElementById("select-toggle-btn");
  const closeBtn = document.getElementById("close-selected-btn");
  const allBtn = document.getElementById("select-all-btn");
  if (toggleBtn) {
    toggleBtn.setAttribute("aria-pressed", SELECT_MODE ? "true" : "false");
    toggleBtn.classList.toggle("is-active", SELECT_MODE);
    const lbl = toggleBtn.querySelector(".action-label");
    if (lbl) lbl.textContent = SELECT_MODE ? "Done" : "Select";
  }
  if (closeBtn) closeBtn.classList.toggle("hidden", !SELECT_MODE);
  if (allBtn) allBtn.classList.toggle("hidden", !SELECT_MODE);
  const list = document.getElementById("tab-list");
  if (list) list.classList.toggle("is-select-mode", SELECT_MODE);
  updateSelectionUI();
  // Hide any open hover tooltip — it's distracting in select mode.
  hideTooltip(true);
  render().catch((err) => console.warn(LOG, "select-mode re-render failed:", err));
}

/** Collect visible tab IDs from the currently rendered list. */
function visibleTabIds() {
  const ids = [];
  const list = document.getElementById("tab-list");
  if (!list) return ids;
  for (const li of list.querySelectorAll(".tab-row")) {
    const id = Number(li.dataset.tabId);
    if (Number.isFinite(id)) ids.push(id);
  }
  return ids;
}

/**
 * Wire the bulk-select toolbar: enter/exit mode, select-all/clear, and the
 * two-step "Close selected" confirm pattern (mirrors the close-idle flow).
 */
function wireBulkSelect() {
  const toggle = document.getElementById("select-toggle-btn");
  const closeBtn = document.getElementById("close-selected-btn");
  const allBtn = document.getElementById("select-all-btn");
  const status = document.getElementById("toolbar-status");
  const labelEl = closeBtn?.querySelector(".action-label");
  if (!toggle || !closeBtn) return;

  function setStatus(text, warn) {
    if (!status) return;
    status.textContent = text || "";
    status.classList.toggle("is-warn", !!warn);
  }

  toggle.addEventListener("click", (ev) => {
    ev.preventDefault();
    setSelectMode(!SELECT_MODE);
  });

  if (allBtn) {
    allBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      const ids = visibleTabIds();
      // If everything visible is selected, clear; otherwise select all visible.
      const allOn = ids.length > 0 && ids.every((id) => SELECTED.has(id));
      if (allOn || SELECTED.size > 0 && !ids.some((id) => !SELECTED.has(id))) {
        SELECTED.clear();
      } else {
        for (const id of ids) SELECTED.add(id);
      }
      // Reflect in the live DOM without a full re-render.
      const list = document.getElementById("tab-list");
      if (list) {
        for (const li of list.querySelectorAll(".tab-row")) {
          const on = SELECTED.has(Number(li.dataset.tabId));
          li.classList.toggle("is-selected", on);
          li.setAttribute("aria-checked", on ? "true" : "false");
        }
      }
      updateSelectionUI();
    });
  }

  function disarm() {
    CLOSE_SELECTED_ARMED = false;
    closeBtn.classList.remove("is-confirming");
    if (labelEl) labelEl.textContent = "Close selected";
    if (CLOSE_SELECTED_TIMER) { clearTimeout(CLOSE_SELECTED_TIMER); CLOSE_SELECTED_TIMER = 0; }
  }

  closeBtn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const n = SELECTED.size;
    if (n === 0) {
      setStatus("Select tabs first", true);
      return;
    }
    if (!CLOSE_SELECTED_ARMED) {
      CLOSE_SELECTED_ARMED = true;
      closeBtn.classList.add("is-confirming");
      if (labelEl) labelEl.textContent = `Close ${n} tab${n === 1 ? "" : "s"}?`;
      setStatus("Click again to confirm", true);
      CLOSE_SELECTED_TIMER = setTimeout(disarm, 4000);
      return;
    }
    closeBtn.setAttribute("disabled", "true");
    setStatus("Closing…", false);
    const ids = Array.from(SELECTED);
    const result = await closeTabsByIds(ids);
    const closed = result?.count || 0;
    disarm();
    SELECTED.clear();
    closeBtn.removeAttribute("disabled");
    if (closed === 0) {
      setStatus("Nothing closed", false);
    } else {
      setStatus("", false);
      showUndoToast(closed, result.closedTabs || []);
    }
    // Stay in select mode but with an empty selection so the user can keep going.
    setTimeout(() => { render().catch(() => {}); }, 150);
  });
}

/**
 * Close a list of tab IDs via chrome.tabs.remove.
 * Captures the closed tabs' metadata (url, pinned, heat signals) before the
 * remove call so the caller can show an Undo toast. Returns
 * { count, closedTabs } where closedTabs is the captured metadata array.
 */
async function closeTabsByIds(ids) {
  const clean = (Array.isArray(ids) ? ids : []).filter((n) => Number.isFinite(n));
  if (clean.length === 0) return { count: 0, closedTabs: [] };
  // Snapshot tab data + heat signals before removal.
  const [accessedResp, countsResp] = await Promise.all([
    sendMessage(MSG.GET_LAST_ACCESSED),
    sendMessage(MSG.GET_ACTIVATION_COUNTS),
  ]);
  const accessed = accessedResp?.map || {};
  const counts = countsResp?.map || {};
  const closedTabs = [];
  await Promise.all(clean.map(async (id) => {
    try {
      const t = await chrome.tabs.get(id);
      if (!t || !t.url) return;
      closedTabs.push({
        url: t.url,
        title: t.title || "",
        pinned: !!t.pinned,
        windowId: t.windowId,
        lastAccessed: typeof accessed[String(id)] === "number" ? accessed[String(id)] : (typeof t.lastAccessed === "number" ? t.lastAccessed : 0),
        activations: typeof counts[String(id)] === "number" ? counts[String(id)] : 0,
      });
    } catch { /* tab gone, skip */ }
  }));
  try {
    await new Promise((resolve) => {
      try {
        chrome.tabs.remove(clean, () => {
          // Swallow lastError — a tab may have closed between selection and removal.
          if (chrome.runtime.lastError) console.warn(LOG, "tabs.remove:", chrome.runtime.lastError.message);
          resolve();
        });
      } catch (err) {
        console.warn(LOG, "tabs.remove threw:", err);
        resolve();
      }
    });
    return { count: clean.length, closedTabs };
  } catch (err) {
    console.warn(LOG, "closeTabsByIds failed:", err);
    return { count: 0, closedTabs: [] };
  }
}

/**
 * Toast notification with Undo for the last close action.
 * Restores tabs via chrome.tabs.create and re-stamps their heat metadata via
 * the background's th:restoreTabMeta channel so heat scores survive.
 *
 * Singleton: a new close action replaces the previous toast (and its undo
 * buffer) — only the most recent close is undoable, by design.
 */
let TOAST_EL = null;
let TOAST_HIDE_TIMER = 0;
let TOAST_BUFFER = null; // { closedTabs: [...] }
const TOAST_LIFETIME_MS = 8000;

function ensureToastEl() {
  if (TOAST_EL && document.body.contains(TOAST_EL)) return TOAST_EL;
  const el = document.createElement("div");
  el.className = "undo-toast";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML =
    '<span class="undo-toast-icon" aria-hidden="true">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M9 14L4 9l5-5"/>' +
        '<path d="M4 9h11a5 5 0 015 5v0a5 5 0 01-5 5H9"/>' +
      '</svg>' +
    '</span>' +
    '<span class="undo-toast-text" data-field="text"></span>' +
    '<button type="button" class="undo-toast-btn" data-undo>Undo</button>' +
    '<button type="button" class="undo-toast-close" aria-label="Dismiss" data-dismiss>' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M6 6l12 12M18 6L6 18"/>' +
      '</svg>' +
    '</button>';
  document.body.appendChild(el);
  el.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    if (target.closest("[data-undo]")) {
      ev.preventDefault();
      undoLastClose().catch((err) => console.warn(LOG, "undo failed:", err));
    } else if (target.closest("[data-dismiss]")) {
      ev.preventDefault();
      hideUndoToast(true);
    }
  });
  TOAST_EL = el;
  return el;
}

function hideUndoToast(immediate) {
  if (TOAST_HIDE_TIMER) { clearTimeout(TOAST_HIDE_TIMER); TOAST_HIDE_TIMER = 0; }
  if (!TOAST_EL) return;
  const apply = () => {
    if (TOAST_EL) {
      TOAST_EL.classList.remove("is-visible");
      TOAST_EL.setAttribute("aria-hidden", "true");
    }
  };
  if (immediate) apply();
  else { TOAST_HIDE_TIMER = setTimeout(apply, 120); }
}

function showUndoToast(count, closedTabs) {
  const n = Number(count) || 0;
  const tabs = Array.isArray(closedTabs) ? closedTabs.filter((t) => t && typeof t.url === "string" && /^https?:|^file:|^ftp:/.test(t.url)) : [];
  if (n <= 0) return;
  TOAST_BUFFER = tabs.length > 0 ? { closedTabs: tabs } : null;
  const tip = ensureToastEl();
  const text = tip.querySelector('[data-field="text"]');
  if (text) text.textContent = `Closed ${n} tab${n === 1 ? "" : "s"}`;
  const undoBtn = tip.querySelector("[data-undo]");
  if (undoBtn) {
    // Disable Undo when we have no restorable URLs (e.g. chrome:// pages).
    if (TOAST_BUFFER && TOAST_BUFFER.closedTabs.length > 0) {
      undoBtn.removeAttribute("disabled");
      undoBtn.classList.remove("is-disabled");
    } else {
      undoBtn.setAttribute("disabled", "true");
      undoBtn.classList.add("is-disabled");
    }
  }
  tip.classList.add("is-visible");
  tip.setAttribute("aria-hidden", "false");
  if (TOAST_HIDE_TIMER) { clearTimeout(TOAST_HIDE_TIMER); TOAST_HIDE_TIMER = 0; }
  TOAST_HIDE_TIMER = setTimeout(() => hideUndoToast(false), TOAST_LIFETIME_MS);
}

async function undoLastClose() {
  const buf = TOAST_BUFFER;
  if (!buf || !Array.isArray(buf.closedTabs) || buf.closedTabs.length === 0) {
    hideUndoToast(true);
    return;
  }
  // Consume the buffer immediately so a double-click doesn't double-restore.
  TOAST_BUFFER = null;
  const undoBtn = TOAST_EL?.querySelector("[data-undo]");
  if (undoBtn) undoBtn.setAttribute("disabled", "true");
  const text = TOAST_EL?.querySelector('[data-field="text"]');
  if (text) text.textContent = `Restoring${buf.closedTabs.length > 1 ? " " + buf.closedTabs.length + " tabs" : ""}\u2026`;
  const metaEntries = [];
  let opened = 0;
  for (const t of buf.closedTabs) {
    try {
      const created = await chrome.tabs.create({
        url: t.url,
        active: false,
        pinned: !!t.pinned,
        windowId: typeof t.windowId === "number" ? t.windowId : undefined,
      });
      if (created && typeof created.id === "number") {
        opened++;
        metaEntries.push({
          tabId: created.id,
          lastAccessed: t.lastAccessed || 0,
          activations: t.activations || 0,
        });
      }
    } catch (err) {
      console.warn(LOG, "undo create failed:", err, t.url);
    }
  }
  if (metaEntries.length > 0) {
    await sendMessage(MSG.RESTORE_TAB_META, { entries: metaEntries });
  }
  if (text) text.textContent = opened > 0 ? `Restored ${opened} tab${opened === 1 ? "" : "s"}` : "Nothing restored";
  // Brief confirmation, then dismiss.
  if (TOAST_HIDE_TIMER) { clearTimeout(TOAST_HIDE_TIMER); TOAST_HIDE_TIMER = 0; }
  TOAST_HIDE_TIMER = setTimeout(() => hideUndoToast(false), 1600);
  setTimeout(() => { render().catch(() => {}); }, 200);
}

/**
 * Fetch all current tab groups across windows as Map<groupId, group>.
 * Returns an empty map when the tabGroups API is unavailable (non-Chromium).
 */
async function getTabGroupsMap() {
  const out = new Map();
  try {
    if (!chrome.tabGroups || typeof chrome.tabGroups.query !== "function") return out;
    const groups = await new Promise((resolve) => {
      try {
        chrome.tabGroups.query({}, (gs) => {
          if (chrome.runtime.lastError) { resolve([]); return; }
          resolve(Array.isArray(gs) ? gs : []);
        });
      } catch { resolve([]); }
    });
    for (const g of groups) if (g && typeof g.id === "number") out.set(g.id, g);
  } catch (err) {
    console.warn(LOG, "getTabGroupsMap failed:", err);
  }
  return out;
}

/** Map a Chrome group color name to a CSS color (matches Chrome's palette). */
function tabGroupColorCss(name) {
  switch (name) {
    case "grey":   return "#5f6368";
    case "blue":   return "#1a73e8";
    case "red":    return "#d93025";
    case "yellow": return "#f9ab00";
    case "green":  return "#188038";
    case "pink":   return "#d01884";
    case "purple": return "#9334e6";
    case "cyan":   return "#007b83";
    case "orange": return "#fa7b17";
    default:       return "var(--fg-dim)";
  }
}

/** Populate the group-filter <select> from the current tab list + group metadata. */
function populateGroupFilterOptions(tabs) {
  const control = document.getElementById("group-filter-control");
  const sel = document.getElementById("group-filter-select");
  const swatch = document.getElementById("group-filter-swatch");
  if (!control || !sel) return;

  // Count tabs per group id present in this window-set so we only show
  // groups that have at least one tab. groupId === -1 means "no group".
  const counts = new Map();
  let ungrouped = 0;
  for (const t of tabs) {
    if (!t || typeof t.id !== "number") continue;
    const gid = typeof t.groupId === "number" ? t.groupId : -1;
    if (gid === -1) { ungrouped++; continue; }
    counts.set(gid, (counts.get(gid) || 0) + 1);
  }

  // Hide the control entirely when there are no groups — saves toolbar space.
  if (counts.size === 0) {
    control.classList.add("hidden");
    if (GROUP_FILTER !== "all") {
      GROUP_FILTER = "all";
      try { chrome.storage?.local?.set?.({ "th:groupFilter": "all" }); } catch {}
    }
    return;
  }
  control.classList.remove("hidden");

  // Rebuild options: All groups, Ungrouped (if any), then each named group.
  const prev = GROUP_FILTER;
  sel.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "all";
  optAll.textContent = `All groups (${tabs.length})`;
  sel.appendChild(optAll);
  if (ungrouped > 0) {
    const optNone = document.createElement("option");
    optNone.value = "none";
    optNone.textContent = `Ungrouped (${ungrouped})`;
    sel.appendChild(optNone);
  }
  // Sort groups by name (fall back to id) for a stable order.
  const entries = Array.from(counts.entries()).map(([gid, n]) => {
    const g = TAB_GROUPS_BY_ID.get(gid) || {};
    return { gid, count: n, title: g.title || "", color: g.color || "grey" };
  });
  entries.sort((a, b) => {
    const at = (a.title || `Group ${a.gid}`).toLowerCase();
    const bt = (b.title || `Group ${b.gid}`).toLowerCase();
    return at.localeCompare(bt) || a.gid - b.gid;
  });
  for (const e of entries) {
    const opt = document.createElement("option");
    opt.value = String(e.gid);
    const label = e.title || `Group ${e.gid}`;
    opt.textContent = `${label} (${e.count})`;
    opt.dataset.color = e.color;
    sel.appendChild(opt);
  }

  // If the previously selected group disappeared, fall back to "all".
  const validValues = new Set(Array.from(sel.options).map((o) => o.value));
  const next = validValues.has(prev) ? prev : "all";
  if (next !== GROUP_FILTER) {
    GROUP_FILTER = next;
    try { chrome.storage?.local?.set?.({ "th:groupFilter": next }); } catch {}
  }
  sel.value = GROUP_FILTER;

  // Color swatch reflects the active selection.
  if (swatch) {
    if (GROUP_FILTER === "all" || GROUP_FILTER === "none") {
      swatch.style.display = "none";
    } else {
      const g = TAB_GROUPS_BY_ID.get(Number(GROUP_FILTER));
      swatch.style.display = "";
      swatch.style.background = tabGroupColorCss(g?.color || "grey");
    }
  }
}

/** Filter rows by the active group-filter selection. */
function applyGroupFilter(rows) {
  if (!Array.isArray(rows)) return [];
  if (GROUP_FILTER === "all") return rows;
  if (GROUP_FILTER === "none") return rows.filter((r) => !Number.isFinite(r.groupId) || r.groupId === -1);
  const gid = Number(GROUP_FILTER);
  if (!Number.isFinite(gid)) return rows;
  return rows.filter((r) => r.groupId === gid);
}

/** Hydrate persisted group-filter choice and wire the <select> change event. */
async function wireGroupFilter() {
  const sel = document.getElementById("group-filter-select");
  if (!sel) return;
  try {
    const stored = await new Promise((resolve) => {
      chrome.storage?.local?.get?.(["th:groupFilter"], (items) => resolve(items || {}));
    });
    const v = stored["th:groupFilter"];
    if (typeof v === "string") GROUP_FILTER = v;
  } catch {}
  sel.addEventListener("change", () => {
    GROUP_FILTER = sel.value || "all";
    try { chrome.storage?.local?.set?.({ "th:groupFilter": GROUP_FILTER }); } catch {}
    render().catch((err) => console.warn(LOG, "group-filter re-render failed:", err));
  });
  // React in real time to Chrome group changes (rename, color, add/remove).
  try {
    chrome.tabGroups?.onUpdated?.addListener(() => { render().catch(() => {}); });
    chrome.tabGroups?.onRemoved?.addListener(() => { render().catch(() => {}); });
    chrome.tabGroups?.onCreated?.addListener(() => { render().catch(() => {}); });
    chrome.tabs?.onUpdated?.addListener((_id, info) => {
      if (info && "groupId" in info) render().catch(() => {});
    });
  } catch {}
}

// Expose for unit-style smoke tests in a non-extension runtime.
export { buildRows, recencyScore, frequencyScore, heatColor, groupRowsByHost, buildSnapshot, parseSnapshot, buildSessionSnapshot, parseSessionSnapshot, rowMatchesFilter, normalizeQuery, sortRows, sortGroups, formatRelativeTime, formatAbsoluteTime, formatCompactAge, formatAbsoluteAgo, bucketizeActivity, sparkPath, renderSparkSVG, computeHeatTrend, renderTrendSVG, buildHeatHistogram, HIST_BUCKETS, renderHeatMinimap, applyGroupFilter, tabGroupColorCss, collectColdTabs, writeClipboardText, countColdCandidates, countPinHotCandidates, buildUsageCsv, csvEscape };
