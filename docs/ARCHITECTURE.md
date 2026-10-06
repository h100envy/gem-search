# Architecture

## Browser boundary

`popup.js` handles explicit activation and local pairing. The service worker stores the pairing code in trusted extension storage, injects three packaged scripts using activeTab, and maintains a bounded outbox. There are no remote extension scripts and no broad `<all_urls>` permission.

`shared.js` extracts a post's rendered text, timestamp permalink and external anchors. `content.js` samples viewport tweet articles every 2.8 seconds without ending the session when the tab is hidden. A foreground sample captures one post; a background sample captures at most 20 rendered posts. `spider-ui.js` creates a shadow-root overlay and moves it toward the inspected card on a visible page; reduced-motion users get immediate movement. Explicit auto-scroll works in the background. An editor on the visible page suppresses scrolling, while collection continues.

The worker stores one explicitly started session in trusted local storage: its ID, selected tab and origin, auto-scroll choice, start time, and optional absolute deadline. The default is **Until I stop it**. Starting on another tab replaces the previous session. Popup Stop targets the stored tab, even when a different tab is active; overlay Stop/dismiss and disconnect also end that session. Content captures require the selected tab and current session ID. The deadline is checked before every capture as well as by content ticks and a dedicated alarm, so a delayed alarm cannot admit late captures.

A one-minute worker alarm samples the selected feed independently of visibility-throttled content timers. Missing content scripts are restored on same-origin feed reloads, using the existing activeTab grant; no X host permission is added. Worker suspension preserves the session and original deadline. Discarded, frozen or loading tabs show a waiting state and retain the session. A closed tab, excluded route, changed origin, or browser restart ends the session. Reopen the feed and explicitly start a new session after restarting the browser. Neither timers nor alarms wake a sleeping computer, and a discarded page cannot render posts until restored. Alarm timing is best effort, not a guaranteed sampling rate.

The outbox holds at most 200 items. A flush retries forwarding every minute while Chrome is running and after captures. Backend network requests run outside the serialized state operations, so a slow backend does not block Stop. Acknowledged IDs are removed from the current queue without overwriting newly captured posts. Disconnect invalidates in-flight flush responses. Stop prevents new collection; it does not delete or retract posts already queued or sent. Captures are idempotent by X status ID; a crash after backend acknowledgement can cause a harmless duplicate submission.

The extension currently expects the engine at `http://127.0.0.1:8787`. A custom backend port requires changing its BASE constant and dashboard links. Only those local endpoints receive captures; the browser never sends xAI credentials.

## Local engine

`Jev.ingest` validates a strict captured-post shape and writes it to SQLite before acknowledging. It rejects malformed/non-X permalinks and future timestamps. A single background loop handles batches of 20. Project links enter the cached crawler pipeline; narrative synthesis uses a rolling 24-hour sample with distinct-author and repetition checks.

The crawler is bounded to three pages per project, standard HTTP(S) ports and capped page sizes. Every DNS result must be globally routable; the TCP connection is pinned to a validated IP and TLS still verifies the requested hostname. Redirects re-enter validation. JavaScript is not executed. A page's content is evidence, never code or instructions.

Besides topics (built-in or a local `topics.json`), each pass extracts cashtags, Solana addresses that decode to 32 bytes, and two-word phrases repeated by at least three distinct authors in the last six hours outside the known topics. Every spider lead carries a 6h-versus-previous-18h growth rate and a first-seen time. Ticker, address and phrase leads are marked `research_only`, and the launch queue refuses them.

Four local checks always retain their own explanations. Optional Grok reviews are attached separately, and a missing/negative Grok review prevents an otherwise-positive candidate from becoming approved when Grok mode is enabled. A scan-wide mutex limits concurrent batches. HN is a separately labeled source with different explicit scoring rules.

## Grok boundary

Four role-specific Chat Completions requests run concurrently. Requests contain at most eight 1,200-character post excerpts and three 2,500-character page excerpts, plus bounded metadata. No browsing or code tools are provided. All model output is treated as untrusted; vote enums, fields and evidence IDs are validated locally.

The shared 24-hour request allowance is reserved atomically before a full review. Timeouts/errors remain charged to the allowance and become hold votes. The limit bounds call count, not xAI billing. Identical evidence/model reviews cache for 24 hours. The user must configure their own model/key; default model availability can change.

## API

| Route | Authorization | Purpose |
| --- | --- | --- |
| GET /api/state | Loopback, same-origin browser boundary | Local dashboard state and pairing code |
| GET /api/extension/status | X-Gem-Extension | Capture counts and nonsecret model status |
| POST /api/extension/ingest | X-Gem-Extension | Durably accept up to 20 posts |
| POST /api/demo, /api/import | X-Gem-Token | Dashboard research actions |
| POST /api/launch-control | X-Gem-Token | Pause/resume the separate optional queue |

Extension credentials cannot invoke dashboard actions. CORS headers are restricted to the extension API and Chrome extension origins, with a separate pairing key still required. The engine is a single-user local process, not a remotely authenticated service.

## Optional launch boundary

Browser findings stay research-only by default. Both SPIDER_ALLOW_LAUNCH=1 and a separately configured launch mode are needed to make them launch candidates. Grok cannot issue launch commands. The launcher consumes structured locally validated shortlist records and applies its own deduplication, quotas and transaction checks. See [AUTOLAUNCH.md](AUTOLAUNCH.md).
