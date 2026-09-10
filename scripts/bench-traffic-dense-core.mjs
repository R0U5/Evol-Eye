// scripts/bench-traffic-dense-core.mjs
// P0.3 dense-core benchmark: jump-to-city + fast pan visible-road coverage
// timing, old (serial single-tile) vs new (viewport-first + neighbor ring).
//
// Usage: node scripts/bench-traffic-dense-core.mjs
// No external data sources — the fixture is a synthetic Manhattan grid.

import {
  generateDenseCoreRoads,
  generateSparseRoads,
  coreViewportBounds,
  simulateJumpAndPan,
  simulateAllocation,
} from '../src/data/trafficDenseCoreFixture.mjs';

const DENSE_BLOCKS = 12;
const DOT_CAP = 6000;
const ALTITUDE = 1500;

// Coverage scenario: an ultra-dense grid where the road COUNT exceeds the
// global dot cap, so the fairness seed pass itself cannot cover every road.
// This is the exact "no visible road starved behind off-screen segments"
// contract — viewport-first ordering decides which roads keep their seed.
const COVERAGE_BLOCKS = 56;
const COVERAGE_BLOCK_DEG = 0.00085;
const COVERAGE_ALTITUDE = 800;

const denseRoads = generateDenseCoreRoads({ blocks: DENSE_BLOCKS });
const viewport = coreViewportBounds({ blocks: DENSE_BLOCKS });

const coverageRoads = generateDenseCoreRoads({
  blocks: COVERAGE_BLOCKS,
  blockSizeDeg: COVERAGE_BLOCK_DEG,
});
const coverageViewport = coreViewportBounds({
  blocks: COVERAGE_BLOCKS,
  blockSizeDeg: COVERAGE_BLOCK_DEG,
});

// ── Timing: jump-to-city + fast pan ────────────────────────
const oldTiming = simulateJumpAndPan({ prefetchEnabled: false });
const newTiming = simulateJumpAndPan({ prefetchEnabled: true });

// ── Coverage: viewport-first allocation under the cap ──────
const oldAllocation = simulateAllocation({
  roads: coverageRoads, viewportBounds: coverageViewport, dotCap: DOT_CAP, altitude: COVERAGE_ALTITUDE, viewportFirst: false,
});
const newAllocation = simulateAllocation({
  roads: coverageRoads, viewportBounds: coverageViewport, dotCap: DOT_CAP, altitude: COVERAGE_ALTITUDE, viewportFirst: true,
});

// Tight-cap probe: when the cap is below the road count, viewport-first
// ordering decides which roads keep their seed dot.
const TIGHT_CAP = 4000;
const tightOld = simulateAllocation({
  roads: coverageRoads, viewportBounds: coverageViewport, dotCap: TIGHT_CAP, altitude: COVERAGE_ALTITUDE, viewportFirst: false,
});
const tightNew = simulateAllocation({
  roads: coverageRoads, viewportBounds: coverageViewport, dotCap: TIGHT_CAP, altitude: COVERAGE_ALTITUDE, viewportFirst: true,
});

// ── Sparse-scene regression: dot counts must match ─────────
const sparseRoads = generateSparseRoads();
const sparseViewport = {
  south: 30.2672 - 0.01, north: 30.2672 + 0.01,
  west: -97.7431 - 0.01, east: -97.7431 + 0.01,
};
const sparseOld = simulateAllocation({
  roads: sparseRoads, viewportBounds: sparseViewport, dotCap: DOT_CAP, altitude: ALTITUDE, viewportFirst: false,
});
const sparseNew = simulateAllocation({
  roads: sparseRoads, viewportBounds: sparseViewport, dotCap: DOT_CAP, altitude: ALTITUDE, viewportFirst: true,
});

const line = (label, value) => `${label.padEnd(46)} ${value}`;

console.log('P0.3 dense-core benchmark (synthetic fixture, no network)');
console.log('='.repeat(72));
console.log(line(`dense-core roads (blocks=${DENSE_BLOCKS})`, denseRoads.length));
console.log(line(`viewport-visible roads`, `${newAllocation.visibleTotal} / ${coverageRoads.length}`));
console.log('');
console.log('── Jump-to-city + fast pan: time to full visible-road coverage ──');
console.log(line('old (serial single-tile) total coverage', `${oldTiming.totalCoverageMs} ms`));
console.log(line('new (neighbor prefetch ring) total coverage', `${newTiming.totalCoverageMs} ms`));
console.log(line('improvement', `${newTiming.improvementMs} ms (${newTiming.improvementPct.toFixed(1)}%)`));
console.log(line('  jump coverage (target full)', `${newTiming.jumpCoverageMs} ms`));
console.log(line('  pan coverage (neighbor full)', `${newTiming.panCoverageMs} ms`));
console.log('');
console.log(`── Viewport-first allocation under the dot cap (blocks=${COVERAGE_BLOCKS}, alt=${COVERAGE_ALTITUDE}m) ──`);
console.log(line('ideal dots (uncapped)', newAllocation.idealDots));
console.log(line(`visible-road coverage @ cap=${DOT_CAP} (old)`, `${oldAllocation.coveragePct.toFixed(1)}% (${oldAllocation.visibleCovered}/${oldAllocation.visibleTotal})`));
console.log(line(`visible-road coverage @ cap=${DOT_CAP} (new)`, `${newAllocation.coveragePct.toFixed(1)}% (${newAllocation.visibleCovered}/${newAllocation.visibleTotal})`));
console.log(line(`visible-road coverage @ cap=${TIGHT_CAP} (old)`, `${tightOld.coveragePct.toFixed(1)}% (${tightOld.visibleCovered}/${tightOld.visibleTotal})`));
console.log(line(`visible-road coverage @ cap=${TIGHT_CAP} (new)`, `${tightNew.coveragePct.toFixed(1)}% (${tightNew.visibleCovered}/${tightNew.visibleTotal})`));
console.log(line('old total dots', oldAllocation.totalDots));
console.log(line('new total dots', newAllocation.totalDots));
console.log('');
console.log('── Sparse-scene regression (common case) ──');
console.log(line('sparse roads', sparseRoads.length));
console.log(line('old dot count', sparseOld.totalDots));
console.log(line('new dot count', sparseNew.totalDots));
console.log(line('delta', `${sparseNew.totalDots - sparseOld.totalDots} (${sparseOld.totalDots ? (((sparseNew.totalDots - sparseOld.totalDots) / sparseOld.totalDots) * 100).toFixed(2) : 0}%)`));
console.log(line('old visible coverage', `${sparseOld.coveragePct.toFixed(1)}%`));
console.log(line('new visible coverage', `${sparseNew.coveragePct.toFixed(1)}%`));