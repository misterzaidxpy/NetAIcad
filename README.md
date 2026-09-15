# netAIcad | AI Powered Netacad Helper

`netAIcad` is a Chrome/Firefox extension that uses AI to solve Netacad quizzes and automate reading through course modules — with or without paying for an API key.

## Features

- 🤖 **Three ways to solve a quiz**:
  - **OpenAI GPT-4o Mini** — via your own API key
  - **Google Gemini 2.5 Flash** — via your own API key, free tier available
  - **🌐 Web AI (ChatGPT)** — no API key at all. Drives the real `chatgpt.com` web UI in a tab for you and **auto-solves the entire quiz end-to-end** (every question, submitted automatically, no manual clicking per question)
- 🧩 **Matching questions supported** — the "match each item to its option" question type is fully supported by every provider above, not just plain multiple-choice
- ✅ **Multiple-answer support** — works with checkbox questions (choose two, choose three, etc.)
- 🖱️ **Auto-select and auto-submit** — the extension doesn't just suggest an answer, it selects it and clicks Submit for you
- 🚶 **Auto-Complete Module walker** — a one-click button that walks the current module's reading sections, click-to-reveal boxes, and embedded self-check questions on your behalf, then stops and hands off at the module's real graded quiz
- 🎯 Automatic question and option extraction from Netacad quizzes (Shadow DOM aware)
- ✨ Visual highlighting of suggested correct answers
- 🔐 Secure API key storage (only needed if you want the API-based providers)
- 🎨 Compact, icon-based buttons that only appear when there's actually something for them to do

## Installation

### Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" in the top right
3. Click "Load unpacked"
4. Select the `netAIcad` folder
5. The extension should now appear in your extensions list

### Firefox

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Navigate to the `netAIcad` folder and select `manifest.json`
4. The extension should now be loaded

