# .Muse — Muse-side helpers for browser-box

Helpers for working with bb from Muse. bb itself stays a pure,
standalone component; everything here talks to it over its HTTP
control API (port 6082) and nothing here is needed to run bb.

## Reaching the control API

The control API is cluster-internal only. The standard route is
sshmitm (10.8.1.5:2222), which splice-forwards to browser-box for
clients holding the authorized SSH key — the same path the CDP port
(9222) has always used. No key, no tunnel: sshmitm answers
"Permission denied (publickey)".

```
.muse/bb-tunnel.sh   # starts 127.0.0.1:16082 -> browser-box:6082, idempotent
.muse/bb-api.sh tabs # talks to the forwarded port
```

Both scripts default to that local forward. BB_API_URL overrides the
base URL (for example http://browser-box:6082 from inside the
cluster). bb-tunnel.sh uses the HTTPS_PROXY CONNECT proxy when one is
set (the sandbox VM route) and connects directly otherwise.

## Files

- bb-tunnel.sh — start the sshmitm forward to the control API.
- bb-api.sh — CLI for the control API: autoclose (minutes / pause /
  suspend / resume, per-tab keep), userscripts, CDP event
  subscriptions and the event log.
- hooks/cdp-events.sh — hook template that follows the CDP event log
  and wakes a worker when new events arrive. Copy it to
  ~/hooks/scripts/, edit the config block, register it with the
  hooks tool. bb-tunnel.sh must be running on that machine.
