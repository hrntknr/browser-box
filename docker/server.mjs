import { execFile } from "node:child_process";
import net from "node:net";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

const WEB_ROOT = "/usr/share/novnc";
const HTTP_HOST = process.env.NOVNC_BIND || "127.0.0.1";
const HTTP_PORT = 6080;
const WS_PORT = 6081;
const CDP_HTTP = "http://127.0.0.1:9223";

const log = (...a) => console.log("[bb-server]", ...a);

let mode = "cursor";

const app = new Hono();

app.get("/bb-pointer", (c) => new Promise((resolve) => {
  // Xvnc sends the cursor shape only after pointer motion in the viewer's own session
  execFile("xdotool", ["getmouselocation"],
    { env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" } },
    (err, stdout) => {
      const m = err ? null : /x:(\d+) y:(\d+)/.exec(stdout);
      resolve(m ? c.json({ x: +m[1], y: +m[2] }) : c.body(null, 502));
    });
}));

app.get("/bb-mode", (c) => c.text(mode + "\n"));

app.post("/bb-mode", async (c) => {
  setMode((await c.req.text()).trim() === "touch" ? "touch" : "cursor");
  return c.body(null, 204);
});

// iOS Safari reuses a cached rfb.js module without revalidating; a stale one must not survive a deploy
const noStore = (_path, c) => c.header("Cache-Control", "no-store");
app.use(serveStatic({ root: WEB_ROOT, onFound: noStore }));

const server = serve(
  { fetch: app.fetch, hostname: HTTP_HOST, port: HTTP_PORT },
  () => log(`http on ${HTTP_HOST}:${HTTP_PORT}, ws proxy -> 127.0.0.1:${WS_PORT}`));


const IDLE_W = 1920, IDLE_H = 1080;
const IDLE_GRACE_MS = 5000;
let viewers = 0;
let idleTimer = 0;

function restoreDesktopSize() {
  if (viewers > 0) return;
  const env = { ...process.env, DISPLAY: process.env.DISPLAY || ":99" };
  const mode = `BB${IDLE_W}x${IDLE_H}`;
  // creating the mode again on later runs just fails and is ignored
  const modeline = ["173.00", "1920", "2048", "2248", "2576",
                    "1080", "1083", "1088", "1120"];
  execFile("xrandr", ["--newmode", mode, ...modeline], { env }, () => {
    execFile("xrandr", ["--addmode", "VNC-0", mode], { env }, () => {
      execFile("xrandr", ["--output", "VNC-0", "--mode", mode], { env },
        err => log(err ? "idle restore failed: " + err.message
                       : `idle restore -> ${IDLE_W}x${IDLE_H}`));
    });
  });
}

function viewerGone() {
  if (viewers > 0) viewers--;
  if (viewers === 0) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(restoreDesktopSize, IDLE_GRACE_MS);
  }
}

server.on("upgrade", (req, socket, head) => {
  viewers++;
  clearTimeout(idleTimer);
  let gone = false;
  const down = () => { if (!gone) { gone = true; viewerGone(); } };
  const up = net.connect(WS_PORT, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => { socket.destroy(); down(); });
  socket.on("error", () => { up.destroy(); down(); });
  up.on("close", down);
  socket.on("close", down);
});


let seq = 0;
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.pending = new Map();
    this.onEvent = null;
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.rej(new Error(m.method + ": " + JSON.stringify(m.error)));
        else p.res(m.result);
      } else if (m.method && this.onEvent) {
        this.onEvent(m.method);
      }
    });
  }
  send(method, params = {}) {
    const id = ++seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error("timeout waiting for " + method));
      }, 10000);
      this.pending.set(id, {
        res: v => { clearTimeout(timer); res(v); },
        rej: e => { clearTimeout(timer); rej(e); },
        method,
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const targets = new Map();

async function applyEmulation(t, on) {
  if (t.applied === on) return;
  // setTouchEmulationEnabled alone does not translate input; setEmitTouchEventsForMouse
  // is what turns the mouse events arriving over VNC into touch events (verified on Chrome 158)
  if (on) {
    await t.cdp.send("Emulation.setTouchEmulationEnabled",
      { enabled: true, maxTouchPoints: 1 });
    await t.cdp.send("Emulation.setEmitTouchEventsForMouse",
      { enabled: true, configuration: "mobile" });
  } else {
    await t.cdp.send("Emulation.setEmitTouchEventsForMouse", { enabled: false });
    await t.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
  t.applied = on;
}

async function applyAll() {
  const on = mode === "touch";
  for (const t of targets.values()) {
    try { await applyEmulation(t, on); }
    catch (e) { log("apply failed:", e.message); }
  }
}

function setMode(next) {
  if (next === mode) return;
  mode = next;
  log("mode ->", mode);
  applyAll().catch(() => {});
}

async function watchTarget(tgt) {
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  const t = { cdp: null, applied: null };
  targets.set(tgt.id, t);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  t.cdp = new CDP(ws);
  // emulation does not reliably survive a navigation; re-apply on each one
  t.cdp.onEvent = method => {
    if (method === "Page.frameNavigated") {
      t.applied = null;
      applyEmulation(t, mode === "touch").catch(() => {});
    }
  };
  ws.addEventListener("close", () => {
    if (targets.get(tgt.id) === t) targets.delete(tgt.id);
  });
  await t.cdp.send("Page.enable");
  await applyEmulation(t, mode === "touch");
}

async function pollTargets() {
  let list;
  try {
    const r = await fetch(CDP_HTTP + "/json/list");
    if (!r.ok) return;
    list = await r.json();
  } catch { return; }
  const pages = list.filter(t => t.type === "page" && t.webSocketDebuggerUrl);
  const seen = new Set(pages.map(t => t.id));
  for (const [id, t] of targets) {
    if (!seen.has(id)) {
      try { t.cdp.ws.close(); } catch {}
      targets.delete(id);
    }
  }
  for (const tgt of pages) {
    if (!targets.has(tgt.id)) {
      try { await watchTarget(tgt); }
      catch (e) { log("watch failed:", e.message); targets.delete(tgt.id); }
    }
  }
}

setInterval(() => { pollTargets().catch(() => {}); }, 1500);
pollTargets().catch(() => {});

process.on("uncaughtException", e => log("uncaught:", e.message));
process.on("unhandledRejection", e => log("unhandled:", String(e)));
