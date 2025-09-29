'use strict';

const OVERLAY_ID = 'maxprod-blocked-overlay';
let blockedChannelSet = new Set();
let latestChannel = null;
let pendingCheck = false;

init();

function init() {
  syncBlockedChannels();
  observeNavigationChanges();
  chrome.storage.onChanged.addListener(handleStorageChanges);
}

function handleStorageChanges(changes, areaName) {
  if (areaName !== 'sync' || !changes.blockedChannels) {
    return;
  }
  const nextChannels = changes.blockedChannels.newValue || [];
  updateBlockedChannelSet(nextChannels);
  scheduleCheck();
}

function observeNavigationChanges() {
  document.addEventListener('yt-navigate-finish', scheduleCheck, { passive: true });
  const observer = new MutationObserver(scheduleCheck);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('yt-page-data-updated', scheduleCheck, { passive: true });
  scheduleCheck();
}

function scheduleCheck() {
  if (pendingCheck) {
    return;
  }
  pendingCheck = true;
  setTimeout(() => {
    pendingCheck = false;
    checkCurrentVideo();
  }, 250);
}

async function syncBlockedChannels() {
  try {
    const { blockedChannels = [] } = await chrome.storage.sync.get({ blockedChannels: [] });
    updateBlockedChannelSet(blockedChannels);
    scheduleCheck();
  } catch (error) {
    console.error('[Maxprod] Failed to load blocked channels', error);
  }
}

function updateBlockedChannelSet(channels) {
  blockedChannelSet = new Set(channels.map(normalizeChannelName).filter(Boolean));
}

function checkCurrentVideo() {
  const channelName = extractChannelName();
  if (!channelName) {
    latestChannel = null;
    removeOverlay();
    return;
  }

  const normalized = normalizeChannelName(channelName);
  if (normalized === latestChannel) {
    return;
  }
  latestChannel = normalized;

  if (blockedChannelSet.has(normalized)) {
    applyOverlay(channelName);
  } else {
    removeOverlay();
  }
}

function extractChannelName() {
  const selectors = [
    '#owner-name a',
    'ytd-channel-name #text',
    'ytd-channel-name a',
    'ytd-video-owner-renderer #text-container a'
  ];

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element && element.textContent) {
      const value = element.textContent.trim();
      if (value) {
        return value;
      }
    }
  }
  return null;
}

function applyOverlay(channelName) {
  const player = document.querySelector('#player');
  if (!player) {
    return;
  }

  const overlay = document.getElementById(OVERLAY_ID) || createOverlay();
  overlay.innerHTML = `
    <div class="maxprod-overlay-content">
      <h1>Blocked channel</h1>
      <p><strong>${escapeHtml(channelName)}</strong> is on your blocklist.</p>
      <p>Take a quick break or pick another video.</p>
    </div>
  `;

  if (!overlay.parentElement) {
    ensurePositioned(player);
    player.appendChild(overlay);
  }

  pauseVideo(player);
}

function createOverlay() {
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.position = 'absolute';
  overlay.style.inset = '0';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.background = 'rgba(0, 0, 0, 0.92)';
  overlay.style.color = '#fff';
  overlay.style.textAlign = 'center';
  overlay.style.padding = '2rem';
  overlay.style.zIndex = '99999';
  overlay.style.fontFamily = 'Roboto, Arial, sans-serif';
  overlay.style.backdropFilter = 'blur(2px)';
  overlay.style.boxSizing = 'border-box';
  return overlay;
}

function removeOverlay() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay && overlay.parentElement) {
    overlay.parentElement.removeChild(overlay);
  }
}

function ensurePositioned(element) {
  const style = window.getComputedStyle(element);
  if (style.position === 'static') {
    element.style.position = 'relative';
  }
}

function pauseVideo(player) {
  const video = player.querySelector('video');
  if (!video) {
    return;
  }
  video.pause();
}

function escapeHtml(input) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return input.replace(/[&<>"']/g, (char) => map[char] || char);
}

function normalizeChannelName(name) {
  return name ? name.trim().toLowerCase() : '';
}
