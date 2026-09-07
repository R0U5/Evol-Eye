#!/usr/bin/env python3
"""Merge all scraped Axis camera data into the Devil's Eye CCTV catalog.

Sources (all local, keyless):
  - data/insecam-cameras.json        (86 cams, geolocated)
  - data/insecam-all-axis.json       (400 cams, unlocated)
  - data/dork-more-cams.json         (6 dorked cams, unlocated-ish)
  - data/discovered-cameras.json     (12 validated + geolocated, from earlier probe)

Writes ~/apps/gods-eye-view/config/cctv_sources_axis.json — the server picks it up
via the existing CCTV_SOURCES_FILE merge in refreshCctvSources(). Unlocated cams
keep lat/lon absent (NaN on the server) so they render frame-only with no globe pin.
"""
import json, os, sys, re
from urllib.request import urlopen, Request

WORKSPACE = os.path.expanduser('~/.openclaw/workspace')
OUT = os.path.expanduser('~/apps/gods-eye-view/config/cctv_sources_axis.json')

HEADERS = {'User-Agent': 'Mozilla/5.0 (compatible; DevilsEye/1.0)'}

def load(name):
    p = os.path.join(WORKSPACE, 'data', name)
    try:
        with open(p) as f:
            return json.load(f)
    except FileNotFoundError:
        print(f'  [skip] {name} missing')
        return []

def check_alive(url, timeout=6):
    """Verify an unauthenticated camera endpoint answers (HTTP 200)."""
    try:
        req = Request(url, headers=HEADERS)
        with urlopen(req, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False

def main():
    live_check = '--live-check' in sys.argv

    # — 1. Geolocated cams (insecam-cameras.json + discovered-cameras.json)
    geo = []
    for c in load('insecam-cameras.json'):
        if not (c.get('lat') and c.get('lon')): continue
        geo.append({
            'id': f"axis-{c['id'].replace('insecam-axis-', 'insecam-')}" if 'insecam-axis-' in c.get('id','') else c['id'],
            'name': c.get('name', 'Axis Camera'),
            'city': c.get('city', ''),
            'cityId': '',
            'provider': 'Discovered Axis Camera',
            'sourceKind': 'discovered',
            'feedType': 'image',
            'url': c.get('url', ''),
            'lat': c.get('lat'), 'lon': c.get('lon'),
            'headingDeg': 0, 'headingConfidence': 'low',
            'pitchDeg': -17, 'fovDeg': 72, 'rangeM': 500,
            'mountHeightM': 12, 'groundElevationM': 0,
            'license': 'Public — unauthenticated Axis camera',
        })
    for c in load('discovered-cameras.json'):
        if not (c.get('lat') and c.get('lon')): continue
        if c.get('id','').startswith('disc-ax-') and c['url']:
            geo.append({
                'id': c['id'], 'name': c.get('name', 'Axis Camera'),
                'city': c.get('city', ''), 'cityId': '',
                'provider': 'Discovered Axis Camera', 'sourceKind': 'discovered',
                'feedType': 'image', 'url': c['url'],
                'lat': c['lat'], 'lon': c['lon'],
                'headingDeg': 0, 'headingConfidence': 'low',
                'pitchDeg': -17, 'fovDeg': 72, 'rangeM': 500,
                'mountHeightM': 12, 'groundElevationM': 0,
                'license': 'Public — unauthenticated Axis camera',
            })

    # — 2. Unlocated cams (insecam-all-axis.json + dork-more-cams.json)
    unloc = []
    seen = set()
    for c in load('insecam-all-axis.json'):
        url = c.get('url', '')
        ip = c.get('ip', '')
        if not url: continue
        key = re.sub(r'^https?://', '', url).split('/')[0]
        if key in seen: continue
        seen.add(key)
        unloc.append({
            'id': f'axis-ul-{len(unloc)+1:04d}',
            'name': f'Axis Camera {ip}', 'city': 'UNLOCATED',
            'cityId': '', 'provider': 'Discovered Axis Camera',
            'sourceKind': 'discovered-unlocated', 'feedType': 'image',
            'url': url, 'lat': None, 'lon': None,
            'headingDeg': 0, 'headingConfidence': 'low',
            'pitchDeg': 0, 'fovDeg': 72, 'rangeM': 0,
            'mountHeightM': 0, 'groundElevationM': 0,
            'license': 'Public — unauthenticated Axis camera',
        })
    for c in load('dork-more-cams.json'):
        url = c.get('mjpg', '')
        ip = c.get('ip', '')
        if not url: continue
        key = re.sub(r'^https?://', '', url).split('/')[0]
        if key in seen: continue
        seen.add(key)
        unloc.append({
            'id': f'axis-ul-{len(unloc)+1:04d}',
            'name': f'Axis Camera {ip}', 'city': 'UNLOCATED',
            'cityId': '', 'provider': 'Discovered Axis Camera',
            'sourceKind': 'discovered-unlocated', 'feedType': 'image',
            'url': url, 'lat': None, 'lon': None,
            'headingDeg': 0, 'headingConfidence': 'low',
            'pitchDeg': 0, 'fovDeg': 72, 'rangeM': 0,
            'mountHeightM': 0, 'groundElevationM': 0,
            'license': 'Public — unauthenticated Axis camera',
        })

    # — 3. Dedupe: same host/port must not appear twice (geo wins).
    by_key = {}
    for c in geo + unloc:
        if not c.get('url'): continue
        key = re.sub(r'^https?://', '', c['url']).split('/')[0]
        has_coords = c.get('lat') is not None
        # geo beats unlocated for the same endpoint
        if key in by_key:
            cur = by_key[key]
            cur_has = cur.get('lat') is not None
            if has_coords and not cur_has:
                by_key[key] = c
        else:
            by_key[key] = c

    catalog = list(by_key.values())

    # — 4. Optional live validation of unlocated cams (they churn; drop dead ones)
    if live_check:
        unloc_kept = []
        for c in catalog:
            if c.get('lat') is not None:
                unloc_kept.append(c)
                continue
            if check_alive(c['url']):
                unloc_kept.append(c)
            else:
                print(f'  [dead] {c["url"]}')
        catalog = unloc_kept

    # sort: located first, then by id
    catalog.sort(key=lambda c: (0 if c.get('lat') is not None else 1, c['id']))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(catalog, f, indent=2)
    geo_n = sum(1 for c in catalog if c.get('lat') is not None)
    print(f'Wrote {OUT}')
    print(f'  total: {len(catalog)} | geolocated: {geo_n} | unlocated: {len(catalog)-geo_n}')

if __name__ == '__main__':
    main()
