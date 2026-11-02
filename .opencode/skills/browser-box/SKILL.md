---
name: browser-box
description: Drive the long-running resident Chrome via the browser-box MCP tools, or Playwright scripts over CDP, for browsing, checking pages, screenshots, and logins. Use when the user asks to "open in a browser", "look at a page", "take a screenshot", or "log in".
---

# browser-box

A resident Chrome runs at the `BOX_CDP` endpoint (default `http://127.0.0.1:9222`). If `curl -s http://127.0.0.1:9222/json/version` fails, the box is down; tell the user just that.
http://localhost:6080/ mirrors the Chrome screen read-only; the user gets control after pressing the handover button (操作を引き継ぐ). Point them there to watch or take over.

## MCP first

If `tools["browser-box"]` is connected, use those tools (navigate, snapshot, click, screenshot) instead of scripts. They run on the resident profile, so login state is available. Write a script only for file downloads, raw CDP-session control (clipboard grants, download behavior), or unbounded waits for manual login.

## Scripts

Self-contained scripts, run from a directory where `playwright` resolves from `node_modules`. Put outputs in `artifacts/`.

```js
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP(process.env.BOX_CDP ?? "http://127.0.0.1:9222");
const page = await browser.contexts()[0].newPage();  // resident profile: logins persist
await page.goto("https://example.com/");

await browser.close();  // without disconnecting, the script never exits
```

- For logged-in operations use `browser.contexts()[0]`; a login in an isolated `newContext()` disappears when the script ends
- Resident-profile tabs are not closed automatically; call `page.close()` to clean up

## Login

Automate inside the resident profile. Switch to manual handover only on request or when automation is stuck (CAPTCHA, 2FA, SMS): open the target URL, have the user take over at http://localhost:6080/, and wait with `page.waitForSelector(<logged-in selector>, { timeout: 0 })`.
