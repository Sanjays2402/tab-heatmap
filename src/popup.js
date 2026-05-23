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
function groupRowsByHost(rows) {
  const map = new Map();
  for (const row of rows) {
    const host = hostnameOf(row.url) || "(local)";
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
function appendGroup(parent, group, expanded) {
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
      const key = "th:groupOpen:" + group.host;
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

  const rows = buildRows(tabs, accessedResp.map || {}, countsResp.map || {}, sparkResp?.map || {}, openedResp?.map || {});
  const sortedAll = sortRows(rows, SORT_MODE);
  const allRows = sortedAll;
  renderHeatHistogram(allRows);
  const q = FILTER_QUERY;
  const filtered = q ? sortedAll.filter((r) => rowMatchesFilter(r, q)) : sortedAll;
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
  if (GROUP_BY_HOST) {
    list.classList.add("is-grouped");
    const groups = sortGroups(groupRowsByHost(filtered), SORT_MODE);
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
      const key = "th:groupOpen:" + g.host;
      const expanded = key in overrides
        ? !!overrides[key]
        : (g.heat >= HOT_THRESHOLD || groups.length <= 4);
      appendGroup(frag, g, expanded);
    }
  } else {
    list.classList.remove("is-grouped");
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
    applyGroupToggleVisual(btn);
    try { chrome.storage?.local?.set?.({ "th:groupByHost": GROUP_BY_HOST }); } catch {}
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

let GROUP_BY_HOST = false;
let FILTER_QUERY = "";
let SORT_MODE = "heat";
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
wireCloseIdle().catch((err) => console.warn(LOG, "wireCloseIdle failed:", err));
wireSuspendIdle().catch((err) => console.warn(LOG, "wireSuspendIdle failed:", err));
wireExport().catch((err) => console.warn(LOG, "wireExport failed:", err));
wireImport().catch((err) => console.warn(LOG, "wireImport failed:", err));
wireJumpHottest();
wireSearch();
wireBulkSelect();
Promise.all([wireSort(), wireGroupToggle()])
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

// Expose for unit-style smoke tests in a non-extension runtime.
export { buildRows, recencyScore, frequencyScore, heatColor, groupRowsByHost, buildSnapshot, parseSnapshot, rowMatchesFilter, normalizeQuery, sortRows, sortGroups, formatRelativeTime, formatAbsoluteTime, formatCompactAge, formatAbsoluteAgo, bucketizeActivity, sparkPath, renderSparkSVG, buildHeatHistogram, HIST_BUCKETS };
