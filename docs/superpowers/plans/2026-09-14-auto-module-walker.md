# Auto Module Content Walker + Matching-Question Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `📖 Auto-Complete Module` button that auto-walks the remaining reading/video/self-check content of the current Netacad module, and teach the existing AI quiz-answer feature to also handle matching (dropdown) questions.

**Architecture:** Everything runs from the existing `content.js` content script — no new files, no new background-driven orchestration loop. The module walker's whole loop (enumerate topics → open each → walk its `.js-heading` sections → classify and handle each) runs directly in `content.js`, because the course-content iframe is same-origin and already reachable via `iframe.contentDocument`. `background.js` is only involved for two things: the existing AI API/Web-AI calls, and a new `chrome.debugger`-based trusted-click fallback (`robustClickCdp`) used when a plain synthetic click doesn't register (confirmed live on Netacad's Angular radio/self-check components).

**Tech Stack:** Vanilla JS, Chrome Manifest V3 (content script + service worker), `chrome.debugger` CDP API, `node:test`/`node:assert` for the pure-logic unit tests in `shared.js`.

## Global Constraints

- This project has no test framework/dependencies beyond Node's built-in `node:test` (no `package.json`, no jsdom). Pure-logic functions (prompt building, answer parsing) live in `shared.js` and get real `node --test "tests/*.test.js"` coverage. DOM-manipulation code in `content.js`/`background.js` has no automated tests in this codebase — verify it with the manual test steps in each task below, exactly like the existing (untested) `chatgptWebAutomationInPage`/`geminiWebAutomationInPage` functions already in `background.js`.
- Reuse the existing `findInShadowDOM(selector, root = document)` helper (already in `content.js`) for every shadow-DOM-aware query in this feature. Do not write a second, duplicate shadow-DOM-search helper.
- `robustClick`'s `chrome.debugger` fallback assumes at most one level of iframe nesting (confirmed live: the course-content iframe is not itself further nested). This is a known, acceptable scope limit — document it in a code comment, don't generalize further.
- The Netacad sidebar/outline UI uses CSS-Modules-generated class names with random build hashes (e.g. `nodeInfoContainer--V7fAp`) — these are **not stable** across deployments and must never be hardcoded as selectors. Use `textContent`/attribute matching for anything in the outline sidebar instead. The classes used *inside* the course-content iframe (`js-heading`, `mcq__item`, `matching__widget`, `matching-dropdown-view`, `dropdown__btn`, `js-dropdown-btn`, `dropdown__item`, `video-js`, `vjs-tech`) are stable, semantic, author-controlled classes confirmed live across multiple modules — these are safe to hardcode.
- Follow existing code style: `console.log`/`console.error` with the same emoji-prefixed logging convention already used in `content.js` and `background.js`.

---

## Task 1: Matching-question prompt/parse helpers in `shared.js`

**Files:**
- Modify: `shared.js`
- Modify: `tests/shared.test.js`

**Interfaces:**
- Produces: `buildMatchingPrompt(rows)` where `rows` is `Array<{ prompt: string, options: string[] }>`, returns a prompt string.
- Produces: `parseMatchingAnswer(rawText, rows)` where `rows` is the same shape (only `.options` is read), returns `Array<{ index: number, option: string }>` — one entry per row, in row order. Throws `Error` if any row's answer can't be found or matched to one of that row's options.
- Both exported via the existing `module.exports` block at the bottom of `shared.js`, alongside `buildPrompt`/`parseAnswerLetters`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/shared.test.js` (after the existing tests, keep the existing `require` line but add the two new names):

```js
const { buildPrompt, parseAnswerLetters, buildMatchingPrompt, parseMatchingAnswer } = require('../shared.js');
```

Then append these tests to the file:

```js
test('buildMatchingPrompt formats each row with its own numbered option list', () => {
  const prompt = buildMatchingPrompt([
    { prompt: 'Organized Crime', options: ['Financially motivated group', 'Government-backed group'] },
    { prompt: 'Hacktivist', options: ['Politically motivated individual', 'Insider employee'] },
  ]);
  assert.match(prompt, /Row 1: "Organized Crime"/);
  assert.match(prompt, /1\. Financially motivated group/);
  assert.match(prompt, /2\. Government-backed group/);
  assert.match(prompt, /Row 2: "Hacktivist"/);
  assert.match(prompt, /Answer with one "Row N: <option text>" line per row:$/);
});

test('parseMatchingAnswer maps each row to its answered option', () => {
  const rows = [
    { options: ['Financially motivated group', 'Government-backed group'] },
    { options: ['Politically motivated individual', 'Insider employee'] },
  ];
  const rawText = 'Row 1: Financially motivated group\nRow 2: Politically motivated individual';
  const result = parseMatchingAnswer(rawText, rows);
  assert.deepEqual(result, [
    { index: 0, option: 'Financially motivated group' },
    { index: 1, option: 'Politically motivated individual' },
  ]);
});

test('parseMatchingAnswer is case-insensitive and tolerates surrounding whitespace', () => {
  const rows = [{ options: ['Alpha', 'Beta'] }];
  const result = parseMatchingAnswer('  row 1:   alpha  ', rows);
  assert.deepEqual(result, [{ index: 0, option: 'Alpha' }]);
});

test('parseMatchingAnswer throws when a row is missing from the response', () => {
  const rows = [{ options: ['Alpha'] }, { options: ['Beta'] }];
  assert.throws(() => parseMatchingAnswer('Row 1: Alpha', rows), /Row 2/);
});

test('parseMatchingAnswer throws when the answered text matches none of that row\'s options', () => {
  const rows = [{ options: ['Alpha', 'Beta'] }];
  assert.throws(() => parseMatchingAnswer('Row 1: Gamma', rows), /doesn't match any/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test "tests/*.test.js"`
Expected: FAIL — `buildMatchingPrompt`/`parseMatchingAnswer` are not defined (undefined is not a function).

- [ ] **Step 3: Implement the functions**

Add to `shared.js`, after `parseAnswerLetters` and before the `module.exports` block:

```js
function buildMatchingPrompt(rows) {
  const rowsFormatted = rows
    .map((row, idx) => {
      const optionsFormatted = row.options
        .map((opt, optIdx) => `   ${optIdx + 1}. ${opt}`)
        .join('\n');
      return `Row ${idx + 1}: "${row.prompt}"\nOptions for Row ${idx + 1}:\n${optionsFormatted}`;
    })
    .join('\n\n');

  return `This is a matching question. For each numbered row, pick the single best-matching option from that row's own option list.

CRITICAL RULES:
1. Output EXACTLY one line per row, in the format "Row N: <option text>"
2. Use the option text exactly as written in that row's list — do not paraphrase
3. No explanation, no extra text, no blank lines

${rowsFormatted}

Answer with one "Row N: <option text>" line per row:`;
}

function parseMatchingAnswer(rawText, rows) {
  const text = (rawText || '').trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const rowAnswers = [];

  rows.forEach((row, idx) => {
    const rowNumber = idx + 1;
    const linePattern = new RegExp(`^Row\\s*${rowNumber}\\s*:\\s*(.+)$`, 'i');
    const matchingLine = lines.find((l) => linePattern.test(l));
    if (!matchingLine) {
      throw new Error(`Could not find an answer for Row ${rowNumber} in the AI's response: ${text}`);
    }
    const rawOption = matchingLine.match(linePattern)[1].trim();
    const bestOption =
      row.options.find((opt) => opt.toLowerCase() === rawOption.toLowerCase()) ||
      row.options.find(
        (opt) =>
          rawOption.toLowerCase().includes(opt.toLowerCase()) ||
          opt.toLowerCase().includes(rawOption.toLowerCase())
      );
    if (!bestOption) {
      throw new Error(
        `AI's answer for Row ${rowNumber} ("${rawOption}") doesn't match any of that row's options: ${row.options.join(', ')}`
      );
    }
    rowAnswers.push({ index: idx, option: bestOption });
  });

  return rowAnswers;
}
```

Update the `module.exports` block at the bottom of `shared.js`:

```js
if (typeof module !== 'undefined') {
  module.exports = { buildPrompt, parseAnswerLetters, buildMatchingPrompt, parseMatchingAnswer };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test "tests/*.test.js"`
Expected: PASS — all tests, including the 5 new ones, green.

- [ ] **Step 5: Commit**

```bash
git add shared.js tests/shared.test.js
git commit -m "feat: add buildMatchingPrompt/parseMatchingAnswer for matching questions"
```

---

## Task 2: `robustClick()` trusted-click helper + `chrome.debugger` fallback

**Files:**
- Modify: `manifest.json`
- Modify: `content.js`
- Modify: `background.js`

**Interfaces:**
- Produces (content.js): `async function robustClick(element, verify)` — `verify` is an optional zero-arg function returning `true` once the click's expected effect happened; returns `boolean` (whether the click ultimately registered). Used by every later task that needs to click something inside the course-content iframe.
- Produces (content.js): `function getAbsolutePageRect(element)` — returns `{ x, y }`, the element's center in top-page viewport coordinates (accounts for one level of iframe offset via `window.frameElement`).
- Consumes (background.js): new message `{ action: 'robustClickCdp', x, y }` → `{ success: boolean, error?: string }`.

- [ ] **Step 1: Add the `debugger` permission**

In `manifest.json`, update the `permissions` array:

```json
  "permissions": [
    "storage",
    "activeTab",
    "scripting",
    "tabs",
    "debugger"
  ],
```

- [ ] **Step 2: Add the CDP click handler in `background.js`**

Add this function anywhere below the existing `askWebAi` function in `background.js`:

```js
async function handleRobustClickCdp(tabId, x, y) {
  const debuggee = { tabId };
  await chrome.debugger.attach(debuggee, '1.3');
  try {
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    return { success: true };
  } finally {
    await chrome.debugger.detach(debuggee).catch(() => {});
  }
}
```

Update the `chrome.runtime.onMessage` listener in `background.js` to add a second branch (keep the existing `getAnswer` branch unchanged):

```js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getAnswer') {
    handleGetAnswer(
      request.question,
      request.options,
      request.modelType,
      request.isMultipleAnswer,
      request.requiredAnswers
    )
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep message channel open for async response
  }
  if (request.action === 'robustClickCdp') {
    handleRobustClickCdp(sender.tab.id, request.x, request.y)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});
