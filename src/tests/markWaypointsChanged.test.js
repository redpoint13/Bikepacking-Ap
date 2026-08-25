import { describe, expect, it } from 'vitest';
import { markWaypointsChanged } from '../gpx.js';

describe('markWaypointsChanged', () => {
  it('re-seats the array so identity-based consumers invalidate', () => {
    const route = { waypoints: [{ id: 'a' }] };
    const before = route.waypoints;
    markWaypointsChanged(route);
    expect(route.waypoints).not.toBe(before);
    expect(route.waypoints).toEqual(before);
  });

  it('bumps the revision monotonically', () => {
    const route = { waypoints: [] };
    markWaypointsChanged(route);
    expect(route.waypointsRevision).toBe(1);
    markWaypointsChanged(route);
    markWaypointsChanged(route);
    expect(route.waypointsRevision).toBe(3);
  });

  it('starts from zero on a route that has never been marked', () => {
    const route = { waypoints: [] };
    expect(route.waypointsRevision).toBeUndefined();
    markWaypointsChanged(route);
    expect(route.waypointsRevision).toBe(1);
  });

  it('tolerates a missing or non-array waypoints field', () => {
    const route = {};
    expect(() => markWaypointsChanged(route)).not.toThrow();
    expect(route.waypoints).toEqual([]);
  });

  it('tolerates a null route', () => {
    expect(() => markWaypointsChanged(null)).not.toThrow();
  });

  it('returns the route for chaining', () => {
    const route = { waypoints: [] };
    expect(markWaypointsChanged(route)).toBe(route);
  });
});
