// Popup script for configuration
document.addEventListener('DOMContentLoaded', async () => {
  const openAiApiKeyInput = document.getElementById('openAiApiKey');
  const geminiApiKeyInput = document.getElementById('geminiApiKey');
  const saveBtn = document.getElementById('saveBtn');
  const statusDiv = document.getElementById('status');
  const testOpenAiBtn = document.getElementById('testOpenAi');
  const testGeminiBtn = document.getElementById('testGemini');
  const openAiStatus = document.getElementById('openAiStatus');
  const geminiStatus = document.getElementById('geminiStatus');

  // Load saved settings
  const settings = await chrome.storage.sync.get([
    'openAiApiKey',
    'geminiApiKey'
  ]);

  if (settings.openAiApiKey) {
    openAiApiKeyInput.value = settings.openAiApiKey;
  }

  if (settings.geminiApiKey) {
    geminiApiKeyInput.value = settings.geminiApiKey;
  }

  // Save settings
  saveBtn.addEventListener('click', async () => {
    const openAiApiKey = openAiApiKeyInput.value.trim();
    const geminiApiKey = geminiApiKeyInput.value.trim();

    // Validation - at least one API key is required
    if (!openAiApiKey && !geminiApiKey) {
      showStatus('Please enter at least one API key', 'error');
      return;
    }

    try {
      await chrome.storage.sync.set({
        openAiApiKey: openAiApiKey,
        geminiApiKey: geminiApiKey
      });

      showStatus('Settings saved successfully!', 'success');
    } catch (error) {
      showStatus('Error saving settings: ' + error.message, 'error');
    }
  });

  // Test OpenAI API key
  testOpenAiBtn.addEventListener('click', async () => {
    const key = openAiApiKeyInput.value.trim();
    if (!key) {
      showTestStatus(openAiStatus, false, 'Enter a key first');
      return;
    }

    setTesting(testOpenAiBtn, true);
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${key}` }
      });

      if (response.ok) {
        showTestStatus(openAiStatus, true, 'Valid');
      } else {
        const data = await response.json().catch(() => ({}));
        showTestStatus(openAiStatus, false, data.error?.message || 'Invalid key');
      }
    } catch (error) {
      showTestStatus(openAiStatus, false, 'Network error');
    } finally {
      setTesting(testOpenAiBtn, false);
    }
  });

  // Test Gemini API key
  testGeminiBtn.addEventListener('click', async () => {
    const key = geminiApiKeyInput.value.trim();
    if (!key) {
      showTestStatus(geminiStatus, false, 'Enter a key first');
      return;
    }

    setTesting(testGeminiBtn, true);
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`
      );

      if (response.ok) {
        showTestStatus(geminiStatus, true, 'Valid');
      } else {
        const data = await response.json().catch(() => ({}));
        showTestStatus(geminiStatus, false, data.error?.message || 'Invalid key');
      }
    } catch (error) {
      showTestStatus(geminiStatus, false, 'Network error');
    } finally {
      setTesting(testGeminiBtn, false);
    }
  });

  function setTesting(button, isTesting) {
    button.disabled = isTesting;
    button.textContent = isTesting ? '...' : 'Test';
  }

  function showTestStatus(el, ok, message) {
    el.textContent = ok ? '✓ ' + message : '✗ ' + message;
    el.className = 'test-status show ' + (ok ? 'ok' : 'fail');

    clearTimeout(el._hideTimeout);
    el._hideTimeout = setTimeout(() => {
      el.classList.remove('show');
    }, 4000);
  }

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = 'status ' + type;
    statusDiv.style.display = 'block';

    if (type === 'success') {
      setTimeout(() => {
        statusDiv.style.display = 'none';
      }, 3000);
    }
  }
});
