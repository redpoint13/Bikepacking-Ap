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
import { getCoordinatesAtMile, calculateElevation } from './gpx.js';
import { inferResupplyCategory } from './enrichment.js';
import { calculateSegmentDifficulty } from './difficulty.js';

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
  optimizeWaterStops: true,
  /** Target distance between water refill stops (miles). Default 20 mi. */
  targetWaterIntervalMi: 20,
  /** Water safety reserve margin (% of total capacity to retain). */
  waterSafetyMarginPercent: 20,
  /** Water needed for camp chores, dinner, overnight & morning (oz). */
  campWaterReserveOz: 40,
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
  /** User manual stop states map: waypointId -> 'planned' | 'optional' | 'skipped' */
  userStopStates: {},
  /** Per-day selected camp option: dayNum -> 'short' | 'medium' | 'long' | campId */
  dayCampSelections: {},
  /** Target mileage range for Short ride day. */
  shortDayRange: { min: 20, max: 35 },
  /** Target mileage range for Medium ride day. */
  mediumDayRange: { min: 36, max: 55 },
  /** Target mileage range for Long ride day. */
  longDayRange: { min: 56, max: 85 },
  /** Global day pace target: 'short' | 'medium' | 'long' */
  dayPacePreset: 'medium',
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

/**
 * Merges userStopStates into the specific excluded/forced arrays.
 * @param {typeof PLAN_DEFAULTS} opts
 * @param {import('./gpx.js').Waypoint[]} waypoints
 * @returns {typeof PLAN_DEFAULTS}
 */
export function resolveOptions(opts, waypoints = []) {
  const o = { ...PLAN_DEFAULTS, ...opts };
  if (!o.userStopStates) return o;

  const excludedWater = new Set(o.excludedWaterIds || []);
  const forcedWater = new Set(o.forcedWaterIds || []);
  const excludedResupply = new Set(o.excludedResupplyIds || []);
  const forcedResupply = new Set(o.forcedResupplyIds || []);
  const excludedCamp = new Set(o.excludedCampIds || []);
  const forcedCamp = new Set(o.forcedCampIds || []);

  for (const [id, state] of Object.entries(o.userStopStates)) {
    const wp = waypoints.find((w) => w.id === id);
    const type = wp?.type;

    if (state === 'skipped') {
      if (type === 'water') excludedWater.add(id);
      else if (type === 'resupply') excludedResupply.add(id);
      else if (type === 'camping') excludedCamp.add(id);
    } else if (state === 'planned') {
      if (type === 'water') forcedWater.add(id);
      else if (type === 'resupply') forcedResupply.add(id);
      else if (type === 'camping') forcedCamp.add(id);
    }
  }

  return {
    ...o,
    excludedWaterIds: Array.from(excludedWater),
    forcedWaterIds: Array.from(forcedWater),
    excludedResupplyIds: Array.from(excludedResupply),
    forcedResupplyIds: Array.from(forcedResupply),
    excludedCampIds: Array.from(excludedCamp),
    forcedCampIds: Array.from(forcedCamp),
  };
}

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

/**
 * Calculates estimated water consumption (in ounces) for a route stretch,
 * adjusting for distance, elevation climbing gain, and terrain surface factor.
 *
 * Base consumption is scaled up during steep climbing sections because climbing
 * significantly increases metabolic heat and sweat rate.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {number} fromMi
 * @param {number} toMi
 * @param {Partial<typeof PLAN_DEFAULTS>} [opts]
 * @returns {number}
 */
export function computeWaterDemand(route, fromMi, toMi, opts = {}) {
  const baseOzPerMile = opts.ozPerMile ?? PLAN_DEFAULTS.ozPerMile;
  const miles = Math.max(0, toMi - fromMi);
  if (miles <= 0.01) return 0;

  let gainFt = 0;
  if (route?.trackPoints && route.trackPoints.length >= 2) {
    try {
      const diff = calculateSegmentDifficulty(route.trackPoints, fromMi, toMi, {
        surfaceFactor: opts.surfaceFactor ?? 1.2,
      });
      gainFt = diff?.gainFt || 0;
    } catch {
      gainFt = 0;
    }
  }

  // Each 1,000 ft of climbing adds effort equivalent to ~0.6x base consumption per 1k ft
  const climbExtraOz = (gainFt / 1000) * (baseOzPerMile * 0.6);
  const surfaceMultiplier = opts.surfaceFactor ? opts.surfaceFactor / 1.2 : 1.0;

  const totalOz = (miles * baseOzPerMile + climbExtraOz) * surfaceMultiplier;
  return Math.ceil(totalOz);
}

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
 *   isCampRefill?: boolean,
 * }>}
 */
