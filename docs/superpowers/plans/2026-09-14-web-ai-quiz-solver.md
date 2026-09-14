# Web AI Quiz Solver (No-API-Key Fallback) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third, independent way to answer Netacad quiz questions — automating a real, visible ChatGPT or Gemini web chat tab (no API key, no rate limit) — selectable via a dropdown next to the existing GPT/Gemini API buttons.

**Architecture:** `content.js` gains a `🌐 Web AI` button + provider dropdown that reuses the existing question-extraction/highlighting code. `background.js` gains window/tab management (`ensureWebAiTab`) and two page-injected automation functions (`chatgptWebAutomationInPage`, `geminiWebAutomationInPage`) run via `chrome.scripting.executeScript`, which type the question into the real chat UI, wait for the reply to finish, and scrape it. Prompt-building and answer-letter-parsing are extracted into a new shared, Node-testable file (`shared.js`) reused by both the existing API code paths and the new web-automation code path.

**Tech Stack:** Vanilla JS, Chrome Extension Manifest V3 (`chrome.scripting`, `chrome.tabs`, `chrome.windows`), Node.js built-in `node:test`/`node:assert` for the one unit-testable module.

## Global Constraints

- Web AI window is a separate, normal-sized, **visible**, unfocused browser window (never minimized/background) — reused across the session, recreated if the user closes it.
- Dropdown defaults to **ChatGPT**; user can switch to **Gemini**.
- One long-lived conversation is reused per site (not a fresh chat per question) — every prompt is prefixed with an "ignore previous questions" instruction to reduce context bleed.
- No auto-submit/auto-advance — this feature only highlights the answer, matching the existing GPT/Gemini API buttons' behavior.
- Response wait timeout: 45 seconds.
- Manifest additions: permissions `"scripting"`, `"tabs"`; host permissions `"https://chatgpt.com/*"`, `"https://gemini.google.com/*"`.
- Errors (not logged in, timeout, selector/UI changed) must surface a clear message to the user — never fail silently.
- ChatGPT selectors (validated against working production code in `D:/Projects/AutoQuizSolver`):
  - Input: `#prompt-textarea`, fallback `[contenteditable="true"][id*="prompt"]`, fallback `div[contenteditable="true"]`.
  - Send: `[data-testid="send-button"]`, fallback `button[aria-label="Send prompt"]`, fallback `button[aria-label="Send"]`, final fallback: dispatch Enter keydown.
  - Still-streaming indicator: `[data-testid="stop-button"]`, `button[aria-label="Stop generating"]`, `button[aria-label="Stop streaming"]`.
  - Response: last `[data-message-author-role="assistant"]`, fallback `.markdown.prose`, fallback `.agent-turn`.
- Gemini selectors (validated live via Chrome DevTools MCP against `gemini.google.com/app`):
  - Input: `.ql-editor[contenteditable="true"]`, fallback `rich-textarea [contenteditable="true"]`, fallback `div[contenteditable="true"]`.
  - Send: `button[aria-label="Send message"]` (only when not disabled), final fallback: dispatch Enter keydown.
  - Response: last of `.model-response-text, message-content, .markdown.markdown-main-panel`.
  - Still-generating indicator: presence of `[aria-busy="true"]` anywhere on the page.
  - Completion detection for both sites: poll every 1s (45s timeout); consider the response "done" once its text stops changing across two consecutive polls **and** no streaming indicator is present.

---

## Task 1: Manifest permissions

**Files:**
- Modify: `manifest.json`

**Interfaces:**
- Produces: extension now has permission to inject scripts into and manage tabs on `chatgpt.com` and `gemini.google.com`, consumed by Task 3's `chrome.scripting`/`chrome.tabs`/`chrome.windows` calls.

- [ ] **Step 1: Add the new permissions and host permissions**

In `manifest.json`, change the `"permissions"` array and `"host_permissions"` array to:

```json
  "permissions": [
    "storage",
    "activeTab",
    "scripting",
    "tabs"
  ],
  "host_permissions": [
    "*://*.netacad.com/*",
    "https://chatgpt.com/*",
    "https://gemini.google.com/*"
  ],
```

- [ ] **Step 2: Verify the manifest is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json', 'utf8')); console.log('valid')"`
Expected output: `valid`

- [ ] **Step 3: Reload the unpacked extension and confirm no manifest errors**

