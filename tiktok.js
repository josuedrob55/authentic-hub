// platforms/tiktok.js — self-contained Zen Mode engine for TikTok.
//
// SCOPE NOTE (unchanged from Sprint 1): this hides videos TikTok has itself
// labeled "AI-generated content" (creator toggle or C2PA auto-detection).
// It cannot catch AI content nobody labeled — TikTok's own detection has
// known gaps.

(function () {
  const PLATFORM = "tiktok";

  const AI_SIGNAL_STRINGS = [
    "ai-generated",
    "ai generated",
    "ai info",
    "made with ai",
    "ai creator",
  ];

  // Semantic hooks only. TikTok's data-e2e attributes are their own QA test
  // hooks (used by TikTok's own engineers), which are far more stable than
  // hashed CSS classnames, but still not guaranteed forever — hence the
  // generic <video>-ancestor fallback below.
  const CONTAINER_SELECTORS = [
    '[data-e2e="recommend-list-item-container"]',
    'div[data-e2e*="video-item"]',
    "section",
  ];

  const DEBOUNCE_MS = 300;
  const hiddenNodes = new WeakSet();
  let debounceTimer = null;

  function textMatchesSignal(str) {
    if (!str) return false;
    const lower = str.toLowerCase();
    return AI_SIGNAL_STRINGS.some((sig) => lower.includes(sig));
  }

  function ownText(el) {
    let out = "";
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out += child.nodeValue + " ";
    }
    return out;
  }

  function elementSignals(el) {
    if (!(el instanceof Element)) return false;
    if (textMatchesSignal(ownText(el))) return true;
    const ariaLabel = el.getAttribute && el.getAttribute("aria-label");
    if (textMatchesSignal(ariaLabel)) return true;
    const title = el.getAttribute && el.getAttribute("title");
    if (textMatchesSignal(title)) return true;
    return false;
  }

  function findContainer(el) {
    for (const sel of CONTAINER_SELECTORS) {
      const found = el.closest(sel);
      if (found) return found;
    }
    // Fallback: climb to the nearest <video>'s ancestor block, since TikTok
    // sometimes wraps items in structures without data-e2e hooks.
    const video = el.closest("video") || el.querySelector?.("video");
    if (video && video.parentElement) return video.parentElement;

    const root = el.getRootNode();
    if (root instanceof ShadowRoot) {
      const host = root.host;
      for (const sel of CONTAINER_SELECTORS) {
        const found = host.closest(sel);
        if (found) return found;
      }
      return host;
    }
    return el;
  }

  function hide(container, matchedEl) {
    if (hiddenNodes.has(container)) return;
    hiddenNodes.add(container);

    container.style.setProperty("display", "none", "important");
    container.setAttribute("data-authentic-hub-hidden", "true");

    console.warn("Authentic Hub: AI Content Nuked", matchedEl);

    chrome.runtime.sendMessage({
      type: "AI_POST_HIDDEN",
      platform: PLATFORM,
      url: location.href,
    }).catch(() => {});

    window.dispatchEvent(new Event("resize"));
  }

  function deepScan(root) {
    if (root.nodeType === Node.ELEMENT_NODE && root.hasAttribute &&
        root.hasAttribute("data-authentic-hub-hidden")) {
      return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    let node = root.nodeType === Node.ELEMENT_NODE ? root : walker.nextNode();

    while (node) {
      if (node.hasAttribute && node.hasAttribute("data-authentic-hub-hidden")) {
        node = walker.nextNode();
        continue;
      }

      if (elementSignals(node)) {
        const container = findContainer(node);
        hide(container, node);
      }

      if (node.shadowRoot) {
        deepScan(node.shadowRoot);
      }

      node = walker.nextNode();
    }
  }

  function runScan() {
    deepScan(document.body);
    attachBadges();
  }

  // --- Curiosity Mode: the "Pill" badge -----------------------------------
  // Nonchalant glassmorphism pill, bottom-right of each video. Click ->
  // runs HeuristicVerificationEngine.analyzeVideo (forensics.js, loaded
  // before this file). Copy deliberately says "signal", not "Likely
  // Human/AI" — see forensics.js header for why that framing matters.

  const badgedVideos = new WeakSet();

  const TOOLTIP_TEXT = {
    low: "No anomaly signal detected. Experimental heuristic — not a verified AI detector.",
    mixed: "Mixed signal — inconclusive. Experimental heuristic, not a verified AI detector.",
    elevated: "Elevated anomaly signal. Experimental heuristic — not proof, verify independently.",
  };

  const LABEL_COLOR = {
    low: "rgba(120, 200, 140, 0.55)",
    mixed: "rgba(230, 180, 70, 0.6)",
    elevated: "rgba(220, 90, 90, 0.65)",
  };

  function findAllVideos(root, out) {
    out = out || [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    let node = root.nodeType === Node.ELEMENT_NODE ? root : walker.nextNode();
    while (node) {
      if (node.tagName === "VIDEO") out.push(node);
      if (node.shadowRoot) findAllVideos(node.shadowRoot, out);
      node = walker.nextNode();
    }
    return out;
  }

  function stylePill(pill) {
    Object.assign(pill.style, {
      position: "absolute",
      right: "10px",
      bottom: "10px",
      zIndex: "2147483000",
      padding: "4px 10px",
      fontSize: "11px",
      lineHeight: "16px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontWeight: "600",
      color: "#fff",
      background: "rgba(255,255,255,0.14)",
      backdropFilter: "blur(10px)",
      WebkitBackdropFilter: "blur(10px)",
      border: "1px solid rgba(255,255,255,0.28)",
      borderRadius: "999px",
      cursor: "pointer",
      userSelect: "none",
      pointerEvents: "auto",
      transition: "background 0.2s ease",
    });
  }

  function applyResult(pill, result) {
    if (result.status === "blocked") {
      pill.textContent = "🔒";
      pill.title = "Can't read this video's pixels (cross-origin). No signal available.";
      return;
    }
    if (result.status === "error") {
      pill.textContent = "⚠️";
      pill.title = "Check failed: " + (result.message || "unknown error");
      return;
    }
    pill.style.background = LABEL_COLOR[result.label] || LABEL_COLOR.mixed;
    pill.textContent = Math.round(result.score * 100) + "%";
    pill.title = TOOLTIP_TEXT[result.label] || TOOLTIP_TEXT.mixed;
  }

  function attachBadge(video) {
    if (badgedVideos.has(video)) return;
    badgedVideos.add(video);

    const container = findContainer(video);
    if (!container || !(container instanceof HTMLElement)) return;
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }

    const pill = document.createElement("div");
    pill.setAttribute("data-authentic-hub-pill", "true");
    pill.textContent = "Check";
    stylePill(pill);

    pill.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (pill.dataset.busy === "true") return;
      if (!window.AuthenticHub || !window.AuthenticHub.HeuristicVerificationEngine) {
        pill.textContent = "⚠️";
        pill.title = "Forensics engine unavailable.";
        return;
      }
      pill.dataset.busy = "true";
      pill.textContent = "…";
      try {
        const engine = new window.AuthenticHub.HeuristicVerificationEngine();
        const result = await engine.analyzeVideo(video);
        applyResult(pill, result);
      } catch (err) {
        pill.textContent = "⚠️";
        pill.title = "Check failed: " + (err && err.message ? err.message : "unknown error");
      } finally {
        pill.dataset.busy = "false";
      }
    });

    container.appendChild(pill);
  }

  function attachBadges() {
    const videos = findAllVideos(document.body);
    for (const v of videos) attachBadge(v);
  }

  function attachObserver() {
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runScan, DEBOUNCE_MS);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    console.info("Authentic Hub: Watching Feed...");
    runScan();
  }

  if (document.body) {
    attachObserver();
  } else {
    document.addEventListener("DOMContentLoaded", attachObserver, { once: true });
  }

  window.AuthenticHub = window.AuthenticHub || {};
  window.AuthenticHub.checkCurrentVideo = function () {
    const candidates = document.querySelectorAll(CONTAINER_SELECTORS.join(","));
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      const inView = rect.top < window.innerHeight * 0.6 && rect.bottom > window.innerHeight * 0.4;
      if (!inView) continue;
      const flagged = elementSignals(el) || Array.from(el.querySelectorAll("*")).some(elementSignals);
      return {
        status: flagged ? "ai-disclosed" : "no-disclosure-found",
        note: flagged
          ? "Platform-disclosed as AI-generated/modified."
          : "No AI disclosure label detected. Not a guarantee of authenticity.",
      };
    }
    return { status: "unknown", note: "Couldn't identify a video in view." };
  };
})();