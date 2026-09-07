<div align="center">

# 🦞 Devil's Eye

### A spatial-intelligence console for planet Earth — forked, rebranded, and extended.

Live aircraft, ships, satellites, earthquakes, fires, radio, public cameras, and
precipitation radar on a photoreal 3D globe — plus hands-free voice control.
Runs locally in your browser from source you can inspect.

</div>

---

## 🕵️ What This Is

**Devil's Eye is an independent fork of [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view)**
by [Bilawal Sidhu](https://github.com/bilawalsidhu). The original project is an
open-source 3D geospatial intelligence client and a canvas for fusing public
signals. This fork keeps that foundation, rebrands it, and extends it with its
own additions.

Big props to the upstream project and its community — this fork exists because
that baseline was excellent to build on.

### What's different in this fork

- **Rebranded UI** — "God's Eye View" → **Devil's Eye**, with a red
  intelligence-console theme (the upstream's cyan accent swept to a spy-tool
  red). Branding, logo, loader, and chrome are ours.
- **Redacted upstream marketing** — this README and the repo metadata describe
  *this* project. The upstream's viral-launch stats, videos, and hosted-product
  pitches belong to the original, not here.
- **Live precipitation radar overlay** — a RainViewer radar imagery layer,
  toggleable from the Display panel (`Radar`), rendered by Cesium with proper
  EPSG:3857 tiling and attribution. Personal/educational use, no key.
- **Dark map stack** — the upstream's direct `tile.openstreetmap.org` stack
  (which returns 403 to browsers that don't meet tile usage policy) is replaced
  with **CartoDB Dark Matter** — keyless, policy-friendly, and on-theme.
- **CCTV SWEEP control** — a "sweep" button jumps to a random camera; hold
  Shift to sweep only the discovered Axis pool. Backed by
  `cctvLayer.sweepCamera({ axisOnly })`.
- **Merged Axis camera catalog** — ~400 discovered public Axis cameras merged
  from Insecam/dork scrapes into `config/cctv_sources_axis.json`, including
  **318 unlocated cameras** that render as frame-only feeds (no globe pin) and
  join the sweep pool. Regenerate with `scripts/merge-axis-catalog.py`.
- **CCTV flash fix** — the projection buffer now uses a single persistent swap
  canvas, eliminating a periodic white-flash frame.
- **Address-search spinner** — the location search shows a spinner while
  resolving.
- **Relaxed Node engine** — `engines.node >=18` (the upstream pin of
  `>=24.14 <25 || >=26 <27` was stricter than Vite needs).

---

## ⚡ Quick Start

**Start without an account or API keys.** Esri satellite imagery + keyless
terrain "just work"; Dark (CartoDB) takes over if Esri is unreachable.
Flights, military traffic, satellites, earthquakes, public cameras, radio,
launches, and the radar overlay are all keyless.

For photorealistic 3D, add a **Cesium ion token** (eligible personal,
non-commercial use) or a **Google Maps key** (metered, direct route, plus
in-app place search). Keys go in through the app's **POWER UP** panel; never a
file edit.

### Terminal / coding agent

```bash
git clone https://github.com/R0U5/Devils-Eye.git
cd devils-eye
npm install
npm run doctor
npm run dev        # or: ./scripts/dev-fresh.sh (clears Vite cache, pulls keys)
```

Open **`http://localhost:4173`**.

Requires **Node.js ≥ 18** (tested through 22–26). The setup doctor warns about
end-of-life Node versions.

### Pinokio

The upstream has Pinokio packaging; this fork doesn't maintain its own
Pinokio manifest — the upstream package remains the easiest serverless route
if you want the original's exact feature set.

---

## 🎛️ What This Thing Does

- **🛩️ Cockpit view:** Ride inside a tracked flight — the camera holds the terrain under you all the way down.
- **📡 Contacts:** A 250 km roster of everything near your target — step through live aircraft and drop into any cockpit.
- **🎯 Click-to-track anything:** Camera locks on, draws a fading trail, surfaces full metadata.
- **🖊️ Voice whiteboard:** Speak annotations onto the world — boundary polygons, marks, routes.
- **🛫 3D hangar:** Real per-class aircraft models — 787, ATR-72, Citation, Bell 206, MQ-9 — swapping from glyph to model as you close in.
- **🎨 Reskin reality:** GLSL sensor looks over the globe — CRT, NVG, FLIR/thermal, Noir, Snow.
- **🟩 Detection overlay:** Screen-space bounding boxes and IDs on everything in view.
- **🎖️ Military HUD + Global Context:** Intelligence-style telemetry and one-switch situational staging.
- **📹 CCTV mesh + SWEEP:** Public cameras projected into 3D — Austin, Caltrans CA, TfL London, plus the discovered Axis pool. Sweep between them with a press of a button.
- **🌧️ Precipitation radar:** RainViewer overlay on globe stacks — toggle in the Display panel.
- **🎥 Scene director + Share Links:** Cinematic camera tours; full view state serialized into a URL.
- **🏠 Reset Globe:** One control — or one sentence — back to a full view of Earth.

---

## 🛰️ What's on the Globe

Keyless by default; some layers accept an optional provider key for more.

| Layer | What you get | Source | Auth |
|-------|--------------|--------|------|
| 🗺️ **Map Stack** | Esri satellite, CartoDB Dark, Google Photorealistic 3D, ion stacks | Esri / CartoDB / Google / Ion | 🟢 Esri + Dark · 🟡 ion Google 3D + terrain · 🔴 direct Google + place search |
| ✈️ **Live Flights** | 11,000+ live aircraft + route history | OpenSky + adsb.lol | 🟢 (🟡 optional credits) |
| 🎖️ **Military Flights** | ADS-B military traffic in amber | adsb.lol | 🟢 |
| 🚢 **Live Vessels** | Ships worldwide | AISStream | 🟡 |
| 🛰️ **Satellites** | 838-object catalog, color-coded by class | CelesTrak | 🟢 |
| 🌍 **Earthquakes** | Global seismic activity, last 24h | USGS | 🟢 |
| 🚗 **Traffic** | Road simulation; TomTom adds live flow speeds | TomTom + OSM | 🟢 sim · 🟡 live speeds |
| 📹 **CCTV Mesh** | ~800 public cameras projected into 3D + ~404 discovered Axis cams (SWEEP) | City APIs / public Axis streams | 🟢 |
| 🌧️ **Radar** | Live precipitation radar overlay | [RainViewer](https://www.rainviewer.com/api.html) (personal/educational use) | 🟢 |
| 📻 **Radio** | Geolocated world radio with an analog tuner | Radio Browser | 🟢 |
| 🚲 **Bikeshare** | Live station availability | GBFS | 🟢 |
| 🔥 **Active Fires** | Live NASA FIRMS detections, trailing 24h | NASA FIRMS | 🟡 |
| 🚀 **Space Missions** | Rolling 30-day launches with payload/stage/recovery detail | Launch Library 2 | 🟢 (🟡 optional) |
| 🎖️ **Mapped Installations** | Viewport-bounded military-site context (incomplete by nature, labeled that way) | OpenStreetMap | 🟢 |

Also on the globe: neighborhood overlays · cockpit WX cloud effect · bundled
static infrastructure (Datacenters 4,351 · Dams 704 · Submarine Cables 712).

---

## 🔑 API Keys

🟢 **No key** · 🟡 **Free key** · 🔴 **Metered**

Use **POWER UP → Provider Settings** to add keys. None is required to start.

| | Key | Why | Get it |
|---|-----|-----|--------|
| 🟡 | **Cesium ion** | Google Photorealistic 3D, world terrain, ion stacks. Free Community plan for eligible personal/non-commercial use | [cesium.com/ion](https://cesium.com/ion) — public `assets:read` token |
| 🔴 | **Google Maps** | Direct Google 3D + place search (Map Tiles API) | [Google Cloud Console](https://console.cloud.google.com/) — URL-restrict it |
| 🔴 | **OpenAI** | Voice + AI HUD summary (metered; the app shows a live session spend, $2 warning, $5 hard cap) | [platform.openai.com](https://platform.openai.com) |
| 🟡 | **AISStream** | Live global ships | [aisstream.io](https://aisstream.io) — free signup |
| 🟡 | **NASA FIRMS** | Live active fires | [firms.modaps.eosdis.nasa.gov](https://firms.modaps.eosdis.nasa.gov) — free key |
| 🟡 | **TomTom** | Live flow speeds / congestion colors | [developer.tomtom.com](https://developer.tomtom.com) — free tier |

`npm run doctor` reports Node/npm readiness and provider routes without
printing credential values. On macOS, `dev-fresh.sh` pulls keys from the
Keychain; otherwise use `.env` (see `.env.example`).

### 💸 What it actually costs

- **Most layers: $0, no signup** — OpenSky anon, USGS, CelesTrak, adsb.lol, city CCTV, Radio Browser, GBFS, Launch Library 2, RainViewer, bundled datasets.
- **Free-key tier: $0 with a signup** — AISStream, FIRMS, TomTom, OpenSky, eligible Cesium ion.
- **Google 3D tiles:** free within an eligible ion Community quota; metered via direct Google key.
- **OpenAI voice: the only real spend** — Realtime audio is a few cents per active minute; evening of heavy use is single-digit dollars. The app meters it (live readout, $2 warning, **$5 hard cap**).

Billing figures change — always check provider pricing pages before relying on them.

---

## 🔧 Under the Hood

- **World-stable icons.** Aircraft and ships point along their real-world heading at every camera angle via per-frame screen-space course projection.
- **Smooth motion from choppy data.** Feeds arrive every 15–30s; the globe renders one interval behind real time and interpolates between fixes, with dead reckoning filling gaps.
- **Honest satellites.** SGP4 propagation; orbit rings stay locked via GMST realignment.
- **Real ground.** Entity heights run through a geoid-aware vertical datum sampled against the rendered terrain mesh.
- **Request budgets.** OpenSky credit governor, TomTom daily tile budget, disk-cached TLEs.
- **Server-side credentials.** Keyed APIs (OpenAI, AISStream, OpenSky OAuth, camera frames) are brokered through a hardened server-side proxy with SSRF protection and response caps. Only Google Maps + Cesium ion keys ever reach the browser (restrict both at the provider).
- **No framework.** Vanilla JavaScript, CesiumJS, Vite — plus Google Photorealistic 3D Tiles, and OpenAI Realtime for voice.

```
src/
├── main.js                 # Bootstrap: tiles, layer registration, window.__devilsEyeView
├── ui.js                   # Runtime UI — panels, HUD, styles, control facade
├── mapStackController.js   # Basemap switching — Esri / Dark / Google 3D / ion stacks
├── data/                   # One module per layer + orchestration + context store
│   ├── cctv.js             # CCTV activation, projection, frustum math, SWEEP
│   ├── rainViewerOverlay.js# Precipitation radar overlay (UrlTemplateImageryProvider)
│   └── local_data/         # Bundled datasets (per-folder provenance)
├── voice/                  # OpenAI Realtime session + voice tools
└── scenes/                 # Cinematic scene director
```

See [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md) for the authoritative runtime reference.

---

## ⚠️ Responsible Use

Devil's Eye runs on **public data, clear sources, and local-first execution.**
Anything involving a private key is brokered server-side. It models **events,
assets, infrastructure, and systems** — aircraft, vessels, satellites, fires,
cameras, cities. It does not build features for named-person search, face
recognition, or tracking individuals.

> [!IMPORTANT]
> Devil's Eye is an exploratory visualization of public and third-party data.
> Data may be delayed, incomplete, modeled, inferred, or wrong. Do not use it
> for flight or maritime navigation, emergency response, medical or health
> decisions, investment decisions, or other safety-critical or operational
> purposes. Verify important information with authoritative sources.

**Status:** an evolving open-source client for exploration and learning — a
fast, hackable foundation, not a hardened production service. Released under
the **[MIT License](LICENSE)**. Live datasets carry their own terms — see
**[DATA_SOURCES.md](DATA_SOURCES.md)**. Security model:
**[SECURITY.md](SECURITY.md)**.

**Not this repo:** the upstream project's hosted product, commercial offers,
and marketing presence at [Halfpixel](https://halfpixel.ai) are entirely the
original authors'. This fork points at the original wherever it matters and
stays otherwise independent.

---

## 🙏 Upstream Attribution

This fork is built on **God's Eye View** by **Bilawal Sidhu**:

- Original repo: [github.com/bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view)
- Original author: [@bilawalsidhu](https://github.com/bilawalsidhu) · [Halfpixel](https://halfpixel.ai)

We keep the upstream's MIT license terms for the code this fork derives from,
and its data-source attributions live in `DATA_SOURCES.md`. If you like what
you see here, check out the original too — this fork stands on it.

---

<div align="center">

**🦞 Devil's Eye — watch the world live, from your own terminal.**

</div>
