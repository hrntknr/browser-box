import { chromium } from "playwright";

const url = process.argv[2] ?? "https://example.com/";
const browser = await chromium.connectOverCDP(process.env.BOX_CDP ?? "http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.newPage());

try {
  await page.goto(url);
  console.log("-> open http://localhost:6080/, press 操作を引き継ぐ, and log in manually");

  await page.waitForSelector("body", { timeout: 0 });

  console.log("login detected - session persisted in resident profile");
} finally {
  // the login lives in the profile, not the tab - don't leave it open
  await page.close().catch(() => {});
  await browser.close();
}

