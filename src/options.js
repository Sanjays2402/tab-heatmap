// Tab Heatmap — options page.
// Persists user-configurable thresholds via the background service worker.

const LOG = "[tab-heatmap:options]";

const MSG = Object.freeze({
  GET_SETTINGS: "th:getSettings",
  SET_SETTINGS: "th:setSettings",
  RESET_HEAT_DATA: "th:resetHeatData",
});

const DEFAULTS = Object.freeze({
  idleCloseDays: 7,
  hotThreshold: 0.5,
  recencyHalfLifeMinutes: 30,
  domainHalfLifeMinutes: {},
  coldWhitelist: [],
  theme: "auto",
  dailySummaryEnabled: true,
  dailySummaryHour: 9,
  autoSuspendEnabled: false,
  autoSuspendHours: 24,
  accentColor: "#ff7a3d",
});

const VALID_THEMES = new Set(["auto", "light", "dark"]);

const DEFAULT_ACCENT = "#ff7a3d";

/** Normalize an accent input → canonical lowercase 6-digit hex, or "" on miss. */
function sanitizeHex(input) {
  if (typeof input !== "string") return "";
  const s = input.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  return "";
}

/** Apply the chosen accent to the document (CSS vars), live-preview style. */
function applyAccent(hex) {
  const c = sanitizeHex(hex) || DEFAULT_ACCENT;
  try {
    document.documentElement.style.setProperty("--accent", c);
    // Derive a soft variant (~18% alpha) from the rgb.
    const r = parseInt(c.slice(1, 3), 16);
    const g = parseInt(c.slice(3, 5), 16);
    const b = parseInt(c.slice(5, 7), 16);
    document.documentElement.style.setProperty("--accent-soft", `rgba(${r}, ${g}, ${b}, 0.18)`);
  } catch { /* noop */ }
}

const LIMITS = Object.freeze({
  idleCloseDays: { min: 1, max: 365 },
  hotThresholdPct: { min: 5, max: 95 },
  recencyHalfLifeMinutes: { min: 1, max: 1440 },
});

/** Promise wrapper around chrome.runtime.sendMessage with a safe fallback. */
function sendMessage(type, payload) {
  return new Promise((resolve) => {
    try {
      const msg = Object.assign({ type }, payload && typeof payload === "object" ? payload : {});
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          console.warn(LOG, "sendMessage error:", chrome.runtime.lastError.message);
          resolve({ ok: false });
          return;
        }
        resolve(resp || { ok: false });
      });
    } catch (err) {
      console.warn(LOG, "sendMessage threw:", err);
      resolve({ ok: false });
    }
  });
}

/** Clamp a number to [min, max]; falls back to default if NaN. */
function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** Bind a slider+number pair so they stay in lockstep. */
function bindPair(sliderId, numberId, { min, max, onChange }) {
  const slider = document.getElementById(sliderId);
  const num = document.getElementById(numberId);
  if (!slider || !num) return { set: () => {}, get: () => 0 };

  const setBoth = (v) => {
    const c = clamp(v, min, max, min);
    slider.value = String(Math.min(Number(slider.max), Math.max(Number(slider.min), c)));
    num.value = String(c);
  };

  slider.addEventListener("input", () => { num.value = slider.value; onChange?.(); });
  num.addEventListener("input", () => {
    // Don't clamp while typing; clamp on blur to avoid yanking the value mid-type.
    onChange?.();
  });
  num.addEventListener("blur", () => { setBoth(num.value); onChange?.(); });

  return {
    set: setBoth,
    get: () => clamp(num.value, min, max, min),
  };
}

const els = {
  status: document.getElementById("status"),
  save: document.getElementById("save-btn"),
  reset: document.getElementById("reset-btn"),
};

let initial = { ...DEFAULTS };

function setStatus(text, tone) {
  if (!els.status) return;
  els.status.textContent = text || "";
  els.status.classList.toggle("is-ok", tone === "ok");
  els.status.classList.toggle("is-warn", tone === "warn");
}

