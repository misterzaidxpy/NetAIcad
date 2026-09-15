// Content script for Netacad Quiz Helper
console.log('Netacad Quiz Helper: Content script loaded in quiz iframe');
console.log('Current URL:', window.location.href);

// Function to search for elements in Shadow DOM
function findInShadowDOM(selector, root = document) {
  // Include root itself if it matches (needed when root is a custom element
  // whose entire content lives in its own shadow root, e.g. a
  // matching-dropdown-view row passed in directly by the module walker).
  let elements = [];
  if (root.matches && root.matches(selector)) elements.push(root);

  // Then find in the regular DOM under root
  elements = elements.concat(Array.from(root.querySelectorAll(selector)));

  // If root itself has a shadow root, search inside it too
  if (root.shadowRoot) elements = elements.concat(findInShadowDOM(selector, root.shadowRoot));

  // Then search in all shadow roots of root's descendants
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
//
// Derives the frame from the ELEMENT's own document/window rather than the
// calling script's `window`, since `window.frameElement` only reflects the
// frame of the currently-executing script instance. The module walker's top-
// frame script instance reaches into the content iframe's document directly
// (see checkForCourseContent), so `window.frameElement` there is always null
// even when `element` lives inside that iframe.
function getAbsolutePageRect(element) {
  const rect = element.getBoundingClientRect();
  const elementWindow = element.ownerDocument && element.ownerDocument.defaultView;
  const frame = elementWindow ? elementWindow.frameElement : null; // null if element's own document is the top document
  const frameRect = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 };
  return {
    x: frameRect.left + rect.left + rect.width / 2,
    y: frameRect.top + rect.top + rect.height / 2,
  };
}