export function computeWaterCarry(route, opts = {}) {
  const o = resolveOptions(opts, resourceWaypoints(route));
  const total = route.totalDistanceMiles ?? 0;
  const waypoints = resourceWaypoints(route);

  const excludedWater = new Set(o.excludedWaterIds);
  const forcedWater = new Set(o.forcedWaterIds);
  const excludedResupply = new Set(o.excludedResupplyIds);
  const forcedResupply = new Set(o.forcedResupplyIds);

  // Candidate water waypoints: reliable water OR forced water OR active resupplies,
  // excluding off-track stops (detour > 0.25 mi) unless explicitly forced.
  const candidates = waypoints.filter((wp) => {
    if (wp.type === 'water') {
      if (excludedWater.has(wp.id)) return false;
      const isOffTrack = (wp.offCourseDistanceMi || 0) > 0.25;
      if (isOffTrack && !forcedWater.has(wp.id)) return false;
      return isReliableWater(wp, o.reliableWaterThreshold) || forcedWater.has(wp.id);
    }
    if (wp.type === 'resupply') {
      if (excludedResupply.has(wp.id)) return false;
      const isOffTrack = (wp.offCourseDistanceMi || 0) > 0.25;
      if (isOffTrack && !forcedResupply.has(wp.id)) return false;
      return true;
    }
    return false;
  });

  // Extract planned camp locations if available
  const campWaypoints = [];
  if (o.dayPlan) {
    for (const d of o.dayPlan) {
      if (d.chosen?.endMi != null && !d.chosen.isFinish) {
        campWaypoints.push({
          mi: d.chosen.endMi,
          name: d.chosen.campName,
          campId: d.chosen.campId,
        });
      }
    }
  } else if (o.dayCampSelections) {
    const camps = waypoints.filter((w) => w.type === 'camping');
    for (const c of camps) {
      campWaypoints.push({ mi: c.distanceFromStartMi, name: c.name, campId: c.id });
    }
  }

  let stops = [];
  if (o.optimizeWaterStops) {
    stops = optimizeWaterStops(route, candidates, o, campWaypoints);
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
      const demand = computeWaterDemand(route, anchors[i - 1], anchors[i], o);
      if (demand > o.waterCapacityOz) {
        return { start: anchors[i - 1], end: anchors[i] };
      }
    }
    return null;
  };

  let emergency = findEmergencyStretch(filteredStops);
  const guard = 100;
  let iterations = 0;

  while (emergency && iterations < guard) {
    // If there's an emergency, find the best intermediate water source
    // that is within maxDetourMi (even if off-track > 0.25 mi) to resolve the capacity gap.
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

    let recommendedOz = computeWaterDemand(route, from.mi, to.mi, o);

    // Check if this stretch ends at a dry campsite
    const isCampRefill = campWaypoints.some(
      (c) =>
        Math.abs(c.mi - to.mi) < 0.5 &&
        !stops.some(
          (s) => Math.abs(s.distanceFromStartMi - c.mi) < 0.1 && (s.reliability ?? 0) >= 50,
        ),
    );

    if (isCampRefill) {
      recommendedOz += o.campWaterReserveOz ?? 40;
    }

    stretches.push({
      fromMi: round1(from.mi),
      fromName: from.name,
      toMi: round1(to.mi),
      toName: to.name,
      miles: round1(miles),
      recommendedOz,
      exceedsCapacity: recommendedOz > o.waterCapacityOz,
      isCampRefill,
    });
  }
  return stretches;
}

/**
 * Finds the optimal subset of water stops along the route.
 * Targets refilling every ~20 miles (configurable via targetWaterIntervalMi),
 * skips unnecessary intermediate water sources when water level is safe,
 * prioritizes high-reliability / low-detour sources, ensures camp water readiness,
 * and handles forced/excluded stop overrides.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {import('./gpx.js').Waypoint[]} candidates - filtered water & resupply waypoints
 * @param {typeof PLAN_DEFAULTS} o
 * @param {Array<{ mi: number, name: string, campId?: string }>} [campStops=[]]
 * @returns {import('./gpx.js').Waypoint[]} Optimal subset of water stops
 */
