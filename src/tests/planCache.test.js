import { beforeEach, describe, expect, it } from 'vitest';
import { PLAN_DEFAULTS, buildPlan, clearPlanCache } from '../plan.js';

/**
 * A single planning-control edit calls buildPlan up to nine times with identical
 * arguments. These tests pin the memo that collapses those into one, and — more
 * importantly — pin every way the plan is allowed to go stale.
 */

/** @returns {import('../gpx.js').RouteContext} */
function makeRoute() {
  return {
    name: 'Cache Loop',
    totalDistanceMiles: 100,
    trackPoints: [
      [0, 0, 1000],
      [0.5, 0.5, 2000],
      [1, 1, 1000],
    ],
    bounds: { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 },
    startOffsetMi: 0,
    isLoop: true,
    waypoints: [
      { id: 'w-0', name: 'Spring A', type: 'water', reliability: 80, distanceFromStartMi: 10 },
      { id: 'w-1', name: 'Store', type: 'resupply', reliability: 90, distanceFromStartMi: 20 },
      { id: 'w-2', name: 'Camp 1', type: 'camping', reliability: 80, distanceFromStartMi: 45 },
      { id: 'w-3', name: 'Creek C', type: 'water', reliability: 70, distanceFromStartMi: 60 },
    ],
  };
}

describe('buildPlan memoization', () => {
  beforeEach(() => clearPlanCache());

  it('returns the identical object for repeated identical calls', () => {
    const route = makeRoute();
    const opts = { ...PLAN_DEFAULTS };
    const a = buildPlan(route, opts);
    const b = buildPlan(route, opts);
    expect(b).toBe(a);
  });

  it('recomputes when an option value changes', () => {
    const route = makeRoute();
    const a = buildPlan(route, { ...PLAN_DEFAULTS, targetDailyMiles: 45 });
    const b = buildPlan(route, { ...PLAN_DEFAULTS, targetDailyMiles: 20 });
    expect(b).not.toBe(a);
    expect(b.dayPlan.length).toBeGreaterThan(a.dayPlan.length);
  });

  it('recomputes when options are mutated in place', () => {
    // selectCampOption and the stop-state toggles mutate planOptions without
    // replacing the object, so identity comparison alone would serve a stale plan.
    const route = makeRoute();
    const opts = { ...PLAN_DEFAULTS };
    const a = buildPlan(route, opts);
    opts.waterCapacityOz = 24;
    const b = buildPlan(route, opts);
    expect(b).not.toBe(a);
  });

  it('recomputes when a waypoint is pushed onto the existing array', () => {
    // The waypoint editor pushes onto route.waypoints, preserving array identity.
    const route = makeRoute();
    const opts = { ...PLAN_DEFAULTS };
    const a = buildPlan(route, opts);
    route.waypoints.push({
      id: 'w-4',
      name: 'New Spring',
      type: 'water',
      reliability: 90,
      distanceFromStartMi: 75,
    });
    const b = buildPlan(route, opts);
    expect(b).not.toBe(a);
  });

  it('recomputes when enrichment replaces the waypoint array', () => {
    const route = makeRoute();
    const opts = { ...PLAN_DEFAULTS };
    const a = buildPlan(route, opts);
    route.waypoints = [...route.waypoints]; // same length, new identity
    const b = buildPlan(route, opts);
    expect(b).not.toBe(a);
  });

  it('recomputes for a different route object', () => {
    const opts = { ...PLAN_DEFAULTS };
    const a = buildPlan(makeRoute(), opts);
    const b = buildPlan(makeRoute(), opts);
    expect(b).not.toBe(a);
  });

  it('still returns a correct plan on a cache hit', () => {
    const route = makeRoute();
    const opts = { ...PLAN_DEFAULTS };
    const cold = buildPlan(route, opts);
    const warm = buildPlan(route, opts);
    expect(warm.dayPlan).toEqual(cold.dayPlan);
    expect(warm.waterCarry).toEqual(cold.waterCarry);
    expect(warm.foodCarry).toEqual(cold.foodCarry);
  });

  it('falls back to recomputing when options cannot be fingerprinted', () => {
    const route = makeRoute();
    const circular = { ...PLAN_DEFAULTS };
    circular.self = circular;
    expect(() => buildPlan(route, circular)).not.toThrow();
    const a = buildPlan(route, circular);
    const b = buildPlan(route, circular);
    expect(b).not.toBe(a); // unstringifiable key always misses, never goes stale
    expect(b.dayPlan).toEqual(a.dayPlan);
  });
});
