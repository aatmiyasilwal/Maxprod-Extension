'use strict';

const OVERLAY_ID = 'maxprod-reddit-overlay';
const CHECK_INTERVAL_MS = 400;
const DEFAULT_STATE = {
  allowedSubreddits: [],
  blockReddit: false,
  extensionEnabled: true
};

const SCROLL_LOCK_STATE_KEY = '__maxprodScrollLockState';

let state = cloneDefaults(DEFAULT_STATE);
let allowedSet = new Set();
let listsVersion = 0;
let lastDecisionKey = '';
let currentOverlayReason = '';

init().catch((error) => console.error('[Maxprod] Reddit script failed to init', error));

async function init() {
  await hydrateState();
  chrome.storage.onChanged.addListener(onStorageChanged);
  checkLocation(true);
  setInterval(() => checkLocation(false), CHECK_INTERVAL_MS);
}

async function hydrateState() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULT_STATE);
    state = { ...DEFAULT_STATE, ...stored };
    const legacyKeys = ['blockedSubreddits', 'blockRedditHomepage'];
    const toRemove = legacyKeys.filter((key) => Object.prototype.hasOwnProperty.call(stored, key));
    if (toRemove.length > 0) {
      await chrome.storage.sync.remove(toRemove);
    }
    state.blockReddit = normalizeBoolean(state.blockReddit);
    state.extensionEnabled = normalizeBoolean(state.extensionEnabled);
  } catch (error) {
    console.error('[Maxprod] Unable to read reddit settings', error);
    state = cloneDefaults(DEFAULT_STATE);
  }
  rebuildSets();
}

function onStorageChanged(changes, areaName) {
  if (areaName !== 'sync') {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'allowedSubreddits')) {
    state.allowedSubreddits = ensureArray(changes.allowedSubreddits.newValue);
    rebuildSets();
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'blockReddit')) {
    state.blockReddit = normalizeBoolean(changes.blockReddit.newValue);
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'extensionEnabled')) {
    state.extensionEnabled = normalizeBoolean(changes.extensionEnabled.newValue);
  }

  checkLocation(true);
}

function rebuildSets() {
  allowedSet = new Set(ensureArray(state.allowedSubreddits).map(normalizeSubreddit).filter(Boolean));
  listsVersion += 1;
}

function checkLocation(force) {
  const hostname = (window.location.hostname || '').toLowerCase();
  if (!hostname.endsWith('reddit.com')) {
    lastDecisionKey = '';
    currentOverlayReason = '';
    clearOverlay();
    return;
  }

  const key = [
    window.location.href,
    state.extensionEnabled,
    state.blockReddit,
    listsVersion
  ].join('|');

  if (!force && key === lastDecisionKey) {
    return;
  }

  lastDecisionKey = key;

  if (!state.extensionEnabled) {
    clearOverlay();
    currentOverlayReason = '';
    return;
  }

  const pathname = window.location.pathname || '/';
  const search = window.location.search || '';

  const reason = determineBlockReason(pathname, search);
  if (reason) {
    applyOverlay(reason);
  } else {
    clearOverlay();
    currentOverlayReason = '';
  }
}

function determineBlockReason(pathname, search) {
  if (!state.blockReddit) {
    return null;
  }

  const lowerPath = pathname.toLowerCase();
  const subreddit = extractSubreddit(lowerPath);

  if (subreddit && allowedSet.has(subreddit)) {
    return null;
  }

  if (subreddit) {
    return { type: 'subreddit', key: subreddit, value: subreddit };
  }

  if (isHomepage(lowerPath, search)) {
    return { type: 'homepage', key: 'home' };
  }

  return { type: 'global', key: 'other' };
}

function isHomepage(pathname, search) {
  if (pathname === '/' || pathname === '') {
    return true;
  }

  switch (pathname) {
    case '/hot':
    case '/best':
    case '/new':
    case '/top':
    case '/r/all':
    case '/r/popular':
      return true;
    default:
      break;
  }

  if (pathname === '/' && search && !search.includes('r=')) {
    return true;
  }

  return false;
}

function extractSubreddit(pathname) {
  const match = pathname.match(/^\/r\/([^/]+)(?:\/|$)/i);
  if (!match || !match[1]) {
    return null;
  }
  return normalizeSubreddit(match[1]);
}

