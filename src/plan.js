/**
 * plan.js — Planning engine for Bikepacker Navigator.
 *
 * Pure functions that answer the three planning questions from a resource log:
 *   1. How much water do I carry to the next reliable source?  (water carry)
 *   2. How much food do I carry to the next resupply?           (food carry)
 *   3. How do I break the route into days, and where can I camp? (day plan)
 *
 * Everything here is on-device and side-effect free, so it is trivially
 * testable and works offline. The UI layer (planning.js) renders the output.
 *
 * @module plan
 */

import { isReliableWater } from './triplog.js';

// ---------------------------------------------------------------------------
// Defaults — all overridable from the Planning UI
// ---------------------------------------------------------------------------

export const PLAN_DEFAULTS = {
  /** Target distance per riding day (miles). */
  targetDailyMiles: 45,
  /** Water consumption estimate (oz per mile ridden). */
  ozPerMile: 5,
  /** On-bike water capacity (oz). 100oz ≈ 3L. */
  waterCapacityOz: 100,
  /** Reliability score at/above which water counts as a dependable refill. */
  reliableWaterThreshold: 50,
  /** Day length window: a day may run from 60%–140% of target. */
  dayMinFactor: 0.6,
  /** Day length window max factor. */
  dayMaxFactor: 1.4,
  /** Whether to optimize water stops rather than stopping at every source. */
  optimizeWaterStops: false,
  /** Overhead time penalty per water stop (minutes). */
  stopOverheadMinutes: 15,
  /** Penalty for carrying 1 oz of water for 1 mile (equivalent to minutes). */
  waterWeightPenalty: 0.1,
  /** Array of waypoint IDs to explicitly skip. */
  excludedWaterIds: [],
  /** Array of waypoint IDs to explicitly force as stops. */
  forcedWaterIds: [],
  /** Array of resupply waypoint IDs to explicitly skip. */
  excludedResupplyIds: [],
  /** Array of resupply waypoint IDs to explicitly force as stops. */
  forcedResupplyIds: [],
  /** Array of camp waypoint IDs to explicitly skip. */
  excludedCampIds: [],
  /** Array of camp waypoint IDs to explicitly force as stops. */
  forcedCampIds: [],
  /** Target calorie intake per riding day (kcal). */
  caloriesPerDay: 3500,
  /** Number of camp meals carried and eaten per day (usually dinner). */
  campMealsPerDay: 1,
  /** Average calories per freeze-dried or camp meal. */
  caloriesPerCampMeal: 800,
  /** Average calories per snack bar/gel/pocket food. */
  avgSnackCalories: 250,
  /** Max detour distance off-route (miles) to include resources. */
  maxDetourMi: 1.5,
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Returns resource waypoints ascending by distance, clamped to the route.
 * @param {import('./gpx.js').RouteContext} route
 * @returns {import('./gpx.js').Waypoint[]}
 */
function resourceWaypoints(route) {
  const total = route.totalDistanceMiles ?? 0;
  return [...route.waypoints]
    .filter((w) => w.distanceFromStartMi >= -0.01 && w.distanceFromStartMi <= total + 0.01)
    .sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);
}

const round1 = (n) => Number(n.toFixed(1));

// ---------------------------------------------------------------------------
// 1. Water carry — dry stretches between reliable sources
// ---------------------------------------------------------------------------

/**
 * Computes the "dry stretches" along the route: each contiguous span between
 * one reliable water source and the next, including the run from the start to
 * the first source and from the last source to the finish.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {Partial<typeof PLAN_DEFAULTS>} [opts]
 * @returns {Array<{
 *   fromMi: number, fromName: string,
 *   toMi: number, toName: string,
 *   miles: number,
 *   recommendedOz: number,
 *   exceedsCapacity: boolean,
 * }>}
 */
