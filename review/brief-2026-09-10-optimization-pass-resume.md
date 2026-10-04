# Big Pickle — EVOL Eye Optimization Pass: RESUME (crash recovery)

Repo: `~/.openclaw/workspace/Devils-Eye` | Branch: `feat/optimization-pass` (off `main` @ fd12024)

**Your previous run crashed at 10:56 PDT (node V8 heap OOM) mid-work — after 7 commits landed but before the final report. This is a continuation, not a restart. Do NOT redo completed work.**

## What already landed (verified committed on `feat/optimization-pass`) — do not touch:
- `00902d2` traffic: release render hold + viewport-cull animation loop (HIGH)
- `5eb4c7e` terrain: LRU cache cap 10k (HIGH)
- `7ba321c` flow-tile in-flight dedup
- `92c3eab` cctv: skip wasted canvas blit
- `b072d57` abort-on-disable for earthquakes/firms/missions
- `ac2323e` radar-state listener detach on StyleManager dispose
- `2ee1aec` cloud loop 12fps throttle
- Test gate last confirmed green: 2795 pass / 0 fail / 1 skip (11.3s)

## Remaining work (from your own audit todo, in order):
1. **vite.config.js manualChunks for cesium** (MEDIUM bundle item) — plus finish any open bundle-size items
2. **CSS audit items** — dead selectors / reflow / will-change (was pending at crash)
3. **Remaining render-perf items** if any
4. **Final gate**: full test suite re-run (2795/0/1) + `npm run build` for before/after chunk numbers, then write final summary to `review/` and report DONE

## ⚠️ Crash-avoidance constraints (new this run):
- **Do NOT spawn parallel sub-agents.** Do all remaining work inline, single-threaded. Prior run OOM'd with concurrent sub-agents + heavy context.
- Keep terminal output lean: avoid dumping giant file lists (`wc -c` over 20+ files is fine once, not repeatedly).
- No `git push`. Conventional commits only if you make new ones. PM merges post-Specs.

Contract unchanged: DO NOT push; report done when finished with gate + numbers.