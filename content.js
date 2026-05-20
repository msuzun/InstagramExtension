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
    };

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
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