In Chrome, go to `chrome://extensions/`, click the reload icon on netAIcad. Confirm no red "Errors" button appears on the extension card. Open a real Netacad quiz page and confirm the existing `🤖 Get Answer from GPT` / `✨ Get Answer from Gemini` buttons still appear and still work (click one, confirm an answer gets highlighted) — this is a regression check before any code changes.

- [ ] **Step 4: Commit**

```bash
git add manifest.json
git commit -m "feat: add scripting/tabs permissions and chatgpt/gemini host permissions"
```

---

## Task 2: Shared prompt-building and answer-parsing helpers

**Files:**
- Create: `shared.js`
- Create: `tests/shared.test.js`
- Modify: `background.js:1` (add `importScripts('shared.js');` at the very top)
- Modify: `background.js` (replace the inline prompt-building and letter-parsing code inside `getAnswerFromGemini` and `getAnswerFromOpenAI` with calls to the new shared helpers)

**Interfaces:**
- Produces: `buildPrompt(question, options, isMultipleAnswer, requiredAnswers) -> string`, `parseAnswerLetters(rawText, options, isMultipleAnswer, requiredAnswers) -> number | number[]` (throws `Error` on unparseable input). Both are attached as `globalThis` functions in the service worker (via `importScripts`) and as CommonJS exports for Node tests.
- Consumed by: Task 3's web-automation dispatcher branch, and by the refactored `getAnswerFromGemini`/`getAnswerFromOpenAI`.

- [ ] **Step 1: Write the failing tests**

Create `tests/shared.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt, parseAnswerLetters } = require('../shared.js');

test('buildPrompt formats a single-answer question with lettered options', () => {
  const prompt = buildPrompt('What is 2+2?', ['3', '4', '5'], false, 1);
  assert.match(prompt, /A\. 3/);
  assert.match(prompt, /B\. 4/);
  assert.match(prompt, /C\. 5/);
  assert.match(prompt, /Answer with only ONE letter:$/);
});

test('buildPrompt formats a multiple-answer question requiring N letters', () => {
  const prompt = buildPrompt('Pick two', ['a', 'b', 'c', 'd'], true, 2);
  assert.match(prompt, /EXACTLY 2 correct answer/);
  assert.match(prompt, /Answer with EXACTLY 2 letter\(s\) separated by commas:$/);
});

test('parseAnswerLetters extracts a single letter for single-answer questions', () => {
  const result = parseAnswerLetters('B', ['x', 'y', 'z'], false, 1);
  assert.equal(result, 1);
});

test('parseAnswerLetters extracts a single letter even with extra text around it', () => {
  const result = parseAnswerLetters('Letter C', ['x', 'y', 'z'], false, 1);
  assert.equal(result, 2);
});

test('parseAnswerLetters extracts multiple letters for multiple-answer questions', () => {
  const result = parseAnswerLetters('A,C', ['w', 'x', 'y', 'z'], true, 2);
  assert.deepEqual(result, [0, 2]);
});

test('parseAnswerLetters trims extra letters down to requiredAnswers', () => {
  const result = parseAnswerLetters('A,B,C', ['w', 'x', 'y', 'z'], true, 2);
  assert.deepEqual(result, [0, 1]);
});

test('parseAnswerLetters throws on a response with no valid letters', () => {
  assert.throws(() => parseAnswerLetters('42', ['x', 'y'], false, 1));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/shared.test.js`
