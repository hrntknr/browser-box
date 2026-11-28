# .muse — CDP event subscriptions and Muse helpers

browser-box records CDP events that match registered subscriptions, so that
Muse (hooks) can be woken by things happening in the browser — page
navigations, tabs closing, network events — without holding its own CDP
connection.

## How it works

- The bb server keeps a browser-level CDP connection with auto-attach
  (flatten). Every attached page session gets the domains enabled that
  current subscriptions need.
- A subscription says: for tabs matching a condition, record events with
  this CDP method name, optionally filtered by a field inside the event
  params.
- Matching events go into an in-memory log (latest 500), each with a
  monotonically increasing `seq`. Consumers poll with a cursor:
  `GET /bb/events?since=<seq>` returns the newer events and `next`, the
  cursor to use for the following poll.
- Subscriptions are persisted in `bb-state.json` and survive restarts.
  The event log itself is in-memory and starts empty on restart.

## Control API (port 6082, cluster-internal)

```
GET    /bb/subscriptions           list subscriptions
POST   /bb/subscriptions           register (idempotent; id = hash of the body)
DELETE /bb/subscriptions/:id       remove
GET    /bb/events?since=0&limit=100
```

Subscription body:

```json
{
  "event": "Page.frameNavigated",
  "targetId": "<optional tab id>",
  "urlPattern": "<optional: substring, or /regex/ when slash-wrapped>",
  "filter": { "field": "frame.url", "contains": "/complete" }
}
```

- `event` (required): any CDP method name, e.g. `Page.frameNavigated`,
  `Target.targetDestroyed`, `Network.responseReceived`.
- `targetId` / `urlPattern`: tab condition. Both may be set; both must match.
- `filter` (optional): `field` is a dot path into the event params;
  `contains` (substring) or `regex` must match its string value.

Event record:

```json
{ "seq": 12, "at": "2026-11-29T00:00:00.000Z", "subscriptionId": "…",
  "targetId": "…", "url": "…", "method": "Page.frameNavigated",
  "params": { "frame": { "url": "…" } } }
```

Params longer than 2000 chars are stored as `{ "truncated": "…" }`.

## CLI

`bb-api.sh` drives the control API from outside the cluster through a
throwaway Job (kubectl-pear.sh):

```
bb-api.sh tabs
bb-api.sh subs
bb-api.sh subs add '{"event":"Page.frameNavigated","urlPattern":"reserve.tokyodisneyresort.jp"}'
bb-api.sh subs del <id>
bb-api.sh events [since] [limit]
```

## Hooks

`hooks/cdp-events.sh` is a generic hook script template: it follows the
event log with a cursor file under `~/hooks/state/`, and wakes its worker
with the new events as payload. Copy it to `~/hooks/scripts/`, set
`HOOK_NAME` and `SUBSCRIPTION_IDS` in the config block, then register it
with the hooks tool (add → dry_run → enable).

First instantiated hook: `restaurant-watcher-events` — watches the TDR
restaurant watcher tab for navigations and tab destruction; its worker
checks the watcher's current state and reports bookings or anomalies.
