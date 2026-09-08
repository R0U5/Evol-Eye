/**
 * Unit tests for the RainViewer radar overlay controller and its map-stack
 * integration (big-pickle brief 2026-09-08g-radar).
 *
 * The controller's Cesium-bound factories (buildProvider / createLayer) and
 * its network seam (fetchLatestFrame / sleep) are injected via `deps`, so the
 * async-init race, retry/backoff, and stack-switch behavior can be exercised
 * deterministically without a WebGL/Cesium runtime.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RainViewerOverlayController } from './rainViewerOverlay.js';
import { MapStackController } from '../mapStackController.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeFrame() {
  return { time: 1, path: '/v2/radar/abc', host: 'https://tilecache.rainviewer.com' };
}

function makeDeps({ fetchLatestFrame, sleep } = {}) {
  return {
    buildProvider: (frame) => ({ url: `https://tilecache.rainviewer.com${frame.path}` }),
    createLayer: (provider, options) => ({ ...options, provider }),
    fetchLatestFrame: fetchLatestFrame || (async () => makeFrame()),
    sleep: sleep || (async () => {}),
  };
}

function makeViewer() {
  const layers = [];
  return {
    imageryLayers: {
      add: (layer, index) => {
        if (index === 0) layers.unshift(layer);
        else layers.push(layer);
      },
      remove: (layer) => {
        const i = layers.indexOf(layer);
        if (i !== -1) layers.splice(i, 1);
      },
    },
    scene: {
      globe: { show: true },
      frameState: { creditDisplay: { addStaticCredit: () => {}, removeStaticCredit: () => {} } },
      setTerrain: () => {},
      primitives: { add: () => {} },
    },
    terrainProvider: null,
  };
}

function makeLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
}

function resetLocalStorage(enabled) {
  globalThis.localStorage = makeLocalStorage(
    enabled ? { 'devilsEyeView.radarOverlay.enabled': '1' } : {},
  );
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Flush the microtask/macrotask queue repeatedly until a condition holds. */
async function flushUntil(condition, { tries = 50 } = {}) {
  for (let i = 0; i < tries && !condition(); i += 1) {
    await flushPromises();
  }
}

// ─── 1. Toggle before `_init` resolves ──────────────────────────────────────

test('toggle before init resolves: _enabled flips immediately, layer shows when ready', async () => {
  resetLocalStorage(false);
  const pending = [];
  const fetchLatestFrame = () => new Promise((resolve) => { pending.push(resolve); });
  const controller = new RainViewerOverlayController(makeViewer(), {
    deps: makeDeps({ fetchLatestFrame }),
  });

  assert.equal(controller._enabled, false);
  const newState = controller.toggle();
  assert.equal(newState, true, 'toggle() must return the new state synchronously');
  assert.equal(controller._enabled, true, 'the click must never feel dead');
  assert.equal(controller.isVisible, false, 'layer not built yet → pending');

  // Resolve every in-flight fetch (the toggle restarted the build).
  for (const resolve of pending.splice(0)) resolve(makeFrame());
  await flushPromises();

  assert.equal(controller.isReady, true);
  assert.equal(controller.isVisible, true, 'init completion must reconcile with _enabled');
});

// ─── 2. Toggle after `_init` ────────────────────────────────────────────────

test('toggle after init: layer show toggles', async () => {
  resetLocalStorage(false);
  const controller = new RainViewerOverlayController(makeViewer(), { deps: makeDeps() });
  await flushPromises();
  assert.equal(controller.isReady, true);
  assert.equal(controller.isVisible, false, 'starts off');

  assert.equal(controller.toggle(), true);
  assert.equal(controller.isVisible, true);

  assert.equal(controller.toggle(), false);
  assert.equal(controller.isVisible, false);
});

// ─── 3. Fetch failure → retries, no throw, final failure resets ─────────────

test('fetch failure: retries with backoff, no throw, final failure resets enabled with explanatory error', async () => {
  resetLocalStorage(true); // starts enabled so the retry loop runs
  let calls = 0;
  const sleeps = [];
  const fetchLatestFrame = async () => { calls += 1; return null; };
  const sleep = async (ms) => { sleeps.push(ms); };
  const controller = new RainViewerOverlayController(makeViewer(), {
    deps: makeDeps({ fetchLatestFrame, sleep }),
  });
  await flushUntil(() => calls >= 4);

  assert.equal(calls, 4, 'initial attempt + 3 retries');
  assert.deepEqual(sleeps, [2000, 4000, 8000], 'backoff schedule');
  assert.equal(controller._enabled, false, 'not stuck pending — reset to off');
  assert.equal(controller.isReady, false);
  assert.equal(controller.lastError, 'Radar unavailable — RainViewer could not be reached');
});

