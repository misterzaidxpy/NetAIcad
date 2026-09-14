# Auto Module Content Walker ("Module Unlock") — Design

## Problem

Netacad courses gate new modules behind completing every item (reading pages, videos, quizzes) in the current module. Manually clicking through every reading page and watching every video to unlock the next module is slow and tedious. The user wants a way to automate walking through the *non-quiz* content of a module so it marks complete and unlocks the next one, without having to babysit every page/video.

Live inspection of Netacad (during the Web AI quiz solver work) established two things relevant here:
- Completion is tracked via xAPI (`GET/POST /adl/data/{registration}/activities/state` and `POST /adl/data/{registration}/statements`), fired by Netacad's own course-player JS in response to real user interaction (scrolling, video playback events, navigation).
- Netacad's Angular-based custom UI widgets (confirmed on the quiz's `.mcq__item` radio buttons) reject synthetic JS `.click()` events — only genuinely trusted input (dispatched via CDP, e.g. through `chrome.debugger`) registers.

This spec covers automating the **content-walking** part only (reading pages + videos). Quiz answering is out of scope and already covered by the existing Web AI / API quiz-solve buttons (see `2026-09-14-web-ai-quiz-solver-design.md`).

## Explicit Decisions (from brainstorming)

- **Trigger:** manual button per module (not fully automatic on page load) — keeps the user in control of when it runs.
- **Extent per click:** walks the *current module* only, then stops (not the whole course).
- **Content types handled:** reading/text pages and videos. PDFs and interactive labs are out of scope for v1.
- **Hitting a quiz:** stop and hand off — notify the user to use the existing Get Answer / Web AI buttons. Never auto-answers or auto-submits a quiz.
- **Automation approach:** realistic simulated interaction (scroll, click Next, play videos) so Netacad's own tracking JS fires its own genuine xAPI calls — never direct xAPI/endpoint forgery. This was chosen over directly forging completion state because forged state is fragile (exact statement schema/timing must be reverse-engineered against a live production account), easy for server-side anomaly detection to flag (instant completion with no interaction trail), and a materially more serious form of academic dishonesty than AI-assisted quiz answering, since it falsifies the user's actual learning record under their real identity.
- **Trusted clicks:** where synthetic `.click()` doesn't register (same failure mode as the quiz radio buttons), fall back to `chrome.debugger`-dispatched trusted input events, attached/detached per click rather than held open for the whole run, to minimize how long Chrome's "this extension is debugging this tab" banner is visible. Requires adding the `debugger` permission to `manifest.json`.
- **Pacing:** fast fixed delay per reading page (a short constant pause, not scaled to reading time) — the user explicitly chose speed over maximal realism here.
- **Control while running:** a floating status/progress overlay ("Auto-Complete Module — Item 3/7") with a Stop button, always visible during a run.

## Scope

In scope:
- A `📖 Auto-Complete Module` button, shown only on Netacad course **content** pages (not quiz pages).
- Walking remaining (not-yet-completed) reading pages and videos in the current module, in outline order.
- A floating progress/Stop overlay while running.
- `chrome.debugger`-based trusted-click fallback for any click that a plain JS `.click()` doesn't register.

Out of scope (v1):
- PDFs, interactive labs/simulations, any content type other than reading pages and video.
- Chaining into subsequent modules automatically.
- Any quiz/exam interaction (answering, submitting, or skipping quiz items) — the walker stops when it reaches one.
- Any direct xAPI/endpoint state forgery.

## Architecture

### Detection (content.js)
- Add `checkForCourseContent()`, analogous to the existing `checkForQuiz()`, to detect a Netacad course content page (as opposed to a quiz page) and locate the module outline/sidebar element. Exact selectors to be confirmed via live DOM inspection (see "Implementation Prerequisite" below) before being written into code — not guessed.
- The existing quiz-detection `MutationObserver`/`initialize()` flow is extended to also check for course-content pages, injecting the `📖 Auto-Complete Module` button (styled consistently with the existing buttons) when detected, instead of the quiz-solve buttons.

