import { describe, expect, it } from 'vitest';
import {
  PLAN_DEFAULTS,
  buildDayPlan,
  campCost,
  getWaypointsWithSyntheticCamps,
  isCampLegal,
} from '../plan.js';

/**
 * Camp selection used to be distance-to-target alone, which ignored every
 * quality signal camp.js computes. An established, watered site lost to an
 * unknown point a tenth of a mile closer, and a synthetic point invented by the
 * planner was scored 100 — so the least-informed markers on the map looked like
 * the most dependable ones.
 */

function makeRoute(camps) {
  const trackPoints = [];
  for (let i = 0; i <= 200; i++) trackPoints.push([39.0 + i * 0.005, -106.0, 3000]);
  return {
    totalDistanceMiles: 100,
    trackPoints,
    waypoints: camps,
    metadata: { forcedCampIds: [] },
  };
}

const camp = (over) => ({
  type: 'camping',
  reliability: 80,
  waterAvailable: 'potable',
  tier: 'official',
  ...over,
});

describe('isCampLegal', () => {
  it('rejects a dispersed site where dispersed camping is not allowed', () => {
    expect(isCampLegal(camp({ tier: 'dispersed', isDispersedLegal: false }))).toBe(false);
    expect(isCampLegal(camp({ isSynthetic: true, isDispersedLegal: false }))).toBe(false);
  });

  it('keeps an official campground even on land closed to dispersed camping', () => {
    // A KOA or a state park sits on private or restricted land and is still
    // somewhere you are explicitly invited to camp. Excluding it for the same
    // reason as a wild pitch would throw away the best sites on the route.
    expect(isCampLegal(camp({ tier: 'official', isDispersedLegal: false }))).toBe(true);
  });

  it('allows anything with no legality information', () => {
    expect(isCampLegal(camp({ tier: 'dispersed' }))).toBe(true);
    expect(isCampLegal({})).toBe(true);
  });
});

describe('campCost', () => {
  it('still treats distance from target as the main axis', () => {
    const near = camp({ distanceFromStartMi: 45 });
    const far = camp({ distanceFromStartMi: 60 });
    expect(campCost(near, 45)).toBeLessThan(campCost(far, 45));
  });

  it('prefers a known watered site slightly further out over an unknown one', () => {
    const good = camp({ distanceFromStartMi: 47, reliability: 90, waterAvailable: 'potable' });
    const unknown = camp({ distanceFromStartMi: 45, reliability: 0, waterAvailable: 'none' });
    expect(campCost(good, 45)).toBeLessThan(campCost(unknown, 45));
  });

  it('penalises a dry camp more than one whose water is merely unrecorded', () => {
    const dry = camp({ distanceFromStartMi: 45, waterAvailable: 'none' });
    const unrecorded = camp({ distanceFromStartMi: 45, waterAvailable: 'unknown' });
    expect(campCost(dry, 45)).toBeGreaterThan(campCost(unrecorded, 45));
  });
});

describe('buildDayPlan camp choice', () => {
  it('chooses the better site over the marginally closer one', () => {
    const route = makeRoute([
      camp({
        id: 'closer-unknown',
        distanceFromStartMi: 45.2,
        reliability: 0,
        waterAvailable: 'none',
        tier: 'dispersed',
      }),
      camp({
        id: 'better-site',
        distanceFromStartMi: 46.5,
        reliability: 90,
        waterAvailable: 'potable',
      }),
    ]);
    const days = buildDayPlan(route, { ...PLAN_DEFAULTS, targetDailyMiles: 45 });
    expect(days[0].chosen.campId).toBe('better-site');
  });

  it('never chooses a dispersed site on land closed to dispersed camping', () => {
    const route = makeRoute([
      camp({ id: 'illegal', distanceFromStartMi: 45, tier: 'dispersed', isDispersedLegal: false }),
      camp({ id: 'legal', distanceFromStartMi: 52, tier: 'dispersed', isDispersedLegal: true }),
    ]);
    const days = buildDayPlan(route, { ...PLAN_DEFAULTS, targetDailyMiles: 45 });
    expect(days[0].chosen.campId).not.toBe('illegal');
  });
});