// Polls `predicate` every `intervalMs` until it returns truthy or `timeoutMs`
// elapses. Returns true if the predicate became truthy, false on timeout.
// This is the ONE shared polling helper — used wherever a fixed timeout was
// previously load-bearing (SPA navigation settling, async completion-status
// tracking, iframe/heading readiness).
async function waitFor(predicate, timeoutMs, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

// Clicks `element`. Netacad's Angular-based custom widgets (confirmed on the
// quiz's radio buttons) ignore synthetic JS `.click()` events, so if `verify`
// doesn't report success after a plain click, this falls back to a
// chrome.debugger-dispatched trusted click via the background script.
async function robustClick(element, verify) {
  if (!element) return false;

  if (element.scrollIntoView) {
    element.scrollIntoView({ block: 'center' });
    // scrollIntoView here is instant (no `behavior`, and the target is
    // usually already on/near screen), so it only needs a single paint to
    // settle before clicking — not a fixed guess.
    await new Promise((r) => requestAnimationFrame(r));
  }

  element.click();

  // Give Angular's own event handling a moment to react, but don't wait
  // longer than necessary — poll `verify` instead of sleeping the full
  // budget every time, so a click that registers immediately (the common
  // case) doesn't sit idle.
  if (!verify || (await waitFor(verify, 500, 30))) {
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

  return !verify || (await waitFor(verify, 500, 30));
}

// Function to extract question and options (based on iframe.js)
function extractMcqQuestionData() {
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
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const promptEl = findInShadowDOM('.matching__item-title_inner', row)[0];
      const prompt = promptEl ? promptEl.textContent.trim() : `Row ${index + 1}`;

      const dropdownBtn = findInShadowDOM('.dropdown__btn.js-dropdown-btn', row)[0];
      if (!dropdownBtn) {
        console.log(`❌ Matching row ${index + 1} has no dropdown button`);
        return null;
      }

      // Read-only: open the popup to read its option list, then close it
      // again without selecting anything — extraction must not change state.
      dropdownBtn.click();
      let options;
      try {
        options = findInShadowDOM('.dropdown__item.js-dropdown-list-item', row.ownerDocument)
          .filter((opt) => opt.offsetParent !== null)
          .map((opt) => (opt.textContent || '').replace(/,\s*\d+\s*of\s*\d+.*$/i, '').trim());
      } finally {
        dropdownBtn.click();
      }

      if (options.length === 0) {
        console.log(`❌ Matching row ${index + 1} has no readable options`);
        return null;
      }

      rowsWithOptions.push({ index, prompt, options });
    }

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

// Both extractors are actually synchronous internally — kept as a plain
// function (not async) so it can be called from inside a waitFor()
// predicate, which checks its return value without awaiting it.
function extractQuestionDataSync() {
  const mcqData = extractMcqQuestionData();
  if (mcqData) return mcqData;
  return extractMatchingQuestionData();
}

async function extractQuestionData() {
  return extractQuestionDataSync();
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

// The graded quiz's "Submit" button lives in <assessment-toolbar-view>, a
// page-level toolbar that's a sibling of (not nested inside) the mcq/matching
// widget's own subtree — confirmed live, so it can't be scoped to the
// question widget the way the self-check-section Submit search is. Search
// the whole document instead, matching the exact button text so "Skip",
// "Skip All", and "Skip navigation" are never mistaken for it.
function findQuizSubmitButton() {
  return findInShadowDOM('button', document).find(
    (b) => /^submit$/i.test((b.textContent || '').trim())
  );
}

// Clicks the Submit button once it's enabled (Netacad only enables it once
// the required number of options are genuinely selected). If it never
// enables — e.g. the AI returned fewer answers than requiredAnswers, or the
// option clicks above didn't register — this deliberately does nothing,
// leaving the AI's highlighted suggestion for manual review/submission
// instead of forcing a submit that wouldn't have worked anyway.
async function clickSubmitIfEnabled() {
  const submitBtn = findQuizSubmitButton();
  if (!submitBtn) return false;
  const enabled = await waitFor(() => !submitBtn.disabled, 3000);
  if (!enabled) return false;
  return robustClick(submitBtn, () => submitBtn.disabled || !submitBtn.isConnected);
}

// Actually selects the AI-chosen option(s) with real, Angular-recognized
// clicks (not just visual highlighting) using the same .element references
// captured during extraction, then submits. Skips options that are already
// selected — clicking an already-checked checkbox would toggle it back off.
async function selectAndSubmitMcqAnswer(questionData, indices) {
  for (const idx of indices) {
    const option = questionData.options[idx];
    if (!option || !option.element) continue;
    const input = option.element.querySelector('input');
    if (input && input.checked) continue;
    await robustClick(option.element, () => !input || input.checked);
  }
  return clickSubmitIfEnabled();
}

// Same idea for matching questions: reopens each row's dropdown and clicks
// the AI-suggested option text for real, then submits.
async function selectAndSubmitMatchingAnswer(rowAnswers) {
  const widgets = findInShadowDOM('.matching__widget', document);
  const visibleWidgets = widgets.filter((w) => {
    const style = window.getComputedStyle(w);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  });
  const widget = visibleWidgets[visibleWidgets.length - 1] || widgets[widgets.length - 1];
  if (!widget) return false;

  const rows = findInShadowDOM('matching-dropdown-view', widget);
  for (const answer of rowAnswers) {
    const row = rows[answer.index];
    if (!row) continue;
    const dropdownBtn = findInShadowDOM('.dropdown__btn.js-dropdown-btn', row)[0];
    if (!dropdownBtn) continue;

    await robustClick(dropdownBtn, () => dropdownBtn.getAttribute('aria-expanded') === 'true');

    // Same as the module walker's matching handler: aria-expanded flips
    // before the option list actually renders, so wait for it dynamically.
    let options = [];
    await waitFor(() => {
      options = findInShadowDOM('.dropdown__item.js-dropdown-list-item', row.ownerDocument).filter(
        (opt) => opt.offsetParent !== null
      );
      return options.length > 0;
    }, 1000, 30);
    const target = options.find(
      (opt) => (opt.textContent || '').replace(/,\s*\d+\s*of\s*\d+.*$/i, '').trim() === answer.option
    );
    if (!target) continue;

    await robustClick(target, () => !/not selected/i.test(dropdownBtn.textContent || ''));
  }
  return clickSubmitIfEnabled();
}

// Function to create the helper buttons (GPT and Gemini)
// Compact SVG icons for the floating buttons — evoke each brand/purpose
// without relying on external logo assets (which would need Content
// Security Policy / web-accessible-resource wiring for a Manifest V3
// extension). Kept tiny and self-contained so they inline cleanly.
const ICON_GPT =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="white"><g>' +
  '<ellipse cx="12" cy="6.2" rx="2.4" ry="4.6"/>' +
  '<ellipse cx="12" cy="6.2" rx="2.4" ry="4.6" transform="rotate(60 12 12)"/>' +
  '<ellipse cx="12" cy="6.2" rx="2.4" ry="4.6" transform="rotate(120 12 12)"/>' +
  '<ellipse cx="12" cy="6.2" rx="2.4" ry="4.6" transform="rotate(180 12 12)"/>' +
  '<ellipse cx="12" cy="6.2" rx="2.4" ry="4.6" transform="rotate(240 12 12)"/>' +
  '<ellipse cx="12" cy="6.2" rx="2.4" ry="4.6" transform="rotate(300 12 12)"/>' +
  '</g></svg>';
const ICON_GEMINI =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="white">' +
  '<path d="M12 2 L14.6 9.4 L22 12 L14.6 14.6 L12 22 L9.4 14.6 L2 12 L9.4 9.4 Z"/>' +
  '</svg>';
const ICON_WEBAI =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="white" stroke-width="1.6">' +
  '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><line x1="3" y1="12" x2="21" y2="12"/>' +
  '</svg>';
const ICON_WALKER =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 6.5 C10 5 6.5 4.5 3 5 V18 C6.5 17.5 10 18 12 19.5 C14 18 17.5 17.5 21 18 V5 C17.5 4.5 14 5 12 6.5 Z"/>' +
  '<line x1="12" y1="6.5" x2="12" y2="19.5"/>' +
  '</svg>';
const ICON_STOP =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="white"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const ICON_LOADING = '⏳';
const ICON_SUCCESS = '✅';

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

  // Create GPT Button (Blue) — compact icon button, tooltip carries the label
  const gptButton = targetDocument.createElement('button');
  gptButton.id = 'netacad-ai-helper-btn-gpt';
  gptButton.innerHTML = ICON_GPT;
  gptButton.title = 'Get Answer from GPT';
  gptButton.className = 'ai-helper-button ai-helper-button-gpt';

  // Create Gemini Button (Purple)
  const geminiButton = targetDocument.createElement('button');
  geminiButton.id = 'netacad-ai-helper-btn-gemini';
  geminiButton.innerHTML = ICON_GEMINI;
  geminiButton.title = 'Get Answer from Gemini';
  geminiButton.className = 'ai-helper-button ai-helper-button-gemini';

  // GPT button click handler
  gptButton.addEventListener('click', async () => {
    await handleButtonClick(gptButton, 'gpt', ICON_GPT);
  });

  // Gemini button click handler
  geminiButton.addEventListener('click', async () => {
    await handleButtonClick(geminiButton, 'gemini', ICON_GEMINI);
  });

  // Create Web AI Button (Green) — ChatGPT only. Gemini's web UI proved
  // unreliable for this automation (its rich-text input kept losing part of
  // the typed prompt even after the tab-focus fix), so there's no provider
  // picker anymore: this always drives chatgpt.com.
  const webAiButton = targetDocument.createElement('button');
  webAiButton.id = 'netacad-ai-helper-btn-webai';
  webAiButton.innerHTML = ICON_WEBAI;
  webAiButton.title = 'Solve via Web AI — ChatGPT (no API key)';
  webAiButton.className = 'ai-helper-button ai-helper-button-webai';

  // Web AI solves the whole quiz in one click: extracts, answers, selects,
  // and submits every remaining question in a loop (see
  // autoSolveQuizViaWebAi) instead of requiring a click per question.
  // Clicking again while it's running stops it, mirroring the module
  // walker's start/stop toggle.
  webAiButton.addEventListener('click', async () => {
    if (quizAutoSolveState.running) {
      stopQuizAutoSolve();
      return;
    }
    await autoSolveQuizViaWebAi(webAiButton, 'chatgpt-web', ICON_WEBAI);
  });

  // Add buttons to the target document body
  targetDocument.body.appendChild(gptButton);
  targetDocument.body.appendChild(geminiButton);
  targetDocument.body.appendChild(webAiButton);
  console.log('AI helper buttons added to', targetDocument === document ? 'main page' : 'iframe');
}

// Detects a Netacad course-content page (as opposed to a quiz page) and
// injects the Auto-Complete Module button. Only runs in the top frame: its
// orchestration (startModuleWalk et al.) needs both the outline sidebar
// (top document) and the content iframe at once, so control stays here
// rather than in its own content-script instance inside that iframe.
//
// The button itself, however, is appended into the *iframe's* document, not
// the top document — confirmed live: the GPT/Gemini/Web AI quiz buttons are
// necessarily created from inside the iframe's own content-script instance
// (see checkForQuiz), so they live in a different `position: fixed`
// coordinate space (the iframe's viewport) than anything attached to the
// top document. The iframe's on-page offset from the browser viewport isn't
// 0, so two buttons with the same CSS `top` value in different coordinate
// spaces land at different screen positions and can visually collide.
// Attaching this button to the iframe's document instead puts all four
// buttons in one coordinate space, so their fixed `top` offsets are
// directly comparable again.
function checkForCourseContent() {
  if (window.top !== window.self) {
    return;
  }

  const iframe = getContentIframe();
  if (!iframe) {
    return;
  }

  // Netacad keeps every topic's DOM mounted (just toggling visibility), so
  // .js-heading elements from other, currently-hidden topics are still
  // findable even while a graded quiz is on screen. The "N of M Questions"
  // badge only renders during actual quiz-taking, so use it to suppress the
  // walker button then — and remove it if a quiz starts after the walker
  // button was already added.
  const existingWalkerBtn = iframe.contentDocument.getElementById('netacad-ai-walker-btn');
  if (getQuizProgress()) {
    if (existingWalkerBtn) existingWalkerBtn.remove();
    return;
  }
  if (existingWalkerBtn) {
    return;
  }

  const headings = findInShadowDOM('.js-heading', iframe.contentDocument);
  if (headings.length === 0) {
    return;
  }

  console.log(`✅ Course content detected (${headings.length} .js-heading sections), adding walker button`);
  createModuleWalkerButton(iframe.contentDocument);
}

function createModuleWalkerButton(targetDocument) {
  const button = targetDocument.createElement('button');
  button.id = 'netacad-ai-walker-btn';
  button.innerHTML = ICON_WALKER;
  button.title = 'Auto-Complete Module';
  button.className = 'ai-helper-button ai-helper-button-walker';

  button.addEventListener('click', () => {
    if (moduleWalkState.running) {
      stopModuleWalk();
    } else {
      startModuleWalk();
    }
  });

  targetDocument.body.appendChild(button);
  console.log('Module walker button added to', targetDocument === document ? 'main page' : 'content iframe');
}

// Sends the extracted question to the background script for an answer, then
// really selects the option(s)/matching choices and submits (not just
// highlights). Shared by the single-question buttons and the full-quiz Web
// AI auto-solve loop so both apply an answer identically.
async function fetchAndApplyAnswer(questionData, modelType) {
  const message = questionData.isMatching
    ? { action: 'getAnswer', isMatching: true, rows: questionData.rows, modelType: modelType }
    : {
        action: 'getAnswer',
        question: questionData.question,
        options: questionData.options.map((opt) => opt.text),
        modelType: modelType,
        isMultipleAnswer: questionData.isMultipleAnswer,
        requiredAnswers: questionData.requiredAnswers,
      };

  const response = await chrome.runtime.sendMessage(message);
  console.log('AI Response received:', response);

  if (!response.success) {
    return { success: false, error: response.error };
  }

  let submitted;
  let answerCount;
  if (questionData.isMatching) {
    highlightMatchingAnswer(response.rowAnswers);
    submitted = await selectAndSubmitMatchingAnswer(response.rowAnswers);
    answerCount = response.rowAnswers.length;
  } else {
    const answerIndices = Array.isArray(response.answerIndex) ? response.answerIndex : [response.answerIndex];
    highlightCorrectAnswer(answerIndices);
    submitted = await selectAndSubmitMcqAnswer(questionData, answerIndices);
    answerCount = answerIndices.length;
  }

  return { success: true, submitted, answerCount };
}

const quizAutoSolveState = { running: false, stopRequested: false };

function stopQuizAutoSolve() {
  quizAutoSolveState.stopRequested = true;
}

// A stable-ish signature for "is this the same question as before" — used to
// detect that Submit actually advanced the quiz to a new question, since
// Netacad keeps every question's DOM mounted and only toggles visibility
// rather than replacing elements (so node identity can't be used).
function questionSignature(questionData) {
  return questionData.isMatching
    ? JSON.stringify(questionData.rows.map((r) => r.prompt))
    : questionData.question;
}

// Solves every remaining question in the current quiz via Web AI, one after
// another, with no per-question button click required: extract → answer →
// select real option(s) → submit → wait for the next question to render →
// repeat. Stops (leaving the last answer highlighted, unsubmitted, for
// manual review) the moment anything doesn't go as expected — a wrong AI
// answer submitted automatically can't be undone, so failing safe here
// matters more than powering through.
async function autoSolveQuizViaWebAi(button, modelType, originalIcon) {
  quizAutoSolveState.running = true;
  quizAutoSolveState.stopRequested = false;
  button.innerHTML = ICON_STOP;
  button.title = 'Stop Web AI Auto-Solve';

  const overlayOpts = {
    overlayId: 'netacad-ai-quizsolve-overlay',
    initialText: 'Web AI Auto-Solve — starting…',
    onStop: stopQuizAutoSolve,
  };
  createOverlay(document, overlayOpts);
  const finish = (text, delayMs) => removeOverlayAfterDelay(text, delayMs, overlayOpts.overlayId);

  let solvedCount = 0;
  try {
    if (!chrome.runtime || !chrome.runtime.id) {
      throw new Error(
        'Extension was reloaded — this page still has the old version. Refresh this tab and try again.'
      );
    }

    while (!quizAutoSolveState.stopRequested) {
      const questionData = extractQuestionDataSync();
      if (!questionData) {
        finish(
          solvedCount > 0
            ? `Done — solved ${solvedCount} question(s). No further question found.`
            : 'Could not find a quiz question on this page.',
          4000
        );
        break;
      }

      // Netacad's own "N of M Questions" badge is a far more reliable
      // progress/advancement signal than anything inferred from extracted
      // question content — prefer it, and only fall back to comparing
      // question text if the badge isn't present for some reason.
      const progress = getQuizProgress();
      const progressLabel = progress ? `question ${progress.current} of ${progress.total}` : `question ${solvedCount + 1}`;
      updateOverlay(`Solving ${progressLabel}…`, overlayOpts.overlayId);
      const prevSignature = questionSignature(questionData);

      const result = await fetchAndApplyAnswer(questionData, modelType);
      if (!result.success) {
        finish(`Stopped after ${solvedCount} question(s): ${result.error}`, 6000);
        break;
      }
      if (!result.submitted) {
        finish(
          `Solved ${solvedCount} question(s), but couldn't submit this one — it's highlighted for manual review.`,
          6000
        );
        break;
      }

      solvedCount++;
      if (quizAutoSolveState.stopRequested) {
        finish(`Stopped by user after ${solvedCount} question(s).`, 4000);
        break;
      }

      updateOverlay(`Solved ${solvedCount}${progress ? ` of ${progress.total}` : ''} — waiting for next question…`, overlayOpts.overlayId);
      const advanced = await waitFor(() => {
        const nextProgress = getQuizProgress();
        if (progress && nextProgress) {
          return nextProgress.current !== progress.current;
        }
        const nextData = extractQuestionDataSync();
        return !nextData || questionSignature(nextData) !== prevSignature;
      }, 8000);

      if (!advanced) {
        finish(`Solved ${solvedCount} question(s) — stopped (next question didn't load).`, 6000);
        break;
      }

      await new Promise((r) => setTimeout(r, 600));
    }
  } catch (error) {
    console.error('❌ Web AI auto-solve error:', error);
    finish(`Stopped after ${solvedCount} question(s): ${error.message}`, 6000);
  } finally {
    quizAutoSolveState.running = false;
    button.disabled = false;
    button.innerHTML = originalIcon;
    button.title = 'Solve via Web AI — ChatGPT (no API key)';
  }
}

// Shared button click handler. originalIcon is the SVG markup to restore
// once the loading/success indicator (a plain emoji swap) has run its course.
async function handleButtonClick(button, modelType, originalIcon) {
  const originalTitle = button.title;
  button.disabled = true;
  button.innerHTML = ICON_LOADING;

  const questionData = await extractQuestionData();

  if (!questionData) {
    alert('Could not extract question data. Make sure you are on a quiz page.');
    button.disabled = false;
    button.innerHTML = originalIcon;
    return;
  }

  try {
    // After the extension is reloaded (e.g. from chrome://extensions during
    // development), content scripts already injected into open tabs are
    // orphaned — chrome.runtime goes undefined in that stale context. Detect
    // it explicitly instead of letting a cryptic
    // "Cannot read properties of undefined (reading 'sendMessage')" surface.
    if (!chrome.runtime || !chrome.runtime.id) {
      throw new Error(
        'Extension was reloaded — this page still has the old version. Refresh this tab and try again.'
      );
    }

    const result = await fetchAndApplyAnswer(questionData, modelType);

    if (result.success) {
      button.title = result.submitted
        ? questionData.isMatching
          ? 'Matches selected & submitted ✓'
          : 'Answer selected & submitted ✓'
        : questionData.isMatching
        ? 'Matches highlighted ✓'
        : questionData.isMultipleAnswer
        ? `${result.answerCount} answers highlighted ✓`
        : 'Answer highlighted ✓';
      button.innerHTML = ICON_SUCCESS;
      setTimeout(() => {
        button.innerHTML = originalIcon;
        button.title = originalTitle;
        button.disabled = false;
      }, 2000);
    } else {
      console.error('AI Error Details:', result.error);
      alert('AI Error: ' + result.error);
      button.disabled = false;
      button.innerHTML = originalIcon;
    }
  } catch (error) {
    console.error('Error getting AI answer:', error);
    const isStaleContext = /Extension was reloaded|Extension context invalidated/i.test(error.message || '');
    alert(
      isStaleContext
        ? error.message
        : 'Error communicating with AI. Please check your API key in the extension popup.'
    );
    button.disabled = false;
    button.innerHTML = originalIcon;
  }
}

// Function to check if quiz exists and create buttons
function checkForQuiz() {
  // Check if app-root exists (indicates we're in the quiz iframe)
  const appRoot = document.querySelector('app-root');
  if (!appRoot) return;

  // Only show the GPT/Gemini/Web AI buttons while an actual graded quiz is
  // being taken — reuse the same "N of M Questions" badge signal as the
  // walker button's suppression, since it's the one reliable "is a quiz
  // (as opposed to a reading page) currently on screen" marker. A
  // visibility check on mcq-view elements doesn't work for this: Netacad's
  // reading pages keep every embedded self-check's mcq-view mounted with
  // normal (non-hidden) CSS the whole time (confirmed live — several
  // self-checks all report "visible" simultaneously on one reading page),
  // so it can't distinguish "on a quiz" from "on a reading page with
  // self-checks further down." Self-checks don't need these buttons anyway
  // — the module walker answers them directly (see handleSelfCheckSection),
  // not through Web AI/GPT/Gemini. Skip touching button existence while Web
  // AI auto-solve is actively running: the quiz briefly has no progress
  // badge while transitioning between questions, and removing/recreating
  // the buttons mid-run would orphan the button reference the loop is
  // updating (icon/title state).
  if (quizAutoSolveState.running) return;

  const buttonsExist = document.getElementById('netacad-ai-helper-btn-gpt');
  const quizActive = !!getQuizProgress();

  if (quizActive && !buttonsExist) {
    console.log('✅ Graded quiz detected, adding GPT/Gemini/Web AI buttons');
    createHelperButton(document);
  } else if (!quizActive && buttonsExist) {
    console.log('No graded quiz active anymore, removing GPT/Gemini/Web AI buttons');
    removeHelperButtons(document);
  }
}

function removeHelperButtons(targetDocument) {
  ['netacad-ai-helper-btn-gpt', 'netacad-ai-helper-btn-gemini', 'netacad-ai-helper-btn-webai'].forEach((id) => {
    const el = targetDocument.getElementById(id);
    if (el) el.remove();
  });
}

// Wait for page to load with multiple attempts
let checkAttempts = 0;
const maxAttempts = 20;

function tryCheckForQuiz() {
  checkAttempts++;

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

  // Also observe for dynamic content changes (for SPA navigation). Both
  // checkForQuiz and checkForCourseContent are idempotent and self-managing
  // (they add their button when it should show, remove it when it
  // shouldn't), so there's no "only check until found once" gate here —
  // both buttons have to be added AND removed repeatedly as the user
  // navigates between reading pages, quizzes, and embedded self-checks
  // within the same session.
  const observer = new MutationObserver(() => {
    checkForQuiz();
    checkForCourseContent();
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

// Returns the course-content iframe (validated only by having a loaded
// contentDocument), or null if it's not present/loaded yet. Centralizes what
// was previously four separate, unvalidated document.querySelector('iframe')
// calls (checkForCourseContent, locateCurrentOutlineGroupIndex, iframeShowsTopic, and
// walkTopicSections) so that if the page ever has more than one iframe, all
// call sites resolve to the same one consistently.
// Kept cheap intentionally — doesn't require .js-heading to already be
// present, since some callers need the iframe before headings render.
function getContentIframe() {
  const iframe = document.querySelector('iframe');
  if (!iframe || !iframe.contentDocument) return null;
  return iframe;
}

// Reads Netacad's own "N of M Questions" badge (confirmed live, e.g. "1 of
// 20 Questions") — a much more reliable "which question / how many total /
// did we advance" signal than inferring it from extracted question content,
// and it also doubles as "is a graded quiz currently being taken" (this
// badge only renders during quiz-taking, not on reading pages or embedded
// self-checks). shadowAwareText is needed because the badge's digits and
// "of"/"Questions" text are often split across separate shadow-DOM-nested
// spans that plain textContent can't see across.
//
// This content script instance runs both in the top page (where the quiz
// content lives inside a nested iframe found via getContentIframe) and, via
// all_frames, as its own separate instance inside that content iframe
// itself (where the quiz badge is right there in the local `document`, and
// getContentIframe finds no further nested iframe to descend into). Handle
// both: prefer the nested iframe's document when one exists, otherwise fall
// back to the local document.
function getQuizProgress() {
  const iframe = getContentIframe();
  const targetDoc = iframe ? iframe.contentDocument : document;
  const text = shadowAwareText(targetDoc.body);
  const match = text.match(/(\d+)\s*of\s*(\d+)\s*Questions?/i);
  if (!match) return null;
  return { current: parseInt(match[1], 10), total: parseInt(match[2], 10) };
}

// Outline sidebar buttons use CSS-Modules-hashed classes overall (see Global
// Constraints), but the un-hashed class *prefix* reliably tells a group
// header apart from a topic regardless of naming convention or completion
// badge — confirmed live across every group shape this course has: numbered
// "Module N" groups, and single-topic named groups ("Final Project", "End
// of Course Survey", "Course Final Exam", a certification exam) that don't
// even always show a badge. Group headers render as
// "nodeInfoContainer--<hash> btnLink--<hash>[ showProgress--<hash>]"; their
// topic(s) render as "subModuleBtn--<hash> btnLink--<hash>". Matching only
// the stable prefix survives the hash changing across deployments.
function isOutlineGroupHeaderButton(button) {
  return /\bnodeInfoContainer/.test(button.className || '');
}
function isOutlineTopicButton(button) {
  return /\bsubModuleBtn/.test(button.className || '');
}

// Locked topics still show their outline "N Prerequisite(s)" chip,
// concatenated onto the button's textContent with no separating space —
// walking into one does nothing but waste a navigation attempt, so they're
// treated like Lab/Practice topics: skipped and surfaced for manual review
// instead of opened.
function isOutlineTopicLocked(text) {
  return /\d+\s*Prerequisites?\s*$/i.test((text || '').trim());
}

// The iframe's document.title reliably contains the current topic's title
// as "... | 5.1. Exploiting Network-Based Vulnerabilities" (numbered) or
// "... | Final Project" (plain-named — and confirmed live, a group like
// "Final Project" renders both its own group-header button AND a topic
// button with the identical name right after it, so matching must target
// the *topic* button specifically or it'll resolve to the group itself).
// Finds that topic's enclosing group header's index in allButtons: for
// numbered topics, matches the "Module N" heading directly; for
// plain-named topics, finds the topic-level button by text match and walks
// backward to the nearest preceding group header.
function locateCurrentOutlineGroupIndex(allButtons) {
  const iframe = getContentIframe();
  if (!iframe || !iframe.contentDocument.title) return -1;
  const parts = iframe.contentDocument.title.split('|');
  if (parts.length < 2) return -1;
  const topicTitle = parts[1].trim();
  if (!topicTitle) return -1;

  const numberedMatch = topicTitle.match(/^(\d+)\./);
  if (numberedMatch) {
    // Match "Module N" anywhere in the string, not followed by another digit
    // (so "Module 1" doesn't match inside "Module 10"), followed by "." or ":".
    const moduleHeadingRegex = new RegExp(`Module\\s+${numberedMatch[1]}(?!\\d)\\s*[.:]`, 'i');
    return allButtons.findIndex(
      (b) => isOutlineGroupHeaderButton(b) && moduleHeadingRegex.test((b.textContent || '').trim())
    );
  }

  const topicButtonIndex = allButtons.findIndex((b) => {
    if (!isOutlineTopicButton(b)) return false;
    const text = (b.textContent || '').trim();
    return text.length > 0 && (text === topicTitle || text.startsWith(topicTitle));
  });
  if (topicButtonIndex === -1) return -1;
  for (let i = topicButtonIndex - 1; i >= 0; i--) {
    if (isOutlineGroupHeaderButton(allButtons[i])) {
      return i;
    }
  }
  return -1;
}

// Group and topic buttons are flat siblings in outline order: a group
// header button, followed by that group's topic buttons, followed by the
// next group header. Confirmed live: each topic button's status
// ("start"/"in progress"/"completed") is NOT part of its textContent — it
// only shows up in the accessible name via a child <img alt="...">, e.g.
// <div class="subModuleStatus--..."><img alt="start" src="..."></div>. Read
// that alt attribute directly rather than parsing it out of textContent.
function getCurrentOutlineGroupTopics() {
  const allButtons = Array.from(document.querySelectorAll('button'));
  const groupIndex = locateCurrentOutlineGroupIndex(allButtons);
  if (groupIndex === -1) {
    throw new Error("Couldn't find the module outline (couldn't determine the current module/section).");
  }

  // The currently-active "Module N" group auto-expands (confirmed live:
  // aria-expanded="true" plus an "active" class), but single-topic named
  // groups ("Final Project", "Course Final Exam", a certification exam)
  // don't get that treatment until a topic inside them has actually been
  // visited before — until then their topic buttons exist in the DOM (so
  // extraction below still finds them) but sit at `visibility: hidden`
  // under the collapsed accordion, silently swallowing any click. Expand
  // the group's own header first so its topics are real, clickable
  // elements by the time openTopic() gets to them.
  const groupHeaderButton = allButtons[groupIndex];
  if (groupHeaderButton.getAttribute('aria-expanded') === 'false') {
    groupHeaderButton.click();
  }

  const topics = [];
  for (let i = groupIndex + 1; i < allButtons.length; i++) {
    if (isOutlineGroupHeaderButton(allButtons[i])) break; // reached the next group
    if (!isOutlineTopicButton(allButtons[i])) continue; // unrelated button in between

    const rawText = (allButtons[i].textContent || '').trim();
    if (!rawText) continue;

    const statusImg = allButtons[i].querySelector('img[alt]');
    const status = statusImg ? statusImg.alt.trim().toLowerCase() : '';
    const locked = isOutlineTopicLocked(rawText);

    const numberedMatch = rawText.match(/^(\d+\.\d+)\.\s*(.+?)\s*(?:\d+\s*\/\s*\d+)?$/i);
    if (numberedMatch) {
      topics.push({
        button: allButtons[i],
        number: numberedMatch[1],
        name: numberedMatch[2].trim(),
        isCompleted: status === 'completed',
        isLocked: locked,
      });
      continue;
    }

    // Plain-named topic (no "N.N." prefix) — e.g. "Final Project", "Final
    // Test", "End of Course Survey", a certification exam. Strip whichever
    // status suffix got concatenated onto the button's textContent with no
    // separating space: either the "N Prerequisite(s)" chip on a locked
    // topic, or an "N / M" sub-item count (confirmed live, e.g. a "PCEP ...
    // Certification Exam" topic showing "0 / 5"), mirroring the same
    // optional fraction the numbered-topic regex above already strips. No
    // numeric id exists for these, so the (cleaned) name doubles as its own
    // match key for iframeShowsTopic below.
    const name = rawText
      .replace(/\d+\s*Prerequisites?\s*$/i, '')
      .replace(/\d+\s*\/\s*\d+\s*$/, '')
      .trim();
    if (!name) continue;
    topics.push({
      button: allButtons[i],
      number: name,
      name,
      isCompleted: status === 'completed',
      isLocked: locked,
    });
  }
  return topics;
}

function getRemainingTopicsInCurrentModule() {
  const allTopics = getCurrentOutlineGroupTopics();
  if (allTopics.length === 0) {
    throw new Error("Couldn't find the module outline (no topics found in the current module/section).");
  }
  // Lab/Practice topics are recognizable by their OUTLINE (topic) name and
  // open external tools the walker doesn't support — never open them.
  // Locked topics (still showing their "N Prerequisite(s)" chip) can't be
  // opened yet either. Both are surfaced separately for the caller's
  // manual-review summary instead of dropped silently (see
  // getLabPracticeTopicNamesInCurrentModule).
  return allTopics.filter(
    (t) => !t.isCompleted && !t.isLocked && !/^(lab|practice)\s*-/i.test(t.name)
  );
}

// Names of incomplete Lab/Practice and locked topics in the current module —
// excluded from the walker's own topic list (see getRemainingTopicsInCurrentModule
// above) but still surfaced by name so the caller can add them to the run's
// final "needs manual review" summary instead of silently dropping them.
function getLabPracticeTopicNamesInCurrentModule() {
  let allTopics;
  try {
    allTopics = getCurrentOutlineGroupTopics();
  } catch {
    return [];
  }
  return allTopics
    .filter((t) => !t.isCompleted && (t.isLocked || /^(lab|practice)\s*-/i.test(t.name)))
    .map((t) => (t.isLocked ? `${t.name} (locked)` : t.name));
}

function iframeShowsTopic(topicMatchKey) {
  const iframe = getContentIframe();
  if (!iframe || !iframe.contentDocument.title) return false;
  const parts = iframe.contentDocument.title.split('|');
  const topicTitle = parts.length >= 2 ? parts[1].trim() : '';
  if (!topicTitle) return false;
  if (/^\d+\.\d+$/.test(topicMatchKey)) {
    return topicTitle.startsWith(topicMatchKey) && !/\d/.test(topicTitle.charAt(topicMatchKey.length));
  }
  // Plain-named topic (e.g. "Final Project") — no numeric id to bounds-check,
  // compare the whole topic title text instead.
  return topicTitle === topicMatchKey || topicTitle.startsWith(topicMatchKey);
}

async function openTopic(topic) {
  // getCurrentOutlineGroupTopics already fires the group-expand click when
  // needed, but that's a synchronous DOM click against a React-controlled
  // accordion — give its visibility update a moment to actually land before
  // trying to click the (until now hidden) topic button itself. Resolves
  // immediately when the topic was already visible (the common case).
  await waitFor(() => {
    const style = window.getComputedStyle(topic.button);
    return style.visibility !== 'hidden' && topic.button.getBoundingClientRect().height > 0;
  }, 2000, 30);

  const navigated = await robustClick(topic.button, () => iframeShowsTopic(topic.number));
  if (!navigated) {
    throw new Error(`Couldn't navigate to topic "${topic.name}".`);
  }
  // robustClick's own internal verify already gives some tolerance, but a
  // slow SPA navigation can still take longer than that to actually swap
  // the iframe content — poll for the same condition with a longer budget
  // instead of assuming it's already settled. No fixed "settle" delay after
  // this: walkTopicSections does its own dynamic wait for .js-heading to
  // actually render before doing anything else.
  await waitFor(() => iframeShowsTopic(topic.number), 8000);
}

// --- Module Walker: progress overlay ---

// Generalized so both the module walker and the Web AI quiz auto-solver can
// each show their own floating status/Stop overlay (distinct IDs so the two
// features never clash if somehow both were active).
function createOverlay(targetDocument, options = {}) {
  const {
    overlayId = 'netacad-ai-walker-overlay',
    initialText = 'Auto-Complete Module — starting…',
    onStop = stopModuleWalk,
  } = options;

  let overlay = targetDocument.getElementById(overlayId);
  if (overlay) return overlay;

  overlay = targetDocument.createElement('div');
  overlay.id = overlayId;
  overlay.className = 'ai-walker-overlay';
  overlay.innerHTML =
    `<span class="ai-walker-overlay-status">${initialText}</span>` +
    '<button class="ai-walker-overlay-stop">Stop</button>';
  overlay.querySelector('.ai-walker-overlay-stop').addEventListener('click', onStop);
  targetDocument.body.appendChild(overlay);
  return overlay;
}

function updateOverlay(text, overlayId = 'netacad-ai-walker-overlay') {
  const status = document.querySelector(`#${overlayId} .ai-walker-overlay-status`);
  if (status) status.textContent = text;
}

function removeOverlayAfterDelay(finalText, delayMs = 4000, overlayId = 'netacad-ai-walker-overlay') {
  updateOverlay(finalText, overlayId);
  console.log('📖 Overlay finished:', finalText);
  setTimeout(() => {
    const overlay = document.getElementById(overlayId);
    if (overlay) overlay.remove();
  }, delayMs);
}

// --- Module Walker: section classification + handlers ---

function findInShadowDOMMulti(selector, elements) {
  return elements.reduce((acc, el) => acc.concat(findInShadowDOM(selector, el)), []);
}

// A "section" is a .js-heading element plus every sibling after it up to
// (not including) the next .js-heading sibling.
// True if `el` is (or, via its own shadow DOM, contains) a `.js-heading` —
// used to recognize "the next heading" as a section boundary even when it's
// wrapped in a custom element like <heading-view> rather than exposing the
// class directly on itself.
function elementIsOrContainsHeading(el) {
  if (el.classList && el.classList.contains('js-heading')) return true;
  if (el.shadowRoot) return findInShadowDOM('.js-heading', el.shadowRoot).length > 0;
  return false;
}

// textContent does NOT pierce into descendant elements' own shadow roots —
// and Netacad's real content is often several shadow-DOM levels deep inside
// nested custom elements (e.g. <block-view>, <check-view>). Walk the full
// composed tree (including shadow roots) to get a text signal that actually
// reflects what's rendered, not just an empty light-DOM shell.
function shadowAwareText(el) {
  let text = '';
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
      return;
    }
    if (node.shadowRoot) walk(node.shadowRoot);
    if (node.childNodes) node.childNodes.forEach(walk);
  }
  walk(el);
  return text;
}

function normalizeHeadingText(raw) {
  return (raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(Incomplete|Completed)\s*/i, '')
    .trim();
}

function getSectionContainerForHeading(heading) {
  // Netacad uses multiple different markup styles for course content across
  // courses, confirmed live on two different templates:
  //   1. Flat: the heading and its content are direct siblings under one
  //      shared container (heading.parentNode already has many children).
  //   2. Deeply componentized: the heading lives alone inside a tiny
  //      per-item ShadowRoot (e.g. a <heading-view> custom element).
  //      Climbing to that shadow host's parent lands on a decoy: a 2-item
  //      [<heading-view>, title-echo-div] wrapper that's just the visible
  //      title chrome (an a11y label + a decorative "<hr>Title<hr>" render),
  //      NOT real content — confirmed by dumping its innerHTML live. The
  //      REAL per-item content (e.g. a <base-view>'s block__container
  //      sibling) is several more single-child levels and one more shadow
  //      crossing further up.
  // To tell a real content sibling apart from a title-echo one without
  // hardcoding Netacad's specific wrapper class names, compare text: an
  // echo's shadow-aware text is empty or just repeats the heading's own
  // title; real content's is longer/different. Keep climbing through
  // shadow boundaries and single/echo-only-child levels until a level has a
  // sibling with genuinely different content.
  const headingText = normalizeHeadingText(heading.textContent);
  function isHeadingEcho(el) {
    const text = normalizeHeadingText(shadowAwareText(el));
    if (!text) return true; // not yet rendered, or genuinely empty — skip past
    return text.includes(headingText) && text.length < headingText.length + 20;
  }

  let anchor = heading;
  let parent = anchor.parentNode;
  for (let depth = 0; depth < 15 && parent; depth++) {
    if (parent.host) {
      // Still inside a component's own internal shadow DOM — always cross,
      // regardless of child count; those are internal template details.
      anchor = parent.host;
      parent = anchor.parentNode;
      continue;
    }
    if (parent.children && parent.children.length > 1) {
      const hasRealContent = Array.from(parent.children).some(
        (c) => c !== anchor && !isHeadingEcho(c)
      );
      if (hasRealContent) break;
    }
    anchor = parent;
    parent = anchor.parentNode;
  }
  if (!parent || !parent.children) return [heading];

  const siblings = Array.from(parent.children);
  const startIndex = siblings.indexOf(anchor);
  if (startIndex === -1) return [heading];
  let endIndex = siblings.length;
  for (let i = startIndex + 1; i < siblings.length; i++) {
    if (elementIsOrContainsHeading(siblings[i])) {
      endIndex = i;
      break;
    }
  }
  return siblings.slice(startIndex, endIndex);
}

function isGradedQuizSection(sectionName, sectionElements) {
  const hasMcq = findInShadowDOMMulti('mcq-view', sectionElements).length > 0;
  const hasQuizNav = findInShadowDOMMulti('button', sectionElements).some((b) =>
    /skip question|skip all question/i.test((b.textContent || '').trim())
  );
  // Err heavily toward detecting a quiz: requiring the "Skip question" nav
  // control (which may render outside this section's narrow sibling range,
  // or not at all in some layouts) is not sufficient on its own — also treat
  // any section whose heading name looks graded (quiz/exam/checkpoint/
  // assessment) plus an mcq-view as graded. Never touching a graded quiz is
  // the single hard non-goal of the module walker.
  const nameLooksGraded = /\b(quiz|exam|checkpoint|assessment|test)\b/i.test(sectionName || '');
  return hasMcq && (hasQuizNav || nameLooksGraded);
}

function classifySection(sectionName, sectionElements) {
  if (/^(lab|practice)\s*-/i.test(sectionName)) {
    return 'unknown'; // Labs/Practices open external tools — out of scope.
  }
  // <check-view> is an interactive code-writing/checking exercise (confirmed
  // live: a "SECTION QUIZ" heading whose content was actually a Python code
  // editor with "Check" buttons, not an MCQ) — solving it means writing
  // real code, well outside what this walker can do. Recognize it
  // explicitly so it's skipped immediately instead of wasting a full
  // reading-pause + completion-wait cycle before falling back to "unknown".
  if (findInShadowDOMMulti('check-view', sectionElements).length > 0) {
    return 'unknown';
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
    if (text.length === 0 || /^(submit|show feedback)$/i.test(text)) return false;
    // Require a positive disclosure signal (expand/collapse ARIA state)
    // instead of treating any non-Submit button as a reveal widget — a PDF
    // download link, external-resource button, or transcript toggle should
    // NOT get escalated to a real trusted click.
    return b.hasAttribute('aria-expanded') || b.hasAttribute('aria-controls');
  });
  if (revealButtons.length > 0) {
    return 'clickToReveal';
  }
  return 'reading';
}

async function handleReadingSection(sectionElements) {
  const target = sectionElements[sectionElements.length - 1] || sectionElements[0];
  await smoothScrollIntoView(target);
  return true;
}

// A real animated scroll (not an instant jump) — confirmed live: Netacad's
// own "seen" tracking for reading sections reliably fires on a manual,
// gradual scroll but is flaky after an instant scrollIntoView({behavior:
// 'auto'}) jump, most likely because it needs actual incremental scroll
// events as the section passes through the viewport rather than teleporting
// straight there. `behavior: 'smooth'` gets the browser to animate it with
// real scroll events, matching manual scrolling; this then waits for that
// animation to actually settle (polled via rAF, not a fixed guess) so the
// caller doesn't move on before the scroll — and whatever tracking it
// triggers — has finished.
async function smoothScrollIntoView(target, block = 'end') {
  if (!target || !target.scrollIntoView) return;

  const scroller = target.ownerDocument.documentElement;
  const before = scroller.scrollTop;
  target.scrollIntoView({ block, behavior: 'smooth' });

  // Nothing to wait for if this scroll position was already on screen.
  await new Promise((r) => requestAnimationFrame(r));
  if (scroller.scrollTop === before) return;

  let lastTop = scroller.scrollTop;
  let stableTicks = 0;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await new Promise((r) => requestAnimationFrame(r));
    const top = scroller.scrollTop;
    if (Math.abs(top - lastTop) < 0.5) {
      stableTicks++;
      if (stableTicks >= 4) break;
    } else {
      stableTicks = 0;
    }
    lastTop = top;
  }
}

async function handleClickToRevealSection(sectionElements) {
  // Keep this filter identical to classifySection's — both must agree on
  // what counts as a disclosure widget.
  const revealButtons = findInShadowDOMMulti('button', sectionElements).filter((b) => {
    const text = (b.textContent || '').trim();
    if (text.length === 0 || /^(submit|show feedback)$/i.test(text)) return false;
    return b.hasAttribute('aria-expanded') || b.hasAttribute('aria-controls');
  });
  for (const btn of revealButtons) {
    // No extra fixed delay after this — robustClick's own verify already
    // confirms the disclosure actually opened (aria-expanded/is-open) before
    // returning, so there's nothing left to wait for here.
    await robustClick(btn, () => btn.getAttribute('aria-expanded') === 'true' || btn.classList.contains('is-open'));
  }
  return true;
}

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

    // aria-expanded flips as soon as the dropdown starts opening, but the
    // option list itself can render a beat later — wait for it dynamically
    // instead of guessing a fixed pause.
    let options = [];
    await waitFor(() => {
      options = findInShadowDOM('.dropdown__item.js-dropdown-list-item', row.ownerDocument).filter(
        (opt) => opt.offsetParent !== null
      );
      return options.length > 0;
    }, 1000, 30);
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

const moduleWalkState = { running: false, stopRequested: false };

function stopModuleWalk() {
  moduleWalkState.stopRequested = true;
}

async function walkTopicSections() {
  const skipped = [];
  const iframe = getContentIframe();
  if (!iframe) {
    throw new Error("Couldn't find the course content iframe.");
  }
  const contentDoc = iframe.contentDocument;

  // The iframe may still be loading right after openTopic(), or a topic may
  // render no headings at all — give it a grace period before concluding
  // there's nothing to walk (which would otherwise silently mark the topic
  // fully processed).
  const headingsReady = await waitFor(() => findInShadowDOM('.js-heading', contentDoc).length > 0, 5000, 50);
  if (!headingsReady) {
    return { skipped, reachedQuiz: false, stopped: false, notLoaded: true };
  }

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

    if (isGradedQuizSection(sectionName, section)) {
      return { skipped, reachedQuiz: true, quizName: sectionName, stopped: false };
    }

    const kind = classifySection(sectionName, section);

    // Videos are skipped outright rather than played at 4x and waited on —
    // confirmed live this was the walker's main slowdown/hang: real lecture
    // videos can run several minutes even at 4x, and the "ended" event some
    // Netacad video players fire is unreliable, leaving handleVideoSection
    // sitting on its full timeout with the outer loop (and the page's own
    // scroll) stalled behind it. No completion tracking is lost that
    // wouldn't already need a fixed play-through anyway — it's just
    // surfaced as "needs manual review" immediately instead.
    if (kind === 'video') {
      skipped.push(`${sectionName} (video — skipped)`);
      nextIncomplete.dataset.aiWalkerSkipped = 'true';
      continue;
    }

    let handled = false;
    if (kind === 'selfCheck') {
      handled = await handleSelfCheckSection(section);
    } else if (kind === 'matching') {
      handled = await handleMatchingSection(section);
    } else if (kind === 'clickToReveal') {
      handled = await handleClickToRevealSection(section);
    } else if (kind === 'reading') {
      handled = await handleReadingSection(section);
    }

    // Give Netacad's own async completion tracking a grace period to flip
    // the class before concluding the section is still incomplete. Poll
    // faster than the default 200ms so a quick flip doesn't sit waiting.
    await waitFor(() => !nextIncomplete.classList.contains('is-incomplete'), 3000, 50);
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
  // The walker button lives in the content iframe's own document (see
  // checkForCourseContent), not the top document this function runs in.
  const walkerIframe = getContentIframe();
  const walkerButton = walkerIframe ? walkerIframe.contentDocument.getElementById('netacad-ai-walker-btn') : null;
  if (walkerButton) {
    walkerButton.innerHTML = ICON_STOP;
    walkerButton.title = 'Stop Auto-Complete';
  }

  const allSkipped = [];
  let processedCount = 0;

  try {
    const topics = getRemainingTopicsInCurrentModule();
    // Lab/Practice topics are never opened, but they must still show up by
    // name in the final "needs manual review" summary.
    allSkipped.push(...getLabPracticeTopicNamesInCurrentModule());

    if (topics.length === 0) {
      const summary =
        allSkipped.length > 0
          ? `Nothing left to auto-complete — ${allSkipped.length} need manual review (${allSkipped.join(', ')})`
          : 'Nothing left to complete in this module.';
      removeOverlayAfterDelay(summary);
      return;
    }

    for (let i = 0; i < topics.length; i++) {
      const topic = topics[i];
      if (moduleWalkState.stopRequested) {
        removeOverlayAfterDelay('Stopped by user.');
        return;
      }

      updateOverlay(`Auto-Complete Module — ${topic.name} (${processedCount + 1}/${topics.length})`);
      await openTopic(topic);

      const result = await walkTopicSections();
      if (result.notLoaded) {
        // Content never loaded for this topic (iframe still loading, or a
        // topic that renders no headings) — flag it for manual review
        // instead of silently marking it processed.
        allSkipped.push(`${topic.name} (content didn't load)`);
        continue;
      }
      allSkipped.push(...result.skipped);

      if (result.reachedQuiz) {
        // Confirmed live: per-SECTION quizzes ("N.N.NN SECTION QUIZ") are
        // their own topic partway through the module and also trip
        // isGradedQuizSection (mcq-view + a "quiz"-looking name) — the same
        // detection that correctly identifies the module's real, final
        // graded test. Only the module's own completion test — always the
        // last remaining topic in outline order — should stop the whole
        // walk; a mid-module section quiz can't be answered automatically
        // either, but should just be skipped so sections after it (which
        // were wrongly never reached before this fix) still get walked.
        const isModuleFinalQuiz = i === topics.length - 1;
        if (isModuleFinalQuiz) {
          removeOverlayAfterDelay(`Reached "${result.quizName}" — use Get Answer / Web AI to continue.`);
          return;
        }
        allSkipped.push(`${topic.name} (reached "${result.quizName}" — needs manual review)`);
        processedCount++;
        continue;
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
    if (walkerButton) {
      walkerButton.innerHTML = ICON_WALKER;
      walkerButton.title = 'Auto-Complete Module';
    }
  }
}