export function computeWaterCarry(route, opts = {}) {
  const o = { ...PLAN_DEFAULTS, ...opts };
  const total = route.totalDistanceMiles ?? 0;
  const waypoints = resourceWaypoints(route);

  const excludedWater = new Set(o.excludedWaterIds);
  const forcedWater = new Set(o.forcedWaterIds);
  const excludedResupply = new Set(o.excludedResupplyIds);
  const forcedResupply = new Set(o.forcedResupplyIds);

  // Candidate water waypoints: reliable water OR forced water OR active resupplies,
  // excluding off-track stops (detour > 0.1 mi) unless explicitly forced.
  const candidates = waypoints.filter((wp) => {
    if (wp.type === 'water') {
      if (excludedWater.has(wp.id)) return false;
      const isOffTrack = (wp.offCourseDistanceMi || 0) > 0.1;
      if (isOffTrack && !forcedWater.has(wp.id)) return false;
      return isReliableWater(wp, o.reliableWaterThreshold) || forcedWater.has(wp.id);
    }
    if (wp.type === 'resupply') {
      if (excludedResupply.has(wp.id)) return false;
      const isOffTrack = (wp.offCourseDistanceMi || 0) > 0.1;
      if (isOffTrack && !forcedResupply.has(wp.id)) return false;
      return true;
    }
    return false;
  });

  let stops = [];
  if (o.optimizeWaterStops) {
    stops = optimizeWaterStops(route, candidates, o);
  } else {
    stops = candidates;
  }

  // Filter stops by detour distance, keeping forced stops
  const filteredStops = stops.filter((wp) => {
    const isForced = wp.type === 'water' ? forcedWater.has(wp.id) : forcedResupply.has(wp.id);
    return (wp.offCourseDistanceMi || 0) <= o.maxDetourMi || isForced;
  });

  // Loop to resolve water emergencies (stretches exceeding water capacity)
  const findEmergencyStretch = (activeStops) => {
    const anchors = [0, ...activeStops.map((s) => s.distanceFromStartMi), total];
    for (let i = 1; i < anchors.length; i++) {
      const dist = anchors[i] - anchors[i - 1];
      if (dist * o.ozPerMile > o.waterCapacityOz) {
        return { start: anchors[i - 1], end: anchors[i] };
      }
    }
    return null;
  };

  let emergency = findEmergencyStretch(filteredStops);
  const guard = 100;
  let iterations = 0;

  while (emergency && iterations < guard) {
    // If we have an emergency stretch, look for ANY valid water/resupply waypoint
    // that is within maxDetourMi (even if off-track > 0.1 mi) to resolve the capacity gap.
    const potentialHelpers = waypoints.filter((w) => {
      if (w.type !== 'water' && w.type !== 'resupply') return false;
      if (w.type === 'water' && excludedWater.has(w.id)) return false;
      if (w.type === 'resupply' && excludedResupply.has(w.id)) return false;

      const mi = w.distanceFromStartMi;
      const offCourse = w.offCourseDistanceMi || 0;
      const isValidHelper = offCourse <= o.maxDetourMi;

      // Keep only helpers that are not already active
      const isAlreadyActive = filteredStops.some((s) => s.id === w.id);

      return (
        isValidHelper && !isAlreadyActive && mi > emergency.start + 0.1 && mi < emergency.end - 0.1
      );
    });

    if (potentialHelpers.length === 0) {
      break;
    }

    const mid = (emergency.start + emergency.end) / 2;
    potentialHelpers.sort(
      (a, b) => Math.abs(a.distanceFromStartMi - mid) - Math.abs(b.distanceFromStartMi - mid),
    );

    filteredStops.push(potentialHelpers[0]);
    filteredStops.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

    emergency = findEmergencyStretch(filteredStops);
    iterations++;
  }

  stops = filteredStops;

  // Anchor points: Start, chosen water stops, Finish.
  const anchors = [{ mi: 0, name: 'Start' }];
  for (const wp of stops) {
    anchors.push({ mi: wp.distanceFromStartMi, name: wp.name || 'Water' });
  }
  anchors.push({ mi: total, name: 'Finish' });

  const stretches = [];
  for (let i = 1; i < anchors.length; i++) {
    const from = anchors[i - 1];
    const to = anchors[i];
    const miles = to.mi - from.mi;
    if (miles <= 0.05) continue; // skip duplicate / co-located anchors
    const recommendedOz = Math.ceil(miles * o.ozPerMile);
    stretches.push({
      fromMi: round1(from.mi),
      fromName: from.name,
      toMi: round1(to.mi),
      toName: to.name,
      miles: round1(miles),
      recommendedOz,
      exceedsCapacity: recommendedOz > o.waterCapacityOz,
    });
  }
  return stretches;
}

