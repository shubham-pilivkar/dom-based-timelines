# MeetMinutes Recorder — Chrome Extension

Records browser-based Google Meet and Microsoft Teams calls, mixes tab
audio with the user's microphone, and streams 20-second WebM chunks
plus a speaker timeline to the MeetMinutes backend.

The implementation is plain JavaScript (ES modules) — no UI framework,
no runtime dependencies. Vite + `@crxjs/vite-plugin` handle bundling and
the MV3 manifest.

---

## Prerequisites

- Node.js 18+ and npm
- Chrome / Chromium 116+ (required for MV3 offscreen documents and
  `chrome.tabCapture.getMediaStreamId({ targetTabId })`)
- A MeetMinutes backend reachable from the browser (default
  `https://api.meetminutes.in`) exposing `/auth/register` + `/auth/login`

## Install + build

```bash
cd meetminutes-extension
npm install
npm run build           # produces dist/
# or
npm run dev             # Vite + crxjs HMR
```

Icons live in `public/icons/`. The brand-blue REC mark is generated
from `scripts/generate-icons.js` (pure-JS via `pngjs`, no native deps):

```bash
npm run icons           # regenerates icon-{16,48,128}.png
```

Edit the `BG`/`DOT`/`RING` constants at the top of the script to
re-skin without external tooling.

## Tests

### Unit tests (Vitest)

```bash
npm test                # vitest run, exits when done
npm run test:watch      # interactive watcher
```

Covers the modules with the most timing / IO surface area:

- `tests/speaker-detector.test.js` — debounce + selector regression timer
- `tests/drain-chunk-queue.test.js` — backoff schedule, success path, 401 bail
- `tests/timeline-buffer.test.js` — 404/501/5xx retention semantics
- `tests/telemetry-buffer.test.js` — same retention semantics for the events buffer
- `tests/audio-mixer.test.js` — gain wiring + monitor-blocked surfacing

### End-to-end (Playwright)

```bash
npm run test:e2e:install   # one-time: download Chromium (~120 MB)
npm run test:e2e           # builds dist/ then runs Playwright
```

The e2e suite covers two specs:

`tests/e2e/extension.spec.js` — extension lifecycle:
1. Service worker registers on launch.
2. Popup renders in IDLE state.
3. Options page round-trips every setting through `chrome.storage.local`
   (URL, token, mic/tab gain, video/audio bitrate).
4. Session-state IndexedDB initialisation produces an IDLE state.

`tests/e2e/recording.spec.js` — recording orchestration with a mock backend:
1. `START_RECORDING` causes the SW to POST `/api/v1/meetings/start`
   with the right body, persists meeting metadata to IDB, and lands
   in ERROR after the offscreen document fails its mock stream.
2. When `chrome.tabCapture` is refused (the canonical headless failure),
   the SW transitions cleanly to ERROR with `tabCapture_failed:` in
   `errorMessage` instead of getting stuck in STARTING.

What the e2e suite **deliberately doesn't** cover: a full successful
recording (Start → real chunks → Stop → finalize). `chrome.tabCapture`
needs activeTab + a real user invocation of the action button, which
Playwright can't reproduce in headless. We mock `getMediaStreamId` to
exercise the SW orchestration up to the offscreen boundary; the
remaining ~30 lines of media-pipeline code are covered by the unit
tests + manual smoke test.

The e2e config uses `channel: 'chromium'` (the full Chromium binary)
rather than the default `chrome-headless-shell`, which doesn't load
MV3 extensions. `npm run test:e2e:install` downloads the right one.

## Telemetry

The extension persists events to an IndexedDB buffer and a periodic
flusher (every 5 min, plus once on every SW wake) ships them to
`POST /api/v1/extension/events`. Until the endpoint is deployed,
events accumulate; the next flush after deployment sweeps the backlog.
The buffer is capped at 1000 events — older events are dropped on
overflow. Allowed names (kept narrow on purpose):

| Event                       | Fired by              | Indicates                                        |
| --------------------------- | --------------------- | ------------------------------------------------ |
| `polling_fallback_engaged`  | content scripts       | MutationObserver went quiet for ≥10s             |
| `selectors_broken`          | content scripts       | 0 tiles seen for ≥30s — Meet/Teams DOM rotated   |
| `chunk_retry_max_backoff`   | drain pump            | Backoff hit the 30s cap (network struggling)     |
| `auth_lost`                 | drain pump            | A request returned 401 mid-session               |
| `monitor_blocked`           | service worker        | Tab-audio re-emit was rejected by autoplay policy |
| `orphan_recovered`          | service worker        | An un-finalized meeting was finalized on startup |
| `audio_context_rotated`     | offscreen document    | Hourly AudioContext refresh completed             |

