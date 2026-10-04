# Big Pickle — BUG: Projected Axis video not streaming realtime (monitor plane frozen/still)

**Repo:** `~/.openclaw/workspace/Devils-Eye` | **Branch:** cut `fix/axis-projection-live` off `main`

## Reported bug (Billy, 2026-09-10)
The **projected monitor-plane video from Axis cams does not stream in real time** — it shows periodic stills (snapshot cadence). The **sidebar CCTV window DOES stream real time** (MJPEG live) for the same cameras. Expected: the projected plane streams live like the sidebar.

## PM recon — architecture facts (verified, trust these)
1. **Mode is derived ONCE** in `createProjectionRuntime` (src/data/cctv.js ~2140):
   `const mode = feedType === 'mjpeg' ? 'live-jpeg' : (isVideoFeedType(feedType) ? 'video' : 'image');`
   The runtime object holds `mode` forever. `ensureProjectionRuntime` re-activation only reopens a live connection **if mode is already 'live-jpeg'** — it never re-derives mode.
2. **Sidebar re-derives every uiState()** (~4050): `const feedType = normalizeFeedType(camera.feedType); const isLiveJpeg = feedType === 'mjpeg';` → active camera gets live MJPEG `<img>` via `mediaUrlFor(camera, SIDEBAR_FEED_RESOLUTION)`.
3. **Live-jpeg projection path is fully built and correct** — `openLiveJpegConnection` binds `<img>` to `mediaUrlFor(camera, PROJECTION_FEED_RESOLUTION)` (1280x720), `drawProjectionFrame` (~2457) blits fresh frames each RAF when `liveFrameCount > lastDrawnLiveFrame`, `refreshProjectionTextures` skips the 1Hz swap throttle for live-jpeg. Live cap = 2 slots (sidebar + projection).
4. **Catalog seed default is `feedType: 'image'`** (~1200). Live sources merge at ~1299: `normalizeSourceFeedType(source.feedType || source.type || 'image', source.url)`.
5. **Self-heal URL guard is narrow** — `isMjpgStreamUrl(url)` only matches `/mjpg/`, `/mjpeg/`, `.mjpg`/`.mjpeg`/`video.mjpg` in the **pathname**. The client later talks to the local proxy endpoint `/api/media/<id>?resolution=…` (`mediaUrlFor`), which never matches — so any Axis source whose catalog/source URL does not literally contain those path markers is permanently classified snapshot/image even if the backend serves multipart MJPEG.

## Prime suspects (verify in order)
- **A (most likely): mode frozen at creation.** If the Axis cam's feedType resolves to `'image'` when the projection runtime is created (catalog seed default, or live source merge order), the plane stays `image` mode forever → 10s/60s still refresh (`refreshProjectionImage` / `frameUrlFor` cache-buster) while the sidebar — recomputed from the same `feedType` *later* — shows live. Investigate WHY the sidebar gets mjpeg but projection gets image for the same camera. Possible paths: the health payload (`_healthById`) later reports the true type and the sidebar/UI uses it, but the projection runtime never re-derives from health; or the active-camera sidebar reservation happens after a catalog re-merge that fixed feedType, while the runtime predates it.
- **B: feedType is declared 'image' for Axis sources** in the live catalog (server merge), and nothing on the client upgrades it for the projection path. Fix belongs in classification: the proxy/health layer should advertise the true stream type (e.g. health payload `streamType: 'mjpeg'`), and the projection runtime should re-derive mode from it.
- **C: projected camera is non-active.** If the monitor plane can target a camera that is NOT the sidebar-active one, it falls outside the active-camera live reservation. Confirm whether projection is always the active camera; if it isn't, that's the routing gap.

## Your job
1. Reproduce or statically confirm the divergence (dev server with a real Axis source if reachable; otherwise trace the catalog/health → mode decision for an Axis cam).
2. Fix so the **projected plane streams live MJPEG for Axis cams like the sidebar does**, without regressing image/video cameras or the live-slot cap (2 slots).
   - Prefer: make projection mode **re-derivable** when the true feed type becomes known (health payload / catalog update), and make the Axis classification robust (server health hint or a URL guard that covers the proxy path). Do not break the 1Hz placeholder/swap throttles or the white-flash protections (owner-field tests 2026-07-04/30).
3. Keep `npm test` at **2795 pass / 0 fail / 1 skip**. Run the cctv-specific tests too (`npm test -- cctv` or the suite's cctv filter).
4. Conventional commits. **DO NOT push.** PM merges post-Specs sign-off.

## Constraints
- Single-threaded, no parallel sub-agents. Keep terminal output lean.
- Do NOT touch: `.env*`, `config/`, `dist/`, `docs/`, logo, repo URL, upstream attribution, vite.config proxy behavior (unless the proxy mislabels types — then flag it, don't change it unilaterally).
- Report DONE with: root cause (A/B/C + evidence), the fix, files changed, gate numbers, and any follow-up you recommend.