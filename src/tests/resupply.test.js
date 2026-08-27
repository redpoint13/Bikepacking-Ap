/**
 * resupply.test.js — Unit tests for the resupply enrichment module.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { haversineDistance, parseGPX } from '../gpx.js';
import {
  CURATED_RESUPPLY_SOURCES,
  fetchOSMResupply,
  isNearRoute,
  mergeResupplySources,
  osmResupplyCategory,
  osmResupplyLabel,
  osmResupplyReliability,
  sampleTrackPoints,
} from '../resupply.js';

const MINIMAL_GPX = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Test Route</name></metadata>
  <wpt lat="35.1989" lon="-111.6537">
    <name>Williams General Store</name>
    <desc>resupply</desc>
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
  it('returns every 20th point for long tracks', () => {
    const pts = Array.from({ length: 100 }, (_, i) => [i, i]);
    const sampled = sampleTrackPoints(pts);
    expect(sampled[0]).toEqual([0, 0]);
    expect(sampled[1]).toEqual([20, 20]);
  });

  it('returns all points for short tracks', () => {
    const pts = [
      [35.0, -111.0],
      [35.1, -111.0],
    ];
    expect(sampleTrackPoints(pts)).toHaveLength(2);
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

  it('returns false for a clearly distant point', () => {
    expect(isNearRoute(40.0, -120.0, sampled)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// osmResupplyCategory
// ---------------------------------------------------------------------------

describe('osmResupplyCategory', () => {
  it('returns grocery for shop=supermarket', () => {
    expect(osmResupplyCategory({ shop: 'supermarket' })?.id).toBe('grocery');
  });

  it('returns grocery for shop=convenience', () => {
    expect(osmResupplyCategory({ shop: 'convenience' })?.id).toBe('grocery');
  });

  it('returns grocery for shop=general', () => {
    expect(osmResupplyCategory({ shop: 'general' })?.id).toBe('grocery');
  });

  it('returns outdoor for shop=bicycle', () => {
    expect(osmResupplyCategory({ shop: 'bicycle' })?.id).toBe('outdoor');
  });

  it('returns outdoor for shop=outdoor', () => {
    expect(osmResupplyCategory({ shop: 'outdoor' })?.id).toBe('outdoor');
  });

  it('returns fuel for amenity=fuel', () => {
    expect(osmResupplyCategory({ amenity: 'fuel' })?.id).toBe('fuel');
  });

  it('returns restaurant for amenity=restaurant', () => {
    expect(osmResupplyCategory({ amenity: 'restaurant' })?.id).toBe('restaurant');
  });

  it('returns cafe for amenity=cafe', () => {
    expect(osmResupplyCategory({ amenity: 'cafe' })?.id).toBe('cafe');
  });

  it('returns fast_food for amenity=fast_food', () => {
    expect(osmResupplyCategory({ amenity: 'fast_food' })?.id).toBe('fast_food');
  });

  it('returns lodging for tourism=hostel', () => {
    expect(osmResupplyCategory({ tourism: 'hostel' })?.id).toBe('lodging');
  });

  it('returns lodging for tourism=motel', () => {
    expect(osmResupplyCategory({ tourism: 'motel' })?.id).toBe('lodging');
  });

  it('returns null for unrecognised tags', () => {
    expect(osmResupplyCategory({ shop: 'florist' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// osmResupplyLabel
// ---------------------------------------------------------------------------

describe('osmResupplyLabel', () => {
  it('uses the name tag when present', () => {
    expect(osmResupplyLabel({ name: 'Pine Creek Market', shop: 'supermarket' })).toBe(
      'Pine Creek Market',
    );
  });

  it('returns the category label for a supermarket with no name', () => {
    expect(osmResupplyLabel({ shop: 'supermarket' })).toBe('Grocery Store');
  });

  it('returns the category label for a fuel station', () => {
    expect(osmResupplyLabel({ amenity: 'fuel' })).toBe('Gas Station');
  });

  it('returns Resupply Stop as final fallback', () => {
    expect(osmResupplyLabel({ shop: 'florist' })).toBe('Resupply Stop');
  });
});

// ---------------------------------------------------------------------------
// osmResupplyReliability
// ---------------------------------------------------------------------------

describe('osmResupplyReliability', () => {
  it('scores grocery stores at 90', () => {
    expect(osmResupplyReliability({ shop: 'supermarket' })).toBe(90);
  });

  it('scores outdoor shops at 85', () => {
    expect(osmResupplyReliability({ shop: 'bicycle' })).toBe(85);
  });

  it('scores fuel stations at 80', () => {
    expect(osmResupplyReliability({ amenity: 'fuel' })).toBe(80);
  });

  it('scores fast food at 75', () => {
    expect(osmResupplyReliability({ amenity: 'fast_food' })).toBe(75);
  });

  it('scores restaurants at 70', () => {
    expect(osmResupplyReliability({ amenity: 'restaurant' })).toBe(70);
  });

  it('scores lodging at 65', () => {
    expect(osmResupplyReliability({ tourism: 'hostel' })).toBe(65);
  });

  it('scores unknown tags at 60', () => {
    expect(osmResupplyReliability({ shop: 'florist' })).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// mergeResupplySources
// ---------------------------------------------------------------------------

describe('mergeResupplySources', () => {
  it('keeps existing GPX resupply waypoints', () => {
    const merged = mergeResupplySources(route, []);
    const gpxResupply = route.waypoints.filter((w) => w.type === 'resupply');
    expect(merged.length).toBeGreaterThanOrEqual(gpxResupply.length);
    expect(merged.some((w) => w.name.includes('Williams'))).toBe(true);
  });

  it('adds an OSM grocery store near the route', () => {
    const osmEl = {
      id: 11111,
      type: 'node',
      lat: 34.9,
      lon: -111.8,
      tags: { shop: 'supermarket', name: 'Pine Creek Market' },
    };
    const merged = mergeResupplySources(route, [osmEl]);
    expect(merged.some((w) => w.id === 'osm-resupply-11111')).toBe(true);
    expect(merged.some((w) => w.name === 'Pine Creek Market')).toBe(true);
  });

  it('skips stops far from the route', () => {
    const farEl = {
      id: 22222,
      type: 'node',
      lat: 40.0,
      lon: -120.0,
      tags: { amenity: 'fuel' },
    };
    const merged = mergeResupplySources(route, [farEl]);
    expect(merged.some((w) => w.id === 'osm-resupply-22222')).toBe(false);
  });

  it('deduplicates a stop coincident with a GPX waypoint', () => {
    const dupeEl = {
      id: 33333,
      type: 'node',
      lat: 35.1989,
      lon: -111.6537,
      tags: { shop: 'general', name: 'Williams (dupe)' },
    };
    const merged = mergeResupplySources(route, [dupeEl]);
    const osmEntries = merged.filter((w) => w.source === 'osm');
    expect(osmEntries.length).toBe(0);
  });

  it('result is sorted by distanceFromStartMi', () => {
    const osmEl = {
      id: 44444,
      type: 'node',
      lat: 34.9,
      lon: -111.8,
      tags: { amenity: 'fuel' },
    };
    const merged = mergeResupplySources(route, [osmEl]);
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i].distanceFromStartMi).toBeGreaterThanOrEqual(
        merged[i - 1].distanceFromStartMi,
      );
    }
  });

  it('exposes the OSM-derived category under the name plan.js reads', () => {
    const osmEl = {
      id: 55555,
      type: 'node',
      lat: 34.9,
      lon: -111.8,
      tags: { shop: 'outdoor', name: 'Trailhead Gear' },
    };
    const merged = mergeResupplySources(route, [osmEl]);
    const added = merged.find((w) => w.id === 'osm-resupply-55555');
    expect(added).toBeDefined();
    expect(added.resupplyCategory).toBe('outdoor');
    expect(added.reliability).toBe(85);
  });

  it('skips elements with missing coordinates', () => {
    const noCoords = { id: 66666, type: 'node', tags: { amenity: 'fuel' } };
    const merged = mergeResupplySources(route, [noCoords]);
    expect(merged.some((w) => w.id === 'osm-resupply-66666')).toBe(false);
  });

  it('assigns fallback category "other" for unrecognised tags', () => {
    const weirdEl = {
      id: 77777,
      type: 'node',
      lat: 34.9,
      lon: -111.8,
      tags: { shop: 'florist', name: 'Desert Flowers' },
    };
    const merged = mergeResupplySources(route, [weirdEl]);
    const added = merged.find((w) => w.id === 'osm-resupply-77777');
    expect(added).toBeDefined();
    expect(added.resupplyCategory).toBe('other');
    expect(added.reliability).toBe(60);
  });

  // --- Curated Colorado Trail hubs ------------------------------------------

  const leadville = CURATED_RESUPPLY_SOURCES.find((s) => s.id === 'ct-resupply-leadville');

  /** Builds a short track running ~0.4 mi east of the given point. */
  const routePassing = (lat, lon, wpt = '') =>
    parseGPX(`<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>CT near a town hub</name></metadata>
  ${wpt}
  <trk><name>CT</name><trkseg>
    <trkpt lat="${lat - 0.003}" lon="${lon + 0.008}"><ele>3100</ele></trkpt>
    <trkpt lat="${lat}" lon="${lon + 0.008}"><ele>3100</ele></trkpt>
    <trkpt lat="${lat + 0.003}" lon="${lon + 0.008}"><ele>3100</ele></trkpt>
  </trkseg></trk>
</gpx>`);

  it('merges a curated CT town hub when the route passes it', () => {
    const merged = mergeResupplySources(routePassing(leadville.lat, leadville.lon), []);
    const hub = merged.find((w) => w.id === leadville.id);
    expect(hub).toBeDefined();
    expect(hub.source).toBe('curated');
    expect(hub.type).toBe('resupply');
    expect(hub.resupplyCategory).toBe('grocery');
  });

  it('leaves curated CT hubs off a route that never goes near them', () => {
    // The shared fixture route is in Arizona, ~600 mi from any CT hub.
    const merged = mergeResupplySources(route, []);
    expect(merged.some((w) => w.source === 'curated')).toBe(false);
  });

  it('deduplicates a curated hub against a coincident existing waypoint', () => {
    const withStore = routePassing(
      leadville.lat,
      leadville.lon,
      `<wpt lat="${leadville.lat}" lon="${leadville.lon}"><name>Leadville Grocery</name></wpt>`,
    );
    const merged = mergeResupplySources(withStore, []);
    const atLeadville = merged.filter(
      (w) => haversineDistance(w.lat, w.lon, leadville.lat, leadville.lon) < 0.05,
    );
    expect(atLeadville).toHaveLength(1);
    expect(atLeadville[0].source).not.toBe('curated');
  });

  it('all curated resupply sources have unique IDs and distinct town coordinates', () => {
    const ids = new Set();
    for (const r of CURATED_RESUPPLY_SOURCES) {
      expect(ids.has(r.id)).toBe(false);
      ids.add(r.id);
    }

    const stageStop = CURATED_RESUPPLY_SOURCES.find((r) => r.id === 'ct-resupply-stage-stop');
    const jefferson = CURATED_RESUPPLY_SOURCES.find((r) => r.id === 'ct-resupply-jefferson');
    expect(stageStop).toBeDefined();
    expect(jefferson).toBeDefined();
    expect(stageStop.lat).not.toBe(jefferson.lat);
    expect(stageStop.lon).not.toBe(jefferson.lon);
  });

});

// ---------------------------------------------------------------------------
// fetchOSMResupply
// ---------------------------------------------------------------------------

describe('fetchOSMResupply', () => {
  it('returns elements on a successful response', async () => {
    const mockElements = [
      { id: 1, type: 'node', lat: 35.0, lon: -111.0, tags: { shop: 'supermarket' } },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ elements: mockElements }),
      }),
    );
    const bounds = { minLon: -112, minLat: 34, maxLon: -111, maxLat: 36 };
    const result = await fetchOSMResupply(bounds);
    expect(result).toEqual(mockElements);
    vi.unstubAllGlobals();
  });

  it('returns empty array on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const bounds = { minLon: -112, minLat: 34, maxLon: -111, maxLat: 36 };
    const result = await fetchOSMResupply(bounds);
    expect(result).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('returns empty array on non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const bounds = { minLon: -112, minLat: 34, maxLon: -111, maxLat: 36 };
    const result = await fetchOSMResupply(bounds);
    expect(result).toEqual([]);
    vi.unstubAllGlobals();
  });
});
