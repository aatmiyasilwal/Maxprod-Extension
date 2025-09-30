const DEFAULT_STATE = {
  blockedHosts: [],
  allowedSubreddits: [],
  blockReddit: false,
  extensionEnabled: true
};

const state = typeof structuredClone === 'function'
  ? structuredClone(DEFAULT_STATE)
  : JSON.parse(JSON.stringify(DEFAULT_STATE));
const statusElement = document.getElementById('status');
const blockRedditCheckbox = document.getElementById('block-reddit');
const openPopupButton = document.getElementById('open-popup');

const lists = {
  blockedHosts: document.getElementById('blocked-hosts-list'),
  allowedSubreddits: document.getElementById('allowed-subreddits-list')
};

const forms = {
  blockedHosts: document.getElementById('blocked-hosts-form'),
  allowedSubreddits: document.getElementById('allowed-subreddits-form')
};

init();

async function init() {
  let loadedFromStorage = false;
  try {
    const data = await chrome.storage.sync.get(DEFAULT_STATE);
    Object.assign(state, data);
    if (Object.prototype.hasOwnProperty.call(data, 'blockedChannels')) {
      await chrome.storage.sync.remove('blockedChannels');
    }
    if (Object.prototype.hasOwnProperty.call(data, 'blockedSubreddits')) {
      await chrome.storage.sync.remove('blockedSubreddits');
    }
    if (Object.prototype.hasOwnProperty.call(data, 'blockRedditHomepage')) {
      await chrome.storage.sync.remove('blockRedditHomepage');
    }
    state.blockReddit = normalizeBoolean(state.blockReddit);
    state.extensionEnabled = normalizeBoolean(state.extensionEnabled);
    loadedFromStorage = true;
  } catch (error) {
    console.error('[Maxprod] Failed to load settings', error);
  }

  renderAll();
  bindEvents();
  flashStatus(loadedFromStorage ? 'Settings loaded' : 'Using default settings.');
}

function bindEvents() {
  blockRedditCheckbox.checked = Boolean(state.blockReddit);
  blockRedditCheckbox.addEventListener('change', async (event) => {
    const nextValue = event.target.checked;
    state.blockReddit = nextValue;
    await chrome.storage.sync.set({ blockReddit: nextValue });
    flashStatus(nextValue ? 'Reddit blocked except allow list.' : 'Reddit unblocked.');
  });

  openPopupButton.addEventListener('click', () => {
    const url = chrome.runtime.getURL('popup.html');
    window.open(url, '_blank', 'noopener');
  });

  forms.blockedHosts.addEventListener('submit', (event) => {
    event.preventDefault();
    handleAddItem({
      key: 'blockedHosts',
      input: document.getElementById('blocked-hosts-input'),
      normalizer: normalizeHost,
      duplicateMessage: 'Website already blocked.',
      successMessage: 'Website blocked.'
    });
  });

  forms.allowedSubreddits.addEventListener('submit', (event) => {
    event.preventDefault();
    handleAddItem({
      key: 'allowedSubreddits',
      input: document.getElementById('allowed-subreddits-input'),
      normalizer: normalizeSubreddit,
      duplicateMessage: 'Subreddit already allowed.',
      successMessage: 'Subreddit allowed.'
    });
  });

  Object.entries(lists).forEach(([key, listElement]) => {
    listElement.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-remove]');
      if (!button) {
        return;
      }
      const value = button.dataset.value;
      removeValueFromList(key, value);
    });
  });
}

async function handleAddItem({
  key,
  input,
  normalizer,
  duplicateMessage,
  successMessage,
  equalityNormalizer = normalizer,
  onAdd
}) {
  const rawValue = input.value;
  const normalizedValue = normalizer(rawValue);
  if (!normalizedValue) {
    flashStatus('Please enter a valid value.');
    return;
  }

  const existing = (state[key] || []).map(equalityNormalizer);
  const comparisonValue = equalityNormalizer(normalizedValue);
  if (existing.includes(comparisonValue)) {
    flashStatus(duplicateMessage);
    input.value = '';
    return;
  }

  if (typeof onAdd === 'function') {
    await onAdd(normalizedValue);
  }

  await updateStateList(key, [...(state[key] || []), normalizedValue]);
  flashStatus(successMessage);
  input.value = '';
  input.focus();
}

async function removeValueFromList(key, value) {
  const equalityNormalizer = getEqualityNormalizerForKey(key);
  const normalizedValue = equalityNormalizer(value);
  const nextList = (state[key] || []).filter(
    (item) => equalityNormalizer(item) !== normalizedValue
  );
  await updateStateList(key, nextList);
  flashStatus('Removed.');
}

function getNormalizerForKey(key) {
  switch (key) {
    case 'blockedHosts':
      return normalizeHost;
    case 'allowedSubreddits':
      return normalizeSubreddit;
    default:
      return (value) => value;
  }
}

function getEqualityNormalizerForKey(key) {
  return getNormalizerForKey(key);
}

async function updateStateList(key, nextList) {
  state[key] = nextList;
  renderList(key);
  const update = { [key]: nextList };
  await chrome.storage.sync.set(update);

}

function renderAll() {
  Object.keys(lists).forEach(renderList);
}

function renderList(key) {
  const listElement = lists[key];
  if (!listElement) {
    return;
  }

  listElement.textContent = '';
  const values = state[key] || [];

  if (!values.length) {
    const emptyMessage = document.createElement('li');
    emptyMessage.className = 'chip empty';
    emptyMessage.textContent = 'None yet';
    listElement.append(emptyMessage);
    return;
  }

  values.forEach((value) => {
    const listItem = document.createElement('li');
    listItem.className = 'chip';

    const label = document.createElement('span');
    label.textContent = value;

    const removeButton = document.createElement('button');
    removeButton.setAttribute('type', 'button');
    removeButton.setAttribute('aria-label', `Remove ${value}`);
    removeButton.dataset.remove = 'true';
    removeButton.dataset.value = value;
    removeButton.textContent = '×';

    listItem.append(label, removeButton);
    listElement.append(listItem);
  });
}

function flashStatus(message) {
  if (!statusElement) {
    return;
  }
  statusElement.textContent = message;
  if (message) {
    setTimeout(() => {
      statusElement.textContent = '';
    }, 3500);
  }
}

function normalizeHost(value) {
  if (!value) {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return url.hostname.replace(/^www\./, '');
  } catch (_) {
    const simpleHost = trimmed.replace(/^www\./, '');
    if (/^[a-z0-9.-]+$/.test(simpleHost)) {
      return simpleHost;
    }
    return null;
  }
}

function normalizeSubreddit(value) {
  if (!value) {
    return null;
  }
  return value
    .toString()
    .trim()
    .replace(/^\/?r\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  return Boolean(value);
}
