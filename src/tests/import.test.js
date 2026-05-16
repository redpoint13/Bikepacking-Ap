/**
 * import.test.js — Unit tests for the URL-based route import module.
 *
 * Tests URL detection, JSON parsing, and waypoint classification without
 * making any real network requests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyKomootItem,
  classifyRWGPSPoint,
  detectImportURL,
  importFromURL,
  parseKomoot,
  parseRideWithGPS,
} from '../import.js';

// ---------------------------------------------------------------------------
// detectImportURL
// ---------------------------------------------------------------------------

describe('detectImportURL', () => {
  it('detects a RideWithGPS route URL', () => {
    const result = detectImportURL('https://ridewithgps.com/routes/12345');
    expect(result).toEqual({ service: 'ridewithgps', id: '12345' });
  });

  it('detects a RideWithGPS trips URL', () => {
    const result = detectImportURL('https://ridewithgps.com/trips/99887');
    expect(result).toEqual({ service: 'ridewithgps', id: '99887' });
  });

  it('detects a Komoot tour URL', () => {
    const result = detectImportURL('https://www.komoot.com/tour/987654321');
    expect(result).toEqual({ service: 'komoot', id: '987654321' });
  });

  it('detects a Komoot tours (plural) URL', () => {
    const result = detectImportURL('https://www.komoot.com/tours/111222333');
    expect(result).toEqual({ service: 'komoot', id: '111222333' });
  });

  it('trims leading/trailing whitespace', () => {
    const result = detectImportURL('  https://ridewithgps.com/routes/42  ');
    expect(result).toEqual({ service: 'ridewithgps', id: '42' });
  });

  it('returns null for an unrecognised URL', () => {
    expect(detectImportURL('https://strava.com/activities/123')).toBeNull();
    expect(detectImportURL('not-a-url')).toBeNull();
    expect(detectImportURL('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyRWGPSPoint
// ---------------------------------------------------------------------------

describe('classifyRWGPSPoint', () => {
  it('classifies water sources', () => {
    expect(classifyRWGPSPoint({ type: 'Water', description: '' })).toBe('water');
    expect(classifyRWGPSPoint({ type: '', description: 'creek crossing' })).toBe('water');
    expect(classifyRWGPSPoint({ type: 'Generic', description: 'Natural spring' })).toBe('water');
  });

  it('classifies camping', () => {
    expect(classifyRWGPSPoint({ type: 'Camp', description: '' })).toBe('camping');
    expect(classifyRWGPSPoint({ type: '', description: 'sleep here' })).toBe('camping');
  });

  it('classifies resupply', () => {
    expect(classifyRWGPSPoint({ type: 'Store', description: '' })).toBe('resupply');
    expect(classifyRWGPSPoint({ type: '', description: 'grocery store' })).toBe('resupply');
    expect(classifyRWGPSPoint({ type: '', description: 'Gas station and cafe' })).toBe('resupply');
  });

  it('falls back to navigation', () => {
    expect(classifyRWGPSPoint({ type: 'generic', description: 'turn left' })).toBe('navigation');
    expect(classifyRWGPSPoint({})).toBe('navigation');
  });
});

// ---------------------------------------------------------------------------
// classifyKomootItem
// ---------------------------------------------------------------------------

describe('classifyKomootItem', () => {
  it('returns navigation for all items (current implementation)', () => {
    expect(classifyKomootItem({ type: 'poi' })).toBe('navigation');
    expect(classifyKomootItem({ type: 'highlight' })).toBe('navigation');
    expect(classifyKomootItem({})).toBe('navigation');
  });
});

// ---------------------------------------------------------------------------
// parseRideWithGPS
// ---------------------------------------------------------------------------

/** Minimal synthetic RideWithGPS payload */
const RWGPS_PAYLOAD = {
  route: {
    id: 99,
    name: 'Test Loop',
    distance: 40000, // ~24.9 mi in meters
    track_points: [
      { x: -111.5, y: 35.1, e: 1500, d: 0 },
      { x: -111.6, y: 35.2, e: 1550, d: 10000 },
      { x: -111.55, y: 35.15, e: 1525, d: 20000 },
      // Close the loop near the start point
      { x: -111.5, y: 35.1, e: 1500, d: 40000 },
    ],
    course_points: [
      { id: 1, x: -111.55, y: 35.15, d: 20000, type: 'Water', description: 'Spring' },
      { id: 2, x: -111.6, y: 35.2, d: 10000, type: 'Store', description: 'Gas station' },
    ],
  },
};

