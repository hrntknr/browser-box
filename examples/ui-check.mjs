// Mobile-UI regression checks for the viewer at http://localhost:6080/ (live box).
// Coarse-pointer bar layout, pinch zoom, two-finger pan, tap accuracy while
// zoomed, and the on-screen keyboard pipeline are all verified by watching
// the viewer's own WebSocket traffic (VNC wire frames), so nothing depends on
// remote desktop state.
import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const UI = process.env.BOX_UI ?? "http://127.0.0.1:6080/";

// record raw VNC frames sent by a viewer page, and decode them in-page
const installRecorder = page => page.addInitScript(() => {
  window.vncFrames = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    const u8 = data instanceof ArrayBuffer ? new Uint8Array(data)
      : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : null;
    if (u8) window.vncFrames.push(Array.from(u8));
    return send.call(this, data);
  };
  window.vncDecode = type => window.vncFrames.flatMap(f => {
    // KeyEvent: type 4 | QEMU extended: type 255; keysym big-endian at [4..7]
    if (type === "key" && (f[0] === 4 || f[0] === 255))
      return [(f[4] << 24 | f[5] << 16 | f[6] << 8 | f[7]) >>> 0];
    if (type === "pointer" && f[0] === 5)
      return [{ mask: f[1], x: f[2] << 8 | f[3], y: f[4] << 8 | f[5] }];
    return [];
  });
  window.vncClear = () => { window.vncFrames = []; };
});
const resetFrames = page => page.evaluate(() => window.vncClear());
const decoded = (page, type) => page.evaluate(t => window.vncDecode(t), type);

const browser = await chromium.connectOverCDP(process.env.BOX_CDP ?? "http://127.0.0.1:9222");

// ------------------------- mobile (touch, 390x844) -------------------------
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },  // iPhone-ish
  hasTouch: true,
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await installRecorder(page);

async function touch(type, points) {
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
}

// ---- connect ----
await page.goto(UI, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#screen canvas");
await page.waitForFunction(
  () => document.querySelector("#bar").dataset.state === "readonly",
  null, { timeout: 10_000 },
);
const canvas0 = await page.evaluate(() => {
  const c = document.querySelector("#screen canvas");
  const r = c.getBoundingClientRect();
  return { w: r.width, h: r.height, left: r.left, top: r.top };
});

// ---- bar: bottom placement, 44px targets, no idle fade on coarse pointers ----
await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }] });
const bar = await page.evaluate(() => ({
  btnH: document.getElementById("handover").getBoundingClientRect().height,
  fromBottom: innerHeight - document.getElementById("bar").getBoundingClientRect().bottom,
}));
assert.ok(bar.btnH >= 44, `handover tap target ${bar.btnH}px < 44px`);
assert.ok(Math.abs(bar.fromBottom - 14) < 8, `bar ${bar.fromBottom}px from bottom, expected ~14`);

// buttons must neither shrink below content width nor wrap their text
const layout = await page.evaluate(() => {
  const bar = document.getElementById("bar");
  const r = bar.getBoundingClientRect();
  const kids = [...bar.children].map(el => el.getBoundingClientRect());
  return {
    overflowX: +Math.max(0, Math.max(...kids.map(k => k.right)) - r.right).toFixed(1),
    overflowY: +Math.max(0, Math.max(...kids.map(k => k.bottom)) - r.bottom).toFixed(1),
    maxBtnH: Math.max(...[...bar.querySelectorAll("button")].map(b => b.getBoundingClientRect().height)),
  };
});
assert.ok(layout.overflowX < 1 && layout.overflowY < 1,
  `bar contents overflow the pill: ${JSON.stringify(layout)}`);
assert.ok(layout.maxBtnH < 56, `button text wrapped: ${JSON.stringify(layout)}`);
await page.evaluate(() => new Promise(r => setTimeout(r, 3500)));
const idleOpacity = await page.evaluate(() =>
  getComputedStyle(document.getElementById("bar")).opacity);
assert.ok(Number(idleOpacity) > 0.9, `bar faded to ${idleOpacity} on coarse pointer (should stay visible)`);

// ---- pinch zoom (two fingers spreading) grows the canvas ----
await resetFrames(page);   // also proves the pinch is NOT forwarded as remote Ctrl+wheel
const cy = canvas0.top + canvas0.h / 2;
await touch("touchStart", [
  { x: canvas0.left + 160, y: cy }, { x: canvas0.left + 230, y: cy }]);
for (let i = 1; i <= 10; i++) {
  const grow = i * 8;
  await touch("touchMove", [
    { x: canvas0.left + 160 - grow, y: cy }, { x: canvas0.left + 230 + grow, y: cy }]);
}
await touch("touchEnd", []);
const styleWidth = await page.evaluate(() =>
  document.querySelector("#screen canvas").style.width);
assert.ok(parseFloat(styleWidth) > canvas0.w * 2,
  `pinch did not zoom (width ${canvas0.w} -> ${styleWidth})`);
const pinchKeys = await decoded(page, "key");
assert.ok(!pinchKeys.includes(0xffe3),
  `pinch leaked to the remote as Ctrl+wheel: ${JSON.stringify(pinchKeys)}`);

