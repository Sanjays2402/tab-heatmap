// Tab Heatmap — popup entry point.
// Renders the open-tab list with a heat score (recency × frequency).

const LOG = "[tab-heatmap:popup]";

const MSG = Object.freeze({
  GET_LAST_ACCESSED: "th:getLastAccessed",
  GET_ACTIVATION_COUNTS: "th:getActivationCounts",
  CLOSE_IDLE: "th:closeIdle",
  GET_SETTINGS: "th:getSettings",
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

/** Detect prefers-color-scheme and set body theme accordingly. */
function applyTheme() {
  try {
    const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.body.dataset.theme = dark ? "dark" : "light";
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

/** Compute recency score in [0, 1] given last-access timestamp. */
function recencyScore(lastAccessedMs, now) {
  if (!Number.isFinite(lastAccessedMs)) return 0;
  const age = Math.max(0, now - lastAccessedMs);
  // Exponential decay with half-life RECENCY_HALF_LIFE_MS.
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
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
    const r = recencyScore(stamp, now);
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

  const rows = buildRows(tabs, accessedResp.map || {}, countsResp.map || {});
  const list = document.getElementById("tab-list");
  const empty = document.getElementById("empty-state");
  const stat = document.getElementById("stat");

  list.innerHTML = "";
  if (rows.length === 0) {
    empty.classList.remove("hidden");
    list.classList.add("hidden");
    if (stat) stat.textContent = "0 tabs";
    return;
  }
  empty.classList.add("hidden");
  list.classList.remove("hidden");

  const frag = document.createDocumentFragment();
  if (GROUP_BY_HOST) {
    list.classList.add("is-grouped");
    const groups = groupRowsByHost(rows);
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
    for (const row of rows) frag.appendChild(rowElement(row));
  }
  list.appendChild(frag);

  if (stat) {
    const hot = rows.filter((r) => r.heat >= HOT_THRESHOLD).length;
    stat.textContent = `${rows.length} tabs • ${hot} hot`;
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
      setStatus(c === 0 ? "Nothing to close" : `Closed ${c} tab${c === 1 ? "" : "s"}`, false);
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

function applyGroupToggleVisual(btn) {
  btn.setAttribute("aria-pressed", GROUP_BY_HOST ? "true" : "false");
  btn.classList.toggle("is-active", GROUP_BY_HOST);
}

let GROUP_BY_HOST = false;

applyTheme();
wireSettings();
wireCloseIdle().catch((err) => console.warn(LOG, "wireCloseIdle failed:", err));
wireGroupToggle().then(() => render()).catch((err) => console.warn(LOG, "render failed:", err));

// Expose for unit-style smoke tests in a non-extension runtime.
export { buildRows, recencyScore, frequencyScore, heatColor, groupRowsByHost };
