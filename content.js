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

      /* Download button injected by the extension */
      .igdl-btn {
        position: absolute !important;
        top: 8px !important;
        right: 8px !important;
        z-index: 2147483646 !important;
        width: 30px !important;
        height: 30px !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        border-radius: 999px !important;
        background: rgba(0, 0, 0, 0.55) !important;
        color: #fff !important;
        border: 1px solid rgba(255, 255, 255, 0.18) !important;
        cursor: pointer !important;
        pointer-events: auto !important;
        backdrop-filter: blur(8px) !important;
        -webkit-backdrop-filter: blur(8px) !important;
      }
      .igdl-btn:hover { background: rgba(0, 0, 0, 0.72) !important; }
      .igdl-btn:active { transform: scale(0.98) !important; }
      .igdl-btn svg { width: 16px !important; height: 16px !important; fill: currentColor !important; }

      /* Story Lightbox (extension UI) */
      .igstorylb-backdrop {
        position: fixed !important;
        inset: 0 !important;
        z-index: 2147483647 !important;
        background: rgba(0,0,0,0.78) !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        padding: 24px !important;
        box-sizing: border-box !important;
      }
      .igstorylb-panel {
        width: min(520px, 96vw) !important;
        height: min(860px, 92vh) !important;
        background: rgba(15, 15, 15, 0.92) !important;
        border: 1px solid rgba(255,255,255,0.12) !important;
        border-radius: 18px !important;
        overflow: hidden !important;
        box-shadow: 0 18px 60px rgba(0,0,0,0.45) !important;
        backdrop-filter: blur(10px) !important;
        -webkit-backdrop-filter: blur(10px) !important;
        display: grid !important;
        grid-template-rows: auto 1fr auto !important;
      }
      .igstorylb-header {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 12px !important;
        padding: 12px 12px 10px 14px !important;
        border-bottom: 1px solid rgba(255,255,255,0.10) !important;
        color: #fff !important;
        font: 600 14px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif !important;
      }
      .igstorylb-title { opacity: 0.92 !important; }
      .igstorylb-close {
        width: 34px !important;
        height: 34px !important;
        border-radius: 999px !important;
        background: rgba(255,255,255,0.10) !important;
        border: 1px solid rgba(255,255,255,0.14) !important;
        color: #fff !important;
        cursor: pointer !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
      }
      .igstorylb-close:hover { background: rgba(255,255,255,0.16) !important; }
      .igstorylb-body {
        position: relative !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        padding: 14px !important;
        box-sizing: border-box !important;
      }
      .igstorylb-media {
        width: 100% !important;
        height: 100% !important;
        border-radius: 14px !important;
        overflow: hidden !important;
        background: rgba(0,0,0,0.35) !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
      }
      .igstorylb-media img, .igstorylb-media video {
        width: 100% !important;
        height: 100% !important;
        object-fit: contain !important;
        background: #000 !important;
      }
      .igstorylb-footer {
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 10px !important;
        padding: 10px 12px 12px !important;
        border-top: 1px solid rgba(255,255,255,0.10) !important;
        color: rgba(255,255,255,0.86) !important;
        font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif !important;
      }
      .igstorylb-navbtn {
        width: 38px !important;
        height: 32px !important;
        border-radius: 10px !important;
        background: rgba(255,255,255,0.10) !important;
        border: 1px solid rgba(255,255,255,0.14) !important;
        color: #fff !important;
        cursor: pointer !important;
      }
      .igstorylb-navbtn:disabled { opacity: 0.38 !important; cursor: default !important; }
      .igstorylb-hint { opacity: 0.80 !important; }
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

  // --- Download button injection --------------------------------------------

  const DOWNLOAD_BTN_CLASS = 'igdl-btn';
  const DOWNLOAD_BTN_ATTR = 'data-igdl-btn';
  const POST_ROOT_ATTR = 'data-igdl-root';

  function isHttpUrl(url) {
    try {
      const u = new URL(String(url));
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function parseSrcsetBestUrl(srcset) {
    // Pick the largest width candidate.
    // srcset format: "url 320w, url2 640w, ..."
    const parts = String(srcset || '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    let best = { url: '', w: 0 };
    for (const p of parts) {
      const m = p.match(/^(\S+)\s+(\d+)w$/);
      if (!m) continue;
      const url = m[1];
      const w = Number.parseInt(m[2], 10);
      if (Number.isFinite(w) && w > best.w && isHttpUrl(url)) best = { url, w };
    }
    return best.url || '';
  }

  function getBestMediaUrlFromRoot(root) {
    if (!isElement(root)) return null;

    // Prefer video if present (reels/posts)
    const vid = root.querySelector('video');
    if (vid) {
      const url = vid.currentSrc || vid.src;
      if (url && isHttpUrl(url)) return { url, kind: 'video' };
    }

    // Find the "best" image by srcset width, then natural size fallback.
    const imgs = root.querySelectorAll('img');
    let best = { url: '', score: 0 };
    for (const img of imgs) {
      if (!img) continue;
      const fromSrcset = parseSrcsetBestUrl(img.getAttribute('srcset'));
      const url = fromSrcset || img.currentSrc || img.src || '';
      if (!url || !isHttpUrl(url)) continue;
      const nw = Number(img.naturalWidth || 0);
      const nh = Number(img.naturalHeight || 0);
      const score = Math.max(1, nw * nh);
      if (score > best.score) best = { url, score };
    }
    if (best.url) return { url: best.url, kind: 'image' };

    return null;
  }

  function findPostRootForButton(btnEl) {
    const root = btnEl.closest?.(`[${POST_ROOT_ATTR}="1"]`);
    if (root) return root;
    // Fallback: the closest article (IG posts) or main section.
    return btnEl.closest?.('article') || btnEl.closest?.('main') || document.body;
  }

  function inferShortcodeFromLink(root) {
    const a = root?.querySelector?.(POST_LINK_SELECTORS);
    const href = a?.getAttribute?.('href') || '';
    const m = href.match(/^\/(p|reel|tv)\/([^/]+)\//i);
    return m ? m[2] : '';
  }

  function sendDownloadRequest({ url, kind, shortcode }) {
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    const code = shortcode ? `_${shortcode}` : '';
    const base = `instagram_media${code}_${ts}_${kind}`;
    try {
      chrome.runtime?.sendMessage?.({
        type: 'IG_DOWNLOAD_MEDIA',
        url,
        filename: base
      });
    } catch {
      // ignore
    }
  }

  function injectDownloadButtonInto(root) {
    if (!isElement(root)) return 0;
    // Mark a post root so the button can reliably find context.
    root.setAttribute(POST_ROOT_ATTR, '1');

    if (root.querySelector?.(`.${DOWNLOAD_BTN_CLASS}[${DOWNLOAD_BTN_ATTR}="1"]`)) return 0;

    // Ensure the root can anchor absolute-positioned button.
    const cs = window.getComputedStyle(root);
    if (cs.position === 'static') {
      setImportantStyle(root, 'position', 'relative');
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = DOWNLOAD_BTN_CLASS;
    btn.setAttribute(DOWNLOAD_BTN_ATTR, '1');
    btn.setAttribute('aria-label', 'İndir');
    btn.title = 'İndir';

    // Minimal download icon (inline SVG)
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a1 1 0 0 1 1 1v9.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4.0 4a1 1 0 0 1-1.4 0l-4.0-4a1 1 0 1 1 1.4-1.42L11 13.59V4a1 1 0 0 1 1-1zM5 20a1 1 0 0 1-1-1v-2a1 1 0 1 1 2 0v1h12v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H5z"/></svg>';

    root.appendChild(btn);
    return 1;
  }

  function injectDownloadButtons() {
    // Find likely post/reel roots.
    // Bound work: keep scanning limited per sweep.
    const roots = new Set();

    // Primary: each article is usually a post in feed.
    document.querySelectorAll('article').forEach((a) => roots.add(a));

    // Secondary: single post/reel pages still contain an article; but as a fallback,
    // use containers around known post links.
    const links = document.querySelectorAll(POST_LINK_SELECTORS);
    let scanned = 0;
    for (const a of links) {
      if (++scanned > 120) break;
      const r = a.closest('article') || a.closest('main') || a.parentElement;
      if (r) roots.add(r);
    }

    let injected = 0;
    let processed = 0;
    for (const r of roots) {
      if (++processed > 80) break;
      injected += injectDownloadButtonInto(r);
    }
    return injected;
  }

  function installDownloadClickHandler() {
    document.addEventListener(
      'click',
      (e) => {
        const t = e.target && e.target.nodeType === 1 ? e.target : null;
        if (!t) return;
        const btn = t.closest?.(`.${DOWNLOAD_BTN_CLASS}[${DOWNLOAD_BTN_ATTR}="1"]`);
        if (!btn) return;

        // Keep click local (avoid triggering IG overlay navigation).
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

        const root = findPostRootForButton(btn);
        const best = getBestMediaUrlFromRoot(root);
        if (!best) return;

        const shortcode = inferShortcodeFromLink(root);
        sendDownloadRequest({ url: best.url, kind: best.kind, shortcode });
      },
      true
    );
  }

  // --- Story Lightbox (UI only) ---------------------------------------------

  /**
   * Important limitation:
   * - This extension UI can display story media URLs, but it does NOT implement any
   *   mechanism to bypass Instagram authentication/authorization or scrape private content.
   * - To show stories, you must provide an allowed/authorized source of story media URLs.
   *
   * Provide stories via one of these options:
   * - A user-provided endpoint you control (e.g. `https://your-domain/story?u=username`)
   * - A compliant API/SDK flow that you’re authorized to use
   *
   * The provider below is a placeholder that returns an empty list by default.
   */

  const STORY = {
    backdrop: null,
    panel: null,
    mediaWrap: null,
    titleEl: null,
    idxEl: null,
    prevBtn: null,
    nextBtn: null,
    closeBtn: null,
    items: /** @type {Array<{ url: string, type: 'image'|'video' }>} */ ([]),
    index: 0,
    username: ''
  };

  function getUsernameFromProfilePage() {
    // Most reliable: path segment on profile pages: /{username}/
    const m = location.pathname.match(/^\/([a-z0-9._]+)\/$/i);
    if (m) return m[1];

    // Fallback: meta / og tags
    const og = document.querySelector('meta[property="og:url"]')?.getAttribute('content') || '';
    try {
      const u = new URL(og);
      const m2 = u.pathname.match(/^\/([a-z0-9._]+)\/$/i);
      return m2 ? m2[1] : '';
    } catch {
      return '';
    }
  }

  function looksLikeStoryRingElement(el) {
    if (!isElement(el)) return false;

    // Instagram story rings are typically around an avatar: img alt contains username or "profile picture"
    // We keep it heuristic, and restrict to profile pages to reduce false positives.
    if (!/^\/[a-z0-9._]+\/$/i.test(location.pathname)) return false;

    const avatarImg =
      el.querySelector?.('img') ||
      el.closest?.('header')?.querySelector?.('img') ||
      null;
    if (!avatarImg) return false;

    const alt = normalizeText(avatarImg.getAttribute('alt') || '');
    const hasAvatarAlt = alt.includes('profile') || alt.includes('profil') || alt.length > 0;
    if (!hasAvatarAlt) return false;

    // Visual cue: often clickable with cursor pointer
    let cs;
    try {
      cs = window.getComputedStyle(el);
    } catch {
      cs = null;
    }
    if (cs && cs.cursor && cs.cursor !== 'pointer') {
      // Still allow; not all rings set pointer on the outer node.
    }

    return true;
  }

  async function storyProviderFetch(username) {
    // Placeholder provider. Return [] by default.
    // Replace this with a compliant endpoint you control.
    // Example skeleton (disabled):
    // const res = await fetch(`https://your-domain.example/story?u=${encodeURIComponent(username)}`);
    // if (!res.ok) return [];
    // const data = await res.json();
    // return Array.isArray(data?.items) ? data.items : [];
    void username;
    return [];
  }

  function storyLightboxClose() {
    if (STORY.backdrop) {
      STORY.backdrop.remove();
      STORY.backdrop = null;
    }
    STORY.items = [];
    STORY.index = 0;
    STORY.username = '';
  }

  function storyLightboxRender() {
    if (!STORY.mediaWrap) return;
    STORY.mediaWrap.innerHTML = '';

    const item = STORY.items[STORY.index];
    if (!item) {
      const msg = document.createElement('div');
      msg.style.color = 'rgba(255,255,255,0.86)';
      msg.style.font = '600 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';
      msg.style.textAlign = 'center';
      msg.textContent = 'Bu kullanıcı için story bulunamadı (veya sağlayıcı yapılandırılmadı).';
      STORY.mediaWrap.appendChild(msg);
    } else if (item.type === 'video') {
      const v = document.createElement('video');
      v.src = item.url;
      v.controls = true;
      v.autoplay = true;
      v.playsInline = true;
      STORY.mediaWrap.appendChild(v);
    } else {
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = `story_${STORY.username}`;
      STORY.mediaWrap.appendChild(img);
    }

    if (STORY.titleEl) STORY.titleEl.textContent = STORY.username ? `Story • @${STORY.username}` : 'Story';
    if (STORY.idxEl) STORY.idxEl.textContent = STORY.items.length ? `${STORY.index + 1} / ${STORY.items.length}` : '';
    if (STORY.prevBtn) STORY.prevBtn.disabled = STORY.index <= 0;
    if (STORY.nextBtn) STORY.nextBtn.disabled = STORY.index >= STORY.items.length - 1;
  }

  function storyLightboxOpen({ username, items }) {
    storyLightboxClose();

    STORY.username = username;
    STORY.items = Array.isArray(items) ? items : [];
    STORY.index = 0;

    const backdrop = document.createElement('div');
    backdrop.className = 'igstorylb-backdrop';
    backdrop.tabIndex = -1;

    const panel = document.createElement('div');
    panel.className = 'igstorylb-panel';

    const header = document.createElement('div');
    header.className = 'igstorylb-header';
    const title = document.createElement('div');
    title.className = 'igstorylb-title';
    title.textContent = username ? `Story • @${username}` : 'Story';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'igstorylb-close';
    close.setAttribute('aria-label', 'Kapat');
    close.title = 'Kapat';
    close.textContent = '×';
    header.appendChild(title);
    header.appendChild(close);

    const body = document.createElement('div');
    body.className = 'igstorylb-body';
    const media = document.createElement('div');
    media.className = 'igstorylb-media';
    body.appendChild(media);

    const footer = document.createElement('div');
    footer.className = 'igstorylb-footer';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'igstorylb-navbtn';
    prev.textContent = '←';
    const hint = document.createElement('div');
    hint.className = 'igstorylb-hint';
    hint.textContent = '';
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'igstorylb-navbtn';
    next.textContent = '→';
    footer.appendChild(prev);
    footer.appendChild(hint);
    footer.appendChild(next);

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(footer);
    backdrop.appendChild(panel);
    document.documentElement.appendChild(backdrop);

    STORY.backdrop = backdrop;
    STORY.panel = panel;
    STORY.mediaWrap = media;
    STORY.titleEl = title;
    STORY.idxEl = hint;
    STORY.prevBtn = prev;
    STORY.nextBtn = next;
    STORY.closeBtn = close;

    const onClose = (e) => {
      e.preventDefault();
      e.stopPropagation();
      storyLightboxClose();
    };
    close.addEventListener('click', onClose);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) onClose(e);
    });
    window.addEventListener(
      'keydown',
      (e) => {
        if (!STORY.backdrop) return;
        if (e.key === 'Escape') storyLightboxClose();
        if (e.key === 'ArrowLeft') {
          if (STORY.index > 0) {
            STORY.index--;
            storyLightboxRender();
          }
        }
        if (e.key === 'ArrowRight') {
          if (STORY.index < STORY.items.length - 1) {
            STORY.index++;
            storyLightboxRender();
          }
        }
      },
      { capture: true }
    );

    prev.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (STORY.index > 0) {
        STORY.index--;
        storyLightboxRender();
      }
    });
    next.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (STORY.index < STORY.items.length - 1) {
        STORY.index++;
        storyLightboxRender();
      }
    });

    storyLightboxRender();
  }

  function installStoryRingInterceptor() {
    // Capture click at the top to prevent IG from triggering its own story viewer/login redirect.
    document.addEventListener(
      'click',
      async (e) => {
        const t = e.target && e.target.nodeType === 1 ? e.target : null;
        if (!t) return;

        // Only on profile pages.
        const username = getUsernameFromProfilePage();
        if (!username) return;

        // Heuristic: user clicked somewhere on/near avatar ring.
        const candidate =
          t.closest?.('header')?.querySelector?.('canvas, svg, img')?.closest?.('a, button, div') ||
          t.closest?.('header') ||
          t.closest?.('a, button, div');

        if (!candidate || !looksLikeStoryRingElement(candidate)) return;

        // Hard-stop the default behavior
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

        // Open UI immediately (no flicker), then load asynchronously.
        storyLightboxOpen({ username, items: [] });

        try {
          const items = await storyProviderFetch(username);
          // Validate items structure
          const safeItems = Array.isArray(items)
            ? items
                .filter((it) => it && typeof it.url === 'string' && isHttpUrl(it.url))
                .map((it) => ({
                  url: String(it.url),
                  type: it.type === 'video' ? 'video' : 'image'
                }))
            : [];
          STORY.items = safeItems;
          STORY.index = 0;
          storyLightboxRender();
        } catch {
          STORY.items = [];
          STORY.index = 0;
          storyLightboxRender();
        }
      },
      true
    );
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
      injectDownloadButtons();

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
  installDownloadClickHandler();
  installStoryRingInterceptor();

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