Payloads carry only diagnostic numbers (idle ms, chunk index, age in ms).
No PII, no tokens. Failures are silent — telemetry is the lowest priority
traffic in the system.

### Endpoint contract

`POST /api/v1/extension/events`

```json
{
  "name": "selectors_broken",
  "payload": { "source": "google_meet", "sinceMs": 31000 },
  "ts": 1717000000000
}
```

- **Auth:** `Authorization: Bearer <token>` — same scheme as the rest of `/api/v1/*`.
- **Success:** any 2xx (typically 202 Accepted).
- **404 / 501:** treated as "endpoint not deployed yet" — the extension keeps the event in its IDB buffer and replays on the next flush.
- **5xx:** the flusher bails after the failed event and retries on the next interval; events stay buffered.
- **401:** transitions the SW to `NEEDS_REAUTH` if a recording is in flight.

### FastAPI reference handler

Drop this into the MeetMinutes backend; once it returns 2xx, the
extension's existing buffer drains automatically.

```python
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Any

router = APIRouter()

class TelemetryEvent(BaseModel):
    name: str
    payload: dict[str, Any]
    ts: int

ALLOWED_NAMES = {
    "polling_fallback_engaged",
    "selectors_broken",
    "chunk_retry_max_backoff",
    "auth_lost",
    "monitor_blocked",
    "orphan_recovered",
    "audio_context_rotated",
}

@router.post("/api/v1/extension/events", status_code=202)
async def post_extension_event(
    event: TelemetryEvent,
    user = Depends(get_current_user),  # your existing dep
):
    if event.name not in ALLOWED_NAMES:
        # Accept and drop — keeps the buffer flushing even if the
        # extension version drifts ahead of the backend.
        return {"accepted": False, "reason": "unknown_name"}
    # Persist to your analytics store of choice (BigQuery, Postgres, etc.)
    # await analytics.record(user_id=user.id, **event.dict())
    return {"accepted": True}
```

## Load unpacked

> [!IMPORTANT]
> **Always load the `dist/` folder — never the project root.**
> The `manifest.json` at the repo root is *build input* for crxjs: it
> points `content_scripts` at the raw ESM source (`src/content/meet.js`,
> `src/transcribe/overlay.js`, …). Chrome loads content scripts as
> **classic scripts**, which cannot use `import`, so loading the root
> folder makes every content script die on its first line with
> `Uncaught SyntaxError: Cannot use import statement outside a module`
> — captions never turn on, the live-transcribe overlay never mounts,
> and transcription fails with `channel_closed`.
>
> Only `dist/` contains the crxjs loader shims that dynamically
> `import(chrome.runtime.getURL(...))` the bundled ES modules.

1. Run `npm run build` (or `npm run dev` — both write a loadable
   `dist/`; dev adds HMR).
2. Open `chrome://extensions`.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and select **`meetminutes-extension/dist`**.
   If you previously loaded the repo root, **Remove** that entry first.
5. Pin the extension to the toolbar.
6. After pulling new code: `npm run build`, then click the **reload**
   ↻ icon on the extension card in `chrome://extensions`.

## First-time configuration

**Sign in / Sign up** from the toolbar popup. The popup shows the auth
view (email + password) whenever `chrome.storage.local` has no
`mm_auth_token`. Hitting Sign up POSTs to `/auth/register`; Sign in
POSTs to `/auth/login`. The returned token is stored under
`mm_auth_token` and the email under `mm_user_email`. Sign out (from
either the popup or the Options page) calls `/auth/logout` and clears
both keys.

The Options page (right-click the icon → **Options**) covers
non-account settings:

| Field             | Notes                                                                      |
| ----------------- | -------------------------------------------------------------------------- |
| Backend base URL  | e.g. `https://api.meetminutes.in` — no trailing slash                      |
| Account           | Shows `Signed in as <email>` plus a Sign out button when authenticated     |
| Microphone gain   | 0 – 2; multiplier applied to mic before mixing — applies live              |
| Tab audio gain    | 0 – 2; multiplier applied to captured tab audio — applies live             |
| Video bitrate     | 1.0 / 1.5 / 2.5 Mbps. Changing during a recording triggers a brief rotation |
| Audio bitrate     | 64 / 96 / 128 kbps. Same live-rotation behaviour as video                  |

The token is never written to `console.log` even at debug verbosity.

## End-to-end smoke test