```

- [ ] **Step 3: Add `robustClick`/`getAbsolutePageRect` in `content.js`**

Add these functions to `content.js`, right after `findElementInShadowDOM` (before `extractQuestionData`):

```js
// Returns the element's center point in top-page viewport coordinates.
// Assumes at most one level of iframe nesting (confirmed on the live course:
// the course-content iframe is not itself further nested).
function getAbsolutePageRect(element) {
  const rect = element.getBoundingClientRect();
  const frame = window.frameElement; // null if this script instance is running in the top frame
  const frameRect = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 };
  return {
    x: frameRect.left + rect.left + rect.width / 2,
    y: frameRect.top + rect.top + rect.height / 2,
  };
}

// Clicks `element`. Netacad's Angular-based custom widgets (confirmed on the
// quiz's radio buttons) ignore synthetic JS `.click()` events, so if `verify`
// doesn't report success after a plain click, this falls back to a
// chrome.debugger-dispatched trusted click via the background script.
async function robustClick(element, verify) {
  if (!element) return false;

  if (element.scrollIntoView) {
    element.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 150));
  }

  element.click();
  await new Promise((r) => setTimeout(r, 300));

  if (!verify || verify()) {
    return true;
  }

  console.log('⚠️ Plain click did not register, retrying via chrome.debugger:', element);
  const { x, y } = getAbsolutePageRect(element);
  let cdpResult;
  try {
    cdpResult = await chrome.runtime.sendMessage({ action: 'robustClickCdp', x, y });
  } catch (error) {
    console.error('❌ robustClickCdp message failed:', error);
    return false;
  }

  if (!cdpResult || !cdpResult.success) {
    console.error('❌ chrome.debugger click fallback failed:', cdpResult && cdpResult.error);
    return false;
  }

  await new Promise((r) => setTimeout(r, 300));
  return !verify || verify();
}
```

- [ ] **Step 4: Manual test**

1. Run `node --test "tests/*.test.js"` — confirm still passing (this task didn't touch `shared.js`).
2. Load the unpacked extension (`chrome://extensions` → reload), open a real Netacad quiz question.
3. Open the page's DevTools console and run:
   ```js
   const item = document.querySelector('mcq-view').shadowRoot.querySelector('.mcq__item');
   const input = item.querySelector('input');
   robustClick(item, () => input.checked).then(r => console.log('robustClick result:', r, 'checked:', input.checked));
   ```
   (Adjust the shadow-root path to match `extractQuestionData`'s traversal if `mcq-view` isn't a direct child of `document`.)
4. Confirm the console logs the "Plain click did not register, retrying via chrome.debugger" warning, Chrome shows the brief "extension started debugging this browser" indicator, and `input.checked` ends up `true`.

- [ ] **Step 5: Commit**

```bash
git add manifest.json content.js background.js
git commit -m "feat: add robustClick() trusted-click helper with chrome.debugger fallback"
```

---

## Task 3: Course-content detection + `📖 Auto-Complete Module` button

**Files:**
- Modify: `content.js`
- Modify: `content.css`

**Interfaces:**
- Produces: `function checkForCourseContent()` — no-ops unless running in the top frame and the course-content iframe (same-origin, reachable via `iframe.contentDocument`) contains at least one `.js-heading` element.
- Produces: `function createModuleWalkerButton(targetDocument)` — injects the `#netacad-ai-walker-btn` button.
- Consumes: `findInShadowDOM` (existing).

- [ ] **Step 1: Add the CSS for the new button**

