import { describe, expect, it } from 'vitest';
import { PLAN_DEFAULTS, optimizeWaterStops } from '../plan.js';

/**
 * stopOverheadMinutes and waterWeightPenalty are the two cost knobs in
 * optimizeWaterStops' candidate scoring. They pull in opposite directions: a
 * stop costs a fixed amount of time however short the leg, while carrying the
 * water for a leg costs more the longer the leg is. These pin that both are
 * actually consulted — they were declared but unread for a long time — and
 * that the shipped defaults leave stop selection where it was.
 */

/** A source every 6 miles over 120 mi, so the optimiser has real freedom. */
function makeCase() {
  const route = {
    name: 'Dense Water',
    totalDistanceMiles: 120,
    trackPoints: [
      [35.0, -111.0, 1000],
      [36.0, -111.0, 1000],
    ],
    waypoints: [],
  };
  const candidates = Array.from({ length: 19 }, (_, i) => ({
    id: `w${i}`,
    name: `Source ${i}`,
    type: 'water',
    reliability: 80,
    distanceFromStartMi: (i + 1) * 6,
    offCourseDistanceMi: 0,
  }));
  const opts = {
    targetWaterIntervalMi: 20,
    waterCapacityOz: 200,
    ozPerMile: 5,
    waterSafetyMarginPercent: 20,
    optimizeWaterStops: true,
    stopOverheadMinutes: PLAN_DEFAULTS.stopOverheadMinutes,
    waterWeightPenalty: PLAN_DEFAULTS.waterWeightPenalty,
  };
  return { route, candidates, opts };
}

const run = (extra = {}) => {
  const { route, candidates, opts } = makeCase();
  return optimizeWaterStops(route, candidates, { ...opts, ...extra });
};

describe('optimizeWaterStops cost knobs', () => {
  it('charges more per stop, so it makes fewer and longer legs', () => {
    const cheap = run({ stopOverheadMinutes: 0 });
    const dear = run({ stopOverheadMinutes: 400 });
    expect(dear.length).toBeLessThan(cheap.length);
    // Longer legs, not merely fewer stops that bunch up.
    expect(dear[0].distanceFromStartMi).toBeGreaterThan(cheap[0].distanceFromStartMi);
  });

  it('charges more to carry water, so it tops up more often', () => {
    const light = run({ waterWeightPenalty: 0 });
    const heavy = run({ waterWeightPenalty: 10 });
    expect(heavy.length).toBeGreaterThan(light.length);
    expect(heavy[0].distanceFromStartMi).toBeLessThan(light[0].distanceFromStartMi);
  });

  it('responds monotonically to the carry penalty', () => {
    const counts = [0, 2, 10].map((waterWeightPenalty) => run({ waterWeightPenalty }).length);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    }
  });

  it('leaves stop selection unchanged at the shipped defaults', () => {
    // Guards against a rescale of these terms silently re-planning every route.
    const atDefaults = run().map((s) => s.distanceFromStartMi);
    const withoutCosts = run({ stopOverheadMinutes: 0, waterWeightPenalty: 0 }).map(
      (s) => s.distanceFromStartMi,
    );
    expect(atDefaults).toEqual(withoutCosts);
  });

  it('falls back to the defaults when the options are absent', () => {
    const { route, candidates, opts } = makeCase();
    const { stopOverheadMinutes, waterWeightPenalty, ...withoutKnobs } = opts;
    expect(optimizeWaterStops(route, candidates, withoutKnobs).map((s) => s.id)).toEqual(
      run().map((s) => s.id),
    );
  });
});