1. Open a Google Meet or Microsoft Teams meeting.
2. Click the MeetMinutes icon.
3. Click **Start recording**. The popup pill turns green; "Recording".
4. Speak. The **Speaker** field updates within ~1 second.
5. Watch the **Upload queue** counter — it should stay near zero.
6. Click **Stop recording**. The popup pill returns to "Idle"; the
   queue drains; the SW calls `/finalize`.

If the backend's `/timeline` endpoint isn't deployed yet, speaker
events accumulate in IndexedDB; you can replay them later with
`chrome.runtime.sendMessage({ type: 'FLUSH_TIMELINE' })` from the
service worker DevTools console.

## Troubleshooting

### No audio in the recording (or tab goes silent)
`chrome.tabCapture` mutes the source tab by default. The offscreen
document re-emits the captured tab audio through a hidden `<audio>`
element — if browser autoplay policy blocks it, the meeting will be
silent for the user but the recording still has audio. Reload the
meeting tab and click anywhere on the page before pressing Start.

### Microphone denied
The first Start triggers a `getUserMedia({ audio: true })` permission
prompt **inside the offscreen document**. If you missed it, open
`chrome://settings/content/microphone` and grant access to the
extension URL (`chrome-extension://<id>/`). Until then, recordings
fall back to tab audio only and `mic_available: false` is sent on
`/meetings/start`.

### Upload returns 401
The popup shows a yellow "Token expired" banner and the state machine
moves to `NEEDS_REAUTH`. Chunks keep accumulating in IndexedDB so
nothing is lost. Update the token in the options page and click
**Start recording** again — the drain pump will replay buffered chunks
before a new session begins.

---

## Architecture

| Component            | Lifetime                  | Responsibilities                                                     |
| -------------------- | ------------------------- | -------------------------------------------------------------------- |
| Service worker       | Wakes on events           | State machine, tabCapture, offscreen lifecycle, drain pump, finalize |
| Offscreen document   | Recreated each recording  | MediaRecorder, AudioContext, mic capture, tab-audio monitor          |
| Popup                | Open while user looks at it | UI; reads state, dispatches start/stop                              |
| Options page         | On user demand            | Token + base URL + gain settings                                     |
| Content script (Meet) | Per Meet tab             | Speaker DOM observation, "meeting ended" signal                      |
| Content script (Teams) | Per Teams tab           | Speaker DOM observation, "meeting ended" signal                      |

Recording continues if the popup is closed because the MediaRecorder
lives in the offscreen document. The service worker is allowed to
suspend; durable state goes to `chrome.storage.session`.

### Dataflow — "user clicks Start"

```
+--------+ click  +-----------------+  getMediaStreamId  +-----------+
| popup  |------->| service worker  |------------------->| chrome.   |
| .js    |        |                 |<------------------ | tabCapture|
+--------+        |                 |   streamId         +-----------+
   ^              |                 |
   | STATE_       |   POST /meetings/start
   | UPDATE       |--------------------------+
   |              |   { meeting_id, upload_url }
   |              |<-------------------------+
   |              |
   |              |   chrome.offscreen.createDocument
   |              |--------------------------+
   |              |                          v
   |              |               +----------------------+
   |              | OFFSCREEN_    | offscreen.html       |
   |              | START         | offscreen.js         |
   |              |-------------->|  getUserMedia(tab)   |
   |              |               |  getUserMedia(mic)   |
   |              |               |  AudioMixer          |
   |              |               |  MediaRecorder.start |
   |              |               +----------+-----------+
   |              |                          |
   |              |   CHUNK_PERSISTED        | every 20s
   |              |<-------------------------+
   |              |                          |
   |              |  (drain pump)            |
   |              |       POST /meetings/{id}/chunks
   |              |--------------------------+
   |              |                          v
   |              |                  MeetMinutes backend
   |              |
   |              |  STATE_UPDATE
   +--------------+

content/{meet,teams}.js (in the meeting tab)
   |
   | SPEAKER_CHANGE -> service worker -> timeline-buffer (IndexedDB)
   |                                       -> POST /meetings/{id}/timeline
   v                                          (every 30s, tolerated 404)
```

---

## Manual testing checklist

Each item maps to a row in the **Edge cases** table in the build
prompt. Use Chrome DevTools' **Network** + the SW + offscreen consoles
in parallel.

- [ ] **TC-01 Popup closes mid-recording** — Start → close popup →
  reopen 30 s later. Upload queue should reflect chunks shipped
  while the popup was closed; state still RECORDING.
- [ ] **TC-02 User switches tab** — During recording switch to a
  different tab. A `__tab_blurred__` event lands in the timeline
  buffer; recording continues.
