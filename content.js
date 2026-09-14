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

  // Add buttons to the target document body
  targetDocument.body.appendChild(gptButton);
  targetDocument.body.appendChild(geminiButton);
  console.log('AI helper buttons added to', targetDocument === document ? 'main page' : 'iframe');
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

  if (checkAttempts < maxAttempts && !document.getElementById('netacad-ai-helper-btn-gpt')) {
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
    if (!document.getElementById('netacad-ai-helper-btn-gpt')) {
      const appRoot = document.querySelector('app-root');
      if (appRoot) {
        console.log('app-root detected via mutation observer');
        checkForQuiz();
      }
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