Expected: FAIL — `Cannot find module '../shared.js'` (file doesn't exist yet).

- [ ] **Step 3: Create `shared.js` with the implementation**

Create `shared.js`:

```javascript
// shared.js - pure helper functions shared between the OpenAI/Gemini API
// code paths and the ChatGPT-web/Gemini-web automation code paths in
// background.js. Loaded into the service worker via importScripts('shared.js'),
// and requireable directly from Node for the tests in tests/shared.test.js.

function buildPrompt(question, options, isMultipleAnswer, requiredAnswers) {
  const letters = options.map((_, idx) => String.fromCharCode(65 + idx));
  const formattedOptions = options
    .map((opt, idx) => `${letters[idx]}. ${opt}`)
    .join('\n');
  const availableLetters = letters.join(', ');

  if (isMultipleAnswer) {
    return `IMPORTANT: This is a multiple-answer question. You MUST select EXACTLY ${requiredAnswers} correct answer(s). Not more, not less.

CRITICAL RULES:
1. You MUST provide EXACTLY ${requiredAnswers} letters
2. Separate letters with commas (e.g., "A,B" or "A,C,D")
3. Only use available letters: ${availableLetters}
4. No explanation, no extra text, no reasoning
5. ONLY output the ${requiredAnswers} correct letter(s)

Question: ${question}

Options:
${formattedOptions}

Answer with EXACTLY ${requiredAnswers} letter(s) separated by commas:`;
  }

  return `Answer this question with ONLY ONE letter from the available options: ${availableLetters}

CRITICAL RULES:
1. Output ONLY ONE letter
2. No explanation, no extra text
3. Only use available letters: ${availableLetters}

Question: ${question}

Options:
${formattedOptions}

Answer with only ONE letter:`;
}

function parseAnswerLetters(rawText, options, isMultipleAnswer, requiredAnswers) {
  const answerText = (rawText || '').trim().toUpperCase();
  const validLetters = options.map((_, idx) => String.fromCharCode(65 + idx)).join('');
  const validLetterPattern = new RegExp(`[${validLetters}]`, 'g');

  if (isMultipleAnswer) {
    const letterMatches = answerText.match(validLetterPattern);
    if (!letterMatches || letterMatches.length === 0) {
      throw new Error(`Invalid answer format. Expected letters from ${validLetters}, got: ${answerText}`);
    }
    const answerIndices = [...new Set(letterMatches)].map(letter => letter.charCodeAt(0) - 65);
    if (answerIndices.length > requiredAnswers) {
      answerIndices.splice(requiredAnswers);
    }
    return answerIndices;
  }

  const letterMatch = answerText.match(validLetterPattern);
  if (!letterMatch) {
    throw new Error(`Invalid answer format. Expected one letter from ${validLetters}, got: ${answerText}`);
  }
  return letterMatch[0].charCodeAt(0) - 65;
}

// Expose to Node for unit tests; ignored by the browser (module is undefined there).
if (typeof module !== 'undefined') {
  module.exports = { buildPrompt, parseAnswerLetters };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/shared.test.js`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Wire `shared.js` into the service worker**

In `background.js`, add as the very first line (before the `SYSTEM_PROMPT` constant):

```javascript
importScripts('shared.js');
```

- [ ] **Step 6: Refactor `getAnswerFromGemini` to use the shared helpers**

In `background.js`, inside `getAnswerFromGemini`, replace the whole prompt-building block (the `let prompt; if (isMultipleAnswer) { ... } else { ... }` section) with:

```javascript
  const prompt = buildPrompt(question, options, isMultipleAnswer, requiredAnswers);
```

Then, replace the final letter-extraction block (from `// Get valid letters based on number of options` down to the closing of the `if (isMultipleAnswer) { ... } else { ... }` that returns `answerIndices`/`answerIndex`) with:

```javascript
  return parseAnswerLetters(answerText, options, isMultipleAnswer, requiredAnswers);
```

Leave everything else in `getAnswerFromGemini` untouched (the fetch call, safety-filter checks, `finishReason` handling, and the `answerText` extraction from `data.candidates[0]` stay exactly as they are — only the prompt construction and the final parsing step change).

- [ ] **Step 7: Refactor `getAnswerFromOpenAI` to use the shared helpers**

Apply the same two replacements inside `getAnswerFromOpenAI`: swap its duplicated prompt-building block for `const prompt = buildPrompt(question, options, isMultipleAnswer, requiredAnswers);`, and swap its duplicated letter-extraction block for `return parseAnswerLetters(answerText, options, isMultipleAnswer, requiredAnswers);`.

- [ ] **Step 8: Manually verify no regression**

Reload the unpacked extension in `chrome://extensions/`. Open a real Netacad quiz. Click `🤖 Get Answer from GPT` on a single-answer question — confirm one option highlights green. Click `✨ Get Answer from Gemini` on a multi-answer ("choose two") question — confirm exactly two options highlight green. Check the DevTools console for the iframe (right-click the quiz iframe → Inspect) for any new errors.

- [ ] **Step 9: Commit**

```bash
git add shared.js tests/shared.test.js background.js
git commit -m "refactor: extract buildPrompt/parseAnswerLetters into shared.js with tests"
```

---

## Task 3: Web AI window management + browser automation in `background.js`

**Files:**
- Modify: `background.js` (add new functions; add two new branches to `handleGetAnswer`)

**Interfaces:**
- Consumes: `buildPrompt`, `parseAnswerLetters` from Task 2.
- Produces: `askWebAi(modelType, prompt) -> Promise<string>` (the raw scraped reply text; throws `Error` with a user-facing message on failure). `handleGetAnswer` now accepts `modelType === 'chatgpt-web'` and `modelType === 'gemini-web'` in addition to the existing `'gpt'`/`'gemini'`, consumed by Task 4's button click handler.

- [ ] **Step 1: Add site configuration and the in-memory window registry**

In `background.js`, after the existing constants (`SYSTEM_PROMPT`, `temperature`, etc.) and before `chrome.runtime.onMessage.addListener`, add:

```javascript
const WEB_AI_SITES = {
  'chatgpt-web': {
    url: 'https://chatgpt.com/',
    windowKey: 'chatgpt',
    siteName: 'ChatGPT',
  },
  'gemini-web': {
    url: 'https://gemini.google.com/app',
    windowKey: 'gemini',
    siteName: 'Gemini',
  },
};

// In-memory only: service workers can be evicted and this will reset, which
// is fine — ensureWebAiTab() always re-validates before reusing an entry.
const webAiWindows = {};
```

- [ ] **Step 2: Add `waitForTabLoad` and `ensureWebAiTab`**

Add below the code from Step 1:

```javascript
function waitForTabLoad(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out waiting for the Web AI tab to finish loading.'));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);

    // Cover the case where the tab is already 'complete' by the time we get here.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => {});
  });
}

async function ensureWebAiTab(modelType) {
  const config = WEB_AI_SITES[modelType];
  const existing = webAiWindows[config.windowKey];

  if (existing) {
    try {
      const tab = await chrome.tabs.get(existing.tabId);
      if (tab) {
        return existing.tabId;
      }
    } catch (e) {
      // Tab (or its window) no longer exists; fall through and recreate it.
    }
  }

  const win = await chrome.windows.create({
    url: config.url,
    type: 'normal',
    focused: false,
    width: 480,
    height: 720,
    left: 20,
    top: 20,
  });
  const tabId = win.tabs[0].id;
  webAiWindows[config.windowKey] = { windowId: win.id, tabId };

  await waitForTabLoad(tabId);
  return tabId;
}
```

- [ ] **Step 3: Add the ChatGPT page-injected automation function**

Add below the code from Step 2 (this function is passed by reference to `chrome.scripting.executeScript` in Step 5 — it runs inside the ChatGPT tab, not in the service worker, so it cannot reference anything outside itself):

```javascript
async function chatgptWebAutomationInPage(prompt) {
  function query(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  const input = query(['#prompt-textarea', '[contenteditable="true"][id*="prompt"]', 'div[contenteditable="true"]']);
  if (!input) {
    return { success: false, error: 'not-logged-in-or-selector-changed' };
  }

  input.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  document.execCommand('insertText', false, prompt);
  await new Promise((r) => setTimeout(r, 400));

  const sendBtn = query(['[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send"]']);
  if (sendBtn) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  await new Promise((r) => setTimeout(r, 1500));

  const deadline = Date.now() + 45000;
  let lastText = '';
  let stableCount = 0;

  while (Date.now() < deadline) {
    const stopBtn = query(['[data-testid="stop-button"]', 'button[aria-label="Stop generating"]', 'button[aria-label="Stop streaming"]']);
    const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
    const fallback1 = document.querySelectorAll('.markdown.prose');
    const fallback2 = document.querySelectorAll('.agent-turn');
    const list = messages.length ? messages : (fallback1.length ? fallback1 : fallback2);
    const currentText = list.length ? list[list.length - 1].textContent.trim() : '';

    if (!stopBtn && currentText && currentText === lastText) {
      stableCount++;
      if (stableCount >= 2) {
        return { success: true, text: currentText };
      }
    } else {
      stableCount = 0;
    }
    lastText = currentText;
    await new Promise((r) => setTimeout(r, 1000));
  }

  return lastText ? { success: true, text: lastText } : { success: false, error: 'timeout-no-response' };
}
```

- [ ] **Step 4: Add the Gemini page-injected automation function**

Add below the code from Step 3:

```javascript
async function geminiWebAutomationInPage(prompt) {
  function query(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  const input = query(['.ql-editor[contenteditable="true"]', 'rich-textarea [contenteditable="true"]', 'div[contenteditable="true"]']);
  if (!input) {
    return { success: false, error: 'not-logged-in-or-selector-changed' };
  }

  input.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  document.execCommand('insertText', false, prompt);
  await new Promise((r) => setTimeout(r, 400));

  const sendBtn = query(['button[aria-label="Send message"]']);
  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  await new Promise((r) => setTimeout(r, 1500));

  const deadline = Date.now() + 45000;
  let lastText = '';
  let stableCount = 0;

  while (Date.now() < deadline) {
    const responses = document.querySelectorAll('.model-response-text, message-content, .markdown.markdown-main-panel');
    const currentText = responses.length ? responses[responses.length - 1].textContent.trim() : '';
    const busy = document.querySelector('[aria-busy="true"]');

    if (!busy && currentText && currentText === lastText) {
      stableCount++;
      if (stableCount >= 2) {
        return { success: true, text: currentText };
      }
    } else {
      stableCount = 0;
    }
    lastText = currentText;
    await new Promise((r) => setTimeout(r, 1000));
  }

  return lastText ? { success: true, text: lastText } : { success: false, error: 'timeout-no-response' };
}
```

- [ ] **Step 5: Add `askWebAi` and the "ignore previous context" prompt wrapper**

Add below the code from Step 4:

```javascript
function buildWebAiPrompt(question, options, isMultipleAnswer, requiredAnswers) {
  const prefix = "Ignore all previous questions and answers in this conversation. Treat the following as a brand-new, unrelated question.\n\n";
  return prefix + buildPrompt(question, options, isMultipleAnswer, requiredAnswers);
}

async function askWebAi(modelType, prompt) {
  const config = WEB_AI_SITES[modelType];
  const tabId = await ensureWebAiTab(modelType);
  const func = modelType === 'chatgpt-web' ? chatgptWebAutomationInPage : geminiWebAutomationInPage;

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args: [prompt],
  });

  const result = results && results[0] ? results[0].result : null;

  if (!result || !result.success) {
    const reason = result ? result.error : 'unknown-error';
    if (reason === 'not-logged-in-or-selector-changed') {
      throw new Error(`Could not find the ${config.siteName} chat input. Please make sure you're logged in to ${config.siteName} in the Web AI window that just opened, then click the button again.`);
    }
    if (reason === 'timeout-no-response') {
      throw new Error(`Timed out waiting for a response from ${config.siteName}. Please try again.`);
    }
    throw new Error(`${config.siteName} automation failed: ${reason}`);
  }

  return result.text;
}
```

- [ ] **Step 6: Wire the two new `modelType` branches into `handleGetAnswer`**

In `background.js`, inside `handleGetAnswer`, change:

```javascript
    } else if (modelType === 'gemini') {
      const apiKey = settings.geminiApiKey;
      if (!apiKey) {
        throw new Error('Gemini API key not configured. Please set it in the extension popup.');
      }
      answerIndex = await getAnswerFromGemini(question, options, apiKey, isMultipleAnswer, requiredAnswers);
    } else {
      throw new Error('Unknown model type: ' + modelType);
    }
