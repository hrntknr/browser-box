import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { initEventWatcher } from "./events.mjs";

const WEB_ROOT = "/usr/share/novnc";
const HTTP_HOST = process.env.NOVNC_BIND || "127.0.0.1";
const HTTP_PORT = 6080;
const CONTROL_PORT = 6082;
const WS_PORT = 6081;
const CDP_HTTP = "http://127.0.0.1:9223";

const log = (...a) => console.log("[bb-server]", ...a);

let mode = "cursor";

// ---------- userscript metadata (same rules as the standalone loader) ----------

const MULTI_KEYS = new Set(["match", "include", "exclude", "require", "grant"]);

function parseMetadata(source) {
  const block = source.match(/\/\/ ==UserScript==[^\S\r\n]*\r?\n([\s\S]*?)\/\/ ==\/UserScript==/);
  if (!block) throw new Error("missing ==UserScript== metadata block");
  const meta = { match: [], include: [], exclude: [], require: [], grant: [], noframes: false };
  for (const line of block[1].split(/\r?\n/)) {
    const m = line.match(/^\s*\/\/\s*@(\S+)(?:\s+(.*?))?\s*$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2] ?? "";
    if (key === "noframes") meta.noframes = true;
    else if (MULTI_KEYS.has(key)) meta[key].push(value);
    else if (!(key in meta)) meta[key] = value;
  }
  return meta;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function matchPatternToRegExp(pattern) {
  if (pattern === "<all_urls>") return /^https?:\/\/[^/]+(?:\/.*)?$/;
  const m = pattern.match(/^(\*|http|https|file|ftp):\/\/([^/]*)(\/.*)?$/);
  if (!m) return null;
  const scheme = m[1] === "*" ? "https?" : m[1];
  let host;
  if (m[2] === "*") host = "[^/]*";
  else if (m[2].startsWith("*.")) host = "(?:[^/]+\\.)*" + escapeRegExp(m[2].slice(2));
  else host = escapeRegExp(m[2]);
  const p = (m[3] ?? "/*").split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${scheme}://${host}${p}$`);
}

function globToRegExp(glob) {
  if (glob.length > 2 && glob.startsWith("/") && glob.endsWith("/")) {
    try {
      return new RegExp(glob.slice(1, -1));
    } catch {
      return null;
    }
  }
  return new RegExp("^" + glob.split("*").map(escapeRegExp).join(".*") + "$");
}

function buildInjectedSource(meta, code) {
  const sources = (list) => list.map((r) => r && r.source).filter(Boolean);
  const cfg = JSON.stringify({
    match: sources(meta.match.map(matchPatternToRegExp)),
    include: sources(meta.include.map(globToRegExp)),
    exclude: sources(meta.exclude.map(globToRegExp)),
    noframes: meta.noframes,
    runAt: meta["run-at"] || "document-idle",
  });
  return `(function () {
var cfg = ${cfg};
var hit = function (list) { return list.some(function (s) { return new RegExp(s).test(location.href); }); };
if ((cfg.match.length || cfg.include.length) && !hit(cfg.match) && !hit(cfg.include)) return;
if (hit(cfg.exclude)) return;
if (cfg.noframes && window !== window.top) return;
var main = function () {
${code}
};
if (cfg.runAt === "document-start") {
  if (document.documentElement) main();
  else {
    var done = false;
    var go = function () { if (done) return; done = true; main(); };
    new MutationObserver(function (records, ob) {
      if (document.documentElement) { ob.disconnect(); go(); }
    }).observe(document, { childList: true });
    document.addEventListener("DOMContentLoaded", go, { once: true });
  }
} else if (cfg.runAt === "document-end") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main, { once: true });
  else main();
} else {
  var idle = function () {
    if (window.requestIdleCallback) window.requestIdleCallback(function () { main(); }, { timeout: 3000 });
    else setTimeout(main, 0);
  };
  if (document.readyState === "complete") idle();
  else window.addEventListener("load", idle, { once: true });
}
})();`;
}

async function assembleScript(source) {
  const meta = parseMetadata(source);
  let code = source;
  if (meta.require.length) {
    const parts = [];
    for (const url of meta.require) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`@require ${url}: HTTP ${res.status}`);
      parts.push(await res.text());
    }
    code = parts.join("\n") + "\n" + source;
  }
  return {
    id: createHash("sha256").update(source).digest("hex").slice(0, 12),
    name: meta.name ?? "unnamed",
    version: meta.version ?? "",
    description: meta.description ?? "",
    runAt: meta["run-at"] || "document-idle",
    match: meta.match,
    include: meta.include,
    exclude: meta.exclude,
    source,
    injected: buildInjectedSource(meta, code),
    addedAt: new Date().toISOString(),
  };
}

