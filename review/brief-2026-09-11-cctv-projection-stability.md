# Big Pickle — Sprint: EVOL Eye CCTV projection stability + UI polish (3 issues)

**Repo:** `~/.openclaw/workspace/Devils-Eye` | **Branch:** `fix/cctv-projection-stability` (cut from main, do NOT push)

**Baseline (verified by PM):** `npm test` green (1 skip = Node-version microbenchmark only). Prior sprint `beeeb2a` merged 4 fixes; 3 regressions/UX issues remain.

---

## Issue 1 (P0): Live video in the projected window flashes constantly when zoomed in

**Symptom (Billy):** "We finally have live video in the projected video window, but it is now flashing very quickly while displaying after zooming in on it. It looks like the image is constantly being refreshed."

**Where:** `src/data/cctv.js` — projection RAF loop + texture swap path:
- `startProjectionLoop()` (~2614): runs `drawProjectionFrame(active)` + `refreshProjectionTextures(active)` every RAF tick (~60fps) while a camera is projected.
- `drawProjectionFrame()` live-jpeg branch (~2508): computes `projectionFrameSignature(runtime)` (64x36 FNV-1a hash, ~1571) every tick; on ANY signature change it blits the img to the 1920x1080 canvas, bumps `canvasStamp`, **repaints chrome** (`paintProjectionChrome`, with timestamp/labels), and grants first frame.
- `refreshProjectionTextures()` (~1640): live-jpeg **explicitly bypasses the 1 Hz swap throttle** (`PROJECTION_TEXTURE_SWAP_MS`) and does an unthrottled buffer swap whenever `canvasStamp !== lastSwappedCanvasStamp`.

**Likely failure modes (verify, then fix the real one):**
1. **JPEG noise → signature churn.** A 64x36 downscale of a compressed JPEG frame often differs slightly between frames even for a static scene (encoder noise, temporal noise). If every frame hashes differently, the plane blits + swaps at MJPEG frame rate continuously → "constantly being refreshed." The signature needs to be *change-tolerant* (perceptual hash / Hamming-distance threshold on the downsampled pixels, or a coarser bucket), not exact-match.
2. **Unthrottled texture swap.** Even with a valid signature, live-jpeg should NOT swap texture every single frame at 60fps. Add a sane min interval (e.g. ~66-100ms, matching typical MJPEG 5-15fps) so the plane refresh cadence matches the stream, not the RAF.
3. **Chrome repaint each blit.** `paintProjectionChrome` redraws overlays every frame the signature changed. If the chrome includes animated/timestamped elements that differ per frame, that's a guaranteed per-frame redraw. Verify whether chrome is stable between frames; if not, only repaint chrome when it actually changes (or at the swap interval).

**Acceptance criteria (all must hold):**
- Static scene on a live-jpeg stream: plane visibly **stable** — no flashing/strobing after zoom.
- Moving scene: updates at stream-like cadence (a few fps), not 60fps, without freeze.
- No white-flash regression (owner field tests 2026-07-04/30 behavior preserved).
- Sidebar `<img>` feed unaffected.
- Existing signature/swap tests updated or added; `npm test` green at baseline + new tests.

---

## Issue 2 (P2): Search spinner — needs its own slot directly LEFT of the search input

**Symptom (Billy):** "The spinning wheel is now over to the left when searching addresses but it's still showing over the search bar — it needs to be on its own directly to the left of the searchbar."

**Current state (post beeeb2a/4e9fa04):**
- HTML `index.html:574-580`: `.location-search-wrap` contains `#search-toggle` button + `#location-search` input + `#location-search-spinner`.
- CSS `style.css:943-958`: `.location-search-spinner { position: absolute; right: 10px; top: 50%; ... }` — absolutely positioned **inside/over the input's right edge**.
- `style.css:1911`: `.location-search-wrap { position: relative; display: flex; align-items: center; }`.

