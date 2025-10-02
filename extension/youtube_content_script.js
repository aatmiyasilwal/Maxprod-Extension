'use strict';

const OVERLAY_ID = 'maxprod-youtube-overlay';
const CHECK_INTERVAL_MS = 400;
const SCROLL_LOCK_STATE_KEY = '__maxprodScrollLockState';

const DEFAULT_STATE = {
  extensionEnabled: true,
  blockedYouTubeChannels: []
};

let state = { ...DEFAULT_STATE };
let lastSignature = '';
let checkToken = 0;
let overlayReason = '';

init().catch((error) => console.error('[Maxprod] YouTube script failed to init', error));

async function init() {
  await hydrateState();
  chrome.storage.onChanged.addListener(handleStorageChange);

  window.addEventListener('yt-navigate-finish', () => queueCheck(true));
  window.addEventListener('yt-navigate-start', () => {
    overlayReason = '';
    clearOverlay();
  });

  setInterval(() => queueCheck(false), CHECK_INTERVAL_MS);
  queueCheck(true);
}

async function hydrateState() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULT_STATE);
    state.extensionEnabled = normalizeBoolean(stored.extensionEnabled);
    state.blockedYouTubeChannels = Array.isArray(stored.blockedYouTubeChannels)
      ? stored.blockedYouTubeChannels
      : [];
  } catch (error) {
    console.error('[Maxprod] Unable to read YouTube settings', error);
    state = { ...DEFAULT_STATE };
  }
}

function handleStorageChange(changes, areaName) {
  if (areaName !== 'sync') {
    return;
  }

  let shouldRecheck = false;

  if (Object.prototype.hasOwnProperty.call(changes, 'extensionEnabled')) {
    state.extensionEnabled = normalizeBoolean(changes.extensionEnabled.newValue);
    shouldRecheck = true;
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'blockedYouTubeChannels')) {
    state.blockedYouTubeChannels = Array.isArray(changes.blockedYouTubeChannels.newValue)
      ? changes.blockedYouTubeChannels.newValue
      : [];
    shouldRecheck = true;
  }

  if (shouldRecheck) {
    queueCheck(true);
  }
}

function queueCheck(force) {
  const signature = buildSignature();
  if (!force && signature === lastSignature) {
    return;
  }

  lastSignature = signature;
  void checkCurrentVideo();
}

function buildSignature() {
  const url = window.location.href;
  return [
    url,
    state.extensionEnabled,
    state.blockedYouTubeChannels?.length || 0
  ].join('|');
}

async function checkCurrentVideo() {
  const videoId = getActiveVideoId();

  if (!videoId || !state.extensionEnabled) {
    overlayReason = '';
    clearOverlay();
    return;
  }

  const currentToken = ++checkToken;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'youtube-check-video',
      videoId
    });

    if (currentToken !== checkToken) {
      return;
    }

    if (!response || response.allowed || response.reason !== 'channel-blocked') {
      if (overlayReason) {
        overlayReason = '';
        clearOverlay();
      }
      if (response && response.error) {
        console.warn('[Maxprod] YouTube check failed:', response.error);
      } else if (response && response.reason === 'missing-api-key') {
        console.info('[Maxprod] Add YOUTUBE_API_KEY to the extension .env file to enable YouTube channel blocking.');
      }
      return;
    }

    const channelTitle = response.channelTitle || 'Blocked channel';
    overlayReason = `blocked:${channelTitle}`;
    applyOverlay(channelTitle);
  } catch (error) {
    console.error('[Maxprod] YouTube check error', error);
  }
}

function getActiveVideoId() {
  const url = window.location.href;

  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('youtube.com')) {
      return null;
    }

    if (parsed.pathname === '/watch') {
      const videoId = parsed.searchParams.get('v');
      return videoId ? videoId.trim() : null;
    }

    if (parsed.pathname.startsWith('/shorts/')) {
      const segments = parsed.pathname.split('/').filter(Boolean);
      return segments[1] ? segments[1].trim() : null;
    }

    if (parsed.pathname.startsWith('/embed/')) {
      const segments = parsed.pathname.split('/').filter(Boolean);
      return segments[1] ? segments[1].trim() : null;
    }
  } catch (_) {
    return null;
  }

  return null;
}

function applyOverlay(channelTitle) {
  const overlay = ensureOverlay();
  if (!overlay) {
    return;
  }

  const title = overlay.querySelector('[data-maxprod-title]');
  const message = overlay.querySelector('[data-maxprod-message]');

  if (title) {
    title.textContent = 'Video blocked';
  }

  if (message) {
    message.textContent = `${channelTitle} is on your YouTube block list.`;
  }

  pauseAllVideos();

  try {
    window.stop();
  } catch (_) {
    // ignore
  }

  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
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
    overlay.style.zIndex = '2147483646';
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
        <p style="margin: 0; font-size: 0.9rem; opacity: 0.65;">Edit your YouTube block list in Maxprod's options.</p>
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

  const stateObj = {
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

  window[SCROLL_LOCK_STATE_KEY] = stateObj;
  return stateObj;
}

function lockScroll() {
  const docEl = document.documentElement;
  if (!docEl) {
    return;
  }

  const stateObj = ensureScrollLockState();
  if (stateObj.count === 0) {
    stateObj.prevDocOverflow = docEl.style.overflow || '';
    stateObj.prevDocOverscroll = docEl.style.overscrollBehavior || '';
    docEl.style.overflow = 'hidden';
    docEl.style.overscrollBehavior = 'none';

    const body = document.body;
    if (body) {
      stateObj.prevBodyOverflow = body.style.overflow || '';
      stateObj.prevBodyTouchAction = body.style.touchAction || '';
      body.style.overflow = 'hidden';
      body.style.touchAction = 'none';
    }

    const listenerOptions = { passive: false };
  window.addEventListener('wheel', stateObj.handlers.wheel, listenerOptions);
  window.addEventListener('touchmove', stateObj.handlers.touchmove, listenerOptions);
  window.addEventListener('keydown', stateObj.handlers.keydown, true);
  window.addEventListener('keypress', stateObj.handlers.keypress, true);
  window.addEventListener('keyup', stateObj.handlers.keyup, true);
  }

  stateObj.count += 1;
}

function unlockScroll() {
  const stateObj = window[SCROLL_LOCK_STATE_KEY];
  if (!stateObj || typeof stateObj !== 'object') {
    return;
  }

  stateObj.count = Math.max(0, stateObj.count - 1);
  if (stateObj.count > 0) {
    return;
  }

  const docEl = document.documentElement;
  if (docEl) {
    docEl.style.overflow = stateObj.prevDocOverflow || '';
    docEl.style.overscrollBehavior = stateObj.prevDocOverscroll || '';
  }

  const body = document.body;
  if (body) {
    body.style.overflow = stateObj.prevBodyOverflow || '';
    body.style.touchAction = stateObj.prevBodyTouchAction || '';
  }

  window.removeEventListener('wheel', stateObj.handlers.wheel);
  window.removeEventListener('touchmove', stateObj.handlers.touchmove);
  window.removeEventListener('keydown', stateObj.handlers.keydown, true);
  window.removeEventListener('keypress', stateObj.handlers.keypress, true);
  window.removeEventListener('keyup', stateObj.handlers.keyup, true);

  delete window[SCROLL_LOCK_STATE_KEY];
}

function pauseAllVideos() {
  const videos = document.querySelectorAll('video');
  videos.forEach((video) => {
    try {
      video.pause();
      video.currentTime = 0;
    } catch (_) {
      // ignore
    }
  });
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
