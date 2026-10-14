# 🛡️ Authentic Hub: AI Forensic Infrastructure

**Authentic Hub** is a full-stack generative media verification system designed to restore digital trust on social platforms. It utilizes a real-time browser extension and a high-performance Python backend to detect synthetic artifacts in short-form video feeds.

---

## 🚀 The Vision
As generative AI reaches a tipping point, social feeds are increasingly flooded with "synthetic slop"—low-quality, unverified AI content that erodes consumer trust. Authentic Hub provides a **Digital Trust Layer**, allowing users to verify content authenticity without interrupting their natural browsing experience.

---

## 🛠️ Technical Architecture
The system employs a **Dual-Stage Verification Pipeline** to navigate the challenges of platform-level security and high-compression video laundering.

### 1. The Frontend (JavaScript / Chrome Manifest V3)
- **Non-Invasive UI:** Injects a glassmorphism "Forensic Pill" overlay directly into Instagram and TikTok UI components using high-performance `MutationObservers`.
- **Asynchronous Resolver:** Implements a resilient permalink seeker to bypass platform-level `blob:` URL security, enabling server-side access to public media streams.
- **Graceful Degradation:** When remote verification is blocked by CORS/CSP policies, the client automatically falls back to a **Local Heuristic Engine** performing pixel-level temporal analysis.

### 2. The Backend (Python / FastAPI / PyTorch)
- **Spectral Flatness Analysis (FFT):** Uses Fast Fourier Transforms to identify "checkerboard artifacts" in the frequency domain—mathematical signatures left by generative upsampling layers (GAN/Diffusion models).
- **Deep Learning Inference:** Integrates **Vision Transformers (ViT)** via the `timm` library to classify spatial inconsistencies in high-compression feeds.
- **C2PA Signature Scanning:** Performs cryptographic provenance checks for JUMBF metadata, distinguishing between hardware-attested origins (e.g., iPhone, Sony) and AI model attribution.
- **System Optimization:** Utilizes an **SQLite persistent caching layer** to store forensic reports for viral content, reducing redundant compute costs by ~75%.

---

## 🔬 Forensic "Tells" Analyzed
- **Temporal Incoherence:** Detecting "background shimmer" where AI models fail to maintain pixel consistency across frames.
- **High-Frequency Periodicity:** Identifying regular structural peaks in the power spectrum associated with synthetic image synthesis.
- **Cryptographic Metadata:** Reading the "Digital Birth Certificate" of files to verify author identity and hardware provenance.

---

## 🔧 Installation & Setup

### 1. Backend Server (`hub-cloud`)
```bash
# Clone the repository
git clone [https://github.com/josuedrob55/authentic-hub.git](https://github.com/josuedrob55/authentic-hub.git)
cd authentic-hub/hub-cloud

# Install required dependencies
python3 -m pip install fastapi uvicorn yt-dlp opencv-python numpy scipy torch timm

# Start the local development server
python3 -m uvicorn main:app --reload --port 8000