### Orchestration (background.js)
- New message action `startModuleWalk` / `stopModuleWalk`, mirroring the existing `getAnswer` message pattern.
- A per-tab in-memory run state (`{ tabId, running, currentIndex, items }`) so a `stopModuleWalk` message can cancel an in-flight run cleanly between items.
- For each remaining outline item, `background.js` drives the content script (via `chrome.scripting.executeScript` calls or ongoing message round-trips) through the following per-item loop:
  1. Navigate to / open the item (click its outline entry).
  2. Wait for its content to render (fixed short timeout).
  3. If it's a reading page: scroll through it, wait the fixed fast delay, then click "Next"/advance.
  4. If it's a video: mute it, increase `playbackRate`, call `.play()`, wait for the `ended` event or a timeout, then advance.
  5. If it's a quiz/exam: stop the run, report "reached a quiz" back to `content.js` for the overlay, and end.
  6. Report progress (`currentIndex`/`total`) back to `content.js` after each item so the overlay updates.
- Any click in this loop that doesn't visibly register (element state doesn't change after a synthetic `.click()`) retries once via `chrome.debugger`: `chrome.debugger.attach({tabId}, '1.3')` → `Input.dispatchMouseEvent` (mousePressed + mouseReleased at the element's coordinates) → `chrome.debugger.detach({tabId})`, all around that single click, not held open across the run.

### UI overlay (content.js / content.css)
- A small fixed-position panel (reuses the existing helper-button visual style/family) showing `Auto-Complete Module — Item {n}/{total}` and a `Stop` button.
- Updated via runtime messages from `background.js` as each item completes.
- On completion, error, or reaching a quiz, the panel shows a final one-line status (e.g. "Done — 7/7 items completed", "Stopped by user", "Reached a quiz — use Get Answer to continue", "Couldn't find the module outline") for a few seconds, then removes itself.

### Manifest changes (manifest.json)
- Add `"debugger"` to `permissions`.

## Data Flow (per run)

1. User clicks `📖 Auto-Complete Module` on a course content page.
2. `content.js` reads the outline/sidebar to build an ordered list of not-yet-completed items in the current module, sends `startModuleWalk` with that list (or lets `background.js` re-derive it — TBD at plan time based on what's simpler given the real DOM), and shows the overlay at item 0.
3. `background.js` processes items one at a time as described above, sending progress/status messages back after each item.
4. `content.js` updates the overlay on each progress message.
5. Run ends via: all items done, a quiz reached, an unrecoverable error, or the user clicking Stop (sends `stopModuleWalk`, checked between items).

## Error Handling

- **Outline/sidebar not found** (selectors don't match — UI changed): don't start the run; overlay shows "Couldn't find the module outline" immediately.
- **Single item times out** (page/video never finishes loading or playing within its timeout): skip that item, log it (console + counted in the final summary as "N items skipped"), continue with the next item rather than aborting the whole run.
- **Click doesn't register even after the `chrome.debugger` fallback**: treat like an item timeout — skip and continue.
- **Reaches a quiz/exam item**: not an error — stop by design, clear message directing the user to the existing quiz-solve buttons.
- **User clicks Stop**: checked between items (not mid-action); run ends with "Stopped by user" status, no partial/half-done item state left behind.

## Testing

- Live Chrome DevTools MCP inspection of a real, logged-in Netacad course content page (reading page + video) is required *before* writing the implementation plan, to replace the placeholder selector assumptions above with real ones — same approach used for the Gemini web selectors in the prior spec.
- Manual test plan once implemented:
  1. Open a module with several unread reading pages and at least one video; click `📖 Auto-Complete Module`.
  2. Confirm the overlay appears and progresses item-by-item, and that the sidebar's own completion checkmarks update as items are walked (proof that Netacad's real tracking fired, not a forged state).
  3. Click Stop mid-run; confirm it halts cleanly between items and the overlay reports "Stopped by user".
  4. Run it again on a module that ends in a quiz; confirm it stops there with the correct handoff message and does not touch the quiz.
  5. Verify the next module unlocks after all reading/video items in the current module are genuinely marked complete.

## Non-goals / Explicit Decisions (recap)

- No direct xAPI/state forgery, ever.
- No quiz answering/submission as part of this feature.
- No automatic chaining into the next module in v1 — one module per click.
- `chrome.debugger` is attached/detached per click, not held open for the whole run.
