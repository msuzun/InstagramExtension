/* global chrome */

/**
 * Background (MV3 service worker)
 *
 * Purpose:
 * - Detect hard redirects/navigations to Instagram login/auth pages.
 * - Keep the user on the last known "valid" Instagram URL (profile/post/etc).
 *
 * Why webNavigation (instead of declarativeNetRequest):
 * - Blocking/redirecting with DNR is static by design; here we want to restore the
 *   *previous per-tab* URL, which is dynamic.
 * - webNavigation can't "cancel" a navigation, but we can detect it early and
 *   immediately drive the tab back to the last good URL.
 */

const IG_HOST_RE = /(^|\.)instagram\.com$/i;

// URLs we consider "auth/login" targets that should be avoided when not logged-in.
// Kept intentionally broad; adjust as needed for new IG flows.
const BLOCK_PATH_RE =
  /^\/(accounts\/login\/?|accounts\/signup\/?|challenge\/?|login\/?|auth\/?|oauth\/?)/i;

// In-memory per-tab state (service worker lifetime). This is usually enough.
// If you want persistence across SW restarts, move this to chrome.storage.session.
/** @type {Map<number, { lastGoodUrl?: string, lastSeenUrl?: string, lastActionAt?: number }>} */
const tabState = new Map();

function isInstagramUrl(urlString) {
  try {
    const u = new URL(urlString);
    return u.protocol === 'https:' && IG_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

function isBlockedInstagramAuthUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== 'https:' || !IG_HOST_RE.test(u.hostname)) return false;
    return BLOCK_PATH_RE.test(u.pathname);
  } catch {
    return false;
  }
}

function getOrInitState(tabId) {
  let s = tabState.get(tabId);
  if (!s) {
    s = {};
    tabState.set(tabId, s);
  }
  return s;
}

function setLastGoodUrl(tabId, url) {
  if (!url || !isInstagramUrl(url) || isBlockedInstagramAuthUrl(url)) return;
  const s = getOrInitState(tabId);
  s.lastGoodUrl = url;
  s.lastSeenUrl = url;
}

async function restoreLastGoodUrl(tabId, blockedUrl) {
  const s = getOrInitState(tabId);
  const now = Date.now();

  // Prevent rapid oscillation loops.
  if (s.lastActionAt && now - s.lastActionAt < 750) return;
  s.lastActionAt = now;

  const fallback = 'https://www.instagram.com/';
  const target = s.lastGoodUrl && isInstagramUrl(s.lastGoodUrl) ? s.lastGoodUrl : fallback;

  // If the lastGoodUrl is effectively the same as the blocked destination, use fallback.
  if (target === blockedUrl) {
    await chrome.tabs.update(tabId, { url: fallback });
    return;
  }

  await chrome.tabs.update(tabId, { url: target });
}

// Receive updates from content script for SPA navigations.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'IG_URL_UPDATE') return;
  const tabId = sender?.tab?.id;
  const url = msg?.url;
  if (typeof tabId !== 'number' || typeof url !== 'string') return;
  setLastGoodUrl(tabId, url);
});

// Track normal navigations and detect auth/login redirects.
chrome.webNavigation.onCommitted.addListener(async (details) => {
  // main frame only
  if (details.frameId !== 0) return;
  const { tabId, url } = details;
  if (typeof tabId !== 'number' || typeof url !== 'string') return;

  if (!isInstagramUrl(url)) return;

  const s = getOrInitState(tabId);
  s.lastSeenUrl = url;

  if (isBlockedInstagramAuthUrl(url)) {
    await restoreLastGoodUrl(tabId, url);
    return;
  }

  // Non-auth IG URL is a valid candidate.
  setLastGoodUrl(tabId, url);
});

// More eager detection (some redirects happen quickly).
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const { tabId, url } = details;
  if (typeof tabId !== 'number' || typeof url !== 'string') return;
  if (!isInstagramUrl(url)) return;

  if (isBlockedInstagramAuthUrl(url)) {
    await restoreLastGoodUrl(tabId, url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