// ---- two-finger drag pans ----
const scroll0 = await page.evaluate(() => {
  const p = document.querySelector("#screen canvas").parentElement;
  return { left: p.scrollLeft, top: p.scrollTop };
});
await touch("touchStart", [{ x: 200, y: 400 }, { x: 290, y: 400 }]);
for (let i = 1; i <= 6; i++) {
  await touch("touchMove", [
    { x: 200 - i * 30, y: 400 }, { x: 290 - i * 30, y: 400 }]);
}
await touch("touchEnd", []);
const scroll1 = await page.evaluate(() => {
  const p = document.querySelector("#screen canvas").parentElement;
  return { left: p.scrollLeft, top: p.scrollTop };
});
assert.ok(scroll1.left > scroll0.left,
  `two-finger drag did not pan (scrollLeft ${scroll0.left} -> ${scroll1.left})`);

// ---- take over (manual mode) so taps are forwarded to the remote ----
await page.click("#handover");

// ---- tap accuracy while zoomed: viewer point -> VNC pointerEvent fb coords ----
await resetFrames(page);
const target = await page.evaluate(() => {
  const c = document.querySelector("#screen canvas");
  const r = c.getBoundingClientRect();
  const px = innerWidth / 2, py = innerHeight / 2;   // guaranteed inside the viewport
  const s = r.width / c.width;
  return { px, py, fbx: Math.round((px - r.left) / s), fby: Math.round((py - r.top) / s) };
});
await page.touchscreen.tap(target.px, target.py);
await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
const pointers = await decoded(page, "pointer");
assert.ok(pointers.some(p => p.mask === 0 &&
  Math.abs(p.x - target.fbx) < 3 && Math.abs(p.y - target.fby) < 3),
  `zoomed tap mapped wrong: ${JSON.stringify(pointers.slice(-4))}, ` +
  `expected fb (${target.fbx}, ${target.fby})`);

// ---- キーボード button: typing reaches the VNC wire ----
await page.click("#soft-keyboard");       // focus hidden input
assert.equal(await page.getAttribute("#soft-keyboard", "data-on"), "true",
  "keyboard button should light up while the input is focused");
await page.keyboard.type("a");
await page.keyboard.press("Enter");
await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
const keysyms = await decoded(page, "key");
assert.ok(keysyms.includes(0x61), `typing 'a' did not reach VNC wire: ${JSON.stringify(keysyms)}`);
assert.ok(keysyms.includes(0xff0d), `Enter did not reach VNC wire: ${JSON.stringify(keysyms)}`);

// ---- 全体 button restores the fitted size ----
await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "fine" }] });
await page.click("#zoom-fit");
const fittedWidth = await page.evaluate(() =>
  document.querySelector("#screen canvas").style.width);
assert.ok(Math.abs(parseFloat(fittedWidth) - canvas0.w) < 2,
  `fit didn't restore ${canvas0.w}px (got ${fittedWidth})`);

await mkdir("artifacts", { recursive: true });
await page.screenshot({ path: "artifacts/ui-mobile.png" });
await context.close();

// ------------------------- desktop (mouse, 1280x800) -------------------------
const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const dpage = await dctx.newPage();
await installRecorder(dpage);
await dpage.goto(UI, { waitUntil: "domcontentloaded" });
await dpage.waitForFunction(
  () => document.querySelector("#bar").dataset.state === "readonly",
  null, { timeout: 10_000 },
);

const dbar = await dpage.evaluate(() => {
  const b = document.getElementById("bar").getBoundingClientRect();
  return { top: b.top };
});
assert.ok(dbar.top < 40, `desktop bar should stay at the top (top=${dbar.top})`);

// hover-driven idle fade must keep working on fine pointers
await dpage.evaluate(() => new Promise(r => setTimeout(r, 3500)));
const didle = await dpage.evaluate(() =>
  document.getElementById("bar").classList.contains("idle") &&
  getComputedStyle(document.getElementById("bar")).opacity);
assert.ok(Number(didle) < 0.3, `desktop bar should fade when idle (opacity=${didle})`);

// canvas-focus typing path (no soft-keyboard button needed on desktop)
await resetFrames(dpage);
await dpage.click("#handover");          // readonly -> manual
await dpage.click("#screen canvas");     // focus the canvas the old way
await dpage.keyboard.type("a");
await dpage.evaluate(() => new Promise(r => setTimeout(r, 300)));
const dkeysyms = await decoded(dpage, "key");
assert.ok(dkeysyms.includes(0x61), `desktop typing did not reach VNC wire: ${JSON.stringify(dkeysyms)}`);

// desktop zoom buttons still work
await dpage.click("#zoom-in");
const dwidth = await dpage.evaluate(() =>
  parseFloat(document.querySelector("#screen canvas").style.width));
assert.ok(dwidth > 1280, `zoom-in did not enlarge (width=${dwidth})`);
await dpage.click("#zoom-fit");   // artifacts below show the fitted view

assert.equal(await dpage.getAttribute("#soft-keyboard", "hidden") !== null, true,
  "soft-keyboard button is pointless with a physical keyboard");

await dpage.screenshot({ path: "artifacts/ui-manual.png" });
// back to readonly, refresh the readonly artifact
await dpage.click("#handover");
await dpage.screenshot({ path: "artifacts/ui-readonly.png" });

await dctx.close();
await browser.close();
console.log("ui-check: all mobile + desktop interaction checks passed");