// ---------- persistent state (userscripts + autoclose) ----------

const STATE_FILE = process.env.BB_STATE_FILE || "/data/profile/bb-state.json";

const state = {
  scripts: [],
  autoclose: { idleMinutes: 360, paused: false, pausedUntil: 0, tabs: {} },
  subscriptions: [],
};
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (Array.isArray(saved.scripts)) state.scripts = saved.scripts;
  if (saved.autoclose) Object.assign(state.autoclose, saved.autoclose);
  if (Array.isArray(saved.subscriptions)) state.subscriptions = saved.subscriptions;
  log(`state loaded: ${state.scripts.length} userscript(s)`);
} catch {}
if (!state.autoclose.tabs || typeof state.autoclose.tabs !== "object")
  state.autoclose.tabs = {};

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    log("state save failed:", e.message);
  }
}

const app = new Hono();
const control = new Hono();

app.get("/bb/pointer", (c) => new Promise((resolve) => {
  // Xvnc sends the cursor shape only after pointer motion in the viewer's own session
  execFile("xdotool", ["getmouselocation"],
    { env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" } },
    (err, stdout) => {
      const m = err ? null : /x:(\d+) y:(\d+)/.exec(stdout);
      resolve(m ? c.json({ x: +m[1], y: +m[2] }) : c.body(null, 502));
    });
}));

app.get("/bb/mode", (c) => c.text(mode + "\n"));

app.post("/bb/mode", async (c) => {
  setMode((await c.req.text()).trim() === "touch" ? "touch" : "cursor");
  return c.body(null, 204);
});

const scriptSummary = (s) => ({
  id: s.id, name: s.name, version: s.version, description: s.description,
  runAt: s.runAt, match: s.match, include: s.include, exclude: s.exclude,
  addedAt: s.addedAt,
});

control.get("/bb/userscripts", (c) => c.json(state.scripts.map(scriptSummary)));

control.get("/bb/userscripts/:id", (c) => {
  const s = state.scripts.find((x) => x.id === c.req.param("id"));
  return s ? c.json({ ...scriptSummary(s), source: s.source })
           : c.json({ error: "not found" }, 404);
});

async function addUserscript(source) {
  const rec = await assembleScript(source);
  const existing = state.scripts.find((x) => x.id === rec.id);
  if (!existing) {
    state.scripts.push(rec);
    saveState();
    log("userscript added:", rec.name, rec.id);
  }
  return { rec: existing || rec, created: !existing };
}

async function applyScriptsToAllTargets() {
  for (const t of targets.values()) {
    try { await applyScriptsToTarget(t); } catch {}
  }
}

control.post("/bb/userscripts", async (c) => {
  if ((c.req.header("content-type") || "").startsWith("multipart/form-data")) {
    const body = await c.req.parseBody({ all: true }).catch(() => null);
    const files = [];
    for (const v of Object.values(body || {})) {
      for (const item of Array.isArray(v) ? v : [v]) {
        // file parts arrive as File objects; text fields are plain strings
        if (item && typeof item === "object" && typeof item.text === "function")
          files.push(item);
      }
    }
    if (!files.length)
      return c.json({ error: "no file part in multipart body" }, 400);
    const results = [];
    for (const f of files) {
      try {
        const { rec, created } = await addUserscript(await f.text());
        results.push({ file: f.name, ok: true, status: created ? 201 : 200, ...scriptSummary(rec) });
      } catch (e) {
        results.push({ file: f.name, ok: false, error: e.message });
      }
    }
    await applyScriptsToAllTargets();
    return c.json({ results }, results.some((r) => r.ok) ? 200 : 400);
  }
  let source = await c.req.text();
  try {
    const j = JSON.parse(source);
    if (j && typeof j.source === "string") source = j.source;
  } catch {}
  let added;
  try {
    added = await addUserscript(source);
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
  await applyScriptsToAllTargets();
  return c.json(scriptSummary(added.rec), added.created ? 201 : 200);
});

control.delete("/bb/userscripts/:id", async (c) => {
  const id = c.req.param("id");
  const i = state.scripts.findIndex((x) => x.id === id);
  if (i === -1) return c.json({ error: "not found" }, 404);
  state.scripts.splice(i, 1);
  saveState();
  log("userscript removed:", id);
  for (const t of targets.values()) {
    try { await removeScriptFromTarget(t, id); } catch {}
  }
  return c.body(null, 204);
});

function autocloseView() {
  const ac = state.autoclose;
  const now = Date.now();
  return {
    idleMinutes: ac.idleMinutes,
    paused: !!(ac.paused || (ac.pausedUntil && ac.pausedUntil > now)),
    pausedUntil: ac.pausedUntil ? new Date(ac.pausedUntil).toISOString() : null,
    tabs: [...targets.entries()].map(([id, t]) => ({
      id,
      url: t.url || "",
      title: t.title || "",
      foreground: !!t.foreground,
      neverClose: !!state.autoclose.tabs[id],
      lastForegroundAt: t.lastForegroundAt
        ? new Date(t.lastForegroundAt).toISOString() : null,
    })),
  };
}

control.get("/bb/autoclose", (c) => c.json(autocloseView()));

control.post("/bb/autoclose", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSON body required" }, 400);
  }
  const ac = state.autoclose;
  if (typeof body.idleMinutes === "number" && body.idleMinutes >= 0)
    ac.idleMinutes = body.idleMinutes;
  if (body.resume === true) {
    ac.paused = false;
    ac.pausedUntil = 0;
  } else if (typeof body.pauseMinutes === "number" && body.pauseMinutes > 0) {
    ac.paused = false;
    ac.pausedUntil = Date.now() + body.pauseMinutes * 60000;
  } else if (body.paused === true) {
    ac.paused = true;
    ac.pausedUntil = 0;
  } else if (body.paused === false) {
    ac.paused = false;
    ac.pausedUntil = 0;
  }
  saveState();
  log("autoclose updated:", JSON.stringify(state.autoclose));
  return c.json(autocloseView());
});