/**
 * Finds the optimal subset of water stops using a DAG shortest path algorithm.
 * Balances stop overhead (time) against the weight of carrying water.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {import('./gpx.js').Waypoint[]} candidates - filtered water waypoints
 * @param {typeof PLAN_DEFAULTS} o
 * @returns {import('./gpx.js').Waypoint[]} Optimal subset of water stops
 */
export function optimizeWaterStops(route, candidates, o) {
  const total = route.totalDistanceMiles ?? 0;
  const forcedWater = new Set(o.forcedWaterIds);

  // Nodes: Start (0), candidates (1..N), Finish (N+1)
  const nodes = [
    { mi: 0, name: 'Start', isWater: false, wp: null },
    ...candidates.map((wp) => ({
      mi: wp.distanceFromStartMi,
      name: wp.name,
      isWater: true,
      wp,
    })),
    { mi: total, name: 'Finish', isWater: false, wp: null },
  ];

  const n = nodes.length;
  const dp = new Array(n).fill(Number.POSITIVE_INFINITY);
  const parent = new Array(n).fill(-1);

  dp[0] = 0;

  for (let i = 0; i < n; i++) {
    if (dp[i] === Number.POSITIVE_INFINITY) continue;

    for (let j = i + 1; j < n; j++) {
      const dist = nodes[j].mi - nodes[i].mi;
      const waterNeededOz = dist * o.ozPerMile;

      // Constraint: Cannot exceed water capacity
      // Fallback: If the next immediate node is beyond capacity, we must allow it.
      if (waterNeededOz > o.waterCapacityOz && j > i + 1) {
        continue;
      }

      // Constraint: Cannot bypass any forced water stops!
      let bypassedForced = false;
      for (let k = i + 1; k < j; k++) {
        if (nodes[k].isWater && nodes[k].wp.type === 'water' && forcedWater.has(nodes[k].wp.id)) {
          bypassedForced = true;
          break;
        }
      }
      if (bypassedForced) {
        continue;
      }

      // Cost = dp[i] + stopCost + carryCost
      // Towns/stores/resupplies are fast to refill (tap/store) and we stop there anyway, so overhead is 2m.
      const isResupply = nodes[j].wp && nodes[j].wp.type === 'resupply';
      const stopCost = nodes[j].isWater ? (isResupply ? 2 : o.stopOverheadMinutes) : 0;
      // Average water carried * distance * weight penalty
      const carryCost = (waterNeededOz / 2) * dist * o.waterWeightPenalty;

      const totalCost = dp[i] + stopCost + carryCost;

      if (totalCost < dp[j]) {
        dp[j] = totalCost;
        parent[j] = i;
      }
    }
  }

  // Reconstruct path
  const path = [];
  let curr = n - 1;
  while (curr !== -1) {
    path.push(curr);
    curr = parent[curr];
  }
  path.reverse();

  // Extract water waypoints
  const chosen = [];
  for (const idx of path) {
    if (nodes[idx].isWater && nodes[idx].wp) {
      chosen.push(nodes[idx].wp);
    }
  }

  return chosen;
}

// ---------------------------------------------------------------------------
// 2. Food carry — spans between resupply points
// ---------------------------------------------------------------------------

/**
 * Computes food-carry spans: each contiguous span between resupply points
 * (Start → first resupply → … → Finish). `days` estimates how many riding
 * days of food the span demands at the target daily mileage.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {Partial<typeof PLAN_DEFAULTS>} [opts]
 * @returns {Array<{
 *   fromMi: number, fromName: string,
 *   toMi: number, toName: string,
 *   miles: number, days: number,
 * }>}
 */
