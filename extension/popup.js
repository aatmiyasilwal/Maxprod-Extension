const DEFAULT_STATE = { extensionEnabled: true };

const toggle = document.getElementById('enabled-toggle');
const message = document.getElementById('state-message');
const optionsButton = document.getElementById('options-button');

init();

async function init() {
  const { extensionEnabled } = await chrome.storage.sync.get(DEFAULT_STATE);
  renderState(Boolean(extensionEnabled));
  bindEvents();
}

function bindEvents() {
  toggle.addEventListener('change', async (event) => {
    const enabled = event.target.checked;
    await chrome.storage.sync.set({ extensionEnabled: enabled });
    renderState(enabled);
  });

  optionsButton.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes.extensionEnabled) {
      return;
    }
    const enabled = Boolean(changes.extensionEnabled.newValue);
    renderState(enabled);
  });
}

function renderState(enabled) {
  toggle.checked = enabled;
  message.textContent = enabled
    ? 'Blocking is active everywhere.'
    : 'Blocking is paused until you turn it back on.';
  document.body.dataset.enabled = String(enabled);
}
