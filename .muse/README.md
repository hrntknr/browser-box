# .Muse — Muse-side helpers for browser-box

Helpers for working with bb from Muse. bb itself stays a pure,
standalone component; everything here talks to it over its HTTP
control API (port 6082) and nothing here is needed to run bb.

Set BB_API_URL to where the control API is reachable from your
machine (default http://localhost:6082).

- bb-api.sh — CLI for the control API: autoclose (minutes / pause /
  suspend / resume, per-tab keep), userscripts, CDP event
  subscriptions and the event log.
- hooks/cdp-events.sh — hook template that follows the CDP event log
  and wakes a worker when new events arrive. Copy it to
  ~/hooks/scripts/, edit the config block, register it with the
  hooks tool.