function applyOverlay(reason) {
  const reasonKey = `${reason.type}:${reason.key}`;
  const isNewReason = reasonKey !== currentOverlayReason;
  currentOverlayReason = reasonKey;

  const overlay = ensureOverlay();
  if (!overlay) {
    return;
  }
  const title = overlay.querySelector('[data-maxprod-title]');
  const message = overlay.querySelector('[data-maxprod-message]');

  if (reason.type === 'homepage') {
    title.textContent = 'Reddit homepage is blocked';
    message.textContent = 'Stay focused! Visit an allowed subreddit or tweak your settings in Maxprod.';
  } else if (reason.type === 'subreddit') {
    title.textContent = `r/${reason.value} is blocked`;
    message.textContent = 'This subreddit is not on your allow list. Add it in Maxprod if you need access.';
  } else {
    title.textContent = 'Reddit is blocked';
    message.textContent = 'Only whitelisted subreddits are accessible. Update your allow list in Maxprod to continue.';
  }

  if (isNewReason) {
    try {
      window.stop();
    } catch (_) {
      // ignore
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }
}

function ensureOverlay() {
  let overlay = document.getElementById(OVERLAY_ID);
  const root = document.body || document.documentElement;
  if (!root) {
    return overlay || null;
  }

  const wasActive = Boolean(overlay && overlay.parentNode);

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-live', 'assertive');
    overlay.tabIndex = -1;
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.zIndex = '2147483647';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.background = 'rgba(15, 23, 42, 0.94)';
    overlay.style.color = '#f8fafc';
    overlay.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    overlay.style.padding = '2.5rem';
    overlay.style.textAlign = 'center';
    overlay.style.backdropFilter = 'blur(4px)';
    overlay.style.pointerEvents = 'auto';
    overlay.innerHTML = `
      <div style="max-width: 520px; display: grid; gap: 1rem;">
        <h1 data-maxprod-title style="margin: 0; font-size: 2rem;"></h1>
        <p data-maxprod-message style="margin: 0; font-size: 1.05rem; line-height: 1.6;"></p>
        <p style="margin: 0; font-size: 0.9rem; opacity: 0.65;">Update your Reddit allow list from the Maxprod extension options page.</p>
      </div>
    `;
  }

  if (!overlay.parentNode) {
    root.appendChild(overlay);
  }

  if (!wasActive) {
    lockScroll();
  }

  if (typeof overlay.focus === 'function') {
    try {
      overlay.focus({ preventScroll: true });
    } catch (_) {
      // ignore focus errors
    }
  }

  return overlay;
}

function clearOverlay() {
  const overlay = document.getElementById(OVERLAY_ID);
  const wasActive = Boolean(overlay && overlay.parentNode);
  if (wasActive) {
    overlay.parentNode.removeChild(overlay);
    unlockScroll();
  }
}

function ensureScrollLockState() {
  const existing = window[SCROLL_LOCK_STATE_KEY];
  if (existing && typeof existing === 'object') {
    return existing;
  }

  const interceptKeyEvent = (event) => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const state = {
    count: 0,
    prevDocOverflow: '',
    prevDocOverscroll: '',
    prevBodyOverflow: '',
    prevBodyTouchAction: '',
    handlers: {
      wheel: (event) => {
        event.preventDefault();
      },
      touchmove: (event) => {
        event.preventDefault();
      },
      keydown: interceptKeyEvent,
      keypress: interceptKeyEvent,
      keyup: interceptKeyEvent
    }
  };

  window[SCROLL_LOCK_STATE_KEY] = state;
  return state;
}

function lockScroll() {
  const docEl = document.documentElement;
  if (!docEl) {
    return;
  }

  const state = ensureScrollLockState();
  if (state.count === 0) {
    state.prevDocOverflow = docEl.style.overflow || '';
    state.prevDocOverscroll = docEl.style.overscrollBehavior || '';
    docEl.style.overflow = 'hidden';
    docEl.style.overscrollBehavior = 'none';

    const body = document.body;
    if (body) {
      state.prevBodyOverflow = body.style.overflow || '';
      state.prevBodyTouchAction = body.style.touchAction || '';
      body.style.overflow = 'hidden';
      body.style.touchAction = 'none';
    }

    const listenerOptions = { passive: false };
  window.addEventListener('wheel', state.handlers.wheel, listenerOptions);
  window.addEventListener('touchmove', state.handlers.touchmove, listenerOptions);
  window.addEventListener('keydown', state.handlers.keydown, true);
  window.addEventListener('keypress', state.handlers.keypress, true);
  window.addEventListener('keyup', state.handlers.keyup, true);
  }

  state.count += 1;
}

function unlockScroll() {
  const state = window[SCROLL_LOCK_STATE_KEY];
  if (!state || typeof state !== 'object') {
    return;
  }

  state.count = Math.max(0, state.count - 1);
  if (state.count > 0) {
    return;
  }

  const docEl = document.documentElement;
  if (docEl) {
    docEl.style.overflow = state.prevDocOverflow || '';
    docEl.style.overscrollBehavior = state.prevDocOverscroll || '';
  }

  const body = document.body;
  if (body) {
    body.style.overflow = state.prevBodyOverflow || '';
    body.style.touchAction = state.prevBodyTouchAction || '';
  }

  window.removeEventListener('wheel', state.handlers.wheel);
  window.removeEventListener('touchmove', state.handlers.touchmove);
  window.removeEventListener('keydown', state.handlers.keydown, true);
  window.removeEventListener('keypress', state.handlers.keypress, true);
  window.removeEventListener('keyup', state.handlers.keyup, true);

  delete window[SCROLL_LOCK_STATE_KEY];
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

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function cloneDefaults(obj) {
  return JSON.parse(JSON.stringify(obj));
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
