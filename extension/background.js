'use strict';

const DEFAULT_STATE = {
  blockedHosts: [],
  allowedSubreddits: [],
  blockReddit: false,
  extensionEnabled: true
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

async function initializeState() {
  const stored = await chrome.storage.sync.get(DEFAULT_STATE);
  const updates = {};
  for (const key of Object.keys(DEFAULT_STATE)) {
    const value = stored[key];
    if (value === undefined) {
      updates[key] = DEFAULT_STATE[key];
    }
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
    await chrome.storage.sync.remove('blockedChannels');
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

          const blockedKeys = new Set([
            'ArrowUp',
            'ArrowDown',
            'ArrowLeft',
            'ArrowRight',
            'PageUp',
            'PageDown',
            'Home',
            'End',
            ' ',
            'Space',
            'Spacebar'
          ]);

          const state = {
            count: 0,
            blockedKeys,
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
              keydown: (event) => {
                if (
                  event.defaultPrevented ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.altKey
                ) {
                  return;
                }

                if (blockedKeys.has(event.key) || blockedKeys.has(event.code)) {
                  event.preventDefault();
                }
              }
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
            window.addEventListener('keydown', state.handlers.keydown, false);
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
          window.removeEventListener('keydown', state.handlers.keydown);

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
