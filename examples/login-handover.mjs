import { chromium } from "playwright";

const url = process.argv[2] ?? "https://example.com/";
const browser = await chromium.connectOverCDP(process.env.BOX_CDP ?? "http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(url);
console.log("-> open http://localhost:6080/ and log in manually");

await page.waitForSelector("body", { timeout: 0 });

console.log("login detected - session persisted in resident profile");

await browser.close();
