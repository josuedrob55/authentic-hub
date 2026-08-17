// forensics.js — Phase 2 (pixel heuristics) + Phase 3 (signature scan)
//
// ‼️ HONESTY NOTE, READ BEFORE CHANGING UI COPY ‼️
// SignatureVerificationEngine below does structural/string-level detection
// of C2PA-shaped byte sequences (JUMBF box markers, known claim-generator
// strings). It does NOT perform cryptographic signature verification
// (no CBOR parse, no COSE signature check, no cert-chain validation against
// the C2PA trust list). A match here means "a manifest-shaped byte sequence
// is present," not "this content's origin has been cryptographically
// proven." Because of that, results are returned as `*-attributed-unverified`
// and the calling UI must not render them as "Confirmed"/"Verified" —
// unverified string matches are trivially spoofable by embedding the same
// bytes in any file.
//
// There is no SynthID/watermark detector in this file. Google's invisible
// watermark is recovered by a proprietary ML detector Google runs
// server-side; there is no client-readable header field that reveals it,
// so a "look for a string in the video header" implementation would be
// fabricated, not weak — it's been left out rather than faked.

(function () {
  window.AuthenticHub = window.AuthenticHub || {};

  // ---------------------------------------------------------------------
  // Phase 2: HeuristicVerificationEngine (unchanged from prior build)
  // ---------------------------------------------------------------------
  const FRAME_SIZE = 256;
  const FRAME_COUNT = 5;
  const FRAME_INTERVAL_MS = 80;

  class HeuristicVerificationEngine {
    constructor() {
      this.canvas = new OffscreenCanvas(FRAME_SIZE, FRAME_SIZE);
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    }

    async _grabFrame(video) {
      this.ctx.drawImage(video, 0, 0, FRAME_SIZE, FRAME_SIZE);
      const imageData = this.ctx.getImageData(0, 0, FRAME_SIZE, FRAME_SIZE);
      return HeuristicVerificationEngine._toGrayscale(imageData.data);
    }

    static _toGrayscale(rgba) {
      const n = FRAME_SIZE * FRAME_SIZE;
      const gray = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        gray[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
      }
      return gray;
    }

    static _boxBlur3(gray) {
      const w = FRAME_SIZE, h = FRAME_SIZE;
      const out = new Float32Array(gray.length);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sum = 0, count = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const yy = y + dy, xx = x + dx;
              if (yy >= 0 && yy < h && xx >= 0 && xx < w) {
                sum += gray[yy * w + xx];
                count++;
              }
            }
          }
          out[y * w + x] = sum / count;
        }
      }
      return out;
    }

    static _residual(gray) {
      const blurred = HeuristicVerificationEngine._boxBlur3(gray);
      const out = new Float32Array(gray.length);
      for (let i = 0; i < gray.length; i++) out[i] = gray[i] - blurred[i];
      return out;
    }

    static _pearson(a, b) {
      const n = a.length;
      let meanA = 0, meanB = 0;
      for (let i = 0; i < n; i++) { meanA += a[i]; meanB += b[i]; }
      meanA /= n; meanB /= n;
      let num = 0, denA = 0, denB = 0;
      for (let i = 0; i < n; i++) {
        const da = a[i] - meanA, db = b[i] - meanB;
        num += da * db; denA += da * da; denB += db * db;
      }
      const den = Math.sqrt(denA * denB);
      return den === 0 ? 0 : num / den;
    }

    _tellNoiseCorrelation(residuals) {
      let total = 0, pairs = 0;
      for (let i = 1; i < residuals.length; i++) {
        total += HeuristicVerificationEngine._pearson(residuals[i - 1], residuals[i]);
        pairs++;
      }
      return pairs ? total / pairs : 0;
    }

    _tellBackgroundShimmer(grayFrames) {
      const w = FRAME_SIZE, h = FRAME_SIZE, margin = Math.floor(FRAME_SIZE * 0.1);
      const ringIdx = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (x < margin || x >= w - margin || y < margin || y >= h - margin) {
            ringIdx.push(y * w + x);
          }
        }
      }
      let varSum = 0;
      for (const idx of ringIdx) {
        let mean = 0;
        for (const frame of grayFrames) mean += frame[idx];
        mean /= grayFrames.length;
        let variance = 0;
        for (const frame of grayFrames) variance += (frame[idx] - mean) ** 2;
        variance /= grayFrames.length;
        varSum += variance;
      }
      return ringIdx.length ? varSum / ringIdx.length : 0;
    }

    _tellFrequencyEnergy(gray) {
      const w = FRAME_SIZE, h = FRAME_SIZE;
      let sum = 0, count = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const gx = gray[i + 1] - gray[i - 1];
          const gy = gray[i + w] - gray[i - w];
          sum += Math.sqrt(gx * gx + gy * gy);
          count++;
        }
      }
      return count ? sum / count : 0;
    }

    async analyzeVideo(videoElement) {
      const t0 = performance.now();

      if (!videoElement || videoElement.readyState < 2) {
        return { status: "error", message: "Video not ready" };
      }
      if (typeof OffscreenCanvas === "undefined") {
        return { status: "error", message: "OffscreenCanvas unsupported" };
      }

      const grayFrames = [];
      try {
        for (let i = 0; i < FRAME_COUNT; i++) {
          grayFrames.push(await this._grabFrame(videoElement));
          if (i < FRAME_COUNT - 1) {
            await new Promise((r) => setTimeout(r, FRAME_INTERVAL_MS));
          }
        }
      } catch (err) {
        const msg = (err && err.message) || "";
        if ((err && err.name === "SecurityError") || /security|taint|cross-origin/i.test(msg)) {
          return { status: "blocked" };
        }
        return { status: "error", message: msg || "capture failed" };
      }

      const residuals = grayFrames.map((g) => HeuristicVerificationEngine._residual(g));

      const noiseCorr = this._tellNoiseCorrelation(residuals);
      const shimmer = this._tellBackgroundShimmer(grayFrames);
      const freqEnergy = this._tellFrequencyEnergy(grayFrames[grayFrames.length - 1]);

      const sigmoid = (x, mid, k) => 1 / (1 + Math.exp(-k * (x - mid)));
      const s1 = 1 - sigmoid(noiseCorr, 0.15, 8);
      const s2 = sigmoid(shimmer, 40, 0.05);
      const s3 = sigmoid(freqEnergy, 18, 0.15);

      const weights = { noise: 0.4, shimmer: 0.35, freq: 0.25 };
      const score = weights.noise * s1 + weights.shimmer * s2 + weights.freq * s3;

      let label = "mixed";
      if (score < 0.35) label = "low";
      else if (score > 0.65) label = "elevated";

      const elapsedMs = performance.now() - t0;
      if (elapsedMs > 1000) {
        console.warn("Authentic Hub: analyzeVideo exceeded 1s budget:", elapsedMs.toFixed(0) + "ms");
      }

      return {
        status: "ok",
        score,
        label,
        tells: { noiseCorrelation: noiseCorr, backgroundShimmer: shimmer, frequencyEnergy: freqEnergy },
        elapsedMs,
      };
    }
  }

  // ---------------------------------------------------------------------
  // Phase 3: SignatureVerificationEngine
  // ---------------------------------------------------------------------
  class SignatureVerificationEngine {
    constructor() {
      this.HEAD_BYTES = 100 * 1024;
      this.TAIL_BYTES = 10 * 1024;

      this.AI_MODEL_MARKERS = [
        "dall-e", "dall·e", "sora", "firefly", "midjourney",
        "stable diffusion", "imagen", "veo", "runway",
      ];
      this.HARDWARE_MARKERS = [
        "iphone", "sony", "canon", "nikon", "pixel camera", "leica", "gopro",
      ];
    }

    async _fetchRange(url, rangeHeader) {
      const res = await fetch(url, { headers: { Range: rangeHeader }, cache: "no-store" });
      if (res.status === 200) {
        // Server ignored our Range header and is sending the whole file --
        // common when a CDN/proxy doesn't support partial content. Bail
        // rather than pulling down an entire video just to scan headers.
        throw new Error("range-not-honored");
      }
      if (res.status !== 206) {
        throw new Error("unexpected-status-" + res.status);
      }
      return res.arrayBuffer();
    }

    // iso-8859-1 is a single-byte codec: every byte maps to exactly one
    // code point, no throwing, no lossy multi-byte re-interpretation. Safe
    // for substring-searching arbitrary binary data for ASCII markers.
    _toSearchableText(buffer) {
      return new TextDecoder("iso-8859-1").decode(new Uint8Array(buffer));
    }

    _scanForC2paSignals(text) {
      const lower = text.toLowerCase();
      const signals = {
        hasJumbfBox: lower.includes("jumb"),
        hasC2paMarker: lower.includes("c2pa") || lower.includes("com.adobe.content-credentials"),
        hasActionMarker: lower.includes("c2pa.placed") || lower.includes("c2pa.created"),
        aiModelMatches: this.AI_MODEL_MARKERS.filter((m) => lower.includes(m)),
        hardwareMatches: this.HARDWARE_MARKERS.filter((m) => lower.includes(m)),
      };
      return signals;
    }

    /**
     * Fetches partial byte ranges of the video and scans them for
     * C2PA/JUMBF-shaped markers. Returns an UNVERIFIED structural signal —
     * see file header. Never treat `attribution` as a proven fact.
     *
     * Return shapes:
     *   { status: 'ok', attribution: 'no-manifest'|'ai-attributed-unverified'
     *              |'human-attributed-unverified'|'ambiguous', signals }
     *   { status: 'blocked', message }   -- CORS / range not supported / network error
     *   { status: 'error', message }
     */
    async checkManifest(video) {
      const url = video && (video.currentSrc || video.src);
      if (!url) return { status: "error", message: "No video URL available" };

      let head, tail;
      try {
        head = await this._fetchRange(url, `bytes=0-${this.HEAD_BYTES - 1}`);
        tail = await this._fetchRange(url, `bytes=-${this.TAIL_BYTES}`);
      } catch (err) {
        // Covers CORS rejection, opaque/no-cors responses, network failure,
        // and "server ignored Range" -- all mean the same thing to the
        // user: we couldn't do deep verification on this asset.
        return { status: "blocked", message: err && err.message };
      }

      const text = this._toSearchableText(head) + this._toSearchableText(tail);
      const signals = this._scanForC2paSignals(text);

      if (!signals.hasJumbfBox && !signals.hasC2paMarker) {
        return { status: "ok", attribution: "no-manifest", signals };
      }

      const hasAi = signals.aiModelMatches.length > 0;
      const hasHardware = signals.hardwareMatches.length > 0;

      if (hasAi && !hasHardware) {
        return { status: "ok", attribution: "ai-attributed-unverified", signals };
      }
      if (hasHardware && !hasAi) {
        return { status: "ok", attribution: "human-attributed-unverified", signals };
      }
      return { status: "ok", attribution: "ambiguous", signals };
    }

    // Deliberately not implemented -- see file header. Kept as an explicit
    // stub (rather than silently absent) so callers get a clear, honest
    // "unsupported" result instead of undefined-function errors.
    async checkWatermark() {
      return {
        status: "unsupported",
        message: "Invisible-watermark (SynthID) detection requires a server-side ML detector; not implementable via client-side header/string scanning.",
      };
    }
  }

  window.AuthenticHub.HeuristicVerificationEngine = HeuristicVerificationEngine;
  window.AuthenticHub.SignatureVerificationEngine = SignatureVerificationEngine;

  // ---------------------------------------------------------------------
  // Phase 4/5: RemoteVerificationEngine — calls the local FastAPI backend
  // (hub-cloud/main.py) instead of doing math in the browser.
  //
  // ⚠️ The backend's ensemble (FFT periodicity + temporal variance + C2PA
  // scan) is real signal processing now, not a random mock — but it has
  // NOT been validated against labeled real-vs-AI data. Every response
  // carries `validated: false` for exactly that reason, and this engine
  // passes it through UNCHANGED. Do not strip it here or in the calling
  // UI; the pill needs it to keep rendering the neutral/heuristic state
  // instead of a confident-looking verdict on an unvalidated score.
  // ---------------------------------------------------------------------
  class RemoteVerificationEngine {
    constructor(endpoint) {
      this.endpoint = endpoint || "http://localhost:8000/verify";
    }

    /**
     * @param {string} videoPageUrl - a permalink yt-dlp can resolve
     *   (e.g. an Instagram /reel/ or /p/ URL), not just a raw CDN blob URL.
     *   Raw CDN URLs often fail server-side due to hotlink/referer
     *   protection that yt-dlp's platform-specific extractors normally
     *   handle for you when given the real page URL.
     *
     * Return shapes:
     *   { status: 'ok', mock, score, label, modelVersion, message }
     *   { status: 'offline', message }  -- fetch failed (server not running,
     *                                      or blocked by page CSP/mixed-content;
     *                                      see note below)
     *   { status: 'error', message }    -- server reachable but returned an error
     */
    async verify(videoPageUrl) {
      let res;
      try {
        res = await fetch(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ video_url: videoPageUrl }),
        });
      } catch (err) {
        // Most common cause: main.py isn't running. Less common: this
        // page's CSP or the browser's mixed-content policy blocked an
        // http:// fetch from an https:// page's content-script context.
        // If that turns out to be the issue on a given platform, route
        // this same request through background.js instead (a service
        // worker isn't subject to page CSP/mixed-content rules) and have
        // it relay the result back via chrome.runtime.sendMessage.
        return {
          status: "offline",
          message: "Could not reach local verification server — is `uvicorn main:app --port 8000` running?",
        };
      }

      if (!res.ok) {
        let detail = "";
        try {
          const body = await res.json();
          detail = body.detail || "";
        } catch (_) {
          /* non-JSON error body, ignore */
        }
        if (res.status === 422) {
          // yt-dlp/FastAPI couldn't resolve or process the URL we sent —
          // distinct from a generic server error so the pill can offer the
          // right message (fall back to local analysis) rather than a
          // vague "⚠️ error".
          return { status: "unresolvable", message: detail || "Server could not resolve this URL." };
        }
        return { status: "error", message: `Server error ${res.status}${detail ? ": " + detail : ""}` };
      }

      const data = await res.json();
      return {
        status: "ok",
        validated: !!data.validated,
        score: data.score,
        label: data.label,
        reason: data.reason,
        message: data.message,
      };
    }
  }

  window.AuthenticHub.RemoteVerificationEngine = RemoteVerificationEngine;
})();