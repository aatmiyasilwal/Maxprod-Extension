'use strict';

const DEFAULT_STATE = {
  blockedHosts: [],
  allowedSubreddits: [],
  blockReddit: false,
  extensionEnabled: true,
  blockedYouTubeChannels: []
};

const RULE_OFFSETS = {
  BLOCKED_HOSTS: 10_000,
  REDDIT_BLOCK: 20_000,
  ALLOWED_SUBREDDITS: 30_000
};

const RULE_PRIORITIES = {
  BLOCK: 1,
  ALLOW: 100
};

const SITE_OVERLAY_ID = 'maxprod-site-block-overlay';
const SCROLL_LOCK_STATE_KEY = '__maxprodScrollLockState';
const YOUTUBE_CACHE_TTL_MS = 5 * 60 * 1000;
const YOUTUBE_CHANNEL_CACHE_TTL_MS = 10 * 60 * 1000;
const ENV_FILE_PATH = '.env';
const ENV_YOUTUBE_KEY = 'YOUTUBE_API_KEY';

/** @type {Map<string, { timestamp: number, data: { channelId: string, channelTitle: string } | null }>} */
const youtubeVideoCache = new Map();
/** @type {Map<string, { timestamp: number, data: { handle: string } | null }>} */
const youtubeChannelCache = new Map();

let envValuesPromise;

chrome.runtime.onInstalled.addListener(() => {
  initializeState().then(updateAllRules).catch(handleError);
});

chrome.runtime.onStartup.addListener(() => {
  updateAllRules().catch(handleError);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') {
    return;
  }

  const relevantKeys = new Set([
    'blockedHosts',
    'allowedSubreddits',
    'blockReddit',
    'extensionEnabled'
  ]);

  const hasRelevantChange = Object.keys(changes).some((key) => relevantKeys.has(key));
  if (hasRelevantChange) {
    updateAllRules().catch(handleError);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  if (message.type === 'youtube-check-video') {
    handleYouTubeVideoCheck(message)
      .then((response) => sendResponse(response))
      .catch((error) => {
        handleError(error);
        sendResponse({ allowed: true, error: error?.message || 'youtube-check-failed' });
      });
    return true;
  }

  return undefined;
});

async function initializeState() {
  const stored = await chrome.storage.sync.get(DEFAULT_STATE);
  const updates = {};
  for (const key of Object.keys(DEFAULT_STATE)) {
    const value = stored[key];
    if (value === undefined) {
      updates[key] = DEFAULT_STATE[key];
    }
  }

  if (stored.blockedYouTubeChannels !== undefined && !Array.isArray(stored.blockedYouTubeChannels)) {
    updates.blockedYouTubeChannels = ensureArray(stored.blockedYouTubeChannels);
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.sync.set(updates);
  }

  if (stored.blockReddit !== undefined && typeof stored.blockReddit !== 'boolean') {
    await chrome.storage.sync.set({ blockReddit: normalizeBoolean(stored.blockReddit) });
  }

  if (stored.extensionEnabled !== undefined && typeof stored.extensionEnabled !== 'boolean') {
    await chrome.storage.sync.set({ extensionEnabled: normalizeBoolean(stored.extensionEnabled) });
  }

  if (Object.prototype.hasOwnProperty.call(stored, 'blockedChannels')) {
    const legacyChannels = ensureArray(stored.blockedChannels);
    if (!stored.blockedYouTubeChannels && legacyChannels.length > 0) {
      await chrome.storage.sync.set({ blockedYouTubeChannels: legacyChannels });
    }
    await chrome.storage.sync.remove('blockedChannels');
  }

  if (Object.prototype.hasOwnProperty.call(stored, 'youtubeApiKey')) {
    await chrome.storage.sync.remove('youtubeApiKey');
  }

  const legacyKeys = ['blockedSubreddits', 'blockRedditHomepage'];
  const keysToRemove = legacyKeys.filter((key) => Object.prototype.hasOwnProperty.call(stored, key));
  if (keysToRemove.length > 0) {
    await chrome.storage.sync.remove(keysToRemove);
  }
}

async function updateAllRules() {
  const state = await chrome.storage.sync.get(DEFAULT_STATE);
  const blockReddit = normalizeBoolean(state.blockReddit);
  const extensionEnabled = normalizeBoolean(state.extensionEnabled);
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existingRules.map((rule) => rule.id);

  if (!extensionEnabled) {
    if (removeRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    }
    await enforceOpenTabs({
      extensionEnabled,
      blockReddit,
      blockedHosts: ensureArray(state.blockedHosts)
    });
    return;
  }

  const rules = [];

  appendBlockedHostRules(rules, ensureArray(state.blockedHosts));

  if (blockReddit) {
    rules.push(createRedditBlockRule());
    appendAllowedSubredditRules(rules, ensureArray(state.allowedSubreddits));
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: rules
  });

  await enforceOpenTabs({
    extensionEnabled,
    blockReddit,
    blockedHosts: ensureArray(state.blockedHosts)
  });
}

