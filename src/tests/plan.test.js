/**
 * plan.test.js — Unit tests for the planning engine.
 */

import { describe, expect, it } from 'vitest';
import { buildDayPlan, buildPlan, computeFoodCarry, computeWaterCarry } from '../plan.js';

/** @returns {import('../gpx.js').RouteContext} */
function makeRoute(extra = {}) {
  return {
    name: 'Test Loop',
    totalDistanceMiles: 100,
    trackPoints: [
      [0, 0],
      [1, 1],
    ],
    bounds: { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 },
    startOffsetMi: 0,
    isLoop: true,
    waypoints: [
      { id: 'wpt-0', name: 'Spring A', type: 'water', reliability: 80, distanceFromStartMi: 10 },
      { id: 'wpt-1', name: 'Trough B', type: 'water', reliability: 30, distanceFromStartMi: 18 },
      { id: 'wpt-2', name: 'Store', type: 'resupply', reliability: 90, distanceFromStartMi: 20 },
      { id: 'wpt-3', name: 'Camp 1', type: 'camping', reliability: 80, distanceFromStartMi: 22 },
      { id: 'wpt-4', name: 'Creek C', type: 'water', reliability: 70, distanceFromStartMi: 45 },
      { id: 'wpt-5', name: 'Camp 2', type: 'camping', reliability: 80, distanceFromStartMi: 48 },
      { id: 'wpt-6', name: 'Diner', type: 'resupply', reliability: 90, distanceFromStartMi: 60 },
      { id: 'wpt-7', name: 'Camp 3', type: 'camping', reliability: 80, distanceFromStartMi: 90 },
    ],
    ...extra,
  };
}

describe('computeWaterCarry', () => {
  it('builds dry stretches between reliable sources', () => {
    const stretches = computeWaterCarry(makeRoute(), {
      reliableWaterThreshold: 50,
      ozPerMile: 5,
      waterCapacityOz: 100,
    });
    // Anchors: Start(0), Spring A(10), Store(20), Creek C(45), Diner(60), Finish(100)
    expect(stretches.map((s) => [s.fromMi, s.toMi])).toEqual([
      [0, 10],
      [10, 20],
      [20, 45],
      [45, 60],
      [60, 100],
    ]);
  });

  it('flags stretches that exceed water capacity', () => {
    const stretches = computeWaterCarry(makeRoute(), {
      reliableWaterThreshold: 50,
      ozPerMile: 5,
      waterCapacityOz: 100,
    });
    const first = stretches.find((s) => s.toMi === 10);
    const long = stretches.find((s) => s.fromMi === 60);
    expect(first.recommendedOz).toBe(50);
    expect(first.exceedsCapacity).toBe(false);
    expect(long.recommendedOz).toBe(200); // 40 mi * 5 oz
    expect(long.exceedsCapacity).toBe(true);
  });
});

describe('computeFoodCarry', () => {
  it('builds spans between resupply points', () => {
    const spans = computeFoodCarry(makeRoute(), {
      targetDailyMiles: 45,
      caloriesPerDay: 4000,
      campMealsPerDay: 1,
      caloriesPerCampMeal: 800,
      avgSnackCalories: 250,
    });
    // Anchors: Start(0), Store(20), Diner(60), Finish(100)
    expect(spans.map((s) => [s.fromMi, s.toMi])).toEqual([
      [0, 20],
      [20, 60],
      [60, 100],
    ]);
    expect(spans.every((s) => s.days >= 1)).toBe(true);

    // Span 1: 20 miles. daysFloat = 20 / 45 = 0.44 days.
    // Calories = 0.4444 * 4000 = 1778 kcal.
    // Camp Meals = Math.round(0.44 * 1) = 0 meals.
    // Snack Calories = 1778 - 0 = 1778 kcal.
    // Snacks = Math.round(1778 / 250) = 7 snacks.
    // Weight = 1778 / 110 = 16 oz.
    expect(spans[0].calories).toBe(1778);
    expect(spans[0].campMeals).toBe(0);
    expect(spans[0].snacks).toBe(7);
    expect(spans[0].weightOz).toBe(16);
  });
});

