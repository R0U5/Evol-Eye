# Big Pickle — REVISION: axis-projection-live fix churns at 60Hz + leaks runtimes

**Repo:** `~/.openclaw/workspace/Devils-Eye` | **Branch:** `fix/axis-projection-live` (already has your commit 04867a8 — revise ON TOP of it, don't rewrite history)

## Why you're back
QA rejected 04867a8. The null-guard and reopen-path are good. The upgrade branch is structurally defective:

### Defect 1 — deterministic 60Hz destroy/recreate churn
Your branch (src/data/cctv.js:2340-2347) destroys + nulls + recurses, but the recreate calls `createProjectionRuntime`, which derives mode **only** from `record.camera.feedType` (line 2140-2145) — it never checks `_healthById`. And `camera.feedType` is immutable after construction (no `feedType =` mutation exists anywhere in the file).

So in the exact scenario the branch exists for — catalog says `feedType: 'image'`, health reports `sourceKind: 'mjpeg'` (the mislabeled-source case from the brief) — the recreated runtime is ALSO image mode. `ensureProjectionRuntime` runs every RAF tick (line 2592), the condition `mode !== 'live-jpeg' && healthIndicatesLive` stays true → **destroy/recreate every frame at ~60fps, indefinitely**.

### Defect 2 — `_projectionEntities` leak
Every create path does `_projectionEntities.push(runtime)` (line 2360). `destroyProjectionRuntime` (2365-2395) never removes from `_projectionEntities` (only wholesale resets at 4720/4723/4781/5396). Churn = unbounded array growth at 60/s, and the draw loops (4335, 4720) iterate that array.

### Defect 3 — plane flash
Each cycle removes the plane entity and re-adds a fresh one → perpetual placeholder/flash on the monitor plane. (Falls out of fixing #1, but keep it in mind when testing.)

## The fix (PM direction — adjust if you find better, but these invariants must hold)
1. **Make `createProjectionRuntime` health-aware.** When deriving `feedType`/`mode` (cctv.js:2140-2145), consult `_healthById.get(record.camera.id)` first: if health's `sourceKind` matches mjpeg/mjpg, treat as `'mjpeg'`. Then the destroy+recreate path terminates (fresh runtime = live-jpeg → condition false on the next tick) and works in BOTH scenarios (catalog-fixed and health-only). Keep the existing `normalizeFeedType(record.camera.feedType)` fallback for non-health cases. Do not change behavior for video/image cameras.
2. **Close the leak:** `destroyProjectionRuntime` must remove the runtime from `_projectionEntities` by identity (`indexOf` + `splice`), before the existing teardown.
3. **Add a regression test** in `src/data/cctv.test.mjs` covering the upgrade path:
   - image-mode runtime exists, `_healthById` gains `{ sourceKind: 'mjpeg' }` for that camera → next `ensureProjectionRuntime` returns a runtime with `mode === 'live-jpeg'` and a bound `<img>`.
   - **No churn:** repeated `ensureProjectionRuntime` calls (simulating RAF ticks) must NOT repeatedly destroy/recreate — assert destroy fires at most once for the upgrade and `_projectionEntities` length stays stable.
   - Follow the file's existing test harness patterns (check how `_healthById` is seeded in tests; if it's not injectable, add a minimal test seam — keep it small).
4. Keep the null-guard and the existing reopen path (`mode === 'live-jpeg' && !liveConnected` → `openLiveJpegConnection`) exactly as they are.

## Constraints
- Single commit on top of 04867a8, conventional commit message.
- Scope: `src/data/cctv.js` + `src/data/cctv.test.mjs` only.
- Gate: `npm test` must stay **0 fail** — expected 2795 pass + your new tests (passed count grows, skip stays 1).
- Run the cctv-focused tests too (`npm test -- cctv` or the suite's cctv filter).
- DO NOT push. PM + Specs re-verify before merge.
- Terminal output lean. Report DONE with: what changed, line refs, gate numbers, and the churn scenario you tested.