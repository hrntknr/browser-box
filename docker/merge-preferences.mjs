import fs from "node:fs";

const path = "/data/profile/Default/Preferences";
let prefs = {};
try {
  prefs = JSON.parse(fs.readFileSync(path, "utf8"));
} catch {}
if (!prefs.browser) prefs.browser = {};
prefs.browser.custom_chrome_frame = false;
fs.mkdirSync("/data/profile/Default", { recursive: true });
fs.writeFileSync(path, JSON.stringify(prefs));
