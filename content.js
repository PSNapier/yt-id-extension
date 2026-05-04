(function () {
  "use strict";

  /** YouTube channel IDs: UC + 22 chars (base64-like). */
  const CHANNEL_ID_RE = /^UC[\w-]{22}$/;

  const TOAST_ID = "yt-id-extension-toast";
  const DEBOUNCE_MS = 200;
  const POLL_MS = 600;

  let debounceTimer = 0;
  let pollTimer = 0;
  let lastNavigationKey = "";

  function isChannelId(s) {
    return typeof s === "string" && CHANNEL_ID_RE.test(s);
  }

  function navigationKey() {
    return `${location.pathname}${location.search}`;
  }

  function parseChannelIdFromHref(href) {
    if (!href || typeof href !== "string") return null;
    try {
      const u = new URL(href, location.origin);
      const m = u.pathname.match(/\/channel\/(UC[\w-]{22})\b/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  function extractFromCurrentUrl() {
    const m = location.pathname.match(/^\/channel\/(UC[\w-]{22})\/?$/);
    return m ? m[1] : null;
  }

  /**
   * Prefer the uploader / page owner via scoped DOM (avoids recommended channels).
   */
  function extractFromDom() {
    const urlId = extractFromCurrentUrl();
    if (urlId) return urlId;

    if (location.pathname === "/watch" || location.pathname.startsWith("/watch")) {
      const owner =
        document.querySelector(
          "ytd-video-owner-renderer a[href*='/channel/UC']"
        ) ||
        document.querySelector("ytd-video-owner-renderer a[href*='/channel/']");
      if (owner) {
        const id = parseChannelIdFromHref(owner.getAttribute("href"));
        if (id) return id;
      }
    }

    const headerLink =
      document.querySelector(
        "ytd-c4-tab-header-renderer a[href*='/channel/UC']"
      ) ||
      document.querySelector("ytd-channel-header a[href*='/channel/UC']") ||
      document.querySelector(
        "yt-page-header-renderer a[href*='/channel/UC']"
      );

    if (headerLink) {
      const id = parseChannelIdFromHref(headerLink.getAttribute("href"));
      if (id) return id;
    }

    return null;
  }

  function extractYtInitialDataObject() {
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const t = script.textContent;
      if (!t || t.indexOf("ytInitialData") === -1) continue;

      const marker = /ytInitialData\s*=/.exec(t);
      if (!marker) continue;

      const start = t.indexOf("{", marker.index);
      if (start === -1) continue;

      let depth = 0;
      for (let i = start; i < t.length; i++) {
        const c = t[i];
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            const jsonStr = t.slice(start, i + 1);
            try {
              return JSON.parse(jsonStr);
            } catch {
              break;
            }
          }
        }
      }
    }
    return null;
  }

  function extractVideoOwnerChannelId(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const id = extractVideoOwnerChannelId(item);
        if (id) return id;
      }
      return null;
    }

    const vor = obj.videoOwnerRenderer;
    if (vor && vor.navigationEndpoint && vor.navigationEndpoint.browseEndpoint) {
      const bid = vor.navigationEndpoint.browseEndpoint.browseId;
      if (isChannelId(bid)) return bid;
    }

    for (const k of Object.keys(obj)) {
      const id = extractVideoOwnerChannelId(obj[k]);
      if (id) return id;
    }
    return null;
  }

  function extractChannelMetadataId(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const id = extractChannelMetadataId(item);
        if (id) return id;
      }
      return null;
    }

    const cm = obj.channelMetadataRenderer;
    if (cm && isChannelId(cm.externalId)) return cm.externalId;

    for (const k of Object.keys(obj)) {
      const id = extractChannelMetadataId(obj[k]);
      if (id) return id;
    }
    return null;
  }

  function collectChannelIdsFromTree(obj, out, depth, maxDepth) {
    if (depth > maxDepth || obj == null) return;
    if (typeof obj === "string") {
      if (isChannelId(obj)) out.add(obj);
      return;
    }
    if (typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      for (const item of obj) collectChannelIdsFromTree(item, out, depth + 1, maxDepth);
      return;
    }

    for (const k of Object.keys(obj)) {
      collectChannelIdsFromTree(obj[k], out, depth + 1, maxDepth);
    }
  }

  function extractFromJson(data, routeHint) {
    if (!data) return null;

    if (routeHint === "watch") {
      const owner = extractVideoOwnerChannelId(data);
      if (owner) return owner;
    }

    const meta = extractChannelMetadataId(data);
    if (meta) return meta;

    const candidates = new Set();
    collectChannelIdsFromTree(data, candidates, 0, 28);

    if (candidates.size === 1) return candidates.values().next().value;

    if (candidates.size > 1) {
      const domId = extractFromDom();
      if (domId && candidates.has(domId)) return domId;
      const owner = extractVideoOwnerChannelId(data);
      if (owner && candidates.has(owner)) return owner;
      const meta2 = extractChannelMetadataId(data);
      if (meta2 && candidates.has(meta2)) return meta2;
    }

    return candidates.size ? pickStableId(candidates) : null;
  }

  function pickStableId(set) {
    return [...set].sort()[0];
  }

  function routeHint() {
    const p = location.pathname;
    if (p === "/watch" || p.startsWith("/watch")) return "watch";
    if (
      p.startsWith("/channel/") ||
      p.startsWith("/@") ||
      p.startsWith("/c/") ||
      p.startsWith("/user/")
    ) {
      return "channel";
    }
    return "other";
  }

  function shouldAttemptExtraction() {
    const h = routeHint();
    return h === "watch" || h === "channel";
  }

  function getChannelId() {
    const fromUrl = extractFromCurrentUrl();
    if (fromUrl) return fromUrl;

    const dom = extractFromDom();
    if (dom) return dom;

    const data = extractYtInitialDataObject();
    const hint = routeHint();
    return extractFromJson(data, hint);
  }

  function ensureToast() {
    let el = document.getElementById(TOAST_ID);
    if (el) return el;

    el = document.createElement("aside");
    el.id = TOAST_ID;
    el.setAttribute("aria-live", "polite");
    el.innerHTML =
      '<span class="yt-id-extension-toast__label">Channel ID</span>' +
      '<span class="yt-id-extension-toast__value"></span>' +
      '<button type="button" class="yt-id-extension-toast__copy" hidden>Copy</button>';

    document.documentElement.appendChild(el);

    const btn = el.querySelector(".yt-id-extension-toast__copy");
    const valueEl = el.querySelector(".yt-id-extension-toast__value");

    btn.addEventListener("click", () => {
      const text = valueEl.textContent.trim();
      if (!text || text.indexOf("Could not") !== -1) return;
      navigator.clipboard.writeText(text).then(
        () => {
          const prev = btn.textContent;
          btn.textContent = "Copied";
          setTimeout(() => {
            btn.textContent = prev;
          }, 1500);
        },
        () => {}
      );
    });

    return el;
  }

  function updateToast() {
    const toast = ensureToast();
    const valueEl = toast.querySelector(".yt-id-extension-toast__value");
    const copyBtn = toast.querySelector(".yt-id-extension-toast__copy");

    if (!shouldAttemptExtraction()) {
      toast.classList.add("yt-id-extension-toast--muted");
      valueEl.textContent = "Not shown on this page type.";
      copyBtn.hidden = true;
      return;
    }

    const id = getChannelId();
    if (id) {
      toast.classList.remove("yt-id-extension-toast--muted");
      valueEl.textContent = id;
      copyBtn.hidden = false;
    } else {
      toast.classList.add("yt-id-extension-toast--muted");
      valueEl.textContent = "Could not detect channel ID.";
      copyBtn.hidden = true;
    }
  }

  function scheduleUpdate() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = 0;
      updateToast();
    }, DEBOUNCE_MS);
  }

  function onNavigationMaybe() {
    const key = navigationKey();
    if (key === lastNavigationKey) return;
    lastNavigationKey = key;
    scheduleUpdate();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = window.setInterval(() => {
      if (navigationKey() !== lastNavigationKey) onNavigationMaybe();
    }, POLL_MS);
  }

  function init() {
    lastNavigationKey = navigationKey();
    ensureToast();
    updateToast();

    document.addEventListener("yt-navigate-finish", onNavigationMaybe, true);

    startPolling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
