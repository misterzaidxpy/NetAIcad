# Web AI Quiz Solver (No-API-Key Fallback) — Design

## Problem

`netAIcad` currently answers Netacad quiz questions by calling the OpenAI or Gemini **API** directly from `background.js`, using a user-supplied API key (`popup.js` / `chrome.storage.sync`). Students without a paid OpenAI key rely on Gemini's free tier, which rate-limits after ~10 requests/minute — too slow for solving a full quiz quickly.

A working reference for a rate-limit-free alternative exists in `D:/Projects/AutoQuizSolver` (a separate PyQt5 + Playwright desktop app called "SolveX", VULMS-focused). Its `legacy_files/quiz_bot.py` and `core/ai_engine.py` automate an already-open, already-logged-in `chatgpt.com` tab via Chrome DevTools Protocol: type the question into the chat box, wait for the reply to finish streaming, scrape the assistant's last message, parse out the answer letter. This uses the free ChatGPT web session (no API key, no per-token billing), so it never hits API rate limits the way the Gemini API does.

This spec ports that mechanism into the `netAIcad` Manifest V3 extension, natively (via `chrome.scripting.executeScript`, no Playwright/CDP needed), and extends it to support **both** ChatGPT web and Gemini web as user-selectable targets.

## Scope

In scope:
- A new, independent way to get an answer by automating a real, visible ChatGPT or Gemini web tab.
- UI: one new `🌐 Web AI` button + a small dropdown (default: ChatGPT, switchable to Gemini) next to the existing `🤖 Get Answer from GPT` / `✨ Get Answer from Gemini` buttons.
- Manifest permission additions for `chatgpt.com` and `gemini.google.com`.

Out of scope (future work, separate spec):
- Auto-unlocking/auto-completing Netacad modules (the "module unlock" feature mentioned by the user — will get its own brainstorming pass).
- Auto-submit / auto-advance to the next question (existing buttons only highlight; this feature matches that behavior — see "Non-goals" below).
- Any change to the existing OpenAI/Gemini API code paths in `background.js` (`getAnswerFromOpenAI`, `getAnswerFromGemini` stay untouched and are reused as prompt-building helpers, not replaced).

## Architecture

### UI (content.js / content.css)
- A third button `🌐 Web AI` is added next to the existing two, using the same `.ai-helper-button` base style (new class `.ai-helper-button-webai`, distinct color, positioned below the Gemini button).
- A small `<select>` (id `netacad-ai-webai-select`) sits next to/above it with two options: `ChatGPT` (default, `value="chatgpt"`) and `Gemini` (`value="gemini"`). Selecting an option just changes which site the button targets on the next click; it does not immediately open anything.
- Clicking `🌐 Web AI` reuses the exact same `extractQuestionData()` / `highlightCorrectAnswer()` functions already in `content.js` — only the "get the answer" step is new. This means multi-answer detection, shadow-DOM extraction, and highlighting logic are shared and unmodified.
- Click handler sends `chrome.runtime.sendMessage({ action: 'getAnswer', modelType: 'chatgpt-web' | 'gemini-web', question, options, isMultipleAnswer, requiredAnswers })` — same message shape as today, just two new `modelType` values.

### Background orchestration (background.js)
New functions alongside the existing `getAnswerFromOpenAI` / `getAnswerFromGemini`:

- `ensureWebAiWindow(site)` — `site` is `'chatgpt'` or `'gemini'`. Looks up a remembered `{windowId, tabId}` (kept in a module-level in-memory object, keyed by site; service workers can be evicted, so on lookup it also calls `chrome.windows.get`/`chrome.tabs.get` to confirm the window/tab still exists before reusing it — if not, it creates a new one).
  - Creates window via `chrome.windows.create({ url: SITE_URLS[site], type: 'normal', focused: false, state: 'normal', width: 480, height: 700 })` — a separate, normal-sized, **visible** window (not minimized), not stealing focus from the quiz tab. Positioned to the side (top-right of the screen) so it doesn't overlap the quiz window.
  - Waits for the tab to reach `status: 'complete'` (via a one-time `chrome.tabs.onUpdated` listener with timeout) before returning, since a freshly created tab needs to finish loading before scripts can be injected.
