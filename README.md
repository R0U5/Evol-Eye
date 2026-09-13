<div align="center">

# 🦞 **EVOL EYE**

### **EARTH VIEW ONLINE LOCATOR** — *CLASSIFIED // NOFORN*

**A SPATIAL-INTELLIGENCE CONSOLE FOR PLANET EARTH**

*Live aircraft · ships · satellites · earthquakes · fires · radio · public cameras · precipitation radar on a photorealistic 3D globe — hands-free voice control. Runs locally in your browser from source you can inspect.*

</div>

---

## 🔐 **PROJECT CLASSIFICATION**

> **EVOL (Earth View Online Locator) Eye** is an **independent fork** of [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) by [Bilawal Sidhu](https://github.com/bilawalsidhu).
>
> The original project is an open-source 3D geospatial intelligence client and a canvas for fusing public signals. This fork keeps that foundation, rebrands it under the **EVOL** designation, and extends it with classified-grade additions.
>
> **Big props to the upstream project and its community** — this fork exists because that baseline was excellent to build on. All upstream credit preserved per MIT license.

---

## 📋 **WHAT'S IN THE DOSSIER**

| Capability | Status | Notes |
|---|---|---|
| **Live Aircraft / ADS-B** | ✅ OPERATIONAL | OpenSky + ADS-B Exchange feeds, paced updates |
| **Maritime / AIS** | ✅ OPERATIONAL | AISHub + custom streams, ship tracks |
| **Satellite / Orbital** | ✅ OPERATIONAL | TLE propagation, ground tracks, visibility windows |
| **Seismic / USGS** | ✅ OPERATIONAL | Real-time earthquake feed, intensity rings |
| **Fire / FIRMS** | ✅ OPERATIONAL | MODIS/VIIRS hotspots, perimeter polygons |
| **Radio / SDR** | ✅ OPERATIONAL | RadioReference + custom scanners, frequency DB |
| **Public CCTV / Axis** | ✅ OPERATIONAL | ~400 discovered cameras, live MJPEG projection, ENHANCE 2.0x, sweep pool |
| **Precipitation Radar** | ✅ OPERATIONAL | RainViewer layer, Cesium EPSG:3857 tiling, no key |
| **Voice Control** | ✅ OPERATIONAL | Hands-free, Web Speech API + local hotword |
| **Windows EXE Installer** | ✅ OPERATIONAL | Single-file .exe (Go + WebView2), no Node needed, Release asset on `exe-v*` tags |

---

## 🕵️ **WHAT'S DIFFERENT IN THIS FORK**

### **1. REBRANDED UI — INTELLIGENCE CONSOLE AESTHETIC**
- **"God's Eye View" → EVOL EYE** — red intelligence-console theme (upstream's cyan swept to spy-tool red)
- **Branding, logo, loader, chrome** — all EVOL, classified dossier styling
- **Evil-eye logo** — concentric iris rings around the globe pupil, tracks pointer gaze
- **Visual Presets grid** — FLIR-style buttons (Normal / CRT / NVG / FLIR / Anime / Noir / Snow)

### **2. REDACTED UPSTREAM MARKETING**
- This README and repo metadata describe **THIS** project only
- Upstream's viral-launch stats, videos, hosted-product pitches → **REDACTED** (belong to original)
- Repo name: **`Evol-Eye`** (GitHub: `R0U5/Evol-Eye`) — repo NOT renamed from upstream; intentional

### **3. LIVE PRECIPITATION RADAR OVERLAY**
- RainViewer radar imagery layer, toggleable from **Display Settings → Visual Presets → RADAR**
- Cesium EPSG:3857 WebMercator tiling, proper attribution
- **No API key** — personal/educational use only per RainViewer TOS
- **Photoreal honesty:** on Google 3D Tiles stack (`globe.show=false`), radar unavailable (imagery layers can't render over 3D tiles). Button shows **UNAVAILABLE** state honestly — no silent no-ops.

### **4. DARK MAP STACK — OPSEC FRIENDLY**
- Upstream's `tile.openstreetmap.org` (403s to non-compliant browsers) → **REPLACED**
- **CartoDB Dark Matter** — keyless, policy-friendly, on-theme dark basemap
- No API keys required for baseline operation

### **3. CCTV SWEEP CONTROL — TACTICAL SWEEP**
- **"SWEEP" button** — jumps to a random camera; hold **Shift** to sweep only the discovered Axis pool
- Backed by `cctvLayer.sweepCamera({ axisOnly })`
- **Click-to-focus ALWAYS flies** — clicking any camera icon/card flies to optimal observation angle (even re-click on active)
- **Auto-hop moves the view** — timed hops fly the globe to next camera when location known

### **4. MERGED AXIS CAMERA CATALOG — TACTICAL ASSET**
- **~400 discovered public Axis cameras** merged from Insecam/dork scrapes into `config/cctv_sources_axis.json`
- **318 unlocated cameras** render as frame-only feeds (no globe pin) → join sweep pool
- Regenerate catalog: `scripts/merge-axis-catalog.py`

### **5. AXIS MJPG SNAPSHOT EXTRACTION — SIGINT TRADECRAFT**
- Discovered Axis cameras serve `multipart/x-mixed-replace` MJPG **streams** (e.g. `…/mjpg/video.mjpg`)
- Previously hung proxy until 8s timeout → **ALL cameras fell through to synthetic "UPSTREAM UNAVAILABLE"**
- Proxy now: (1) probes Axis still endpoints (`/mjpg/1/image.jpg`, `/axis-cgi/jpg/image.cgi`), then (2) buffers stream just long enough to extract **first complete JPEG frame**
- Remaining unreachable cameras → **red NO SIGNAL** state (visible degradation, not silent failure)

### **6. LIVE AXIS MJPEG PROJECTION — HEALTH-AWARE UPGRADE**
- Projection runtime is **health-aware**: when a discovered Axis camera serves a real `multipart/x-mixed-replace` MJPG stream, the frozen snapshot plane **auto-upgrades to live-jpeg**
- Live redraw via **RAF change-tolerant frame signature** — no flashing on refresh
- **"ATTEMPTING TO CONNECT"** overlay while a live feed loads; **ENHANCE toggle 2.0x** scales panel + feed
- Scrollable location popover; spinner anchored to its own flex slot
- Unhealthy / plain-HTTP cameras stay on paced snapshots — live relaying only when the source is healthy

### **7. VISIBLE FEED STATES — SITUATIONAL AWARENESS**
- **Awaiting first frame** → cyan **LOADING…** placeholder
- **Fetch failed, no prior frame** → red **NO SIGNAL** placeholder
- **Once worked, now fails** → keeps last good frame on monitor (persistence)

### **8. CONSOLE DEBUG OUTPUT — TRADECRAFT TRANSPARENCY**
- Failures are **no longer silent**
- `CCTV_PROXY_DEBUG=1` (dev server) or `window.__CCTV_DEBUG__ = true` (console) → traces per-camera frame fetches + load results

### **9. ADDRESS SEARCH NORMALIZATION — ANALYST WORKFLOW**
- Variations normalize to canonical backend address: `[address redacted]`, `[address redacted]`, `[address redacted]` → all resolve to **[address redacted]**
- Camera-fence bypass for fully-qualified addresses (street number + city/state/zip) — no more "no address found" when camera is elsewhere
- Abbreviation expansion: `sac`→`sacramento`, `cal`→`california`, `ca`→`california`, `5rd`→`5th` (malformed ordinal fix)
- Result validation: explicit city/state in query validated against geocode result — Chicago hit on Sacramento query = **REJECTED**

### **10. FINE-GRAINED GITHUB TOKEN FIX — INSTALLER OPSEC**
- Installer downloads source via GitHub REST API `zipball` endpoint (`api.github.com/repos/…/zipball/…`)
- **Fine-grained PATs with `contents:read` now work** — fixed cross-origin redirect Authorization header stripping (github.com → codeload.github.com)
- Public repos: unchanged archive URL; Private repos: API zipball endpoint (signed codeload redirect, no auth needed on hop-2)

---

## 🚀 **QUICK START**

```bash
# Clone the classified repo
git clone https://github.com/R0U5/Evol-Eye.git
cd Evol-Eye

# Install deps (Node 22+)
npm ci

# Dev server (port 4173)
npm run dev

# Build release bundle
npm run build

# Installer build (creates platform installers)
npm run build:installer

# Run tests
npm test
```

**Requires Node 22+**. Cesium ion token or Google Maps Platform key optional (enables photoreal 3D Tiles stack). RainViewer radar, CCTV, OpenSky, AISHub, USGS, FIRMS — all keyless by default.

### **WINDOWS ONE-CLICK INSTALL — SINGLE-FILE EXE**

No Node, no browser install, no source clone. Grab **`Evol-Eye-Installer.exe`** from the [Releases page](https://github.com/R0U5/Evol-Eye/releases):

- **Single-file Windows executable** — Go + WebView2 wrapper; production bundle embedded in the binary
- **No Node needed** — WebView2 runtime ships with Win11; Win10 installs it automatically on first run
- **CI-built & checksummed** — cross-compiled with Zig, headless selftest on Linux + Windows runner, `SHA256SUMS.txt` attached on `exe-v*` tags
- **Supply-chain hardened** — toolchain tarballs checksum-verified, actions SHA-pinned, stripped exe
- Legacy cross-platform installer (Win/macOS/Linux) still available via `npm run build:installer`

---

## 🗂 **REPO STRUCTURE (CLASSIFIED OVERVIEW)**

```
Evol-Eye/
├── src/                    # Core application (ESM)
│   ├── data/               # Feeds: aircraft, ships, sats, quakes, fires, radio, CCTV, radar
│   ├── scenes/             # Globe scene management
│   ├── voice/              # Hands-free voice control pipeline
│   ├── ui.js               # Main UI controller, radar toggle, visual presets
│   └── main.js             # App bootstrap
├── installer/              # Installers: legacy cross-platform + single-file Windows exe
│   ├── core.mjs            # Manifest, download, auth
│   ├── runner.mjs          # Install orchestration
│   ├── main.go             # Single-file Windows exe (Go + WebView2 wrapper)
│   ├── go.mod              # Pins webview_go 0.10.0 (vendored)
│   ├── vendor/             # Hermetic Go deps (patched EventToken.h)
│   └── manifest.json       # Repo metadata (private: true)
├── config/
│   └── cctv_sources_axis.json    # ~400 Axis camera catalog
├── scripts/
│   └── merge-axis-catalog.py     # Regenerate Axis catalog
├── docs/
│   ├── media/              # Demo GIFs (58 MB — LFS candidate)
│   └── CURRENT-STATE.md    # Living architecture doc
├── public/
│   └── logo.svg            # Evil-eye logo (globe pupil + concentric rings)
├── package.json            # name: evol-eye, version: 0.1.1
└── LICENSE                 # MIT (upstream compatible)
```

---

## 🔑 **OPERATIONAL KEYS (OPTIONAL)**

| Key | Purpose | Required? |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | Photoreal 3D Tiles (Google 3D Tiles) | ❌ — Cesium ion fallback |
| `CESIUM_ION_TOKEN` | Ion-hosted 3D Tiles / imagery | ❌ — keyless dark stack default |
| `OPENAI_API_KEY` | Voice LLM fallback | ❌ — local Web Speech default |
| `AISSTREAM_API_KEY` | Enhanced AIS maritime | ❌ — AISHub keyless |
| `TOMTOM_API_KEY` | Enhanced geocoding | ❌ — Nominatim keyless |
| `OPENSKY_CLIENT_SECRET` | Enhanced OpenSky | ❌ — anonymous works |
| `LL2_API_TOKEN` | Lightning detection | ❌ — optional |

> **Fine-grained GitHub PAT** with `contents:read` on `R0U5/Evol-Eye` required for **installer source download** when repo is private. Provide via installer UI, `--token`, or `GEV_INSTALLER_TOKEN` env var.

---

## 🔬 **TESTING & VERIFICATION**

```bash
# Full test suite (2807 tests)
npm test

# Installer-specific tests (47 cases)
npm run installer:test

# Type checking (if tsconfig present)
npm run typecheck

# Lint
npm run lint
```

**CI:** GitHub Actions — Node 24/26, Installer tests (macOS/Ubuntu/Windows), Windows onboarding. All must pass.

---

## ⚙️ **PERFORMANCE & RELIABILITY — OPTIMIZATION PASS**

A dedicated optimization pass (merged Sep 10) cut wasted work across the render, data, and bundle paths:

- **Traffic render-hold release + viewport culling** — animation loop no longer held by stale dot sets; off-screen work culled
- **Terrain height cache LRU cap** — in-memory height cache bounded (10k entries)
- **Flow-tile in-flight dedup** — concurrent identical tile fetches collapse to one
- **CCTV canvas blit skip** — video projection feeds skip wasted canvas redraws
- **Abort-on-disable** — earthquakes / FIRMS / missions poll fetches honor manager abort signal
- **Radar listener detach** — StyleManager dispose no longer leaks state listeners
- **Cloud loop 12fps throttle** — independent cloud render cadence capped
- **Chunked vendor build** — satellite.js / mgrs / pbf / vector-tile split into cache-stable chunk
- **CSS dead-selector purge** — dropped layout-promoting `will-change` on ring outline
- **Voice geocode/nearby LRU bounding** — reverse-geocode + nearby-places caches bounded

**Test gate:** 2806 pass / 0 fail / 1 skip (was 2795).

---

## 📜 **LICENSE & ATTRIBUTION**

**MIT License** — compatible with upstream [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) (MIT).

> **UPSTREAM CREDIT (MANDATORY):**
> - Original: [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) by [Bilawal Sidhu](https://github.com/bilawalsidhu)
> - This fork: EVOL Eye by R0U5

All upstream code retains its original MIT license. This fork's additions are MIT.

---

## 📡 **COMMUNICATIONS SECURITY**

- **No telemetry** — zero phone-home, zero analytics, zero crash reporting
- **Local-first** — all feeds fetched client-side; dev server only serves static assets + CCTV proxy
- **Fine-grained GitHub PAT** never logged, never persisted to disk (in-memory only during install)
- **CCTV proxy** binds localhost, rejects non-loopback, validates `Host` header

---

## 📞 **CONTACT / DEBRIEF**

- **Issues:** GitHub Issues (operational only — no feature requests without design doc)
- **Security:** `SECURITY.md` — coordinated disclosure
- **Upstream:** [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) — watch for baseline improvements

---

<div align="center">

**EVOL EYE v0.1.1** — *EARTH VIEW ONLINE LOCATOR*

**CLASSIFIED // NOFORN // REL TO EVOL EYE PERSONNEL ONLY**

*Earth View Online Locator — because the planet doesn't watch itself.*

</div>