"""
Authentic Hub — Verification API (main.py) — "Ensemble Forensic" build

Combines three signals into one score:
  1. FFT periodicity (NumPy)             — checkerboard/upsampling artifact proxy
  2. Temporal variance periodicity (OpenCV + NumPy) — stochastic-vs-periodic noise proxy
  3. C2PA/JUMBF structural scan            — provenance-manifest presence (unverified)

⚠️ CALIBRATION STATUS — READ BEFORE PRESENTING THIS ANYWHERE ⚠️
None of these three signals have been validated against a labeled dataset
of real-vs-AI video. The FFT and temporal-variance techniques ARE grounded
in real, published forensic research — periodic frequency-domain artifacts
from transposed-convolution upsampling are documented (Durall et al. 2020,
"Watch your Up-Convolution"; Zhang et al. 2019 on GAN spectral artifacts) —
so the underlying mechanism is legitimate, not invented. But the specific
thresholds, weights, and the score/label cutoffs below are hand-picked, not
fit to data, and this build has never been run against a single labeled
real-or-AI example. `score` and `reason` describe what the heuristic
detected, not a proven fact about the video's origin.

If asked "what's your precision/recall": the honest answer right now is
"unmeasured — no validation set yet," not a number. Being upfront about
that is the credible, professional answer; a system that overstates its
own certainty is the actual red flag.

Every response carries `validated: false` for exactly this reason, and
nothing downstream should treat a False here as "the model got worse" —
it's telling the truth about what has and hasn't been checked. Flip it to
True only after real validation against labeled data.

Run with:
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000
"""

import logging
import urllib.request
from typing import List, Optional, Tuple

import cv2
import numpy as np
import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("authentic-hub")

app = FastAPI(title="Authentic Hub Verification API", version="0.2.0-ensemble")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # TODO: restrict before any non-local deployment
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

KEYFRAME_COUNT = 10
HEAD_BYTES = 100 * 1024

AI_MODEL_MARKERS = [
    "dall-e", "dall·e", "sora", "firefly", "midjourney",
    "stable diffusion", "imagen", "veo", "runway",
]
HARDWARE_MARKERS = [
    "iphone", "sony", "canon", "nikon", "pixel camera", "leica", "gopro",
]


class VerifyRequest(BaseModel):
    video_url: str


class VerifyResponse(BaseModel):
    status: str                       # "ok" | "error"
    validated: bool = False           # ALWAYS False until real validation happens — see module docstring
    score: Optional[float] = None
    label: Optional[str] = None       # 'low' | 'mixed' | 'elevated'
    reason: Optional[str] = None
    frame_count: Optional[int] = None
    signals: Optional[dict] = None    # raw per-tell diagnostics, for exactly the "explain what the Brain saw" use case
    message: Optional[str] = None


def resolve_stream_url(video_url: str) -> str:
    """Resolve a page URL to a direct, playable media URL via yt-dlp.
    Server-side, so browser CORS/canvas-tainting never applies here."""
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "format": "best[ext=mp4]/best",
        "noplaylist": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(video_url, download=False)
        if info.get("url"):
            return info["url"]
        if info.get("entries"):
            first = info["entries"][0]
            if first and first.get("url"):
                return first["url"]
        formats = info.get("formats") or []
        if formats:
            return formats[-1]["url"]
        raise RuntimeError("yt-dlp resolved the URL but returned no playable stream")


def extract_keyframes(stream_url: str, count: int = KEYFRAME_COUNT) -> List[np.ndarray]:
    """Pull `count` evenly-spaced grayscale frames (as float64 arrays) via
    OpenCV's FFmpeg backend, which reads directly from a network URL."""
    cap = cv2.VideoCapture(stream_url)
    if not cap.isOpened():
        raise RuntimeError("OpenCV could not open the video stream")

    frames: List[np.ndarray] = []
    try:
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        if total_frames > 0:
            indices = [int(i * total_frames / count) for i in range(count)]
            for idx in indices:
                cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
                ok, frame = cap.read()
                if ok and frame is not None:
                    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float64)
                    frames.append(gray)
        else:
            # Some streams don't report a reliable frame count — fall back
            # to sequential reads, sampling every 3rd frame.
            read_count = 0
            while len(frames) < count:
                ok, frame = cap.read()
                if not ok or frame is None:
                    break
                if read_count % 3 == 0:
                    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float64)
                    frames.append(gray)
                read_count += 1
    finally:
        cap.release()

    if not frames:
        raise RuntimeError("No frames could be extracted from the stream")
    return frames


