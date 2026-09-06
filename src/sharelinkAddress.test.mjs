// src/sharelinkAddress.test.mjs
//
// URL-hash address resolver. Pure functions over the hash string and a
// geocoded result — no network, no Cesium, no DOM. Locks the contract:
//
//   * `q` is the only field that triggers a geocode.
//   * When `q` is present, the geocode result is the source of truth for
//     lat/lon; the URL cannot override.
//   * When `q` is missing, the resolver returns null (caller falls through
//     to the normal lat/lon share-link restore).
//   * Errors are returned as `{ error, query }` objects, never thrown, so
//     the boot pipeline can surface them in the loader status without
//     crashing the app.
//   * `street_address` types get a 250 m default altitude (close enough to
//     see the building); everything else (cities, regions, landmarks) gets
//     600 m so the geocoded viewport is honored.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addressFromHash,
  buildStateFromGeocode,
} from './sharelinkAddress.js';

test('addressFromHash returns null when hash is empty', () => {
  assert.equal(addressFromHash(''), null);
  assert.equal(addressFromHash('#'), null);
});

test('addressFromHash returns null when there is no `q`', () => {
  assert.equal(addressFromHash('#lat=38.5&lon=-121.4'), null);
  assert.equal(addressFromHash('#style=retro'), null);
});

test('addressFromHash returns null for whitespace-only `q`', () => {
  assert.equal(addressFromHash('#q='), null);
  assert.equal(addressFromHash('#q=%20%20'), null);
  assert.equal(addressFromHash('#q=   '), null);
});

test('addressFromHash returns the trimmed address', () => {
  assert.equal(addressFromHash('#q=5561+48th+Street'), '5561 48th Street');
  assert.equal(addressFromHash('#q=%205561%2048th%20Street%20'), '5561 48th Street');
  assert.equal(addressFromHash('q=Austin,+TX'), 'Austin, TX');
});

test('addressFromHash works whether or not hash has a leading #', () => {
  assert.equal(addressFromHash('#q=Sacramento'), 'Sacramento');
  assert.equal(addressFromHash('q=Sacramento'), 'Sacramento');
});

test('addressFromHash picks `q` even when other keys are present', () => {
  assert.equal(
    addressFromHash('#lat=38.5&lon=-121.4&q=Sacramento'),
    'Sacramento',
  );
});

test('buildStateFromGeocode returns null for null input', () => {
  assert.equal(buildStateFromGeocode('#q=foo', null, 'foo'), null);
});

test('buildStateFromGeocode returns null for non-finite coordinates', () => {
  assert.equal(
    buildStateFromGeocode('#q=foo', { lat: NaN, lon: -121.4, label: 'x' }, 'foo'),
    null,
  );
  assert.equal(
    buildStateFromGeocode('#q=foo', { lat: 38.5, lon: Infinity, label: 'x' }, 'foo'),
    null,
  );
});

test('buildStateFromGeocode fills lat/lon from the geocoded result, not the URL', () => {
  // Even if the URL had bogus coordinates, the geocode result wins.
  const state = buildStateFromGeocode(
    '#lat=99&lon=99&q=5561+48th+Street',
    { lat: 38.5254, lon: -121.4475, label: '5561 48th St, Sacramento, CA 95820', types: ['street_address'], viewport: null },
    '5561 48th Street',
  );
  assert.equal(state.lat, 38.5254);
  assert.equal(state.lon, -121.4475);
  assert.equal(state.query, '5561 48th Street');
  assert.equal(state.label, '5561 48th St, Sacramento, CA 95820');
});

test('buildStateFromGeocode uses 250 m default altitude for street addresses', () => {
  const state = buildStateFromGeocode(
    '#q=1600+Pennsylvania+Ave',
    { lat: 38.8977, lon: -77.0365, label: 'The White House', types: ['street_address'], viewport: null },
    '1600 Pennsylvania Ave',
  );
  assert.equal(state.alt, 250);
});

test('buildStateFromGeocode uses 600 m default altitude for cities and regions', () => {
  const state = buildStateFromGeocode(
    '#q=Tokyo',
    { lat: 35.6762, lon: 139.6503, label: 'Tokyo, Japan', types: ['locality', 'political'], viewport: null },
    'Tokyo',
  );
  assert.equal(state.alt, 600);
});

test('buildStateFromGeocode honors a user-supplied alt override', () => {
  const state = buildStateFromGeocode(
    '#q=Tokyo&alt=2000',
    { lat: 35.6762, lon: 139.6503, label: 'Tokyo, Japan', types: ['locality'], viewport: null },
    'Tokyo',
  );
  assert.equal(state.alt, 2000);
});

test('buildStateFromGeocode carries over style from the hash', () => {
  const state = buildStateFromGeocode(
    '#q=Tokyo&style=thermal',
    { lat: 35.6762, lon: 139.6503, label: 'Tokyo, Japan', types: ['locality'], viewport: null },
    'Tokyo',
  );
  assert.equal(state.style, 'thermal');
});

test('buildStateFromGeocode falls back to the original query when label is missing', () => {
  const state = buildStateFromGeocode(
    '#q=Sacramento',
    { lat: 38.58, lon: -121.49, label: null, types: ['locality'], viewport: null },
    'Sacramento',
  );
  assert.equal(state.label, 'Sacramento');
});
