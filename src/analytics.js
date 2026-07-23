/**
 * analytics.js — Segment Analytics engine for Bikepacker Navigator.
 *
 * Computes logistical, terrain, pacing, and resupply analytics for any route segment
 * (startMi to endMi), day plan, or waypoint-to-waypoint leg.
 *
 * @module analytics
 */

import { calculateElevation } from './gpx.js';
import { calculateSegmentDifficulty } from './difficulty.js';
import { buildPlan } from './plan.js';

/**
 * Format hours into a human readable duration (e.g., "4h 15m").
 * @param {number} hours
 * @returns {string}
 */
export function formatDuration(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return '0m';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Computes full analytics for a route segment between startMi and endMi.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {number} startMi
 * @param {number} endMi
 * @param {Object} [options={}]
 * @returns {Object} Segment analytics report
 */
export function computeSegmentAnalytics(route, startMi, endMi, options = {}) {
  const totalDist = route ? route.totalDistanceMiles : 0;
  const sMi = Math.max(0, Math.min(startMi, totalDist));
  const eMi = Math.max(sMi, Math.min(endMi, totalDist));
  const distanceMi = Number((eMi - sMi).toFixed(1));

  const surfaceFactor = options.surfaceFactor ?? 1.2;
  const paceMph = options.paceMovingAvgMph ?? 10;
  const ozPerMile = options.ozPerMile ?? 5;
  const caloriesPerDay = options.caloriesPerDay ?? 3500;
  const targetDailyMiles = options.targetDailyMiles ?? 45;
  const campMealsPerDay = options.campMealsPerDay ?? 1;

  // 1. Elevation & Terrain Difficulty
  const trackPoints = route ? route.trackPoints : [];
  const { gainFt, lossFt } = calculateElevation(trackPoints, sMi, eMi);
  const difficulty = calculateSegmentDifficulty(trackPoints, sMi, eMi, { surfaceFactor });

  // 2. Pacing & Time Estimates (Tobler/Naismith elevation penalty: +0.5 hr per 1000 ft climb)
  const baseMovingHours = distanceMi > 0 ? distanceMi / paceMph : 0;
  const elevationPenaltyHours = (gainFt / 1000) * 0.5;
  const estimatedMovingHours = Number((baseMovingHours + elevationPenaltyHours).toFixed(2));
  const estimatedElapsedHours = Number((estimatedMovingHours * 1.25).toFixed(2)); // +25% for stops/breaks

  // 3. Logistical Carry Math
  const waterNeededOz = Math.round(distanceMi * ozPerMile);
  const caloriesNeededKcal = Math.round((distanceMi / targetDailyMiles) * caloriesPerDay);
  const campMealsNeeded = Math.round((distanceMi / targetDailyMiles) * campMealsPerDay);

  // 4. Waypoints within segment
  const allWaypoints = route ? route.waypoints : [];
  const segmentWaypoints = allWaypoints.filter(
    (w) => w.distanceFromStartMi >= sMi - 0.05 && w.distanceFromStartMi <= eMi + 0.05,
  );

  const waterSources = segmentWaypoints.filter((w) => w.type === 'water');
  const resupplyPoints = segmentWaypoints.filter((w) => w.type === 'resupply');
  const campSpots = segmentWaypoints.filter((w) => w.type === 'camping');

  return {
    startMi: Number(sMi.toFixed(1)),
    endMi: Number(eMi.toFixed(1)),
    distanceMi,
    gainFt,
    lossFt,
    hillinessFtPerMi: difficulty.hillinessFtPerMi,
    difficulty,
    pacing: {
      paceMph,
      estimatedMovingHours,
      estimatedElapsedHours,
      formattedMovingTime: formatDuration(estimatedMovingHours),
      formattedElapsedTime: formatDuration(estimatedElapsedHours),
    },
    logistics: {
      waterNeededOz,
      waterNeededLiters: Number((waterNeededOz / 33.814).toFixed(1)),
      caloriesNeededKcal,
      campMealsNeeded,
    },
    waypoints: {
      all: segmentWaypoints,
      waterSources,
      resupplyPoints,
      campSpots,
    },
  };
}

/**
 * Builds analytics for each day in a day plan, including sub-leg analytics.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {Object} [options={}]
 * @returns {Array<Object>} Array of day segment analytics
 */
export function buildDaySegmentAnalytics(route, options = {}) {
  if (!route) return [];
  const plan = buildPlan(route, options);
  const dayPlan = plan.dayPlan || [];

  return dayPlan.map((day) => {
    const dayStartMi = day.startMi;
    const dayEndMi = day.chosen ? day.chosen.endMi : dayStartMi;
    const dayAnalytics = computeSegmentAnalytics(route, dayStartMi, dayEndMi, options);

    // Find key stopping waypoints on this day to build sub-leg analytics
    const keyWaypoints = route.waypoints.filter(
      (w) =>
        w.distanceFromStartMi > dayStartMi + 0.05 &&
        w.distanceFromStartMi < dayEndMi - 0.05 &&
        (w.type === 'resupply' || w.type === 'water' || w.type === 'camping'),
    );

    // Form sequence of leg boundaries: dayStart -> keyWaypoints -> dayEnd
    const legPoints = [
      { name: `Day ${day.day} Start`, mile: dayStartMi },
      ...keyWaypoints.map((w) => ({ name: w.name, mile: w.distanceFromStartMi, type: w.type })),
      { name: day.chosen ? day.chosen.campName : 'Day End', mile: dayEndMi },
    ];

    const legs = [];
    for (let i = 0; i < legPoints.length - 1; i++) {
      const from = legPoints[i];
      const to = legPoints[i + 1];
      if (to.mile - from.mile > 0.1) {
        const legAnalytics = computeSegmentAnalytics(route, from.mile, to.mile, options);
        legs.push({
          fromName: from.name,
          toName: to.name,
          startMi: from.mile,
          endMi: to.mile,
          analytics: legAnalytics,
        });
      }
    }

    return {
      day: day.day,
      chosenCamp: day.chosen ? day.chosen.campName : 'Camp',
      analytics: dayAnalytics,
      legs,
    };
  });
}
