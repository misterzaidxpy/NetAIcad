// Background service worker for handling AI API requests

importScripts('shared.js');

const SYSTEM_PROMPT = `SYSTEM:
You are an AI assistant that answers multiple-choice questions with extreme precision.

CRITICAL RULES - YOU MUST FOLLOW THESE EXACTLY:
1. Think carefully before answering; simulate code or calculate math internally
2. ONLY output the letter(s) specified in the prompt (e.g., A, B, C, D, E, F)
3. If asked for ONE letter, provide EXACTLY ONE letter
4. If asked for N letters, provide EXACTLY N letters separated by commas
5. NEVER include explanations, reasoning, punctuation, or extra text
6. NEVER output more or fewer letters than requested
7. Follow the EXACT format specified in the user prompt

Your response must contain ONLY the requested letter(s) and nothing else.
End.
`
const temperature = 0;
const top_p = 1.0;
const max_tokens = 2000; // Increased for Gemini compatibility
const presence_penalty = 0;
const frequency_penalty = 0;

const WEB_AI_SITES = {
  'chatgpt-web': {
    url: 'https://chatgpt.com/',
    windowKey: 'chatgpt',
    siteName: 'ChatGPT',
    left: 20,
    top: 20,
  },
  'gemini-web': {
    url: 'https://gemini.google.com/app',
    windowKey: 'gemini',
    siteName: 'Gemini',
    left: 520,
    top: 20,
  },
};

// In-memory only: service workers can be evicted and this will reset, which
// is fine — ensureWebAiTab() always re-validates before reusing an entry.
const webAiWindows = {};

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
    left: config.left,
    top: config.top,
  });

  const tabId = win.tabs[0].id;
  webAiWindows[config.windowKey] = { tabId };

  await waitForTabLoad(tabId);
  return tabId;
}

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

function buildWebAiPrompt(question, options, isMultipleAnswer, requiredAnswers) {
  const prefix = "Ignore all previous questions and answers in this conversation. Treat the following as a brand-new, unrelated question.\n\n";
  return prefix + buildPrompt(question, options, isMultipleAnswer, requiredAnswers);
}

async function askWebAi(modelType, prompt) {
  const config = WEB_AI_SITES[modelType];
  const tabId = await ensureWebAiTab(modelType);
  const func = modelType === 'chatgpt-web' ? chatgptWebAutomationInPage : geminiWebAutomationInPage;

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func,
      args: [prompt],
    });
  } catch (e) {
    throw new Error(`Lost connection to the ${config.siteName} tab (it may have been closed or navigated away). Please try again.`);
  }

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

