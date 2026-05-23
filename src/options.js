// Tab Heatmap — options page.
// Persists user-configurable thresholds via the background service worker.

const LOG = "[tab-heatmap:options]";

const MSG = Object.freeze({
  GET_SETTINGS: "th:getSettings",
  SET_SETTINGS: "th:setSettings",
});

const DEFAULTS = Object.freeze({
  idleCloseDays: 7,
  hotThreshold: 0.5,
  recencyHalfLifeMinutes: 30,
  domainHalfLifeMinutes: {},
  theme: "auto",
});

const VALID_THEMES = new Set(["auto", "light", "dark"]);

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

/** Current theme preference in the form ("auto"|"light"|"dark"). */
let themePref = "auto";
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

function readForm() {
  return {
    idleCloseDays: idle.get(),
    hotThreshold: hot.get() / 100,
    recencyHalfLifeMinutes: half.get(),
    domainHalfLifeMinutes: { ...domainMap },
    theme: VALID_THEMES.has(themePref) ? themePref : "auto",
  };
}

function writeForm(s) {
  idle.set(s.idleCloseDays);
  hot.set(Math.round((s.hotThreshold ?? DEFAULTS.hotThreshold) * 100));
  half.set(s.recencyHalfLifeMinutes);
  domainMap = (s.domainHalfLifeMinutes && typeof s.domainHalfLifeMinutes === "object")
    ? { ...s.domainHalfLifeMinutes }
    : {};
  themePref = VALID_THEMES.has(s.theme) ? s.theme : "auto";
  applyTheme(themePref);
  renderThemeSeg();
  renderDomainList();
}

function markDirty() {
  const cur = readForm();
  const sameDomain = JSON.stringify(cur.domainHalfLifeMinutes) === JSON.stringify(initial.domainHalfLifeMinutes || {});
  const changed =
    cur.idleCloseDays !== initial.idleCloseDays ||
    cur.hotThreshold !== initial.hotThreshold ||
    cur.recencyHalfLifeMinutes !== initial.recencyHalfLifeMinutes ||
    cur.theme !== (initial.theme || "auto") ||
    !sameDomain;
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
    theme: VALID_THEMES.has(s.theme) ? s.theme : DEFAULTS.theme,
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
      theme: VALID_THEMES.has(resp.settings.theme) ? resp.settings.theme : DEFAULTS.theme,
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

els.save?.addEventListener("click", () => { save().catch((err) => { console.warn(LOG, err); setStatus("Save failed", "warn"); }); });
els.reset?.addEventListener("click", resetDefaults);
wireDomainAdd();
wireThemeSeg();

load().catch((err) => { console.warn(LOG, "load failed:", err); setStatus("Failed to load settings", "warn"); });

// Exposed for smoke testing in non-extension runtimes.
export { clamp, readForm, writeForm, DEFAULTS, LIMITS, normalizeHost, isValidHost, VALID_THEMES };