```

to:

```javascript
    } else if (modelType === 'gemini') {
      const apiKey = settings.geminiApiKey;
      if (!apiKey) {
        throw new Error('Gemini API key not configured. Please set it in the extension popup.');
      }
      answerIndex = await getAnswerFromGemini(question, options, apiKey, isMultipleAnswer, requiredAnswers);
    } else if (modelType === 'chatgpt-web' || modelType === 'gemini-web') {
      const prompt = buildWebAiPrompt(question, options, isMultipleAnswer, requiredAnswers);
      const rawText = await askWebAi(modelType, prompt);
      answerIndex = parseAnswerLetters(rawText, options, isMultipleAnswer, requiredAnswers);
    } else {
      throw new Error('Unknown model type: ' + modelType);
    }
```

- [ ] **Step 7: Manually verify ChatGPT-web end to end**

Reload the unpacked extension. Open a real Netacad quiz page (Task 4 hasn't added the button yet, so trigger it directly from the quiz iframe's console for this check):

```javascript
chrome.runtime.sendMessage({
  action: 'getAnswer',
  question: 'What is 2+2?',
  options: ['3', '4', '5'],
  modelType: 'chatgpt-web',
  isMultipleAnswer: false,
  requiredAnswers: 1
}, console.log);
```

Expected: a new, visible browser window opens pointed at `chatgpt.com` (or reuses one if you already ran this once this session), the prompt gets typed and sent, and after the reply finishes the console logs `{ success: true, answerIndex: 1 }` (index 1 = "4"). If you weren't logged in, expect `{ success: false, error: "Could not find the ChatGPT chat input..." }` instead — log in to the opened window and re-run the command to confirm it then succeeds.

- [ ] **Step 8: Manually verify Gemini-web end to end**

Repeat Step 7's console command with `modelType: 'gemini-web'`. Expected: a visible window opens pointed at `gemini.google.com/app`, the same flow completes, and the console logs a successful `answerIndex`.

- [ ] **Step 9: Commit**

```bash
git add background.js
git commit -m "feat: add ChatGPT-web/Gemini-web automation via chrome.scripting"
```

---

## Task 4: `🌐 Web AI` button + provider dropdown in the quiz UI

**Files:**
- Modify: `content.js` (inside `createHelperButton`)
- Modify: `content.css` (new button/select styles)

**Interfaces:**
- Consumes: `handleButtonClick(button, modelType, originalText)` (already generic, defined earlier in `content.js` — no changes needed to it), and the `chatgpt-web`/`gemini-web` `modelType` values from Task 3.
- Produces: two new DOM nodes, `#netacad-ai-webai-select` and `#netacad-ai-helper-btn-webai`, appended to the same document the GPT/Gemini buttons are appended to.

