/**
 * RainViewer radar overlay controller.
 *
 * Adds a live precipitation radar Cesium imagery layer sourced from the free
 * RainViewer public API (no key required, personal/educational use).
 *
 * Attribution required: "Weather data by RainViewer" with a link to
 * rainviewer.com — see https://www.rainviewer.com/api.html
 *
 * API reference: https://github.com/RainViewer/rainviewer-api-example
 *   - API endpoint: https://api.rainviewer.com/public/weather-maps.json
 *   - Response: { version, generated, host: "https://tilecache.rainviewer.com",
 *                 radar: { past: [{time, path}], nowcast: [] } }
 *   - Tile URL: {host}{path}/{size}/{z}/{x}/{y}/{color}_{size}.png
 *     e.g. https://tilecache.rainviewer.com/v2/radar/d7dacfda7b52/512/6/36/2/2_1.png
 *   - Default color scheme: 2_1 (universal blue, free-tier default)
 *   - Personal-use zoom cap: level 7 (512px tiles)
 *   - Frames refreshed every ~10 minutes.
 */

import * as Cesium from 'cesium';

// ─── Constants ───────────────────────────────────────────────────────────────

/** RainViewer public API endpoint — no key required. */
const RV_API_URL = 'https://api.rainviewer.com/public/weather-maps.json';

/** Tile size in pixels. 512 is the max for the free personal-use tier. */
const TILE_SIZE = 512;

/** Color scheme ID (2 = universal blue, RainViewer free-tier default). */
const COLOR_SCHEME = '2';

/** Options: {smooth}_{snow}. 1_1 = smoothed + show snow. */
const SMOOTH_SNOW = '1_1';

/** How long to cache the weather-maps response before refetching. */
const MAPS_CACHE_TTL_MS = 30 * 60 * 1000;

/** localStorage key for the enabled preference. */
const ENABLED_KEY = 'evolEyeView.radarOverlay.enabled';

// ─── Credit ─────────────────────────────────────────────────────────────────

/** RainViewer requires visible attribution. */
const CREDIT_HTML =
  'Weather data by <a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>';

// ─── API client ─────────────────────────────────────────────────────────────

/**
 * Weather-maps response shape.
 * @typedef {{ version: string, generated: number, host: string,
 *             radar: { past: Array<{time: number, path: string}>, nowcast: Array },
 *             satellite: { infrared: Array } }} WeatherMapsResponse
 */

/**
 * Radar frame extracted from the weather-maps response.
 * @typedef {{ time: number, path: string, host: string }} RadarFrame
 */

/** Cached weather-maps response. */
let _mapsCache = null;
/** Timestamp (Date.now()) when _mapsCache was fetched. */
let _mapsCacheAt = 0;

/**
 * Fetch and cache the RainViewer weather-maps manifest.
 * Returns the full parsed response, or null if the API is unreachable.
 * @returns {Promise<WeatherMapsResponse|null>}
 */
