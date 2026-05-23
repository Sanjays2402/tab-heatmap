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