async function handleGetAnswer(question, options, modelType, isMultipleAnswer = false, requiredAnswers = 1) {
  try {
    // Get settings from storage
    const settings = await chrome.storage.sync.get([
      'geminiApiKey',
      'openAiApiKey'
    ]);

    let answerIndex;

    if (modelType === 'gpt') {
      const apiKey = settings.openAiApiKey;
      if (!apiKey) {
        throw new Error('OpenAI API key not configured. Please set it in the extension popup.');
      }
      answerIndex = await getAnswerFromOpenAI(question, options, apiKey, isMultipleAnswer, requiredAnswers);
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

    return { success: true, answerIndex: answerIndex };
  } catch (error) {
    console.error('Error getting answer:', error);
    return { success: false, error: error.message };
  }
}

async function getAnswerFromGemini(question, options, apiKey, isMultipleAnswer = false, requiredAnswers = 1) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const prompt = buildPrompt(question, options, isMultipleAnswer, requiredAnswers);

  const requestBody = {
    contents: [{
      parts: [{
        text: prompt
      }]
    }],
    generationConfig: {
      temperature: temperature,
      topP: top_p,
      maxOutputTokens: max_tokens
    },
    safetySettings: [
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_NONE"
      },
      {
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_NONE"
      },
      {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: "BLOCK_NONE"
      },
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_NONE"
      }
    ]
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  const data = await response.json();
  console.log('Gemini raw response:', data);
  console.log('Response status:', response.status, response.statusText);

  if (!response.ok) {
    console.error('Gemini API error response:', data);
    throw new Error(`Gemini API error: ${data.error?.message || response.statusText}`);
  }

  console.log('Gemini API response (formatted):', JSON.stringify(data, null, 2));

  // Check if response has the expected structure
  if (!data || typeof data !== 'object' || !data.candidates || data.candidates.length === 0) {
    console.error('Unexpected Gemini response structure:', data);
    console.error('data.candidates:', data.candidates);
    throw new Error('Gemini returned no candidates or an invalid response structure. Full response: ' + JSON.stringify(data));
  }

  // Log the candidate structure for debugging
  console.log('First candidate structure:', JSON.stringify(data.candidates[0], null, 2));

  // Check if content was blocked by safety filters (but MAX_TOKENS is OK if we have content)
  const candidate = data.candidates[0];
  const blockingReasons = ['SAFETY', 'RECITATION', 'OTHER'];

  if (candidate.finishReason && blockingReasons.includes(candidate.finishReason)) {
    console.error('Gemini blocked or filtered the response. Finish reason:', candidate.finishReason);
    console.error('Safety ratings:', candidate.safetyRatings);
    throw new Error(`Gemini blocked the response. Reason: ${candidate.finishReason}. This might be due to content filters.`);
  }

  // Log finish reason for debugging
  if (candidate.finishReason) {
    console.log('Gemini finish reason:', candidate.finishReason);
  }

  const answerText = data.candidates[0]?.content?.parts?.[0]?.text?.trim().toUpperCase();

  if (!answerText) {
    console.error('Could not extract answer text from candidate:', data.candidates[0]);
    console.error('Content:', data.candidates[0]?.content);
    console.error('Parts:', data.candidates[0]?.content?.parts);

    // More detailed error message
    let errorDetails = 'No answer received from Gemini. ';
    if (!data.candidates[0]?.content) {
      errorDetails += 'Response has no content. ';
    } else if (!data.candidates[0]?.content?.parts) {
      errorDetails += 'Content has no parts. ';
    } else if (!data.candidates[0]?.content?.parts?.[0]) {
      errorDetails += 'Parts array is empty. ';
    } else if (!data.candidates[0]?.content?.parts?.[0]?.text) {
      errorDetails += 'First part has no text. ';
    }
    errorDetails += 'Full response: ' + JSON.stringify(data.candidates[0]);

    throw new Error(errorDetails);
  }

  console.log('Gemini answer text:', answerText);

  return parseAnswerLetters(answerText, options, isMultipleAnswer, requiredAnswers);
}

async function getAnswerFromOpenAI(question, options, apiKey, isMultipleAnswer = false, requiredAnswers = 1) {
  const url = 'https://api.openai.com/v1/chat/completions';

  const prompt = buildPrompt(question, options, isMultipleAnswer, requiredAnswers);

  const requestBody = {
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: prompt
      }
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

  console.log('OpenAI full response:', JSON.stringify(data, null, 2));
  console.log('Response status:', response.status, response.statusText);

  if (!response.ok) {
    console.error('OpenAI API error response:', data);
    throw new Error(`OpenAI API error: ${data.error?.message || response.statusText}`);
  }

  const rawContent = data.choices?.[0]?.message?.content;
  const answerText = rawContent?.trim().toUpperCase();

  if (!answerText) {
    console.error('Empty or undefined answer text from OpenAI');
    console.error('Raw content:', rawContent);
    console.error('Finish reason:', data.choices?.[0]?.finish_reason);
    console.error('Full response data:', JSON.stringify(data, null, 2));

    let errorDetails = 'No answer received from OpenAI. ';
    if (!data.choices) {
      errorDetails += 'Response has no choices array. ';
    } else if (data.choices.length === 0) {
      errorDetails += 'Choices array is empty. ';
    } else if (!data.choices[0].message) {
      errorDetails += 'First choice has no message. ';
    } else if (!data.choices[0].message.content) {
      errorDetails += 'Message has no content. ';
    } else if (data.choices[0].message.content.trim() === '') {
      errorDetails += 'Message content is empty/whitespace. ';
    }

    if (data.choices[0]?.finish_reason === 'length') {
      errorDetails += 'Response was cut off due to token limit. ';
    }

    errorDetails += 'Full response: ' + JSON.stringify(data);
    throw new Error(errorDetails);
  }

  console.log('OpenAI raw answer:', answerText);

  return parseAnswerLetters(answerText, options, isMultipleAnswer, requiredAnswers);
}