const idle = bindPair("idle-slider", "idle-input", {
  min: LIMITS.idleCloseDays.min,
  max: LIMITS.idleCloseDays.max,
  onChange: () => markDirty(),
});
const hot = bindPair("hot-slider", "hot-input", {
  min: LIMITS.hotThresholdPct.min,
  max: LIMITS.hotThresholdPct.max,
  onChange: () => markDirty(),
});
const half = bindPair("half-slider", "half-input", {
  min: LIMITS.recencyHalfLifeMinutes.min,
  max: LIMITS.recencyHalfLifeMinutes.max,
  onChange: () => markDirty(),
});

/** Normalize hostname for the per-domain map (lowercase, strip www.). */
function normalizeHost(h) {
  if (typeof h !== "string") return "";
  return h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
}

/** Validate that a string looks like a usable host. */
function isValidHost(h) {
  return /^[a-z0-9.-]+\.[a-z]{2,}$|^localhost$/.test(h);
}

/** In-memory edit copy of the per-domain map; persisted on save. */
let domainMap = {};

/** In-memory edit copy of the cold-close whitelist; persisted on save. */
let whitelist = [];

/** Sanitize + sort the whitelist before render/save. */
function sanitizeWhitelist(arr) {
  const seen = new Set();
  const src = Array.isArray(arr) ? arr : [];
  for (const v of src) {
    const host = normalizeHost(v);
    if (host && isValidHost(host)) seen.add(host);
  }
  return [...seen].sort();
}

function renderWhitelist() {
  const list = document.getElementById("whitelist-list");
  if (!list) return;
  list.innerHTML = "";
  if (whitelist.length === 0) {
    const li = document.createElement("li");
    li.className = "domain-empty";
    li.textContent = "No protected hosts. Every domain is fair game for cold-close.";
    list.appendChild(li);
    return;
  }
  for (const host of whitelist) {
    const li = document.createElement("li");
    li.className = "domain-row whitelist-row";
    li.innerHTML =
      '<span class="domain-host"></span>' +
      '<span class="whitelist-badge" aria-hidden="true">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z"/>' +
          '<path d="M9 12l2 2 4-4"/>' +
        '</svg>' +
        '<span>protected</span>' +
      '</span>' +
      '<button type="button" class="btn btn-ghost domain-remove" aria-label="Remove from whitelist">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M6 6l12 12M18 6L6 18"/>' +
        '</svg>' +
      '</button>';
    li.querySelector(".domain-host").textContent = host;
    li.querySelector(".domain-remove").addEventListener("click", () => {
      whitelist = whitelist.filter((h) => h !== host);
      renderWhitelist();
      markDirty();
    });
    list.appendChild(li);
  }
}

function wireWhitelistAdd() {
  const hostEl = document.getElementById("whitelist-host");
  const addBtn = document.getElementById("whitelist-add-btn");
  if (!hostEl || !addBtn) return;
  const add = () => {
    const host = normalizeHost(hostEl.value);
    if (!host || !isValidHost(host)) {
      setStatus("Enter a valid host (e.g. github.com)", "warn");
      hostEl.focus();
      return;
    }
    if (!whitelist.includes(host)) {
      whitelist = sanitizeWhitelist([...whitelist, host]);
      renderWhitelist();
      markDirty();
    }
    hostEl.value = "";
  };
  addBtn.addEventListener("click", add);
  hostEl.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); add(); } });
}

/** Current theme preference in the form ("auto"|"light"|"dark"). */
let themePref = "auto";
let accentColor = DEFAULT_ACCENT;
let THEME_MEDIA = null;
let THEME_LISTENER = null;

/** Apply the chosen theme to <body> and bind a media listener for auto. */
function applyTheme(pref) {
  const p = VALID_THEMES.has(pref) ? pref : "auto";
  if (THEME_MEDIA && THEME_LISTENER) {
    try { THEME_MEDIA.removeEventListener("change", THEME_LISTENER); } catch { /* noop */ }
    THEME_LISTENER = null;
  }
  try {
    if (p === "auto") {
      // Let the @media (prefers-color-scheme) rule drive things by clearing the attr.
      // We still observe changes so other auto-tied UI (e.g. ambient blobs) can respond.
      delete document.body.dataset.theme;
      THEME_MEDIA = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
      if (THEME_MEDIA && typeof THEME_MEDIA.addEventListener === "function") {
        THEME_LISTENER = () => { /* attribute already absent; CSS handles it */ };
        THEME_MEDIA.addEventListener("change", THEME_LISTENER);
      }
    } else {
      document.body.dataset.theme = p;
    }
  } catch {
    document.body.dataset.theme = p === "light" ? "light" : "dark";
  }
}

