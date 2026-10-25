# Earth View Online Locator (EVOL) Eye

EVOL Eye is an open‑source 3D globe that visualises live public data streams directly in the browser. It displays aircraft, ships, satellites, earthquakes, fires, radio transmissions, public cameras, and precipitation radar while keeping all processing local.

## Project Overview

EVOL Eye is an independent fork of [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) by Bilawal Sidhu. This fork rebrands the project, refines the interface, and adds new capabilities while preserving upstream credit. All upstream code retains its original MIT license; this fork's additions are MIT as well.

![Original gif](https://github.com/bilawalsidhu/gods-eye-view/blob/main/docs/media/hero-open-source-reveal.gif)
## Capabilities

| Capability | Status | Notes |
|---|---|---|
| Live aircraft (ADS-B) | Operational | OpenSky + ADS-B Exchange feeds, paced updates |
| Maritime (AIS) | Operational | AISHub + custom streams, ship tracks |
| Satellites / orbital | Operational | TLE propagation, ground tracks, visibility windows |
| Earthquakes | Operational | Real-time USGS feed, intensity rings |
| Fires | Operational | MODIS/VIIRS hotspots, perimeter polygons |
| Radio / SDR | Operational | RadioReference + custom scanners, frequency database |
| Public CCTV | Operational | Publicly listed Axis cameras, live MJPEG projection |
| Precipitation radar | Operational | RainViewer layer, no API key required |
| Voice control | Operational | Web Speech API + local hotword, hands-free |
| Windows installer | Operational | Single-file exe (Go + WebView2), CI-built, Release asset |

## What Is Different in This Fork

- **Rebranded interface.** Added red theme (upstream's cyan) and updated branding, logo, and loader.
- **Dark map stack.** Upstream's `tile.openstreetmap.org` (which 403s for non-compliant browsers) is replaced with CartoDB Dark Matter — keyless and policy-friendly.
- **Precipitation radar overlay.** RainViewer radar imagery, toggleable from Display Settings. No API key; personal/educational use per RainViewer's terms. Unavailable honestly when the current map stack cannot render it.
- **Public CCTV layer.** Sweep controls, click-to-focus camera flights, and a health-aware projection runtime: cameras serving live MJPG streams auto-upgrade to live feeds; unreachable cameras show a clear "no signal" state instead of failing silently.
- **Address search normalization.** Query variations resolve to a canonical address, with explicit city/state validation so a hit in the wrong metro area is rejected.
- **Installer improvements.** A single-file Windows executable (Go + WebView2 wrapper) built in CI with checksummed toolchains; a fine-grained GitHub PAT with `contents:read` works for installer source downloads.

## Quick Start

```bash
git clone https://github.com/R0U5/Evol-Eye.git
cd Evol-Eye

npm ci          # install dependencies (Node 22+)
npm run dev     # dev server on port 4173
npm run build   # build release bundle
npm test        # run tests
```

Cesium ion token or Google Maps Platform key are optional (they enable the photoreal 3D Tiles stack). RainViewer radar, CCTV, OpenSky, AISHub, USGS, and FIRMS all work keyless by default.

### Windows one-click install

Grab **`Evol-Eye-Installer.exe`** from the [Releases page](https://github.com/R0U5/Evol-Eye/releases):

- Single-file Windows executable (Go + WebView2); no Node or source clone needed
- CI-built and checksummed, with a `SHA256SUMS.txt` attached to each `exe-v*` tag
- Toolchain tarballs checksum-verified and actions SHA-pinned

The legacy cross-platform installer (Windows/macOS/Linux) is still available via `npm run build:installer`.

## Repository Structure

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
│   └── manifest.json       # Repo metadata
├── config/
│   └── cctv_sources_axis.json    # Public Axis camera catalog
├── scripts/
│   └── merge-axis-catalog.py     # Regenerate the Axis camera catalog
├── docs/
│   ├── media/              # Demo media
│   └── CURRENT-STATE.md    # Living architecture doc
├── public/
│   └── logo.svg            # EVOL Eye logo (globe pupil + concentric rings)
├── package.json            # name: evol-eye, version: 0.1.1
└── LICENSE                 # MIT (upstream compatible)
```

## Optional Keys

| Key | Purpose | Required? |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | Photoreal 3D Tiles | No — Cesium ion fallback |
| `CESIUM_ION_TOKEN` | Ion-hosted 3D Tiles | No — keyless dark stack default |
| `OPENAI_API_KEY` | Voice LLM fallback | No — local Web Speech default |
| `AISSTREAM_API_KEY` | Enhanced AIS maritime | No — AISHub keyless |
| `TOMTOM_API_KEY` | Enhanced geocoding | No — Nominatim keyless |
| `OPENSKY_CLIENT_SECRET` | Enhanced OpenSky | No — anonymous works |
| `LL2_API_TOKEN` | Lightning detection | No — optional |

A fine-grained GitHub PAT with `contents:read` on `R0U5/Evol-Eye` is required for installer source downloads while the repo is private; provide it via the installer UI, `--token`, or the `GEV_INSTALLER_TOKEN` env var. (Once the repo is public, the standard archive URL is used and no token is needed.)

## Testing & Verification

```bash
npm test                # full test suite
npm run installer:test  # installer-specific tests
npm run lint
```

CI: GitHub Actions across Node 24/26, installer tests (macOS/Ubuntu/Windows), and Windows onboarding. All must pass.

## Privacy & Security

- No telemetry — no phone-home, no analytics, no crash reporting.
- Local-first — all feeds are fetched client-side; the dev server only serves static assets and the CCTV proxy.
- The fine-grained GitHub PAT is never logged and never persisted to disk (in-memory only during install).
- The CCTV proxy binds to localhost, rejects non-loopback connections, and validates the `Host` header.
- See [SECURITY.md](SECURITY.md) for coordinated disclosure.
- See [DISCLAIMER.md](DISCLAIMER.md) for usage terms and liability.

## License & Attribution

- Original: [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) by [Bilawal Sidhu](https://github.com/bilawalsidhu)
- This fork: EVOL Eye by R0U5

Both are MIT. See [LICENSE](LICENSE).