Add to `content.css`, after the `.ai-helper-button-webai:hover` block:

```css
/* Module Walker Button (Amber) */
.ai-helper-button-walker {
  top: 300px;
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
}

.ai-helper-button-walker:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(245, 158, 11, 0.6);
  background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
}
```

Add to the existing `@media (max-width: 768px)` block, after `.ai-helper-button-webai { top: 210px; }`:

```css
  .ai-helper-button-walker {
    top: 260px;
  }
```

- [ ] **Step 2: Add detection + button creation to `content.js`**

Add these functions to `content.js`, after `createHelperButton` and before `handleButtonClick`:

```js
// Detects a Netacad course-content page (as opposed to a quiz page) and
// injects the Auto-Complete Module button. Only runs in the top frame: it
// reaches into the course-content iframe itself (same-origin) rather than
// running as its own content-script instance inside that iframe.
function checkForCourseContent() {
  if (window.top !== window.self) {
    return;
  }
  if (document.getElementById('netacad-ai-walker-btn')) {
    return;
  }

  const iframe = document.querySelector('iframe');
  if (!iframe || !iframe.contentDocument) {
    return;
  }

  const headings = findInShadowDOM('.js-heading', iframe.contentDocument);
  if (headings.length === 0) {
    return;
  }

  console.log(`✅ Course content detected (${headings.length} .js-heading sections), adding walker button`);
  createModuleWalkerButton(document);
}

function createModuleWalkerButton(targetDocument) {
  const button = targetDocument.createElement('button');
  button.id = 'netacad-ai-walker-btn';
  button.innerHTML = '📖 Auto-Complete Module';
  button.className = 'ai-helper-button ai-helper-button-walker';

  button.addEventListener('click', () => {
    if (moduleWalkState.running) {
      stopModuleWalk();
    } else {
      startModuleWalk();
    }
  });

  targetDocument.body.appendChild(button);
  console.log('Module walker button added to main page');
}
```

- [ ] **Step 3: Wire detection into the existing init loop**

In `content.js`, update `tryCheckForQuiz`:

```js
function tryCheckForQuiz() {
  checkAttempts++;
  console.log(`Attempt ${checkAttempts} to find quiz`);

  checkForQuiz();
  checkForCourseContent();

  const found = document.getElementById('netacad-ai-helper-btn-gpt') || document.getElementById('netacad-ai-walker-btn');
  if (checkAttempts < maxAttempts && !found) {
    setTimeout(tryCheckForQuiz, 500);
  }
}
```

And update the `MutationObserver` callback inside `initialize`:

```js
  const observer = new MutationObserver((mutations) => {
    // Only check if buttons don't exist
    const found = document.getElementById('netacad-ai-helper-btn-gpt') || document.getElementById('netacad-ai-walker-btn');
    if (!found) {
      const appRoot = document.querySelector('app-root');
      if (appRoot) {
        console.log('app-root detected via mutation observer');
        checkForQuiz();
      }
      checkForCourseContent();
    }
  });
```

This task references `moduleWalkState`, `startModuleWalk`, and `stopModuleWalk`, which don't exist yet — that's expected; Task 4 adds them. Add a temporary stub at the bottom of `content.js` for this task's manual test to work standalone (Task 4 will replace it):

```js
// Temporary stub — replaced with the real implementation in the next task.
const moduleWalkState = { running: false };
function startModuleWalk() { console.log('startModuleWalk stub called'); }
function stopModuleWalk() { console.log('stopModuleWalk stub called'); }
```

- [ ] **Step 4: Manual test**

1. Load the unpacked extension, open a Netacad **course content** page (not a quiz) — e.g. a module's "Introduction" or numbered topic page.
2. Confirm the amber `📖 Auto-Complete Module` button appears (in the main page, not clipped inside the iframe).
3. Open a **quiz** page and confirm the button does *not* appear there (only the existing GPT/Gemini/Web AI buttons do) unless that quiz page also has non-quiz `.js-heading` sections above it (e.g. a module's "Summary" page, which legitimately has both — that's expected and fine, per the design's stop-at-quiz behavior).
4. Click the button and confirm `startModuleWalk stub called` logs to the console (real behavior lands in Task 4/6).

- [ ] **Step 5: Commit**

```bash
git add content.js content.css
git commit -m "feat: detect Netacad course-content pages and add Auto-Complete Module button"
```

---

## Task 4: Topic outline parsing + progress overlay + reading/click-reveal/video handlers

**Files:**
- Modify: `content.js`
- Modify: `content.css`

**Interfaces:**
- Produces: `function getCurrentModuleNumber()`, `function getModuleOutlineTopics(moduleNumber)`, `function getRemainingTopicsInCurrentModule()` — outline parsing, text/attribute-based only (no hashed classes).
- Produces: `function createOverlay(targetDocument)`, `function updateOverlay(text)`, `function removeOverlayAfterDelay(finalText, delayMs)`.
- Produces: `async function openTopic(topic)`.
- Produces: `function getSectionContainerForHeading(heading)`, `function findInShadowDOMMulti(selector, elements)`, `function classifySection(sectionName, sectionElements)`.
- Produces: `async function handleReadingSection(sectionElements)`, `async function handleClickToRevealSection(sectionElements)`, `async function handleVideoSection(sectionElements)`.
- Consumes: `findInShadowDOM`, `robustClick` (Task 2).

- [ ] **Step 1: Add overlay CSS**

Add to `content.css`, after the module-walker button rules from Task 3:

```css
/* Module Walker Progress Overlay */
.ai-walker-overlay {
  position: fixed;
  left: 20px;
  bottom: 20px;
  z-index: 10001;
  background: #1f2937;
  color: white;
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 13px !important;
  font-family: Arial, Helvetica, sans-serif !important;
  display: flex;
  align-items: center;
  gap: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  max-width: 360px;
}

.ai-walker-overlay-status {
  flex: 1;
}

.ai-walker-overlay-stop {
  background: #ef4444;
  color: white;
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 12px !important;
  font-weight: 600 !important;
  cursor: pointer;
}

.ai-walker-overlay-stop:hover {
  background: #dc2626;
}
```

Add to the `@media (max-width: 768px)` block:

```css
  .ai-walker-overlay {
    left: 10px;
    bottom: 10px;
    max-width: calc(100% - 20px);
  }
```

- [ ] **Step 2: Remove the Task 3 stub and add the overlay + outline-parsing functions**

In `content.js`, delete the temporary stub block added at the end of Task 3:

```js
// Temporary stub — replaced with the real implementation in the next task.
const moduleWalkState = { running: false };
function startModuleWalk() { console.log('startModuleWalk stub called'); }
function stopModuleWalk() { console.log('stopModuleWalk stub called'); }
```

In its place, add:

```js
// --- Module Walker: outline parsing (main frame only) ---

// The iframe's document.title reliably contains the current topic's number
// as "... | 5.1. Exploiting Network-Based Vulnerabilities" even when the
// module-number placeholder earlier in the title is unresolved.
function getCurrentModuleNumber() {
  const iframe = document.querySelector('iframe');
  if (!iframe || !iframe.contentDocument || !iframe.contentDocument.title) return null;
  const parts = iframe.contentDocument.title.split('|');
  if (parts.length < 2) return null;
  const match = parts[1].trim().match(/^(\d+)\./);
  return match ? match[1] : null;
}

// Outline sidebar buttons use CSS-Modules-hashed classes that aren't stable
// across deployments (see Global Constraints) — this reads plain button text
// instead. Module/topic buttons are flat siblings in outline order: a
// "Module N: ..." button, followed by that module's topic buttons, followed
// by the next "Module N+1: ..." button. Confirmed live: each topic button's
// status ("start"/"in progress"/"completed") is NOT part of its textContent —
// it only shows up in the accessible name via a child <img alt="...">, e.g.
// <div class="subModuleStatus--..."><img alt="start" src="..."></div>. Read
// that alt attribute directly rather than parsing it out of textContent.
function getModuleOutlineTopics(moduleNumber) {
  const allButtons = Array.from(document.querySelectorAll('button'));
  const moduleButtonIndex = allButtons.findIndex((b) =>
    new RegExp(`^Module ${moduleNumber}:`).test((b.textContent || '').trim())
  );
  if (moduleButtonIndex === -1) {
    throw new Error(`Couldn't find "Module ${moduleNumber}" in the course outline.`);
  }

  const topics = [];
  for (let i = moduleButtonIndex + 1; i < allButtons.length; i++) {
    const text = (allButtons[i].textContent || '').trim();
    if (/^Module \d+:/.test(text) || /Final Exam|Capstone Activity|End of Course Survey/i.test(text)) {
      break;
    }
    const topicMatch = text.match(/^(\d+\.\d+)\.\s*(.+?)\s*(?:\d+\s*\/\s*\d+)?$/i);
    if (topicMatch) {
      const statusImg = allButtons[i].querySelector('img[alt]');
      const status = statusImg ? statusImg.alt.trim().toLowerCase() : '';
      topics.push({
        button: allButtons[i],
        number: topicMatch[1],
        name: topicMatch[2].trim(),
        isCompleted: status === 'completed',
      });
    }
  }
  return topics;
}

