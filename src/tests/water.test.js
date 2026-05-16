/**
 * water.test.js — Unit tests for the water enrichment module.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseGPX } from '../gpx.js';
import {
  fetchOSMWater,
  fetchUSGSLocations,
  isNearRoute,
  mergeWaterSources,
  osmLabel,
  osmReliability,
  sampleTrackPoints,
  usgsReliability,
} from '../water.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL_GPX = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Test Route</name></metadata>
  <wpt lat="35.1989" lon="-111.6537">
    <name>Oak Creek</name>
    <desc>water in river</desc>
  </wpt>
  <trk>
    <name>Test Route</name>
    <trkseg>
      <trkpt lat="35.1989" lon="-111.6537"><ele>2134</ele></trkpt>
      <trkpt lat="35.1900" lon="-111.7000"><ele>2100</ele></trkpt>
      <trkpt lat="34.9000" lon="-111.8000"><ele>1800</ele></trkpt>
      <trkpt lat="34.7540" lon="-112.0190"><ele>1000</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

let route;
beforeAll(() => {
  route = parseGPX(MINIMAL_GPX);
});

// ---------------------------------------------------------------------------
// sampleTrackPoints
// ---------------------------------------------------------------------------

describe('sampleTrackPoints', () => {
  it('returns every 20th point', () => {
    const pts = Array.from({ length: 100 }, (_, i) => [i, i]);
    const sampled = sampleTrackPoints(pts);
    expect(sampled[0]).toEqual([0, 0]);
    expect(sampled[1]).toEqual([20, 20]);
    expect(sampled[sampled.length - 1]).toEqual([80, 80]);
  });

  it('always includes the first point', () => {
    const pts = [
      [35.0, -111.0],
      [35.1, -111.0],
    ];
    expect(sampleTrackPoints(pts)[0]).toEqual([35.0, -111.0]);
  });
});

// ---------------------------------------------------------------------------
// isNearRoute
// ---------------------------------------------------------------------------

describe('isNearRoute', () => {
  const sampled = [
    [35.0, -111.0],
    [35.1, -111.0],
  ];

  it('returns true for a point on the track', () => {
    expect(isNearRoute(35.0, -111.0, sampled)).toBe(true);
  });

  it('returns true for a point close to the track', () => {
    expect(isNearRoute(35.005, -111.0, sampled)).toBe(true);
  });

  it('returns false for a distant point', () => {
    expect(isNearRoute(40.0, -120.0, sampled)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// osmLabel
// ---------------------------------------------------------------------------

describe('osmLabel', () => {
  it('uses the name tag when present', () => {
    expect(osmLabel({ name: 'Peralta Spring' })).toBe('Peralta Spring');
  });

  it('labels drinking_water nodes', () => {
    expect(osmLabel({ amenity: 'drinking_water' })).toBe('Drinking Water');
  });

  it('labels springs', () => {
    expect(osmLabel({ natural: 'spring' })).toBe('Spring');
  });

  it('labels water taps', () => {
    expect(osmLabel({ man_made: 'water_tap' })).toBe('Water Tap');
  });

  it('labels water wells', () => {
    expect(osmLabel({ man_made: 'water_well' })).toBe('Water Well');
  });

  it('falls back to generic label', () => {
    expect(osmLabel({})).toBe('Water Source');
  });
});

// ---------------------------------------------------------------------------
// osmReliability
// ---------------------------------------------------------------------------

describe('osmReliability', () => {
  it('drinking_water scores highest', () => {
    expect(osmReliability({ amenity: 'drinking_water' })).toBe(85);
  });

  it('water_tap scores high', () => {
    expect(osmReliability({ man_made: 'water_tap' })).toBe(80);
  });

  it('confirmed drinking spring scores above unconfirmed', () => {
    const confirmed = osmReliability({ natural: 'spring', drinking_water: 'yes' });
    const unconfirmed = osmReliability({ natural: 'spring' });
    expect(confirmed).toBeGreaterThan(unconfirmed);
  });

  it('waterhole scores lowest', () => {
    expect(osmReliability({ natural: 'waterhole' })).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// usgsReliability
// ---------------------------------------------------------------------------

describe('usgsReliability', () => {
  it('stream/river type scores 75', () => {
    const f = { properties: { monitoringLocationType: 'Stream' } };
    expect(usgsReliability(f)).toBe(75);
  });

  it('spring type scores 65', () => {
    const f = { properties: { monitoringLocationType: 'Spring' } };
    expect(usgsReliability(f)).toBe(65);
  });

  it('defaults to 60 for unknown type', () => {
    const f = { properties: {} };
    expect(usgsReliability(f)).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// mergeWaterSources
// ---------------------------------------------------------------------------

describe('mergeWaterSources', () => {
  it('keeps existing GPX water waypoints', () => {
    const merged = mergeWaterSources(route, [], []);
    const gpxWater = route.waypoints.filter((w) => w.type === 'water');
    expect(merged.length).toBeGreaterThanOrEqual(gpxWater.length);
    expect(merged.some((w) => w.name.includes('Oak Creek'))).toBe(true);
  });

  it('adds a USGS feature near the route', () => {
    const usgsFeature = {
      id: 'site-1',
      geometry: { coordinates: [-111.65, 35.199] },
      properties: {
        monitoringLocationNumber: '09505200',
        monitoringLocationName: 'Oak Creek near Flagstaff',
        monitoringLocationType: 'Stream',
      },
    };
    const merged = mergeWaterSources(route, [usgsFeature], []);
    expect(merged.some((w) => w.source === 'usgs')).toBe(true);
  });

  it('deduplicates a USGS feature coincident with a GPX waypoint', () => {
    // Place USGS station at exactly the same coords as Oak Creek GPX waypoint
    const usgsFeature = {
      id: 'site-dupe',
      geometry: { coordinates: [-111.6537, 35.1989] },
      properties: {
        monitoringLocationNumber: '09505200',
        monitoringLocationName: 'Oak Creek (dupe)',
        monitoringLocationType: 'Stream',
      },
    };
    const merged = mergeWaterSources(route, [usgsFeature], []);
    // Should not have two waypoints within 0.15 mi of each other
    const usgsEntries = merged.filter((w) => w.source === 'usgs');
    expect(usgsEntries.length).toBe(0);
  });

  it('skips USGS features far from the route', () => {
    const farFeature = {
      id: 'far-site',
      geometry: { coordinates: [-115.0, 40.0] }, // Nevada
      properties: { monitoringLocationNumber: '99999', monitoringLocationType: 'Stream' },
    };
    const merged = mergeWaterSources(route, [farFeature], []);
    expect(merged.some((w) => w.id === 'usgs-99999')).toBe(false);
  });

  it('adds an OSM spring near the route', () => {
    const osmEl = {
      id: 12345,
      lat: 34.9,
      lon: -111.8,
      tags: { natural: 'spring', name: 'Hidden Spring' },
    };
    const merged = mergeWaterSources(route, [], [osmEl]);
    expect(merged.some((w) => w.id === 'osm-12345')).toBe(true);
    expect(merged.some((w) => w.name === 'Hidden Spring')).toBe(true);
  });

  it('result is sorted by distanceFromStartMi', () => {
    const osmEl = {
      id: 99999,
      lat: 34.9,
      lon: -111.8,
      tags: { natural: 'spring' },
    };
    const merged = mergeWaterSources(route, [], [osmEl]);
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i].distanceFromStartMi).toBeGreaterThanOrEqual(
        merged[i - 1].distanceFromStartMi,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// fetchUSGSLocations / fetchOSMWater — network mocks
// ---------------------------------------------------------------------------

describe('fetchUSGSLocations', () => {
  it('returns features on a successful response', async () => {
    const mockFeatures = [{ id: 'f1', geometry: { coordinates: [0, 0] }, properties: {} }];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ features: mockFeatures }),
      }),
    );

    const bounds = { minLon: -112, minLat: 34, maxLon: -111, maxLat: 36 };
    const result = await fetchUSGSLocations(bounds);
    expect(result).toEqual(mockFeatures);
    vi.unstubAllGlobals();
  });

  it('returns empty array on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const bounds = { minLon: -112, minLat: 34, maxLon: -111, maxLat: 36 };
    const result = await fetchUSGSLocations(bounds);
    expect(result).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('returns empty array on non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const bounds = { minLon: -112, minLat: 34, maxLon: -111, maxLat: 36 };
    const result = await fetchUSGSLocations(bounds);
    expect(result).toEqual([]);
    vi.unstubAllGlobals();
  });
});

describe('fetchOSMWater', () => {
  it('returns elements on a successful response', async () => {
    const mockElements = [{ id: 1, lat: 35.0, lon: -111.0, tags: { natural: 'spring' } }];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ elements: mockElements }),
      }),
    );

    const bounds = { minLon: -112, minLat: 34, maxLon: -111, maxLat: 36 };
    const result = await fetchOSMWater(bounds);
    expect(result).toEqual(mockElements);
    vi.unstubAllGlobals();
  });

  it('returns empty array on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const bounds = { minLon: -112, minLat: 34, maxLon: -111, maxLat: 36 };
    const result = await fetchOSMWater(bounds);
    expect(result).toEqual([]);
    vi.unstubAllGlobals();
  });
});