**What Billy wants:** The spinner must NOT overlay the input at all. It should sit in its own dedicated slot **immediately to the left of the input** (between the toggle button and the input, or left of the input — decide based on layout), own width, never overlapping input text.

**Do:**
- Restructure so the spinner is a normal flex child (not absolute over the input), shown only while `.is-searching` (keep the class gate), hidden otherwise (preserve `display:none` default).
- Remove the `right:10px` overlay + the `.is-searching #location-search { padding-right: 28px }` hack (no longer needed when the spinner isn't inside the input).
- Keep the 14px round spinner styling + spin animation.
- Check BOTH the generic rule (~943) and the `#command-dock` overrides (~7428, ~7681) so the dock variant also gets the new layout. Verify with the panel open in dock and in the top bar (if applicable).

**Acceptance criteria:**
- While searching: spinner occupies its own slot directly left of the input; nothing overlaps the input text.
- Idle: no spinner visible, layout unchanged.
- No layout shift of the toggle/input when the spinner appears/disappears (or acceptable, minimal — prefer reserving the slot with `visibility` over full display toggle if shift is ugly).

---

## Issue 3 (P2): Location (premade locations) popover is cut off — must be scrollable both directions

**Symptom (Billy):** "The premade locations that pop up when we hit locations is cut off. It needs to be scrollable in both directions so we can see all of them."

**Where:** The location bar popover (`#command-dock #location-bar .dock-popover-content`, style.css ~8477) contains `.location-city-row` with `#location-pills` (city pills from `CITY_POIS` — currently ~51? cities, so the row is wide) plus the POI row.

**Current state:**
- `.location-pills` (style.css:1773) already has `overflow-x: auto` (hidden scrollbar) — horizontal scroll exists but is easy to miss.
- The popover container itself (`.dock-popover-content`, ~8085/8449) has NO max-height / overflow-y — so a tall content stack (city row + POI row + more) overflows the viewport and is cut off at top (popover anchors above the dock, bottom: calc(100% + 0.65rem)).

**Do:**
- Give `#command-dock #location-bar .dock-popover-content` a `max-height` (viewport-aware, e.g. `min(60dvh, 34rem)` or similar — pick what fits 1080p and doesn't clash with the `--dock-popover-mobile-width` overrides at ~8588) + `overflow-y: auto`.
- Ensure the pills row keeps usable horizontal scrolling within the popover (both directions = vertical scroll for the whole popover, horizontal for the pills row). Keep/restore visible scroll affordance (the current `scrollbar-width: none` hides it — consider a subtle styled scrollbar so it's discoverable; PM prefers discoverable).
- Check the `#control-panel .dock-popover-content` sibling (presets) is NOT broken by shared rules — scope changes to the location-bar popover only unless the presets popover has the same cut-off problem (then fix both, mention it).
- Mobile media-query overrides (~8588-8600) must keep working (width override) with the new max-height.

**Acceptance criteria:**
- With the location panel open: all premade locations reachable — vertical scroll when tall, horizontal scroll for the wide pills row; nothing cut off.
- Scrollbars visible/usable (styled to match theme), wheel + drag scroll work.
- No regression to the control-panel presets popover.

---

## Constraints
- Scope: `src/ui.js`, `src/data/cctv.js`, `style.css`, `index.html`, `src/data/cctv.test.mjs` (+ new test files if a seam needs one).
- Conventional commits, commit as you go (never wait for context expiry). **DO NOT push.**
- `npm test` green. Run `npm test -- cctv` for the cctv suite.
- Keep the 2-slot live cap, no white-flash regressions, don't break sidebar, don't break the dock pin/collapse behavior.
- Tests for Issue 1: add unit coverage for the new change-tolerant signature (pure function seam — `frameSignatureFromPixels` is already exported) + swap throttle logic if extractable.
- Report DONE per-issue with files+lines and test results, then commit. Do NOT merge — PM merges after Specs QA approves.