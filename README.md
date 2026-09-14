# netAIcad | AI Powered Netacad Quiz Helper

`netAIcad` is a Chrome/Firefox extension that uses AI to help answer Netacad quiz questions by highlighting the correct option.

## Features

- 🤖 **Dual AI Provider Support**:
  - **OpenAI GPT-4o Mini** - Fast and accurate for all question types
  - **Google Gemini 2.5 Flash** - Free tier available, great performance
- 🎯 Automatic question and option extraction from Netacad quizzes
- ✅ **Multiple-answer support** - Works with checkbox questions (choose two, choose three, etc.)
- ✨ Visual highlighting of suggested correct answers
- 🔐 Secure API key storage
- 🎨 Clean and intuitive dual-button UI (GPT and Gemini buttons)
- ⚡ Fast response times with both models
- 💡 Choose the best model for your needs

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

## Setup

### 1. Get API Keys

**Option A: OpenAI** (GPT-4o Mini)
- Sign up at [OpenAI Platform](https://platform.openai.com/)
- Get your API key from [OpenAI API Keys](https://platform.openai.com/api-keys)
- Very affordable pay-as-you-go pricing

**Option B: Google Gemini** (⭐ FREE - Recommended to start)
- Sign up at [Google AI Studio](https://makersuite.google.com/app/apikey)
- Get your free API key
- Generous free tier with excellent performance

**You can use one or both API keys!**

### 2. Configure the Extension

1. Click the extension icon in your browser toolbar
2. Enter your API key(s):
   - **OpenAI API Key** (for GPT-4o Mini)
   - **Google Gemini API Key** (for Gemini 2.5 Flash)
3. Click "Save Settings"

**Note:** You need at least one API key to use the extension. Both providers work great!

## Usage

1. Navigate to a Netacad quiz page
2. You'll see **two buttons** on the page once the quiz iframe loads:
   - **🤖 Get Answer from GPT** (Blue) - Uses OpenAI GPT-4o Mini
   - **✨ Get Answer from Gemini** (Purple) - Uses Google Gemini 2.5 Flash
3. Click the button for the AI provider you want to use
4. The extension will highlight the AI-suggested correct answer(s)
   - For single-answer questions (radio buttons): One option is highlighted
   - For multiple-answer questions (checkboxes): Multiple options are highlighted
5. Review the suggestion and make your selection

### Multiple-Answer Questions

The extension automatically detects when a question requires multiple answers (checkboxes instead of radio buttons) and will:
- Analyze the question text to determine how many answers are needed (e.g., "choose two", "select three")
- Request the correct number of answers from the AI
- Highlight all suggested correct answers in green

### Which Provider to Use? 🤔

Both models work great for all types of questions! Here are some considerations:

- **GPT-4o Mini**:
  - Very accurate and reliable
  - Pay-as-you-go pricing (affordable)
  - Great for all question types

- **Gemini 2.5 Flash**:
  - Free tier available (generous limits)
  - Excellent performance
  - Perfect for starting out or high-volume use

## Screenshots

Below are some screenshots demonstrating the extension in action:

### 1. Extension Popup Settings

![Extension Popup Settings](screenshots/popup-settings.png)

*Configure your API key and select your AI provider (Gemini or ChatGPT).*

---

### 2. AI Provider Buttons on Netacad Quiz

![AI Provider Buttons](screenshots/quiz-button.png)

*Two buttons appear on Netacad quiz pages: "🤖 Get Answer from GPT" and "✨ Get Answer from Gemini".*

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

1. **Content Script** (`content.js`) runs on Netacad pages and detects quiz elements using Shadow DOM
2. Netacad uses Shadow DOM to encapsulate quiz content, so the script accesses the `mcq-view` element's shadow root
3. The script extracts question text and options from inside the shadow DOM
4. The script detects if the question requires multiple answers (checkbox vs radio button)
5. User clicks either the **blue button** (GPT) or **purple button** (Gemini)
6. **Background Script** (`background.js`) sends the question to the selected AI provider (OpenAI or Google) with info about whether multiple answers are needed
7. The AI responds with the correct option letter(s) (e.g., "A" for single answer, or "A,B" for multiple answers)
8. The extension highlights the corresponding option(s) with inline styles (since CSS doesn't penetrate Shadow DOM)

## Files

- `manifest.json` - Extension configuration
- `content.js` - Script that runs on Netacad pages
- `content.css` - Styles for highlighting and button
- `background.js` - Service worker that handles AI API calls
- `popup.html` - Extension settings popup UI
- `popup.js` - Popup functionality

## Privacy & Security

- API keys are stored locally in Chrome's sync storage
- No data is sent to any server except the AI provider you choose (OpenAI or Google)
- The extension only runs on `netacad.com` domains
- Your quiz data is only sent to the AI provider when you click a button

## Limitations

- AI suggestions may not always be correct - always verify answers
- Requires at least one API key (OpenAI or Gemini)
- **Affordable/FREE options**:
  - **Gemini**: Free tier with generous limits (⭐ Recommended to start)
  - **OpenAI**: Very affordable pay-as-you-go pricing
- Works with multiple-choice questions (single and multiple answers)
- Both models work well for all question types
- The extension tries to auto-detect the number of required answers, but may default to 2 if unclear

## Troubleshooting

**Extension buttons not appearing**
- Make sure you're on a Netacad quiz page with multiple choice questions
- Refresh the page after installing the extension
- Check that both blue (GPT) and purple (Gemini) buttons are visible

**API errors**
- Verify your API key is correct in the extension popup
- For GPT button: Make sure you entered a valid OpenAI API key
- For Gemini button: Make sure you entered a valid Google Gemini API key
- Check that you have API credits/quota remaining
- Gemini has a generous free tier - start with that if you're unsure

**No answer highlighted**
- Check the browser console for errors (F12)
- Verify the question format is supported (must be multiple choice)
- Try the other provider button if one doesn't work
- Make sure you saved your API key(s) in the settings

## Disclaimer

This extension is for educational purposes only. Always verify AI suggestions and use your own judgment when answering quiz questions.