function renderThemeSeg() {
  const seg = document.getElementById("theme-seg");
  if (!seg) return;
  for (const btn of seg.querySelectorAll(".seg-btn")) {
    const on = btn.dataset.theme === themePref;
    btn.setAttribute("aria-checked", on ? "true" : "false");
  }
}

function wireThemeSeg() {
  const seg = document.getElementById("theme-seg");
  if (!seg) return;
  seg.addEventListener("click", (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest(".seg-btn") : null;
    if (!btn) return;
    const next = btn.dataset.theme;
    if (!VALID_THEMES.has(next) || next === themePref) return;
    themePref = next;
    applyTheme(themePref);
    renderThemeSeg();
    markDirty();
  });
  seg.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    const order = ["auto", "light", "dark"];
    const i = order.indexOf(themePref);
    if (i < 0) return;
    ev.preventDefault();
    const ni = ev.key === "ArrowLeft" ? (i + order.length - 1) % order.length : (i + 1) % order.length;
    themePref = order[ni];
    applyTheme(themePref);
    renderThemeSeg();
    const focusBtn = seg.querySelector(`.seg-btn[data-theme="${themePref}"]`);
    if (focusBtn) focusBtn.focus();
    markDirty();
  });
}

function renderDomainList() {
  const list = document.getElementById("domain-list");
  if (!list) return;
  list.innerHTML = "";
  const entries = Object.entries(domainMap).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.className = "domain-empty";
    li.textContent = "No overrides yet. Defaults apply to every host.";
    list.appendChild(li);
    return;
  }
  for (const [host, mins] of entries) {
    const li = document.createElement("li");
    li.className = "domain-row";
    li.innerHTML =
      '<span class="domain-host"></span>' +
      '<input class="domain-mins-input" type="number" min="1" max="1440" step="1" inputmode="numeric">' +
      '<span class="unit">min</span>' +
      '<button type="button" class="btn btn-ghost domain-remove" aria-label="Remove override">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M6 6l12 12M18 6L6 18"/>' +
        '</svg>' +
      '</button>';
    li.querySelector(".domain-host").textContent = host;
    const input = li.querySelector(".domain-mins-input");
    input.value = String(mins);
    input.addEventListener("input", () => {
      const n = clamp(input.value, 1, 1440, mins);
      domainMap[host] = n;
      markDirty();
    });
    li.querySelector(".domain-remove").addEventListener("click", () => {
      delete domainMap[host];
      renderDomainList();
      markDirty();
    });
    list.appendChild(li);
  }
}

function wireDomainAdd() {
  const hostEl = document.getElementById("domain-host");
  const minsEl = document.getElementById("domain-mins");
  const addBtn = document.getElementById("domain-add-btn");
  if (!hostEl || !minsEl || !addBtn) return;
  const add = () => {
    const host = normalizeHost(hostEl.value);
    if (!host || !isValidHost(host)) {
      setStatus("Enter a valid host (e.g. github.com)", "warn");
      hostEl.focus();
      return;
    }
    const mins = clamp(minsEl.value, 1, 1440, 30);
    domainMap[host] = mins;
    hostEl.value = "";
    minsEl.value = "60";
    renderDomainList();
    markDirty();
  };
  addBtn.addEventListener("click", add);
  hostEl.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); add(); } });
  minsEl.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); add(); } });
}

function renderAccentSwatches() {
  const root = document.getElementById("accent-swatches");
  if (root) {
    for (const btn of root.querySelectorAll(".swatch")) {
      const on = sanitizeHex(btn.dataset.accent) === accentColor;
      btn.setAttribute("aria-checked", on ? "true" : "false");
    }
  }
  const picker = document.getElementById("accent-picker");
  const input = document.getElementById("accent-input");
  if (picker) picker.value = accentColor;
  if (input && document.activeElement !== input) input.value = accentColor;
}

