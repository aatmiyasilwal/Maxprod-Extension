'use strict';

const OVERLAY_ID = 'maxprod-reddit-overlay';
const CHECK_INTERVAL_MS = 400;
const DEFAULT_STATE = {
  blockedSubreddits: [],
  allowedSubreddits: [],
  blockRedditHomepage: true,
  extensionEnabled: true
};

let state = cloneDefaults(DEFAULT_STATE);
let blockedSet = new Set();
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

  let needsRebuild = false;

  if (Object.prototype.hasOwnProperty.call(changes, 'blockedSubreddits')) {
    state.blockedSubreddits = ensureArray(changes.blockedSubreddits.newValue);
    needsRebuild = true;
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'allowedSubreddits')) {
    state.allowedSubreddits = ensureArray(changes.allowedSubreddits.newValue);
    needsRebuild = true;
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'blockRedditHomepage')) {
    state.blockRedditHomepage = Boolean(changes.blockRedditHomepage.newValue);
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'extensionEnabled')) {
    state.extensionEnabled = Boolean(changes.extensionEnabled.newValue);
  }

  if (needsRebuild) {
    rebuildSets();
  }

  checkLocation(true);
}

function rebuildSets() {
  blockedSet = new Set(ensureArray(state.blockedSubreddits).map(normalizeSubreddit).filter(Boolean));
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
    state.blockRedditHomepage,
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
  const lowerPath = pathname.toLowerCase();

  if (state.blockRedditHomepage && isHomepage(lowerPath, search)) {
    return { type: 'homepage', key: 'home' };
  }

  const subreddit = extractSubreddit(lowerPath);
  if (!subreddit) {
    return null;
  }

  if (allowedSet.has(subreddit)) {
    return null;
  }

  if (blockedSet.has(subreddit)) {
    return { type: 'subreddit', key: subreddit, value: subreddit };
  }

  return null;
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
  const title = overlay.querySelector('[data-maxprod-title]');
  const message = overlay.querySelector('[data-maxprod-message]');

  if (reason.type === 'homepage') {
    title.textContent = 'Reddit homepage is blocked';
    message.textContent = 'Stay focused! Open a specific allowed community or tweak your settings in Maxprod.';
  } else {
    title.textContent = `r/${reason.value} is blocked`;
    message.textContent = 'This subreddit is on your blocklist. Pick another community or update your Maxprod settings.';
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
  if (overlay) {
    return overlay;
  }

  overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-live', 'assertive');
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
  overlay.innerHTML = `
    <div style="max-width: 520px; display: grid; gap: 1rem;">
      <h1 data-maxprod-title style="margin: 0; font-size: 2rem;"></h1>
      <p data-maxprod-message style="margin: 0; font-size: 1.05rem; line-height: 1.6;"></p>
      <p style="margin: 0; font-size: 0.9rem; opacity: 0.65;">Edit your block or allow lists from the Maxprod extension options page.</p>
    </div>
  `;

  const root = document.body || document.documentElement;
  root.appendChild(overlay);
  document.documentElement.style.overflow = 'hidden';
  return overlay;
}

function clearOverlay() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay && overlay.parentNode) {
    overlay.parentNode.removeChild(overlay);
  }
  document.documentElement.style.overflow = '';
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