- [ ] **Step 1: Add the dropdown and button inside `createHelperButton`**

In `content.js`, inside `createHelperButton(targetDocument = document)`, right after the Gemini button's click handler is wired up (after the line `geminiButton.addEventListener('click', ...)` block) and before `targetDocument.body.appendChild(gptButton);`, add:

```javascript
  // Create Web AI provider select (ChatGPT / Gemini)
  const webAiSelect = targetDocument.createElement('select');
  webAiSelect.id = 'netacad-ai-webai-select';
  webAiSelect.className = 'ai-helper-select';

  const chatgptOption = targetDocument.createElement('option');
  chatgptOption.value = 'chatgpt-web';
  chatgptOption.textContent = 'ChatGPT';
  webAiSelect.appendChild(chatgptOption);

  const geminiWebOption = targetDocument.createElement('option');
  geminiWebOption.value = 'gemini-web';
  geminiWebOption.textContent = 'Gemini';
  webAiSelect.appendChild(geminiWebOption);

  // Create Web AI Button (Green)
  const webAiButton = targetDocument.createElement('button');
  webAiButton.id = 'netacad-ai-helper-btn-webai';
  webAiButton.innerHTML = '🌐 Web AI';
  webAiButton.className = 'ai-helper-button ai-helper-button-webai';

  webAiButton.addEventListener('click', async () => {
    const modelType = webAiSelect.value;
    await handleButtonClick(webAiButton, modelType, '🌐 Web AI');
  });
```