export function computeFoodCarry(route, opts = {}) {
  const o = { ...PLAN_DEFAULTS, ...opts };
  const total = route.totalDistanceMiles ?? 0;
  const waypoints = resourceWaypoints(route);
  const excludedResupply = new Set(o.excludedResupplyIds);
  const forcedResupply = new Set(o.forcedResupplyIds);

  // 1. Initial list of candidates
  const candidates = waypoints.filter(
    (wp) => wp.type === 'resupply' && !excludedResupply.has(wp.id),
  );

  // 2. Active resupplies: only include on-track resupplies (detour <= 0.1 mi) by default, or forced ones!
  const activeResupplies = candidates.filter(
    (w) => (w.offCourseDistanceMi || 0) <= 0.1 || forcedResupply.has(w.id),
  );

  // Loop to resolve resupply emergencies (distance between resupplies > 3 days of riding)
  const maxFoodCarryMiles = o.targetDailyMiles * 3;
  const findFoodEmergency = (activeStops) => {
    const milesList = [0, ...activeStops.map((s) => s.distanceFromStartMi), total];
    for (let i = 1; i < milesList.length; i++) {
      const dist = milesList[i] - milesList[i - 1];
      if (dist > maxFoodCarryMiles) {
        return { start: milesList[i - 1], end: milesList[i] };
      }
    }
    return null;
  };

  let emergency = findFoodEmergency(activeResupplies);
  const guard = 100;
  let iterations = 0;

  while (emergency && iterations < guard) {
    const potentialHelpers = candidates.filter((w) => {
      const mi = w.distanceFromStartMi;
      const isWithinDetour = (w.offCourseDistanceMi || 0) <= o.maxDetourMi;
      return isWithinDetour && mi > emergency.start + 1.0 && mi < emergency.end - 1.0;
    });

    if (potentialHelpers.length === 0) {
      break;
    }

    const mid = (emergency.start + emergency.end) / 2;
    potentialHelpers.sort(
      (a, b) => Math.abs(a.distanceFromStartMi - mid) - Math.abs(b.distanceFromStartMi - mid),
    );

    activeResupplies.push(potentialHelpers[0]);
    activeResupplies.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

    emergency = findFoodEmergency(activeResupplies);
    iterations++;
  }

  const anchors = [{ mi: 0, name: 'Start' }];
  for (const wp of activeResupplies) {
    anchors.push({ mi: wp.distanceFromStartMi, name: wp.name || 'Resupply' });
  }
  anchors.push({ mi: total, name: 'Finish' });

  const spans = [];
  for (let i = 1; i < anchors.length; i++) {
    const from = anchors[i - 1];
    const to = anchors[i];
    const miles = to.mi - from.mi;
    if (miles <= 0.05) continue;

    const daysFloat = miles / o.targetDailyMiles;
    const totalCalories = Math.round(daysFloat * o.caloriesPerDay);

    const campMeals = Math.round(daysFloat * o.campMealsPerDay);
    const campMealCalories = campMeals * o.caloriesPerCampMeal;

    const snackCalories = Math.max(0, totalCalories - campMealCalories);
    const snacks = Math.round(snackCalories / o.avgSnackCalories);
    const weightOz = Math.round(totalCalories / 110);

    spans.push({
      fromMi: round1(from.mi),
      fromName: from.name,
      toMi: round1(to.mi),
      toName: to.name,
      miles: round1(miles),
      days: Math.max(1, Math.ceil(miles / o.targetDailyMiles)),
      daysFloat: round1(daysFloat),
      calories: totalCalories,
      campMeals,
      snacks,
      weightOz,
    });
  }
  return spans;
}

// ---------------------------------------------------------------------------
// 3. Day plan — multi-day segments with short/medium/long camp options
// ---------------------------------------------------------------------------

/**
 * Picks the camp nearest a target mile from a list of candidate camps that lie
 * ahead of `afterMi`. Returns null if none qualify.
 * @param {import('./gpx.js').Waypoint[]} camps
 * @param {number} afterMi
 * @param {number} targetMi
 * @param {number} windowLo  - absolute lower bound (miles)
 * @param {number} windowHi  - absolute upper bound (miles)
 * @returns {import('./gpx.js').Waypoint | null}
 */
