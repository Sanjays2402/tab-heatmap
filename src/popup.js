// Tab Heatmap — popup entry point.
// Renders the open-tab list with a heat score (recency × frequency).

const LOG = "[tab-heatmap:popup]";

const MSG = Object.freeze({
  GET_LAST_ACCESSED: "th:getLastAccessed",
  JUMP_HOTTEST: "th:jumpHottest",
  GET_ACTIVATION_COUNTS: "th:getActivationCounts",
  CLOSE_IDLE: "th:closeIdle",
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
function buildRows(tabs, accessedMap, countsMap) {
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
    return {
      id: t.id,
      windowId: t.windowId,
      title: t.title || t.url || "Untitled",
      url: t.url || "",
      favIconUrl: t.favIconUrl || "",
      active: !!t.active,
      pinned: !!t.pinned,
      lastAccessed: stamp,
      activations: count,
      recency: r,
      frequency: f,
      heat,
    };
  }).sort((a, b) => b.heat - a.heat);
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

/** Create a single tab row element. */
function rowElement(row) {
  const li = document.createElement("li");
  li.className = "tab-row" + (row.active ? " active" : "");
  li.setAttribute("role", "button");
  li.setAttribute("tabindex", "0");
  li.dataset.tabId = String(row.id);
  li.title = row.title + (row.url ? "\n" + row.url : "");

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

  li.innerHTML =
    faviconHTML +
    '<div class="tab-main">' +
      `<div class="tab-title"></div>` +
      `<div class="tab-sub"></div>` +
    '</div>' +
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
  li.addEventListener("click", activate);
  li.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); activate(); }
  });

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
  const [tabs, accessedResp, countsResp] = await Promise.all([
    getAllTabs(),
    sendMessage(MSG.GET_LAST_ACCESSED),
    sendMessage(MSG.GET_ACTIVATION_COUNTS),
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

  const rows = buildRows(tabs, accessedResp.map || {}, countsResp.map || {});
  const allRows = rows;
  const q = FILTER_QUERY;
  const filtered = q ? rows.filter((r) => rowMatchesFilter(r, q)) : rows;
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
    const groups = groupRowsByHost(filtered);
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
      setStatus(c === 0 ? `Nothing to close${suffix}` : `Closed ${c} tab${c === 1 ? "" : "s"}${suffix}`, false);
      // Re-render after a beat so the user sees the result, then refresh the list.
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
wireExport().catch((err) => console.warn(LOG, "wireExport failed:", err));
wireImport().catch((err) => console.warn(LOG, "wireImport failed:", err));
wireJumpHottest();
wireSearch();
wireGroupToggle().then(() => render()).catch((err) => console.warn(LOG, "render failed:", err));

// Expose for unit-style smoke tests in a non-extension runtime.
export { buildRows, recencyScore, frequencyScore, heatColor, groupRowsByHost, buildSnapshot, parseSnapshot, rowMatchesFilter, normalizeQuery };
