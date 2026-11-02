// Mobile-UI regression checks for the viewer at http://localhost:6080/ (live box).
// Coarse-pointer bar layout, the always-on trackpad (relative cursor in both
// read-only and manual modes), pinch zoom, two-finger pan/scroll, and the
// on-screen keyboard pipeline are all verified by watching the viewer's own
// WebSocket traffic (VNC wire frames), so nothing depends on remote desktop
// state.
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

// touch down at `points`, move each by deltas[j] once per step, then release
async function sweep(points, deltas, steps) {
  await touch("touchStart", points);
  for (let i = 1; i <= steps; i++) {
    await touch("touchMove", points.map((p, j) => ({
      x: p.x + deltas[j].x * i, y: p.y + deltas[j].y * i })));
  }
  await touch("touchEnd", []);
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

// noVNC's touch fallback cursor (body > canvas) is the trackpad cursor image
const cursorPos = page => page.evaluate(() => {
  const c = document.querySelector("body > canvas");
  return { x: parseFloat(c.style.left) || 0, y: parseFloat(c.style.top) || 0 };
});

// ---- the trackpad is active already in read-only: a one-finger drag moves
// the relative cursor by the drag delta (not a jump to the finger) and leaks
// nothing to the remote
await resetFrames(page);
const cur0 = await cursorPos(page);
await sweep([{ x: 60, y: 600 }], [{ x: 20, y: 0 }], 5);       // one-finger drag
const cur1 = await cursorPos(page);
assert.ok(Math.abs(cur1.x - cur0.x - 100) < 12 && Math.abs(cur1.y - cur0.y) < 12,
  `read-only touch is not trackpad: cursor ${JSON.stringify(cur0)} -> ` +
  `${JSON.stringify(cur1)} (finger (60,600) -> (160,600))`);
const roPointers = await decoded(page, "pointer");
assert.equal(roPointers.length, 0,
  `read-only touch leaked to the remote: ${JSON.stringify(roPointers)}`);

// ---- pinch zoom (two fingers spreading) grows the canvas ----
await resetFrames(page);   // also proves the pinch is NOT forwarded as remote Ctrl+wheel
const cy = canvas0.top + canvas0.h / 2;
await sweep(
  [{ x: canvas0.left + 160, y: cy }, { x: canvas0.left + 230, y: cy }],
  [{ x: -8, y: 0 }, { x: 8, y: 0 }], 10);
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
await sweep(
  [{ x: 200, y: 400 }, { x: 290, y: 400 }],
  [{ x: -30, y: 0 }, { x: -30, y: 0 }], 6);
const scroll1 = await page.evaluate(() => {
  const p = document.querySelector("#screen canvas").parentElement;
  return { left: p.scrollLeft, top: p.scrollTop };
});
assert.ok(scroll1.left > scroll0.left,
  `two-finger drag did not pan (scrollLeft ${scroll0.left} -> ${scroll1.left})`);

// ---- take over (manual mode) so gestures are forwarded to the remote ----
await page.click("#handover");

// ---- tap: clicks land at the trackpad cursor, not at the finger ----
await resetFrames(page);
const target = await page.evaluate(() => {
  const c = document.querySelector("#screen canvas");
  const cur = document.querySelector("body > canvas");   // fallback cursor
  const r = c.getBoundingClientRect();
  const s = r.width / c.width;
  const fx = (parseFloat(cur.style.left) - r.left) / s;  // cursor in fb coords
  const fy = (parseFloat(cur.style.top) - r.top) / s;
  const px = 300, py = 150;   // deliberately far from the cursor
  return { px, py, fx, fy,
           fbx: (px - r.left) / s, fby: (py - r.top) / s };
});
await page.touchscreen.tap(target.px, target.py);
await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
const pointers = await decoded(page, "pointer");
assert.ok(pointers.some(p => p.mask === 1 &&
  Math.abs(p.x - target.fx) < 3 && Math.abs(p.y - target.fy) < 3),
  `tap did not click at the trackpad cursor: ${JSON.stringify(pointers.slice(-6))}, ` +
  `expected fb (${target.fx.toFixed(0)}, ${target.fy.toFixed(0)})`);
assert.ok(Math.hypot(target.fx - target.fbx, target.fy - target.fby) > 20,
  "finger position and cursor coincide; tap mapping is not pinned");

// ---- two-finger drag scrolls the remote page in manual mode ----
await resetFrames(page);
await sweep(
  [{ x: 200, y: 300 }, { x: 290, y: 300 }],
  [{ x: 0, y: -40 }, { x: 0, y: -40 }], 6);
const wheels = await decoded(page, "pointer");
assert.ok(wheels.filter(p => p.mask === 0x8).length >= 2,
  `two-finger drag did not wheel the remote: ${JSON.stringify(wheels.slice(-8))}`);

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
