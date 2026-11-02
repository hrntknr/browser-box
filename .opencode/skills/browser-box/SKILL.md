---
name: browser-box
description: Connect scripts to a long-running resident Chrome for browsing, checking pages, taking screenshots, and logging into sites. Use when the user asks to "open in a browser", "look at a page", "take a screenshot", "log in", and similar requests.
---

# browser-box

A resident Chrome is running; scripts connect to it over CDP. The endpoint is the `BOX_CDP` env var (default `http://127.0.0.1:9222`).
If `curl -s http://127.0.0.1:9222/json/version` does not respond, the box is down. Tell the user just that; do not get involved in how it is started.

## Scripts

Write self-contained scripts. Run them from a directory where playwright resolves from `node_modules` (`npm install playwright` first if there is none). Put outputs in `artifacts/`.

```js
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP(process.env.BOX_CDP ?? "http://127.0.0.1:9222");
const context = await browser.newContext();
const page = await context.newPage();
await page.goto("https://example.com/");
await page.screenshot({ path: "artifacts/shot.png" });

await browser.close();  // without disconnecting, the script never exits
```

- `context.close()` is not needed. Chrome closes the tabs automatically on disconnect or process death (SIGKILL included). Call it per-context only in a script that keeps running and creates contexts in a loop
- For operations that need a logged-in state, use `browser.contexts()[0]` (the resident profile). Its login state lives in the profile and survives disconnects and container restarts
- Isolated contexts cannot use that login state (a login inside an isolated context disappears when that script ends). Resident-profile tabs are not closed automatically; use `page.close()` if you do not want them left open

## Login

Automation is the default. Log in inside the resident profile's context so the state persists in the profile.
Switch to manual handover only when the user explicitly asks, or when automation is stuck (CAPTCHA, 2FA, SMS verification). Then open the target URL, have the user operate the resident Chrome screen, and detect completion with `page.waitForSelector(<selector indicating logged-in state>, { timeout: 0 })`.
