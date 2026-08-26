import { describe, expect, it, vi } from 'vitest';
import { PLAN_DEFAULTS, getActiveStopIds, isBikeReachable } from '../plan.js';
import {
  annotateWilderness,
  fetchWildernessAreas,
  readWildernessName,
  wildernessAt,
} from '../wilderness.js';

/**
 * Bicycles are barred from designated Wilderness Areas by the Wilderness Act.
 * A camp or water source inside one is unusable however good it looks, so this
 * is a hard filter on planning rather than a scoring penalty. It is separate
 * from land-manager legality: a Wilderness sits inside USFS or BLM ground,
 * both of which otherwise permit dispersed camping.
 */

/** A square with a square hole cut out of it. */
const AREAS = [
  {
    name: 'Lost Creek Wilderness',
    rings: [
      [
        [-106, 39],
        [-105, 39],
        [-105, 40],
        [-106, 40],
        [-106, 39],
      ],
      [
        [-105.6, 39.4],
        [-105.4, 39.4],
        [-105.4, 39.6],
        [-105.6, 39.6],
        [-105.6, 39.4],
      ],
    ],
  },
];

describe('wildernessAt', () => {
  it('finds a point inside the boundary', () => {
    expect(wildernessAt(39.2, -105.8, AREAS)).toBe('Lost Creek Wilderness');
  });

  it('treats a hole as outside, because a hole is excluded land', () => {
    expect(wildernessAt(39.5, -105.5, AREAS)).toBeNull();
  });

  it('returns null outside every area, and for unusable coordinates', () => {
    expect(wildernessAt(38.0, -107.0, AREAS)).toBeNull();
    expect(wildernessAt(Number.NaN, -105.8, AREAS)).toBeNull();
    expect(wildernessAt(39.2, -105.8, [])).toBeNull();
  });
});

describe('annotateWilderness', () => {
  const makeRoute = () => ({
    totalDistanceMiles: 100,
    trackPoints: [
      [39.2, -105.8, 3000],
      [38.0, -107.0, 3000],
    ],
    waypoints: [
      {
        id: 'c1',
        type: 'camping',
        lat: 39.2,
        lon: -105.8,
        distanceFromStartMi: 10,
        reliability: 90,
      },
      {
        id: 'c2',
        type: 'camping',
        lat: 38.0,
        lon: -107.0,
        distanceFromStartMi: 50,
        reliability: 90,
      },
    ],
  });

  it('flags only the waypoints inside a wilderness', () => {
    const route = makeRoute();
    expect(annotateWilderness(route, AREAS)).toBe(1);
    expect(route.waypoints[0].wilderness).toBe('Lost Creek Wilderness');
    expect(route.waypoints[0].bikeAccessible).toBe(false);
    expect(route.waypoints[1].bikeAccessible).not.toBe(false);
  });

  it('clears the flag if a waypoint is no longer inside one', () => {
    const route = makeRoute();
    route.waypoints[1].wilderness = 'Stale';
    route.waypoints[1].bikeAccessible = false;
    annotateWilderness(route, AREAS);
    expect(route.waypoints[1].wilderness).toBeUndefined();
    expect(route.waypoints[1].bikeAccessible).toBe(true);
  });

  it('does nothing when no boundaries loaded, rather than excluding everything', () => {
    const route = makeRoute();
    expect(annotateWilderness(route, [])).toBe(0);
    expect(route.waypoints.every((w) => w.bikeAccessible !== false)).toBe(true);
  });
});

describe('planning excludes wilderness waypoints', () => {
  it('never makes a flagged waypoint an active stop', () => {
    const route = {
      totalDistanceMiles: 100,
      trackPoints: [
        [39.2, -105.8, 3000],
        [38.0, -107.0, 3000],
      ],
      waypoints: [
        {
          id: 'w-in',
          type: 'water',
          lat: 39.2,
          lon: -105.8,
          distanceFromStartMi: 20,
          reliability: 95,
          offCourseDistanceMi: 0,
        },
        {
          id: 'w-out',
          type: 'water',
          lat: 38.0,
          lon: -107.0,
          distanceFromStartMi: 60,
          reliability: 95,
          offCourseDistanceMi: 0,
        },
      ],
    };
    const before = getActiveStopIds(route, { ...PLAN_DEFAULTS });
    expect(before.has('w-in')).toBe(true);

    annotateWilderness(route, AREAS);
    route.waypointsRevision = 1; // bust the plan memo
    const after = getActiveStopIds(route, { ...PLAN_DEFAULTS });
    expect(after.has('w-in')).toBe(false);
  });

  it('isBikeReachable defaults to reachable until boundaries say otherwise', () => {
    expect(isBikeReachable({})).toBe(true);
    expect(isBikeReachable({ bikeAccessible: false })).toBe(false);
  });
});

describe('fetchWildernessAreas', () => {
  it('asks for simplified geometry, or the corridor is megabytes', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ features: [] }) });
    vi.stubGlobal('fetch', spy);
    await fetchWildernessAreas({ minLat: 37, maxLat: 40, minLon: -108, maxLon: -105 });
    const url = new URL(spy.mock.calls[0][0]);
    expect(Number(url.searchParams.get('maxAllowableOffset'))).toBeGreaterThan(0);
    expect(url.searchParams.get('returnGeometry')).toBe('true');
    vi.unstubAllGlobals();
  });

  it('treats an ArcGIS error body as failure despite its HTTP 200', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ error: { message: 'boom' } }) }),
    );
    expect(
      await fetchWildernessAreas({ minLat: 37, maxLat: 40, minLon: -108, maxLon: -105 }),
    ).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe('readWildernessName', () => {
  it('reads the key however the service cases it', () => {
    // The layer accepts WILDERNESSNAME in outFields but answers with
    // `wildernessname`, so a case-sensitive read named every area "Wilderness
    // Area" — no use to a rider needing to know which detour applies.
    expect(readWildernessName({ wildernessname: 'Lost Creek Wilderness' })).toBe(
      'Lost Creek Wilderness',
    );
    expect(readWildernessName({ WILDERNESSNAME: 'Weminuche Wilderness' })).toBe(
      'Weminuche Wilderness',
    );
  });

  it('falls back only when there is genuinely no name', () => {
    expect(readWildernessName({})).toBe('Wilderness Area');
    expect(readWildernessName({ wildernessname: '   ' })).toBe('Wilderness Area');
    expect(readWildernessName(null)).toBe('Wilderness Area');
  });
});