- [ ] **TC-03 Meeting tab refreshed** — Press F5 in the meeting tab
  during recording. SW transitions to STOPPING then IDLE; final
  chunk is finalized; popup shows `recording_tab_navigated`.
- [ ] **TC-04 Mic permission denied** — Reset the extension mic
  permission, click Start, deny the prompt. Recording continues
  with `Mic: tab audio only`; `/meetings/start` carries
  `mic_available: false`.
- [ ] **TC-05 Network drop during upload** — Throttle to "Offline"
  in DevTools mid-recording. Queue depth grows. Restore network;
  queue drains with exponential backoff (visible in SW console).
- [ ] **TC-06 Token expired (401)** — Replace token with junk in
  options. Start a recording. SW transitions to NEEDS_REAUTH;
  buffered chunks remain on disk; popup shows yellow banner.
  Restore token, click Start again — drain replays.
- [ ] **TC-07 Long recording (>2 hrs)** — Run a 2h+ test (e.g. on
  a static page with looping audio). Verify Chrome task manager
  memory stays flat; AudioContext rotates every 60 min (visible
  via the hidden `<audio>` glitch + console).
- [ ] **TC-08 Multiple meeting tabs** — Start a recording on tab A.
  Switch to a second Meet tab; click Start in the popup. Should
  refuse with "another recording is active".
- [ ] **TC-09 Meeting ends naturally** — Click "Leave call" inside
  Meet/Teams. Content script fires MEETING_ENDED; SW auto-stops;
  finalize runs.
- [ ] **TC-10 Offscreen document crashes** — In `chrome://inspect`,
  inspect the offscreen document and run `throw new Error('boom')`.
  SW heartbeat watchdog trips at ≤ 5 s; state moves to ERROR;
  pending chunks remain in IndexedDB.
- [ ] **TC-11 Timeline endpoint missing (404/501)** — Point the
  options URL at a backend without `/timeline`. Speaker events
  accumulate; periodic flush logs `timeline_unimplemented_*` at
  debug; recording is unaffected.
- [ ] **TC-12 Speaker detection observer goes quiet** — In the
  meeting tab DevTools, run `MutationObserver = function(){}`
  (effectively breaking it). After 10 s the polling fallback
  takes over and speaker updates resume.
- [ ] **TC-13 SW suspended mid-recording** — In `chrome://serviceworker-internals`, force-stop the SW. Offscreen
  document keeps recording; on the next event the SW wakes and
  drains as normal.

---

## File map (matches build deliverable order)

```
meetminutes-extension/
├─ package.json
├─ vite.config.js
├─ manifest.json
├─ public/icons/                (16, 48, 128 PNGs — provide your own)
└─ src/
   ├─ constants.js              # message types, storage keys, tunables
   ├─ lib/
   │  ├─ messaging.js
   │  ├─ audio-mixer.js
   │  ├─ recorder.js
   │  └─ speaker-detector.js
   ├─ api/
   │  ├─ client.js              # endpoints, auth, chunk drain pump
   │  └─ timeline-buffer.js     # IndexedDB store + periodic flush
   ├─ background/
   │  └─ service-worker.js
   ├─ offscreen/
   │  ├─ offscreen.html
   │  └─ offscreen.js
   ├─ popup/
   │  ├─ popup.html
   │  ├─ popup.js
   │  └─ popup.css
   ├─ options/
   │  ├─ options.html
   │  └─ options.js
   └─ content/
      ├─ meet.js
      └─ teams.js
```

## What's intentionally NOT included

- Analytics / telemetry / third-party scripts.
- Any logging that could leak the bearer token.
- A "resume after SW restart" path for the offscreen MediaStream — the
  underlying tabCapture stream cannot be revived once the offscreen
  document dies, so we surface ERROR instead of pretending otherwise.
- Alembic-style migrations on IndexedDB — the schema is created in
  `onupgradeneeded` and bumped via the `openDb` version.

## Endpoint contract reference

Endpoint paths are isolated in one config object inside `src/api/client.js`
(`ENDPOINTS`). To re-align with the real backend, edit that single
object — no other file references paths.

| Path                                       | Method | Purpose                       |
| ------------------------------------------ | ------ | ----------------------------- |
| `/api/v1/me`                               | GET    | Auth check / profile          |
| `/api/v1/meetings/start`                   | POST   | Begin a recording session     |
| `/api/v1/meetings/{id}/chunks`             | POST   | Upload one WebM chunk         |
| `/api/v1/meetings/{id}/finalize`           | POST   | Mark recording complete       |
| `/api/v1/meetings/{id}/timeline` (future)  | POST   | Speaker timeline events       |
# chrome_extension
# dom-based-timelines