function getRemainingTopicsInCurrentModule() {
  const moduleNumber = getCurrentModuleNumber();
  if (!moduleNumber) {
    throw new Error("Couldn't find the module outline (couldn't determine the current module number).");
  }
  const allTopics = getModuleOutlineTopics(moduleNumber);
  if (allTopics.length === 0) {
    throw new Error(`Couldn't find the module outline (no topics found under Module ${moduleNumber}).`);
  }
  return allTopics.filter((t) => !t.isCompleted);
}

function iframeShowsTopic(topicNumber) {
  const iframe = document.querySelector('iframe');
  if (!iframe || !iframe.contentDocument || !iframe.contentDocument.title) return false;
  const parts = iframe.contentDocument.title.split('|');
  return parts.length >= 2 && parts[1].trim().startsWith(topicNumber);
}

async function openTopic(topic) {
  await robustClick(topic.button, () => iframeShowsTopic(topic.number));
  await new Promise((r) => setTimeout(r, 1500));
}

// --- Module Walker: progress overlay ---

function createOverlay(targetDocument) {
  let overlay = targetDocument.getElementById('netacad-ai-walker-overlay');
  if (overlay) return overlay;

  overlay = targetDocument.createElement('div');
  overlay.id = 'netacad-ai-walker-overlay';
  overlay.className = 'ai-walker-overlay';
  overlay.innerHTML =
    '<span class="ai-walker-overlay-status">Auto-Complete Module — starting…</span>' +
    '<button class="ai-walker-overlay-stop">Stop</button>';
  overlay.querySelector('.ai-walker-overlay-stop').addEventListener('click', stopModuleWalk);
  targetDocument.body.appendChild(overlay);
  return overlay;
}

function updateOverlay(text) {
  const status = document.querySelector('#netacad-ai-walker-overlay .ai-walker-overlay-status');
  if (status) status.textContent = text;
}

function removeOverlayAfterDelay(finalText, delayMs = 4000) {
  updateOverlay(finalText);
  console.log('Module walker finished:', finalText);
  setTimeout(() => {
    const overlay = document.getElementById('netacad-ai-walker-overlay');
    if (overlay) overlay.remove();
  }, delayMs);
}

// --- Module Walker: section classification + handlers ---

function findInShadowDOMMulti(selector, elements) {
  return elements.reduce((acc, el) => acc.concat(findInShadowDOM(selector, el)), []);
}

// A "section" is a .js-heading element plus every sibling after it up to
// (not including) the next .js-heading sibling.
function getSectionContainerForHeading(heading) {
  const parent = heading.parentElement;
  const siblings = Array.from(parent.children);
  const startIndex = siblings.indexOf(heading);
  let endIndex = siblings.length;
  for (let i = startIndex + 1; i < siblings.length; i++) {
    if (siblings[i].classList && siblings[i].classList.contains('js-heading')) {
      endIndex = i;
      break;
    }
  }
  return siblings.slice(startIndex, endIndex);
}

function isGradedQuizSection(sectionElements) {
  const hasMcq = findInShadowDOMMulti('mcq-view', sectionElements).length > 0;
  const hasQuizNav = findInShadowDOMMulti('button', sectionElements).some((b) =>
    /skip question|skip all question/i.test((b.textContent || '').trim())
  );
  return hasMcq && hasQuizNav;
}

function classifySection(sectionName, sectionElements) {
  if (/^(lab|practice)\s*-/i.test(sectionName)) {
    return 'unknown'; // Labs/Practices open external tools — out of scope.
  }
  if (findInShadowDOMMulti('video', sectionElements).length > 0) {
    return 'video';
  }
  if (findInShadowDOMMulti('mcq-view', sectionElements).length > 0) {
    return 'selfCheck';
  }
  if (findInShadowDOMMulti('.matching__widget', sectionElements).length > 0) {
    return 'matching';
  }
  const revealButtons = findInShadowDOMMulti('button', sectionElements).filter((b) => {
    const text = (b.textContent || '').trim();
    return text.length > 0 && !/^(submit|show feedback)$/i.test(text);
  });
  if (revealButtons.length > 0) {
    return 'clickToReveal';
  }
  return 'reading';
}

async function handleReadingSection(sectionElements) {
  const target = sectionElements[sectionElements.length - 1] || sectionElements[0];
  if (target && target.scrollIntoView) {
    target.scrollIntoView({ block: 'end', behavior: 'auto' });
  }
  await new Promise((r) => setTimeout(r, 1500));
  return true;
}