describe('buildDayPlan', () => {
  it('splits the route into days that cover the full distance', () => {
    const days = buildDayPlan(makeRoute(), { targetDailyMiles: 45 });
    expect(days.length).toBeGreaterThan(0);
    const last = days[days.length - 1];
    expect(last.chosen.endMi).toBe(100);
  });

  it('offers camp options and advances on the chosen one', () => {
    const days = buildDayPlan(makeRoute(), { targetDailyMiles: 45 });
    // Day 1 medium camp should be Camp 2 (mile 48, nearest to target 45)
    expect(days[0].options.medium.campName).toBe('Camp 2');
    expect(days[0].chosen.endMi).toBe(48);
  });

  it('terminates with a Finish day when no camp is in range', () => {
    const route = makeRoute({ waypoints: [], totalDistanceMiles: 40 });
    const days = buildDayPlan(route, { targetDailyMiles: 45 });
    expect(days.length).toBe(1);
    expect(days[0].chosen.isFinish).toBe(true);
    expect(days[0].chosen.endMi).toBe(40);
  });
});

describe('buildPlan', () => {
  it('bundles water, food, and day plans with resolved options', () => {
    const plan = buildPlan(makeRoute(), { targetDailyMiles: 45 });
    expect(plan.waterCarry.length).toBeGreaterThan(0);
    expect(plan.foodCarry.length).toBeGreaterThan(0);
    expect(plan.dayPlan.length).toBeGreaterThan(0);
    expect(plan.options.targetDailyMiles).toBe(45);
  });
});

describe('Water Optimizer and Manual Overrides', () => {
  it('respects excludedWaterIds', () => {
    const route = makeRoute();
    // Normally Spring A (10) and Creek C (45) are stops.
    // If we exclude Spring A:
    const stretches = computeWaterCarry(route, {
      reliableWaterThreshold: 50,
      excludedWaterIds: ['wpt-0'], // Spring A is id 'wpt-0'
    });
    // Anchors should be: Start(0), Store(20), Creek C(45), Diner(60), Finish(100)
    expect(stretches.map((s) => [s.fromMi, s.toMi])).toEqual([
      [0, 20],
      [20, 45],
      [45, 60],
      [60, 100],
    ]);
  });

  it('respects forcedWaterIds', () => {
    const route = makeRoute();
    // Normally Trough B (18) is unreliable (30% < 50% threshold).
    // If we force Trough B:
    const stretches = computeWaterCarry(route, {
      reliableWaterThreshold: 50,
      forcedWaterIds: ['wpt-1'], // Trough B is 'wpt-1'
    });
    // Anchors: Start(0), Spring A(10), Trough B(18), Store(20), Creek C(45), Diner(60), Finish(100)
    expect(stretches.map((s) => [s.fromMi, s.toMi])).toEqual([
      [0, 10],
      [10, 18],
      [18, 20],
      [20, 45],
      [45, 60],
      [60, 100],
    ]);
  });

  it('optimizes water stops based on stop overhead vs carry weight', () => {
    const route = makeRoute();
    // We have water at 10 and 45.
    // Let's add a water source at 20.
    route.waypoints.push({
      id: 'wpt-8',
      name: 'Spring D',
      type: 'water',
      reliability: 80,
      distanceFromStartMi: 20,
    });
    route.waypoints.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

    // If optimizeWaterStops is false, we stop at all: 10, 20, 45, 60
    const normal = computeWaterCarry(route, { optimizeWaterStops: false });
    expect(normal.map((s) => [s.fromMi, s.toMi])).toEqual([
      [0, 10],
      [10, 20],
      [20, 45],
      [45, 60],
      [60, 100],
    ]);

    // If optimizeWaterStops is true, and overhead is high (30 mins) and penalty is low:
    // it should skip Spring D (20) if we exclude the resupply point at 20 so only Spring D remains.
    const optimized = computeWaterCarry(route, {
      optimizeWaterStops: true,
      waterCapacityOz: 200,
      stopOverheadMinutes: 30,
      waterWeightPenalty: 0.01,
    });
    // It should skip 10 and 45 (since they have high overhead) and stop only at resupply points (20, 60)!
    expect(optimized.map((s) => [s.fromMi, s.toMi])).toEqual([
      [0, 20],
      [20, 60],
      [60, 100],
    ]);
  });
});
