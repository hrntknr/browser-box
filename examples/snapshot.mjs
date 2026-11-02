import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const url = process.argv[2] ?? "https://example.com/";
const browser = await chromium.connectOverCDP(process.env.BOX_CDP ?? "http://127.0.0.1:9222");
const context = await browser.newContext();
const page = await context.newPage();
const resp = await page.goto(url, { timeout: 45_000 });
console.log("status:", resp.status());
console.log("title:", await page.title());
const text = await page.evaluate(() => document.body.innerText);
console.log("body sample:", text.slice(0, 150).replaceAll("\n", " / "));
await mkdir("artifacts", { recursive: true });
const name = new URL(url).hostname.replace(/\W+/g, "-");
await page.screenshot({ path: `artifacts/${name}.png` });
console.log(`screenshot: artifacts/${name}.png`);

await browser.close();
