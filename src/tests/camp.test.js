/**
 * camp.test.js — Unit tests for the camp site enrichment module.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  fetchOSMCampSites,
  isNearRoute,
  mergeCampSources,
  osmCampLabel,
  osmCampReliability,
  osmCampTier,
  sampleTrackPoints,
} from '../camp.js';
import { parseGPX } from '../gpx.js';

const MINIMAL_GPX = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Test Route</name></metadata>
  <wpt lat="35.1989" lon="-111.6537">
    <name>Dead Horse Ranch</name>
    <desc>camping state park</desc>
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

describe('osmCampTier', () => {
  it('returns null for private sites', () => {
    expect(osmCampTier({ access: 'private' })).toBeNull();
    expect(osmCampTier({ access: 'no' })).toBeNull();
  });

  it('returns dispersed for backcountry sites', () => {
    expect(osmCampTier({ backcountry: 'yes' })).toBe('dispersed');
  });

  it('returns dispersed for informal sites', () => {
    expect(osmCampTier({ informal: 'yes' })).toBe('dispersed');
  });

  it('returns dispersed for BLM-operated sites', () => {
    expect(osmCampTier({ operator: 'BLM' })).toBe('dispersed');
  });

  it('returns dispersed for USFS-operated sites', () => {
    expect(osmCampTier({ operator: 'USFS' })).toBe('dispersed');
  });

  it('returns official for a named campground with no special tags', () => {
    expect(osmCampTier({ name: 'Manzanita Campground' })).toBe('official');
  });

  it('returns official as default', () => {
    expect(osmCampTier({})).toBe('official');
  });
});

describe('osmCampLabel', () => {
  it('uses the name tag when present', () => {
    expect(osmCampLabel({ name: 'Pine Flat' })).toBe('Pine Flat');
  });

  it('returns Dispersed Camping for dispersed tier', () => {
    expect(osmCampLabel({ backcountry: 'yes' })).toBe('Dispersed Camping');
  });

  it('returns Camp Site as fallback', () => {
    expect(osmCampLabel({})).toBe('Camp Site');
  });
});

describe('osmCampReliability', () => {
  it('official campgrounds score 90', () => {
    expect(osmCampReliability({ name: 'Big Park Campground' })).toBe(90);
  });

  it('dispersed/BLM scores 80', () => {
    expect(osmCampReliability({ operator: 'BLM' })).toBe(80);
  });

  it('backcountry scores 75', () => {
    expect(osmCampReliability({ backcountry: 'yes' })).toBe(75);
  });

  it('private sites score 0', () => {
    expect(osmCampReliability({ access: 'private' })).toBe(0);
  });
});

describe('mergeCampSources', () => {
  it('keeps existing GPX camping waypoints', () => {
    const merged = mergeCampSources(route, []);
    const gpxCamps = route.waypoints.filter((w) => w.type === 'camping');
    expect(merged.length).toBeGreaterThanOrEqual(gpxCamps.length);
    expect(merged.some((w) => w.name.includes('Dead Horse'))).toBe(true);
  });

  it('adds an OSM camp site near the route', () => {
    const osmEl = {
      id: 55555,
      type: 'node',
      lat: 34.9,
      lon: -111.8,
      tags: { tourism: 'camp_site', name: 'Ponderosa Camp' },
    };
    const merged = mergeCampSources(route, [osmEl]);
    expect(merged.some((w) => w.id === 'osm-camp-55555')).toBe(true);
    expect(merged.some((w) => w.name === 'Ponderosa Camp')).toBe(true);
  });

  it('accepts way elements with center coordinates', () => {
    const osmWay = {
      id: 77777,
      type: 'way',
      center: { lat: 34.9, lon: -111.8 },
      tags: { tourism: 'camp_site', name: 'Pine Ridge Camp' },
    };
    const merged = mergeCampSources(route, [osmWay]);
    expect(merged.some((w) => w.id === 'osm-camp-77777')).toBe(true);
  });

  it('skips private camp sites', () => {
    const privateEl = {
      id: 11111,
      type: 'node',
      lat: 34.9,
      lon: -111.8,
      tags: { tourism: 'camp_site', access: 'private' },
    };
    const merged = mergeCampSources(route, [privateEl]);
    expect(merged.some((w) => w.id === 'osm-camp-11111')).toBe(false);
  });

  it('skips sites far from the route', () => {
    const farEl = {
      id: 22222,
      type: 'node',
      lat: 40.0,
      lon: -120.0,
      tags: { tourism: 'camp_site', name: 'Nevada Camp' },
    };
    const merged = mergeCampSources(route, [farEl]);
    expect(merged.some((w) => w.id === 'osm-camp-22222')).toBe(false);
  });

  it('deduplicates a site coincident with a GPX waypoint', () => {
    const dupeEl = {
      id: 33333,
      type: 'node',
      lat: 35.1989,
      lon: -111.6537,
      tags: { tourism: 'camp_site', name: 'Dead Horse (dupe)' },
    };
    const merged = mergeCampSources(route, [dupeEl]);
    const osmEntries = merged.filter((w) => w.source === 'osm');
    expect(osmEntries.length).toBe(0);
  });

  it('result is sorted by distanceFromStartMi', () => {
    const osmEl = {
      id: 44444,
      type: 'node',
      lat: 34.9,
      lon: -111.8,
      tags: { tourism: 'camp_site' },
    };
    const merged = mergeCampSources(route, [osmEl]);
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i].distanceFromStartMi).toBeGreaterThanOrEqual(
        merged[i - 1].distanceFromStartMi,
      );
    }
  });

  it('includes tier and reliability on enriched waypoints', () => {
    const osmEl = {
      id: 66666,
      type: 'node',
      lat: 34.9,
      lon: -111.8,
      tags: { tourism: 'camp_site', operator: 'USFS' },
    };
    const merged = mergeCampSources(route, [osmEl]);
    const added = merged.find((w) => w.id === 'osm-camp-66666');
    expect(added).toBeDefined();
    expect(added.tier).toBe('dispersed');
    expect(added.reliability).toBe(80);
  });
});

describe('fetchOSMCampSites', () => {
  it('returns elements on a successful response', async () => {
    const mockElements = [
      { id: 1, type: 'node', lat: 35.0, lon: -111.0, tags: { tourism: 'camp_site' } },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ elements: mockElements }),
      }),
    );
    const bounds = { minLon: -112, minLat: 34, maxLon: -111, maxLat: 36 };
    const result = await fetchOSMCampSites(bounds);
    expect(result).toEqual(mockElements);
    vi.unstubAllGlobals();
  });

  it('returns empty array on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const bounds = { minLon: -112, minLat: 34, maxLon: -111, maxLat: 36 };
    const result = await fetchOSMCampSites(bounds);
    expect(result).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('returns empty array on non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const bounds = { minLon: -112, minLat: 34, maxLon: -111, maxLat: 36 };
    const result = await fetchOSMCampSites(bounds);
    expect(result).toEqual([]);
    vi.unstubAllGlobals();
  });
});
