---
name: browser-box
description: Drive the long-running resident Chrome via the browser-box MCP tools, or Playwright scripts over CDP, for browsing, checking pages, screenshots, and logins. Use when the user asks to "open in a browser", "look at a page", "take a screenshot", or "log in".
---

# browser-box

A resident Chrome runs at the `BOX_CDP` endpoint (default `http://127.0.0.1:9222`). If `curl -s http://127.0.0.1:9222/json/version` fails, the box is down; tell the user just that.
http://localhost:6080/ mirrors the Chrome screen read-only; the user gets control after pressing the handover button (操作を引き継ぐ). Point them there to watch or take over.

## MCP first

If `tools["browser-box"]` is connected, use those tools (navigate, snapshot, click, screenshot) instead of scripts. They run on the resident profile, so login state is available. Write a script only for file downloads, raw CDP-session control (clipboard grants, download behavior), or unbounded waits for manual login.

## Clean up tabs when done

The resident profile never cleans up tabs for you: `browser_close` and script exits only disconnect, and a later session opens its own tab instead of reusing leftovers. Close every tab you opened before finishing.

- MCP: close each tab you opened with `browser_tabs` `{"action": "close"}` (a fresh session starts one tab with its first navigate; `browser_tabs {"action": "new"}` adds more). `browser_close` closes nothing. `{"action": "list"}` shows stale leftovers from earlier crashed sessions—close those too if they are clearly not the user's.
- Scripts: self-contained, run where `playwright` resolves from `node_modules`, outputs in `artifacts/`. Close in a `finally` so errors and aborts don't leak, and sweep popups too (`window.open` / `target=_blank` tabs survive closing their opener):

```js
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP(process.env.BOX_CDP ?? "http://127.0.0.1:9222");
const context = browser.contexts()[0];   // resident profile: logins persist
const keep = new Set(context.pages());   // tabs that aren't ours
try {
  const page = await context.newPage();
  await page.goto("https://example.com/");
} finally {
  for (const p of context.pages())       // ours + popups, never the user's
    if (!keep.has(p)) await p.close().catch(() => {});
  await browser.close();                 // without this the script never exits
}
```

What leaks when cleanup is skipped (all verified against this box):

- Tabs in `contexts()[0]` on `browser.close()`: the call only disconnects, so every resident-profile tab stays
- Tabs after the MCP session ends (agent stops, opencode restarts, `browser_close`): nothing closes them—the tool's context close lands on the shared default context and is a no-op for tabs
- Tabs from sessions that died mid-task: never reused, just pile up across reboots
- Popups opened by pages you did close
- Only `newContext()` is self-cleaning: Chrome destroys that incognito context on disconnect (its logins go with it)

## Login

Automate inside the resident profile. Switch to manual handover only on request or when automation is stuck (CAPTCHA, 2FA, SMS): open the target URL, have the user take over at http://localhost:6080/, and wait with `page.waitForSelector(<logged-in selector>, { timeout: 0 })`. Once logged in, close the tab—the session lives in the profile, not the tab.
