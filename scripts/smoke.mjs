// Smoke test: validates manifest.json shape and required files exist.
import fs from "node:fs";
const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const must = ["manifest_version","name","version","description"];
for (const k of must) if (!m[k]) { console.error("missing manifest key:", k); process.exit(1); }
if (m.manifest_version !== 3) { console.error("manifest_version must be 3"); process.exit(1); }
for (const p of ["src/popup.html","src/popup.js","src/popup.css","src/background.js","src/options.html","src/options.js","src/options.css"])
  if (!fs.existsSync(p)) { console.error("missing file:", p); process.exit(1); }
for (const sz of [16,32,48,128]) if (!fs.existsSync(`icons/icon-${sz}.png`)) { console.error("missing icon:", sz); process.exit(1); }
console.log("\u2713 smoke ok");

if (!m.options_ui || m.options_ui.page !== "src/options.html") {
  console.error("manifest.options_ui.page must point to src/options.html");
  process.exit(1);
}

// Keyboard shortcut: jump-to-hottest must be declared and wired in the SW.
if (!m.commands || !m.commands["jump-to-hottest"]) {
  console.error("manifest.commands['jump-to-hottest'] missing");
  process.exit(1);
}
const sk = m.commands["jump-to-hottest"].suggested_key;
if (!sk || !sk.default) {
  console.error("jump-to-hottest must define suggested_key.default");
  process.exit(1);
}
const bg = fs.readFileSync("src/background.js", "utf8");
if (!/chrome\.commands\.onCommand/.test(bg) || !/jump-to-hottest/.test(bg)) {
  console.error("background.js must handle the jump-to-hottest command");
  process.exit(1);
}
if (!/jumpToHottestTab/.test(bg)) {
  console.error("background.js must define jumpToHottestTab");
  process.exit(1);
}

// Pinned tabs must always be excluded from cold-close. The reaper must check
// `pinned` both in the scan predicate and in a race-safe re-verify pass.
if (!/isColdCloseCandidate/.test(bg)) {
  console.error("background.js must define isColdCloseCandidate predicate");
  process.exit(1);
}
const pinnedChecks = (bg.match(/\.pinned\b/g) || []).length;
if (pinnedChecks < 2) {
  console.error("background.js must guard pinned tabs in at least two places (scan + verify)");
  process.exit(1);
}
if (!/chrome\.tabs\.get\(/.test(bg)) {
  console.error("background.js must re-verify candidates with chrome.tabs.get before removal");
  process.exit(1);
}

// Suspend cold tabs (discard) feature: SW must expose a suspendIdleTabs path
// that uses chrome.tabs.discard, and the popup must wire a button for it.
if (!/suspendIdleTabs/.test(bg)) {
  console.error("background.js must define suspendIdleTabs");
  process.exit(1);
}
if (!/chrome\.tabs\.discard/.test(bg)) {
  console.error("background.js must call chrome.tabs.discard for the suspend path");
  process.exit(1);
}
if (!/th:suspendIdle/.test(bg)) {
  console.error("background.js must handle the th:suspendIdle message");
  process.exit(1);
}
const popupHtml = fs.readFileSync("src/popup.html", "utf8");
if (!/id="suspend-idle-btn"/.test(popupHtml)) {
  console.error("popup.html must include the #suspend-idle-btn action");
  process.exit(1);
}
const popupJs = fs.readFileSync("src/popup.js", "utf8");
if (!/wireSuspendIdle/.test(popupJs) || !/th:suspendIdle/.test(popupJs)) {
  console.error("popup.js must wire the suspend-idle action");
  process.exit(1);
}

// Tab age column: SW must track first-opened, popup must surface it.
if (!/th:firstOpened\b/.test(bg) || !/recordFirstOpened/.test(bg)) {
  console.error("background.js must track first-opened timestamps per tab");
  process.exit(1);
}
if (!/th:getFirstOpened/.test(bg) || !/th:getFirstOpened/.test(popupJs)) {
  console.error("first-opened map must be exposed to the popup");
  process.exit(1);
}
if (!/tab-age/.test(popupJs)) {
  console.error("popup.js must render the tab-age column");
  process.exit(1);
}
const popupCss = fs.readFileSync("src/popup.css", "utf8");
if (!/\.tab-age\b/.test(popupCss)) {
  console.error("popup.css must style .tab-age");
  process.exit(1);
}