def spectral_flatness(magnitude: np.ndarray, eps: float = 1e-8) -> float:
    """Wiener entropy / spectral flatness: geometric_mean / arithmetic_mean
    of a magnitude spectrum. This is a standard, well-established DSP
    metric — used here as-is, not invented for this project. Close to 1.0
    = noise-like/broadband (stochastic). Close to 0.0 = peaky/tonal
    (periodic)."""
    if magnitude is None or magnitude.size == 0:
        return 1.0

    mag = magnitude.flatten()
    mag = mag[mag > eps]
    if mag.size == 0:
        return 1.0

    log_mag = np.log(mag)
    geo_mean = np.exp(np.mean(log_mag))
    arith_mean = np.mean(mag)
    if arith_mean <= eps:
        return 1.0

    return float(np.clip(geo_mean / arith_mean, 0.0, 1.0))


def fft_periodicity_score(frame: Optional[np.ndarray]) -> Tuple[float, dict]:
    """Tell #1 — FFT periodicity in the high-frequency band. Published
    forensic literature documents that transposed-convolution upsampling
    in many generative models leaves periodic checkerboard artifacts with
    a distinct frequency-domain signature. This computes spectral flatness
    over the outer (high-frequency) annulus of the 2D FFT magnitude
    spectrum as a proxy for that periodicity. Low flatness suggests
    tonal/periodic structure — that's the mechanism's signal, not a proven
    detector; see module docstring."""
    if frame is None or frame.size == 0:
        return 0.5, {"error": "empty or missing frame"}

    f = np.fft.fft2(frame)
    fshift = np.fft.fftshift(f)
    magnitude = np.abs(fshift)

    h, w = magnitude.shape
    cy, cx = h // 2, w // 2
    yy, xx = np.ogrid[:h, :w]
    dist = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2)
    max_dist = np.sqrt(cy ** 2 + cx ** 2) if (cy or cx) else 1.0

    # High-frequency annulus: outer 60-95% of the spectrum radius, avoiding
    # the low-frequency core and the very edge (Nyquist boundary effects).
    band_mask = (dist > 0.6 * max_dist) & (dist < 0.95 * max_dist)
    band = magnitude[band_mask]

    flatness = spectral_flatness(band)
    anomaly = 1.0 - flatness  # low flatness (peaky/periodic) -> higher anomaly

    return anomaly, {
        "spectral_flatness": round(flatness, 4),
        "band_pixel_count": int(band.size),
    }


def temporal_variance_score(frames: List[np.ndarray]) -> Tuple[float, dict]:
    """Tell #2 — temporal variance periodicity. Computes per-pixel variance
    across the sampled frames (a proxy for frame-to-frame noise/shimmer),
    then runs the same spectral-flatness analysis on that variance map.
    Natural sensor noise tends toward spatially white/stochastic (high
    flatness); some synthesis pipelines produce grid-patterned temporal
    shimmer (low flatness). Same caveat as Tell #1 applies."""
    if not frames or len(frames) < 2:
        return 0.5, {"error": "insufficient frames (need >= 2)"}

    stack = np.stack(frames, axis=0)
    variance_map = np.var(stack, axis=0)

    f = np.fft.fft2(variance_map)
    fshift = np.fft.fftshift(f)
    magnitude = np.abs(fshift)

    flatness = spectral_flatness(magnitude)
    anomaly = 1.0 - flatness

    return anomaly, {
        "spectral_flatness": round(flatness, 4),
        "mean_variance": round(float(np.mean(variance_map)), 4),
    }


def scan_c2pa_manifest(head_bytes: Optional[bytes]) -> dict:
    """Tell #3 — structural C2PA/JUMBF scan. String-level detection only,
    NOT cryptographic signature verification (no CBOR parse, no COSE
    signature check, no cert-chain validation against the C2PA trust
    list). 'has_manifest: true' means a manifest-shaped byte sequence is
    present, not that origin has been cryptographically proven — see
    module docstring. Trivially spoofable by embedding these same bytes
    in any file, so never surface this as "Verified"."""
    if not head_bytes:
        return {"has_manifest": False, "attribution": "no-manifest"}

    text = head_bytes.decode("latin-1", errors="ignore").lower()
    has_jumbf = "jumb" in text
    has_c2pa = "c2pa" in text or "com.adobe.content-credentials" in text

    if not has_jumbf and not has_c2pa:
        return {"has_manifest": False, "attribution": "no-manifest"}

    ai_matches = [m for m in AI_MODEL_MARKERS if m in text]
    hw_matches = [m for m in HARDWARE_MARKERS if m in text]

    if ai_matches and not hw_matches:
        attribution = "ai-attributed-unverified"
    elif hw_matches and not ai_matches:
        attribution = "human-attributed-unverified"
    else:
        attribution = "ambiguous"

    return {
        "has_manifest": True,
        "attribution": attribution,
        "ai_matches": ai_matches,
        "hardware_matches": hw_matches,
    }