async function handleClickToRevealSection(sectionElements) {
  const revealButtons = findInShadowDOMMulti('button', sectionElements).filter((b) => {
    const text = (b.textContent || '').trim();
    return text.length > 0 && !/^(submit|show feedback)$/i.test(text);
  });
  for (const btn of revealButtons) {
    await robustClick(btn, () => btn.getAttribute('aria-expanded') === 'true' || btn.classList.contains('is-open'));
    await new Promise((r) => setTimeout(r, 300));
  }
  return true;
}

async function handleVideoSection(sectionElements) {
  const videos = findInShadowDOMMulti('video', sectionElements);
  if (videos.length === 0) return false;
  const video = videos[0];
  video.muted = true;
  video.playbackRate = 4;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('ended', finish);
      resolve();
    };
    video.addEventListener('ended', finish, { once: true });
    const timeoutMs = Math.max(5000, ((video.duration || 60) / video.playbackRate) * 1000 * 2);
    setTimeout(finish, timeoutMs);
    video.play().catch(finish);
  });

  return true;
}
```

- [ ] **Step 3: Add temporary stubs for the not-yet-built pieces**

`classifySection` can return `'selfCheck'` or `'matching'`, whose handlers don't exist until Task 5, and the full loop that uses all of this doesn't exist until Task 6. Add temporary stubs at the end of `content.js` so this task's manual test is self-contained (Task 5/6 will replace these):

```js
// Temporary stubs — replaced in later tasks.
const moduleWalkState = { running: false, stopRequested: false };
function stopModuleWalk() { moduleWalkState.stopRequested = true; }
async function handleSelfCheckSection() { return false; }
async function handleMatchingSection() { return false; }
async function startModuleWalk() {
  console.log('startModuleWalk stub: topics =', getRemainingTopicsInCurrentModule());
}
```

- [ ] **Step 4: Manual test**

1. Load the unpacked extension, open a course content page on a module with at least one unread topic.
2. In the DevTools console, run `getRemainingTopicsInCurrentModule()` and confirm it returns the expected not-yet-completed topics (name + number) for the current module, and throws a clear error if run on a page with no outline.
3. Run `openTopic(topics[0])` (using a topic from the previous call) and confirm the iframe navigates to that topic.
4. Run `createOverlay(document)` and confirm the overlay panel appears bottom-left with a Stop button; click Stop and confirm `moduleWalkState.stopRequested` becomes `true`.
5. On a topic with a plain reading section, a click-to-reveal section (e.g. a "Summary" topic's "What Did I Learn" heading), and a video, manually call `classifySection('name', getSectionContainerForHeading(heading))` for each of their `.js-heading` elements (found via `findInShadowDOM('.js-heading', document.querySelector('iframe').contentDocument)`) and confirm each returns the expected type. Then call the matching handler function directly (e.g. `handleVideoSection(...)`) and confirm it behaves as designed (video plays muted/sped-up and the promise resolves on `ended`).

- [ ] **Step 5: Commit**

```bash
git add content.js content.css
git commit -m "feat: add module outline parsing, progress overlay, and reading/reveal/video handlers"
```

---

## Task 5: Self-check and matching section handlers

**Files:**
- Modify: `content.js`

**Interfaces:**
- Produces: `async function handleSelfCheckSection(sectionElements)`, `async function handleMatchingSection(sectionElements)` — replace the Task 4 stubs of the same names.
- Consumes: `robustClick`, `findInShadowDOM`, `findInShadowDOMMulti`.

- [ ] **Step 1: Replace the stubs with real implementations**

In `content.js`, delete:

```js
async function handleSelfCheckSection() { return false; }
async function handleMatchingSection() { return false; }
```

Replace with:

```js
// Formative/embedded self-checks (radio/checkbox groups). Per the design
// spec's explicit decision, any attempted answer is enough — these are
// ungraded and only need to be attempted to complete the section.
async function handleSelfCheckSection(sectionElements) {
  const items = findInShadowDOMMulti('.mcq__item', sectionElements);
  if (items.length === 0) return false;

  const handledGroups = new Set();
  for (const item of items) {
    const input = item.querySelector('input');
    const groupKey = input && input.name ? input.name : item.parentElement;
    if (handledGroups.has(groupKey)) continue;
    if (input && input.checked) {
      handledGroups.add(groupKey);
      continue;
    }
    await robustClick(item, () => !input || input.checked);
    handledGroups.add(groupKey);
  }

  const submitButtons = findInShadowDOMMulti('button', sectionElements).filter((b) =>
    /^submit/i.test((b.textContent || '').trim())
  );
  for (const btn of submitButtons) {
    if (!btn.disabled) {
      await robustClick(btn, () => btn.disabled);
    }
  }

  return true;
}

// Matching-dropdown rows (also used for Likert-scale "Lab Survey" widgets —
// both share the same .matching__widget/matching-dropdown-view markup). Per
// the design spec, embedded matching self-checks accept any answer.
async function handleMatchingSection(sectionElements) {
  const rows = findInShadowDOMMulti('matching-dropdown-view', sectionElements);
  if (rows.length === 0) return false;

  for (const row of rows) {
    const dropdownBtn = findInShadowDOM('.dropdown__btn.js-dropdown-btn', row)[0];
    if (!dropdownBtn) continue;

    await robustClick(dropdownBtn, () => dropdownBtn.getAttribute('aria-expanded') === 'true');
    await new Promise((r) => setTimeout(r, 300));

    const options = findInShadowDOM('.dropdown__item.js-dropdown-list-item', row.ownerDocument).filter(
      (opt) => opt.offsetParent !== null
    );
    if (options.length === 0) continue;

    await robustClick(options[0], () => /not selected/i.test(options[0].textContent || '') === false);
  }

  const submitButtons = findInShadowDOMMulti('button', sectionElements).filter((b) =>
    /^submit/i.test((b.textContent || '').trim())
  );
  for (const btn of submitButtons) {
    if (!btn.disabled) {
      await robustClick(btn, () => btn.disabled);
    }
  }

  return true;
}
```

- [ ] **Step 2: Manual test**

1. Load the unpacked extension, find a course-content topic with an embedded self-check (e.g. a "Skills Check" section) and one with a matching/Lab Survey widget.
2. In the DevTools console, get that section's elements: `const section = getSectionContainerForHeading(theHeadingElement);` then call `await handleSelfCheckSection(section)` — confirm an option gets selected, Submit is clicked, and the heading's class flips from `is-incomplete` to `is-complete`.
3. Repeat for a matching/survey widget with `await handleMatchingSection(section)` — confirm the dropdown opens, an option is picked, Submit is clicked, and the heading completes.
4. Confirm `robustClick`'s `chrome.debugger` fallback path only engages when the plain click genuinely doesn't register (watch the console for the "Plain click did not register" warning — it should *not* appear for the matching dropdown, since that one was confirmed live to accept plain clicks; it may appear for the self-check radio/checkbox clicks, consistent with the quiz radio findings).

- [ ] **Step 3: Commit**

```bash
git add content.js
git commit -m "feat: add self-check and matching section handlers to the module walker"
```

---

## Task 6: Full walk loop — `startModuleWalk`/`stopModuleWalk`, quiz hand-off, skip reporting

**Files:**
- Modify: `content.js`

**Interfaces:**
- Produces: `async function walkTopicSections()` → `{ skipped: string[], reachedQuiz: boolean, quizName?: string, stopped: boolean }`.
- Produces (replaces Task 4's stub): `async function startModuleWalk()`.
- Produces (replaces Task 4's stub): `function stopModuleWalk()` (same behavior, now colocated with the real `moduleWalkState`).

- [ ] **Step 1: Remove the Task 4 stubs**

Delete from `content.js`:

```js
// Temporary stubs — replaced in later tasks.
const moduleWalkState = { running: false, stopRequested: false };
function stopModuleWalk() { moduleWalkState.stopRequested = true; }
async function startModuleWalk() {
  console.log('startModuleWalk stub: topics =', getRemainingTopicsInCurrentModule());
}
```

(Leave `handleSelfCheckSection`/`handleMatchingSection` from Task 5 untouched — those are real now, not stubs.)

- [ ] **Step 2: Add the real state, section-walk loop, and top-level orchestration**

Add to `content.js`:

```js
const moduleWalkState = { running: false, stopRequested: false };

