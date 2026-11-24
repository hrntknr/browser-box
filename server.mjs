// browser-box front server: serves the noVNC web root, proxies the VNC
// websocket to websockify, and takes the viewer's input-mode reports.
//
// The viewer page reports "touch" while a phone-sized touch viewer is
// operating (and "cursor" otherwise). In touch mode this process puts the
// box's Chrome into CDP touch emulation, so the mouse events that arrive
// over VNC are delivered to pages as touch input and a one-finger drag
// touch-scrolls, like on a real phone. In cursor mode emulation is off
// and Chrome is a plain mouse browser.
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const WEB_ROOT = "/usr/share/novnc";
const HTTP_HOST = process.env.NOVNC_BIND || "127.0.0.1";
const HTTP_PORT = 6080;
const WS_PORT = 6081;                 // websockify, localhost only
const CDP_HTTP = "http://127.0.0.1:9223";

const log = (...a) => console.log("[bb-server]", ...a);

// ---------------------------------------------------------------- HTTP ---

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

let mode = "cursor";                  // last mode reported by the viewer

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/bb-mode") {
    if (req.method === "POST") {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => {
        setMode(body.trim() === "touch" ? "touch" : "cursor");
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" }).end(mode + "\n");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.join(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end("not found"); return; }
    const type = MIME[path.extname(file)] || "application/octet-stream";
    const headers = { "Content-Type": type, "Content-Length": st.size };
    if (type.startsWith("text/") || type === "application/json")
      headers["Cache-Control"] = "no-cache";
    res.writeHead(200, headers);
    if (req.method === "HEAD") { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
});

// The VNC stream itself is tunnelled byte-for-byte to websockify.
server.on("upgrade", (req, socket, head) => {
  const up = net.connect(WS_PORT, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(HTTP_PORT, HTTP_HOST, () =>
  log(`http on ${HTTP_HOST}:${HTTP_PORT}, ws proxy -> 127.0.0.1:${WS_PORT}`));

// ------------------------------------------------------- touch emulation ---

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

const targets = new Map();            // targetId -> { cdp, applied }

async function applyEmulation(t, on) {
  if (t.applied === on) return;
  // setTouchEmulationEnabled alone only changes what the page reports
  // (maxTouchPoints, pointer media); it does not translate input.
  // setEmitTouchEventsForMouse is what turns the mouse events arriving
  // over VNC into touch events in the page — a drag then touch-scrolls.
  // Verified against Chrome 158: the former alone leaves a drag as mouse
  // events with no scrolling, the latter produces touchstart/move/end
  // and scrolls.
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
  } catch { return; }                 // Chrome not up (yet / restarting)
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
