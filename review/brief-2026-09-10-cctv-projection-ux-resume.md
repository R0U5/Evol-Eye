# Big Pickle — RESUME: EVOL Eye CCTV projection fixes (issue 1 root cause PROVEN)

**Repo:** `~/.openclaw/workspace/Devils-Eye` | **Branch:** `fix/cctv-projection-ux` (already cut)

## CONTEXT: your previous run (context exhausted before committing — nothing landed, no work lost except the analysis below)

You empirically confirmed the root cause of Issue 1 with a Chromium probe in /tmp/mjpeg-probe:
- **Chrome fires `img.onload` exactly ONCE for a multipart/x-mixed-replace MJPEG stream** (14 frames served → `load: 1`).
- The projection draw path in `src/data/cctv.js` currently advances `liveFrameCount` / redraws the projection canvas only when the live `<img>` fires `onload` per frame. Since onload only fires once, after the first frame the canvas never redraws → frozen still on the monitor plane. Sidebar works because the browser itself decodes the MJPEG in the native `<img>` (no canvas redraw needed).
- **Your validated fix:** RAF-side redraw + change detection. Reuse the existing `projectionFrameSignature(runtime)` (~line 1571, 64x36 downsampled FNV-1a signature of `runtime.image` pixels) — each RAF tick, compute the live img's signature; when it CHANGES, blit `drawImage(runtime.image)` to the full projection canvas, bump `canvasStamp`, update `lastFrameSignature`, draw chrome, grant first frame. When unchanged, skip (preserves the no-redundant-swap / no-white-flash properties). Verified: 18 frames → signature detected all 18.
- Design notes from your thinking: keep a "real frame present" gate for first-frame grant (blank-before-load = constant sig = no grant until first frame); `projectionFrameSignature` returning null (taint/decode race) degrades to "assume changed" — for the proxy (same-origin) taint won't occur; static pixel-identical scenes just don't redraw (correct).

## IMPLEMENT NOW (on fix/cctv-projection-ux, commits on top of main)

### Issue 1 (P0): live-jpeg projection draws via RAF-side signature change detection
Modify the live-jpeg branch of `drawProjectionFrame` (src/data/cctv.js ~1641) so it:
1. Computes `sig = projectionFrameSignature(runtime)` each RAF (reuse existing fn; it already handles null/taint as "assume changed").
2. On `sig !== runtime.lastFrameSignature`: `drawImage(runtime.image)` to the projection canvas (with imageSmoothing), bump `runtime.canvasStamp`, set `lastFrameSignature = sig`, paint the chrome, grant first frame when a real frame is present (naturalWidth > 0 / non-blank).
3. On unchanged: leave canvas (no stamp bump → refreshProjectionTextures skips the swap — preserves no-flash).
- Keep `liveFrameCount`/`lastDrawnLiveFrame` semantics consistent — if tests reference them, update the tests, do not break the frame-count invariant.
- Add a unit test if a seam exists (frameSignatureFromPixels is already exported/testable — test the change-detection branch with a fake runtime whose image signature changes). Keep `npm test` at 2796/0/1 baseline + new tests.

### Issue 2 (P1): "Attempting to connect..." overlay
In the projection placeholder path (`paintProjectionPlaceholder` ~1720 / `paintProjectionChrome` ~1795), when a live-jpeg/video runtime exists but no frame has landed yet (state 'loading'/first-connect), draw a **full black plane** with **red "ATTEMPTING TO CONNECT..."** (or "ATTEMPTING TO CONNECT…" with animated dots if simple) in the existing tactical mono/letter-spaced style. Match the app's red `#ff2d2d`-ish accents and the surveillance chrome. Keep the existing no-feed/error states unchanged (only the connecting state gets the black+red treatment).
- See brief's issue 2 section for the full spec.

### Issue 3 (P1): ENHANCE = 2x
`style.css:6092` `#cctv-panel.enhanced { --cctv-enhance-scale: 1.3; }` → `2.0`. Verify the clamp at `style.css:4607` (max-height `calc(100vh - 24px)` + `--cctv-enhance-scale` usage) still keeps the panel usable at 2x on 1080p.

### Issue 4 (P2): spinner position
`.location-search-wrap` (style.css:1911) lacks `position: relative`, so the absolute `.location-search-spinner` (right:10px, top:50%) positions against a distant ancestor → far right. Add `position: relative` to `.location-search-wrap` (both the generic 1911 rule and the `#command-dock` override at 7423 if it needs it). Verify spinner sits inside the input's right edge.

## Constraints
- Scope: `src/ui.js`, `src/data/cctv.js`, `style.css`, `index.html`, `src/data/cctv.test.mjs`. Conventional commits. **DO NOT push.**
- `npm test` green. Run `npm test -- cctv` for the cctv suite.
- Keep the 2-slot live cap, no white-flash regressions (owner-field tests 2026-07-04/30), don't break sidebar.
- Report DONE per-issue with files+lines changed and test results. Commit as you go — do not wait until context runs out to write files/commits.