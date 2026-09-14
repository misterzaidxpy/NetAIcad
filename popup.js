// Popup script for configuration
document.addEventListener('DOMContentLoaded', async () => {
  const openAiApiKeyInput = document.getElementById('openAiApiKey');
  const geminiApiKeyInput = document.getElementById('geminiApiKey');
  const saveBtn = document.getElementById('saveBtn');
  const statusDiv = document.getElementById('status');

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
