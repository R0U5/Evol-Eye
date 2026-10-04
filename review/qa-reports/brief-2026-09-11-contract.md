# QA Verification Contract
**Project:** EVOL Eye
**Sprint Brief:** `brief-2026-09-11-cctv-projection-stability.md`
**Branch:** `fix/cctv-projection-stability`
**Author:** Specs (QA Engineer)
**Date:** 2026-09-11
---
## 1. Verifiable Checks per Issue
---
### Issue 1 – Live video flashes when zoomed (P0)
| Check Type | Target | Concrete Check |
|---|---|---|
| **Code Inspection** | `src/data/cctv.js` – `startProjectionLoop()` (≈ line 2614) | Verify the RAF loop calls `drawProjectionFrame(active)` **and** `refreshProjectionTextures(active)` **once per frame**. Confirm that `refreshProjectionTextures` respects `PROJECTION_TEXTURE_SWAP_MS` (no direct bypass for live‑jpeg). |
| | `drawProjectionFrame()` (≈ line 2508) | Ensure `projectionFrameSignature(runtime)` is **not** a strict 1:1 hash on every JPEG frame. Look for a tolerance implementation (e.g., Hamming‑distance threshold) or add a comment noting the need. |
| | `refreshProjectionTextures()` (≈ line 1640) | Confirm that texture swap only occurs when `Date.now() - lastSwapTimestamp >= PROJECTION_TEXTURE_SWAP_MS`. |
| **Unit Test Expectations** | Test file `src/data/cctv.test.mjs` (or new `cctv.signature.test.mjs`) | 1. Feed two *identical* JPEG buffers – expect `frameSignatureFromPixels` returns the same signature and **no** texture swap is recorded within the swap‑interval window. 2. Feed a *different* JPEG buffer – expect a new signature **and** a texture swap **once** per `PROJECTION_TEXTURE_SWAP_MS`. 3. Simulate a static scene with 60 fps frames – the projection canvas `canvasStamp` should **not** change each tick (no flashing). |
| **UI / Layout Invariant** | Projection canvas element (`#projection-canvas` or the `<canvas>` created in `src/ui.js`) | When the user zooms in and the scene is static, the visual output should be stable (no rapid repaint). Verify via a pixel‑diff test: capture two consecutive frames after zoom; diff should be ≤ 1 pixel (tolerance for timestamp overlay). |
| **Regression Guard** | Sidebar `<img>` feed (`.sidebar-feed img`) | Ensure the feed is **not** affected by the new signature logic – images should continue to load without extra refreshes. |
---
### Issue 2 – Search spinner positioning (P2)
| Check Type | Target | Concrete Check |
|---|---|---|
| **Code Inspection** | `index.html` (lines 574‑580) | Verify that `#location-search-spinner` is placed **as a direct child** of `.location-search-wrap` **before** `#location-search` in the DOM order. |
| | `style.css` (lines 943‑958) | The rule `.location-search-spinner { position: absolute; … }` must be **removed** or overridden to `position: static` (default flex) and **no** `right: 10px`. |
| | `style.css` (line 1911) | `.location-search-wrap { display: flex; align-items: center; }` must remain unchanged – the spinner will naturally sit left of the input. |
| **Unit / Integration Test** | Component test (jest+jsdom) for the search bar | Render the search bar, toggle class `.is-searching` on the wrapper. Assert that: <br>• `spinner.offsetLeft < input.offsetLeft` (spinner is left of input). <br>• `input.getBoundingClientRect().right` does **not** shrink when spinner appears (i.e., input width stays constant). |
| **CSS / Layout Invariant** | `.location-search-spinner` element | While `.is-searching` is present, spinner should **not** overlap the text area of `#location-search`. Use computed style `getComputedStyle(spinner).right` to be `auto` and ensure `margin-right` on the input is unchanged. |
| **Regression Guard** | Dock variant (`#command-dock` overrides at ~7428, ~7681) | Verify that the same flex‑layout rule applies in the dock context – spinner still appears left of the input and no overlay occurs. |
---
### Issue 3 – Location popover cut‑off (P2)
| Check Type | Target | Concrete Check |
|---|---|---|
| **Code Inspection** | `style.css` (popover selector around line 8477) | The rule for `#command-dock #location-bar .dock-popover-content` must include: <br>`max-height: min(60dvh, 34rem);` <br>`overflow-y: auto;` <br> (or equivalent values that keep the popover within the viewport). |
| | `.location-pills` rule (line 1773) | Ensure `overflow-x: auto;` remains unchanged and that a visible scrollbar is **not** suppressed (`scrollbar-width: none` may be changed to `auto` or a themed style). |
| **Unit / Integration Test** | Popover component test (e.g., React/Preact or vanilla DOM test) | Render the location popover with **> 30** city pills and a long POI list. Assert: <br>• `popover.scrollHeight > popover.clientHeight` → vertical scrollbar present. <br>• `pills.scrollWidth > pills.clientWidth` → horizontal scrollbar present. |
| **UI / Layout Invariant** | `#command-dock #location-bar .dock-popover-content` | The popover must never be clipped by the viewport. Visual regression test: open popover in a 1080p viewport, capture full screenshot, verify that the bottom edge of the last city pill is **visible** (no cut‑off). |
| **Regression Guard** | Control‑panel presets popover (`#control-panel .dock-popover-content`) | Ensure the CSS changes scoped to the location popover do **not** inadvertently affect the presets popover. A quick visual diff of both popovers should show the presets retaining its original height/overflow behavior. |
| **Mobile Media Queries** | Media‑query blocks around line 8588‑8600 | Confirm that the added `max-height` and `overflow-y` rules persist under `@media (max-width: …)` conditions (i.e., the popover remains scrollable on mobile). |
---
## 2. Test‑Command Baseline
- Run `npm test` in the project root.
- **Success criterion:** All test suites pass **green**.
- Known exception: **1 skipped test** (`Node‑24 micro‑benchmark`) – this skip is expected and **must not** be treated as a failure.
- The contract adds **new unit / integration tests** for the three issues; after they are added the full suite must still satisfy the above baseline.
---
## 3. Checklist – Acceptance Criteria Mapping
| # | Acceptance Criterion (from brief) | Checkable Item (contract) |
|---|---|---|
| 1 | Live video should be stable after zoom – no flashing. | Verify `canvasStamp` remains unchanged for static scene (UI pixel‑diff) and texture swap respects throttle (code inspection & unit test). |
| 2 | Moving video updates at stream‑like cadence, not 60 fps. | Unit test asserting at most one swap per `PROJECTION_TEXTURE_SWAP_MS` while frames differ. |
| 3 | No regression of white‑flash guard. | Visual test of the “owner‑field” flash scenario (manual check – part of regression guard). |
| 4 | Sidebar feed remains unaffected. | Verify sidebar `<img>` elements do not receive extra repaint events (code diff & manual observation). |
| 5 | Search spinner positioned left of input, no overlay. | DOM order & computed‑style check (integration test). |
| 6 | Spinner appears only while searching and does not shift layout. | Toggle `.is-searching` and assert input width unchanged (integration test). |
| 7 | Location popover fully scrollable vertically and horizontally. | Popover scroll‑height/width assertions (unit test) and visual clip‑free screenshot. |
| 8 | No visual regression in control‑panel presets popover. | Manual side‑by‑side diff after applying popover CSS changes. |
| 9 | Mobile layout retains scrollability. | Run popover test in a simulated narrow viewport (e.g., 375 px width) and assert scrollbars present. |
---
## 4. Areas of Likely Regression to Probe
- **Sidebar feed (`.sidebar-feed img`)** – ensure the new signature logic doesn’t trigger unnecessary redraws.
- **White‑flash guard** (owner‑field overlay) – confirm unchanged behavior.
- **Dock pin / collapse** – verify that adding `max-height` to the location popover does not interfere with the dock’s collapse animation or pinning logic.
- **Control‑panel presets popover** – scoped CSS must not break its scroll/height handling.
- **Mobile media‑query overrides** for both the search bar and the location popover – ensure the new flex layout and max‑height rules survive the responsive breakpoints.
- **npm test baseline** – re‑run after adding contract tests to confirm the existing skip remains the only non‑green result.
---
*This contract file is intended for the QA lead to review, approve, and commit alongside the sprint code changes. No source files have been modified.*

**Contract file created:** `/home/goblin/.openclaw/workspace/Devils-Eye/review/qa-reports/brief-2026-09-11-contract.md`