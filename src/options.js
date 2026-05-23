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
});

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

function readForm() {
  return {
    idleCloseDays: idle.get(),
    hotThreshold: hot.get() / 100,
    recencyHalfLifeMinutes: half.get(),
  };
}

function writeForm(s) {
  idle.set(s.idleCloseDays);
  hot.set(Math.round((s.hotThreshold ?? DEFAULTS.hotThreshold) * 100));
  half.set(s.recencyHalfLifeMinutes);
}

function markDirty() {
  const cur = readForm();
  const changed =
    cur.idleCloseDays !== initial.idleCloseDays ||
    cur.hotThreshold !== initial.hotThreshold ||
    cur.recencyHalfLifeMinutes !== initial.recencyHalfLifeMinutes;
  setStatus(changed ? "Unsaved changes" : "", changed ? "warn" : "");
}

async function load() {
  const resp = await sendMessage(MSG.GET_SETTINGS);
  const s = (resp && resp.settings) || { ...DEFAULTS };
  initial = {
    idleCloseDays: clamp(s.idleCloseDays, LIMITS.idleCloseDays.min, LIMITS.idleCloseDays.max, DEFAULTS.idleCloseDays),
    hotThreshold: clamp(s.hotThreshold, 0.05, 0.95, DEFAULTS.hotThreshold),
    recencyHalfLifeMinutes: clamp(s.recencyHalfLifeMinutes, LIMITS.recencyHalfLifeMinutes.min, LIMITS.recencyHalfLifeMinutes.max, DEFAULTS.recencyHalfLifeMinutes),
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

load().catch((err) => { console.warn(LOG, "load failed:", err); setStatus("Failed to load settings", "warn"); });

// Exposed for smoke testing in non-extension runtimes.
export { clamp, readForm, writeForm, DEFAULTS, LIMITS };
