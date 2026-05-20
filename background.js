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

function sanitizeFilenamePart(s) {
  return String(s || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 140);
}

function guessExtensionFromUrl(urlString) {
  try {
    const u = new URL(urlString);
    const m = u.pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    if (!m) return '';
    const ext = m[1];
    // Basic allow-list for sanity
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm', 'mov'].includes(ext)) return ext;
    return '';
  } catch {
    return '';
  }
}

async function downloadMedia({ url, filename }) {
  if (typeof url !== 'string' || !isInstagramUrl(url)) return;
  const ext = guessExtensionFromUrl(url);
  const safeName = sanitizeFilenamePart(filename || 'instagram_media');
  const finalName = ext && !safeName.toLowerCase().endsWith(`.${ext}`) ? `${safeName}.${ext}` : safeName;

  try {
    await chrome.downloads.download({
      url,
      filename: finalName,
      saveAs: false,
      conflictAction: 'uniquify'
    });
  } catch {
    // ignore: download may fail due to permissions/CORS/private content
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'IG_DOWNLOAD_MEDIA') return;
  const url = msg?.url;
  const filename = msg?.filename;
  downloadMedia({ url, filename });
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