function stopModuleWalk() {
  moduleWalkState.stopRequested = true;
}

async function walkTopicSections() {
  const skipped = [];
  const iframe = document.querySelector('iframe');
  if (!iframe || !iframe.contentDocument) {
    throw new Error("Couldn't find the course content iframe.");
  }
  const contentDoc = iframe.contentDocument;

  let guardCount = 0;
  while (guardCount < 200) {
    guardCount++;
    if (moduleWalkState.stopRequested) {
      return { skipped, reachedQuiz: false, stopped: true };
    }

    const headings = findInShadowDOM('.js-heading', contentDoc);
    const nextIncomplete = headings.find(
      (h) => h.classList.contains('is-incomplete') && !h.dataset.aiWalkerSkipped
    );
    if (!nextIncomplete) {
      return { skipped, reachedQuiz: false, stopped: false };
    }

    const sectionName = nextIncomplete.textContent.trim().replace(/^Incomplete\s*/, '');
    const section = getSectionContainerForHeading(nextIncomplete);

    if (isGradedQuizSection(section)) {
      return { skipped, reachedQuiz: true, quizName: sectionName, stopped: false };
    }

    const kind = classifySection(sectionName, section);
    let handled = false;
    if (kind === 'video') {
      handled = await handleVideoSection(section);
    } else if (kind === 'selfCheck') {
      handled = await handleSelfCheckSection(section);
    } else if (kind === 'matching') {
      handled = await handleMatchingSection(section);
    } else if (kind === 'clickToReveal') {
      handled = await handleClickToRevealSection(section);
    } else if (kind === 'reading') {
      handled = await handleReadingSection(section);
    }

    const stillIncomplete = nextIncomplete.classList.contains('is-incomplete');
    if (!handled || stillIncomplete) {
      skipped.push(sectionName);
      nextIncomplete.dataset.aiWalkerSkipped = 'true';
    }
  }

  throw new Error('Module walker stopped after 200 sections — this looks like a loop, aborting to be safe.');
}