function appendBlockedHostRules(rules, hosts) {
  hosts
    .filter(Boolean)
    .map((host) => host.trim().toLowerCase())
    .filter((host, index, arr) => host && arr.indexOf(host) === index)
    .forEach((host, index) => {
      rules.push({
        id: RULE_OFFSETS.BLOCKED_HOSTS + index,
        priority: RULE_PRIORITIES.BLOCK,
        action: { type: 'block' },
        condition: {
          urlFilter: `||${host}`,
          resourceTypes: ['main_frame']
        }
      });
    });
}

function createRedditBlockRule() {
  return {
    id: RULE_OFFSETS.REDDIT_BLOCK,
    priority: RULE_PRIORITIES.BLOCK,
    action: { type: 'block' },
    condition: {
      urlFilter: '||reddit.com^',
      resourceTypes: ['main_frame']
    }
  };
}

function appendAllowedSubredditRules(rules, subreddits) {
  subreddits
    .filter(Boolean)
    .map(normalizeSubreddit)
    .filter((sub, index, arr) => sub && arr.indexOf(sub) === index)
    .forEach((subreddit, index) => {
      rules.push({
        id: RULE_OFFSETS.ALLOWED_SUBREDDITS + index,
        priority: RULE_PRIORITIES.ALLOW,
        action: { type: 'allow' },
        condition: {
          urlFilter: `||reddit.com/r/${subreddit}`,
          resourceTypes: ['main_frame']
        }
      });
    });
}

async function enforceOpenTabs({ extensionEnabled, blockedHosts }) {
  try {
    const tabs = await chrome.tabs.query({});
    const blockedHostSet = new Set(
      blockedHosts
        .filter(Boolean)
        .map(normalizeHostForMatching)
        .filter(Boolean)
    );

    await Promise.allSettled(
      tabs.map(async (tab) => {
        if (!tab.id || !tab.url || !/^https?:/i.test(tab.url)) {
          return;
        }

        const hostname = getHostnameFromUrl(tab.url);
        if (!hostname) {
          return;
        }

        if (!extensionEnabled) {
          await removeSiteOverlay(tab.id);
          return;
        }

        if (hostname.endsWith('reddit.com')) {
          await removeSiteOverlay(tab.id);
          return;
        }

        if (isHostBlocked(hostname, blockedHostSet)) {
          await applySiteOverlay(tab.id, hostname);
        } else {
          await removeSiteOverlay(tab.id);
        }
      })
    );
  } catch (error) {
    handleError(error);
  }
}

function isHostBlocked(hostname, blockedHostSet) {
  if (!hostname || !blockedHostSet || blockedHostSet.size === 0) {
    return false;
  }

  const normalized = normalizeHostForMatching(hostname);
  if (!normalized) {
    return false;
  }

  for (const blocked of blockedHostSet) {
    if (normalized === blocked || normalized.endsWith(`.${blocked}`)) {
      return true;
    }
  }

  return false;
}

function getHostnameFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
}

