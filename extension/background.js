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
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existingRules.map((rule) => rule.id);

  if (!state.extensionEnabled) {
    if (removeRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    }
    return;
  }

  const rules = [];

  appendBlockedHostRules(rules, ensureArray(state.blockedHosts));

  if (state.blockReddit) {
    rules.push(createRedditBlockRule());
    appendAllowedSubredditRules(rules, ensureArray(state.allowedSubreddits));
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: rules
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