describe('synthetic camps state what they are', () => {
  const syntheticRoute = () => makeRoute([]); // no real camps at all

  it('carries no reliability rather than claiming certainty', () => {
    const opts = { ...PLAN_DEFAULTS, targetDailyMiles: 45 };
    const wpts = getWaypointsWithSyntheticCamps(syntheticRoute(), opts);
    const synth = wpts.filter((w) => w.isSynthetic);
    expect(synth.length).toBeGreaterThan(0);
    for (const s of synth) {
      // null hides the popup's reliability bar; 100 painted it full.
      expect(s.reliability).toBeNull();
      expect(s.needsSiteSelection).toBe(true);
    }
  });

  it('is named as a target, not as a campsite, and drops the word Wilderness', () => {
    const wpts = getWaypointsWithSyntheticCamps(syntheticRoute(), {
      ...PLAN_DEFAULTS,
      targetDailyMiles: 45,
    });
    const s = wpts.find((w) => w.isSynthetic);
    expect(s.name).toMatch(/no known site|no known campsite/i);
    // "Wilderness dispersed camping" named the one thing bikes may not do.
    expect(s.description).not.toMatch(/wilderness/i);
    expect(s.description).toMatch(/find a spot|need to find/i);
  });

  it('stays strippable by id and flag, so persisted plans stay clean', () => {
    const wpts = getWaypointsWithSyntheticCamps(syntheticRoute(), {
      ...PLAN_DEFAULTS,
      targetDailyMiles: 45,
    });
    const s = wpts.find((w) => w.isSynthetic);
    expect(s.id.startsWith('synth-')).toBe(true);
    expect(s.isSynthetic).toBe(true);
  });
});

describe('the last-resort fallback honours legality too', () => {
  /**
   * When no camp falls inside the short, medium or long window, buildDayPlan
   * drops to a fallback that takes the nearest camp within ~45% of the target.
   * That loop did not consult isCampLegal, so the one situation the hard filter
   * exists for — a dispersed site on land closed to dispersed camping being the
   * only thing in range — was exactly the situation that bypassed it.
   *
   * With target 45 the windows span 27–63 miles, and the fallback reaches
   * 24.75–65.25, so a camp at mile 25 is outside every window but inside the
   * fallback's range.
   */
  const opts = { ...PLAN_DEFAULTS, targetDailyMiles: 45 };

  it('degrades to a synthetic marker rather than an illegal camp', () => {
    const route = makeRoute([
      camp({
        id: 'only-and-illegal',
        distanceFromStartMi: 25,
        tier: 'dispersed',
        isDispersedLegal: false,
      }),
    ]);
    const days = buildDayPlan(route, opts);
    expect(days[0].chosen.campId).not.toBe('only-and-illegal');
    expect(days[0].chosen.campId).toMatch(/^synth-camp-/);
  });

  it('still uses the fallback when the only camp in range is legal', () => {
    // Guards against fixing the leak by breaking the fallback outright.
    const route = makeRoute([
      camp({
        id: 'only-and-legal',
        distanceFromStartMi: 25,
        tier: 'dispersed',
        isDispersedLegal: true,
      }),
    ]);
    const days = buildDayPlan(route, opts);
    expect(days[0].chosen.campId).toBe('only-and-legal');
  });
});

describe('synthetic camp water proximity recommendation', () => {
  const opts = { ...PLAN_DEFAULTS, targetDailyMiles: 40 };

  it('names dispersed camp near reliable water when water is close to target mileage', () => {
    const route = makeRoute([
      {
        id: 'water-spring-39',
        name: 'Cascade Spring',
        type: 'water',
        distanceFromStartMi: 39.5,
        lat: 37.74,
        lon: -107.85,
        reliability: 90,
      },
    ]);
    const days = buildDayPlan(route, opts);
    expect(days[0].chosen.campName).toContain('Dispersed Camp near Cascade Spring');
    expect(days[0].chosen.campName).toContain('39.5');
  });

  it('falls back to no known site when no water is near target mileage', () => {
    const route = makeRoute([
      {
        id: 'water-spring-10',
        name: 'Far Spring',
        type: 'water',
        distanceFromStartMi: 10,
        lat: 37.74,
        lon: -107.85,
        reliability: 90,
      },
    ]);
    const days = buildDayPlan(route, opts);
    expect(days[0].chosen.campName).toMatch(/Target mi 40.0 — no known site/);
  });
});
