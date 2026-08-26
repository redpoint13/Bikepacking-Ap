/**
 * water.test.js — Unit tests for the water enrichment module.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseGPX } from '../gpx.js';
import {
  USGS_DRINKABLE_SITE_TYPES,
  fetchOSMWater,
  fetchUSGSFlowData,
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
  it('scores a spring above a stream', () => {
    const spring = { properties: { site_type_code: 'SP' } };
    const stream = { properties: { site_type_code: 'ST' } };
    expect(usgsReliability(spring)).toBe(80);
    expect(usgsReliability(stream)).toBe(70);
    expect(usgsReliability(spring)).toBeGreaterThan(usgsReliability(stream));
  });

  it('scores ditches and canals below open water', () => {
    expect(usgsReliability({ properties: { site_type_code: 'ST-DCH' } })).toBe(55);
    expect(usgsReliability({ properties: { site_type_code: 'ST-CA' } })).toBe(55);
  });

  /**
   * The Colorado Trail corridor returns ~5,100 USGS sites, over half of them
   * groundwater observation wells, plus atmospheric sensors and facilities —
   * one of which is a sewage works. These are boreholes and installations, not
   * water a rider can take. The previous scoring read a field the API does not
   * return, so every one of them scored 60: above the default reliability
   * threshold of 50, and therefore offered as a refill.
   */
  it('refuses to score undrinkable site types', () => {
    for (const code of ['GW', 'GW-TH', 'AT', 'FA-SEW', 'FA-DV', 'SB-TSM', 'LA']) {
      expect(usgsReliability({ properties: { site_type_code: code } })).toBe(0);
    }
  });

  it('scores an unknown or absent type as unusable rather than defaulting', () => {
    expect(usgsReliability({ properties: {} })).toBe(0);
    expect(usgsReliability({})).toBe(0);
    expect(usgsReliability({ properties: { site_type_code: 'XX' } })).toBe(0);
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
        monitoring_location_number: '09505200',
        monitoring_location_name: 'Oak Creek near Flagstaff',
        site_type_code: 'ST',
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
        monitoring_location_number: '09505200',
        monitoring_location_name: 'Oak Creek (dupe)',
        site_type_code: 'ST',
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
      properties: { monitoring_location_number: '99999', monitoringLocationType: 'Stream' },
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
  it('queries each drinkable site type and returns the combined features', async () => {
    // site_type_code accepts one value per request — a comma list returns
    // nothing — so this issues one request per drinkable type and flattens.
    const spy = vi.fn(async (url) => {
      const type = new URL(url).searchParams.get('site_type_code');
      return {
        ok: true,
        json: async () => ({
          features: [{ id: `f-${type}`, geometry: { coordinates: [0, 0] }, properties: {} }],
        }),
      };
    });
    vi.stubGlobal('fetch', spy);

    const bounds = { minLon: -112, minLat: 34, maxLon: -111, maxLat: 36 };
    const result = await fetchUSGSLocations(bounds);

    const requested = spy.mock.calls.map((c) => new URL(c[0]).searchParams.get('site_type_code'));
    expect(new Set(requested)).toEqual(new Set(Object.keys(USGS_DRINKABLE_SITE_TYPES)));
    expect(result).toHaveLength(Object.keys(USGS_DRINKABLE_SITE_TYPES).length);
    vi.unstubAllGlobals();
  });

  it('asks for a limit far above the old 200, which truncated long routes', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) }));
    vi.stubGlobal('fetch', spy);
    await fetchUSGSLocations({ minLon: -112, minLat: 34, maxLon: -111, maxLat: 36 });
    const limit = Number(new URL(spy.mock.calls[0][0]).searchParams.get('limit'));
    expect(limit).toBeGreaterThanOrEqual(2000);
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

describe('fetchUSGSFlowData', () => {
  it('returns a Map of siteId to flow rate on success', async () => {
    const mockData = {
      value: {
        timeSeries: [
          {
            sourceInfo: { siteCode: [{ value: '09505200' }] },
            values: [{ value: [{ value: '12.5' }] }],
          },
          {
            sourceInfo: { siteCode: [{ value: '09505500' }] },
            values: [{ value: [{ value: '0.0' }] }],
          },
        ],
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockData,
      }),
    );

    const result = await fetchUSGSFlowData(['09505200', '09505500']);
    expect(result.get('09505200')).toBe(12.5);
    expect(result.get('09505500')).toBe(0.0);
    vi.unstubAllGlobals();
  });

  it('returns empty Map on error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const result = await fetchUSGSFlowData(['09505200']);
    expect(result.size).toBe(0);
    vi.unstubAllGlobals();
  });
});

describe('mergeWaterSources with flowMap', () => {
  const usgsFeature = {
    id: 'site-1',
    geometry: { coordinates: [-111.65, 35.199] },
    properties: {
      monitoring_location_number: '09505200',
      monitoring_location_name: 'Oak Creek near Flagstaff',
      site_type_code: 'ST',
    },
  };

  it('sets reliability to 90% when flow is positive', () => {
    const flowMap = new Map([['09505200', 12.5]]);
    const merged = mergeWaterSources(route, [usgsFeature], [], flowMap);
    const station = merged.find((w) => w.id === 'usgs-09505200');
    expect(station.reliability).toBe(90);
    expect(station.description).toContain('12.5 cfs');
  });

  it('sets reliability to 0% when flow is zero', () => {
    const flowMap = new Map([['09505200', 0.0]]);
    const merged = mergeWaterSources(route, [usgsFeature], [], flowMap);
    const station = merged.find((w) => w.id === 'usgs-09505200');
    expect(station.reliability).toBe(0);
    expect(station.description).toContain('reports DRY');
  });

  it('falls back to static reliability when site is missing from flowMap', () => {
    const merged = mergeWaterSources(route, [usgsFeature], [], new Map());
    const station = merged.find((w) => w.id === 'usgs-09505200');
    expect(station.reliability).toBe(70); // ST — stream
    expect(station.description).toBe('Stream (USGS gauge)');
  });
});