function pickCampNear(camps, afterMi, targetMi, windowLo, windowHi) {
  let best = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const c of camps) {
    const mi = c.distanceFromStartMi;
    if (mi <= afterMi + 0.05) continue;
    if (mi < windowLo || mi > windowHi) continue;
    const delta = Math.abs(mi - targetMi);
    if (delta < bestDelta) {
      best = c;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * Builds a multi-day plan. For each day it offers up to three camp options —
 * short (~75% of target), medium (~target), and long (~125% of target) — drawn
 * from camp waypoints within the day-length window. The chain advances on the
 * medium option (falling back to long, then short, then the route finish).
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {Partial<typeof PLAN_DEFAULTS>} [opts]
 * @returns {Array<{
 *   day: number,
 *   startMi: number,
 *   options: { short: DayOption|null, medium: DayOption|null, long: DayOption|null },
 *   chosen: DayOption,
 * }>}
 *
 * @typedef {Object} DayOption
 * @property {string} campName
 * @property {number} endMi
 * @property {number} miles
 * @property {number|null} nextWaterMi   - miles from camp to next reliable water
 * @property {number|null} nextFoodMi    - miles from camp to next resupply
 * @property {boolean} isFinish
 */
export function buildDayPlan(route, opts = {}) {
  const o = { ...PLAN_DEFAULTS, ...opts };
  const total = route.totalDistanceMiles ?? 0;
  const waypoints = resourceWaypoints(route);
  const excludedCamps = new Set(o.excludedCampIds);
  const camps = waypoints.filter((w) => w.type === 'camping' && !excludedCamps.has(w.id));

  const nextWaterFrom = (mi) => {
    for (const w of waypoints) {
      if (w.distanceFromStartMi > mi + 0.05 && isReliableWater(w, o.reliableWaterThreshold)) {
        return {
          miles: round1(w.distanceFromStartMi - mi),
          name: w.name || 'Water Source',
        };
      }
    }
    return null;
  };
  const nextFoodFrom = (mi) => {
    for (const w of waypoints) {
      if (w.distanceFromStartMi > mi + 0.05 && w.type === 'resupply') {
        return {
          miles: round1(w.distanceFromStartMi - mi),
          name: w.name || 'Resupply',
        };
      }
    }
    return null;
  };

  const makeOption = (camp, startMi) => {
    const endMi = camp.distanceFromStartMi;
    const waterInfo = nextWaterFrom(endMi);
    const foodInfo = nextFoodFrom(endMi);
    return {
      campId: camp.id,
      campName: camp.name || 'Camp',
      endMi: round1(endMi),
      miles: round1(endMi - startMi),
      nextWaterMi: waterInfo ? waterInfo.miles : null,
      nextWaterName: waterInfo ? waterInfo.name : null,
      nextFoodMi: foodInfo ? foodInfo.miles : null,
      nextFoodName: foodInfo ? foodInfo.name : null,
      isFinish: false,
    };
  };

  const finishOption = (startMi) => ({
    campId: 'finish',
    campName: 'Finish',
    endMi: round1(total),
    miles: round1(total - startMi),
    nextWaterMi: null,
    nextWaterName: null,
    nextFoodMi: null,
    nextFoodName: null,
    isFinish: true,
  });

  const days = [];
  let startMi = 0;
  let dayNum = 1;
  const guard = 200; // hard stop against pathological inputs

  while (startMi < total - 0.5 && dayNum <= guard) {
    const windowLo = startMi + o.targetDailyMiles * o.dayMinFactor;
    const windowHi = startMi + o.targetDailyMiles * o.dayMaxFactor;

    // If the finish is reachable within (or before) a full day, end here.
    if (total <= windowHi) {
      const opt = finishOption(startMi);
      days.push({
        day: dayNum,
        startMi: round1(startMi),
        options: { short: null, medium: opt, long: null },
        chosen: opt,
      });
      break;
    }

    const medCamp = pickCampNear(camps, startMi, startMi + o.targetDailyMiles, windowLo, windowHi);
    const shortCamp = pickCampNear(
      camps,
      startMi,
      startMi + o.targetDailyMiles * 0.75,
      windowLo,
      startMi + o.targetDailyMiles,
    );
    const longCamp = pickCampNear(
      camps,
      startMi,
      startMi + o.targetDailyMiles * 1.25,
      startMi + o.targetDailyMiles,
      windowHi,
    );

    let short = shortCamp ? makeOption(shortCamp, startMi) : null;
    let medium = medCamp ? makeOption(medCamp, startMi) : null;
    let long = longCamp ? makeOption(longCamp, startMi) : null;

    if (!short) {
      const targetShort = startMi + o.targetDailyMiles * 0.75;
      const waterInfo = nextWaterFrom(targetShort);
      const foodInfo = nextFoodFrom(targetShort);
      short = {
        campId: `synth-camp-${dayNum}-short`,
        campName: 'Wilderness Camp',
        endMi: round1(targetShort),
        miles: round1(o.targetDailyMiles * 0.75),
        nextWaterMi: waterInfo ? waterInfo.miles : null,
        nextWaterName: waterInfo ? waterInfo.name : null,
        nextFoodMi: foodInfo ? foodInfo.miles : null,
        nextFoodName: foodInfo ? foodInfo.name : null,
        isFinish: false,
      };
    }
    if (!medium) {
      const targetMed = startMi + o.targetDailyMiles;
      const waterInfo = nextWaterFrom(targetMed);
      const foodInfo = nextFoodFrom(targetMed);
      medium = {
        campId: `synth-camp-${dayNum}-med`,
        campName: 'Wilderness Camp',
        endMi: round1(targetMed),
        miles: round1(o.targetDailyMiles),
        nextWaterMi: waterInfo ? waterInfo.miles : null,
        nextWaterName: waterInfo ? waterInfo.name : null,
        nextFoodMi: foodInfo ? foodInfo.miles : null,
        nextFoodName: foodInfo ? foodInfo.name : null,
        isFinish: false,
      };
    }
    if (!long) {
      const targetLong = startMi + o.targetDailyMiles * 1.25;
      const waterInfo = nextWaterFrom(targetLong);
      const foodInfo = nextFoodFrom(targetLong);
      long = {
        campId: `synth-camp-${dayNum}-long`,
        campName: 'Wilderness Camp',
        endMi: round1(targetLong),
        miles: round1(o.targetDailyMiles * 1.25),
        nextWaterMi: waterInfo ? waterInfo.miles : null,
        nextWaterName: waterInfo ? waterInfo.name : null,
        nextFoodMi: foodInfo ? foodInfo.miles : null,
        nextFoodName: foodInfo ? foodInfo.name : null,
        isFinish: false,
      };
    }

    let chosen = medium;
    if (short && o.forcedCampIds.includes(short.campId)) {
      chosen = short;
    } else if (medium && o.forcedCampIds.includes(medium.campId)) {
      chosen = medium;
    } else if (long && o.forcedCampIds.includes(long.campId)) {
      chosen = long;
    } else if (medCamp && o.forcedCampIds.includes(medCamp.id)) {
      chosen = medium;
    } else if (shortCamp && o.forcedCampIds.includes(shortCamp.id)) {
      chosen = short;
    } else if (longCamp && o.forcedCampIds.includes(longCamp.id)) {
      chosen = long;
    }

    days.push({
      day: dayNum,
      startMi: round1(startMi),
      options: { short, medium, long },
      chosen,
    });
    startMi = chosen.endMi;
    dayNum += 1;
  }

  return days;
}

// ---------------------------------------------------------------------------
// Convenience: full plan bundle
// ---------------------------------------------------------------------------

/**
 * Computes the complete plan (water carry, food carry, day plan) in one call.
 * @param {import('./gpx.js').RouteContext} route
 * @param {Partial<typeof PLAN_DEFAULTS>} [opts]
 */
export function buildPlan(route, opts = {}) {
  const o = { ...PLAN_DEFAULTS, ...opts };
  return {
    options: o,
    waterCarry: computeWaterCarry(route, o),
    foodCarry: computeFoodCarry(route, o),
    dayPlan: buildDayPlan(route, o),
  };
}
