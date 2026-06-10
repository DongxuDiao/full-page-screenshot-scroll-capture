/**
 * Popup script — mode selection, settings, and capture trigger.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Load saved settings
  const settings = await getSettings();
  document.getElementById('format').value = settings.format;
  document.getElementById('defaultAction').value = settings.defaultAction;
  document.getElementById('captureDelay').value = settings.captureDelay;

  // Button click handlers
  const buttons = document.querySelectorAll('.btn[data-mode]');
  buttons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode;
      setStatus('');
      setButtonsDisabled(true);

      try {
        await saveSettings();
        const response = await triggerCapture(mode);
        if (response && response.error) {
          throw new Error(response.error);
        }
        window.close();
      } catch (err) {
        setStatus(err.message || 'Failed to start capture');
        setButtonsDisabled(false);
      }
    });
  });

  // Save settings on change
  ['format', 'defaultAction', 'captureDelay'].forEach((id) => {
    document.getElementById(id).addEventListener('change', saveSettings);
  });
});

async function triggerCapture(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');

  return await chrome.runtime.sendMessage({
    type: 'startCapture',
    tabId: tab.id,
    mode
  });
}

function setButtonsDisabled(disabled) {
  document.querySelectorAll('.btn[data-mode]').forEach((btn) => {
    btn.disabled = disabled;
  });
}

function setStatus(message) {
  document.getElementById('status').textContent = message;
}

async function saveSettings() {
  const settings = {
    format: document.getElementById('format').value,
    defaultAction: document.getElementById('defaultAction').value,
    captureDelay: parseInt(document.getElementById('captureDelay').value, 10)
  };
  await chrome.storage.local.set({ settings });
}

async function getSettings() {
  const defaults = {
    format: 'png',
    defaultAction: 'preview',
    captureDelay: 100
  };
  const stored = await chrome.storage.local.get('settings');
  return { ...defaults, ...(stored.settings || {}) };
}
