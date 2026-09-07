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
const ENABLED_KEY = 'devilsEyeView.radarOverlay.enabled';

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
    tilingScheme: new Cesium.WebMapTilingScheme(),
    enablePickFeatures: false,
  });
}

// ─── Controller ─────────────────────────────────────────────────────────────

/**
 * RainViewerOverlayController manages a Cesium ImageryLayer showing live radar
 * precipitation tiles. It is instantiated once by mapStackController.js and
 * lives for the session; the globe stack controller calls `setEnabled()` to
 * show/hide it when the user toggles the Radar button in the display panel.
 *
 * Lifecycle:
 *   constructor(viewer)          → builds provider, creates layer, hides it
 *   setEnabled(enabled: boolean) → show / hide; persists preference
 *   refresh()                     → fetch latest frame and update provider URL
 *   destroy()                     → remove layer, cancel pending fetches
 */
export class RainViewerOverlayController {
  /**
   * @param {Cesium.Viewer} viewer
   */
  constructor(viewer) {
    this._viewer = viewer;
    this._layer = null;
    this._provider = null;
    this._currentFrame = null;
    this._enabled = this._readStoredEnabled();
    this._destroyed = false;

    // Build the initial provider (latest frame) and imagery layer.
    this._init().catch((err) => {
      console.warn('[RadarOverlay] init failed:', err);
    });
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

  // ── Init ─────────────────────────────────────────────────────────────────

  /**
   * Fetch the latest frame and create the imagery layer.
   * @returns {Promise<void>}
   */
  async _init() {
    const frame = await fetchLatestFrame();
    if (this._destroyed) return;
    this._currentFrame = frame;
    this._provider = buildProvider(frame ?? { path: '/', host: 'https://tilecache.rainviewer.com' });
    this._layer = new Cesium.ImageryLayer(this._provider, {
      show: false,
      // Moderate opacity so the basemap bleeds through — users can still
      // orient geographically while seeing precipitation intensity.
      alpha: 0.65,
    });
    this._viewer.imageryLayers.add(this._layer);
    // Apply initial enabled state.
    if (this._enabled) {
      this._layer.show = true;
    }
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
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this._enabled = enabled;
    this._persistEnabled(enabled);
    if (this._layer) {
      this._layer.show = enabled;
    }
  }

  /**
   * Toggle the overlay. Returns the new enabled state.
   * @returns {boolean}
   */
  toggle() {
    this.setEnabled(!this._enabled);
    return this._enabled;
  }

  /**
   * Whether the layer is ready yet. Until `_init()` builds the imagery layer
   * (it fetches the latest radar frame first), `_layer` is null and a toggle
   * looks like a silent no-op. Used by the map-stack controller to surface a
   * synthetic "pending" state rather than a false "off".
   * @returns {boolean}
   */
  get isReady() {
    return this._layer != null;
  }

  /**
   * Refresh to the latest radar frame. Safe to call on a timer or on demand.
   * @returns {Promise<void>}
   */
  async refresh() {
    if (this._destroyed) return;
    const frame = await fetchLatestFrame();
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
