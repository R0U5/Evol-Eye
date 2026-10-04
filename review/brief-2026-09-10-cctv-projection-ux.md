# Big Pickle — SPRINT: EVOL Eye CCTV panel + projection fixes (4 issues)

**Repo:** `~/.openclaw/workspace/Devils-Eye` | **Branch:** cut `fix/cctv-projection-ux` off `main`

## Issue 1 (P0) — Projected monitor-plane feed is NOT live (sidebar is)
**Reported by Billy:** Clicking a CCTV/access cam — the projected 3D monitor plane shows periodic stills, but the **sidebar CCTV window streams the SAME camera live** (MJPEG). Expected: the projected plane streams live like the sidebar.

**PM recon — verified architecture:**
- Sidebar path (WORKS): `getPublicCameraState` (~4068) → `feedType = normalizeFeedType(camera.feedType)` → `isLiveJpeg` → binds `mediaUrlFor(camera, SIDEBAR_FEED_RESOLUTION)` (960x540) to a real `<img>`. Browser decodes multipart/x-mixed-replace natively.
- Projection path (FROZEN): `createProjectionRuntime` (~2130) derives `mode`; if `live-jpeg` → `openLiveJpegConnection` (~2303) sets `liveImg.src = mediaUrlFor(camera, PROJECTION_FEED_RESOLUTION)` (1280x720). The RAF loop (`startProjectionLoop` ~2602) calls `ensureProjectionRuntime` → `drawProjectionFrame` → `refreshProjectionTextures` each tick.
- **KEY SUSPECTS (verify in order):**
  1. **`drawProjectionFrame` (~1641-1690)** — check whether the live-jpeg `<img>` is actually drawn to the projection canvas each RAF, and whether `liveFrameCount`/`lastDrawnLiveFrame`/`canvasStamp` correctly advance when new MJPEG frames arrive. If `runtime.image` isn't being drawn (or the stamp doesn't increment on img load), the canvas never changes → `refreshProjectionTextures` sees unchanged `canvasStamp` and never swaps → frozen stills. **This is the most likely root cause.**
  2. **`openLiveJpegConnection`** — verify `runtime.image` exists (is the `<img>` created in `createProjectionRuntime` for live-jpeg mode?) and that `liveImg.onload`/`onerror` wiring updates `canvasStamp`. If the img element is null/never bound, the MJPEG stream never reaches the canvas.
  3. **`refreshProjectionTextures` (~1638)** — confirm the canvasStamp guard isn't blocking live-jpeg (it skips the 1Hz throttle for live-jpeg, but the `canvasStamp === lastSwappedCanvasStamp` early-return could still block if the canvas isn't changing).
  4. **`PROJECTION_FEED_RESOLUTION`** — confirm 1280x720 MJPEG actually streams from the proxy (sidebar uses 960x540 and works; if the 720p upstream is broken/frozen, that's the divergence).
- The Axis fix (merged 13893b8) made the runtime health-aware — so mode should be `live-jpeg` for MJPEG cams now. If it's still `image`, the projection uses `refreshProjectionImage` (10s stills) — that would ALSO explain frozen projection while sidebar is live. **Check which mode the projection runtime actually has at runtime.**
- **Constraint:** do NOT break the sidebar. Do NOT break the 2-slot live cap (`LIVE_MEDIA_CONNECTION_CAP`). Do NOT regress image/video cameras. Keep `npm test` at 2796/0/1 (+ any new tests).

## Issue 2 (P1) — "Attempting to connect..." overlay while feed loads
**Reported by Billy:** When a user clicks a camera and the feed isn't up yet, show a **blacked-out overlay on the projected monitor plane** with **red "Attempting to connect..."** text — spy-tool aesthetic, matching the app's existing tactical chrome (CCTV monitor border, source labels, cyan/red accents).

**PM recon:**
- Projection placeholder machinery already exists: `paintProjectionPlaceholder` (~1720, draws state text like 'no-feed'/'loading'/'error'), `PLACEHOLDER_REPAINT_MS` throttle (~140), `paintProjectionChrome` (~1795, surveillance-monitor border/branding).
- The placeholder already paints states — verify it currently draws a "loading/attempting" message for a connecting camera, and if so, restyle it per Billy's spec (full black plane + red "ATTEMPTING TO CONNECT..." like a real spy feed). If it doesn't cover the connecting state, add it.
- Match existing chrome style: mono font, letter-spacing, red `#ff2d2d`/cyan accents already used in the app. Should read like a security-cam boot screen.

## Issue 3 (P1) — ENHANCE button = 2x window (was 130%)
**Reported by Billy:** The ENHANCE button should make the CCTV panel **double its default size** (200%), not 130%.

**PM recon:**
- `style.css:6092` `#cctv-panel.enhanced { --cctv-enhance-scale: 1.3; }` — change to **2.0**.
- `style.css:4607` comment mentions clamping after scaling so enhanced panel fits viewport — verify 2.0 still clamps sensibly on small screens (the CSS `--cctv-enhance-scale` is consumed by the panel/frame sizing; check where it's applied and that 2.0 doesn't break layout at max-height `calc(100vh - 24px)`).
- Button label logic is in `src/ui.js:6291` (toggles 'enhanced' class + label ENHANCE/ENHANCED) — that's fine, just the scale constant changes.

## Issue 4 (P2) — Address-processing spinner pinned far right of the address area
**Reported by Billy:** The spinning wheel that shows while resolving an address displays all the way to the right of the address area (escaping its intended position).

**PM recon:**
- Spinner CSS: `style.css:942-958` `.location-search-spinner { position: absolute; right: 10px; top: 50%; ... }`.
- HTML: `index.html:574-579` — `.location-search-wrap` contains a toggle button + `#location-search` input + `#location-search-spinner`.
- **Suspect:** `.location-search-spinner` uses `position: absolute` but its containing `.location-search-wrap` (style.css:1911) has **no `position: relative`** → the absolute spinner positions against the nearest positioned ancestor (or the viewport), pushing it far right/out of the input. **Fix:** add `position: relative` to `.location-search-wrap` (or position the spinner against `#location-search` specifically). Verify in both contexts: the generic search wrap (1911) and `#command-dock .location-search-wrap` (7423).

## Constraints
- Scope: `src/ui.js`, `src/data/cctv.js`, `style.css`, `index.html` (if needed). Tests: `src/data/cctv.test.mjs`.
- Conventional commits, clean series on `fix/cctv-projection-ux` off `main`.
- `npm test` must stay green (2796/0/1 baseline; add tests for new behavior, especially Issue 1's frame-draw path if a test seam exists).
- DO NOT push to main. PM merges after Specs sign-off.
- Report DONE per-issue: root cause, fix, files+lines, test results, and how you verified the projection actually streams (e.g. unit test on the draw path or a documented manual verification).

## Team
- **Big Pickle (you):** all 4 fixes
- **Hackerman:** only if Issue 1 touches connection/security surface (otherwise skip)
- **Specs:** QA gate on the whole sprint before PM merge
- **Billy:** confirmed sidebar works live; projection is the broken display path.