describe('parseRideWithGPS', () => {
  it('extracts the route name', () => {
    const ctx = parseRideWithGPS(RWGPS_PAYLOAD);
    expect(ctx.name).toBe('Test Loop');
  });

  it('converts track_points to [lat, lon] pairs', () => {
    const ctx = parseRideWithGPS(RWGPS_PAYLOAD);
    expect(ctx.trackPoints[0]).toEqual([35.1, -111.5]);
    expect(ctx.trackPoints[1]).toEqual([35.2, -111.6]);
  });

  it('converts distance from meters to miles', () => {
    const ctx = parseRideWithGPS(RWGPS_PAYLOAD);
    // 40000 m / 1609.344 ≈ 24.85 mi
    expect(ctx.totalDistanceMiles).toBeCloseTo(24.85, 1);
  });

  it('classifies and creates waypoints from course_points', () => {
    const ctx = parseRideWithGPS(RWGPS_PAYLOAD);
    const water = ctx.waypoints.find((w) => w.type === 'water');
    const resupply = ctx.waypoints.find((w) => w.type === 'resupply');
    expect(water).toBeDefined();
    expect(resupply).toBeDefined();
    expect(water.source).toBe('ridewithgps');
  });

  it('filters out course_points without coordinates', () => {
    const data = {
      route: {
        ...RWGPS_PAYLOAD.route,
        course_points: [
          { id: 1, x: null, y: null, type: 'Water' },
          { id: 2, x: -111.55, y: 35.15, d: 0, type: 'Store' },
        ],
      },
    };
    const ctx = parseRideWithGPS(data);
    expect(ctx.waypoints).toHaveLength(1);
  });

  it('handles data without a nested route key', () => {
    const flat = { ...RWGPS_PAYLOAD.route };
    const ctx = parseRideWithGPS(flat);
    expect(ctx.name).toBe('Test Loop');
  });

  it('sets startOffsetMi to 0', () => {
    const ctx = parseRideWithGPS(RWGPS_PAYLOAD);
    expect(ctx.startOffsetMi).toBe(0);
  });

  it('sets source to ridewithgps', () => {
    const ctx = parseRideWithGPS(RWGPS_PAYLOAD);
    expect(ctx.source).toBe('ridewithgps');
  });

  it('detects isLoop when start and end are close', () => {
    const ctx = parseRideWithGPS(RWGPS_PAYLOAD);
    // Our payload closes back near start so isLoop should be true
    expect(ctx.isLoop).toBe(true);
  });

  it('computes bounds correctly', () => {
    const ctx = parseRideWithGPS(RWGPS_PAYLOAD);
    expect(ctx.bounds.minLat).toBeCloseTo(35.1, 1);
    expect(ctx.bounds.maxLat).toBeCloseTo(35.2, 1);
    expect(ctx.bounds.minLon).toBeCloseTo(-111.6, 1);
    expect(ctx.bounds.maxLon).toBeCloseTo(-111.5, 1);
  });
});

// ---------------------------------------------------------------------------
// parseKomoot
// ---------------------------------------------------------------------------

const KOMOOT_PAYLOAD = {
  id: 42,
  name: 'Alpine Gravel',
  distance: 80000, // meters → ~49.7 mi
  _embedded: {
    coordinates: {
      items: [
        { lat: 47.5, lng: 11.0, alt: 900 },
        { lat: 47.6, lng: 11.1, alt: 950 },
        { lat: 47.55, lng: 11.05, alt: 920 },
      ],
    },
    timeline: {
      items: [
        {
          type: 'poi',
          reference: { lat: 47.6, lng: 11.1, text: 'Mountain Hut' },
        },
        {
          type: 'highlight',
          reference: { lat: 47.55, lng: 11.05, text: 'Summit View' },
        },
        // Item without reference coords should be filtered out
        { type: 'segment', reference: {} },
      ],
    },
  },
};

describe('parseKomoot', () => {
  it('extracts the tour name', () => {
    const ctx = parseKomoot(KOMOOT_PAYLOAD);
    expect(ctx.name).toBe('Alpine Gravel');
  });

  it('converts coordinates.items to [lat, lon] track points', () => {
    const ctx = parseKomoot(KOMOOT_PAYLOAD);
    expect(ctx.trackPoints[0]).toEqual([47.5, 11.0]);
    expect(ctx.trackPoints[1]).toEqual([47.6, 11.1]);
  });

  it('converts distance from meters to miles', () => {
    const ctx = parseKomoot(KOMOOT_PAYLOAD);
    // 80000 m / 1000 / 1.60934 ≈ 49.7 mi
    expect(ctx.totalDistanceMiles).toBeCloseTo(49.7, 0);
  });

  it('creates waypoints from timeline items with reference coords', () => {
    const ctx = parseKomoot(KOMOOT_PAYLOAD);
    // Item without reference.lat should be filtered out
    expect(ctx.waypoints).toHaveLength(2);
    expect(ctx.waypoints[0].name).toBe('Mountain Hut');
    expect(ctx.waypoints[0].source).toBe('komoot');
  });

  it('sets startOffsetMi to 0', () => {
    const ctx = parseKomoot(KOMOOT_PAYLOAD);
    expect(ctx.startOffsetMi).toBe(0);
  });

  it('sets source to komoot', () => {
    const ctx = parseKomoot(KOMOOT_PAYLOAD);
    expect(ctx.source).toBe('komoot');
  });

  it('handles missing _embedded gracefully', () => {
    const ctx = parseKomoot({ id: 1, name: 'Empty', distance: 0 });
    expect(ctx.trackPoints).toHaveLength(0);
    expect(ctx.waypoints).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// importFromURL (integration — stubs fetch)
// ---------------------------------------------------------------------------

describe('importFromURL', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws for an unrecognised URL', async () => {
    await expect(importFromURL('https://strava.com/activities/1')).rejects.toThrow(
      'Unrecognised URL',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('calls the RideWithGPS API for a ridewithgps URL', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => RWGPS_PAYLOAD,
    });

    const ctx = await importFromURL('https://ridewithgps.com/routes/99');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('ridewithgps.com/routes/99.json'),
      expect.any(Object),
    );
    expect(ctx.name).toBe('Test Loop');
    expect(ctx.source).toBe('ridewithgps');
  });

  it('throws on a non-ok RideWithGPS response', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(importFromURL('https://ridewithgps.com/routes/0')).rejects.toThrow(
      'RideWithGPS HTTP 404',
    );
  });

  it('calls the Komoot API for a komoot URL', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => KOMOOT_PAYLOAD,
    });

    const ctx = await importFromURL('https://www.komoot.com/tour/42');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('api.komoot.de/v007/tours/42'),
      expect.any(Object),
    );
    expect(ctx.name).toBe('Alpine Gravel');
    expect(ctx.source).toBe('komoot');
  });

  it('throws on a non-ok Komoot response', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 403 });
    await expect(importFromURL('https://www.komoot.com/tour/999')).rejects.toThrow(
      'Komoot HTTP 403',
    );
  });
});