function wireAccentPicker() {
  const swatches = document.getElementById("accent-swatches");
  const picker = document.getElementById("accent-picker");
  const input = document.getElementById("accent-input");
  const reset = document.getElementById("accent-reset");
  if (swatches) {
    swatches.addEventListener("click", (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest(".swatch") : null;
      if (!btn) return;
      const next = sanitizeHex(btn.dataset.accent);
      if (!next || next === accentColor) return;
      accentColor = next;
      applyAccent(accentColor);
      renderAccentSwatches();
      markDirty();
    });
  }
  if (picker) {
    picker.addEventListener("input", () => {
      const next = sanitizeHex(picker.value);
      if (!next) return;
      accentColor = next;
      applyAccent(accentColor);
      renderAccentSwatches();
      markDirty();
    });
  }
  if (input) {
    const commit = () => {
      const next = sanitizeHex(input.value);
      if (!next) { input.value = accentColor; setStatus("Enter a hex like #ff7a3d", "warn"); return; }
      if (next === accentColor) { input.value = accentColor; return; }
      accentColor = next;
      applyAccent(accentColor);
      renderAccentSwatches();
      markDirty();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); commit(); } });
  }
  if (reset) {
    reset.addEventListener("click", () => {
      if (accentColor === DEFAULT_ACCENT) return;
      accentColor = DEFAULT_ACCENT;
      applyAccent(accentColor);
      renderAccentSwatches();
      markDirty();
    });
  }
}

function readForm() {
  const dailyEl = document.getElementById("daily-enabled");
  const hourEl = document.getElementById("daily-hour");
  const autoEl = document.getElementById("autosuspend-enabled");
  const autoHoursEl = document.getElementById("autosuspend-hours");
  return {
    idleCloseDays: idle.get(),
    hotThreshold: hot.get() / 100,
    recencyHalfLifeMinutes: half.get(),
    domainHalfLifeMinutes: { ...domainMap },
    coldWhitelist: sanitizeWhitelist(whitelist),
    theme: VALID_THEMES.has(themePref) ? themePref : "auto",
    dailySummaryEnabled: dailyEl ? !!dailyEl.checked : DEFAULTS.dailySummaryEnabled,
    dailySummaryHour: clamp(hourEl?.value, 0, 23, DEFAULTS.dailySummaryHour),
    autoSuspendEnabled: autoEl ? !!autoEl.checked : DEFAULTS.autoSuspendEnabled,
    autoSuspendHours: clamp(autoHoursEl?.value, 1, 720, DEFAULTS.autoSuspendHours),
    accentColor: sanitizeHex(accentColor) || DEFAULT_ACCENT,
  };
}

function writeForm(s) {
  idle.set(s.idleCloseDays);
  hot.set(Math.round((s.hotThreshold ?? DEFAULTS.hotThreshold) * 100));
  half.set(s.recencyHalfLifeMinutes);
  domainMap = (s.domainHalfLifeMinutes && typeof s.domainHalfLifeMinutes === "object")
    ? { ...s.domainHalfLifeMinutes }
    : {};
  whitelist = sanitizeWhitelist(s.coldWhitelist);
  themePref = VALID_THEMES.has(s.theme) ? s.theme : "auto";
  const dailyEl = document.getElementById("daily-enabled");
  const hourEl = document.getElementById("daily-hour");
  if (dailyEl) dailyEl.checked = s.dailySummaryEnabled !== false;
  if (hourEl) hourEl.value = String(clamp(s.dailySummaryHour, 0, 23, DEFAULTS.dailySummaryHour));
  const autoEl = document.getElementById("autosuspend-enabled");
  const autoHoursEl = document.getElementById("autosuspend-hours");
  if (autoEl) autoEl.checked = s.autoSuspendEnabled === true;
  if (autoHoursEl) autoHoursEl.value = String(clamp(s.autoSuspendHours, 1, 720, DEFAULTS.autoSuspendHours));
  accentColor = sanitizeHex(s.accentColor) || DEFAULT_ACCENT;
  applyAccent(accentColor);
  renderAccentSwatches();
  applyTheme(themePref);
  renderThemeSeg();
  renderDomainList();
  renderWhitelist();
}

