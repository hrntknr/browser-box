// CDP event subscriptions: a browser-level CDP connection auto-attaches to
// every target and records events that match registered subscriptions.
// Outer tooling (e.g. Muse hooks) polls the log with a cursor via the
// control API instead of holding its own CDP connection.

import { createHash } from "node:crypto";

const EVENT_LOG_MAX = 500;
const PARAMS_MAX = 2000;

export function initEventWatcher({ state, saveState, control, log, cdpHttp }) {
  if (!Array.isArray(state.subscriptions)) state.subscriptions = [];

  let seq = 0;
  let msgSeq = 0;
  const eventLog = [];
  const sessions = new Map();
  const targetUrls = new Map();
  let client = null;

  function subId(sub) {
    return createHash("sha256").update(JSON.stringify({
      event: sub.event,
      targetId: sub.targetId || null,
      urlPattern: sub.urlPattern || null,
      filter: sub.filter || null,
    })).digest("hex").slice(0, 12);
  }

  function urlMatches(pattern, url) {
    if (pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
      try { return new RegExp(pattern.slice(1, -1)).test(url); } catch { return false; }
    }
    return (url || "").includes(pattern);
  }

  function fieldValue(obj, field) {
    let cur = obj;
    for (const key of field.split(".")) {
      if (cur === null || typeof cur !== "object") return undefined;
      cur = cur[key];
    }
    return cur;
  }

  function filterMatches(filter, params) {
    if (!filter) return true;
    const v = fieldValue(params, filter.field);
    if (v === undefined || v === null) return false;
    const s = String(v);
    if (filter.regex) {
      try { return new RegExp(filter.regex).test(s); } catch { return false; }
    }
    if (filter.contains) return s.includes(filter.contains);
    return true;
  }

  function dispatch(method, targetId, url, params) {
    for (const sub of state.subscriptions) {
      if (sub.event !== method) continue;
      if (sub.targetId && sub.targetId !== targetId) continue;
      if (sub.urlPattern && !urlMatches(sub.urlPattern, url || "")) continue;
      if (!filterMatches(sub.filter, params)) continue;
      let p = params ?? null;
      try {
        const s = JSON.stringify(p);
        if (s && s.length > PARAMS_MAX) p = { truncated: s.slice(0, PARAMS_MAX) };
      } catch { p = null; }
      eventLog.push({
        seq: ++seq,
        at: new Date().toISOString(),
        subscriptionId: sub.id,
        targetId: targetId || "",
        url: url || "",
        method,
        params: p,
      });
      if (eventLog.length > EVENT_LOG_MAX)
        eventLog.splice(0, eventLog.length - EVENT_LOG_MAX);
      log("cdp event:", method, "sub", sub.id, "seq", seq);
    }
  }

  function neededDomains() {
    const set = new Set();
    for (const sub of state.subscriptions) {
      const d = String(sub.event).split(".")[0];
      if (d && d !== "Target") set.add(d);
    }
    return set;
  }

  async function enableDomains(sessionId) {
    const s = sessions.get(sessionId);
    if (!s || !client || s.type !== "page") return;
    for (const d of neededDomains()) {
      if (s.domains.has(d)) continue;
      s.domains.add(d);
      try {
        await client.send(d + ".enable", {}, sessionId);
      } catch (e) {
        s.domains.delete(d);
        log("cdp event watcher: enable", d, "failed:", e.message);
      }
    }
  }

  function refreshDomains() {
    for (const sid of sessions.keys()) enableDomains(sid).catch(() => {});
  }

  class BrowserCDP {
    constructor(ws) {
      this.ws = ws;
      this.pending = new Map();
      this.onMessage = null;
      ws.addEventListener("message", (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error) p.rej(new Error(m.method + ": " + JSON.stringify(m.error)));
          else p.res(m.result);
        } else if (m.method && this.onMessage) {
          this.onMessage(m);
        }
      });
    }
    send(method, params = {}, sessionId) {
      const id = ++msgSeq;
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          rej(new Error("timeout waiting for " + method));
        }, 10000);
        this.pending.set(id, {
          res: (v) => { clearTimeout(timer); res(v); },
          rej: (e) => { clearTimeout(timer); rej(e); },
          method,
        });
        this.ws.send(JSON.stringify(msg));
      });
    }
  }

  function onMessage(m) {
    const p = m.params || {};
    if (m.method === "Target.attachedToTarget") {
      const info = p.targetInfo || {};
      sessions.set(p.sessionId, {
        targetId: info.targetId || "",
        type: info.type || "",
        url: info.url || "",
        domains: new Set(),
      });
      if (info.targetId) targetUrls.set(info.targetId, info.url || "");
      enableDomains(p.sessionId).catch(() => {});
      return;
    }
    if (m.method === "Target.detachedFromTarget") {
      sessions.delete(p.sessionId);
      return;
    }
    if (m.method === "Target.targetInfoChanged") {
      const info = p.targetInfo || {};
      if (info.targetId) {
        targetUrls.set(info.targetId, info.url || "");
        for (const s of sessions.values())
          if (s.targetId === info.targetId) s.url = info.url || "";
      }
      return;
    }
    if (m.method === "Target.targetDestroyed") {
      dispatch(m.method, p.targetId || "", targetUrls.get(p.targetId) || "", p);
      targetUrls.delete(p.targetId);
      return;
    }
    if (m.sessionId) {
      const s = sessions.get(m.sessionId);
      if (!s) return;
      if (m.method === "Page.frameNavigated" && p.frame && p.frame.url)
        s.url = p.frame.url;
      const url = (p.frame && p.frame.url) || s.url || "";
      dispatch(m.method, s.targetId, url, p);
      return;
    }
    dispatch(m.method,
      (p.targetInfo && p.targetInfo.targetId) || p.targetId || "", "", p);
  }

  async function connect() {
    try {
      const r = await fetch(cdpHttp + "/json/version");
      const v = await r.json();
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", rej, { once: true });
      });
      client = new BrowserCDP(ws);
      client.onMessage = onMessage;
      ws.addEventListener("close", () => {
        if (client && client.ws === ws) client = null;
        sessions.clear();
        targetUrls.clear();
        log("cdp event watcher: browser connection closed, retrying");
        setTimeout(() => connect().catch(() => {}), 5000);
      });
      await client.send("Target.setAutoAttach",
        { autoAttach: true, flatten: true, waitForDebuggerOnStart: false });
      log("cdp event watcher: connected");
    } catch (e) {
      log("cdp event watcher: connect failed:", e.message);
      setTimeout(() => connect().catch(() => {}), 5000);
    }
  }

  const view = (s) => ({
    id: s.id,
    event: s.event,
    targetId: s.targetId || null,
    urlPattern: s.urlPattern || null,
    filter: s.filter || null,
    createdAt: s.createdAt,
  });

  control.get("/bb/subscriptions", (c) => c.json(state.subscriptions.map(view)));

  control.post("/bb/subscriptions", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "JSON body required" }, 400);
    }
    if (!body || typeof body.event !== "string" || !body.event)
      return c.json({ error: "event is required" }, 400);
    if (body.targetId != null && typeof body.targetId !== "string")
      return c.json({ error: "targetId must be a string" }, 400);
    if (body.urlPattern != null && typeof body.urlPattern !== "string")
      return c.json({ error: "urlPattern must be a string" }, 400);
    let filter = null;
    if (body.filter != null) {
      if (typeof body.filter !== "object"
        || typeof body.filter.field !== "string" || !body.filter.field)
        return c.json({ error: "filter.field is required" }, 400);
      filter = { field: body.filter.field };
      if (typeof body.filter.contains === "string") filter.contains = body.filter.contains;
      if (typeof body.filter.regex === "string") filter.regex = body.filter.regex;
    }
    const sub = {
      event: body.event,
      targetId: body.targetId || null,
      urlPattern: body.urlPattern || null,
      filter,
    };
    sub.id = subId(sub);
    const existing = state.subscriptions.find((x) => x.id === sub.id);
    if (existing) return c.json(view(existing), 200);
    sub.createdAt = new Date().toISOString();
    state.subscriptions.push(sub);
    saveState();
    refreshDomains();
    log("subscription added:", sub.event, sub.id);
    return c.json(view(sub), 201);
  });

  control.delete("/bb/subscriptions/:id", (c) => {
    const id = c.req.param("id");
    const i = state.subscriptions.findIndex((x) => x.id === id);
    if (i === -1) return c.json({ error: "not found" }, 404);
    state.subscriptions.splice(i, 1);
    saveState();
    log("subscription removed:", id);
    return c.body(null, 204);
  });

  control.get("/bb/events", (c) => {
    const since = Number(c.req.query("since") || 0) || 0;
    let limit = Number(c.req.query("limit") || 100) || 100;
    limit = Math.max(1, Math.min(limit, EVENT_LOG_MAX));
    const events = eventLog.filter((e) => e.seq > since).slice(0, limit);
    return c.json({
      events,
      next: seq,
      oldest: eventLog.length ? eventLog[0].seq : seq + 1,
    });
  });

  connect().catch(() => {});
}
