# Chrome Web Store listing — MeetMinutes Recorder

Paste the sections below into the Chrome Web Store developer dashboard
when you submit. Keep this file in lockstep with `manifest.json` so a
reviewer's "permission X is requested but not in your listing" loop
never starts.

Last updated: see git log. Manifest version pinned by this file: `1.0.0`.

---

## Quick reference (paste into the dashboard fields)

### Name (≤ 75 chars)
`MeetMinutes: Record & Transcribe Google Meet and Teams`

### Short description (≤ 132 chars — used in search results)
`Record Google Meet and Microsoft Teams calls in your browser. Get instant transcripts, summaries, and shareable highlights.`

### Category
**Workflow & Planning** (Productivity). Otter.ai, Fireflies, Tactiq and Read.ai all sit in this category — recording/transcription is the established pattern reviewers see daily, so the risk model is calibrated.

### Language
`English (US)` for v1.0. Add more locales in v1.1+ once the listing is approved (extra locales don't speed up review and sometimes slow it down because reviewers scan every `messages.json`).

---

## Single-purpose statement (Chrome Web Store: "Single purpose")

> Record Google Meet and Microsoft Teams meetings with on-screen
> participant consent and upload them to the user's MeetMinutes
> account for transcription and AI summaries.

Optional pairing with the MeetMinutes Desktop app (off by default,
loopback-only) is documented under host-permission justifications
below — it does not constitute a second purpose; it's the same
recording workflow enriched with desktop-side speaker identification.

---

## Long description (paste into "Description")

```
Record Google Meet and Microsoft Teams calls directly from your
browser, then get an AI-generated transcript, summary, and shareable
highlight clips — without installing a desktop app or sending a bot.

KEY FEATURES
• One-click recording from any Google Meet or Microsoft Teams tab.
• Live transcription with speaker labels (you and other participants).
• Auto-summary and action-item extraction once the recording ends.
• Browser-only — no desktop install required. Optional desktop
  pairing for richer speaker identification.
• On-device noise suppression on the tab-audio leg so background
  comfort noise doesn't bleed into the recording.
• Keyboard shortcuts: Ctrl+Shift+R to toggle recording, Ctrl+Shift+T
  to toggle live transcription, from any tab in your current window.

HOW IT WORKS
1. Sign in to your MeetMinutes account from the extension popup.
2. Open a Google Meet or Microsoft Teams call.
3. Click the extension icon and press "Start Recording". A small
   in-tab banner shows that recording is active.
4. Press "Stop". The recording uploads to your MeetMinutes account;
   transcript and summary appear at meetminutes.in/library shortly
   after the meeting ends.

PRIVACY
• The extension never records unless you click Start.
• The in-tab banner stays visible while recording is active so you
  always know capture is on.
• Audio, video, and screen captures upload only to your MeetMinutes
  account — never to any third party. Full Privacy Policy:
  https://www.meetminutes.in/privacy-policy.
• MeetMinutes' use of information received from Google APIs adheres
  to the Chrome Web Store User Data Policy, including the Limited
  Use requirements.

PRICING
Free to install. Paid subscription tiers are available on
meetminutes.in/pricing for higher recording limits and AI features.
Billing happens entirely on meetminutes.in; the extension does not
process payments.

SUPPORT
support@meetminutes.in
```

---

## Permission justifications (Chrome Web Store: "Permission justification")

Paste one section per permission. Reviewers look for *why*, not *what*
— state the user-visible feature each permission enables.

### `tabCapture`
Required by `chrome.tabCapture.getMediaStreamId()` to capture the
audio + video of the meeting tab the user explicitly invokes the
recorder on. `tabCapture` is strictly narrower than `desktopCapture`:
it captures only the specific Meet/Teams tab the user clicks into,
not the whole screen or other tabs. The user invokes recording from
the extension popup or via a keyboard shortcut (both Chrome treats
as a user gesture).

### `activeTab`
Required by the two keyboard shortcuts the extension exposes
(`Ctrl+Shift+R` to toggle recording, `Ctrl+Shift+T` to toggle live
transcription). When the user fires a shortcut, Chrome grants
`activeTab` for the currently-focused tab, and that grant is what
satisfies `chrome.tabCapture`'s "extension has been invoked for the
current page" requirement. Without `activeTab` the shortcuts would
fail when the user has switched away from the meeting tab — for
example while presenting a slide deck in a separate window.
`activeTab` is the *least*-privileged way to satisfy that
requirement: it grants access only to the tab the user just invoked
the action on, only for the duration of that invocation.

### `storage`
Persist the user's MeetMinutes backend URL, authentication token,
preferred audio/video bitrates, the subscription feature snapshot,
and per-session lifecycle state across service-worker restarts.
Without this the extension would forget settings every time Chrome
suspends the SW.

### `offscreen`
Run `MediaRecorder` and `AudioContext` in a dedicated offscreen
document so recording survives popup close and service-worker
suspension. `MediaRecorder` cannot run directly inside an MV3
service worker; the offscreen document is the supported pattern
documented at developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3.

### `tabs`
Two narrow uses:
1. Read `tab.url` from the popup to identify which meeting tab the
   user wants to record.
2. Watch `tabs.onUpdated` / `tabs.onRemoved` so recording auto-stops
   if the user navigates away or closes the meeting tab — and any
   in-flight chunks are flushed before teardown.

Used only for the recording tab in flight; never queries unrelated
tabs.

### `scripting`
Used by the service worker to inject the speaker-name capture
helper into Meet/Teams tabs when a recording starts. Injection is
gated on `host_permissions` (only Meet/Teams URLs match) and on the
user clicking Start Recording — never injected without the explicit
gesture.

### `alarms`
Wake the service worker periodically (every 30 seconds, the MV3
minimum) to run watchdogs that survive SW suspension because alarms
are persisted to disk:
- Offscreen heartbeat — detect a wedged MediaRecorder so we can
  recover the session rather than silently produce a 0-byte file.
- Stop-force timeout — guarantee the recording stops within 10
  seconds of the user clicking Stop even if the SW was suspended.
- Subscription refresh — re-check the user's plan hourly so feature
  gates don't show stale state.
- Periodic upload retry for chunks queued offline.

### `notifications`
Surface a single desktop notification when the recording has been
fully uploaded and the user can safely close the meeting tab.
Without this, the user has no signal that uploads have drained.

### `identity`
Used by `chrome.identity.launchWebAuthFlow` to run Google /
Microsoft OAuth sign-in via the backend's BFF (Backend-For-Frontend).
The redirect target is the extension's own `chromiumapp.org`
origin; no broad identity APIs are used and no OAuth tokens are
stored by the extension (they live in `chrome.storage` only as
Bearer tokens for the user's MeetMinutes account).

---

## Host-permission justifications

### `https://meet.google.com/*`, `https://teams.microsoft.com/*`, `https://teams.live.com/*`
Inject a content script that:
1. Detects when a recording starts (lifecycle message from the
   service worker) and shows a small "Recording" banner in the tab.
2. Reads the DOM to identify which participant tile is currently
   the active speaker, producing a stream of speaker-change events
   that feed the transcript's diarization.

Detection is read-only; the script never modifies meeting state or
exfiltrates any data Google/Microsoft don't already expose to the
page itself.

### `https://api.meetminutes.in/*`
The MeetMinutes backend the user authenticates against. Used for
session create, chunked upload of the recording, finalize, and
transcript retrieval. No third-party endpoint is contacted; the
CSP `connect-src` explicitly restricts outbound HTTPS to this
origin (and the loopback WebSocket below, when the user opts in).

---

## Optional host-permission justification

### `*://127.0.0.1/*` and `*://localhost/*` (in `optional_host_permissions`)
**Not granted at install time.** The user must explicitly grant
these inside the extension's Options page by:
1. Installing the MeetMinutes Desktop app (separate download).
2. Enabling "Identify speakers in transcripts" in its Settings.
3. Copying the bridge token from the desktop Settings dialog
   (stored in the OS keyring; not in any cloud).
4. Pasting it into this extension's Options page and ticking
   "Enable desktop pairing".

At the moment the user ticks the checkbox, the extension calls
`chrome.permissions.request({origins: ['*://127.0.0.1/*',
'*://localhost/*']})` inside the same user-gesture handler; if the
user denies, the bridge stays off.

Once granted, this extension opens a WebSocket to
`ws://127.0.0.1:<port>` on a fixed port range (47291–47299) and
forwards the same speaker-change events the content script already
produces. **No data ever leaves the user's machine through this
channel** — the desktop app's WebSocket server is bound to the
loopback interface only, validated with a per-machine token, and
rejects non-paired clients. Loopback hosts are placed in
`optional_host_permissions` so a Chrome Web Store install never
pre-grants access to the user's local machine — the bridge is
opt-in.

---

## Data usage disclosure (Chrome Web Store: "Privacy practices")

Tick the following on the developer dashboard "Data usage" form:

| Field | Selection | Why |
|---|---|---|
| Personally identifiable information | **Yes** | User's email + display name for the MeetMinutes account |
| Authentication information | **Yes** | Bearer token in `chrome.storage.local` (never transmitted except as the `Authorization` header on requests to the user's own MeetMinutes backend) |
| Personal communications | **Yes** | The meeting audio + video + screen capture the user explicitly opts to record |
| Website content | **Yes** | Participant names visible in the Meet/Teams tab DOM, used solely to label the user's transcript |
| User activity | **Yes** | Anonymous telemetry events (`recording_started`, `chunk_uploaded`, etc.) on an explicit allowlist — no clicks, no keystrokes, no page navigation tracking |
| Web history | **No** | |
| Financial information | **No** | |
| Health information | **No** | |
| Location | **No** | |

### Use of data certifications (all required for approval)
- ✅ I certify that this extension's use of data complies with the Chrome Web Store **Limited Use** requirements.
- ✅ I certify that user data is **not sold** to third parties.
- ✅ I certify that user data is **not used or transferred** for purposes unrelated to the extension's single purpose.
- ✅ I certify that user data is **not used or transferred** to determine creditworthiness or for lending purposes.

### Privacy policy URL
**Required.** The extension transmits audio/video and authentication
tokens; this triggers Chrome's mandatory privacy-policy requirement.

URL: `https://www.meetminutes.in/privacy-policy`

The policy must include the **literal Limited Use attestation**
(reviewer-checked):

> MeetMinutes' use of information received from Google APIs will
> adhere to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
> including the Limited Use requirements.

And must cover:
- What is collected (audio/video, screen capture, auth token, display name, speaker-name events, telemetry).
- Where it's stored (MeetMinutes backend on Google Cloud Mumbai region).
- Retention (per your terms — be explicit).
- Local-only storage of the bridge token (OS keyring) for the desktop-pairing feature.
- User rights (delete, export, contact support@meetminutes.in).

---

## Test instructions for reviewer (paste into "Notes for reviewer")

```
Tested on Chrome stable, fresh profile.

CREDENTIALS
Email: reviewer@meetminutes.in
Password: <provide a working pre-activated paid account>
This account is pre-upgraded to the Pro tier so the upgrade modal
isn't triggered during review.

HAPPY-PATH CLICK PATH (~3 minutes)
1. Install the extension and click its toolbar icon.
2. Sign in with the credentials above.
3. Open https://meet.google.com/new in a new tab.
4. Click the extension icon → press "Start Recording".
   • You should see a small "Recording" banner appear in the meeting
     tab and the popup state pill flip to "RECORDING".
5. Speak for ~30 seconds.
6. Press "Stop Recording".
   • A desktop notification appears when the upload finishes.
7. Open https://app.meetminutes.in/library — the new recording is
   listed with its transcript.

LIVE TRANSCRIPTION (~2 minutes)
1. Open a Google Meet tab.
2. Click the extension icon → "Transcribe" tab → "Start
   transcription".
3. A floating live-transcript overlay appears in the meeting tab.
4. Speak for ~30 seconds — words appear in the overlay as you talk.
5. Press "Stop transcription" to dismiss.

KEYBOARD SHORTCUTS
• Ctrl+Shift+R toggles recording on the active Meet/Teams tab.
• Ctrl+Shift+T toggles live transcription.

OPTIONAL — DESKTOP PAIRING (skip if not testing this surface)
This feature is off by default; the loopback host permission lives in
`optional_host_permissions` and is requested only when the user
ticks "Enable desktop pairing" in the extension Options page.
The MeetMinutes Desktop app is a separate install; download +
demo video link: <provide if you want this surface reviewed>.

PRICING / BILLING
The extension shows an "Upgrade Plan" modal when a free-tier user
clicks a Pro feature. The CTA opens
https://www.meetminutes.in/pricing in a new tab — all billing is
handled on the SaaS web app, never inside the extension.

If anything fails, please email support@meetminutes.in — we aim to
respond within 24 hours during the review window.
```

---

## Listing screenshots / video (REQUIRED — reviewers look for these)

Submit **all 5 screenshot slots at 1280×800** (full bleed, no padding,
no "Best/#1/Free/Award-winning" overlays). For a recording extension,
the reviewer specifically looks for visible consent UX in at least
one screenshot. Suggested set:

1. **Popup signed-in view, RECORDING state** — shows the red
   "Recording" pill, elapsed timer, speaker label, and stop button.
   This is the consent-UX screenshot reviewers look for.
2. **In-tab recording banner on a Google Meet tab** — proves the
   user is always told when capture is on.
3. **Live transcription overlay** showing real-time captions with
   speaker labels.
4. **MeetMinutes library page** (web app) showing a finished
   recording with transcript + AI summary.
5. **Options / Settings page** showing the audio bitrate dropdown,
   the desktop pairing toggle (off), and the Privacy / Terms links.

### Promo image (REQUIRED)
**440 × 280** small tile. Logo + 3–5 word tagline. No "Best", "#1",
"Free", "Award-winning", emojis, or competitor names. Optional
**1400 × 560 marquee** boosts category carousel placement.

### Walkthrough video (STRONGLY RECOMMENDED)
A 30–60 second YouTube clip showing the happy path above. Reviewers
who watch a video almost always approve on the first pass; reviewers
who have to reason about `tabCapture` + loopback from text alone
routinely come back with clarifying questions.

---

## Reviewer-empathy tactics (proven to reduce review time)

- **Submit Tue–Thu morning UTC.** Friday submissions sit until
  Monday.
- **Verified Publisher badge** — add your domain to the developer
  account before submission. Massive trust + ranking boost.
- **Pre-emptively answer the obvious questions** in the description
  ("Does it need a server-side bot?" "Where is audio stored?" "Is
  screen capture used?"). Already done in the description block
  above.
- **Disambiguate from generic "Meet Minutes"** — every reference
  uses the brand prefix "MeetMinutes".
- **Don't resubmit to reset the queue** — it restarts the clock and
  can flag the publisher account. If 3 weeks pass with no reply,
  file a one-stop-support ticket instead.

---

## Pre-submission checklist

### Code-side (this repo)
- [x] `manifest.json` version is `1.0.0`.
- [x] `DEFAULT_API_BASE_URL` points at production (`api.meetminutes.in`).
- [x] No `test-api` host in `host_permissions`.
- [x] No `identitytoolkit.googleapis.com` in `host_permissions` or CSP.
- [x] Loopback hosts moved to `optional_host_permissions`; bridge
      requests them at runtime via `chrome.permissions.request`.
- [x] `mailto:` support link is `support@meetminutes.in`, not a
      personal address.
- [x] Terms + Privacy Policy links live in the popup signin view.
- [x] No `console.debug` in hot paths.
- [x] No bundled `firebase/auth` SDK (Blue Argon-safe — auth is BFF).
- [x] AudioWorklets loaded via `chrome.runtime.getURL()` packaged
      paths only — never `blob:` or remote URLs.
- [x] No `setInterval` keepalive in the service worker — uses
      `chrome.alarms` only.
- [x] `vite.config.js` has `minify: false` — code stays readable for
      reviewers (CWS rejects obfuscated bundles).
- [x] Static audit (`node tests/integration/check-static.mjs`) green: 42/42.
- [x] Unit tests green: 699/699.
- [x] `dist/` rebuilt against the current manifest (`npm run build`).

### Listing-side (Chrome Web Store dashboard) — YOU MUST DO THESE
- [ ] Privacy policy live at `https://www.meetminutes.in/privacy-policy`
      with the Limited Use attestation verbatim.
- [ ] Terms page live at `https://www.meetminutes.in/terms` (or
      whatever URL you wire into the popup signin footer).
- [ ] 5 screenshots at 1280×800 (see list above).
- [ ] 440×280 promo tile.
- [ ] 30–60 s walkthrough video URL (YouTube unlisted is fine).
- [ ] Test account credentials in "Notes for reviewer".
- [ ] All Data Usage form fields ticked + Limited Use attestation.
- [ ] Submitter is on the same Google account that owns
      `meetminutes.in` in Search Console — claims the
      Verified Publisher badge.
- [ ] Single-purpose description = the one in this file (verbatim).
- [ ] Permission + host-permission justifications copy-pasted from
      the sections above.

### Rejection-code verifications (see "Rejection-code watchlist" below)
- [ ] **🔴 Red Nickel** — visually scan every screenshot PNG,
      the 440×280 promo tile, the marquee (if used), and the
      walkthrough video thumbnail for the banned words
      (Best / #1 / Top / Free / Award-winning / Editor's Choice /
      Number One / 100% claims). The bot OCRs image text.
- [ ] **🟡 Yellow Magnesium** — the dashboard description includes
      the Pricing section verbatim ("Free to install. Paid
      subscription tiers..."). The reviewer test account is on the
      Pro tier so the upgrade modal isn't triggered mid-review.

---

## What can still go wrong after submission

1. **Privacy-policy / Terms URL returns 404 mid-review** — reviewer
   refreshes; if it 404s, instant rejection. Verify both URLs are
   live and reachable without login, and STAY live for the full
   review window.
2. **Screenshots with "Free / Best / #1" overlay** — automated
   policy bot ("Red Nickel") flags them.
3. **Permission justification length mismatch** — if the dashboard
   form has, say, 250 chars and you paste the full paragraph above,
   it truncates. Keep each justification under ~250 chars in the
   form; this file is a backup with the full context.
4. **First submission with `tabCapture` + recording features will
   get manual review** — expect 5–14 days, not 3 days. Don't panic.
5. **Reviewer asks "what's the localhost permission for?"** — your
   reply: link to the `optional_host_permissions` section above +
   note that it's runtime-requested only on user opt-in.

---

## Rejection-code watchlist

Chrome's reviewer-side automated checks emit four-letter colour
codes when something looks off. The two that most often catch
recording extensions in 2025-2026 are below — verify each line
in the manual check column BEFORE you click Submit. Sources:
[dev.to rejection-code roundup](https://dev.to/bdilip48/chrome-web-store-rejection-codes-4hfj),
[Red Nickel audit (DEV)](https://dev.to/_350df62777eb55e1/how-to-avoid-chrome-web-store-red-nickel-rejection-what-i-found-after-auditing-18-extensions-gbg),
[Yellow Magnesium thread](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/tqJBTb4ncCU).

### 🔴 Red Nickel — banned promotional language

Triggered by superlatives in the **title, short description,
long description, screenshot overlays, or promo tile**. The bot
scans visual text inside images too, so a screenshot caption
saying "Best Meet recorder" gets flagged the same as a title
saying it.

| Surface | Manual check before submit |
|---|---|
| Title | ❌ No "Best", "#1", "Top", "Free", "Award-winning", "Editor's Choice", "Number One" |
| Short description | Same — and avoid "100%" claims ("100% private", "100% free") |
| Long description | Strip all of the above |
| Each of the 5 screenshots | **Open each PNG and visually scan the overlay text** — banned words in image-rendered text are the most common Red Nickel hit because authors forget the bot OCRs them |
| 440×280 promo tile | Same overlay scan |
| 1400×560 marquee (if used) | Same |
| Walkthrough video thumbnail | Same — YouTube thumbnails are reviewer-visible |

If you legitimately need to convey "free to install with paid
tiers", phrase it as **"Free to install. Paid subscription
tiers available on meetminutes.in/pricing."** — the bot
recognises this as pricing-table language and lets it through
(matches the long-description block above).

### 🟡 Yellow Magnesium — subscription gate not disclosed

Triggered when the dashboard description doesn't tell users
that key functionality is paid-only and they encounter a
paywall after install. The extension feels "deceptive" to the
bot's heuristic.

| Surface | Manual check before submit |
|---|---|
| Long description (Pricing section) | ✅ Already discloses: "Free to install. Paid subscription tiers are available on meetminutes.in/pricing for higher recording limits and AI features. Billing happens entirely on meetminutes.in; the extension does not process payments." |
| Upgrade modal copy in the popup | Modal title format must include the feature name + "is a premium feature" so the user sees WHY they're being redirected (already shipped — see `src/popup/popup.js` `openUpgradeModal`) |
| Test instructions for reviewer | ✅ Already provides a pre-activated Pro test account so the reviewer doesn't hit the modal mid-test |
| Privacy policy page (subscription mention) | Mention that subscription state is fetched from the backend and stored locally — this turns "undisclosed paywall" into "disclosed subscription gate" |
| Featured/Promotional badge | Don't claim "Free" in the promo tile if a free-tier user can't actually record (they can — your free tier permits recording, so this is fine for us) |

If a reviewer flags Yellow Magnesium anyway, respond with: "The
extension is fully usable on the Free tier (recording, live
transcription, upload). Paid tiers raise the meeting-length cap
and unlock advanced AI summaries on the meetminutes.in web app.
The Pricing section of the description and the upgrade modal
both disclose this; pre-activated Pro reviewer account is in the
Notes for reviewer."
