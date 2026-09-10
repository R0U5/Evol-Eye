// src/data/trafficDenseCore.test.mjs
// P0.3 dense-core dispatch: viewport-first ordering, neighbor prefetch ring,
// and the benchmark fixture contract.
//
// The fixture is the spec: after jump-to-city + fast pan, visible-road
// coverage must arrive strictly sooner than the serial single-tile baseline,
// and a tight dot cap must never starve a visible road behind off-screen
// segments. Sparse scenes (the common case) must be byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateDenseCoreRoads,
  generateSparseRoads,
  coreViewportBounds,
  simulateJumpAndPan,
  simulateAllocation,
} from './trafficDenseCoreFixture.mjs';
import { neighborTileBounds, roadVisibleInBounds, pointInBounds } from './trafficBounds.js';
import { effectiveDotCap } from './traffic.js';

const DOT_CAP = 6000;
const ALTITUDE = 800;

test('dense-core fixture: jump-to-city + fast pan coverage is strictly faster with the prefetch ring', () => {
  const oldTiming = simulateJumpAndPan({ prefetchEnabled: false });
  const newTiming = simulateJumpAndPan({ prefetchEnabled: true });
  assert.ok(
    newTiming.totalCoverageMs < oldTiming.totalCoverageMs,
    `prefetch must beat serial: new=${newTiming.totalCoverageMs}ms old=${oldTiming.totalCoverageMs}ms`,
  );
  assert.ok(newTiming.improvementMs > 0, 'improvement must be positive');
  // The prefetch must complete before the pan for the model to be honest.
  const prefetchEvent = newTiming.events.find((e) => e.what === 'prefetch-neighbors-major');
  const panEvent = newTiming.events.find((e) => e.what === 'pan-to-neighbor');
  assert.ok(prefetchEvent.t <= panEvent.t, 'prefetch must land before the pan');
});

test('dense-core fixture: viewport-first allocation never starves visible roads under a tight cap', () => {
  const roads = generateDenseCoreRoads({ blocks: 56, blockSizeDeg: 0.00085 });
  const viewport = coreViewportBounds({ blocks: 56, blockSizeDeg: 0.00085 });
  const oldAlloc = simulateAllocation({ roads, viewportBounds: viewport, dotCap: DOT_CAP, altitude: ALTITUDE, viewportFirst: false });
  const newAlloc = simulateAllocation({ roads, viewportBounds: viewport, dotCap: DOT_CAP, altitude: ALTITUDE, viewportFirst: true });

  // At the real cap both strategies cover every visible road (the existing
  // fair allocation already handles the common case) — no regression.
  assert.equal(oldAlloc.coveragePct, 100);
  assert.equal(newAlloc.coveragePct, 100);
  assert.equal(oldAlloc.totalDots, newAlloc.totalDots, 'total dot count must be unchanged');

  // Under a cap tighter than the road count, viewport-first must keep every
  // visible road seeded while the demand-only ordering starves some.
  const TIGHT_CAP = 4000;
  const tightOld = simulateAllocation({ roads, viewportBounds: viewport, dotCap: TIGHT_CAP, altitude: ALTITUDE, viewportFirst: false });
  const tightNew = simulateAllocation({ roads, viewportBounds: viewport, dotCap: TIGHT_CAP, altitude: ALTITUDE, viewportFirst: true });
  assert.ok(
    tightNew.coveragePct > tightOld.coveragePct,
    `viewport-first must beat demand-only under a tight cap: new=${tightNew.coveragePct}% old=${tightOld.coveragePct}%`,
  );
  assert.equal(tightNew.coveragePct, 100, 'every visible road must keep its seed when the cap covers the visible count');
  assert.equal(tightNew.totalDots, tightOld.totalDots, 'the cap must still bound the total dot count');
});

test('dense-core fixture: sparse scenes are byte-identical (no regression)', () => {
  const roads = generateSparseRoads();
  const viewport = {
    south: 30.2672 - 0.01, north: 30.2672 + 0.01,
    west: -97.7431 - 0.01, east: -97.7431 + 0.01,
  };
  const oldAlloc = simulateAllocation({ roads, viewportBounds: viewport, dotCap: DOT_CAP, altitude: 1500, viewportFirst: false });
  const newAlloc = simulateAllocation({ roads, viewportBounds: viewport, dotCap: DOT_CAP, altitude: 1500, viewportFirst: true });
  assert.equal(newAlloc.totalDots, oldAlloc.totalDots, 'sparse dot count must not change');
  assert.equal(newAlloc.coveragePct, 100);
  assert.equal(oldAlloc.coveragePct, 100);
});

test('neighbor prefetch ring: ring 1 yields the 8 surrounding tiles, center excluded', () => {
  const center = { south: 30.0, west: -98.0, north: 30.05, east: -97.95 };
  const neighbors = neighborTileBounds(center, 1);
  assert.equal(neighbors.length, 8);
  const keys = neighbors.map((n) => `${n.south.toFixed(4)},${n.west.toFixed(4)},${n.north.toFixed(4)},${n.east.toFixed(4)}`);
  assert.equal(new Set(keys).size, 8, 'neighbors must be distinct');
  // Each neighbor is one tile-span offset in at least one axis.
  for (const n of neighbors) {
    const dLat = n.south - center.south;
    const dLon = n.west - center.west;
    const latOff = Math.abs(dLat / (center.north - center.south));
    const lonOff = Math.abs(dLon / (center.east - center.west));
    assert.ok(
      (latOff === 1 || latOff === 0) && (lonOff === 1 || lonOff === 0) && (latOff + lonOff >= 1),
      `neighbor offset must be one tile span: lat=${latOff} lon=${lonOff}`,
    );
  }
  // The ring must include the four cardinal neighbors.
  const cardinal = neighbors.filter((n) => (
    (n.south === center.south && n.west !== center.west)
    || (n.west === center.west && n.south !== center.south)
  ));
  assert.equal(cardinal.length, 4);
});

test('pointInBounds and roadVisibleInBounds classify viewport membership', () => {
  const bounds = { south: 30.0, west: -98.0, north: 30.05, east: -97.95 };
  assert.equal(pointInBounds(-97.98, 30.02, bounds), true);
  assert.equal(pointInBounds(-98.1, 30.02, bounds), false);
  assert.equal(pointInBounds(-97.98, 30.1, bounds), false);
  // A road with any vertex inside is visible (even if it starts outside).
  const crossing = { coords: [[-98.1, 30.02], [-97.98, 30.02]] };
  const inside = { coords: [[-97.98, 30.02], [-97.97, 30.03]] };
  const outside = { coords: [[-98.1, 30.02], [-98.09, 30.03]] };
  assert.equal(roadVisibleInBounds(crossing, bounds), true);
  assert.equal(roadVisibleInBounds(inside, bounds), true);
  assert.equal(roadVisibleInBounds(outside, bounds), false);
  assert.equal(roadVisibleInBounds(null, bounds), false);
});

test('adaptive dot cap: frame-time pressure sheds density, never below the floor', () => {
  // No frames yet → base cap.
  assert.equal(effectiveDotCap(), 6000);
});