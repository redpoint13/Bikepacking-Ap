import { describe, expect, it } from 'vitest';
import { ENRICHMENT_LIMITS, capEnrichedWaypoints } from '../enrichmentLimits.js';

/**
 * The Overpass queries are bbox-wide and uncapped, so a route through a town
 * returns every cafe and hotel in it. These tests pin the thinning that keeps
 * that from flooding the planner — and, more importantly, pin what it must
 * never drop.
 */

function osm(mi, reliability, id = `osm-${mi}-${reliability}`) {
  return { id, type: 'resupply', source: 'osm', distanceFromStartMi: mi, reliability };
}
function gpxWaypoint(mi, id = `gpx-${mi}`) {
  return { id, type: 'resupply', source: 'route', distanceFromStartMi: mi, reliability: 50 };
}

const LIMITS = { maxCount: 10, minSpacingMi: 1 };

describe('capEnrichedWaypoints', () => {
  it('returns waypoints sorted by distance', () => {
    const out = capEnrichedWaypoints([osm(30, 80), osm(10, 80), osm(20, 80)], LIMITS);
    expect(out.map((w) => w.distanceFromStartMi)).toEqual([10, 20, 30]);
  });

  it('keeps the highest-reliability stop in a cluster', () => {
    const cluster = [osm(10.0, 65, 'bar'), osm(10.1, 90, 'supermarket'), osm(10.2, 70, 'cafe')];
    const out = capEnrichedWaypoints(cluster, LIMITS);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('supermarket');
  });

  it('keeps stops that are properly spread out', () => {
    const spread = [osm(0, 80), osm(5, 80), osm(10, 80), osm(15, 80)];
    expect(capEnrichedWaypoints(spread, LIMITS)).toHaveLength(4);
  });

  it('never drops a waypoint the rider did not get from OSM', () => {
    const user = { id: 'user-1', source: 'user', distanceFromStartMi: 10.0, reliability: 0 };
    const gpx = gpxWaypoint(10.05);
    const usgs = { id: 'usgs-1', source: 'usgs', distanceFromStartMi: 10.1, reliability: 90 };
    const out = capEnrichedWaypoints([user, gpx, usgs, osm(10.02, 100)], LIMITS);
    const ids = out.map((w) => w.id);
    expect(ids).toContain('user-1');
    expect(ids).toContain('gpx-10.05');
    expect(ids).toContain('usgs-1');
  });

  it('does not place an OSM stop on top of a non-OSM one', () => {
    const gpx = gpxWaypoint(10);
    const out = capEnrichedWaypoints([gpx, osm(10.1, 100)], LIMITS);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('gpx-10');
  });

  it('enforces maxCount even when everything is well spaced', () => {
    const many = Array.from({ length: 50 }, (_, i) => osm(i * 10, 80));
    const out = capEnrichedWaypoints(many, { maxCount: 6, minSpacingMi: 1 });
    expect(out).toHaveLength(6);
  });

  it('counts only OSM stops against maxCount', () => {
    const protectedWpts = Array.from({ length: 20 }, (_, i) => gpxWaypoint(i * 10));
    const out = capEnrichedWaypoints([...protectedWpts, osm(5, 80), osm(15, 80)], {
      maxCount: 1,
      minSpacingMi: 1,
    });
    expect(out.filter((w) => w.source === 'route')).toHaveLength(20);
    expect(out.filter((w) => w.source === 'osm')).toHaveLength(1);
  });

  it('is stable — the same input yields the same survivors', () => {
    const input = [osm(10.0, 80, 'a'), osm(10.1, 80, 'b'), osm(10.2, 80, 'c')];
    const first = capEnrichedWaypoints(input, LIMITS).map((w) => w.id);
    const second = capEnrichedWaypoints([...input].reverse(), LIMITS).map((w) => w.id);
    expect(second).toEqual(first);
  });

  it('handles empty and absent input', () => {
    expect(capEnrichedWaypoints([], LIMITS)).toEqual([]);
    expect(capEnrichedWaypoints(null, LIMITS)).toEqual([]);
  });

  it('passes everything through when no limits are given', () => {
    const cluster = [osm(10.0, 65), osm(10.1, 90), osm(10.2, 70)];
    expect(capEnrichedWaypoints(cluster, null)).toHaveLength(3);
  });

  it('thins a town-density cluster to something a planner can use', () => {
    // 300 resupply nodes packed into 4 miles of town, as Flagstaff returns.
    const town = Array.from({ length: 300 }, (_, i) =>
      osm(20 + (i / 300) * 4, 60 + (i % 30), `town-${i}`),
    );
    const out = capEnrichedWaypoints(town, ENRICHMENT_LIMITS.resupply);
    expect(out.length).toBeLessThanOrEqual(9); // 4 mi at 0.5 mi spacing
    expect(out.length).toBeGreaterThan(0);
  });

  it('ships limits for every enriched waypoint type', () => {
    for (const type of ['water', 'camping', 'resupply']) {
      expect(ENRICHMENT_LIMITS[type].maxCount).toBeGreaterThan(0);
      expect(ENRICHMENT_LIMITS[type].minSpacingMi).toBeGreaterThan(0);
    }
  });
});
