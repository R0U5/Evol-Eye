// src/data/trafficDenseCoreFixture.mjs
// Dense-core benchmark fixture for the P0.3 traffic dispatch.
//
// Synthetic Manhattan-style road grid + a pluggable fetch-latency model. The
// fixture measures the two P0.3 improvements independently:
//
//  1. `simulateJumpAndPan` — the TIMING model. After jump-to-city the user
//     fast-pans into a neighboring tile. The old behavior fetches that tile
//     serially (debounce → major → full); the new behavior prefetched the
//     neighbor ring during the jump, so the pan's major pass is a cache hit
//     and only the full pass re-fetches. The metric is the time from
//     jump-to-city to full visible-road coverage.
//
//  2. `simulateAllocation` — the COVERAGE model. The clamped fetch tile
//     (0.05°) is larger than the active viewport, so a tight dot cap can
//     starve visible roads behind off-screen segments. Viewport-first
//     ordering seeds visible roads before off-screen ones. The metric is the
//     fraction of viewport-visible roads that receive at least one dot.
//
// The fixture is strategy-agnostic: the benchmark/test passes the strategy
// flags to compare the serial single-tile baseline against the new build.
// No external data sources are needed — the road grid is synthetic.

import { allocateRoadDotBudgets, computeDotCount } from './traffic.js';
import { roadVisibleInBounds } from './trafficBounds.js';

/**
 * Generate a dense-core road grid (Manhattan-style blocks).
 *
 * Each block segment is its own road object so the count is high (heavy
 * intersections) and the geometry is short polylines, like a real city core.
 *
 * @param {Object} [opts]
 * @param {number} [opts.blocks=12] - Blocks per side (roads = 2·blocks·(blocks+1)).
 * @param {number} [opts.blockSizeDeg=0.004] - Block size in degrees (~440 m).
 * @param {number} [opts.centerLat=30.2672] - Core center latitude (Austin).
 * @param {number} [opts.centerLon=-97.7431] - Core center longitude (Austin).
 * @returns {Array<{coords:number[][], type:string}>} Road objects.
 */
export function generateDenseCoreRoads({
  blocks = 12,
  blockSizeDeg = 0.004,
  centerLat = 30.2672,
  centerLon = -97.7431,
} = {}) {
  const roads = [];
  const half = (blocks * blockSizeDeg) / 2;
  const south = centerLat - half;
  const west = centerLon - half;

  // Horizontal street segments (one road per block segment).
  for (let i = 0; i <= blocks; i++) {
    const lat = south + i * blockSizeDeg;
    const type = i % 3 === 0 ? 'primary' : 'residential';
    for (let j = 0; j < blocks; j++) {
      const lon0 = west + j * blockSizeDeg;
      const lon1 = lon0 + blockSizeDeg;
      roads.push({ coords: [[lon0, lat], [lon1, lat]], type });
    }
  }
  // Vertical street segments.
  for (let j = 0; j <= blocks; j++) {
    const lon = west + j * blockSizeDeg;
    const type = j % 3 === 0 ? 'primary' : 'residential';
    for (let i = 0; i < blocks; i++) {
      const lat0 = south + i * blockSizeDeg;
      const lat1 = lat0 + blockSizeDeg;
      roads.push({ coords: [[lon, lat0], [lon, lat1]], type });
    }
  }
  return roads;
}

/**
 * Generate a sparse road set (the common case): few roads, all inside the
 * viewport, total ideal dots well under the cap. Used to prove the P0.3
 * changes do not regress sparse scenes.
 *
 * @param {Object} [opts]
 * @param {number} [opts.rows=5] - Grid rows.
 * @param {number} [opts.cols=5] - Grid columns.
 * @param {number} [opts.centerLat=30.2672]
 * @param {number} [opts.centerLon=-97.7431]
 * @param {number} [opts.spanDeg=0.012] - Grid span (inside a 0.02° viewport).
 * @returns {Array<{coords:number[][], type:string}>} Road objects.
 */
export function generateSparseRoads({
  rows = 5,
  cols = 5,
  centerLat = 30.2672,
  centerLon = -97.7431,
  spanDeg = 0.012,
} = {}) {
  const roads = [];
  const south = centerLat - spanDeg / 2;
  const west = centerLon - spanDeg / 2;
  for (let i = 0; i < rows; i++) {
    const lat = south + (i / (rows - 1)) * spanDeg;
    for (let j = 0; j < cols; j++) {
      const lon = west + (j / (cols - 1)) * spanDeg;
      roads.push({
        coords: [[lon, lat], [lon + 0.001, lat + 0.001]],
        type: (i + j) % 3 === 0 ? 'primary' : 'residential',
      });
    }
  }
  return roads;
}

/**
 * Viewport bounds for a dense core: the inner half of the core's span, so
 * roughly half the generated roads are on-screen and half are off-screen.
 *
 * @param {Object} [opts]
 * @param {number} [opts.blocks=12]
 * @param {number} [opts.blockSizeDeg=0.004]
 * @param {number} [opts.centerLat=30.2672]
 * @param {number} [opts.centerLon=-97.7431]
 * @returns {{south:number, west:number, north:number, east:number}}
 */
