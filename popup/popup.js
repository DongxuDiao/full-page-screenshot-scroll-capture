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
      await saveSettings();
      await triggerCapture(mode);
      window.close();
    });
  });

  // Save settings on change
  ['format', 'defaultAction', 'captureDelay'].forEach((id) => {
    document.getElementById(id).addEventListener('change', saveSettings);
  });
});

async function triggerCapture(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  chrome.runtime.sendMessage({
    type: 'startCapture',
    tabId: tab.id,
    mode
  });
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
