// Content script for Netacad Quiz Helper
console.log('Netacad Quiz Helper: Content script loaded in quiz iframe');
console.log('Current URL:', window.location.href);

// Function to search for elements in Shadow DOM
function findInShadowDOM(selector, root = document) {
  // First try to find in the regular DOM
  let elements = Array.from(root.querySelectorAll(selector));

  // Then search in all shadow roots
  const allElements = root.querySelectorAll('*');
  allElements.forEach(el => {
    if (el.shadowRoot) {
      elements = elements.concat(findInShadowDOM(selector, el.shadowRoot));
    }
  });

  return elements;
}

// Function to get text content from Shadow DOM element
function getTextFromShadowElement(element) {
  if (!element) return '';

  // Try regular textContent first
  if (element.textContent && element.textContent.trim()) {
    return element.textContent.trim();
  }

  // If element has shadow root, search inside it
  if (element.shadowRoot) {
    return element.shadowRoot.textContent?.trim() || '';
  }

  return '';
}

// Helper function to wait for an element to appear in shadow DOM
async function waitForElement(parentElement, selector, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    const element = parentElement.querySelector(selector);
    if (element) {
      return element;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

// Helper function to wait for shadow root content to load
async function waitForShadowContent(element, maxAttempts = 20) {
  if (!element || !element.shadowRoot) return null;

  for (let i = 0; i < maxAttempts; i++) {
    if (element.shadowRoot.children.length > 0) {
      return element.shadowRoot;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return element.shadowRoot;
}

// Recursive function to find an element in shadow DOM tree
function findElementInShadowDOM(root, selector) {
  // Try to find in current level
  let element = root.querySelector(selector);
  if (element) return element;

  // Search in all shadow roots
  const allElements = root.querySelectorAll('*');
  for (let el of allElements) {
    if (el.shadowRoot) {
      element = findElementInShadowDOM(el.shadowRoot, selector);
      if (element) return element;
    }
  }

  return null;
}

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

// Function to extract question and options (based on iframe.js)
async function extractQuestionData() {
  console.log('=== Starting Question Extraction ===');

  try {
    // Find ALL mcq-view elements and pick the visible/active one
    console.log('🔍 Searching for active mcq-view...');

    // Get all mcq-view elements recursively
    let allMcqViews = [];
    function findAllMcqViews(root) {
      const mcqViews = root.querySelectorAll('mcq-view');
      allMcqViews.push(...mcqViews);

      const allElements = root.querySelectorAll('*');
      for (let el of allElements) {
        if (el.shadowRoot) {
          findAllMcqViews(el.shadowRoot);
        }
      }
    }

    findAllMcqViews(document);
    console.log(`Found ${allMcqViews.length} total mcq-view elements`);

    if (allMcqViews.length === 0) {
      console.log('❌ No mcq-view found in entire shadow DOM tree');
      return null;
    }

    // Find the visible/active mcq-view
    // The current question is typically the LAST visible one
    let mcqViewElement = null;
    let visibleMcqViews = [];

    // Strategy 1: Find all visible mcq-views
    for (let mcq of allMcqViews) {
      const parent = mcq.closest('.block__container, [class*="block"]');
      if (parent) {
        const style = window.getComputedStyle(parent);
        const isVisible = style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0';

        // Also check if parent has 'animate' or 'active' class
        const hasActiveClass = parent.classList.contains('animate') ||
          parent.classList.contains('active') ||
          parent.classList.contains('is-active');

        console.log(`mcq-view check: visible=${isVisible}, hasActiveClass=${hasActiveClass}, classes=${parent.className}`);

        if (isVisible) {
          visibleMcqViews.push(mcq);
          console.log(`Added to visible list (${visibleMcqViews.length} total visible)`);
        }
      }
    }

    // Strategy 2: Pick the LAST visible mcq-view (the current question)
    if (visibleMcqViews.length > 0) {
      mcqViewElement = visibleMcqViews[visibleMcqViews.length - 1];
      console.log(`✅ Found active mcq-view (last visible, ${visibleMcqViews.length} visible total)`);
    }

    // Strategy 3: If no visible ones found, take the last one overall
    if (!mcqViewElement && allMcqViews.length > 0) {
      mcqViewElement = allMcqViews[allMcqViews.length - 1];
      console.log('✅ Using last mcq-view element (fallback)');
    }

    if (!mcqViewElement) {
      console.log('❌ Could not determine active mcq-view');
      return null;
    }

    console.log('✅ Selected mcq-view element');

    if (!mcqViewElement.shadowRoot) {
      console.log('❌ mcq-view has no shadow root');
      return null;
    }

    let mcqView = mcqViewElement.shadowRoot.querySelector("div");
    if (!mcqView) {
      console.log('❌ No div in mcq-view shadow root');
      return null;
    }

    console.log('✅ Found mcq-view div');

    // Now extract question and options (steps 16-17 from iframe.js)
    // 16. Get question text
    let headerContainer = mcqView.querySelector("div[class='component__header-container']");
    if (!headerContainer) {
      console.log('❌ No component__header-container found');
      return null;
    }

    let baseView = headerContainer.querySelector("base-view");
    if (!baseView || !baseView.shadowRoot) {
      console.log('❌ No base-view or its shadow root found');
      return null;
    }

    let bodyInner = baseView.shadowRoot.querySelector("div[class='component__body-inner mcq__body-inner']");
    if (!bodyInner) {
      console.log('❌ No component__body-inner found');
      return null;
    }

    let questionText = bodyInner.textContent.trim();
    console.log('📝 Extracted question:', questionText.substring(0, 150));

    // Check if there's a code-with-mcq element (contains code snippet)
    let codeText = '';
    const codeWithMcq = mcqView.querySelector('code-with-mcq');
    if (codeWithMcq && codeWithMcq.shadowRoot) {
      const codeComponent = codeWithMcq.shadowRoot.querySelector("div[class='component']");
      if (codeComponent) {
        codeText = codeComponent.textContent.trim();
        console.log('📝 Found code snippet:', codeText.substring(0, 150));
        // Append code to question text
        questionText = questionText + '\n\nCode:\n' + codeText;
        console.log('📝 Question with code:', questionText);
      }
    }
    else {
      console.log('📝 No code-with-mcq element found, checking for sgpluse-codewindowwithmcq-view');
      if (mcqView) {
        const codeComponent = mcqView.querySelector("sgpluse-codewindowwithmcq-view")
        if (codeComponent && codeComponent.shadowRoot) {
          const codeShadowRoot = codeComponent.shadowRoot
          const codePre = codeShadowRoot.querySelector("pre")
          const codeCode = codePre.querySelector('code')
          console.log('📝 Found code component:', codeCode);
          if (codeCode) {
            let codeWebComponent = codeCode.querySelector('code-window-webcomponent-mcq');
            if (codeWebComponent && codeWebComponent.shadowRoot) {
              codeText = codeWebComponent.shadowRoot.querySelector('div[class="code-container"]').textContent.trim();
            }
            console.log('📝 Found code snippet:', codeText);
            // Append code to question text
            questionText = questionText + '\n\nCode:\n' + codeText;
            console.log('📝 Question with code:', questionText);
          }
        }
        else {
          console.log('❌ No sgpluse-codewindowwithmcq-view element found');
        }
      }
    }

    // 17. Get options
    let optionNodes = mcqView.querySelectorAll('.mcq__item-text-inner');
    if (optionNodes.length === 0) {
      console.log('❌ No option nodes found');
      return null;
    }

    console.log(`✅ Found ${optionNodes.length} options`);

    let options = Array.from(optionNodes).map((node, index) => {
      const text = node.textContent.trim();
      console.log(`Option ${index}: ${text.substring(0, 50)}`);
      return {
        index: index,
        text: text,
        element: node.closest('.mcq__item')
      };
    });

    // Detect if this is a multiple-answer question (checkbox)
    // Check for checkbox input type
    const firstOption = mcqView.querySelector('.mcq__item');
    let isMultipleAnswer = false;
    let requiredAnswers = 1;

    if (firstOption) {
      // Look for input type (checkbox vs radio)
      const inputElement = firstOption.querySelector('input[type="checkbox"]');
      if (inputElement) {
        isMultipleAnswer = true;
        console.log('✅ Detected CHECKBOX question (multiple answers possible)');
      } else {
        console.log('✅ Detected RADIO question (single answer)');
      }
    }

    // Try to detect number of required answers from question text
    if (isMultipleAnswer) {
      const questionLower = questionText.toLowerCase();

      // Match patterns like "choose two", "select three", "choose 2", etc.
      const patterns = [
        /choose\s+(two|three|four|five|2|3|4|5)/i,
        /select\s+(two|three|four|five|2|3|4|5)/i,
        /pick\s+(two|three|four|five|2|3|4|5)/i,
        /identify\s+(two|three|four|five|2|3|4|5)/i
      ];

      const numberMap = {
        'two': 2, '2': 2,
        'three': 3, '3': 3,
        'four': 4, '4': 4,
        'five': 5, '5': 5
      };

      for (const pattern of patterns) {
        const match = questionLower.match(pattern);
        if (match && match[1]) {
          const num = numberMap[match[1].toLowerCase()];
          if (num) {
            requiredAnswers = num;
            console.log(`✅ Detected ${requiredAnswers} required answers from question text`);
            break;
          }
        }
      }

      // If still couldn't detect, default to 2 for checkbox questions
      if (requiredAnswers === 1) {
        requiredAnswers = 2;
        console.log('⚠️ Could not detect number of answers, defaulting to 2');
      }
    }

    console.log('=== Extraction Complete ===\n');

    return {
      question: questionText,
      options: options,
      isMultipleAnswer: isMultipleAnswer,
      requiredAnswers: requiredAnswers
    };

  } catch (error) {
    console.error('❌ Error during extraction:', error);
    return null;
  }
}

// Function to highlight the correct answer(s)
// correctOptionIndices can be a single index or an array of indices
function highlightCorrectAnswer(correctOptionIndices) {
  console.log('=== Starting Highlight ===');

  // Normalize to array
  const indices = Array.isArray(correctOptionIndices) ? correctOptionIndices : [correctOptionIndices];
  console.log('Highlighting option indices:', indices);

  try {
    // Find ALL mcq-view elements and pick the visible/active one (same as extraction)
    let allMcqViews = [];
    function findAllMcqViews(root) {
      const mcqViews = root.querySelectorAll('mcq-view');
      allMcqViews.push(...mcqViews);

      const allElements = root.querySelectorAll('*');
      for (let el of allElements) {
        if (el.shadowRoot) {
          findAllMcqViews(el.shadowRoot);
        }
      }
    }

    findAllMcqViews(document);
    console.log(`Found ${allMcqViews.length} total mcq-view elements for highlighting`);

    if (allMcqViews.length === 0) {
      console.log('❌ No mcq-view found for highlighting');
      return;
    }

    // Find the visible/active mcq-view (same logic as extraction)
    let mcqViewElement = null;
    let visibleMcqViews = [];

    for (let mcq of allMcqViews) {
      const parent = mcq.closest('.block__container, [class*="block"]');
      if (parent) {
        const style = window.getComputedStyle(parent);
        const isVisible = style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0';

        if (isVisible) {
          visibleMcqViews.push(mcq);
        }
      }
    }

    // Pick the LAST visible mcq-view (the current question)
    if (visibleMcqViews.length > 0) {
      mcqViewElement = visibleMcqViews[visibleMcqViews.length - 1];
      console.log(`✅ Found active mcq-view for highlighting (last visible, ${visibleMcqViews.length} visible total)`);
    }

    // Fallback: use the last one overall
    if (!mcqViewElement && allMcqViews.length > 0) {
      mcqViewElement = allMcqViews[allMcqViews.length - 1];
      console.log('✅ Using last mcq-view for highlighting (fallback)');
    }

    if (!mcqViewElement) {
      console.log('❌ Could not determine active mcq-view for highlighting');
      return;
    }

    console.log('✅ Selected mcq-view for highlighting');

    if (!mcqViewElement.shadowRoot) {
      console.log('❌ mcq-view has no shadow root');
      return;
    }

    let mcqView = mcqViewElement.shadowRoot.querySelector("div");
    if (!mcqView) {
      console.log('❌ No div in mcq-view shadow root');
      return;
    }

    // Get all option elements
    const optionElements = mcqView.querySelectorAll('.mcq__item');
    console.log(`Found ${optionElements.length} option elements for highlighting`);

    // Remove any existing highlights
    optionElements.forEach(element => {
      element.classList.remove('ai-correct-answer');
      element.style.removeProperty('background-color');
      element.style.removeProperty('border');
      element.style.removeProperty('box-shadow');
      element.style.removeProperty('color');

      // Reset text color for all text elements inside
      const textElements = element.querySelectorAll('*');
      textElements.forEach(el => {
        el.style.removeProperty('color');
      });
    });

    // Highlight all correct answers
    indices.forEach((correctOptionIndex) => {
      if (correctOptionIndex >= 0 && correctOptionIndex < optionElements.length) {
        const correctElement = optionElements[correctOptionIndex];
        correctElement.classList.add('ai-correct-answer');

        // Apply inline styles - green background with white text
        correctElement.style.backgroundColor = '#22c55e';
        correctElement.style.border = '3px solid #16a34a';
        correctElement.style.borderRadius = '8px';
        correctElement.style.boxShadow = '0 0 0 4px rgba(34, 197, 94, 0.2)';
        correctElement.style.color = 'white';

        // Make sure all text inside is white
        const textElements = correctElement.querySelectorAll('*');
        textElements.forEach(el => {
          el.style.color = 'white';
        });

        console.log(`✅ Highlighted option ${correctOptionIndex} as correct`);
      } else {
        console.log(`❌ Invalid option index: ${correctOptionIndex} (total options: ${optionElements.length})`);
      }
    });

    console.log('=== Highlight Complete ===\n');

  } catch (error) {
    console.error('❌ Error during highlighting:', error);
  }
}

// Function to create the helper buttons (GPT and Gemini)
function createHelperButton(targetDocument = document) {
  // Check if buttons already exist
  if (document.getElementById('netacad-ai-helper-btn-gpt')) {
    console.log('Buttons already exist in main document');
    return;
  }

  if (targetDocument !== document && targetDocument.getElementById('netacad-ai-helper-btn-gpt')) {
    console.log('Buttons already exist in iframe');
    return;
  }

  // Create GPT Button (Blue)
  const gptButton = targetDocument.createElement('button');
  gptButton.id = 'netacad-ai-helper-btn-gpt';
  gptButton.innerHTML = '🤖 Get Answer from GPT';
  gptButton.className = 'ai-helper-button ai-helper-button-gpt';

  // Create Gemini Button (Purple)
  const geminiButton = targetDocument.createElement('button');
  geminiButton.id = 'netacad-ai-helper-btn-gemini';
  geminiButton.innerHTML = '✨ Get Answer from Gemini';
  geminiButton.className = 'ai-helper-button ai-helper-button-gemini';

  // GPT button click handler
  gptButton.addEventListener('click', async () => {
    await handleButtonClick(gptButton, 'gpt', '🤖 Get Answer from GPT');
  });

  // Gemini button click handler
  geminiButton.addEventListener('click', async () => {
    await handleButtonClick(geminiButton, 'gemini', '✨ Get Answer from Gemini');
  });

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

  // Add buttons to the target document body
  targetDocument.body.appendChild(gptButton);
  targetDocument.body.appendChild(geminiButton);
  targetDocument.body.appendChild(webAiSelect);
  targetDocument.body.appendChild(webAiButton);
  console.log('AI helper buttons added to', targetDocument === document ? 'main page' : 'iframe');
}

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

// Shared button click handler
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
    // Send message to background script with model type and multiple-answer info
    const response = await chrome.runtime.sendMessage({
      action: 'getAnswer',
      question: questionData.question,
      options: questionData.options.map(opt => opt.text),
      modelType: modelType,
      isMultipleAnswer: questionData.isMultipleAnswer,
      requiredAnswers: questionData.requiredAnswers
    });

    console.log('AI Response received:', response);

    if (response.success) {
      // Handle both single answer (number) and multiple answers (array)
      const answerIndices = Array.isArray(response.answerIndex) ? response.answerIndex : [response.answerIndex];
      highlightCorrectAnswer(answerIndices);

      const answerText = questionData.isMultipleAnswer
        ? `✅ ${answerIndices.length} Answers Highlighted`
        : '✅ Answer Highlighted';

      button.innerHTML = answerText;
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

// Function to check if quiz exists and create buttons
function checkForQuiz() {
  console.log('Checking for quiz in current document...');
  console.log('Current URL:', window.location.href);

  // Check if app-root exists (indicates we're in the quiz iframe)
  const appRoot = document.querySelector('app-root');
  console.log('app-root element:', appRoot);

  const buttonsExist = document.getElementById('netacad-ai-helper-btn-gpt');
  console.log('Buttons exist:', buttonsExist);

  if (appRoot && !buttonsExist) {
    console.log('Quiz iframe detected, creating buttons');
    createHelperButton(document);
  } else if (!appRoot) {
    console.log('No app-root element found in this document');
  }
}

// Wait for page to load with multiple attempts
let checkAttempts = 0;
const maxAttempts = 20;

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

// Initialize when page is fully loaded
function initialize() {
  console.log('Initializing extension in quiz iframe...');

  // Start checking for quiz
  setTimeout(tryCheckForQuiz, 1000);

  // Also observe for dynamic content changes (for SPA navigation)
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

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
}

// Wait for complete page load (including iframes)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM Content Loaded');
    // Wait a bit more for iframe to be ready
    setTimeout(initialize, 500);
  });
} else if (document.readyState === 'interactive') {
  console.log('Document interactive');
  setTimeout(initialize, 500);
} else {
  console.log('Document already complete');
  initialize();
}

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
  const topicTitle = parts.length >= 2 ? parts[1].trim() : '';
  return topicTitle.startsWith(topicNumber) && !/\d/.test(topicTitle.charAt(topicNumber.length));
}

async function openTopic(topic) {
  const navigated = await robustClick(topic.button, () => iframeShowsTopic(topic.number));
  if (!navigated) {
    throw new Error(`Couldn't navigate to topic ${topic.number} (${topic.name}).`);
  }
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
  console.log('📖 Module walker finished:', finalText);
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

  const completed = await new Promise((resolve) => {
    let settled = false;
    let timeoutId;
    const finish = (didComplete) => {
      if (settled) return;
      settled = true;
      video.removeEventListener('ended', onEnded);
      clearTimeout(timeoutId);
      resolve(didComplete);
    };
    const onEnded = () => finish(true);
    video.addEventListener('ended', onEnded, { once: true });
    const timeoutMs = Math.max(5000, ((video.duration || 60) / video.playbackRate) * 1000 * 2);
    timeoutId = setTimeout(() => finish(false), timeoutMs);
    video.play().catch(() => finish(false));
  });

  return completed;
}

// Temporary stubs — replaced in later tasks.
const moduleWalkState = { running: false, stopRequested: false };
function stopModuleWalk() { moduleWalkState.stopRequested = true; }
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

    await robustClick(options[0], () => !/not selected/i.test(dropdownBtn.textContent || ''));
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
async function startModuleWalk() {
  console.log('startModuleWalk stub: topics =', getRemainingTopicsInCurrentModule());
}