async function startModuleWalk() {
  if (moduleWalkState.running) return;
  moduleWalkState.running = true;
  moduleWalkState.stopRequested = false;

  createOverlay(document);
  const walkerButton = document.getElementById('netacad-ai-walker-btn');
  if (walkerButton) walkerButton.textContent = '⏹ Stop Auto-Complete';

  const allSkipped = [];
  let processedCount = 0;

  try {
    const topics = getRemainingTopicsInCurrentModule();
    if (topics.length === 0) {
      removeOverlayAfterDelay('Nothing left to complete in this module.');
      return;
    }

    for (const topic of topics) {
      if (moduleWalkState.stopRequested) {
        removeOverlayAfterDelay('Stopped by user.');
        return;
      }

      updateOverlay(`Auto-Complete Module — ${topic.name} (${processedCount + 1}/${topics.length})`);
      await openTopic(topic);

      const result = await walkTopicSections();
      allSkipped.push(...result.skipped);

      if (result.reachedQuiz) {
        removeOverlayAfterDelay(`Reached "${result.quizName}" — use Get Answer / Web AI to continue.`);
        return;
      }
      if (result.stopped) {
        removeOverlayAfterDelay('Stopped by user.');
        return;
      }

      processedCount++;
    }

    const summary =
      allSkipped.length > 0
        ? `Done — ${processedCount}/${topics.length} completed, ${allSkipped.length} need manual review (${allSkipped.join(', ')})`
        : `Done — ${processedCount}/${topics.length} completed.`;
    removeOverlayAfterDelay(summary);
  } catch (error) {
    console.error('❌ Module walk error:', error);
    removeOverlayAfterDelay('Error: ' + error.message);
  } finally {
    moduleWalkState.running = false;
    if (walkerButton) walkerButton.textContent = '📖 Auto-Complete Module';
  }
}
```

- [ ] **Step 3: Manual test (full end-to-end, per the design spec's test plan)**

1. Load the unpacked extension. Open a module with several unread reading sections, at least one video, and at least one embedded self-check. Click `📖 Auto-Complete Module`.
2. Confirm the overlay appears and progresses topic-by-topic, and the sidebar's own outline status (e.g. "start" → "completed") updates as sections complete — proof Netacad's real tracking fired, not a forged state.
3. Click Stop mid-run; confirm it halts cleanly (finishes the current section, doesn't start a new topic) and the overlay reports "Stopped by user."
4. Run it again on a module that has a graded quiz within one of its topics (e.g. a "Summary" topic); confirm the walker completes the reading/self-check sections before the quiz, then stops with the "Reached ... — use Get Answer / Web AI to continue" message, and the quiz itself is untouched (no options selected, no submit clicked).
5. If a Lab or Practice item exists in the module, confirm it's skipped and named in the final summary rather than crashing the run.
6. Once a module's non-quiz content is genuinely complete, confirm the next module unlocks in the outline (its "Prerequisite locked" state clears, matching what was observed on the live "Course Final Exam" node).

- [ ] **Step 4: Commit**

```bash
git add content.js
git commit -m "feat: complete module walker loop with quiz hand-off and skip reporting"
```

---

## Task 7: Matching-question extraction + highlighting for the existing quiz feature

**Files:**
- Modify: `content.js`

**Interfaces:**
- Produces: `function extractMcqQuestionData()` — the existing `extractQuestionData` body, unchanged, renamed.
- Produces: `function extractMatchingQuestionData()` — returns `{ isMatching: true, rows: Array<{ index, prompt, options }> }` or `null`.
- Modifies: `async function extractQuestionData()` — now tries MCQ extraction first, falls back to matching extraction.
- Produces: `function highlightMatchingAnswer(rowAnswers)` — `rowAnswers` is `Array<{ index, option }>` as returned by `parseMatchingAnswer`.
- Modifies: `handleButtonClick` — branches on `questionData.isMatching`.

- [ ] **Step 1: Rename the existing extraction function**

In `content.js`, rename the function signature line:

```js
async function extractQuestionData() {
```

to:

```js
function extractMcqQuestionData() {
```

(Leave every line of its body exactly as-is — this is a pure rename, zero logic changes, to avoid any regression risk to the shipped MCQ extraction.)

- [ ] **Step 2: Add the matching extractor and the new dispatcher**

Add these new functions to `content.js`, right after the renamed `extractMcqQuestionData`:

```js
function extractMatchingQuestionData() {
  console.log('=== Starting Matching Question Extraction ===');
  try {
    const widgets = findInShadowDOM('.matching__widget', document);
    const visibleWidgets = widgets.filter((w) => {
      const style = window.getComputedStyle(w);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });
    const widget = visibleWidgets[visibleWidgets.length - 1] || widgets[widgets.length - 1];
    if (!widget) {
      console.log('❌ No matching widget found');
      return null;
    }

    const rows = findInShadowDOM('matching-dropdown-view', widget);
    if (rows.length === 0) {
      console.log('❌ Matching widget has no rows');
      return null;
    }

    const rowsWithOptions = [];
    rows.forEach((row, index) => {
      const promptEl = findInShadowDOM('.matching__item-title_inner', row)[0];
      const prompt = promptEl ? promptEl.textContent.trim() : `Row ${index + 1}`;

      const dropdownBtn = findInShadowDOM('.dropdown__btn.js-dropdown-btn', row)[0];
      if (!dropdownBtn) return;

      // Read-only: open the popup to read its option list, then close it
      // again without selecting anything — extraction must not change state.
      dropdownBtn.click();
      const options = findInShadowDOM('.dropdown__item.js-dropdown-list-item', row.ownerDocument)
        .filter((opt) => opt.offsetParent !== null)
        .map((opt) => (opt.textContent || '').replace(/,\s*\d+\s*of\s*\d+.*$/i, '').trim());
      dropdownBtn.click();

      rowsWithOptions.push({ index, prompt, options });
    });

    if (rowsWithOptions.length === 0) {
      console.log('❌ Could not read any matching row options');
      return null;
    }

    console.log(`✅ Extracted ${rowsWithOptions.length} matching rows`);
    console.log('=== Matching Extraction Complete ===\n');
    return { isMatching: true, rows: rowsWithOptions };
  } catch (error) {
    console.error('❌ Error during matching extraction:', error);
    return null;
  }
}

async function extractQuestionData() {
  const mcqData = extractMcqQuestionData();
  if (mcqData) return mcqData;
  return extractMatchingQuestionData();
}
```

- [ ] **Step 3: Add `highlightMatchingAnswer`**

Add to `content.js`, right after `highlightCorrectAnswer`:

```js
function highlightMatchingAnswer(rowAnswers) {
  console.log('=== Highlighting Matching Answers ===', rowAnswers);
  try {
    const widgets = findInShadowDOM('.matching__widget', document);
    const visibleWidgets = widgets.filter((w) => {
      const style = window.getComputedStyle(w);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });
    const widget = visibleWidgets[visibleWidgets.length - 1] || widgets[widgets.length - 1];
    if (!widget) {
      console.log('❌ Could not determine active matching widget for highlighting');
      return;
    }

    const rows = findInShadowDOM('matching-dropdown-view', widget);
    rows.forEach((row, index) => {
      row.style.outline = '';
      row.title = '';
      const answer = rowAnswers.find((a) => a.index === index);
      if (!answer) return;
      row.style.outline = '3px solid #22c55e';
      row.style.borderRadius = '8px';
      row.title = `✓ AI suggests: ${answer.option}`;
      console.log(`✅ Highlighted row ${index} suggestion: ${answer.option}`);
    });

    console.log('=== Matching Highlight Complete ===\n');
  } catch (error) {
    console.error('❌ Error during matching highlight:', error);
  }
}
```

- [ ] **Step 4: Update `handleButtonClick` to branch on `isMatching`**

Replace the body of `handleButtonClick` in `content.js` with:

```js
async function handleButtonClick(button, modelType, originalText) {
  button.disabled = true;
  button.innerHTML = '⏳ Analyzing...';

  const questionData = await extractQuestionData();

  if (!questionData) {
    alert('Could not extract question data. Make sure you are on a quiz page.');
    button.disabled = false;
    button.innerHTML = originalText;
    return;
  }

  try {
    const message = questionData.isMatching
      ? { action: 'getAnswer', isMatching: true, rows: questionData.rows, modelType: modelType }
      : {
          action: 'getAnswer',
          question: questionData.question,
          options: questionData.options.map(opt => opt.text),
          modelType: modelType,
          isMultipleAnswer: questionData.isMultipleAnswer,
          requiredAnswers: questionData.requiredAnswers
        };

    const response = await chrome.runtime.sendMessage(message);

    console.log('AI Response received:', response);

    if (response.success) {
      if (questionData.isMatching) {
        highlightMatchingAnswer(response.rowAnswers);
        button.innerHTML = '✅ Matches Highlighted';
      } else {
        const answerIndices = Array.isArray(response.answerIndex) ? response.answerIndex : [response.answerIndex];
        highlightCorrectAnswer(answerIndices);
        button.innerHTML = questionData.isMultipleAnswer
          ? `✅ ${answerIndices.length} Answers Highlighted`
          : '✅ Answer Highlighted';
      }
      setTimeout(() => {
        button.innerHTML = originalText;
        button.disabled = false;
      }, 2000);
    } else {
      console.error('AI Error Details:', response.error);
      alert('AI Error: ' + response.error);
      button.disabled = false;
      button.innerHTML = originalText;
    }
  } catch (error) {
    console.error('Error getting AI answer:', error);
    alert('Error communicating with AI. Please check your API key in the extension popup.');
    button.disabled = false;
    button.innerHTML = originalText;
  }
}
```

- [ ] **Step 5: Manual test**

1. Run `node --test "tests/*.test.js"` — confirm still passing (this task didn't touch `shared.js`).
2. Load the unpacked extension on a regular MCQ quiz question and click `🤖 Get Answer from GPT` — confirm behavior is byte-for-byte unchanged from before this task (this validates the `extractMcqQuestionData` rename didn't break anything).
3. `extractMatchingQuestionData()`/`extractQuestionData()` and `highlightMatchingAnswer` can't be fully validated end-to-end until Task 8 wires up `background.js`'s response — for now, confirm in the console that `await extractQuestionData()` returns `null` gracefully (not a crash) on a page with neither an MCQ nor a matching widget, and returns the MCQ shape unchanged on a normal quiz question.

- [ ] **Step 6: Commit**

```bash
git add content.js
git commit -m "feat: add matching-question extraction and highlighting to the quiz-answer feature"
```

---

## Task 8: `background.js` matching-answer dispatch (OpenAI, Gemini, Web AI)

**Files:**
- Modify: `background.js`

**Interfaces:**
- Produces: `async function handleGetMatchingAnswer(rows, modelType)` → `{ success: boolean, rowAnswers?, error? }`.
- Produces: `async function getMatchingAnswerFromOpenAI(rows, apiKey)`, `async function getMatchingAnswerFromGemini(rows, apiKey)` → `Array<{ index, option }>` (as returned by `parseMatchingAnswer`).
- Modifies: `function buildWebAiPrompt` → replaced by `function wrapWebAiPrompt(prompt)`, and its one existing call site in `handleGetAnswer` updated accordingly (mechanical rename + one extra explicit `buildPrompt` call, no behavior change for the existing MCQ web-AI path).
- Modifies: `chrome.runtime.onMessage` listener — adds the `request.isMatching` branch.
- Consumes: `buildMatchingPrompt`, `parseMatchingAnswer` (Task 1), `askWebAi` (existing).

- [ ] **Step 1: Replace `buildWebAiPrompt` with `wrapWebAiPrompt`**

In `background.js`, replace:

```js
function buildWebAiPrompt(question, options, isMultipleAnswer, requiredAnswers) {
  const prefix = "Ignore all previous questions and answers in this conversation. Treat the following as a brand-new, unrelated question.\n\n";
  return prefix + buildPrompt(question, options, isMultipleAnswer, requiredAnswers);
}
```

with:

```js
function wrapWebAiPrompt(prompt) {
  const prefix = "Ignore all previous questions and answers in this conversation. Treat the following as a brand-new, unrelated question.\n\n";
  return prefix + prompt;
}
```

Then update its one call site inside `handleGetAnswer`:

```js
    } else if (modelType === 'chatgpt-web' || modelType === 'gemini-web') {
      const prompt = buildWebAiPrompt(question, options, isMultipleAnswer, requiredAnswers);
      const rawText = await askWebAi(modelType, prompt);
      answerIndex = parseAnswerLetters(rawText, options, isMultipleAnswer, requiredAnswers);
```

to:

```js
    } else if (modelType === 'chatgpt-web' || modelType === 'gemini-web') {
      const prompt = wrapWebAiPrompt(buildPrompt(question, options, isMultipleAnswer, requiredAnswers));
      const rawText = await askWebAi(modelType, prompt);
      answerIndex = parseAnswerLetters(rawText, options, isMultipleAnswer, requiredAnswers);
```

- [ ] **Step 2: Add the matching-specific OpenAI/Gemini callers**

Add to `background.js`, after `getAnswerFromOpenAI`:

```js
async function getMatchingAnswerFromOpenAI(rows, apiKey) {
  const prompt = buildMatchingPrompt(rows);
  const url = 'https://api.openai.com/v1/chat/completions';
  const requestBody = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ],
    temperature: temperature,
    top_p: top_p,
    max_tokens: max_tokens,
    presence_penalty: presence_penalty,
    frequency_penalty: frequency_penalty,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestBody)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`OpenAI API error: ${data.error?.message || response.statusText}`);
  }

  const answerText = data.choices?.[0]?.message?.content?.trim();
  if (!answerText) {
    throw new Error('No answer received from OpenAI for the matching question. Full response: ' + JSON.stringify(data));
  }

  return parseMatchingAnswer(answerText, rows);
}