- `askWebAi(site, prompt)` — calls `ensureWebAiWindow(site)`, then `chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: <site-specific injected function>, args: [prompt] })`, and returns the scraped answer text. Injected function is `async` — `executeScript` awaits it and returns its resolved value.
- Two injected functions, `chatgptWebAutomation(prompt)` and `geminiWebAutomation(prompt)`, each doing: find input → clear/focus → insert prompt text → click send (or press Enter as fallback) → poll every 1s (45s timeout) until the "generating" indicator disappears → read the last assistant message → return its trimmed text. (See "ChatGPT selectors" and "Gemini selectors" below.)
- `handleGetAnswer` (existing dispatcher in `background.js`) gets two new branches for `modelType === 'chatgpt-web'` and `modelType === 'gemini-web'`:
  1. Build the same lettered prompt used today (extract the prompt-building logic already inside `getAnswerFromGemini`/`getAnswerFromOpenAI` into a shared `buildPrompt(question, options, isMultipleAnswer, requiredAnswers)` helper, reused by all four code paths — API and web).
  2. Prepend a fixed instruction: `"Ignore all previous questions and answers in this conversation. Treat the following as a brand-new, unrelated question.\n\n"` (mitigates the context-bleed risk of reusing one long conversation, per user's choice to reuse rather than start fresh chats).
  3. Call `askWebAi(site, prompt)`, get back raw text.
  4. Parse the letter(s) out of the raw text using the same regex-based letter extraction already used for Gemini/OpenAI (extract that into a shared `parseAnswerLetters(text, options, isMultipleAnswer, requiredAnswers)` helper).
  5. Return `{ success: true, answerIndex }` in the same shape as today — `content.js`'s highlighting code needs zero changes.

### Manifest changes (manifest.json)
- Add permissions: `"scripting"`, `"tabs"`.
- Add host permissions: `"https://chatgpt.com/*"`, `"https://gemini.google.com/*"`.

### Popup (popup.html / popup.js)
- Add a short help note: "Web AI (no API key): uses a real ChatGPT/Gemini tab. You must be logged in there." Optionally a button "Open ChatGPT / Gemini tab now" that just calls `ensureWebAiWindow` proactively so the user can log in before their first quiz question — deferred as a nice-to-have, not required for v1 (v1: if not logged in, the error message tells the user what to do).

## Selectors

### ChatGPT (`chatgpt.com`) — ported directly from the validated `legacy_files/quiz_bot.py` / `core/ai_engine.py` reference:
- Input: `#prompt-textarea`, fallback `[contenteditable="true"][id*="prompt"]`, fallback `div[contenteditable="true"]`.
- Send: `[data-testid="send-button"]`, fallback `button[aria-label="Send prompt"]`, fallback `button[aria-label="Send"]`, final fallback: press `Enter`.
- Streaming indicator (still generating): `[data-testid="stop-button"]` or `button[aria-label="Stop generating"]` or `button[aria-label="Stop streaming"]` present.
- Response: last element matching `[data-message-author-role="assistant"]`, fallback `.markdown.prose`, fallback `.agent-turn`.

### Gemini (`gemini.google.com`) — **not yet validated**; the legacy reference never automated Gemini's web UI. Before writing `geminiWebAutomation`, I will use the Chrome DevTools MCP tool against your actual logged-in Chrome to inspect the live DOM and confirm real selectors (Gemini's input is a `rich-textarea`/`contenteditable` custom element, and its structure differs meaningfully from ChatGPT's). Placeholder selectors will not be committed — this inspection happens during implementation, before the Gemini code path is written, and the plan will include it as an explicit step.

## Data Flow (per question)

1. User clicks `🌐 Web AI` on a Netacad quiz (dropdown already set to ChatGPT or Gemini).
2. `content.js` extracts question/options (existing code, unchanged) → sends `getAnswer` message with the chosen `modelType`.
3. `background.js` builds the prompt, ensures the target site's window/tab exists and is loaded, injects the automation function, and awaits the scraped reply.
4. Reply is parsed into option index/indices using the existing regex-based parser.
5. `{ success, answerIndex }` returned to `content.js`, which highlights the answer(s) exactly as it does for the API-based buttons today.

## Error Handling

- **Not logged in** (automation detects the input box is missing or a sign-in page is shown): return `{ success: false, error: "Please log in to ChatGPT/Gemini in the Web AI window, then try again." }`. Never silently fail.
- **Response timeout** (45s, no matching selectors found / generation never finishes): return a clear timeout error; the window/tab is left open (not closed) so the user can see what happened.
- **Selector not found at all** (site changed its UI): return an explicit "couldn't find the input box / response — the site's UI may have changed" error, logged to console with full DOM context for future debugging.
- **User closes the Web AI window mid-session**: next click on `🌐 Web AI` transparently recreates it (per `ensureWebAiWindow`'s existence check).
- **`executeScript` injection failure** (e.g., tab navigated away from the target site): detect via the injected function's absence of expected elements, treat as "not logged in / wrong page" error above, and navigate the tab back to the correct URL before retrying once.

## Testing

- Before writing `geminiWebAutomation`, use the Chrome DevTools MCP tool (attached to a real, logged-in Chrome session) to inspect `gemini.google.com`'s live chat DOM and pin down robust selectors (prefer `aria-label`/role attributes over generated class names, matching the ChatGPT approach).
- Manual test plan once implemented:
  1. Load the unpacked extension, open a real Netacad quiz.
  2. Click `🌐 Web AI` with ChatGPT selected — confirm a visible window opens (or reuses an existing one), the question is typed and sent, and the correct option is highlighted.
  3. Repeat 5+ times in a row on different questions to confirm the same window/tab is reused and no rate-limit-style failures occur.
  4. Switch the dropdown to Gemini and repeat.
  5. Log out of ChatGPT/Gemini in the automation window and confirm the extension surfaces the "please log in" error instead of hanging or crashing.
  6. Close the automation window manually mid-quiz and confirm the next click recreates it.

## Non-goals / Explicit Decisions

- No auto-submit/auto-advance — matches current button behavior (highlight only); user still clicks the actual answer and Next.
- One long-lived conversation per site is reused across the whole session (not a fresh chat per question), per explicit user preference — mitigated with a per-message "ignore previous context" instruction, not eliminated.
- The Web AI window is a separate, visible, unfocused browser window (not a background/minimized tab) so the user can watch it work, per explicit user preference.