export function coreViewportBounds({
  blocks = 12,
  blockSizeDeg = 0.004,
  centerLat = 30.2672,
  centerLon = -97.7431,
} = {}) {
  const half = (blocks * blockSizeDeg) / 4;
  return {
    south: centerLat - half,
    north: centerLat + half,
    west: centerLon - half,
    east: centerLon + half,
  };
}

/**
 * Timing model for jump-to-city + fast pan.
 *
 * Pipeline (matches traffic.js):
 *  - Camera move → debounce (D) → fetch major (L) → fetch full (L').
 *  - The neighbor prefetch ring (new) starts when the target major is ready
 *    and runs in parallel with the target full fetch.
 *  - The user fast-pans at the moment the target is fully loaded.
 *  - The pan's neighbor tile: major is cached (new) or fetched serially (old);
 *    full is always fetched.
 *
 * @param {Object} [opts]
 * @param {number} [opts.debounceMs=320] - Camera-settle debounce.
 * @param {number} [opts.majorLatencyMs=200] - Major-only fetch latency.
 * @param {number} [opts.fullLatencyMs=300] - Full-graph fetch latency.
 * @param {boolean} [opts.prefetchEnabled=false] - Neighbor ring prefetch on.
 * @returns {{jumpCoverageMs:number, panCoverageMs:number, totalCoverageMs:number,
 *   improvementMs:number, improvementPct:number, events:Array<{t:number, what:string}>}}
 */
export function simulateJumpAndPan({
  debounceMs = 320,
  majorLatencyMs = 200,
  fullLatencyMs = 300,
  prefetchEnabled = false,
} = {}) {
  const t0 = 0;
  // Jump-to-city: debounce, then major fetch, then full fetch.
  const targetMajorAt = t0 + debounceMs + majorLatencyMs;
  const targetFullAt = targetMajorAt + fullLatencyMs;
  // Prefetch ring (new): neighbor major fetches start when the target major
  // is ready and run in parallel with the target full fetch.
  const prefetchReadyAt = prefetchEnabled
    ? targetMajorAt + majorLatencyMs
    : Infinity;
  // Fast pan at the moment the target is fully loaded.
  const panAt = targetFullAt;
  // Neighbor coverage: the pan still debounces before its load runs. Major is
  // cached (prefetch completed before the pan) or fetched serially (debounce
  // + major latency); full is always fetched after the major pass.
  const neighborMajorAt = prefetchEnabled && prefetchReadyAt <= panAt
    ? panAt + debounceMs
    : panAt + debounceMs + majorLatencyMs;
  const neighborFullAt = neighborMajorAt + fullLatencyMs;

  const oldTotal = (debounceMs + majorLatencyMs + fullLatencyMs)
    + debounceMs + majorLatencyMs + fullLatencyMs;
  const newTotal = neighborFullAt;
  const improvementMs = oldTotal - newTotal;

  return {
    jumpCoverageMs: targetFullAt,
    panCoverageMs: neighborFullAt,
    totalCoverageMs: neighborFullAt,
    improvementMs,
    improvementPct: oldTotal > 0 ? (improvementMs / oldTotal) * 100 : 0,
    events: [
      { t: targetMajorAt, what: 'target-major' },
      { t: targetFullAt, what: 'target-full' },
      { t: prefetchReadyAt, what: 'prefetch-neighbors-major' },
      { t: panAt, what: 'pan-to-neighbor' },
      { t: neighborMajorAt, what: 'neighbor-major' },
      { t: neighborFullAt, what: 'neighbor-full' },
    ],
  };
}

/**
 * Coverage model for dot allocation under a tight cap.
 *
 * Uses the REAL `allocateRoadDotBudgets` and `computeDotCount` from traffic.js
 * so the fixture measures production logic, not a reimplementation. With
 * `viewportFirst`, visible roads are seeded before off-screen segments.
 *
 * @param {Object} opts
 * @param {Array<{coords:number[][], type:string}>} opts.roads - Road objects.
 * @param {{south:number, west:number, north:number, east:number}} opts.viewportBounds
 * @param {number} opts.dotCap - Global dot cap.
 * @param {number} [opts.altitude=1500] - Camera altitude (spacing).
 * @param {boolean} [opts.viewportFirst=false] - Viewport-first allocation.
 * @returns {{visibleTotal:number, visibleCovered:number, coveragePct:number,
 *   totalDots:number, idealDots:number}}
 */
export function simulateAllocation({
  roads,
  viewportBounds,
  dotCap,
  altitude = 1500,
  viewportFirst = false,
}) {
  const priority = viewportFirst
    ? roads.map((road) => (roadVisibleInBounds(road, viewportBounds) ? 1 : 0))
    : null;
  const budgets = allocateRoadDotBudgets(roads, altitude, dotCap, priority);
  let visibleCovered = 0;
  let visibleTotal = 0;
  let idealDots = 0;
  for (let i = 0; i < roads.length; i++) {
    idealDots += computeDotCount(roads[i], altitude);
    if (!roadVisibleInBounds(roads[i], viewportBounds)) continue;
    visibleTotal += 1;
    if (budgets[i] > 0) visibleCovered += 1;
  }
  return {
    visibleTotal,
    visibleCovered,
    coveragePct: visibleTotal ? (visibleCovered / visibleTotal) * 100 : 100,
    totalDots: budgets.reduce((a, b) => a + b, 0),
    idealDots,
  };
}