def fetch_head_bytes(stream_url: str, num_bytes: int = HEAD_BYTES) -> Optional[bytes]:
    """Best-effort fetch of the first `num_bytes` of the stream for the C2PA
    scan. Runs server-side against whatever URL yt-dlp resolved — failures
    here (network error, server ignoring Range, etc.) are non-fatal to the
    overall /verify call; we just fall back to 'no-manifest' and keep going
    with the pixel-based tells."""
    try:
        request = urllib.request.Request(
            stream_url, headers={"Range": f"bytes=0-{num_bytes - 1}"}
        )
        with urllib.request.urlopen(request, timeout=10) as resp:
            return resp.read(num_bytes)
    except Exception as exc:
        logger.warning("C2PA head-byte fetch failed (non-fatal): %s", exc)
        return None


def build_verdict(fft_anomaly: float, temporal_anomaly: float, c2pa: dict) -> dict:
    """Combines the three signals into one score + reason. If a C2PA
    manifest was found, it's surfaced as the primary reason (it's the more
    specific signal) — but still explicitly labeled unverified. Absent
    that, the pixel-based ensemble score drives the label/reason, always
    phrased as a heuristic finding, never a determination."""

    weights = {"fft": 0.5, "temporal": 0.5}
    pixel_score = weights["fft"] * fft_anomaly + weights["temporal"] * temporal_anomaly
    pixel_score = float(np.clip(pixel_score, 0.0, 1.0))

    if pixel_score < 0.35:
        label = "low"
    elif pixel_score > 0.65:
        label = "elevated"
    else:
        label = "mixed"

    if c2pa.get("has_manifest"):
        attribution = c2pa.get("attribution")
        if attribution == "ai-attributed-unverified":
            reason = ("C2PA-shaped manifest bytes matched an AI-model marker "
                       "(UNVERIFIED — no cryptographic signature check performed)")
        elif attribution == "human-attributed-unverified":
            reason = ("C2PA-shaped manifest bytes matched a camera/hardware marker "
                       "(UNVERIFIED — no cryptographic signature check performed)")
        else:
            reason = "C2PA-shaped manifest present but markers were ambiguous (UNVERIFIED)"
    else:
        if label == "elevated":
            reason = "Elevated periodicity in frequency/temporal-variance analysis (possible upsampling artifact) — unvalidated heuristic"
        elif label == "low":
            reason = "No elevated periodicity detected in frequency/temporal-variance analysis — unvalidated heuristic"
        else:
            reason = "Mixed/inconclusive periodicity signal — unvalidated heuristic"

    return {"score": round(pixel_score, 4), "label": label, "reason": reason}


@app.get("/health")
def health():
    return {"status": "ok", "build": "ensemble-v0.2-unvalidated"}


@app.post("/verify", response_model=VerifyResponse)
def verify(req: VerifyRequest):
    video_url = str(req.video_url)
    logger.info("Verify request for %s", video_url)

    try:
        stream_url = resolve_stream_url(video_url)
    except Exception as exc:
        logger.exception("yt-dlp resolution failed")
        raise HTTPException(status_code=422, detail=f"Could not resolve video stream: {exc}")

    try:
        frames = extract_keyframes(stream_url, KEYFRAME_COUNT)
    except Exception as exc:
        logger.exception("Keyframe extraction failed")
        raise HTTPException(status_code=422, detail=f"Could not extract frames: {exc}")

    logger.info("Extracted %d frames, shape=%s", len(frames), frames[0].shape if frames else None)

    fft_anomaly, fft_signals = fft_periodicity_score(frames[-1] if frames else None)
    logger.info("Tell #1 (FFT periodicity): anomaly=%.4f signals=%s", fft_anomaly, fft_signals)

    temporal_anomaly, temporal_signals = temporal_variance_score(frames)
    logger.info("Tell #2 (temporal variance): anomaly=%.4f signals=%s", temporal_anomaly, temporal_signals)

    head_bytes = fetch_head_bytes(stream_url, HEAD_BYTES)
    c2pa_result = scan_c2pa_manifest(head_bytes)
    logger.info("Tell #3 (C2PA scan): result=%s", c2pa_result)

    verdict = build_verdict(fft_anomaly, temporal_anomaly, c2pa_result)
    logger.info("Final verdict: %s", verdict)

    return VerifyResponse(
        status="ok",
        validated=False,
        score=verdict["score"],
        label=verdict["label"],
        reason=verdict["reason"],
        frame_count=len(frames),
        signals={
            "fft_periodicity": fft_signals,
            "temporal_variance": temporal_signals,
            "c2pa": c2pa_result,
        },
        message=(
            "UNVALIDATED heuristic ensemble — not tested against labeled "
            "real-vs-AI data. Treat score/reason as an investigative "
            "signal, not a determination."
        ),
    )