async function applySiteOverlay(tabId, hostname) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (host, overlayId, scrollStateKey) => {
        function ensureScrollLockState(key) {
          const existingState = window[key];
          if (existingState && typeof existingState === 'object') {
            return existingState;
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

          window[key] = state;
          return state;
        }

        function lockScroll(key) {
          const docEl = document.documentElement;
          if (!docEl) {
            return;
          }

          const state = ensureScrollLockState(key);
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

        const existing = document.getElementById(overlayId);
        const root = document.body || document.documentElement;
        if (!root) {
          return;
        }

        const wasActive = Boolean(existing && existing.parentNode);

        let overlay = existing;
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.id = overlayId;
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
              <h1 style="margin: 0; font-size: 2rem;">Site blocked</h1>
              <p data-maxprod-site-host style="margin: 0; font-size: 1.05rem; line-height: 1.6;"></p>
              <p style="margin: 0; font-size: 0.9rem; opacity: 0.65;">Update your blocked sites in Maxprod to regain access.</p>
            </div>
          `;
        }

        const message = overlay.querySelector('[data-maxprod-site-host]');
        if (message) {
          message.textContent = `${host} is blocked by Maxprod.`;
        }

        if (!overlay.parentNode) {
          root.appendChild(overlay);
        }

        if (!wasActive) {
          lockScroll(scrollStateKey);
        }

        document.documentElement.dataset.maxprodSiteOverlay = 'true';

        try {
          window.stop();
        } catch (_) {
          // ignore
        }

        window.scrollTo({ top: 0, left: 0, behavior: 'auto' });

        if (typeof overlay.focus === 'function') {
          try {
            overlay.focus({ preventScroll: true });
          } catch (_) {
            // ignore focus errors
          }
        }
      },
      args: [hostname, SITE_OVERLAY_ID, SCROLL_LOCK_STATE_KEY]
    });
  } catch (error) {
    // Ignore tabs where scripts cannot run (e.g., chrome:// pages)
  }
}

async function removeSiteOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (overlayId, scrollStateKey) => {
        function unlockScroll(key) {
          const state = window[key];
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

          delete window[key];
        }

        const overlay = document.getElementById(overlayId);
        const wasActive = Boolean(overlay && overlay.parentNode);
        if (wasActive) {
          overlay.parentNode.removeChild(overlay);
        }

        if (wasActive) {
          unlockScroll(scrollStateKey);
        }

        delete document.documentElement.dataset.maxprodSiteOverlay;
      },
      args: [SITE_OVERLAY_ID, SCROLL_LOCK_STATE_KEY]
    });
  } catch (_) {
    // Ignore tabs where scripts cannot run (e.g., chrome:// pages)
  }
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

async function handleYouTubeVideoCheck(message) {
  const videoId = (message?.videoId || '').trim();
  if (!videoId) {
    return { allowed: true, reason: 'invalid-video-id' };
  }

  const stored = await chrome.storage.sync.get({
    extensionEnabled: DEFAULT_STATE.extensionEnabled,
    blockedYouTubeChannels: DEFAULT_STATE.blockedYouTubeChannels
  });

  const extensionEnabled = normalizeBoolean(stored.extensionEnabled);
  if (!extensionEnabled) {
    return { allowed: true, reason: 'extension-disabled' };
  }

  const normalizedEntries = ensureArray(stored.blockedYouTubeChannels)
    .map(normalizeYouTubeChannelEntry)
    .filter(Boolean);

  if (normalizedEntries.length === 0) {
    return { allowed: true, reason: 'no-blocked-channels' };
  }

  const apiKey = await getYoutubeApiKeyFromEnv();
  if (!apiKey) {
    return { allowed: true, reason: 'missing-api-key' };
  }

  const videoInfo = await fetchYouTubeVideoInfo(videoId, apiKey);
  if (!videoInfo) {
    return { allowed: true, reason: 'video-not-found' };
  }

  let channelHandle = '';
  if (normalizedEntries.some((entry) => entry.type === 'handle')) {
    const channelInfo = await fetchYouTubeChannelInfo(videoInfo.channelId, apiKey);
    channelHandle = channelInfo?.handle || '';
  }

  const blocked = isChannelBlocked(videoInfo, normalizedEntries, channelHandle);
  return {
    allowed: !blocked,
    reason: blocked ? 'channel-blocked' : 'channel-allowed',
    channelId: videoInfo.channelId,
    channelTitle: videoInfo.channelTitle
  };
}

async function fetchYouTubeVideoInfo(videoId, apiKey) {
  const now = Date.now();
  const cached = youtubeVideoCache.get(videoId);
  if (cached && now - cached.timestamp < YOUTUBE_CACHE_TTL_MS) {
    return cached.data;
  }

  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.search = new URLSearchParams({
    part: 'snippet',
    id: videoId,
    key: apiKey
  }).toString();

  const response = await fetch(url.toString());
  if (!response.ok) {
    if (response.status === 400 || response.status === 403) {
      const errorBody = await response.text();
      throw new Error(`YouTube API error (${response.status}): ${errorBody}`);
    }
    throw new Error(`YouTube API request failed with status ${response.status}`);
  }

  const data = await response.json();
  const item = data?.items?.[0];
  const result = item && item.snippet
    ? {
        channelId: (item.snippet.channelId || '').trim(),
        channelTitle: (item.snippet.channelTitle || '').trim()
      }
    : null;

  youtubeVideoCache.set(videoId, { data: result, timestamp: now });
  pruneYouTubeVideoCache();
  return result;
}

async function fetchYouTubeChannelInfo(channelId, apiKey) {
  const normalizedId = (channelId || '').trim();
  if (!normalizedId) {
    return null;
  }

  const now = Date.now();
  const cached = youtubeChannelCache.get(normalizedId);
  if (cached && now - cached.timestamp < YOUTUBE_CHANNEL_CACHE_TTL_MS) {
    return cached.data;
  }

  const url = new URL('https://www.googleapis.com/youtube/v3/channels');
  url.search = new URLSearchParams({
    part: 'snippet',
    id: normalizedId,
    key: apiKey
  }).toString();

  const response = await fetch(url.toString());
  if (!response.ok) {
    if (response.status === 400 || response.status === 403) {
      const errorBody = await response.text();
      throw new Error(`YouTube channel API error (${response.status}): ${errorBody}`);
    }
    throw new Error(`YouTube channel API request failed with status ${response.status}`);
  }

  const data = await response.json();
  const item = data?.items?.[0];
  const handle = item?.snippet?.customUrl ? item.snippet.customUrl.trim().toLowerCase() : '';

  const result = { handle }; // handle may be empty string if unavailable
  youtubeChannelCache.set(normalizedId, { data: result, timestamp: now });
  pruneYouTubeChannelCache();
  return result;
}

async function getYoutubeApiKeyFromEnv() {
  try {
    const values = await loadEnvValues();
    const key = values[ENV_YOUTUBE_KEY];
    if (!key) {
      envValuesPromise = null;
      return '';
    }
    return typeof key === 'string' ? key.trim() : '';
  } catch (error) {
    handleError(error);
    envValuesPromise = null;
    return '';
  }
}

async function loadEnvValues() {
  if (!envValuesPromise) {
    envValuesPromise = (async () => {
      try {
        const url = chrome.runtime.getURL(ENV_FILE_PATH);
        const response = await fetch(url);
        if (!response.ok) {
          return {};
        }
        const text = await response.text();
        return parseEnvFile(text);
      } catch (_) {
        return {};
      }
    })();
  }

  return envValuesPromise;
}

function parseEnvFile(content) {
  if (!content) {
    return {};
  }

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .reduce((acc, line) => {
      const eqIndex = line.indexOf('=');
      if (eqIndex === -1) {
        return acc;
      }
      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key) {
        acc[key] = value;
      }
      return acc;
    }, {});
}

function normalizeSubreddit(input) {
  return input
    .toString()
    .trim()
    .replace(/^\/?r\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function handleError(error) {
  console.error('[Maxprod] Background error:', error);
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

function normalizeHostForMatching(host) {
  if (!host) {
    return '';
  }

  return host
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
}

function normalizeYouTubeChannelEntry(value) {
  if (!value) {
    return null;
  }

  let raw = value.toString().trim();
  if (!raw) {
    return null;
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.pathname.startsWith('/channel/')) {
        raw = url.pathname.split('/').filter(Boolean)[1] || raw;
      } else if (url.pathname.startsWith('/@')) {
        raw = `@${url.pathname.split('/').filter(Boolean)[0].replace(/^@/, '')}`;
      } else if (url.pathname.startsWith('/c/')) {
        raw = url.pathname.split('/').filter(Boolean)[1] || raw;
      }
    } catch (_) {
      // ignore malformed URLs
    }
  }

  if (/^uc[A-Za-z0-9_-]{22}$/i.test(raw)) {
    return { type: 'id', value: raw.toLowerCase() };
  }

  if (raw.startsWith('@')) {
    return { type: 'handle', value: raw.slice(1).toLowerCase() };
  }

  return { type: 'name', value: raw.toLowerCase() };
}

function isChannelBlocked(info, entries, channelHandle = '') {
  if (!info) {
    return false;
  }

  const channelId = (info.channelId || '').toLowerCase();
  const channelTitle = (info.channelTitle || '').toLowerCase();
  const normalizedHandle = (channelHandle || '').replace(/^@/, '').toLowerCase();

  for (const entry of entries) {
    if (!entry || !entry.value) {
      continue;
    }

    if (entry.type === 'id' && entry.value === channelId) {
      return true;
    }

    if (entry.type === 'name' && entry.value === channelTitle) {
      return true;
    }

    if (entry.type === 'handle' && normalizedHandle && entry.value === normalizedHandle) {
      return true;
    }
  }

  return false;
}

function pruneYouTubeVideoCache() {
  const MAX_CACHE_ENTRIES = 100;
  if (youtubeVideoCache.size <= MAX_CACHE_ENTRIES) {
    return;
  }

  const entries = Array.from(youtubeVideoCache.entries())
    .sort((a, b) => a[1].timestamp - b[1].timestamp);

  while (youtubeVideoCache.size > MAX_CACHE_ENTRIES && entries.length) {
    const [videoId] = entries.shift();
    youtubeVideoCache.delete(videoId);
  }
}

function pruneYouTubeChannelCache() {
  const MAX_CACHE_ENTRIES = 200;
  if (youtubeChannelCache.size <= MAX_CACHE_ENTRIES) {
    return;
  }

  const entries = Array.from(youtubeChannelCache.entries())
    .sort((a, b) => a[1].timestamp - b[1].timestamp);

  while (youtubeChannelCache.size > MAX_CACHE_ENTRIES && entries.length) {
    const [channelId] = entries.shift();
    youtubeChannelCache.delete(channelId);
  }
}
