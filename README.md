# browser-box

A resident Chrome in a container, driven over CDP and watched through a
noVNC viewer. `docker/server.mjs` serves the viewer and a small HTTP API.

## Listeners

One process runs two HTTP listeners that share the same state (target
watcher, userscript registry, autoclose settings):

| Port | App | Reach |
| --- | --- | --- |
| 6080 | Viewer UI: noVNC static files, `GET /bb/pointer`, `GET/POST /bb/mode` | The only port published through the gateway (behind oauth2-proxy) |
| 6082 | Control API: `/bb/userscripts`, `/bb/autoclose` | Cluster-internal only, like CDP (9222). Exposed on the Service but deliberately has no HTTPRoute |
| 9222 | CDP forward to Chrome's own debugging port (9223) | Cluster-internal only |

The control API has no authentication of its own; it relies on only
being reachable from inside the cluster.

## Endpoints

### Viewer (6080)

- `GET /bb/pointer` — current pointer position in the desktop as
  `{"x": 0, "y": 0}`; 502 when the position cannot be read.
- `GET /bb/mode` — the input mode as plain text, `cursor` or `touch`.
- `POST /bb/mode` — body text `touch` enables touch emulation on every
  tab, anything else switches back to `cursor`. Returns 204.

### Userscripts (6082)

- `GET /bb/userscripts` — array of registered scripts:
  `{id, name, version, description, runAt, match, include, exclude, addedAt}`.
- `GET /bb/userscripts/:id` — the same summary plus the full `source`;
  404 when the id is unknown.
- `POST /bb/userscripts` — register a script, in any of three forms:
  - raw body: the userscript source as the request body;
  - JSON: `{"source": "..."}`;
  - `multipart/form-data`: every file part (any field name) is
    registered as one userscript, and several files can be uploaded in
    one request. The response is
    `{"results": [{"file": name, "ok": true, "status": 201, ...summary},
    {"file": name, "ok": false, "error": "..."}]}` with HTTP 200, or 400
    when no file could be registered (including a multipart body with
    no file part at all).
  - A single-script registration returns the summary with 201 when the
    script is new, 200 when the identical source was already
    registered. Registration is idempotent: the id is the first 12 hex
    characters of the sha256 of the source. An invalid script is a 400
    with `{"error": "..."}`.
- `DELETE /bb/userscripts/:id` — unregister and remove the script from
  every tab. Returns 204, 404 when the id is unknown.

Userscript semantics follow the usual userscript rules:

- A `// ==UserScript==` metadata block is required.
- `@match`, `@include` and `@exclude` decide where the script runs
  (`@include` also accepts a `/regex/` value). `@run-at` accepts
  `document-start`, `document-end` and `document-idle` (the default).
  `@noframes` restricts the script to the top frame. `@name`,
  `@version` and `@description` only feed the summary.
- `@require` URLs are fetched once at registration time and prepended
  to the script body.
- No `GM_*` APIs are provided.
- Scripts are injected with `Page.addScriptToEvaluateOnNewDocument`:
  a registered script takes effect from the next navigation, in tabs
  that are already open as well as in tabs opened later.
- Deleting a script stops it from running on future navigations, but
  whatever an already-executed copy changed in a loaded page stays
  until that page reloads.

### Autoclose (6082)

- `GET /bb/autoclose` — `{"idleMinutes", "paused", "pausedUntil",
  "tabs": [{"id", "url", "title", "foreground", "lastForegroundAt"}]}`.
- `POST /bb/autoclose` — JSON body; the fields combine:
  - `idleMinutes` (number, 0 or more): idle threshold in minutes.
    0 disables closing.
  - `pauseMinutes` (number): pause closing for that many minutes.
  - `paused: true` pauses indefinitely, `paused: false` resumes.
  - `resume: true` resumes.
  - The response is the same view as the GET.

Every 15 seconds the server checks which tab is in front
(`document.visibilityState` / `document.hasFocus()`). A tab that has
not been in front for longer than `idleMinutes` — 360 minutes
(6 hours) by default — is closed, oldest first. The last remaining tab
is never closed. A timed pause expires on its own and closing resumes;
the pause state is persisted, so restarting the server does not
silently resume closing.

## State

The userscript registry and the autoclose settings persist in
`/data/profile/bb-state.json` on the profile volume (override the path
with the `BB_STATE_FILE` environment variable). Writes are atomic
(temp file + rename).
