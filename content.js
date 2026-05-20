(() => {
  'use strict';

  /**
   * Instagram (SPA) sometimes injects a "Log in / Giriş yap" modal and
   * locks scroll via inline styles and/or special classes on <html>/<body>.
   *
   * Goals:
   * - Detect and remove login modal containers from the DOM.
   * - Keep page scroll enabled by overriding scroll-lock CSS with !important.
   * - Observe DOM changes efficiently (low CPU) for SPA/dynamic injections.
   *
   * Notes:
   * - We avoid tight loops. We batch mutations and run a single "sweep" per frame.
   * - We prefer broad but safe heuristics: remove only obvious login prompts/modals.
   */

  // --- Config (tuneable, low-risk defaults) ---------------------------------

  const TEXT_KEYWORDS = [
    // Turkish
    'giriş yap',
    'giris yap',
    'oturum aç',
    'oturum ac',
    'kaydol',
    // English
    'log in',
    'login',
    'sign up',
    'sign in'
  ];

  // Common containers/overlays used by IG; role="presentation" is frequently used.
  const MODAL_CANDIDATE_SELECTORS = [
    'div[role="presentation"]',
    'div[role="dialog"]',
    '[aria-modal="true"]'
  ].join(',');

  const MAX_TEXT_SCAN_CHARS = 3500; // Prevent expensive textContent scans on huge nodes.

  // Auth/login-like paths we want to prevent (SPA + hard redirects safety net).
  const BLOCK_PATH_RE =
    /^\/(accounts\/login\/?|accounts\/signup\/?|challenge\/?|login\/?|auth\/?|oauth\/?)/i;

  // --- Utilities -------------------------------------------------------------

  /** Lowercase + collapse whitespace for resilient keyword matching. */
  function normalizeText(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function nodeTextMayContainKeywords(node) {
    if (!node) return false;
    let text = '';
    try {
      text = node.textContent || '';
    } catch {
      return false;
    }
    if (!text) return false;
    if (text.length > MAX_TEXT_SCAN_CHARS) {
      text = text.slice(0, MAX_TEXT_SCAN_CHARS);
    }
    const t = normalizeText(text);
    return TEXT_KEYWORDS.some((k) => t.includes(k));
  }

  function isElement(el) {
    return el && el.nodeType === Node.ELEMENT_NODE;
  }

  function isBlockedAuthLocation(urlLike) {
    try {
      const u = new URL(String(urlLike), location.origin);
      if (u.origin !== location.origin) return false;
      return BLOCK_PATH_RE.test(u.pathname);
    } catch {
      return false;
    }
  }

  function safeSendUrlToBackground(url) {
    // content_scripts can message the service worker (no extra permissions needed)
    try {
      chrome.runtime?.sendMessage?.({ type: 'IG_URL_UPDATE', url: String(url) });
    } catch {
      // ignore (e.g. chrome not available in some environments)
    }
  }

  /**
   * Identify a likely login modal root:
   * - role="presentation"/dialog or aria-modal
   * - and contains log in/sign up text cues
   * - and looks like an overlay (often fixed/absolute with high z-index)
   */
  function isLikelyLoginModal(el) {
    if (!isElement(el)) return false;

    // Strong signal: contains "log in" / "giriş yap" etc.
    if (!nodeTextMayContainKeywords(el)) return false;

    // Extra safety: overlay-ish layout (not always accessible, but helps avoid false positives).
    let cs;
    try {
      cs = window.getComputedStyle(el);
    } catch {
      cs = null;
    }
    if (cs) {
      const pos = cs.position;
      const zi = Number.parseInt(cs.zIndex || '0', 10);
      const overlayLike =
        pos === 'fixed' || pos === 'sticky' || (pos === 'absolute' && zi >= 10) || zi >= 100;
      if (!overlayLike) {
        // If it's not overlay-like, it still might be a container higher up; allow via attributes.
        const hasModalAttrs =
          el.getAttribute('role') === 'presentation' ||
          el.getAttribute('role') === 'dialog' ||
          el.getAttribute('aria-modal') === 'true';
        if (!hasModalAttrs) return false;
      }
    }

    return true;
  }

  function removeElement(el) {
    try {
      el.remove();
      return true;
    } catch {
      // Fallback for older DOMs (rare in Chrome, but harmless).
      try {
        if (el.parentNode) el.parentNode.removeChild(el);
        return true;
      } catch {
        return false;
      }
    }
  }

  // --- Scroll lock override --------------------------------------------------

  const STYLE_ID = 'ig-scroll-unlock-style';

  function ensureScrollOverrideStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      /* Keep scroll enabled even if IG applies scroll-lock styles */
      html, body {
        overflow: auto !important;
        overflow-x: hidden !important;
        position: static !important;
        height: auto !important;
        max-height: none !important;
        overscroll-behavior: auto !important;
        touch-action: auto !important;
      }

      /* Unlock common UI interaction locks on media */
      img, video, a {
        pointer-events: auto !important;
        user-select: auto !important;
        -webkit-user-select: auto !important;
      }

      /* Some overlays rely on "no select" / "no callout" behavior */
      * {
        -webkit-touch-callout: default !important;
      }
    `;
    (document.documentElement || document.head || document).appendChild(style);
  }

  function unlockScrollInline() {
    // Remove common inline locks on <html>/<body>.
    const targets = [document.documentElement, document.body].filter(Boolean);
    for (const el of targets) {
      try {
        el.style.setProperty('overflow', 'auto', 'important');
        el.style.setProperty('position', 'static', 'important');
        el.style.setProperty('height', 'auto', 'important');
        el.style.setProperty('max-height', 'none', 'important');
      } catch {
        // ignore
      }
    }
  }

  // --- Modal removal ---------------------------------------------------------

  /**
   * Find & remove obvious login modal roots.
   * Approach:
   * - Query typical modal-ish selectors (role presentation/dialog/aria-modal).
   * - Filter with keyword heuristics.
   * - Remove the best candidates.
   */
  function removeLoginModals() {
    const doc = document;
    if (!doc || !doc.documentElement) return 0;

    const candidates = doc.querySelectorAll(MODAL_CANDIDATE_SELECTORS);
    let removed = 0;

    for (const el of candidates) {
      if (!isElement(el)) continue;

      // Sometimes the keyword is inside a nested child; check el first, else check a few levels up.
      let target = null;
      if (isLikelyLoginModal(el)) {
        target = el;
      } else {
        const parent = el.parentElement;
        const grand = parent?.parentElement;
        if (parent && isLikelyLoginModal(parent)) target = parent;
        else if (grand && isLikelyLoginModal(grand)) target = grand;
      }

      if (target && removeElement(target)) removed++;
    }

    // Secondary heuristic: sometimes IG uses a generic full-screen overlay without roles.
    // We keep this conservative: only remove if it contains strong keywords and is fixed + large.
    if (removed === 0) {
      const maybeOverlays = doc.querySelectorAll('div');
      let scanned = 0;
      for (const el of maybeOverlays) {
        // Bound work: don't scan too many divs in one sweep.
        if (++scanned > 120) break;
        if (!nodeTextMayContainKeywords(el)) continue;
        let cs;
        try {
          cs = window.getComputedStyle(el);
        } catch {
          cs = null;
        }
        if (!cs) continue;
        if (cs.position !== 'fixed') continue;
        const rect = el.getBoundingClientRect();
        const coversLargeArea =
          rect.width >= Math.min(600, window.innerWidth * 0.6) &&
          rect.height >= Math.min(400, window.innerHeight * 0.5);
        if (!coversLargeArea) continue;

        if (removeElement(el)) {
          removed++;
          break; // one is enough; next sweep will catch others
        }
      }
    }

    return removed;
  }

  // --- Media interaction unlock (right click / middle click / overlays) ------

  const POST_LINK_SELECTORS = [
    'a[href^="/p/"]',
    'a[href^="/reel/"]',
    'a[href^="/tv/"]'
  ].join(',');

  function setImportantStyle(el, prop, value) {
    try {
      el.style.setProperty(prop, value, 'important');
    } catch {
      // ignore
    }
  }

  function rectCovers(a, b) {
    // Does rect A cover most of rect B?
    const iw = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const ih = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (iw <= 0 || ih <= 0) return false;
    const inter = iw * ih;
    const areaB = Math.max(1, b.width * b.height);
    return inter / areaB >= 0.75;
  }

  function looksLikeTransparentClickShield(el, mediaRect) {
    if (!isElement(el)) return false;
    let cs;
    try {
      cs = window.getComputedStyle(el);
    } catch {
      cs = null;
    }
    if (!cs) return false;

    // Overlay-like positioning
    if (!(cs.position === 'absolute' || cs.position === 'fixed')) return false;
    if (cs.pointerEvents === 'none') return false; // already not blocking
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;

    // Transparent / near-transparent background is common for shields
    const bg = cs.backgroundColor || '';
    const transparentLike = bg === 'transparent' || bg.endsWith(', 0)') || bg === 'rgba(0, 0, 0, 0)';

    // Covers the media area
    const r = el.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return false;
    if (!rectCovers(r, mediaRect)) return false;

    // Conservative: either transparent-like OR no meaningful content
    const noText = !normalizeText(el.textContent || '');
    return transparentLike || noText;
  }

  function unlockMediaContainer(container) {
    if (!isElement(container)) return 0;

    // If IG applied pointer-events/user-select locks to the container, override.
    setImportantStyle(container, 'pointer-events', 'auto');
    setImportantStyle(container, 'user-select', 'auto');
    setImportantStyle(container, '-webkit-user-select', 'auto');

    const media = container.querySelector('img, video');
    if (!media) return 0;

    setImportantStyle(media, 'pointer-events', 'auto');
    setImportantStyle(media, 'user-select', 'auto');
    setImportantStyle(media, '-webkit-user-select', 'auto');

    const mediaRect = media.getBoundingClientRect();
    if (mediaRect.width < 10 || mediaRect.height < 10) return 0;

    // Find overlay children that are likely shields.
    // Bound work: do not scan too deep.
    const children = container.querySelectorAll('div, span');
    let changed = 0;
    let scanned = 0;

    for (const el of children) {
      if (++scanned > 80) break;
      if (!isElement(el) || el === media) continue;
      if (!looksLikeTransparentClickShield(el, mediaRect)) continue;

      // Prefer neutralizing rather than removing to reduce layout risk.
      setImportantStyle(el, 'pointer-events', 'none');
      changed++;
    }

    return changed;
  }

  function ensurePostAnchorsWork() {
    // Ensure post anchors can receive middle-click and have pointer-events enabled.
    const links = document.querySelectorAll(POST_LINK_SELECTORS);
    let touched = 0;
    let scanned = 0;
    for (const a of links) {
      if (++scanned > 200) break;
      if (!isElement(a)) continue;
      if (!a.getAttribute('href')) continue;
      setImportantStyle(a, 'pointer-events', 'auto');
      touched++;
    }
    return touched;
  }

  function unlockMediaInteractions() {
    const containers = document.querySelectorAll('article, main, section');
    let changed = 0;
    let scanned = 0;

    for (const c of containers) {
      if (++scanned > 80) break;
      if (!isElement(c)) continue;

      // Prefer processing around known post anchors first.
      const links = c.querySelectorAll(POST_LINK_SELECTORS);
      let linkScanned = 0;
      for (const a of links) {
        if (++linkScanned > 20) break;
        const container = a.closest('article') || a.parentElement || c;
        changed += unlockMediaContainer(container);
      }
    }

    changed += ensurePostAnchorsWork();
    return changed;
  }

  function installClickGuards() {
    // Prevent IG from cancelling context menu / middle click on media and post links.
    // We stop propagation early (capture) but do NOT preventDefault.
    const stopIfRelevant = (e) => {
      const t = /** @type {Element|null} */ (e.target && e.target.nodeType === 1 ? e.target : null);
      if (!t) return;

      // If event originated on a media element or inside a post link, we let browser defaults win.
      const inPostLink = !!t.closest?.(POST_LINK_SELECTORS);
      const isMedia = t.matches?.('img, video') || !!t.closest?.('img, video');

      if (!inPostLink && !isMedia) return;

      // Do not block left-click navigation; only unlock right-click & middle-click behaviors.
      if (e.type === 'auxclick') {
        // button: 1 = middle
        if (e.button !== 1) return;
      }

      e.stopPropagation();
      // stopImmediatePropagation is stronger; helps when IG installs multiple capture handlers.
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    };

    window.addEventListener('contextmenu', stopIfRelevant, true);
    window.addEventListener('auxclick', stopIfRelevant, true);
    window.addEventListener('mousedown', stopIfRelevant, true);
  }

  // --- Efficient SPA watching ------------------------------------------------

  let scheduled = false;
  let lastRun = 0;
  const MIN_INTERVAL_MS = 120; // Avoid running too frequently under heavy mutation storms.

  function scheduleSweep(reason) {
    if (scheduled) return;
    scheduled = true;

    // Use rAF to align with rendering; fall back to setTimeout for early document phases.
    const run = () => {
      scheduled = false;
      const now = performance.now();
      if (now - lastRun < MIN_INTERVAL_MS) {
        // Re-schedule once if we were called too soon.
        scheduleSweep('throttled');
        return;
      }
      lastRun = now;

      // Keep these in a single sweep to minimize layout recalcs.
      ensureScrollOverrideStyle();
      unlockScrollInline();
      removeLoginModals();
      unlockMediaInteractions();

      // SPA may attempt to move user into auth/login routes; push back to last good URL.
      enforceSafeLocation();
    };

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  // --- SPA redirect prevention (History API) --------------------------------

  let lastGoodUrl = location.href;
  let lastGoodRecordedAt = 0;
  const MIN_GOOD_URL_INTERVAL_MS = 200;

  function recordGoodUrl(url) {
    if (!url || isBlockedAuthLocation(url)) return;
    const now = performance.now();
    if (now - lastGoodRecordedAt < MIN_GOOD_URL_INTERVAL_MS) return;
    lastGoodRecordedAt = now;
    lastGoodUrl = String(url);
    safeSendUrlToBackground(lastGoodUrl);
  }

  function restoreToLastGoodUrl() {
    if (!lastGoodUrl || lastGoodUrl === location.href) return;
    try {
      history.replaceState(history.state, '', lastGoodUrl);
      // Some cases need a direct assignment to force location.
      if (location.href !== lastGoodUrl) {
        location.href = lastGoodUrl;
      }
    } catch {
      try {
        location.href = lastGoodUrl;
      } catch {
        // ignore
      }
    }
  }

  function enforceSafeLocation() {
    if (isBlockedAuthLocation(location.href)) {
      restoreToLastGoodUrl();
      return;
    }
    recordGoodUrl(location.href);
  }

  function installHistoryGuards() {
    // Record the initial URL (if it's safe).
    recordGoodUrl(location.href);

    const origPushState = history.pushState.bind(history);
    const origReplaceState = history.replaceState.bind(history);

    function guardedNavigate(originalFn, args) {
      const urlArg = args?.[2];
      if (urlArg && isBlockedAuthLocation(urlArg)) {
        // Block SPA attempt to push/replace into login/auth routes.
        restoreToLastGoodUrl();
        return;
      }
      const result = originalFn(...args);
      // Schedule a safe check because IG sometimes mutates URL then DOM.
      scheduleSweep('history');
      return result;
    }

    history.pushState = function (...args) {
      return guardedNavigate(origPushState, args);
    };

    history.replaceState = function (...args) {
      return guardedNavigate(origReplaceState, args);
    };

    window.addEventListener(
      'popstate',
      () => {
        scheduleSweep('popstate');
      },
      { capture: true }
    );
  }

  function startObserver() {
    const root = document.documentElement;
    if (!root) return;

    const observer = new MutationObserver((mutations) => {
      // We don't analyze each mutation (expensive); just react once per batch.
      // But we can short-circuit if nothing relevant happened.
      for (const m of mutations) {
        if (m.type === 'childList' && (m.addedNodes?.length || m.removedNodes?.length)) {
          scheduleSweep('childList');
          return;
        }
        if (m.type === 'attributes') {
          // Scroll-lock styles often come via attributes on html/body.
          if (m.target === document.body || m.target === document.documentElement) {
            scheduleSweep('attr');
            return;
          }
        }
      }
      scheduleSweep('mutations');
    });

    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'aria-hidden']
    });

    // Also re-run on scroll attempts (user interactions) without heavy frequency.
    window.addEventListener(
      'wheel',
      () => scheduleSweep('wheel'),
      { passive: true, capture: true }
    );
    window.addEventListener(
      'touchmove',
      () => scheduleSweep('touchmove'),
      { passive: true, capture: true }
    );
  }

  // --- Boot -----------------------------------------------------------------

  // Early sweep (document_start) to prevent initial lock.
  scheduleSweep('boot');

  // Guard SPA history-based "redirects" ASAP.
  installHistoryGuards();
  installClickGuards();

  // Ensure we start observing as soon as possible.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      startObserver();
      scheduleSweep('domcontentloaded');
    }, { once: true });
  } else {
    startObserver();
    scheduleSweep('ready');
  }
})();