async function fetchWeatherMaps() {
  const now = Date.now();
  if (_mapsCache && now - _mapsCacheAt < MAPS_CACHE_TTL_MS) {
    return _mapsCache;
  }
  try {
    const response = await fetch(RV_API_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const maps = await response.json();
    if (!maps?.host || !Array.isArray(maps?.radar?.past)) {
      throw new Error('Unexpected RainViewer weather-maps format');
    }
    _mapsCache = maps;
    _mapsCacheAt = now;
    return maps;
  } catch (err) {
    console.warn('[RadarOverlay] weather-maps fetch failed:', err?.message ?? err);
    return null;
  }
}

/**
 * Return the most recent radar frame, or null if unavailable.
 * @returns {Promise<RadarFrame|null>}
 */
async function fetchLatestFrame() {
  const maps = await fetchWeatherMaps();
  if (!maps || !maps.radar?.past?.length) return null;
  const frame = maps.radar.past[0];
  return {
    time: frame.time,
    path: frame.path,
    host: maps.host,
  };
}

// ─── Tile URL builder ────────────────────────────────────────────────────────

/**
 * Build a RainViewer tile URL from a radar frame and Cesium tile coords.
 *
 * Tile URL format (from RainViewer API docs + github example):
 *   {host}{path}/{size}/{z}/{x}/{y}/{color}_{size}.png
 * e.g. https://tilecache.rainviewer.com/v2/radar/d7dacfda7b52/512/6/36/2/2_1.png
 *
 * @param {RadarFrame} frame — frame from fetchLatestFrame()
 * @param {number} z         — zoom level
 * @param {number} x         — tile column
 * @param {number} y         — tile row
 * @returns {string}
 */
function buildTileUrl(frame, z, x, y) {
  // host may or may not end with a slash; normalize.
  const host = frame.host.endsWith('/') ? frame.host : `${frame.host}/`;
  // path always starts with a slash (e.g. "/v2/radar/d7dacfda7b52").
  const base = `${host}${frame.path.replace(/^\//, '')}`;
  // RainViewer tile URL format (per docs):
  //   {host}{path}/{size}/{z}/{x}/{y}/{color}/{options}.png
  // where color and options are SEPARATE path segments, not joined.
  // e.g. .../512/2/2/1/2/1_1.png  (color=2, options=1_1)
  // The old code merged them into one segment (2_1) → every tile 404.
  return `${base}/${TILE_SIZE}/${z}/${x}/${y}/${COLOR_SCHEME}/${SMOOTH_SNOW}.png`;
}

// ─── Imagery provider ────────────────────────────────────────────────────────

/**
 * Build the UrlTemplateImageryProvider for the given radar frame.
 * @param {RadarFrame} frame
 * @returns {Cesium.UrlTemplateImageryProvider}
 */
function buildProvider(frame) {
  return new Cesium.UrlTemplateImageryProvider({
    url: buildTileUrl(frame, '{z}', '{x}', '{y}'),
    credit: CREDIT_HTML,
    minimumLevel: 0,
    // Personal-use tier is capped at zoom 7. Setting maximumLevel higher is safe
    // (Cesium simply won't request those levels above the available data) but
    // avoids exposing empty/missing tile artifacts.
    maximumLevel: 7,
    rectangle: Cesium.Rectangle.fromDegrees(-180, -90, 180, 90),
    // Tiles are in EPSG:3857 (Web Mercator). UrlTemplateImageryProvider defaults
    // to geographic if omitted, which produces a misaligned overlay.
    // NOTE: `Cesium.WebMapTilingScheme` does not exist in Cesium >= 1.104
    // (removed with the old WebMapServiceImageryProvider API) — constructing it
    // throws "not a constructor", which silently killed the overlay on every
    // build attempt. `WebMercatorTilingScheme` is the correct EPSG:3857 scheme.
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    enablePickFeatures: false,
  });
}

// ─── Controller ─────────────────────────────────────────────────────────────

/**
 * RainViewerOverlayController manages a Cesium ImageryLayer showing live radar
 * precipitation tiles. It is instantiated once by mapStackController.js and
 * lives for the session; the globe stack controller calls `setEnabled()` to
 * show/hide it when the user toggles the Radar button.
 *
 * Lifecycle:
 *   constructor(viewer)          → starts an async build (fetch + layer)
 *   setEnabled(enabled: boolean) → show / hide; persists preference; queues
 *                                  intent if the layer isn't built yet
 *   toggle()                     → flips enabled, returns the new state
 *   refresh()                    → fetch latest frame and update provider URL
 *   destroy()                    → remove layer, cancel pending fetches
 */
export class RainViewerOverlayController {
  /**
   * @param {Cesium.Viewer} viewer
   * @param {object} [options]
   * @param {(controller: RainViewerOverlayController) => void} [options.onStateChange]
   *   Called whenever the overlay's enabled/ready state changes (init completes,
   *   a toggle lands, a retry exhausts). Lets the UI reconcile its button
   *   instead of leaving it stuck in "pending".
   * @param {object} [options.deps] — test seam for the Cesium-bound factories.
   *   Defaults to the real implementations; unit tests inject fakes so the
   *   controller logic can run without a WebGL/Cesium runtime.
   * @param {(frame: RadarFrame) => object} [options.deps.buildProvider]
   * @param {(provider: object, options: object) => object} [options.deps.createLayer]
   * @param {() => Promise<RadarFrame|null>} [options.deps.fetchLatestFrame]
   * @param {(ms: number) => Promise<void>} [options.deps.sleep]
   */
  constructor(viewer, { onStateChange = null, deps = {} } = {}) {
    this._viewer = viewer;
    this._layer = null;
    this._provider = null;
    this._currentFrame = null;
    this._enabled = this._readStoredEnabled();
    this._destroyed = false;
    this._buildGen = 0;
    this._lastError = null;
    this._onStateChange = onStateChange;
    this._deps = {
      buildProvider,
      createLayer: (provider, options) => new Cesium.ImageryLayer(provider, options),
      fetchLatestFrame,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...deps,
    };

    // Build the initial provider (latest frame) and imagery layer. Fire-and-forget:
    // _loadAndBuild reconciles with _enabled on BOTH success and failure, so a
    // toggle that lands before this resolves is never dropped.
    this._requestBuild();
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  _readStoredEnabled() {
    try {
      return localStorage.getItem(ENABLED_KEY) === '1';
    } catch {
      return false;
    }
  }

  _persistEnabled(enabled) {
    try {
      localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0');
    } catch { /* best effort */ }
  }

  // ── Build / retry ────────────────────────────────────────────────────────

  /**
   * Start a fresh build attempt. Each call bumps `_buildGen`; an older in-flight
   * attempt aborts when it notices it has been superseded, so a `setEnabled(true)`
   * that lands mid-backoff is honored instead of being clobbered by the older
   * attempt's failure reset.
   */
  _requestBuild() {
    const gen = ++this._buildGen;
    this._loadAndBuild(gen).catch((err) => {
      console.warn('[RadarOverlay] init failed:', err);
    });
  }

  /**
   * Fetch the latest frame (retrying with backoff while enabled) and build the
   * imagery layer. Reconciles the layer's visibility with `_enabled` on both
   * success and failure. Never throws.
   * @param {number} gen — build generation this attempt belongs to
   * @returns {Promise<void>}
   */
  async _loadAndBuild(gen) {
    const frame = await this._fetchFrameWithRetry(gen);
    if (this._destroyed || gen !== this._buildGen) return; // superseded
    if (!frame) {
      // Retries exhausted while enabled → we cannot show radar. Reset to off so
      // the button reads "off" (not stuck pending) and surface the reason.
      if (this._enabled) {
        this._enabled = false;
        this._persistEnabled(false);
        this._lastError = 'Radar unavailable — RainViewer could not be reached';
        console.warn(`[RadarOverlay] ${this._lastError}`);
      }
      this._emitStateChange();
      return;
    }
    this._buildLayer(frame);
    // Reconcile: apply the CURRENT enabled state (a toggle may have landed
    // while the fetch was in flight).
    if (this._layer) this._layer.show = this._enabled;
    this._emitStateChange();
  }

  /**
   * Fetch the latest radar frame, retrying with backoff (2s/4s/8s) while the
   * overlay is still enabled. Stops early if the controller is destroyed or the
   * build attempt is superseded. Returns the frame, or null once retries are
   * exhausted.
   * @param {number} gen
   * @returns {Promise<RadarFrame|null>}
   */
  async _fetchFrameWithRetry(gen) {
    const backoff = [2000, 4000, 8000];
    for (let attempt = 0; ; attempt++) {
      const frame = await this._deps.fetchLatestFrame();
      if (frame) return frame;
      if (this._destroyed || gen !== this._buildGen) return null;
      if (!this._enabled) return null; // user turned it off mid-backoff
      if (attempt >= backoff.length) return null; // retries exhausted
      await this._sleep(backoff[attempt]);
    }
  }

  _sleep(ms) {
    return this._deps.sleep(ms);
  }

  /**
   * Build (or rebuild) the imagery layer for the given frame, keeping it above
   * the active basemap. Idempotent: a stale layer is removed first.
   * @param {RadarFrame} frame
   */
  _buildLayer(frame) {
    this._currentFrame = frame;
    this._provider = this._deps.buildProvider(frame);
    if (this._layer) {
      this._viewer.imageryLayers.remove(this._layer, false);
    }
    this._layer = this._deps.createLayer(this._provider, {
      show: false,
      // Moderate opacity so the basemap bleeds through — users can still
      // orient geographically while seeing precipitation intensity.
      alpha: 0.65,
    });
    // `add` appends at the top of the imagery stack, above the basemap that
    // _activateGlobeStack inserts at index 0 — the overlay must render on top.
    this._viewer.imageryLayers.add(this._layer);
  }

  _emitStateChange() {
    this._onStateChange?.(this);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** True if the overlay is currently visible. */
  get isVisible() {
    return this._layer?.show ?? false;
  }

  /** The current radar frame metadata, or null. */
  get currentFrame() {
    return this._currentFrame;
  }

  /**
   * Show or hide the radar overlay and persist the preference.
   *
   * `_enabled` is the source of truth and is set synchronously, so a click
   * always takes effect immediately. If the layer isn't built yet (init still
   * in flight, or a prior fetch failure left it null), the intent is queued via
   * `_enabled` and a build is (re)started — the click is never dropped.
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this._enabled = enabled;
    this._persistEnabled(enabled);
    if (this._layer) {
      this._layer.show = enabled;
    } else if (enabled) {
      // Layer not built yet — kick off a (re)build so the intent isn't dropped.
      this._requestBuild();
    }
    this._emitStateChange();
  }

  /**
   * Toggle the overlay. Returns the new enabled state synchronously so the
   * button can reflect the click immediately.
   * @returns {boolean}
   */
  toggle() {
    this.setEnabled(!this._enabled);
    return this._enabled;
  }

  /**
   * Whether the layer is ready yet. Until a build completes (it fetches the
   * latest radar frame first), `_layer` is null and a toggle looks like a
   * silent no-op. Used by the UI to surface a synthetic "pending" state rather
   * than a false "off".
   * @returns {boolean}
   */
  get isReady() {
    return this._layer != null;
  }

  /**
   * Human-readable reason the overlay is unavailable, or null if it is ready.
   * Set when a fetch/retry exhausts; surfaced in the button title so the user
   * isn't left with a silent "off".
   * @returns {string|null}
   */
  get lastError() {
    return this._lastError;
  }

  /**
   * Refresh to the latest radar frame. Safe to call on a timer or on demand.
   * @returns {Promise<void>}
   */
  async refresh() {
    if (this._destroyed) return;
    const frame = await this._deps.fetchLatestFrame();
    if (this._destroyed || !frame) return;
    // Skip if the frame path hasn't actually changed.
    if (frame.path === this._currentFrame?.path) return;
    this._currentFrame = frame;
    // Swap the provider URL — Cesium's imagery layer will discard its cached
    // tiles for the old timestamp and start fetching new tiles.
    if (this._provider) {
      this._provider.url = buildTileUrl(frame, '{z}', '{x}', '{y}');
    }
  }

  /**
   * Set the radar layer opacity.
   * @param {number} alpha — 0 (invisible) to 1 (opaque)
   */
  setAlpha(alpha) {
    if (this._layer) {
      this._layer.alpha = Math.max(0, Math.min(1, alpha));
    }
  }

  /**
   * Tear down the overlay. Call once on app destroy.
   */
  destroy() {
    this._destroyed = true;
    if (this._layer) {
      this._viewer.imageryLayers.remove(this._layer, false);
      this._layer = null;
    }
    this._provider = null;
    this._currentFrame = null;
  }
}