async function getMatchingAnswerFromGemini(rows, apiKey) {
  const prompt = buildMatchingPrompt(rows);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: temperature,
      topP: top_p,
      maxOutputTokens: max_tokens
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gemini API error: ${data.error?.message || response.statusText}`);
  }

  const answerText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!answerText) {
    throw new Error('No answer received from Gemini for the matching question. Full response: ' + JSON.stringify(data));
  }

  return parseMatchingAnswer(answerText, rows);
}
```

- [ ] **Step 3: Add `handleGetMatchingAnswer` and wire it into the message listener**

Add to `background.js`, after `handleGetAnswer`:

```js
async function handleGetMatchingAnswer(rows, modelType) {
  try {
    const settings = await chrome.storage.sync.get(['geminiApiKey', 'openAiApiKey']);
    let rowAnswers;

    if (modelType === 'gpt') {
      const apiKey = settings.openAiApiKey;
      if (!apiKey) {
        throw new Error('OpenAI API key not configured. Please set it in the extension popup.');
      }
      rowAnswers = await getMatchingAnswerFromOpenAI(rows, apiKey);
    } else if (modelType === 'gemini') {
      const apiKey = settings.geminiApiKey;
      if (!apiKey) {
        throw new Error('Gemini API key not configured. Please set it in the extension popup.');
      }
      rowAnswers = await getMatchingAnswerFromGemini(rows, apiKey);
    } else if (modelType === 'chatgpt-web' || modelType === 'gemini-web') {
      const rawText = await askWebAi(modelType, wrapWebAiPrompt(buildMatchingPrompt(rows)));
      rowAnswers = parseMatchingAnswer(rawText, rows);
    } else {
      throw new Error('Unknown model type: ' + modelType);
    }

    return { success: true, rowAnswers: rowAnswers };
  } catch (error) {
    console.error('Error getting matching answer:', error);
    return { success: false, error: error.message };
  }
}
```

Update the `chrome.runtime.onMessage` listener's `getAnswer` branch (from Task 2) to check `request.isMatching` first:

```js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getAnswer') {
    if (request.isMatching) {
      handleGetMatchingAnswer(request.rows, request.modelType)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;
    }
    handleGetAnswer(
      request.question,
      request.options,
      request.modelType,
      request.isMultipleAnswer,
      request.requiredAnswers
    )
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep message channel open for async response
  }
  if (request.action === 'robustClickCdp') {
    handleRobustClickCdp(sender.tab.id, request.x, request.y)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});
```

- [ ] **Step 4: Manual test (full end-to-end)**

1. Run `node --test "tests/*.test.js"` — confirm all tests (including Task 1's) still pass.
2. Load the unpacked extension, confirm a normal MCQ quiz question still gets answered correctly by all three of `🤖`, `✨`, and `🌐 Web AI` (regression check on the `wrapWebAiPrompt` rename).
3. Find (or wait for) a quiz question rendered as a `.matching__widget` (per the design spec, this may take some searching across courses/modules since none was confirmed live during design). Click `🤖 Get Answer from GPT`:
   - Confirm `extractQuestionData()` returns the matching shape (check the console logs from `extractMatchingQuestionData`).
   - Confirm `background.js` returns `{ success: true, rowAnswers }`.
   - Confirm each row gets a green outline + a `title` tooltip naming the AI's suggested option, and that no option is auto-selected (the user still opens the dropdown and picks it themselves, per the existing "highlight only" convention).
4. Repeat with `✨ Get Answer from Gemini` and `🌐 Web AI` (both providers) on the same matching question.

- [ ] **Step 5: Commit**

```bash
git add background.js
git commit -m "feat: dispatch matching-question answers through OpenAI, Gemini, and Web AI"
```