// ─── 4. Re-enable after a failure rebuilds and shows the layer ──────────────

test('setEnabled(true) after a failure rebuilds and shows the layer', async () => {
  resetLocalStorage(true); // initial build runs the full retry loop
  let calls = 0;
  const fetchLatestFrame = async () => { calls += 1; return calls <= 4 ? null : makeFrame(); };
  const controller = new RainViewerOverlayController(makeViewer(), {
    deps: makeDeps({ fetchLatestFrame, sleep: async () => {} }),
  });
  await flushUntil(() => calls >= 4);

  // Initial build exhausted retries → enabled reset to off, no layer.
  assert.equal(calls, 4);
  assert.equal(controller._enabled, false);
  assert.equal(controller.isReady, false);

  // API recovers; re-enabling rebuilds and shows the layer.
  controller.setEnabled(true);
  await flushPromises();
  assert.equal(controller.isReady, true);
  assert.equal(controller.isVisible, true);
});

// ─── 4b. Real provider builder must construct (root-cause regression) ───────

test('real buildProvider constructs with the installed Cesium (WebMercatorTilingScheme, not removed WebMapTilingScheme)', async () => {
  resetLocalStorage(false);
  // Use the REAL buildProvider; only the layer factory and network are faked.
  // Regression: `Cesium.WebMapTilingScheme` was removed in Cesium >= 1.104 and
  // `new Cesium.WebMapTilingScheme()` throws "not a constructor", which killed
  // the overlay on every build attempt in the browser.
  const controller = new RainViewerOverlayController(makeViewer(), {
    deps: {
      createLayer: (provider, options) => ({ ...options, provider }),
      fetchLatestFrame: async () => makeFrame(),
      sleep: async () => {},
    },
  });
  await flushPromises();
  assert.equal(controller.isReady, true, 'the real provider builder must not throw');
  assert.ok(controller._provider, 'provider built');
  assert.match(String(controller._provider.url), /tilecache\.rainviewer\.com/);
});

// ─── 5. mapStackController: photoreal preserves, globe stack restores ───────

test('mapStackController: radar preference survives photoreal and is restored on globe stacks', async () => {
  globalThis.window = { dispatchEvent: () => {} };
  resetLocalStorage(false);

  const viewer = makeViewer();
  const controller = new MapStackController(viewer, {
    googleTileset: null,
    initialStack: 'esri-imagery',
    radarOverlayDeps: makeDeps(),
  });
  await flushPromises(); // let the internal overlay's initial build settle

  // Enable radar.
  controller.setRadarOverlayEnabled(true);
  assert.equal(controller._radarOverlay._enabled, true);
  assert.equal(controller._radarOverlay.isVisible, true);

  // Stub the Cesium-heavy internals so activation runs headless. The fake
  // provider carries the tilingScheme Cesium.ImageryLayer's constructor needs.
  const fakeProvider = {
    tilingScheme: { tileXYToRectangle: () => ({ west: 0, south: 0, east: 1, north: 1 }) },
    rectangle: { west: 0, south: 0, east: 1, north: 1 },
    ready: true,
  };
  controller._getImageryProvider = async () => ({
    provider: fakeProvider,
    effectiveStackId: 'esri-imagery',
    fallbackMessage: null,
  });
  controller._setWorldTerrainEnabled = async () => {};
  controller._syncEsriAttribution = () => {};

  // Photoreal: preference preserved, layer not hidden.
  controller._switchGen = 1;
  await controller._activatePhotoreal(1);
  assert.equal(controller._radarOverlay._enabled, true, 'photoreal must not clobber the radar preference');
  assert.equal(controller._radarOverlay.isVisible, true, 'photoreal must not hide the radar layer');

  // Globe stack: radar restored to visible.
  controller._switchGen = 2;
  await controller._activateGlobeStack({ id: 'esri-imagery' }, 2);
  assert.equal(controller._radarOverlay.isVisible, true, 'entering a globe stack restores the radar overlay');
});

// ─── 6. HTML: old toggle gone, new button present, no duplicate ids ─────────

test('HTML: radar toggle removed from #pp-toggles, radar button in Visual Presets grid, no duplicate ids', () => {
  const html = readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

  // Old toggle gone.
  assert.equal(html.includes('id="radar-toggle"'), false, 'old #radar-toggle must be removed');

  // New button present in the style grid.
  assert.match(html, /class="style-btn radar-btn"[^>]*data-radar="true"/, 'radar button must be in the Visual Presets grid');

  // No duplicate ids anywhere.
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], 'no duplicate ids in index.html');
});