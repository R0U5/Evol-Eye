# Devil's Eye — Prioritized Backlog (audit 2026-09-08, subagent deepseek-v4-flash)

Source: docs/KNOWN-ISSUES.md, docs/CURRENT-STATE.md, docs/PERFORMANCE.md, TESTING.md, CHANGELOG.md (+ greps). No open security/data-loss issues documented (recent hardening: SSRF closed, GBFS byte-cap, DOMPurify/protobufjs patched).

## P0 — must fix
1. **Merge `feat/height-datum`** (KNOWN-ISSUES.md Open #3). Aircraft placement visibly wrong: born-grounded contacts render at geoid (~150m below inland field) ≤1 poll; cold-start airports float low 30-60s. Complete fix sits on unmerged branch. Largest "looks broken" defect family.
2. **CCTV panel can restore off-screen after layout refactors** (KNOWN-ISSUES.md:34). Panel visibly disappears; recovery requires clearing localStorage by hand. Doc workaround targets `v6.panelPos.*` but code is at `v8` (src/ui.js:229) — workaround only removes the collapsed v6 key, not v8 positions key. Operators following the doc cannot recover.
3. **Street traffic late/uneven in dense cores** (KNOWN-ISSUES.md Open #1). Loader fetches one clamped viewport tile at a time (src/data/traffic.js:418 major/full pass) under global MAX_DOTS cap (traffic.js:57). Visible roads arrive late after city jumps/fast pans. Next-iteration candidates are the spec: viewport-first priority, neighbor prefetch ring, adaptive dot cap.

## P1 — should fix
1. **Infrastructure layers unusable en masse** (CURRENT-STATE 2026-08-23) — tile cut because ~5,700 entities kill frame rate; real fix (bundled-infra globe-LOD declutter) post-launch; voice "infrastructure mode" still maps to same layers.
2. **Military aircraft lack floor-hold path** (CURRENT-STATE 2026-08-21) — floor-hold applies to flights.js; militaryFlights.js does not use it. During terrain outage, grounded military contacts sink to geoid.
3. **Detection density sub-60 FPS** (PERFORMANCE) — 39.3/41.1 @ 25%, 34.4/35.5 @ 100% (~8,170 obs); combined operational 39.9/43.1 FPS, 872 MiB heap, ~48-54K text draws.
4. **CCTV cold activation 19.6s** (PERFORMANCE "Cold layer activation") — largest single-layer activation cost (192.7 MiB heap) vs 0.5-3.5s for every other layer.
5. **Scene playback teardown can leave recording chrome up** (CURRENT-STATE 2026-08-20) — setRecordingMode(false) not idempotent; worst case recording chrome stays up.
6. **AIS vessels ~22/30 FPS** (PERFORMANCE "Keyed live sources") — 12k vessels; lowest keyed source; needs controlled rerun.

## P2 — should do
1. **Perf baseline gaps** — no Windows data, no min-memory recommendation, keyed live pass no controlled rerun, Military Installations untested.
2. **Headless CI can't sign off visuals** — headless Chromium forces SwiftShader (relative CI/A-B evidence only); headful real-GPU is sign-off surface; GPU parity gap in CI.
3. **Traffic sync chip single-percentage** (KNOWN-ISSUES Open #1 continuation).
4. **Height-datum residuals after merge** — cold-start floor latency 30-60s, born-grounded first poll at geoid (tracks P0.1).
5. **AIS watchdog locked invariants** (CURRENT-STATE) — verify coverage.

## P3 — nice to have
- First-run launcher: location mini-status hidden (display:none !important) — unhiding is separate product decision.
- Submarine cables 412 MiB heap; datacenters 328 MiB — memory optimization candidates.
- Snow/Noir styles below 60 FPS (47/56.6 Noir, 42.3/45.8 Snow).
- GitHub repo private → public flip (installer manifest repoIsPrivate single switch).

## Top 5 priorities (ranked)
1. Merge feat/height-datum (P0.1) → 2. CCTV panel off-screen restore + fix stale v6 doc workaround (P0.2) → 3. Street traffic dense-core latency (P0.3) → 4. Military floor-hold gap (P1.2) → 5. CCTV cold activation 19.6s (P1.4)