export function optimizeWaterStops(route, candidates, o, campStops = []) {
  const total = route.totalDistanceMiles ?? 0;
  const forcedWater = new Set(o.forcedWaterIds || []);
  const forcedResupply = new Set(o.forcedResupplyIds || []);

  const targetInterval = o.targetWaterIntervalMi ?? 20;
  const capacity = o.waterCapacityOz ?? 100;
  const safetyPercent = o.waterSafetyMarginPercent ?? 20;
  const safeCapacity = capacity * (1 - safetyPercent / 100);

  // Nodes in order from Start (0) to Finish (total)
  const sortedCandidates = [...candidates].sort(
    (a, b) => a.distanceFromStartMi - b.distanceFromStartMi,
  );

  const chosen = [];
  let lastStopMi = 0;

  // Helper to test if a candidate is forced
  const isForced = (wp) =>
    wp.type === 'water' ? forcedWater.has(wp.id) : forcedResupply.has(wp.id);

  // Loop through route until we can safely reach the Finish
  let currentSearchIndex = 0;
  const maxLoops = sortedCandidates.length + 10;
  let loops = 0;

  while (loops++ < maxLoops) {
    // 1. Can we reach Finish from lastStopMi safely?
    const demandToFinish = computeWaterDemand(route, lastStopMi, total, o);
    const hasPendingForcedAhead = sortedCandidates.slice(currentSearchIndex).some(isForced);
    const hasPendingCampAhead = campStops.some((c) => c.mi > lastStopMi + 0.1 && c.mi <= total);

    // If finish is reachable without exceeding safe capacity AND no forced/camp stops exist ahead:
    if (demandToFinish <= safeCapacity && !hasPendingForcedAhead && !hasPendingCampAhead) {
      break;
    }

    // 2. Look at all upcoming candidates ahead of lastStopMi
    const upcoming = [];
    for (let i = currentSearchIndex; i < sortedCandidates.length; i++) {
      const wp = sortedCandidates[i];
      if (wp.distanceFromStartMi <= lastStopMi + 0.1) continue;

      const demand = computeWaterDemand(route, lastStopMi, wp.distanceFromStartMi, o);
      upcoming.push({ wp, index: i, demand, mi: wp.distanceFromStartMi });
    }

    if (upcoming.length === 0) {
      break;
    }

    // 3. Check for forced stops in immediate reach
    const forcedInReach = upcoming.filter((u) => isForced(u.wp) && u.demand <= capacity);
    if (forcedInReach.length > 0) {
      // Pick the earliest forced stop
      const pick = forcedInReach[0];
      chosen.push(pick.wp);
      lastStopMi = pick.mi;
      currentSearchIndex = pick.index + 1;
      continue;
    }

    // 4. Check for upcoming camp stop within reach
    const nextCamp = campStops.find(
      (c) => c.mi > lastStopMi + 0.1 && c.mi <= lastStopMi + targetInterval * 1.4,
    );
    if (nextCamp) {
      const candidatesBeforeCamp = upcoming.filter(
        (u) => u.mi <= nextCamp.mi + 0.5 && u.demand <= capacity,
      );
      if (candidatesBeforeCamp.length > 0) {
        candidatesBeforeCamp.sort(
          (a, b) => Math.abs(a.mi - nextCamp.mi) - Math.abs(b.mi - nextCamp.mi),
        );
        const pick = candidatesBeforeCamp[0];
        chosen.push(pick.wp);
        lastStopMi = pick.mi;
        currentSearchIndex = pick.index + 1;
        continue;
      }
    }

    // 5. Evaluate all reachable candidates within capacity
    const reachable = upcoming.filter((u) => u.demand <= capacity);
    if (reachable.length === 0) {
      const pick = upcoming[0];
      chosen.push(pick.wp);
      lastStopMi = pick.mi;
      currentSearchIndex = pick.index + 1;
      continue;
    }

    const safeCandidates = reachable.filter((u) => u.demand <= safeCapacity);
    const candidatePool = safeCandidates.length > 0 ? safeCandidates : reachable;

    // Multi-factor scoring for candidate selection
    let bestPick = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const c of candidatePool) {
      const distFromLast = c.mi - lastStopMi;
      const targetDelta = Math.abs(distFromLast - targetInterval);

      // Base score: deviation from target interval
      let score = targetDelta * 2.0;

      // Heavy penalty for stopping too early (e.g. < 60% of target interval) unless it's the only safe option
      if (distFromLast < targetInterval * 0.6) {
        score += (targetInterval * 0.6 - distFromLast) * 5.0;
      }

      // Reliability bonus (higher reliability reduces penalty)
      const reliability = c.wp.reliability ?? 50;
      score -= (reliability - 50) * 0.1;

      // Detour penalty (miles off course)
      const offCourse = c.wp.offCourseDistanceMi || 0;
      score += offCourse * 12.0;

      // Resupply bonus (stores/towns provide easy guaranteed refill)
      if (c.wp.type === 'resupply') {
        score -= 4.0;
      }

      // Lookahead check: from candidate c, can we reach another water source or finish?
      const nextRemaining = sortedCandidates.filter((w) => w.distanceFromStartMi > c.mi + 0.1);
      if (nextRemaining.length > 0) {
        const nextDemand = computeWaterDemand(route, c.mi, nextRemaining[0].distanceFromStartMi, o);
        if (nextDemand > capacity) {
          score += 15.0;
        }
      }

      if (score < bestScore) {
        bestScore = score;
        bestPick = c;
      }
    }

    if (!bestPick) {
      bestPick = candidatePool[candidatePool.length - 1]; // furthest reachable fallback
    }

    chosen.push(bestPick.wp);
    lastStopMi = bestPick.mi;
    currentSearchIndex = bestPick.index + 1;
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
  const o = resolveOptions(opts, resourceWaypoints(route));
  const total = route.totalDistanceMiles ?? 0;
  const waypoints = resourceWaypoints(route);
  const excludedResupply = new Set(o.excludedResupplyIds);
  const forcedResupply = new Set(o.forcedResupplyIds);

  // 1. Initial list of candidates
  const candidates = waypoints.filter(
    (wp) => wp.type === 'resupply' && !excludedResupply.has(wp.id),
  );

  // 2. Active resupplies: only include on-track resupplies (detour <= 0.25 mi) by default, or forced ones!
  const activeResupplies = candidates.filter(
    (w) => (w.offCourseDistanceMi || 0) <= 0.25 || forcedResupply.has(w.id),
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

  const anchors = [{ mi: 0, name: 'Start', category: 'grocery' }];
  for (const wp of activeResupplies) {
    const cat =
      wp.resupplyCategory || inferResupplyCategory(wp.name, wp.description, wp.tags || {});
    anchors.push({ mi: wp.distanceFromStartMi, name: wp.name || 'Resupply', category: cat, wp });
  }
  anchors.push({ mi: total, name: 'Finish', category: 'none' });

  const categoryLabels = {
    grocery: 'Full Grocery',
    cstore: 'Gas Station / C-Store',
    restaurant: 'Restaurant / Diner',
    none: 'No Resupply',
  };

  const spans = [];
  for (let i = 1; i < anchors.length; i++) {
    const from = anchors[i - 1];
    const to = anchors[i];
    const miles = to.mi - from.mi;
    if (miles <= 0.05) continue;

    const daysFloat = miles / o.targetDailyMiles;
    const totalCalories = Math.round(daysFloat * o.caloriesPerDay);

    let campMeals = Math.round(daysFloat * o.campMealsPerDay);
    if (to.category === 'restaurant') {
      campMeals = Math.max(0, campMeals - 1);
    }

    const campMealCalories = campMeals * o.caloriesPerCampMeal;

    const snackCalories = Math.max(0, totalCalories - campMealCalories);
    const snacks = Math.round(snackCalories / o.avgSnackCalories);
    const weightOz = Math.round(totalCalories / 110);

    spans.push({
      fromMi: round1(from.mi),
      fromName: from.name,
      fromCategory: from.category,
      fromCategoryLabel: categoryLabels[from.category] || 'Resupply',
      toMi: round1(to.mi),
      toName: to.name,
      toCategory: to.category,
      toCategoryLabel: categoryLabels[to.category] || 'Resupply',
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
  const o = resolveOptions(opts, resourceWaypoints(route));
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

    const { gainFt, lossFt } = calculateElevation(route.trackPoints, startMi, endMi);
    const waterOptions = waypoints.filter(
      (w) =>
        w.type === 'water' &&
        w.distanceFromStartMi > startMi + 0.05 &&
        w.distanceFromStartMi <= endMi + 0.05 &&
        isReliableWater(w, o.reliableWaterThreshold),
    ).length;
    const resupplyOptions = waypoints.filter(
      (w) =>
        w.type === 'resupply' &&
        w.distanceFromStartMi > startMi + 0.05 &&
        w.distanceFromStartMi <= endMi + 0.05,
    ).length;
    const difficulty = calculateSegmentDifficulty(route.trackPoints, startMi, endMi, {
      surfaceFactor: o.surfaceFactor,
    });

    return {
      campId: camp.id,
      campName: camp.name || 'Camp',
      endMi: round1(endMi),
      miles: round1(endMi - startMi),
      nextWaterMi: waterInfo ? waterInfo.miles : null,
      nextWaterName: waterInfo ? waterInfo.name : null,
      nextFoodMi: foodInfo ? foodInfo.miles : null,
      nextFoodName: foodInfo ? foodInfo.name : null,
      eleGainFt: gainFt,
      eleLossFt: lossFt,
      waterOptions,
      resupplyOptions,
      difficulty,
      isFinish: false,
      waterAvailable: camp.waterAvailable || null,
      waterDetails: camp.waterDetails || '',
      fee: camp.fee || null,
      tier: camp.tier || null,
      landManager: camp.landManager || null,
    };
  };

  const finishOption = (startMi) => {
    const { gainFt, lossFt } = calculateElevation(route.trackPoints, startMi, total);
    const waterOptions = waypoints.filter(
      (w) =>
        w.type === 'water' &&
        w.distanceFromStartMi > startMi + 0.05 &&
        w.distanceFromStartMi <= total + 0.05 &&
        isReliableWater(w, o.reliableWaterThreshold),
    ).length;
    const resupplyOptions = waypoints.filter(
      (w) =>
        w.type === 'resupply' &&
        w.distanceFromStartMi > startMi + 0.05 &&
        w.distanceFromStartMi <= total + 0.05,
    ).length;
    const difficulty = calculateSegmentDifficulty(route.trackPoints, startMi, total, {
      surfaceFactor: o.surfaceFactor,
    });

    return {
      campId: 'finish',
      campName: 'Finish',
      endMi: round1(total),
      miles: round1(total - startMi),
      nextWaterMi: null,
      nextWaterName: null,
      nextFoodMi: null,
      nextFoodName: null,
      eleGainFt: gainFt,
      eleLossFt: lossFt,
      waterOptions,
      resupplyOptions,
      difficulty,
      isFinish: true,
    };
  };

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

    const makeSyntheticOption = (startMi, endMi, dayNum, tierLabel) => {
      const targetMi = Math.min(total, round1(endMi));
      const campId = `synth-camp-d${dayNum}-${tierLabel}`;
      const waterInfo = nextWaterFrom(targetMi);
      const foodInfo = nextFoodFrom(targetMi);
      const { gainFt, lossFt } = calculateElevation(route.trackPoints, startMi, targetMi);
      const waterOptions = waypoints.filter(
        (w) =>
          w.type === 'water' &&
          w.distanceFromStartMi > startMi + 0.05 &&
          w.distanceFromStartMi <= targetMi + 0.05 &&
          isReliableWater(w, o.reliableWaterThreshold),
      ).length;
      const resupplyOptions = waypoints.filter(
        (w) =>
          w.type === 'resupply' &&
          w.distanceFromStartMi > startMi + 0.05 &&
          w.distanceFromStartMi <= targetMi + 0.05,
      ).length;
      const difficulty = calculateSegmentDifficulty(route.trackPoints, startMi, targetMi, {
        surfaceFactor: o.surfaceFactor,
      });

      return {
        campId,
        campName: `Dispersed Camp (mi ${targetMi.toFixed(1)})`,
        endMi: targetMi,
        miles: round1(targetMi - startMi),
        nextWaterMi: waterInfo ? waterInfo.miles : null,
        nextWaterName: waterInfo ? waterInfo.name : null,
        nextFoodMi: foodInfo ? foodInfo.miles : null,
        nextFoodName: foodInfo ? foodInfo.name : null,
        eleGainFt: gainFt,
        eleLossFt: lossFt,
        waterOptions,
        resupplyOptions,
        difficulty,
        isFinish: targetMi >= total - 0.05,
      };
    };

    if (!short && !medium && !long) {
      // Find the camp closest to the target daily mileage to minimize stretching/shrinking the day
      let fallbackCamp = null;
      let minDelta = Infinity;
      const target = startMi + o.targetDailyMiles;
      const maxAllowedDelta = o.targetDailyMiles * 0.45; // Max ~15 miles off target daily miles

      for (const c of camps) {
        if (c.distanceFromStartMi > startMi + 0.05) {
          const delta = Math.abs(c.distanceFromStartMi - target);
          if (delta < minDelta) {
            minDelta = delta;
            fallbackCamp = c;
          }
        }
      }

      if (fallbackCamp && minDelta <= maxAllowedDelta) {
        medium = makeOption(fallbackCamp, startMi);
      } else {
        medium = makeSyntheticOption(startMi, startMi + o.targetDailyMiles, dayNum, 'med');
        short = makeSyntheticOption(startMi, startMi + o.targetDailyMiles * 0.75, dayNum, 'short');
        long = makeSyntheticOption(startMi, startMi + o.targetDailyMiles * 1.25, dayNum, 'long');
      }
    }

    const daySelection = o.dayCampSelections?.[dayNum] || o.dayPacePreset || 'medium';
    let chosen = null;

    if (daySelection === 'short' && short) chosen = short;
    else if (daySelection === 'long' && long) chosen = long;
    else if (daySelection === 'medium' && medium) chosen = medium;
    else if (short && (o.forcedCampIds.includes(short.campId) || daySelection === short.campId))
      chosen = short;
    else if (medium && (o.forcedCampIds.includes(medium.campId) || daySelection === medium.campId))
      chosen = medium;
    else if (long && (o.forcedCampIds.includes(long.campId) || daySelection === long.campId))
      chosen = long;
    else chosen = medium || short || long;

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
  const o = resolveOptions(opts, resourceWaypoints(route));
  const dayPlan = buildDayPlan(route, o);
  const waterCarry = computeWaterCarry(route, { ...o, dayPlan });
  const foodCarry = computeFoodCarry(route, o);
  return {
    options: o,
    waterCarry,
    foodCarry,
    dayPlan,
  };
}

/**
 * Computes the set of waypoint IDs that are currently active stops (water, resupply, camp).
 * @param {import('./gpx.js').RouteContext} route
 * @param {typeof PLAN_DEFAULTS} opts
 * @returns {Set<string>}
 */
export function getActiveStopIds(route, opts) {
  const activeIds = new Set();
  if (!route) return activeIds;

  const total = route.totalDistanceMiles ?? 0;
  const waypoints = [...route.waypoints].sort(
    (a, b) => a.distanceFromStartMi - b.distanceFromStartMi,
  );

  const excludedWater = new Set(opts.excludedWaterIds);
  const forcedWater = new Set(opts.forcedWaterIds);
  const excludedResupply = new Set(opts.excludedResupplyIds);
  const forcedResupply = new Set(opts.forcedResupplyIds);

  // 1. Camps chosen in day plan
  const campStops = [];
  const plan = buildPlan(route, opts);
  for (const d of plan.dayPlan) {
    if (d.chosen?.campId) {
      activeIds.add(d.chosen.campId);
      campStops.push({
        mi: d.chosen.endMi,
        name: d.chosen.campName,
        campId: d.chosen.campId,
      });
    }
  }

  // 2. Filter water candidates
  const waterWpts = waypoints.filter((w) => w.type === 'water');
  const waterCandidates = waterWpts.filter((wp) => {
    if (excludedWater.has(wp.id)) return false;
    const isOffTrack = (wp.offCourseDistanceMi || 0) > 0.25;
    if (isOffTrack && !forcedWater.has(wp.id)) return false;
    return (wp.reliability ?? 0) >= opts.reliableWaterThreshold || forcedWater.has(wp.id);
  });

  // Filter resupply candidates
  const resupplyWpts = waypoints.filter((w) => w.type === 'resupply');
  const activeResupplies = resupplyWpts.filter((w) => {
    if (excludedResupply.has(w.id)) return false;
    const isOffTrack = (w.offCourseDistanceMi || 0) > 0.25;
    if (isOffTrack && !forcedResupply.has(w.id)) return false;
    return true;
  });

  const waterStops = opts.optimizeWaterStops
    ? optimizeWaterStops(route, [...waterCandidates, ...activeResupplies], opts, campStops)
    : waterCandidates;

  // Filter water stops by detour
  const filteredWaterStops = waterStops.filter((wp) => {
    const isForced = wp.type === 'water' ? forcedWater.has(wp.id) : forcedResupply.has(wp.id);
    return (wp.offCourseDistanceMi || 0) <= opts.maxDetourMi || isForced;
  });

  // Resolve water emergencies
  const findEmergencyStretch = (activeStops) => {
    const anchors = [0, ...activeStops.map((s) => s.distanceFromStartMi), total];
    for (let i = 1; i < anchors.length; i++) {
      const demand = computeWaterDemand(route, anchors[i - 1], anchors[i], opts);
      if (demand > opts.waterCapacityOz) {
        return { start: anchors[i - 1], end: anchors[i] };
      }
    }
    return null;
  };

  let emergency = findEmergencyStretch(filteredWaterStops);
  const guard = 100;
  let iterations = 0;

  while (emergency && iterations < guard) {
    const potentialHelpers = waypoints.filter((w) => {
      if (w.type !== 'water' && w.type !== 'resupply') return false;
      if (w.type === 'water' && excludedWater.has(w.id)) return false;
      if (w.type === 'resupply' && excludedResupply.has(w.id)) return false;

      const mi = w.distanceFromStartMi;
      const offCourse = w.offCourseDistanceMi || 0;
      const isValidHelper = offCourse <= opts.maxDetourMi;

      const isAlreadyActive = filteredWaterStops.some((s) => s.id === w.id);

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

    filteredWaterStops.push(potentialHelpers[0]);
    filteredWaterStops.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

    emergency = findEmergencyStretch(filteredWaterStops);
    iterations++;
  }

  for (const wp of filteredWaterStops) {
    activeIds.add(wp.id);
  }

  // Food resupplies
  const activeResupplyStops = activeResupplies;

  // Resolve food emergencies
  const maxFoodCarryMiles = opts.targetDailyMiles * 3;
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

  let foodEmergency = findFoodEmergency(activeResupplyStops);
  let foodIterations = 0;

  while (foodEmergency && foodIterations < guard) {
    const potentialHelpers = resupplyWpts.filter((w) => {
      if (excludedResupply.has(w.id)) return false;
      const mi = w.distanceFromStartMi;
      const isWithinDetour = (w.offCourseDistanceMi || 0) <= opts.maxDetourMi;
      const isAlreadyActive = activeResupplyStops.some((s) => s.id === w.id);

      return (
        isWithinDetour &&
        !isAlreadyActive &&
        mi > foodEmergency.start + 1.0 &&
        mi < foodEmergency.end - 1.0
      );
    });

    if (potentialHelpers.length === 0) {
      break;
    }

    const mid = (foodEmergency.start + foodEmergency.end) / 2;
    potentialHelpers.sort(
      (a, b) => Math.abs(a.distanceFromStartMi - mid) - Math.abs(b.distanceFromStartMi - mid),
    );

    activeResupplyStops.push(potentialHelpers[0]);
    activeResupplyStops.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

    foodEmergency = findFoodEmergency(activeResupplyStops);
    foodIterations++;
  }

  for (const wp of activeResupplyStops) {
    activeIds.add(wp.id);
  }

  return activeIds;
}

/**
 * Returns waypoints with synthetic camp options included so they can be drawn on the map.
 * @param {import('./gpx.js').RouteContext} route
 * @param {typeof PLAN_DEFAULTS} opts
 * @returns {Array<object>}
 */
export function getWaypointsWithSyntheticCamps(route, opts) {
  if (!route) return [];
  // Strip any persistent synthetic waypoints from the base list
  const waypoints = (route.waypoints || []).filter(
    (w) => !w.id?.startsWith('synth-') && !w.isSynthetic,
  );

  const plan = buildPlan(route, opts);
  for (const d of plan.dayPlan) {
    const chosen = d.chosen;
    if (chosen?.campId?.startsWith('synth-camp-')) {
      if (waypoints.some((w) => w.id === chosen.campId)) continue;

      const pt = getCoordinatesAtMile(route.trackPoints, chosen.endMi);
      if (pt) {
        waypoints.push({
          id: chosen.campId,
          name: chosen.campName || `Day ${d.day} Dispersed Camp`,
          type: 'camping',
          lat: pt[0],
          lon: pt[1],
          distanceFromStartMi: chosen.endMi,
          description: `Wilderness dispersed camping option for Day ${d.day}.`,
          reliability: 100,
          isSynthetic: true,
          source: 'synthetic',
        });
      }
    }
  }
  return waypoints;
}