// per-tab exclusion: an excluded tab is never closed by autoclose,
// regardless of the global rule. The global rule itself stays in effect.
control.get("/bb/autoclose/tabs", (c) => c.json({
  tabs: Object.keys(state.autoclose.tabs).map((id) => {
    const t = targets.get(id);
    return { id, neverClose: true, url: t ? t.url || "" : "", title: t ? t.title || "" : "" };
  }),
}));

control.post("/bb/autoclose/tabs/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  if (body && body.neverClose === false) delete state.autoclose.tabs[id];
  else state.autoclose.tabs[id] = true;
  saveState();
  log("autoclose tab exclusion:", id, !!state.autoclose.tabs[id]);
  return c.json({ id, neverClose: !!state.autoclose.tabs[id] });
});

control.delete("/bb/autoclose/tabs/:id", (c) => {
  const id = c.req.param("id");
  if (!(id in state.autoclose.tabs)) return c.json({ error: "not found" }, 404);
  delete state.autoclose.tabs[id];
  saveState();
  log("autoclose tab exclusion removed:", id);
  return c.body(null, 204);
});

// CDP event subscriptions + event log (see events.mjs)
initEventWatcher({ state, saveState, control, log, cdpHttp: CDP_HTTP });

// iOS Safari reuses a cached rfb.js module without revalidating; a stale one must not survive a deploy
const noStore = (_path, c) => c.header("Cache-Control", "no-store");
app.use(serveStatic({ root: WEB_ROOT, onFound: noStore }));

