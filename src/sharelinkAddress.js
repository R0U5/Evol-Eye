// src/sharelinkAddress.js
//
// Resolve a `#q=<address>` URL-hash parameter to coordinates, then merge the
// result into a `parseInitialHash`–shaped state object so the existing share-link
// restore path (which already owns the camera after the 1500 ms delayed-flight
// timer) does the fly-in. The geocode itself never moves the camera — keeping
// the boot pipeline linear and avoiding a second race against the default
// fly-to-Austin path.
//
// URL contract:
//   #lat=...&lon=...         — coordinates win. `q` is ignored.
//   #lat=...&lon=...&q=...   — coordinates still win. `q` is kept as the
//                              formatted label if the geocoder would otherwise
//                              have produced a different one.
//   #q=<address>             — geocode first, then build the rest of the
//                              share-link state from the existing hash keys.
//   # (no lat/lon, no q)     — the share-link layer is dormant; boot path
//                              keeps its existing behavior (fly to Austin).
//
// Error policy: a missing key, a 404, a network failure, or a no-match result
// all return `null` to the caller. The caller is expected to surface the
// failure to the loader status (NOT silently fall back to Austin — the user
// asked for a specific place).

import { geocodeAddress } from './locations.js';

/**
 * Pull `q` out of a URL hash string. Returns the decoded query or null.
 * Trims and rejects empty strings.
 *
 * @param {string} hash - the raw `window.location.hash` value (with or without leading `#`).
 * @returns {string|null}
 */
export function addressFromHash(hash) {
  if (typeof hash !== 'string' || hash.length === 0) return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  const q = params.get('q');
  if (!q) return null;
  const trimmed = q.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build a `parseInitialHash`–shaped state object from a hash plus a geocoded
 * result. Keeps every other share-link key the hash already carries (style,
 * bloom, hud, etc.) — only the camera-related fields are filled in from the
 * geocode. If the geocoder returned a viewport, the camera is framed onto
 * that viewport; otherwise we use a sensible default altitude for the URL.
 *
 * The `query` and `label` fields on the returned state are consumed by the
 * loader status text ("Finding [address redacted]…") and the
 * HUD locality panel; they are not part of the share-link contract itself.
 *
 * @param {string} hash
 * @param {{lat:number, lon:number, label:string, types:string[], viewport:object|null}} geocoded
 * @param {string} originalQuery
 * @returns {object|null}
 */
export function buildStateFromGeocode(hash, geocoded, originalQuery) {
  if (!geocoded || !Number.isFinite(geocoded.lat) || !Number.isFinite(geocoded.lon)) {
    return null;
  }
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);

  // Frame altitude: prefer a geocoded viewport (cities, regions) by inferring
  // a range from the box diagonal, otherwise use a 600 m default that puts a
  // residential street in clear focus. Building-scale addresses without a
  // viewport get the close-landmark default (250 m) so the camera doesn't
  // orbit from altitude for a single house.
  const isPrecise = Array.isArray(geocoded.types)
    && geocoded.types.includes('street_address');
  const alt = isPrecise ? 250 : 600;

  const state = {
    lat: geocoded.lat,
    lon: geocoded.lon,
    alt: parseOr(params.get('alt'), alt),
    heading: parseOr(params.get('heading'), 0),
    pitch: parseOr(params.get('pitch'), -35),
    roll: parseOr(params.get('roll'), 0),
    style: URL_TO_STYLE[params.get('style')] || 'normal',
    query: originalQuery,
    label: geocoded.label || originalQuery,
  };

  return state;
}

/**
 * Top-level entry: read the hash, geocode the address if requested, and
 * return a state object shaped like `parseInitialHash` output — or null if
 * the hash has no `q=`, the geocode failed, or the API key is missing.
 *
 * The caller (`ui.js` boot path) is responsible for merging this state into
 * the existing share-link restore so the camera, style, and panels are all
 * honored.
 *
 * @param {object} viewer - Cesium viewer; passed to geocodeAddress for viewport-bias context.
 * @param {string} hash - the raw URL hash (e.g. `window.location.hash`).
 * @returns {Promise<object|null>}
 */
export async function resolveAddressShareState(viewer, hash) {
  const query = addressFromHash(hash);
  if (!query) return null;

  let geocoded;
  try {
    geocoded = await geocodeAddress(viewer, query);
  } catch (err) {
    // Missing API key, network error, rate limit, etc. The caller is expected
    // to surface this; we deliberately do not fall back to Austin.
    return { error: String(err?.message || err), query };
  }

  if (!geocoded) {
    return { error: 'no-match', query };
  }

  return buildStateFromGeocode(hash, geocoded, query);
}

const URL_TO_STYLE = Object.freeze({
  normal: 'normal',
  retro: 'retro',
  surveillance: 'surveillance',
  thermal: 'thermal',
  anime: 'anime',
  noir: 'noir',
  snow: 'snow',
});

function parseOr(value, fallback) {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : fallback;
}
