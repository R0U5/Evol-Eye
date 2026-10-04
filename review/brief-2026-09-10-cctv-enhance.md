# Big Pickle — ENHANCE button for CCTV panel (+30% window & video)

Repo: `~/.openclaw/workspace/Devils-Eye` | Branch: `feat/cctv-enhance` (create off `main` @ 7aaef74)
Contract: add an ENHANCE toggle to the CCTV panel header that scales the panel AND the video feed to 130%. Toggle back to 100% on second click ("resizable"). Conventional commit(s). DO NOT push, DO NOT PR (GitHub auth broken — known). Work clean, commit on branch, report when done.

## The ask (Billy, verbatim intent)
"Add a button to the menu already in the window that says **Enhance** (an ode to the old cop shows — enhance, enhance!) and make the window and the video in it **30% larger**." The button must live in the CCTV window's existing header/menu row. Click = 1.3x; click again = back to 1.0x. The video scales WITH the window (they stay proportional).

## Where things are (verified)
- HTML: `index.html` — `#cctv-panel` ~line 602. Header row:
  ```html
  <div class="panel-header">
    <span class="panel-title">CCTV</span>
    <span class="panel-divider"></span>
    <button class="panel-collapse-btn" data-collapse-target="cctv-panel" title="Collapse panel">+</button>
  </div>
  ```
  Put the ENHANCE button in this header row (the "menu"), next to the collapse button. Style it like the existing header buttons / scene-btn family so it matches the spy-console aesthetic (monospace, cyan-tinted). Label exactly `ENHANCE`.
- CSS: `style.css`
  - Panel width: `#right-context-rail #cctv-panel:not(.collapsed)` sets `--cctv-panel-expanded-width: 560px; width: var(--cctv-panel-expanded-width);` (~line 4628). There is ALSO a left-stack variant (`#left-panel-stack > #cctv-panel:not(.collapsed)`, ~line 6626) — the panel can dock either side, so the scale must work in BOTH layouts.
  - Feed stage: `.cctv-frame-wrap` (`min-height: 180px; flex-shrink: 0`), `#cctv-frame` is `width: 100%; aspect-ratio: 16 / 9; object-fit: contain`. **Because the video is width-100% + fixed 16:9, scaling the panel width to 130% automatically scales the video 130%** — no JS math on the img needed. Just make sure the wrap's min-height floor scales too so it never pinches (e.g. `min-height: calc(180px * var(--cctv-enhance-scale))`).

## Implementation direction (recommended, PM-vetted)
Use a CSS custom property + one class — zero layout JS:
1. `#cctv-panel` gets a class `enhanced` toggled by the button (aria-pressed reflects state).
2. Define `--cctv-enhance-scale: 1.3` inside `#cctv-panel.enhanced` (or a `:root` var defaulting to 1 and override to 1.3 on `.enhanced`).
3. Update the width rules to multiply: `width: calc(var(--cctv-panel-expanded-width) * var(--cctv-enhance-scale));` in BOTH right-rail and left-stack variants (guard the `@media (max-width: 800px)` clamp so it still fits viewport — `min(calc(560px * var(--cctv-enhance-scale)), calc(100vw - 24px))`).
4. Scale the feed stage floor: `.cctv-frame-wrap { min-height: calc(180px * var(--cctv-enhance-scale)); }` — keep `flex-shrink: 0`.
5. Wire the button in `src/ui.js`: find where `_cctvPanel` is cached (~line 2263) or the collapse-btn wiring (`_initPanelChrome` ~line 4041 — the `document.querySelectorAll('.panel-collapse-btn[data-collapse-target]')` block is the model). Add a click handler: `this._cctvPanel.classList.toggle('enhanced')`, set `aria-pressed`, and (nice-to-have) flip the button label to `ENHANCED` while active — your call on label, keep it tasteful. No persistence required (session-only toggle is fine; do NOT add localStorage unless it's a 2-line pattern match — if you do, use the existing `evolEyeView.` prefix and note the key).

## Constraints
- ONLY touch: `index.html` (cctv header row), `style.css` (width/scale rules), `src/ui.js` (button wiring). Nothing else.
- Do NOT touch: logo, upstream attribution, `.env*`, `config/`, `dist/`, docs, tests of unrelated features.
- Keep the spy/cyan + red aesthetic. Button must fit the existing toolbar/header visual language.
- **Tests**: `npm test` MUST stay green (baseline on main: 2795 pass / 0 fail / 1 skip). No test changes expected — this is DOM/CSS. If any existing test asserts on the cctv panel header child count or width (unlikely), update ONLY that assertion and note it.
- No build (`dist` excluded). No push.

## Verify
1. `npm test` green, report exact counts.
2. Grep your diff: only the 3 files above changed.
3. Sanity-check the Math: 560 * 1.3 = 728px; 180 * 1.3 = 234px min-height. State these in your report.

## Report
Files changed (+/-), the exact CSS var/class names you chose, button placement, label behavior (static vs toggle), test counts, and any deviation from this brief.