> **Note:** the trusted-click fallback (used when a plain synthetic click doesn't register on a Netacad widget) relies on `chrome.debugger`, which is Chrome-only. The extension still works in Firefox, but that specific fallback won't be available there.

## Setup

### Option A — Web AI (no account/API key needed)

1. Just be logged in to [chatgpt.com](https://chatgpt.com) in your regular browser.
2. That's it — the **🌐 Web AI** button on a quiz page will open (or reuse) a ChatGPT tab, type the question in for you, and read back the answer, all automatically.

### Option B — Your own API key

**OpenAI** (GPT-4o Mini)
- Sign up at [OpenAI Platform](https://platform.openai.com/)
- Get your API key from [OpenAI API Keys](https://platform.openai.com/api-keys)
- Very affordable pay-as-you-go pricing

**Google Gemini** (⭐ FREE tier available)
- Sign up at [Google AI Studio](https://makersuite.google.com/app/apikey)
- Get your free API key
- Generous free tier with excellent performance

Then, in the extension popup:

1. Click the extension icon in your browser toolbar
2. Paste your API key(s) and click **Test** to confirm they work
3. Click **Save Settings**

**You can mix and match** — set up one, both, or neither (and just use Web AI) API key(s).

## Usage

### Solving a quiz

On a real graded quiz page, up to three buttons appear automatically once Netacad's quiz widget loads:

- **🤖 Get Answer from GPT** — uses your OpenAI key
- **✨ Get Answer from Gemini** — uses your Gemini key
- **🌐 Solve via Web AI** — no key needed; click it once and it solves the *entire* quiz, question after question, selecting and submitting each answer automatically until it's done or you hit Stop

For the GPT/Gemini buttons, each click answers the current question only: the extension extracts the question (including matching-question rows), asks the AI, then selects and submits the suggested answer(s) for you. These buttons only show up while an actual graded quiz is on screen — not on regular reading pages.

### Auto-Complete Module walker

While reading through a module's content (not on a quiz), a walker button appears. Clicking it:

1. Walks every remaining incomplete section in the **current module only**
2. Handles plain reading sections (smooth-scrolls through them so Netacad's own "seen" tracking fires), click-to-reveal boxes, and embedded self-check questions
3. Skips things it can't safely automate — Labs, Practices, videos, and anything unrecognized — and lists them at the end so you know what to finish manually
4. Stops and hands off to you the moment it reaches the module's real graded quiz/test
5. Shows a floating progress overlay with a **Stop** button so you can cancel at any time

## Which Provider to Use? 🤔

- **Web AI (ChatGPT)** — best if you don't want to pay for or manage an API key at all, and don't mind a browser tab briefly popping into focus while it works.
- **GPT-4o Mini** — very accurate and reliable, cheap pay-as-you-go pricing, answers one question per click.
- **Gemini 2.5 Flash** — free tier with generous limits, great for high-volume use.

## Screenshots

Below are some screenshots demonstrating the extension in action:

### 1. Extension Popup Settings

![Extension Popup Settings](screenshots/popup-settings.png)

*Configure your API key(s) and test them right from the popup.*

---

### 2. AI Provider Buttons on Netacad Quiz

![AI Provider Buttons](screenshots/quiz-button.png)

*Buttons appear on Netacad quiz pages only while a graded quiz is active: GPT, Gemini, and Web AI.*

---

### 3. Highlighted AI-Suggested Answer (Simple)

![Highlighted Answer](screenshots/answer-highlight.png)

*The extension highlights the AI-suggested correct answer with a green border.*

---

### 3. Highlighted AI-Suggested Answer (Code)

![Highlighted Answer](screenshots/coding-highlight.png)

*The extension highlights the AI-suggested correct answer with a green border.*

---

### 4. Get Better Result

![Final Result](screenshots/score.png)

*The extension give you better results with 90% accuracy*

---

### 5. Complete the Course in less time

![Course Completion](screenshots/completion.png)

*The extension complete your course in no time*

---

## How It Works

### Quiz solving

1. **Content Script** (`content.js`) runs on Netacad pages (in every frame) and detects quiz elements inside Shadow DOM (`mcq-view`, matching widgets, etc.)
2. It extracts the question text, options, whether it's single/multiple-answer, and — for matching questions — every row and its own option list
3. Depending on which button you clicked:
   - **GPT/Gemini**: **Background Script** (`background.js`) sends the question to the OpenAI or Google API and gets back the correct letter(s) or row answers
   - **Web AI**: `background.js` opens/reuses a `chatgpt.com` tab in your current window, briefly focuses it (to dodge Chrome's background-tab throttling), types the question in, waits for the reply, and parses it — then automatically repeats this for every remaining question in the quiz
4. Either way, the extension then **selects** the suggested option(s)/row-matches using trusted clicks and **submits** the answer, advancing to the next question
5. `shared.js` holds the prompt-building and answer-parsing logic used by both the API and Web AI code paths (and is unit-tested — see [Testing](#testing))

### Trusted clicks

Some of Netacad's Angular-based custom widgets ignore synthetic `element.click()` calls. `robustClick()` tries a plain click first and, if it doesn't register, falls back to a `chrome.debugger`-dispatched trusted input event via the background script.

### Module walker

The walker reads the course outline sidebar to find the current module's remaining topics, opens each one, and classifies its content (reading / click-to-reveal / self-check / video / unsupported) to decide how to handle it — using a real animated `scrollIntoView({behavior: 'smooth'})` for reading sections so Netacad's own scroll-based "seen" tracking fires correctly. It stops the moment it detects the module's actual graded quiz/test, never attempting to answer it automatically.

## Files

- `manifest.json` - Extension configuration
- `content.js` - Runs on Netacad pages: quiz solving UI/logic and the module walker
- `content.css` - Styles for buttons, highlighting, and the progress overlay
- `background.js` - Service worker: AI API calls, Web AI tab automation, trusted-click fallback
- `shared.js` - Pure prompt-building/answer-parsing helpers shared by the API and Web AI code paths
- `popup.html` / `popup.js` - Extension settings popup UI
- `tests/` - Unit tests for `shared.js` (Node's built-in test runner, no dependencies)

## Testing

```bash
node --test "tests/*.test.js"
```

## Privacy & Security

- API keys are stored locally in Chrome's sync storage
- No data is sent to any server except the AI provider you choose (OpenAI, Google, or ChatGPT's own web UI)
- The extension only runs on `netacad.com` domains (plus `chatgpt.com`/`gemini.google.com` purely to drive the Web AI tab)
- The `chrome.debugger` permission is only ever used as a same-tab, same-session trusted-click fallback — it isn't used to inspect or log anything
- Your quiz data is only sent to an AI provider when you click a button

## Limitations

- AI suggestions may not always be correct - always verify answers
- Web AI requires you to already be logged in to `chatgpt.com` in your browser
- The module walker only walks the *current* module and stops at its graded quiz/test — it never attempts to answer a graded quiz for you
- The walker skips Labs, Practices, videos, and any content type it doesn't recognize, and lists them for manual review instead of guessing
- A few topics (e.g. an external "Final Project" submission tool) live outside Netacad's own content iframe entirely and aren't supported by the walker

## Troubleshooting

**Extension buttons not appearing**
- Make sure you're on a Netacad quiz page with an active graded quiz (the GPT/Gemini/Web AI buttons only show up then) or a module content page (for the walker button)
- Refresh the page after installing or updating the extension

**API errors (GPT/Gemini)**
- Verify your API key is correct in the extension popup, and use the **Test** button to confirm
- Check that you have API credits/quota remaining

**Web AI not working**
- Make sure you're logged in to `chatgpt.com` in the tab it opens
- If it can't find the chat input, click the button again after the ChatGPT tab finishes loading

**No answer highlighted / selected**
- Check the browser console for errors (F12)
- Try a different provider button if one doesn't work
- If you see an "extension context invalidated" message, refresh the tab (this happens after reloading the extension itself)

## Disclaimer

This extension is for educational purposes only. Always verify AI suggestions and use your own judgment when answering quiz questions.
