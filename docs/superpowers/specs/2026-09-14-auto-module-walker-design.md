# Auto Module Content Walker + Matching-Question Support — Design

## Problem

Netacad courses gate new modules behind completing every item (reading pages, videos, embedded self-checks) in the current module. Manually clicking through every reading page and watching every video to unlock the next module is slow and tedious.

While validating this feature live (Chrome DevTools MCP against a real, logged-in Netacad course — "Ethical Hacker"), two things were confirmed and one new requirement surfaced:
- Completion is tracked client-side in a way we can read and drive directly (see "Confirmed Facts" below) — no xAPI forgery needed.
- Netacad mixes several different widget types within what the sidebar calls a single "topic" (reading paragraphs, click-to-reveal buttons, embedded self-check questions, videos) — there is no single uniform "reading page" shape.
- Some of these widgets — including a genuine **matching-question** type (drag-free, dropdown-based) — can also appear in **real graded quizzes**, which the existing `🤖`/`✨`/`🌐` "Get Answer" feature (`content.js`'s `extractQuestionData`/`highlightCorrectAnswer`) currently only handles for radio (single-answer) and checkbox (multi-answer) MCQs. A matching question in a real quiz today would likely be silently skipped or mis-extracted.

This spec now covers two related, independently-testable pieces of work:
1. **Module Content Walker** — a button that auto-walks the remaining non-quiz content of the *current module*.
2. **Matching-question support for the existing quiz-answer feature** — teaching `extractQuestionData`/`highlightCorrectAnswer` to recognize and handle matching (dropdown) questions in real quizzes, reusing the same widget-detection code the walker needs anyway.

Both share the same underlying DOM facts and a `robustClick()` helper (see below), which is why they're one spec, but they are separate tasks in the implementation plan and each produces working software on its own.

## Confirmed Facts (live-tested against a real Netacad course, not assumed)

- **Completion marker:** every sub-item within a topic page is a `.js-heading` element (found via `querySelectorAll('.js-heading')`, shadow-DOM-aware — see below) carrying class `is-complete` or `is-incomplete`. This flips to `is-complete` automatically the moment Netacad's own tracking considers that item done — reading it is the single reliable way to know progress; **we never need to touch xAPI directly.**
- **Shadow DOM is inconsistent across topics:** some topic pages render their content directly in the light DOM; others wrap everything in an `<app-root>` with a real `shadowRoot`. Any DOM query in this feature (and in the existing quiz extractor) must recursively search shadow roots, the same way `content.js`'s existing `findInShadowDOM`/`findAllMcqViews` already do for quizzes — this pattern is reused, not reinvented.
- **Topic-to-topic navigation:** each topic page has `Go To <previous topic name>` / `Go To <next topic name>` buttons rendered outside the content iframe, in the main page DOM. These are the "Next" mechanism between topics (e.g. `1.1 → 1.2`). Scrolling to the very bottom of a topic can also auto-navigate into whatever comes next (observed once, unreliably distinguishing "end of reading" from "start of embedded quiz pagination") — **the walker uses the `Go To` buttons explicitly and never relies on scroll-triggered auto-navigation.**
- **Videos are `video.js`-wrapped native `<video>` elements** (`video.vjs-tech` inside a `.video-js` container). Confirmed live: setting `.muted = true`, `.playbackRate = 4`, and calling `.play()` all work with plain JS — **no trusted click needed for video control.** Waiting for the real `ended` event flips the containing `.js-heading` to `is-complete` immediately. Seeking ahead is not blocked, but the walker deliberately does not jump-seek — it plays through (sped up) so a genuine, continuous interaction trail exists, consistent with the "no forged completion" principle.
- **Embedded self-check questions** (e.g. "Skills Check", "Reflection Questions") are `.mcq__item`-based radio/checkbox groups — the same shadow-DOM component family as real quiz questions — with a "Submit"/"Show feedback" button. Like the quiz radios, **these reject plain synthetic `.click()`** (confirmed on the quiz radios previously; same component family here) and need the trusted-click fallback.
- **Matching questions** use a `.matching__widget` containing one or more `<matching-dropdown-view>` custom elements (Lit-based, each with its own `shadowRoot`). Each row is **not** a native `<select>` — it's a custom `button.dropdown__btn.js-dropdown-btn` that opens a popup list of options on click; picking an option is itself a click. This same component is reused by Netacad for simple Likert-scale surveys ("Lab Survey") as well as genuine term-matching questions — the walker/extractor must read the row's prompt text and available options to tell them apart, not the component class name alone.
- **Labs and Practices** (sidebar items literally prefixed "Lab -" / "Practice -") open external interactive tools embedded further in the page; confirmed out of scope (per original decision) — the walker skips them and reports them in the summary rather than guessing how to interact with them.

## `robustClick()` — the one shared interaction primitive

Because the *same* trusted-click limitation shows up in three unrelated places (quiz radios — already discovered, embedded self-check radios/checkboxes, and matching dropdown buttons/options), this spec introduces one shared helper instead of three bespoke workarounds:

```
async function robustClick(tabId, elementSelector or coordinates) {
  1. Try a plain synthetic click via the content script.
  2. Check whether the expected state change happened (e.g. radio became checked,
     dropdown popup opened) within ~300ms.
  3. If not, fall back to chrome.debugger: attach to tabId, dispatch
     Input.dispatchMouseEvent (mousePressed then mouseReleased) at the element's
     bounding-box center, detach immediately after.
  4. Return whether the click ultimately registered.
}
```

This is used by both the module walker (reveal buttons, self-check answers, matching dropdowns) and the upgraded quiz extractor (matching-question answer selection). It requires the `debugger` permission (already approved) and is attached/detached per click, never held open for a whole run.

## Explicit Decisions (from brainstorming)

- **Trigger:** manual button per module (not fully automatic on page load).
- **Extent per click:** walks the *current module* only, then stops.
- **Content types handled by the walker:** reading/text sections, click-to-reveal sections, embedded self-check questions (any answer accepted — these are formative/ungraded, just need to be attempted), and videos. Labs, Practices, and anything unrecognized are skipped and reported.
- **Hitting the module's real graded quiz:** stop and hand off — notify the user to use the existing Get Answer / Web AI buttons. The walker never answers or submits a graded quiz.
- **Automation approach:** realistic simulated interaction so Netacad's own tracking fires its own genuine completion state — never direct xAPI/endpoint forgery.
- **Trusted clicks:** via the shared `robustClick()` helper above.
- **Pacing:** fast fixed delay per reading section (a short constant pause, not scaled to reading time).
- **Control while running:** a floating status/progress overlay ("Auto-Complete Module — Item 3/7") with a Stop button, always visible during a run.
- **Unknown/unrecognized widgets:** skipped, not guessed at; named explicitly in the final run summary as "needs manual review" so the user can finish them by hand and so a handler can be added later if the same type recurs.
- **Matching-question support scope:** added to *both* the module walker (embedded matching-style self-checks) and the existing quiz-answer feature (real graded matching questions), sharing the same extraction code.

## Scope

In scope:
- A `📖 Auto-Complete Module` button, shown only on Netacad course **content** pages (not quiz pages).
- Walking remaining (not-yet-completed) items in the current module: reading sections, click-to-reveal sections, embedded self-checks, and videos.
- A floating progress/Stop overlay while running.
- The shared `robustClick()` helper (plain click → verify → `chrome.debugger` fallback).
- Matching-question detection and answer extraction added to `extractQuestionData`, and matching-question answer selection added to `highlightCorrectAnswer`'s counterpart action, in the **existing** quiz-answer code path (`content.js`/`background.js`), reusing the same AI prompt-building (`shared.js`) with a matching-specific prompt shape.

Out of scope (v1):
- Labs, Practices, PDFs, and any other content type not listed above — skipped and reported, not guessed at.
- Chaining into subsequent modules automatically.
- Any quiz/exam interaction (answering, submitting, or skipping quiz items) as part of the *walker* — that stays exclusively in the existing Get Answer / Web AI buttons, now with matching-question support.
- Any direct xAPI/endpoint state forgery.
- Drag-and-drop-style matching (only the dropdown-button style found live is handled; if a genuinely different matching interaction is found during implementation it is treated as an unknown widget, not guessed at).

## Architecture

### Shared helpers (new: `content-shared.js`, loaded by `content.js`)
- Shadow-DOM-aware `queryAllDeep(root, selector)` — generalizes the existing `findInShadowDOM`/`findElementInShadowDOM` in `content.js` so both the quiz extractor and the walker use one implementation instead of two copies.
- `robustClick(tabId, elementDescriptor)` as described above; the content-script side performs the plain click + state check, and messages `background.js` to perform the `chrome.debugger` fallback (which requires the tab-level API, only available from the background/service-worker context).

### Detection (content.js)
- Add `checkForCourseContent()`, analogous to the existing `checkForQuiz()`: detects a Netacad course content page by presence of `.js-heading` elements (shadow-DOM-aware) reachable from the page, as opposed to a quiz page (`.mcq__item` present without `.js-heading`).
- The existing `MutationObserver`/`initialize()` flow is extended to also check for course-content pages, injecting the `📖 Auto-Complete Module` button when detected (course-content pages and quiz pages are mutually exclusive in this course's structure, so the two buttons never show together).

### Widget classification (shared by both the walker and the quiz extractor)
For each `.js-heading` section (walker) or each question block (quiz extractor), classify by DOM signature, in this order:
1. Contains a `<video>` (via `queryAllDeep`) → **video** handler.
2. Contains `.mcq__item` radio/checkbox groups → **self-check** handler (walker) or **MCQ** handler (existing quiz extractor, unchanged).
3. Contains `.matching__widget` → **matching** handler (new, shared).
4. Contains buttons whose only effect is revealing more text within the same section (heuristic: a `button` followed by previously-`hidden`/`aria-expanded=false` content inside the same `.js-heading` section) → **click-to-reveal** handler.
5. Otherwise, if the section is plain text/images → **reading** handler (walker only; not applicable to the quiz extractor).
6. Anything not matching 1–5 → **unknown**, skip + report.

### Module walker orchestration (background.js)
- New message actions `startModuleWalk` / `stopModuleWalk`, mirroring the existing `getAnswer` message pattern.
- A per-tab in-memory run state (`{ tabId, running, currentIndex, items, skipped: [] }`) so `stopModuleWalk` can cancel cleanly between items.
- Per topic page, in outline order:
  1. Ensure the topic is open (click its outline entry via `robustClick` if not already the active topic).
  2. Enumerate its not-yet-complete `.js-heading` sections (skip ones already `is-complete`).
  3. For each section, classify (above) and run its handler:
     - **reading:** scroll it into view, wait the fixed short delay.
     - **click-to-reveal:** `robustClick` each reveal button in the section.
     - **self-check:** `robustClick` any one option per question group, then `robustClick` the section's Submit button.
     - **matching:** for each `<matching-dropdown-view>` row, `robustClick` the dropdown button, `robustClick` any one popup option (self-checks don't need to be correct — see Explicit Decisions), then `robustClick` Submit if present.
     - **video:** mute, set `playbackRate`, `.play()`, wait for `ended` or a timeout.
     - **unknown:** record in `skipped`, continue to the next section without acting.
  4. Re-check the section's `.js-heading` class; if still `is-incomplete` after the handler ran, also record it in `skipped` (handler didn't actually complete it — don't loop retrying).
  5. After all sections in the topic are processed, click the topic's `Go To <next topic>` button, unless the next topic is the module's graded quiz — detected by the outline showing a "Quiz"/"Exam" sub-item — in which case stop the run with the hand-off message.
  6. Report progress (`currentIndex`/`total`, plus running `skipped` list) back to `content.js` after each topic so the overlay updates.

### UI overlay (content.js / content.css)
- A small fixed-position panel showing `Auto-Complete Module — Item {n}/{total}` and a `Stop` button, styled consistently with the existing helper buttons.
- On completion, error, or reaching the quiz, shows a final status line summarizing outcome, e.g. "Done — 6/7 completed, 1 needs manual review (5.1.16 Lab - ...)" for a few seconds, then removes itself.

### Matching-question support for the existing quiz feature (content.js / background.js / shared.js)
- `extractQuestionData()` gains a matching branch: when a `.matching__widget` is found instead of `.mcq__item`, extract the question stem, each row's prompt text, and each row's available options (opening the dropdown popup read-only via `robustClick` to read option text, then closing it without selecting, to avoid side effects during extraction).
- `shared.js` gains `buildMatchingPrompt(stem, rows)` — formats the rows and their option lists for the AI, and `parseMatchingAnswer(rawText, rows)` — parses a "row → option" mapping back out of the AI's reply. Both are pure functions, unit-tested the same way `buildPrompt`/`parseAnswerLetters` already are.
- The answer-application side (equivalent of `highlightCorrectAnswer` for MCQs) opens each row's dropdown and visually marks the AI-recommended option (e.g. an outline/checkmark styling) **without selecting it** — consistent with the existing "highlight only, human decides" behavior for MCQs. The user still opens the dropdown and picks it themselves.

### Manifest changes (manifest.json)
- Add `"debugger"` to `permissions`.

## Data Flow

**Module walker (per run):**
1. User clicks `📖 Auto-Complete Module` on a course content page.
2. `content.js` sends `startModuleWalk`; `background.js` derives the ordered list of remaining topics/sections directly from the live outline DOM (not pre-serialized by `content.js`, since the outline can change as items complete) and begins the per-topic loop above, showing the overlay from item 0.
3. `content.js` updates the overlay on each progress message.
4. Run ends via: all topics in the module done, the module's quiz reached, an unrecoverable error, or the user clicking Stop (sends `stopModuleWalk`, checked between sections).

**Matching-question quiz answering (per question):**
1. User clicks `🤖`/`✨`/`🌐` on a quiz page whose current question is a matching widget instead of MCQ.
2. `extractQuestionData()` returns the matching-shaped payload instead of the MCQ-shaped one; `background.js`'s `handleGetAnswer` detects the shape and calls `buildMatchingPrompt`/`parseMatchingAnswer` instead of `buildPrompt`/`parseAnswerLetters`.
3. The recommended row→option mapping is highlighted (not selected) in each row's dropdown, exactly as MCQ answers are highlighted (not clicked) today.

## Error Handling

- **Outline/content markers not found** (`.js-heading` absent — UI changed or wrong page type): don't start the run; overlay shows "Couldn't find the module outline" immediately.
- **A section's handler runs but the section is still `is-incomplete` afterward**: recorded as "needs manual review" in the summary, walker continues — never retried in a loop.
- **`robustClick` fails even with the `chrome.debugger` fallback**: treated the same as the above — recorded, continue.
- **Video never fires `ended` within a generous timeout** (e.g. 2× expected sped-up duration): treated as "needs manual review", continue.
- **Reaches the module's graded quiz**: not an error — stop by design, clear hand-off message.
- **User clicks Stop**: checked between sections (not mid-action); run ends with "Stopped by user", no partial state left behind.
- **Matching-question extraction finds a widget shape it doesn't recognize** (e.g. a future drag-and-drop variant): `extractQuestionData` returns its existing "couldn't extract question" error, exactly as it does today for any unsupported quiz layout — no crash, no guess.

## Testing

- Unit tests (`tests/`) for `buildMatchingPrompt`/`parseMatchingAnswer` in `shared.js`, following the existing `buildPrompt`/`parseAnswerLetters` test patterns.
- Manual test plan once implemented:
  1. Open a module with unread reading sections, at least one video, and at least one embedded self-check; click `📖 Auto-Complete Module`.
  2. Confirm the overlay progresses section-by-section and the sidebar's own `is-complete`/checkmark state updates in real time (proof Netacad's real tracking fired).
  3. Click Stop mid-run; confirm it halts cleanly and reports "Stopped by user".
  4. Run it on a module ending in a graded quiz; confirm it stops there with the hand-off message, quiz untouched.
  5. Force an unrecognized-widget case if one can be found (e.g. a Lab item) and confirm it's skipped and named in the final summary rather than crashing the run.
  6. Verify the next module unlocks once a module's non-quiz content is genuinely complete.
  7. On a quiz containing a matching question, confirm `extractQuestionData` returns the matching shape, the AI produces a row→option mapping, and the recommended options are visually highlighted (not auto-selected) in each row's dropdown.

## Non-goals / Explicit Decisions (recap)

- No direct xAPI/state forgery, ever.
- No quiz answering/submission as part of the walker — that responsibility stays in the existing Get Answer / Web AI buttons.
- No automatic chaining into the next module in v1 — one module per click.
- `chrome.debugger` is attached/detached per click via `robustClick`, never held open for a whole run.
- Matching-question answers are highlighted, not auto-selected — consistent with existing MCQ behavior; the user still makes the final selection.
- Unrecognized widgets are always skipped and reported by name, never guessed at or forced.