function markDirty() {
  const cur = readForm();
  const sameDomain = JSON.stringify(cur.domainHalfLifeMinutes) === JSON.stringify(initial.domainHalfLifeMinutes || {});
  const sameWhitelist = JSON.stringify(cur.coldWhitelist) === JSON.stringify(sanitizeWhitelist(initial.coldWhitelist));
  const changed =
    cur.idleCloseDays !== initial.idleCloseDays ||
    cur.hotThreshold !== initial.hotThreshold ||
    cur.recencyHalfLifeMinutes !== initial.recencyHalfLifeMinutes ||
    cur.theme !== (initial.theme || "auto") ||
    cur.dailySummaryEnabled !== (initial.dailySummaryEnabled !== false) ||
    cur.dailySummaryHour !== (initial.dailySummaryHour ?? DEFAULTS.dailySummaryHour) ||
    cur.autoSuspendEnabled !== (initial.autoSuspendEnabled === true) ||
    cur.autoSuspendHours !== (initial.autoSuspendHours ?? DEFAULTS.autoSuspendHours) ||
    cur.accentColor !== (sanitizeHex(initial.accentColor) || DEFAULT_ACCENT) ||
    !sameDomain ||
    !sameWhitelist;
  setStatus(changed ? "Unsaved changes" : "", changed ? "warn" : "");
}

async function load() {
  const resp = await sendMessage(MSG.GET_SETTINGS);
  const s = (resp && resp.settings) || { ...DEFAULTS };
  initial = {
    idleCloseDays: clamp(s.idleCloseDays, LIMITS.idleCloseDays.min, LIMITS.idleCloseDays.max, DEFAULTS.idleCloseDays),
    hotThreshold: clamp(s.hotThreshold, 0.05, 0.95, DEFAULTS.hotThreshold),
    recencyHalfLifeMinutes: clamp(s.recencyHalfLifeMinutes, LIMITS.recencyHalfLifeMinutes.min, LIMITS.recencyHalfLifeMinutes.max, DEFAULTS.recencyHalfLifeMinutes),
    domainHalfLifeMinutes: (s.domainHalfLifeMinutes && typeof s.domainHalfLifeMinutes === "object") ? { ...s.domainHalfLifeMinutes } : {},
    coldWhitelist: sanitizeWhitelist(s.coldWhitelist),
    theme: VALID_THEMES.has(s.theme) ? s.theme : DEFAULTS.theme,
    dailySummaryEnabled: s.dailySummaryEnabled !== false,
    dailySummaryHour: clamp(s.dailySummaryHour, 0, 23, DEFAULTS.dailySummaryHour),
    autoSuspendEnabled: s.autoSuspendEnabled === true,
    autoSuspendHours: clamp(s.autoSuspendHours, 1, 720, DEFAULTS.autoSuspendHours),
    accentColor: sanitizeHex(s.accentColor) || DEFAULT_ACCENT,
  };
  writeForm(initial);
  setStatus("", "");
}

async function save() {
  const patch = readForm();
  els.save?.setAttribute("disabled", "true");
  setStatus("Saving…", "");
  const resp = await sendMessage(MSG.SET_SETTINGS, { patch });
  els.save?.removeAttribute("disabled");
  if (resp && resp.ok && resp.settings) {
    initial = {
      idleCloseDays: resp.settings.idleCloseDays,
      hotThreshold: resp.settings.hotThreshold,
      recencyHalfLifeMinutes: resp.settings.recencyHalfLifeMinutes,
      domainHalfLifeMinutes: { ...(resp.settings.domainHalfLifeMinutes || {}) },
      coldWhitelist: sanitizeWhitelist(resp.settings.coldWhitelist),
      theme: VALID_THEMES.has(resp.settings.theme) ? resp.settings.theme : DEFAULTS.theme,
      dailySummaryEnabled: resp.settings.dailySummaryEnabled !== false,
      dailySummaryHour: clamp(resp.settings.dailySummaryHour, 0, 23, DEFAULTS.dailySummaryHour),
      autoSuspendEnabled: resp.settings.autoSuspendEnabled === true,
      autoSuspendHours: clamp(resp.settings.autoSuspendHours, 1, 720, DEFAULTS.autoSuspendHours),
      accentColor: sanitizeHex(resp.settings.accentColor) || DEFAULT_ACCENT,
    };
    writeForm(initial);
    setStatus("Saved", "ok");
    setTimeout(() => setStatus("", ""), 1600);
  } else {
    setStatus("Save failed", "warn");
  }
}

