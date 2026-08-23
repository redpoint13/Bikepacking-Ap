/**
 * difficulty.js — Bikepacking Trail Difficulty Score & Hike-a-Bike Predictor.
 *
 * Evaluates route terrain difficulty and predicts Hike-a-Bike (HAB) sections based on
 * elevation density (ft/mi), gradient analysis (≥15% threshold), and surface friction factors.
 *
 * @module difficulty
 */

import { getTrackSegmentForMiles, haversineDistance } from './gpx.js';

/** Surface friction factors for effort multiplier */
export const SURFACE_FACTORS = {
  PAVED: { id: 'paved', label: 'Paved Road', factor: 1.0 },
  GRAVEL: { id: 'gravel', label: 'Gravel / Dirt Road', factor: 1.2 },
  SINGLETRACK: { id: 'singletrack', label: 'Technical Singletrack', factor: 1.6 },
  ROUGH: { id: 'rough', label: 'Rough / Loose Sand / Rock', factor: 2.0 },
};

/**
 * Calculates difficulty score and predicts Hike-a-Bike sections for a route segment.
 *
 * @param {Array<[number, number, number]>} trackPoints - [lat, lon, eleMeters]
 * @param {number} [startMi=0]
 * @param {number} [endMi=null]
 * @param {Object} [opts={}]
 * @param {number} [opts.surfaceFactor=1.2] - Surface friction multiplier
 * @param {number} [opts.habGradeThreshold=15] - Min gradient % to flag Hike-a-Bike
 * @returns {{
 *   distanceMi: number,
 *   gainFt: number,
 *   lossFt: number,
 *   hillinessFtPerMi: number,
 *   avgClimbGradePct: number,
 *   maxGradePct: number,
 *   difficultyScore: number,
 *   difficultyRating: { label: string, cls: string, badge: string },
 *   hikeABike: {
 *     distanceMi: number,
 *     percent: number,
 *     pitchCount: number,
 *     severity: 'None' | 'Occasional' | 'Frequent' | 'Severe',
 *   }
 * }}
 */
export function calculateSegmentDifficulty(trackPoints, startMi = 0, endMi = null, opts = {}) {
  const surfaceFactor = opts.surfaceFactor ?? 1.2;
  const habGradeThreshold = opts.habGradeThreshold ?? 15;

  const segment = getTrackSegmentForMiles(trackPoints, startMi, endMi ?? Number.POSITIVE_INFINITY);

  if (!segment || segment.length < 2) {
    return {
      distanceMi: 0,
      gainFt: 0,
      lossFt: 0,
      hillinessFtPerMi: 0,
      avgClimbGradePct: 0,
      maxGradePct: 0,
      difficultyScore: 0,
      difficultyRating: { label: 'Easy', cls: 'easy', badge: '🟢 Easy' },
      hikeABike: { distanceMi: 0, percent: 0, pitchCount: 0, severity: 'None' },
    };
  }

  // 1. Calculate distances and elevation profile using rolling window to smooth noise
  let totalDistanceMiles = 0;
  let gainMeters = 0;
  let lossMeters = 0;
  let _climbingDistanceMiles = 0;
  let totalClimbGradeSum = 0;
  let climbSampleCount = 0;
  let maxGradePct = 0;

  let habDistanceMiles = 0;
  let inHabPitch = false;
  let habPitchCount = 0;

  // Window size of ~40-50m for gradient calculation
  const WINDOW = Math.max(1, Math.min(5, Math.floor(segment.length / 10)));

  for (let i = WINDOW; i < segment.length; i += WINDOW) {
    const p1 = segment[i - WINDOW];
    const p2 = segment[i];

    const dMi = haversineDistance(p1[0], p1[1], p2[0], p2[1]);
    if (dMi <= 0.001) continue;

    totalDistanceMiles += dMi;
    const eleDiffM = (p2[2] || 0) - (p1[2] || 0);

    if (eleDiffM > 0) gainMeters += eleDiffM;
    else lossMeters -= eleDiffM;

    // Grade % = (rise_in_feet / run_in_feet) * 100
    const dFeet = dMi * 5280;
    const eleDiffFeet = eleDiffM * 3.28084;
    const gradePct = (eleDiffFeet / dFeet) * 100;

    if (gradePct > maxGradePct) {
      maxGradePct = Math.min(45, Math.round(gradePct)); // clamp unreasonable GPS spikes
    }

    if (gradePct > 1) {
      _climbingDistanceMiles += dMi;
      totalClimbGradeSum += gradePct;
      climbSampleCount++;
    }

    // Hike-a-bike detection
    if (gradePct >= habGradeThreshold) {
      habDistanceMiles += dMi;
      if (!inHabPitch) {
        inHabPitch = true;
        habPitchCount++;
      }
    } else {
      inHabPitch = false;
    }
  }

  const gainFt = Math.round(gainMeters * 3.28084);
  const lossFt = Math.round(lossMeters * 3.28084);
  const distMi = Number(totalDistanceMiles.toFixed(1));
  const hillinessFtPerMi = distMi > 0 ? Math.round(gainFt / distMi) : 0;
  const avgClimbGradePct =
    climbSampleCount > 0 ? Number((totalClimbGradeSum / climbSampleCount).toFixed(1)) : 0;

  // 2. Compute Difficulty Score
  // D = (Distance * surfaceFactor) + (Gain / 500) * (1 + 0.05 * avgClimbGradePct)
  const scoreRaw = distMi * surfaceFactor + (gainFt / 500) * (1 + 0.05 * avgClimbGradePct);
  const difficultyScore = Number(scoreRaw.toFixed(1));

  let difficultyRating = { label: 'Easy', cls: 'easy', badge: '🟢 Easy' };
  if (difficultyScore >= 50) {
    difficultyRating = { label: 'Severe', cls: 'severe', badge: '⬛ Severe' };
  } else if (difficultyScore >= 30) {
    difficultyRating = { label: 'Hard', cls: 'hard', badge: '🔴 Hard' };
  } else if (difficultyScore >= 15) {
    difficultyRating = { label: 'Moderate', cls: 'moderate', badge: '🔵 Moderate' };
  }

  // 3. Hike-a-bike summary
  const habMiles = Number(habDistanceMiles.toFixed(1));
  const habPercent = distMi > 0 ? Math.round((habMiles / distMi) * 100) : 0;

  let habSeverity = 'None';
  if (habPercent >= 10) habSeverity = 'Severe';
  else if (habPercent >= 4) habSeverity = 'Frequent';
  else if (habPercent > 0 || habMiles > 0) habSeverity = 'Occasional';

  return {
    distanceMi: distMi,
    gainFt,
    lossFt,
    hillinessFtPerMi,
    avgClimbGradePct,
    maxGradePct,
    difficultyScore,
    difficultyRating,
    hikeABike: {
      distanceMi: habMiles,
      percent: habPercent,
      pitchCount: habPitchCount,
      severity: habSeverity,
    },
  };
}

/**
 * Calculates difficulty & Hike-a-Bike for full route.
 * @param {import('./gpx.js').RouteContext} route
 * @param {Object} [opts]
 */
export function calculateRouteDifficulty(route, opts = {}) {
  if (!route || !route.trackPoints) return null;
  return calculateSegmentDifficulty(route.trackPoints, 0, route.totalDistanceMiles, opts);
}