const server = serve(
  { fetch: app.fetch, hostname: HTTP_HOST, port: HTTP_PORT },
  () => log(`http on ${HTTP_HOST}:${HTTP_PORT}, ws proxy -> 127.0.0.1:${WS_PORT}`));

serve(
  { fetch: control.fetch, hostname: HTTP_HOST, port: CONTROL_PORT },
  () => log(`control api on ${HTTP_HOST}:${CONTROL_PORT}`));


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

async function applyScriptsToTarget(t) {
  if (!t.cdp) return;
  for (const s of state.scripts) {
    if (t.scripts.has(s.id)) continue;
    const { identifier } = await t.cdp.send(
      "Page.addScriptToEvaluateOnNewDocument", { source: s.injected });
    t.scripts.set(s.id, identifier);
  }
}

async function removeScriptFromTarget(t, scriptId) {
  const identifier = t.scripts.get(scriptId);
  if (!identifier) return;
  t.scripts.delete(scriptId);
  await t.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
}

async function watchTarget(tgt) {
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  const t = {
    cdp: null, applied: null, scripts: new Map(),
    url: tgt.url || "", title: tgt.title || "",
    foreground: false, lastForegroundAt: Date.now(),
  };
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
  await applyScriptsToTarget(t);
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
    const t = targets.get(tgt.id);
    if (t) {
      t.url = tgt.url || "";
      t.title = tgt.title || "";
    } else {
      try { await watchTarget(tgt); }
      catch (e) { log("watch failed:", e.message); targets.delete(tgt.id); }
    }
  }
  let pruned = false;
  for (const id of Object.keys(state.autoclose.tabs)) {
    if (!targets.has(id)) { delete state.autoclose.tabs[id]; pruned = true; }
  }
  if (pruned) saveState();
}

setInterval(() => { pollTargets().catch(() => {}); }, 1500);
pollTargets().catch(() => {});

// ---------- autoclose: close tabs that have not been in front for a while ----------

const FG_EXPR = "(() => { try { return document.visibilityState === \"visible\" || document.hasFocus(); } catch { return false; } })()";

async function sweepAutoclose() {
  const ac = state.autoclose;
  const now = Date.now();
  if (ac.pausedUntil && ac.pausedUntil <= now) {
    ac.pausedUntil = 0;
    saveState();
    log("autoclose: pause expired, resumed");
  }
  for (const t of targets.values()) {
    if (!t.cdp) continue;
    try {
      const r = await t.cdp.send("Runtime.evaluate",
        { expression: FG_EXPR, returnByValue: true });
      const fg = !!(r && r.result && r.result.value);
      t.foreground = fg;
      if (fg) t.lastForegroundAt = now;
    } catch {}
  }
  if (!ac.idleMinutes || ac.idleMinutes <= 0) return;
  if (ac.paused || (ac.pausedUntil && ac.pausedUntil > now)) return;
  const pages = [...targets.entries()];
  if (pages.length <= 1) return;
  const stale = pages
    .filter(([id, t]) => !ac.tabs[id] && !t.foreground
      && now - (t.lastForegroundAt || now) > ac.idleMinutes * 60000)
    .sort((a, b) => (a[1].lastForegroundAt || 0) - (b[1].lastForegroundAt || 0));
  let remaining = pages.length;
  for (const [id, t] of stale) {
    if (remaining <= 1) break;
    try {
      await fetch(`${CDP_HTTP}/json/close/${id}`);
      log("autoclose: closed", t.url || id);
      remaining--;
    } catch (e) {
      log("autoclose close failed:", e.message);
    }
  }
}

setInterval(() => { sweepAutoclose().catch(() => {}); }, 15000);

process.on("uncaughtException", e => log("uncaught:", e.message));
process.on("unhandledRejection", e => log("unhandled:", String(e)));