- [ ] **Step 2: Append the new elements to the page**

Immediately after the existing `targetDocument.body.appendChild(geminiButton);` line in `createHelperButton`, add:

```javascript
  targetDocument.body.appendChild(webAiSelect);
  targetDocument.body.appendChild(webAiButton);
```

- [ ] **Step 3: Guard against duplicate injection**

At the top of `createHelperButton`, the existing duplicate-check only tests for `netacad-ai-helper-btn-gpt`. That check already covers the whole button group (GPT is always created first, in the same function call, so if it exists the select/Web AI button exist too) — no change needed here, just confirm by reading the existing check:

```javascript
  if (document.getElementById('netacad-ai-helper-btn-gpt')) {
    console.log('Buttons already exist in main document');
    return;
  }
```

This already prevents the new elements from being duplicated on repeated calls — nothing to modify.

- [ ] **Step 4: Add styles for the dropdown and button in `content.css`**

In `content.css`, after the existing `.ai-helper-button-gemini:hover` rule block, add:

```css
/* Web AI provider select */
.ai-helper-select {
  position: fixed;
  right: 20px;
  top: 200px;
  z-index: 10000;
  min-width: 200px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid #d0d7de;
  font-size: 13px !important;
  font-weight: 600 !important;
  font-family: Arial, Helvetica, sans-serif !important;
  cursor: pointer;
}

/* Web AI Button (Green) */
.ai-helper-button-webai {
  top: 240px;
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
}

.ai-helper-button-webai:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(16, 185, 129, 0.6);
  background: linear-gradient(135deg, #34d399 0%, #10b981 100%);
}
```

