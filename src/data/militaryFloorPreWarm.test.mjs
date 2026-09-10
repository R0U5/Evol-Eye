// src/data/militaryFloorPreWarm.test.mjs
// P0.1 Option C — military floor pre-warm.
//
// A born-grounded military contact (alt_baro:"ground", no alt_geom) has no
// altitude data at all, so pickRenderAltitudeM returns the null sentinel and
// the layer falls back to `altitudeM` (0 m on first poll). The installations
// layer pre-warms the coarse floor cells for static military installations at
// load; this suite pins the render path that consumes those warmed floors on
// the FIRST poll (no geoid sentinel) and the no-pre-warm fallback (no crash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import militaryFlightsLayer, {
  _installationFloorPreWarmAttemptedForTest,
  _setInstallationFloorPreWarmForTest,
  _setTrackedMilitaryRefreshStateForTest,
} from './militaryFlights.js';
import {
  cachedGroundFloor,
  reportMeshFloorCell,
  _clearMeshFloorCellsForTest,
  setMeshFloorPreferred,
} from './groundFloor.js';

// Kirtland AFB-ish installation cell (field elevation ~1590 m ellipsoidal).
const INSTALLATION = { lat: 35.04, lon: -106.61 };
const FLOOR_M = 1590;
const LIFT_M = 1.5;
const GROUNDED_ICAO = 'ae01ce';

/** Fake billboard collection: records every add so tests can inspect positions. */
function makeFakeBillboardCollection() {
  const billboards = [];
  return {
    show: true,
    add(options) {
      const bb = { ...options };
      billboards.push(bb);
      return bb;
    },
    remove() {},
    billboards,
  };
}

/** Seed the shared military layer state through the production test seam. */
function setupMilitaryLayerState() {
  const billboardCollection = makeFakeBillboardCollection();
  const viewer = { camera: { positionCartographic: null }, scene: {} };
  // A dummy contact populates the shared state seam; the born-grounded contact
  // under test is a DIFFERENT icao24, so the poll creates a fresh billboard
  // through the fake collection (the real render path).
  _setTrackedMilitaryRefreshStateForTest({
    icao24: 'dummy001',
    entity: null,
    billboard: {
      position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
      color: Cesium.Color.WHITE,
      show: false,
    },
    billboardCollection,
    viewer,
    tracked: false,
    meta: { onGround: false, rawLat: 0, rawLon: 0 },
  });
  return { billboardCollection, viewer };
}

/** Stub the adsb.lol feed to return exactly the given aircraft rows. */
function stubMilitaryFeed(aircraftRows) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ac: aircraftRows }),
  });
  return () => { globalThis.fetch = realFetch; };
}

/** A born-grounded military row: alt_baro:"ground", no alt_geom. */
function bornGroundedAircraft(icao24, lat, lon) {
  return {
    hex: icao24,
    lon,
    lat,
    alt_baro: 'ground',
    track: 0,
    gs: 0,
    seen: 0,
    seen_pos: 0,
    flight: 'TEST',
    t: 'C17',
    r: '00-0000',
    ownOp: 'United States Air Force',
  };
}

/** Read the rendered ellipsoidal height of a contact from the nearby cohort. */
function nearbyHeight(icao24, center) {
  const nearby = militaryFlightsLayer.getNearby(center, 500_000, 50);
  const contact = nearby.find((item) => item.icao24 === icao24);
  assert.ok(contact, `contact ${icao24} must be in the nearby cohort`);
  return Cesium.Cartographic.fromCartesian(contact.position).height;
}

test('born-grounded military contact renders at the pre-warmed installation floor on first poll', async () => {
  setMeshFloorPreferred(true);
  _clearMeshFloorCellsForTest();
  reportMeshFloorCell(INSTALLATION.lat, INSTALLATION.lon, FLOOR_M);
  assert.equal(cachedGroundFloor(INSTALLATION.lat, INSTALLATION.lon), FLOOR_M);

  const { viewer } = setupMilitaryLayerState();
  const restoreFetch = stubMilitaryFeed([
    bornGroundedAircraft(GROUNDED_ICAO, INSTALLATION.lat, INSTALLATION.lon),
  ]);
  try {
    await militaryFlightsLayer.update(viewer);
    const height = nearbyHeight(
      GROUNDED_ICAO,
      Cesium.Cartesian3.fromDegrees(INSTALLATION.lon, INSTALLATION.lat, 0),
    );
    // The floor is warm BEFORE the poll, so the born-grounded contact is lifted
    // onto it on the FIRST poll — never the 0 m / geoid sentinel.
    assert.ok(
      Math.abs(height - (FLOOR_M + LIFT_M)) < 0.01,
      `expected ${FLOOR_M + LIFT_M} m, got ${height} m`,
    );
  } finally {
    restoreFetch();
    _clearMeshFloorCellsForTest();
  }
});

test('born-grounded military contact without a pre-warm falls back to the existing default (no crash)', async () => {
  setMeshFloorPreferred(true);
  _clearMeshFloorCellsForTest();
  assert.equal(cachedGroundFloor(INSTALLATION.lat, INSTALLATION.lon), null);

  const { viewer } = setupMilitaryLayerState();
  const restoreFetch = stubMilitaryFeed([
    bornGroundedAircraft(GROUNDED_ICAO, INSTALLATION.lat, INSTALLATION.lon),
  ]);
  try {
    await militaryFlightsLayer.update(viewer);
    const height = nearbyHeight(
      GROUNDED_ICAO,
      Cesium.Cartesian3.fromDegrees(INSTALLATION.lon, INSTALLATION.lat, 0),
    );
    // No warm floor: the existing default (0 m for a first-poll grounded row)
    // holds — the poll must not crash and must not invent a floor.
    assert.ok(Math.abs(height) < 0.01, `expected 0 m default, got ${height} m`);
  } finally {
    restoreFetch();
  }
});

test('military first poll attempts the one-shot installation floor pre-warm', async () => {
  _setInstallationFloorPreWarmForTest(false);
  assert.equal(_installationFloorPreWarmAttemptedForTest(), false);

  const { viewer } = setupMilitaryLayerState();
  const restoreFetch = stubMilitaryFeed([
    bornGroundedAircraft(GROUNDED_ICAO, INSTALLATION.lat, INSTALLATION.lon),
  ]);
  try {
    await militaryFlightsLayer.update(viewer);
    assert.equal(
      _installationFloorPreWarmAttemptedForTest(),
      true,
      'the first poll must attempt the one-shot installation floor pre-warm',
    );
    // A second poll must NOT re-attempt (installations are static; one warm is
    // the bounded cost).
    await militaryFlightsLayer.update(viewer);
    assert.equal(_installationFloorPreWarmAttemptedForTest(), true);
  } finally {
    restoreFetch();
    _setInstallationFloorPreWarmForTest(false);
  }
});