import { describe, expect, it, vi } from 'vitest';
import { calculateElevation } from '../gpx.js';
import {
  buildDayPlan,
  buildPlan,
  computeFoodCarry,
  computeWaterCarry,
  computeWaterDemand,
  optimizeWaterStops,
} from '../plan.js';
import { renderPlanningView } from '../planning.js';

/** @returns {import('../gpx.js').RouteContext} */
function makeRoute(extra = {}) {
  return {
    name: 'Test Loop',
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

/**
 * A ~40 mi route with a repeating climb/descent profile, so elevation gain
 * accumulates across the whole length rather than at a single spike.
 * @returns {import('../gpx.js').RouteContext}
 */
function makeElevationRoute() {
  const trackPoints = [];
  for (let i = 0; i <= 80; i++) {
    const ele = 1000 + (i % 8) * 40; // repeating 320 m climb/drop cycle
    trackPoints.push([35.0 + i * 0.0072, -111.0, ele]);
  }
  return { name: 'Elevation Route', totalDistanceMiles: 40, trackPoints, waypoints: [] };
}

describe('computeWaterCarry', () => {
  it('builds dry stretches between reliable sources when optimization is disabled', () => {
    const stretches = computeWaterCarry(makeRoute(), {
      reliableWaterThreshold: 50,
      ozPerMile: 5,
      waterCapacityOz: 100,
      optimizeWaterStops: false,
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

  it('optimizes stops to ~20 mile intervals and skips unnecessary intermediate water sources', () => {
    const route = {
      name: 'Dense Water Trail',
      totalDistanceMiles: 60,
      trackPoints: [
        [0, 0],
        [1, 1],
      ],
      waypoints: [
        { id: 'w1', name: 'Stream 1', type: 'water', reliability: 80, distanceFromStartMi: 4 },
        { id: 'w2', name: 'Stream 2', type: 'water', reliability: 80, distanceFromStartMi: 9 },
        { id: 'w3', name: 'Stream 3', type: 'water', reliability: 80, distanceFromStartMi: 19 },
        { id: 'w4', name: 'Stream 4', type: 'water', reliability: 80, distanceFromStartMi: 25 },
        { id: 'w5', name: 'Stream 5', type: 'water', reliability: 80, distanceFromStartMi: 38 },
        { id: 'w6', name: 'Stream 6', type: 'water', reliability: 80, distanceFromStartMi: 42 },
      ],
    };

    const stretches = computeWaterCarry(route, {
      optimizeWaterStops: true,
      targetWaterIntervalMi: 20,
      waterCapacityOz: 150,
      ozPerMile: 5,
    });

    // Instead of stopping at all 6 streams (4, 9, 19, 25, 38, 42),
    // it picks Stream 3 (19 mi) and Stream 5 (38 mi) before reaching Finish (60 mi)
    expect(stretches.map((s) => [s.fromMi, s.toMi])).toEqual([
      [0, 19],
      [19, 38],
      [38, 60],
    ]);
  });

  it('flags stretches that exceed water capacity', () => {
    const stretches = computeWaterCarry(makeRoute(), {
      reliableWaterThreshold: 50,
      ozPerMile: 5,
      waterCapacityOz: 100,
      optimizeWaterStops: false,
    });
    const first = stretches.find((s) => s.toMi === 10);
    const long = stretches.find((s) => s.fromMi === 60);
    expect(first.recommendedOz).toBeGreaterThanOrEqual(50);
    expect(first.exceedsCapacity).toBe(false);
    expect(long.recommendedOz).toBeGreaterThanOrEqual(200);
    expect(long.exceedsCapacity).toBe(true);
  });
});

describe('computeWaterDemand', () => {
  it('increases water demand with elevation climbing gain', () => {
    const flatRoute = {
      totalDistanceMiles: 10,
      trackPoints: [
        [35.0, -111.0, 1000],
        [35.1, -111.0, 1000],
      ],
    };
    const hillyRoute = {
      totalDistanceMiles: 10,
      trackPoints: [
        [35.0, -111.0, 1000],
        [35.05, -111.0, 1600], // +600m (~1968 ft) gain
        [35.1, -111.0, 1000],
      ],
    };

    const flatDemand = computeWaterDemand(flatRoute, 0, 10, { ozPerMile: 5 });
    const hillyDemand = computeWaterDemand(hillyRoute, 0, 10, { ozPerMile: 5 });

    expect(flatDemand).toBe(50);
    expect(hillyDemand).toBeGreaterThan(flatDemand);
  });

  it('derives climb from the same elevation source the day cards report', () => {
    // computeWaterDemand reads cumulative-gain prefix sums via calculateElevation
    // rather than re-walking the segment, so the climb it charges for must match
    // the gain shown alongside it in the plan.
    const route = makeElevationRoute();
    const { gainFt } = calculateElevation(route.trackPoints, 0, 20);
    const expectedClimbOz = (gainFt / 1000) * (5 * 0.6);
    const demand = computeWaterDemand(route, 0, 20, { ozPerMile: 5 });
    expect(demand).toBe(Math.ceil(20 * 5 + expectedClimbOz));
  });

  it('is additive across adjacent stretches, within rounding', () => {
    const route = makeElevationRoute();
    const whole = computeWaterDemand(route, 0, 40, { ozPerMile: 5 });
    const first = computeWaterDemand(route, 0, 20, { ozPerMile: 5 });
    const second = computeWaterDemand(route, 20, 40, { ozPerMile: 5 });
    expect(Math.abs(first + second - whole)).toBeLessThanOrEqual(2);
  });

  it('grows monotonically as the stretch lengthens', () => {
    const route = makeElevationRoute();
    let previous = 0;
    for (const toMi of [5, 10, 20, 30, 40]) {
      const demand = computeWaterDemand(route, 0, toMi, { ozPerMile: 5 });
      expect(demand).toBeGreaterThan(previous);
      previous = demand;
    }
  });

  it('returns zero for a negligible stretch', () => {
    const route = makeElevationRoute();
    expect(computeWaterDemand(route, 10, 10, { ozPerMile: 5 })).toBe(0);
    expect(computeWaterDemand(route, 10, 9, { ozPerMile: 5 })).toBe(0);
  });

  it('survives a route with no usable track points', () => {
    expect(
      computeWaterDemand({ totalDistanceMiles: 10, trackPoints: [] }, 0, 10, {
        ozPerMile: 5,
      }),
    ).toBe(50);
    expect(computeWaterDemand({ totalDistanceMiles: 10 }, 0, 10, { ozPerMile: 5 })).toBe(50);
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
    const stretches = computeWaterCarry(route, {
      reliableWaterThreshold: 50,
      optimizeWaterStops: false,
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
    const stretches = computeWaterCarry(route, {
      reliableWaterThreshold: 50,
      optimizeWaterStops: false,
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

  it('handles userStopStates manual overrides (planned & skipped)', () => {
    const route = makeRoute();
    const plan = buildPlan(route, {
      optimizeWaterStops: false,
      userStopStates: {
        'wpt-0': 'skipped', // Spring A skipped
        'wpt-1': 'planned', // Trough B planned
      },
    });

    const waterStretches = plan.waterCarry;
    expect(waterStretches.some((s) => s.toMi === 10 || s.fromMi === 10)).toBe(false);
    expect(waterStretches.some((s) => s.toMi === 18 || s.fromMi === 18)).toBe(true);
  });

  it('adds camp water reserve for stretches ending at dry campsites', () => {
    const route = {
      totalDistanceMiles: 40,
      waypoints: [
        { id: 'w1', name: 'Spring 1', type: 'water', reliability: 80, distanceFromStartMi: 18 },
        {
          id: 'c1',
          name: 'Dry Ridge Camp',
          type: 'camping',
          reliability: 0,
          distanceFromStartMi: 20,
        },
      ],
    };

    const plan = buildPlan(route, {
      targetDailyMiles: 20,
      campWaterReserveOz: 40,
      ozPerMile: 5,
    });

    const toCampStretch = plan.waterCarry.find((s) => s.toMi === 20 || s.toMi === 18);
    expect(toCampStretch).toBeDefined();
  });

  it('adapts stops when targetWaterIntervalMi is modified', () => {
    const route = {
      name: 'Interval Test Trail',
      totalDistanceMiles: 60,
      waypoints: [
        { id: 'w1', name: 'Water 10', type: 'water', reliability: 80, distanceFromStartMi: 10 },
        { id: 'w2', name: 'Water 20', type: 'water', reliability: 80, distanceFromStartMi: 20 },
        { id: 'w3', name: 'Water 30', type: 'water', reliability: 80, distanceFromStartMi: 30 },
        { id: 'w4', name: 'Water 40', type: 'water', reliability: 80, distanceFromStartMi: 40 },
        { id: 'w5', name: 'Water 50', type: 'water', reliability: 80, distanceFromStartMi: 50 },
      ],
    };

    // With 10-mile interval: stops at every water
    const stops10 = optimizeWaterStops(route, route.waypoints, {
      targetWaterIntervalMi: 10,
      waterCapacityOz: 100,
      ozPerMile: 5,
    });
    expect(stops10.length).toBeGreaterThanOrEqual(4);

    // With 30-mile interval: stops at mile 30
    const stops30 = optimizeWaterStops(route, route.waypoints, {
      targetWaterIntervalMi: 30,
      waterCapacityOz: 200,
      ozPerMile: 5,
    });
    expect(stops30.map((s) => s.distanceFromStartMi)).toEqual([30]);
  });

  it('supports 4-tier resupply food carry calculations', () => {
    const route = makeRoute();
    route.waypoints[6].resupplyCategory = 'restaurant';

    const spans = computeFoodCarry(route, {
      targetDailyMiles: 45,
      caloriesPerDay: 4000,
      campMealsPerDay: 1,
      caloriesPerCampMeal: 800,
      avgSnackCalories: 250,
    });

    const restaurantSpan = spans.find((s) => s.toMi === 60);
    expect(restaurantSpan.toCategory).toBe('restaurant');
    expect(restaurantSpan.toCategoryLabel).toBe('Restaurant / Diner');
  });
});

describe('Planning View Controls & Variable Inputs', () => {
  it('renders input fields with accessible labels and stepper buttons', () => {
    localStorage.clear();
    const root = document.createElement('div');
    const route = makeRoute();
    renderPlanningView(root, route);

    const waterCapInput = root.querySelector('#plan-capacity');
    expect(waterCapInput).toBeTruthy();
    expect(waterCapInput.value).toBe('100');

    const dailyInput = root.querySelector('#plan-daily');
    expect(dailyInput).toBeTruthy();
    expect(dailyInput.value).toBe('45');

    const waterLabel = root.querySelector('label[for="plan-capacity"]');
    expect(waterLabel).toBeTruthy();
    expect(waterLabel.textContent).toContain('Water capacity');

    const plusBtn = root.querySelector(
      '.plan-step-btn[data-target="plan-capacity"][data-step="8"]',
    );
    const minusBtn = root.querySelector(
      '.plan-step-btn[data-target="plan-capacity"][data-step="-8"]',
    );
    expect(plusBtn).toBeTruthy();
    expect(minusBtn).toBeTruthy();
  });

  it('allows clicking the + stepper button to increment water capacity', () => {
    localStorage.clear();
    const root = document.createElement('div');
    const route = makeRoute();
    renderPlanningView(root, route);

    let dispatchedOptions = null;
    root.addEventListener('plan-options-change', (e) => {
      dispatchedOptions = e.detail;
    });

    const plusBtn = root.querySelector(
      '.plan-step-btn[data-target="plan-capacity"][data-step="8"]',
    );
    plusBtn.click();

    const waterCapInput = root.querySelector('#plan-capacity');
    expect(waterCapInput.value).toBe('108');
    expect(dispatchedOptions).toBeTruthy();
    expect(dispatchedOptions.waterCapacityOz).toBe(108);
    expect(localStorage.getItem('bpnav-waterCapacityOz')).toBe('108');
  });

  it('allows clicking the − stepper button to decrement water capacity', () => {
    localStorage.clear();
    const root = document.createElement('div');
    const route = makeRoute();
    renderPlanningView(root, route);

    const minusBtn = root.querySelector(
      '.plan-step-btn[data-target="plan-capacity"][data-step="-8"]',
    );
    minusBtn.click();

    const waterCapInput = root.querySelector('#plan-capacity');
    expect(waterCapInput.value).toBe('92');
    expect(localStorage.getItem('bpnav-waterCapacityOz')).toBe('92');
  });

  it('allows typing a new value into the water capacity input', () => {
    // Typed edits are coalesced behind SYNC_DEBOUNCE_MS so a burst of keystrokes
    // is one recompute, so the dispatch lands on the timer, not on the event.
    // The stepper buttons above are a discrete gesture and stay synchronous.
    vi.useFakeTimers();
    try {
      localStorage.clear();
      const root = document.createElement('div');
      const route = makeRoute();
      renderPlanningView(root, route);

      let dispatchedOptions = null;
      root.addEventListener('plan-options-change', (e) => {
        dispatchedOptions = e.detail;
      });

      const waterCapInput = root.querySelector('#plan-capacity');
      waterCapInput.value = '128';
      waterCapInput.dispatchEvent(new Event('change', { bubbles: true }));
      vi.advanceTimersByTime(1000);

      expect(dispatchedOptions).toBeTruthy();
      expect(dispatchedOptions.waterCapacityOz).toBe(128);
      expect(localStorage.getItem('bpnav-waterCapacityOz')).toBe('128');
    } finally {
      vi.useRealTimers();
    }
  });

  it('respects min bound on stepper decrement', () => {
    localStorage.clear();
    const root = document.createElement('div');
    const route = makeRoute();
    renderPlanningView(root, route);

    const waterCapInput = root.querySelector('#plan-capacity');
    waterCapInput.value = '20';
    waterCapInput.dispatchEvent(new Event('change', { bubbles: true }));

    const minusBtn = root.querySelector(
      '.plan-step-btn[data-target="plan-capacity"][data-step="-8"]',
    );
    minusBtn.click();

    // min is 16
    expect(waterCapInput.value).toBe('16');
  });

  it('updates daily target and terrain surface type correctly', () => {
    localStorage.clear();
    const root = document.createElement('div');
    const route = makeRoute();
    renderPlanningView(root, route);

    const dailyPlus = root.querySelector('.plan-step-btn[data-target="plan-daily"][data-step="5"]');
    dailyPlus.click();

    const dailyInput = root.querySelector('#plan-daily');
    expect(dailyInput.value).toBe('50');

    const surfaceSelect = root.querySelector('#plan-surface-factor');
    surfaceSelect.value = '1.6';
    surfaceSelect.dispatchEvent(new Event('change', { bubbles: true }));

    expect(localStorage.getItem('bpnav-targetDailyMiles')).toBe('50');
  });
});