In the existing `@media (max-width: 768px)` block at the bottom of `content.css`, after the `.ai-helper-button-gemini { top: 120px; }` rule, add:

```css
  .ai-helper-select {
    right: 10px;
    top: 170px;
    min-width: 160px;
    font-size: 12px !important;
  }

  .ai-helper-button-webai {
    top: 210px;
  }
```

- [ ] **Step 5: Manually verify the UI**

Reload the unpacked extension, open a real Netacad quiz page. Confirm you now see three buttons stacked on the right (`🤖 Get Answer from GPT`, `✨ Get Answer from Gemini`, `🌐 Web AI`) plus a dropdown above the green button showing "ChatGPT" selected by default. Click `🌐 Web AI` with ChatGPT selected — confirm the button shows "⏳ Analyzing..." and, once the automation window responds, the correct option highlights green exactly like the other two buttons. Switch the dropdown to "Gemini" and click again — confirm it targets `gemini.google.com` this time (check the automation window's tab).

- [ ] **Step 6: Commit**

```bash
git add content.js content.css
git commit -m "feat: add Web AI button + provider dropdown to quiz UI"
```

---

## Task 5: Popup note about the Web AI login requirement

**Files:**
- Modify: `popup.html`

**Interfaces:**
- None (static content only).

- [ ] **Step 1: Add a short note below the two API key fields**

In `popup.html`, immediately before the `<button id="saveBtn" ...>` line, add:

```html
  <div class="info" style="margin-bottom: 10px;">
    🌐 <strong>Web AI</strong> (no API key needed): the quiz page's "Web AI" button opens a real ChatGPT/Gemini tab for you. Make sure you're logged in there.
  </div>
```

- [ ] **Step 2: Manually verify**

Reload the unpacked extension, open the popup by clicking the extension icon. Confirm the new note renders below the Gemini key field and above the Save button, doesn't overflow the 320px width, and doesn't break the existing layout or the Test buttons added earlier.

- [ ] **Step 3: Commit**

```bash
git add popup.html
git commit -m "docs: note Web AI login requirement in popup"
```

---

## Task 6: Full end-to-end acceptance pass

**Files:** none (verification only).

- [ ] **Step 1: Run the automated unit tests one more time**

Run: `node --test tests/`
Expected: all tests pass (Task 2's 7 tests).

- [ ] **Step 2: Fresh quiz, ChatGPT path, repeated questions**

On a real Netacad quiz, click `🌐 Web AI` (ChatGPT selected) on 3+ different questions in a row. Confirm: the same automation window/tab is reused each time (no new window per question), each question gets highlighted correctly, and no rate-limit-style failures occur.

- [ ] **Step 3: Switch to Gemini mid-quiz**

Switch the dropdown to Gemini and click `🌐 Web AI` on the next question. Confirm a *second*, separate automation window opens for `gemini.google.com` (the ChatGPT window/tab from Step 2 stays open and reusable independently).

- [ ] **Step 4: Logged-out error path**

In the ChatGPT automation window, log out (or open its dev tools and clear cookies for the site). Click `🌐 Web AI` (ChatGPT) again on the quiz. Confirm the extension surfaces the "Could not find the ChatGPT chat input... make sure you're logged in" error (via the existing `alert(...)` in `handleButtonClick`'s catch path) instead of hanging indefinitely or crashing the service worker.

- [ ] **Step 5: Closed-window recovery**

Manually close the ChatGPT automation window. Click `🌐 Web AI` (ChatGPT) again. Confirm a new window is transparently created and the question still gets answered (no error about a missing window).

- [ ] **Step 6: Final regression check on the original two buttons**

Click `🤖 Get Answer from GPT` and `✨ Get Answer from Gemini` once more each, on any question, to confirm Task 2's refactor didn't change their behavior.
