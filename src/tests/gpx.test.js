/**
 * gpx.test.js — Unit tests for the GPX parser module.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyStartOffset,
  classifyWaypoint,
  computeRouteDistance,
  distanceFromStart,
  haversineDistance,
  nearestTrackPointIndex,
  nextWaypointOfType,
  parseGPX,
  waypointsOfType,
} from '../gpx.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL_GPX = `<?xml version="1.0"?>
<gpx version="1.1">
  <trk><name>Test Route</name><trkseg>
    <trkpt lat="35.1989" lon="-111.6537"><ele>2100</ele></trkpt>
    <trkpt lat="35.2000" lon="-111.6600"><ele>2110</ele></trkpt>
    <trkpt lat="35.2100" lon="-111.6700"><ele>2120</ele></trkpt>
  </trkseg></trk>
  <wpt lat="35.2000" lon="-111.6600">
    <name>Oak Creek</name>
    <desc>Water source</desc>
  </wpt>
  <wpt lat="35.2100" lon="-111.6700">
    <name>Whole Foods</name>
    <desc>Resupply</desc>
  </wpt>
</gpx>`;

const NO_TRACK_GPX = `<?xml version="1.0"?>
<gpx version="1.1"><trk><name>Empty</name></trk></gpx>`;

const INVALID_GPX = 'not xml at all <<<';

let route;

beforeAll(() => {
  route = parseGPX(MINIMAL_GPX);
});

// ---------------------------------------------------------------------------
// parseGPX — basic structure
// ---------------------------------------------------------------------------

describe('parseGPX — structure', () => {
  it('returns a route name', () => {
    expect(route.name).toBe('Test Route');
  });

  it('extracts track points as [lat, lon] pairs', () => {
    expect(route.trackPoints).toHaveLength(3);
    expect(route.trackPoints[0].slice(0, 2)).toEqual([35.1989, -111.6537]);
  });

  it('computes totalDistanceMiles > 0', () => {
    expect(route.totalDistanceMiles).toBeGreaterThan(0);
  });

  it('sets startOffsetMi to 0', () => {
    expect(route.startOffsetMi).toBe(0);
  });

  it('sets isLoop (false for non-loop fixture)', () => {
    expect(typeof route.isLoop).toBe('boolean');
    expect(route.isLoop).toBe(false);
  });

  it('computes bounds', () => {
    expect(route.bounds.minLat).toBeCloseTo(35.1989, 3);
    expect(route.bounds.maxLat).toBeCloseTo(35.21, 2);
    expect(route.bounds.minLon).toBeCloseTo(-111.67, 2);
    expect(route.bounds.maxLon).toBeCloseTo(-111.6537, 3);
  });

  it('sorts waypoints by distanceFromStartMi ascending', () => {
    const dists = route.waypoints.map((w) => w.distanceFromStartMi);
    expect(dists).toEqual([...dists].sort((a, b) => a - b));
  });

  it('throws on GPX with no track points', () => {
    expect(() => parseGPX(NO_TRACK_GPX)).toThrow();
  });

  it('throws on completely invalid XML', () => {
    expect(() => parseGPX(INVALID_GPX)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Waypoint classification
// ---------------------------------------------------------------------------

describe('parseGPX — waypoint classification', () => {
  it('classifies Oak Creek as water', () => {
    const water = route.waypoints.find((w) => w.name === 'Oak Creek');
    expect(water).toBeDefined();
    expect(water.type).toBe('water');
  });

  it('classifies Whole Foods as resupply', () => {
    const resupply = route.waypoints.find((w) => w.name === 'Whole Foods');
    expect(resupply).toBeDefined();
    expect(resupply.type).toBe('resupply');
  });

  it('assigns a distanceFromStartMi > 0 to waypoints not at start', () => {
    for (const wp of route.waypoints) {
      expect(wp.distanceFromStartMi).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// classifyWaypoint
// ---------------------------------------------------------------------------

describe('classifyWaypoint', () => {
  it('returns water for creek/spring keywords', () => {
    expect(classifyWaypoint('Oak Creek')).toBe('water');
    expect(classifyWaypoint('Natural Spring')).toBe('water');
  });

  it('returns camping for camp keywords', () => {
    expect(classifyWaypoint('Dead Horse Ranch State Park')).toBe('camping');
    expect(classifyWaypoint('Camp Site')).toBe('camping');
    expect(classifyWaypoint('Shelter Cabin')).toBe('camping');
    expect(classifyWaypoint('Colorado Trail Yurt')).toBe('camping');
    expect(classifyWaypoint('10th Mountain Hut')).toBe('camping');
    expect(classifyWaypoint('2 Tent Site')).toBe('camping');
    expect(classifyWaypoint('Meadows CG Road')).toBe('camping');
    expect(classifyWaypoint('Wilderness Bivouac')).toBe('camping');
  });

  it('returns resupply for store keywords', () => {
    expect(classifyWaypoint('Whole Foods')).toBe('resupply');
    expect(classifyWaypoint('Pilot Travel Center')).toBe('resupply');
  });

  it('returns navigation for unrecognised waypoints', () => {
    expect(classifyWaypoint('Turn left at fence')).toBe('navigation');
    expect(classifyWaypoint('')).toBe('navigation');
  });

  it('checks description as well as name', () => {
    expect(classifyWaypoint('Point A', 'water cache here')).toBe('water');
  });

  it('returns summit for pass/peak keywords', () => {
    expect(classifyWaypoint('Georgia Pass')).toBe('summit');
    expect(classifyWaypoint('Elbert Peak')).toBe('summit');
    expect(classifyWaypoint('Mountain Crest')).toBe('summit');
  });
});

// ---------------------------------------------------------------------------
// haversineDistance
// ---------------------------------------------------------------------------

describe('haversineDistance', () => {
  it('returns 0 for identical points', () => {
    expect(haversineDistance(35.0, -111.0, 35.0, -111.0)).toBe(0);
  });

  it('calculates ~69 miles per degree of latitude', () => {
    const d = haversineDistance(35.0, -111.0, 36.0, -111.0);
    expect(d).toBeGreaterThan(68);
    expect(d).toBeLessThan(70);
  });

  it('is symmetric', () => {
    const d1 = haversineDistance(35.0, -111.0, 36.0, -112.0);
    const d2 = haversineDistance(36.0, -112.0, 35.0, -111.0);
    expect(d1).toBeCloseTo(d2, 8);
  });
});

// ---------------------------------------------------------------------------
// computeRouteDistance
// ---------------------------------------------------------------------------

describe('computeRouteDistance', () => {
  it('returns 0 for a single point', () => {
    expect(computeRouteDistance([[35.0, -111.0]])).toBe(0);
  });

  it('returns 0 for an empty array', () => {
    expect(computeRouteDistance([])).toBe(0);
  });

  it('sums segment distances', () => {
    const pts = [
      [35.0, -111.0],
      [36.0, -111.0],
      [37.0, -111.0],
    ];
    const d = computeRouteDistance(pts);
    const seg = haversineDistance(35.0, -111.0, 36.0, -111.0);
    expect(d).toBeCloseTo(seg * 2, 4);
  });
});

// ---------------------------------------------------------------------------
// nearestTrackPointIndex
// ---------------------------------------------------------------------------

describe('nearestTrackPointIndex', () => {
  const pts = [
    [35.0, -111.0],
    [35.5, -111.0],
    [36.0, -111.0],
  ];

  it('returns 0 for a point at the start', () => {
    expect(nearestTrackPointIndex(35.0, -111.0, pts)).toBe(0);
  });

  it('returns the last index for a point at the end', () => {
    expect(nearestTrackPointIndex(36.0, -111.0, pts)).toBe(2);
  });

  it('returns the nearest index for a midpoint', () => {
    expect(nearestTrackPointIndex(35.49, -111.0, pts)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// distanceFromStart
// ---------------------------------------------------------------------------

describe('distanceFromStart', () => {
  const pts = [
    [35.0, -111.0],
    [35.5, -111.0],
    [36.0, -111.0],
  ];

  it('returns ~0 for the first track point', () => {
    expect(distanceFromStart(35.0, -111.0, pts)).toBeCloseTo(0, 1);
  });

  it('returns a positive distance for a later point', () => {
    expect(distanceFromStart(36.0, -111.0, pts)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// waypointsOfType / nextWaypointOfType
// ---------------------------------------------------------------------------

describe('waypointsOfType', () => {
  it('returns only waypoints of the requested type', () => {
    const water = waypointsOfType(route, 'water');
    expect(water.every((w) => w.type === 'water')).toBe(true);
  });

  it('returns an empty array for a type with no waypoints', () => {
    expect(waypointsOfType(route, 'camping')).toHaveLength(0);
  });
});

describe('nextWaypointOfType', () => {
  it('returns the first water waypoint when currentMile is 0', () => {
    const next = nextWaypointOfType(route, 'water', 0);
    expect(next).not.toBeNull();
    expect(next.type).toBe('water');
  });

  it('returns null when no waypoints of that type exist', () => {
    const next = nextWaypointOfType(route, 'camping', 0);
    expect(next).toBeNull();
  });

  it('skips waypoints behind currentMile', () => {
    const first = nextWaypointOfType(route, 'water', 0);
    const afterFirst = nextWaypointOfType(route, 'water', first.distanceFromStartMi);
    // afterFirst should be further along (or null if only one water wpt)
    if (afterFirst) {
      expect(afterFirst.distanceFromStartMi).toBeGreaterThan(first.distanceFromStartMi);
    }
  });
});

// ---------------------------------------------------------------------------
// applyStartOffset
// ---------------------------------------------------------------------------

describe('applyStartOffset', () => {
  /** Build a minimal RouteContext with known waypoints for offset tests */
  function makeRoute({ isLoop = false } = {}) {
    return {
      name: 'Test Route',
      totalDistanceMiles: 100,
      trackPoints: [],
      isLoop,
      startOffsetMi: 0,
      waypoints: [
        { id: 'w1', lat: 0, lon: 0, type: 'water', distanceFromStartMi: 10 },
        { id: 'w2', lat: 0, lon: 0, type: 'resupply', distanceFromStartMi: 40 },
        { id: 'w3', lat: 0, lon: 0, type: 'camping', distanceFromStartMi: 70 },
      ],
      bounds: { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 },
    };
  }

  it('returns a new object — does not mutate the original', () => {
    const original = makeRoute();
    const adjusted = applyStartOffset(original, 20);
    expect(adjusted).not.toBe(original);
    // Original waypoints unchanged
    expect(original.waypoints[0].distanceFromStartMi).toBe(10);
  });

  it('with offset 0 leaves distances unchanged', () => {
    const adjusted = applyStartOffset(makeRoute(), 0);
    expect(adjusted.waypoints[0].distanceFromStartMi).toBe(10);
    expect(adjusted.waypoints[1].distanceFromStartMi).toBe(40);
    expect(adjusted.waypoints[2].distanceFromStartMi).toBe(70);
  });

  it('sets startOffsetMi on the returned context', () => {
    const adjusted = applyStartOffset(makeRoute(), 25);
    expect(adjusted.startOffsetMi).toBe(25);
  });

  // --- Point-to-point ---
  describe('point-to-point route', () => {
    it('subtracts the offset from each waypoint distance', () => {
      const adjusted = applyStartOffset(makeRoute({ isLoop: false }), 20);
      // w1 was at 10 -> 10-20 = -10 (behind start)
      // w2 was at 40 -> 40-20 = 20
      // w3 was at 70 -> 70-20 = 50
      expect(adjusted.waypoints.find((w) => w.id === 'w1').distanceFromStartMi).toBe(-10);
      expect(adjusted.waypoints.find((w) => w.id === 'w2').distanceFromStartMi).toBe(20);
      expect(adjusted.waypoints.find((w) => w.id === 'w3').distanceFromStartMi).toBe(50);
    });

    it('re-sorts waypoints by adjusted distance', () => {
      const adjusted = applyStartOffset(makeRoute({ isLoop: false }), 20);
      const dists = adjusted.waypoints.map((w) => w.distanceFromStartMi);
      expect(dists).toEqual([...dists].sort((a, b) => a - b));
    });

    it('clamps offset to [0, totalDistanceMiles]', () => {
      const over = applyStartOffset(makeRoute({ isLoop: false }), 999);
      expect(over.startOffsetMi).toBe(100);
      const neg = applyStartOffset(makeRoute({ isLoop: false }), -5);
      expect(neg.startOffsetMi).toBe(0);
    });
  });

  // --- Loop route ---
  describe('loop route', () => {
    it('uses modular arithmetic so all distances are non-negative', () => {
      // total = 100, offset = 20
      // w1 at 10: (10-20+100)%100 = 90
      // w2 at 40: (40-20+100)%100 = 20
      // w3 at 70: (70-20+100)%100 = 50
      const adjusted = applyStartOffset(makeRoute({ isLoop: true }), 20);
      expect(adjusted.waypoints.find((w) => w.id === 'w1').distanceFromStartMi).toBeCloseTo(90);
      expect(adjusted.waypoints.find((w) => w.id === 'w2').distanceFromStartMi).toBeCloseTo(20);
      expect(adjusted.waypoints.find((w) => w.id === 'w3').distanceFromStartMi).toBeCloseTo(50);
    });

    it('all adjusted distances are >= 0 for any offset', () => {
      for (const offset of [0, 10, 50, 99, 100]) {
        const adjusted = applyStartOffset(makeRoute({ isLoop: true }), offset);
        for (const wp of adjusted.waypoints) {
          expect(wp.distanceFromStartMi).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('preserves _absDistMi as the original distance', () => {
      const adjusted = applyStartOffset(makeRoute({ isLoop: true }), 20);
      expect(adjusted.waypoints.find((w) => w.id === 'w1')._absDistMi).toBe(10);
    });
  });
});
