# Big Pickle — EVOL Eye Optimization Pass

Repo: `~/.openclaw/workspace/Devils-Eye` | Branch: `feat/optimization-pass` (off `main` @ fd12024)
Contract: systematic optimization sweep across the codebase. Conventional commits. DO NOT push (GitHub auth works now but per protocol: PM merges after review). Report when done.

## Scope (PM-vetted priorities)

### 1. Bundle size / load performance
- **Vite build analysis**: run `npm run build && npx vite-bundle-analyzer dist` (or `rollup-plugin-visualizer`) — identify heavy chunks
- **Dynamic imports**: audit `src/` for modules that should be lazy-loaded (e.g., heavy layers like `cctv.js`, `flights.js`, `satellites.js`, `traffic.js` — currently all eager?)
- **Code splitting**: ensure vendor chunks are split sensibly; check for duplicate deps
- **Tree-shaking**: verify no dead code in production build (sideEffects in package.json?)

### 2. Runtime render performance (Cesium globe is the bottleneck)
- **Frame budget**: current target 60fps (16.67ms). Profile `requestAnimationFrame` loop in `mapStackController.js` / `src/ui.js` render path
- **Entity/primitive count**: audit `BillboardCollection`, `PointPrimitiveCollection`, `Entity` usage — Cesium entities are expensive; primitives preferred for high-volume (flights, satellites, vessels)
- **CCTV frame pipeline**: `cctv.js` MJPEG/JPEG decode → texture upload — check for unnecessary re-decodes, double-buffering, offscreen canvas reuse
- **Traffic layer**: `traffic.js` dot rendering — `MAX_DOTS=6000`, per-frame canvas draws; verify adaptive cap (from P0.3) is actually active and not overhead
- **Shader complexity**: any custom Cesium materials/shaders? Minimize uniform updates per frame

### 3. Memory / leak hygiene
- **Event listener cleanup**: grep `addEventListener` without matching `removeEventListener` in `destroy`/`disable` methods
- **Cesium resource disposal**: `viewer.destroy()`, `scene.primitives.removeAll()`, `imageryLayers.removeAll()` — verify all layers clean up on disable
- **Cache bounds**: verify LRU/TTL caps on `terrainHeightsProxy`, `adsbdb`, `tomtom` tile caches are enforced (P0.1/P0.3 added caps — confirm they work)
- **WebGL context loss**: any handling? (nice-to-have)

### 4. Network / API efficiency
- **Request deduplication**: `refreshCctvSources()`, `loadAxisCatalogFromFile()` — are concurrent calls deduplicated?
- **Overpass/traffic**: P0.3 added prefetch ring — verify it cancels on camera move (AbortController)
- **Nominatim geocode**: rate-limit backoff + cache (localStorage?) — currently hits API on every search?
- **CelesTrak TLE / OpenSky / USGS**: polling intervals reasonable? Exponential backoff on errors?

### 5. CSS / layout
- **Reflow triggers**: audit `style.css` for forced synchronous layouts (offsetWidth/Height in loops, getComputedStyle in RAF)
- **Animation performance**: `transform`/`opacity` only for animated elements; check `.cctv-frame-shimmer`, panel expand/collapse transitions
- **Unused CSS**: purge dead rules (PurgeCSS or manual audit) — the codebase has accumulated

## Constraints
- **Do NOT change**: upstream attribution, `.env*`, `config/`, `dist/`, docs, logo, repo URL
- **Preserve**: all existing functionality, test parity (2795 pass baseline)
- **Focus**: measurable wins (bundle KB, frame ms, memory MB, request count)
- **Report**: per-area findings, before/after numbers (or "no win — already optimal"), files changed

## Test gate
`npm test` MUST stay 2795 pass / 0 fail / 1 skip. CI must pass.