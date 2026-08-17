// platforms/instagram.js — DEBUG BUILD: aggressive universal text scan.
//
// GOAL OF THIS BUILD: confirm detection is actually firing before trusting
// it to silently hide anything. Set DEBUG_MODE = false once purple borders
// are reliably appearing on the right elements, to switch back to silent
// hide (display:none) instead of the visible border.
//
// LIKELY ROOT CAUSE of "fires once, then nothing while scrolling": the
// previous MutationObserver only watched {childList, subtree}. If Instagram
// updates a badge's label via a characterData mutation (replacing an
// existing text node's value) rather than inserting a new node, that never
// fires childList. This build (a) adds characterData:true to the observer,
// and (b) also polls the whole page on an interval as a fallback that
// doesn't depend on mutation events firing correctly at all.
//
// SCOPE NOTE (unchanged): this still only detects platform-DISCLOSED AI
// content (the labels below). It does not detect undisclosed AI content.

(function () {
  const PLATFORM = "instagram";
  const DEBUG_MODE = true;

  const AI_SIGNAL_STRINGS = [
    "made with ai",
    "ai info",
    "ai creator",
    "ai-generated content",
  ];

  const SCAN_INTERVAL_MS = 500;

  const flaggedContainers = new WeakSet();
  const videoPillMap = new Map(); // video element -> pill element

  function textMatchesSignal(str) {
    if (!str) return false;
    const lower = str.toLowerCase();
    return AI_SIGNAL_STRINGS.some((sig) => lower.includes(sig));
  }

  // Given the text node that matched, find the enclosing reel/post
  // container: prefer the nearest <article>, else walk ancestors and pick
  // whichever has the highest computed z-index (common heuristic for
  // locating the active overlay/reel wrapper in these SPA feeds).
  function findAiContainer(textNode) {
    const startEl = textNode.parentElement;
    if (!startEl) return null;

    const article = startEl.closest("article");
    if (article) return article;

    let node = startEl;
    let best = null;
    let bestZ = -Infinity;
    for (let depth = 0; node && depth < 15; depth++) {
      if (node instanceof Element) {
        const z = parseInt(getComputedStyle(node).zIndex, 10);
        if (!isNaN(z) && z > bestZ) {
          bestZ = z;
          best = node;
        }
      }
      node = node.parentElement;
    }
    return best || startEl;
  }

  function flagContainer(container, matchedText) {
    if (!container || flaggedContainers.has(container)) return;
    flaggedContainers.add(container);

    console.log("[Authentic Hub] FOUND AI LABEL: ", matchedText);

    if (DEBUG_MODE) {
      container.style.setProperty("border", "4px solid purple", "important");
      container.setAttribute("data-authentic-hub-flagged", "true");
    } else {
      container.style.setProperty("display", "none", "important");
      container.setAttribute("data-authentic-hub-hidden", "true");
      window.dispatchEvent(new Event("resize")); // nudge lazy-loaders to backfill
    }

    chrome.runtime.sendMessage({
      type: "AI_POST_HIDDEN",
      platform: PLATFORM,
      url: location.href,
    }).catch(() => {});
  }

  // Full-page text-node sweep. Deliberately unscoped/aggressive per this
  // debug build's purpose — heavier than the previous element-level scan,
  // expect higher CPU use on large feeds. Revert to targeted scanning once
  // the root cause above is confirmed and fixed.
  function scanAllText() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const val = node.nodeValue;
      if (!val || !val.trim()) continue;
      if (textMatchesSignal(val)) {
        const container = findAiContainer(node);
        flagContainer(container, val.trim().slice(0, 120));
      }
    }
  }

  function attachObserver() {
    const observer = new MutationObserver(() => {
      scanAllText();
      attachBadges();
    });

    // characterData:true is the key addition — catches in-place text
    // updates that childList/subtree alone misses.
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    console.info("Authentic Hub: Watching Feed...");
  }

  function startPolling() {
    setInterval(() => {
      scanAllText();
      attachBadges();
    }, SCAN_INTERVAL_MS);
  }

  // --- Curiosity Pill: signature-first, with pixel-heuristic fallback ----
  // Flow on click: pulse (loading) -> SignatureVerificationEngine.checkManifest
  //   -> if a manifest signal was found, show it (labeled *-unverified)
  //   -> if no manifest / blocked, offer a fallback to the local pixel
  //      heuristic (HeuristicVerificationEngine) rather than a fake "cloud"
  //      button, since we have no cloud backend to call.

  let pillStyleInjected = false;
  function injectPillStyles() {
    if (pillStyleInjected) return;
    pillStyleInjected = true;
    const style = document.createElement("style");
    style.textContent = `
      @keyframes authenticHubPulse {
        0%   { box-shadow: 0 0 0 0 rgba(80,150,255,0.55); }
        70%  { box-shadow: 0 0 0 8px rgba(80,150,255,0); }
        100% { box-shadow: 0 0 0 0 rgba(80,150,255,0); }
      }
      [data-authentic-hub-pill].ah-loading {
        background: rgba(80,150,255,0.35) !important;
        animation: authenticHubPulse 1.2s infinite;
      }
    `;
    document.head.appendChild(style);
  }

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

  // yt-dlp needs a real, public instagram.com permalink (e.g. /reel/<id>/),
  // NEVER the raw blob: URL a <video> element uses internally for playback.
  // blob: URLs are page-local object references -- yt-dlp/the backend has
  // no way to fetch them at all, and sending one is a guaranteed 422.
  //
  // Returns a validated absolute URL string, or null if nothing usable was
  // found nearby. Callers MUST treat null as "no remote check possible" --
  // never fall back to video.currentSrc/video.src here, that's exactly the
  // blob: leak this function exists to stop.
  function findPermalink(video) {
    let node = video.parentElement;
    for (let depth = 0; node && depth < 12; depth++) {
      const anchors = node.querySelectorAll
        ? node.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/tv/"]')
        : [];
      for (const a of anchors) {
        const candidate = isUsablePermalink(a.href);
        if (candidate) return candidate;
      }
      node = node.parentElement;
    }
    return null;
  }

  // Strict allow-list check: must parse as a URL, must be blob:-free, must
  // be an instagram.com host, and must contain a recognized permalink path
  // segment. Returns the normalized href on success, or null.
  function isUsablePermalink(href) {
    if (!href || typeof href !== "string") return null;
    if (href.startsWith("blob:")) return null; // hard stop, never let this through

    let parsed;
    try {
      parsed = new URL(href, location.href);
    } catch (_) {
      return null;
    }

    if (parsed.protocol === "blob:") return null;
    if (!/(^|\.)instagram\.com$/i.test(parsed.hostname)) return null;
    if (!/\/(reel|reels|p|tv)\//i.test(parsed.pathname)) return null;

    return parsed.href;
  }

  function stylePill(pill) {
    Object.assign(pill.style, {
      position: "fixed",
      zIndex: "2147483647",
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
      whiteSpace: "nowrap",
    });
  }

  function setPillLoading(pill) {
    pill.classList.add("ah-loading");
    pill.textContent = "Verifying…";
    pill.title = "Fetching partial video bytes to scan for a provenance manifest…";
  }

  function applyHeuristicResult(pill, result) {
    pill.classList.remove("ah-loading");
    if (result.status === "blocked") {
      pill.textContent = "🔒";
      pill.title = "Platform blocked deep verification.";
      return;
    }
    if (result.status === "error") {
      pill.textContent = "⚠️";
      pill.title = "Check failed: " + (result.message || "unknown error");
      return;
    }
    const colors = {
      low: "rgba(120, 200, 140, 0.75)",
      mixed: "rgba(230, 180, 70, 0.8)",
      elevated: "rgba(220, 90, 90, 0.85)",
    };
    const tooltips = {
      low: "Pixel heuristic: no anomaly signal. Experimental, unvalidated — not a verified detector.",
      mixed: "Pixel heuristic: mixed/inconclusive signal. Experimental, unvalidated.",
      elevated: "Pixel heuristic: elevated anomaly signal. Experimental, unvalidated — not proof.",
    };
    pill.style.background = colors[result.label] || colors.mixed;
    pill.textContent = "px:" + Math.round(result.score * 100) + "%";
    pill.title = tooltips[result.label] || tooltips.mixed;
  }

  async function runPixelFallback(pill, video) {
    if (!window.AuthenticHub || !window.AuthenticHub.HeuristicVerificationEngine) {
      pill.classList.remove("ah-loading");
      pill.textContent = "⚠️";
      pill.title = "Pixel heuristic engine unavailable.";
      return;
    }
    setPillLoading(pill);
    try {
      const engine = new window.AuthenticHub.HeuristicVerificationEngine();
      const result = await engine.analyzeVideo(video);
      applyHeuristicResult(pill, result);
    } catch (err) {
      pill.classList.remove("ah-loading");
      pill.textContent = "⚠️";
      pill.title = "Check failed: " + (err && err.message ? err.message : "unknown error");
    }
  }

  async function applyRemoteResult(pill, result, video) {
    pill.classList.remove("ah-loading");

    if (result.status === "offline") {
      pill.textContent = "🔌";
      pill.title = result.message + " Click again to fall back to the local pixel heuristic.";
      pill.dataset.fallback = "pixel";
      return;
    }

    if (result.status === "unresolvable") {
      // Server reached, but couldn't resolve/process the URL we sent
      // (e.g. yt-dlp failed on this specific post). Show the requested
      // icon briefly, then automatically fall back to local analysis --
      // "graceful degradation" rather than making the user click again.
      pill.textContent = "🔗?";
      pill.title = "Could not resolve public link. Using local analysis instead.";
      await new Promise((r) => setTimeout(r, 500)); // let the icon actually be seen before it transitions
      await runPixelFallback(pill, video);
      return;
    }

    if (result.status === "error") {
      pill.textContent = "⚠️";
      pill.title = result.message;
      return;
    }

    if (!result.validated) {
      // Deliberately NOT using the red/amber/green confidence palette here.
      // A distinct neutral color + explicit hedge keeps an unvalidated
      // heuristic score from reading as a real verdict — see forensics.js
      // and hub-cloud/main.py headers.
      const neutral = {
        low: "rgba(140, 130, 210, 0.7)",
        mixed: "rgba(150, 120, 220, 0.75)",
        elevated: "rgba(170, 110, 210, 0.8)",
      };
      pill.style.background = neutral[result.label] || neutral.mixed;
      pill.textContent = "⚗️ " + Math.round((result.score || 0) * 100) + "%";
      pill.title = "UNVALIDATED — " + (result.reason || result.message || "heuristic ensemble, not tested against labeled data.");
      return;
    }

    // Reached only once the backend's `validated` flag has been
    // deliberately set to true after real testing against labeled data.
    const colors = {
      low: "rgba(120, 200, 140, 0.75)",
      mixed: "rgba(230, 180, 70, 0.8)",
      elevated: "rgba(220, 90, 90, 0.85)",
    };
    pill.style.background = colors[result.label] || colors.mixed;
    pill.textContent = Math.round((result.score || 0) * 100) + "%";
    pill.title = result.reason || result.message || "Server verification result.";
  }

  function attachBadge(video) {
    if (videoPillMap.has(video)) return;
    injectPillStyles();

    const pill = document.createElement("div");
    pill.setAttribute("data-authentic-hub-pill", "true");
    pill.textContent = "Check";
    stylePill(pill);

    pill.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (pill.dataset.busy === "true") return;

      // A prior click already told us the remote server is unreachable --
      // this click runs the local pixel-heuristic fallback instead of
      // retrying the same failed request.
      if (pill.dataset.fallback === "pixel") {
        delete pill.dataset.fallback;
        pill.dataset.busy = "true";
        await runPixelFallback(pill, video);
        pill.dataset.busy = "false";
        return;
      }

      pill.dataset.busy = "true";

      // Resolve BEFORE touching the network. No usable permalink means no
      // remote call at all -- this is what actually stops blob: URLs from
      // ever reaching the backend, rather than relying on the server to
      // reject them after the fact.
      const permalink = findPermalink(video);
      if (!permalink) {
        setPillLoading(pill);
        await runPixelFallback(pill, video);
        pill.dataset.busy = "false";
        return;
      }

      if (!window.AuthenticHub || !window.AuthenticHub.RemoteVerificationEngine) {
        pill.textContent = "⚠️";
        pill.title = "Remote verification engine unavailable.";
        pill.dataset.busy = "false";
        return;
      }

      setPillLoading(pill);
      try {
        const engine = new window.AuthenticHub.RemoteVerificationEngine();
        const result = await engine.verify(permalink);
        await applyRemoteResult(pill, result, video);
      } catch (err) {
        pill.classList.remove("ah-loading");
        pill.textContent = "⚠️";
        pill.title = "Check failed: " + (err && err.message ? err.message : "unknown error");
      } finally {
        pill.dataset.busy = "false";
      }
    });

    document.body.appendChild(pill);
    videoPillMap.set(video, pill);
  }

  function attachBadges() {
    const videos = findAllVideos(document.body);
    for (const v of videos) attachBadge(v);
  }

  // position:fixed doesn't follow an element during scroll on its own --
  // it's viewport-anchored. This loop recomputes each pill's coordinates
  // from its video's current bounding rect every frame. It also doubles as
  // the memory-leak guard: any pill whose video has left the DOM is
  // removed from both the page and the Map here, so videoPillMap can't
  // grow unbounded across an infinite-scroll session.
  function trackPills() {
    for (const [video, pill] of videoPillMap) {
      if (!document.body.contains(video)) {
        pill.remove();
        videoPillMap.delete(video);
        continue;
      }
      const rect = video.getBoundingClientRect();
      const onscreen = rect.width > 0 && rect.height > 0 &&
        rect.bottom > 0 && rect.top < window.innerHeight &&
        rect.right > 0 && rect.left < window.innerWidth;
      if (!onscreen) {
        pill.style.display = "none";
      } else {
        pill.style.display = "block";
        pill.style.left = Math.round(rect.right - 66) + "px";
        pill.style.top = Math.round(rect.bottom - 34) + "px";
      }
    }
    requestAnimationFrame(trackPills);
  }

  function init() {
    attachObserver();
    scanAllText();   // initial pass
    attachBadges();  // initial pass
    startPolling();
    requestAnimationFrame(trackPills);
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  }
})();