function resetDefaults() {
  writeForm(DEFAULTS);
  markDirty();
}

/** Two-step confirm flow for wiping all tracked heat data. */
function wireResetHeatData() {
  const btn = document.getElementById("reset-data-btn");
  const confirm = document.getElementById("reset-data-confirm");
  const cancel = document.getElementById("reset-data-cancel");
  const yes = document.getElementById("reset-data-yes");
  const status = document.getElementById("reset-data-status");
  if (!btn || !confirm || !cancel || !yes) return;

  const setLocalStatus = (text, tone) => {
    if (!status) return;
    status.textContent = text || "";
    status.classList.toggle("is-ok", tone === "ok");
    status.classList.toggle("is-warn", tone === "warn");
  };

  const hide = () => {
    confirm.hidden = true;
    btn.removeAttribute("disabled");
  };

  btn.addEventListener("click", () => {
    confirm.hidden = false;
    btn.setAttribute("disabled", "true");
    setLocalStatus("", "");
    // Focus the safer option by default so accidental Enter cancels.
    cancel.focus();
  });
  cancel.addEventListener("click", () => {
    hide();
    btn.focus();
  });
  yes.addEventListener("click", async () => {
    yes.setAttribute("disabled", "true");
    cancel.setAttribute("disabled", "true");
    setLocalStatus("Wiping…", "");
    const resp = await sendMessage(MSG.RESET_HEAT_DATA);
    yes.removeAttribute("disabled");
    cancel.removeAttribute("disabled");
    if (resp && resp.ok) {
      hide();
      setLocalStatus("Heat data wiped. Tabs reseeded from now.", "ok");
      setTimeout(() => setLocalStatus("", ""), 2400);
    } else {
      setLocalStatus("Reset failed", "warn");
    }
  });
  confirm.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { ev.preventDefault(); hide(); btn.focus(); }
  });
}

els.save?.addEventListener("click", () => { save().catch((err) => { console.warn(LOG, err); setStatus("Save failed", "warn"); }); });
els.reset?.addEventListener("click", resetDefaults);
wireDomainAdd();
wireWhitelistAdd();
wireThemeSeg();
wireAccentPicker();
wireResetHeatData();
document.getElementById("daily-enabled")?.addEventListener("change", markDirty);
document.getElementById("daily-hour")?.addEventListener("input", markDirty);
document.getElementById("daily-hour")?.addEventListener("blur", (ev) => {
  const el = ev.target;
  if (!(el instanceof HTMLInputElement)) return;
  el.value = String(clamp(el.value, 0, 23, DEFAULTS.dailySummaryHour));
  markDirty();
});
document.getElementById("autosuspend-enabled")?.addEventListener("change", markDirty);
document.getElementById("autosuspend-hours")?.addEventListener("input", markDirty);
document.getElementById("autosuspend-hours")?.addEventListener("blur", (ev) => {
  const el = ev.target;
  if (!(el instanceof HTMLInputElement)) return;
  el.value = String(clamp(el.value, 1, 720, DEFAULTS.autoSuspendHours));
  markDirty();
});

load().catch((err) => { console.warn(LOG, "load failed:", err); setStatus("Failed to load settings", "warn"); });

// Exposed for smoke testing in non-extension runtimes.
export { clamp, readForm, writeForm, DEFAULTS, LIMITS, normalizeHost, isValidHost, VALID_THEMES, sanitizeWhitelist, sanitizeHex, applyAccent, DEFAULT_ACCENT };
