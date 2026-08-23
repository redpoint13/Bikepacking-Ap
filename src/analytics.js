/**
 * analytics.js — Segment Analytics engine for Bikepacker Navigator.
 *
 * Computes logistical, terrain, pacing, and resupply analytics for any route segment
 * (startMi to endMi), day plan, or waypoint-to-waypoint leg.
 *
 * @module analytics
 */

import { calculateSegmentDifficulty } from './difficulty.js';
import { calculateElevation } from './gpx.js';
import { buildPlan, getActiveStopIds } from './plan.js';

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

  // 3. Logistical Requirements (Water & Calorie budgeting)
  const waterNeededOz = Math.round(distanceMi * ozPerMile);
  const waterNeededLiters = Number((waterNeededOz * 0.0295735).toFixed(1));

  // Calories: proportion of daily target + elevation metabolic cost (~100 kcal per 1000 ft climbing)
  const baseCalories = (distanceMi / targetDailyMiles) * caloriesPerDay;
  const climbCalories = (gainFt / 1000) * 100;
  const caloriesNeededKcal = Math.round(baseCalories + climbCalories);
  const campMealsNeeded = Math.max(
    0,
    Math.round((distanceMi / targetDailyMiles) * campMealsPerDay),
  );

  // 4. Resource & Waypoint Filtering
  const waypoints = route ? route.waypoints : [];
  const segmentWaypoints = waypoints.filter(
    (w) => w.distanceFromStartMi >= sMi && w.distanceFromStartMi <= eMi,
  );

  const waterSources = segmentWaypoints.filter((w) => w.type === 'water');
  const resupplyPoints = segmentWaypoints.filter((w) => w.type === 'resupply');
  const campSpots = segmentWaypoints.filter((w) => w.type === 'camping');

  const hillinessFtPerMi = distanceMi > 0 ? Math.round(gainFt / distanceMi) : 0;

  const analyticsResult = {
    startMi: sMi,
    endMi: eMi,
    distanceMi,
    gainFt,
    lossFt,
    hillinessFtPerMi,
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
      waterNeededLiters,
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

  analyticsResult.narrative = generateSegmentNarrative(analyticsResult);
  return analyticsResult;
}

/**
 * Builds day-by-day and leg-by-leg analytics for an entire planned route.
 * Restricts sub-legs to actual designated stops (camps, resupplies, active water stops)
 * rather than splitting on every individual stream or POI.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {Object} [options={}]
 * @returns {Array<Object>} Array of day segment analytics
 */
export function buildDaySegmentAnalytics(route, options = {}) {
  if (!route) return [];
  const plan = buildPlan(route, options);
  const dayPlan = plan.dayPlan || [];
  const activeStopIds = getActiveStopIds(route, options);

  return dayPlan.map((day) => {
    const dayStartMi = day.startMi;
    const dayEndMi = day.chosen ? day.chosen.endMi : dayStartMi;
    const dayAnalytics = computeSegmentAnalytics(route, dayStartMi, dayEndMi, options);

    // Find key stopping waypoints on this day to build sub-leg analytics.
    // Only include designated/active stops (resupplies, planned stops, user stops)
    const keyWaypoints = (route.waypoints || []).filter(
      (w) =>
        w.distanceFromStartMi > dayStartMi + 0.1 &&
        w.distanceFromStartMi < dayEndMi - 0.1 &&
        (activeStopIds.has(w.id) ||
          w.type === 'resupply' ||
          (w.source === 'user' && w.type !== 'navigation')),
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

/**
 * Generates a rich, descriptive narrative for a route segment including towns passed,
 * key milestones, trail watchouts, and logistical tips.
 *
 * @param {Object} segmentData - Segment metrics & waypoints
 * @returns {Object} Structured narrative object
 */
export function generateSegmentNarrative(segmentData) {
  const {
    startMi,
    endMi,
    distanceMi,
    gainFt,
    lossFt,
    hillinessFtPerMi,
    difficulty,
    pacing,
    logistics,
    waypoints,
  } = segmentData;

  // 1. Identify Towns & Major Services Passed
  const townsAndServices = [];
  const rawTowns = (waypoints?.resupplyPoints || []).concat(
    (waypoints?.all || []).filter(
      (w) =>
        w.type === 'resupply' ||
        w.tags?.place ||
        w.description?.toLowerCase().includes('town') ||
        w.description?.toLowerCase().includes('resupply') ||
        w.description?.toLowerCase().includes('cuesheet') ||
        w.tier === 'official' ||
        w.tier === 'store',
    ),
  );

  const seenTowns = new Set();
  for (const t of rawTowns) {
    if (seenTowns.has(t.name)) continue;
    seenTowns.add(t.name);
    const detourMi = t.offCourseDistanceMi || 0;
    const detourText =
      detourMi > 0.15
        ? detourMi > 0.3
          ? ` (${detourMi.toFixed(1)} mi off-route detour)`
          : ` (${Math.round(detourMi * 5280)} ft detour)`
        : ' (on route)';

    townsAndServices.push({
      name: t.name,
      mile: Number(t.distanceFromStartMi.toFixed(1)),
      type: t.type === 'resupply' ? 'Resupply Town / Store' : 'Civic Landmark',
      description: t.description || t.amenity || 'Services and resupply available',
      detourText,
    });
  }

  // 2. Key Chronological Milestones
  const milestoneCandidates = [...(waypoints?.all || [])].sort(
    (a, b) => a.distanceFromStartMi - b.distanceFromStartMi,
  );

  const milestones = [];
  for (const wp of milestoneCandidates) {
    const mi = Number(wp.distanceFromStartMi.toFixed(1));
    let icon = '📍';
    let category = 'Landmark';
    let detail = wp.description || '';

    if (wp.type === 'resupply') {
      icon = '🛒';
      category = 'Resupply';
    } else if (wp.type === 'water') {
      icon = '💧';
      category = 'Water Source';
      const rel = wp.reliability != null ? `${wp.reliability}% reliable` : 'Water';
      const flow = wp.seasonalStatus ? ` · ${wp.seasonalStatus}` : '';
      detail = `${rel}${flow}${wp.description ? ` — ${wp.description}` : ''}`;
    } else if (wp.type === 'camping') {
      icon = '⛺';
      category = 'Campsite';
      const fee = wp.fee ? ` [${wp.fee}]` : '';
      const water = wp.waterDetails ? ` (${wp.waterDetails})` : '';
      detail = `${wp.landManager || 'Camp'}${fee}${water}${wp.description ? ` — ${wp.description}` : ''}`;
    } else if (wp.type === 'summit') {
      icon = '⛰️';
      category = 'Summit / Pass';
      detail = wp.elevationFt ? `${wp.elevationFt.toLocaleString()} ft elevation` : (wp.description || '');
    }

    milestones.push({
      mile: mi,
      name: wp.name,
      icon,
      category,
      detail,
    });
  }

  // 3. Proactive Trail Tips & Watchouts ("What to look out for")
  const tips = [];

  // A. Hike-a-Bike & Steep Climbing Warning
  if (difficulty?.hikeABike && difficulty.hikeABike.distanceMi > 0) {
    const hab = difficulty.hikeABike;
    tips.push({
      icon: '⚠️',
      severity: 'warning',
      title: `Hike-a-Bike Alert (${hab.distanceMi} mi)`,
      text: `Expect ${hab.distanceMi} mi of steep hike-a-bike (${hab.pitchCount} pitches ≥15% grade, ${hab.percent}% of leg). Wear sturdy footwear and plan for reduced moving speeds.`,
    });
  }

  // B. Water Dry Gap Strategy
  const waterWpts = (waypoints?.waterSources || []).sort(
    (a, b) => a.distanceFromStartMi - b.distanceFromStartMi,
  );
  if (waterWpts.length === 0) {
    tips.push({
      icon: '🚫',
      severity: 'warning',
      title: 'Complete Dry Stretch',
      text: `No reliable water sources mapped along this entire ${distanceMi} mi stretch. You must pack at least ${logistics.waterNeededOz} oz (~${logistics.waterNeededLiters} L) before departure.`,
    });
  } else {
    let maxDry = 0;
    let prev = startMi;
    for (const w of waterWpts) {
      const gap = w.distanceFromStartMi - prev;
      if (gap > maxDry) maxDry = gap;
      prev = w.distanceFromStartMi;
    }
    if (endMi - prev > maxDry) maxDry = endMi - prev;

    if (maxDry > 15) {
      tips.push({
        icon: '💧',
        severity: 'warning',
        title: `Long Dry Gap (${maxDry.toFixed(1)} mi)`,
        text: `Longest dry gap between water refills is ${maxDry.toFixed(1)} miles. Budget water capacity carefully for high heat or heavy climbing.`,
      });
    } else {
      tips.push({
        icon: '💧',
        severity: 'info',
        title: 'Water Strategy',
        text: `${waterWpts.length} water source(s) available on this leg (max gap ${maxDry.toFixed(1)} mi). Carry ≈${logistics.waterNeededOz} oz minimum.`,
      });
    }
  }

  // C. Elevation Profile & Climbing Trajectory
  if (gainFt >= 1200) {
    tips.push({
      icon: '📈',
      severity: 'tip',
      title: `Substantial Climbing (+${gainFt.toLocaleString()} ft)`,
      text: `Heavy climbing stretch averaging ${hillinessFtPerMi} ft/mi. Pacing will be slower than flat terrain; preserve leg energy early.`,
    });
  } else if (lossFt >= 1500) {
    tips.push({
      icon: '📉',
      severity: 'tip',
      title: `Long Technical Descent (-${lossFt.toLocaleString()} ft)`,
      text: `Extended descent. Watch for loose gravel, ruts, and brake overheating on steep sections.`,
    });
  }

  // D. Food & Resupply Strategy
  if (townsAndServices.length > 0) {
    const townNames = townsAndServices.map((t) => `${t.name} (mi ${t.mile})`).join(', ');
    tips.push({
      icon: '🛒',
      severity: 'info',
      title: 'Town & Service Access',
      text: `Direct access to services at: ${townNames}. Great opportunity to refuel and top off food before remote stretches.`,
    });
  } else {
    tips.push({
      icon: '🏕️',
      severity: 'info',
      title: 'Remote Wilderness Stretch',
      text: `No town services or commercial stores on this segment. Carry all required nutrition (~${logistics.caloriesNeededKcal.toLocaleString()} kcal).`,
    });
  }

  // 4. Cohesive Narrative Paragraph
  const townLead =
    townsAndServices.length > 0
      ? `passes through ${townsAndServices.map((t) => t.name).join(' and ')}`
      : 'navigates remote backcountry terrain with no commercial services';

  const waterLead =
    waterWpts.length > 0
      ? `features ${waterWpts.length} mapped water point(s)`
      : 'is a dry carry requiring full water provisioning from the start';

  const habLead =
    difficulty?.hikeABike && difficulty.hikeABike.distanceMi > 0
      ? ` Riders should prepare for ${difficulty.hikeABike.distanceMi} mi of steep hike-a-bike across ${difficulty.hikeABike.pitchCount} pitches.`
      : ' Terrain offers rideable grades with no major hike-a-bike bottlenecks.';

  const summaryParagraph =
    `Mile ${Number(startMi).toFixed(1)} to Mile ${Number(endMi).toFixed(1)} (${distanceMi} mi) ${townLead}. ` +
    `The leg involves +${gainFt.toLocaleString()} ft of ascent and -${lossFt.toLocaleString()} ft of descent (${hillinessFtPerMi} ft/mi average hilliness), estimated at ${pacing.formattedMovingTime} of moving time (${pacing.formattedElapsedTime} total elapsed). ` +
    `The route ${waterLead}.${habLead} ` +
    `Total nutritional demand: ~${logistics.caloriesNeededKcal.toLocaleString()} kcal and ${logistics.waterNeededOz} oz (~${logistics.waterNeededLiters} L) of water.`;

  return {
    headline: `Mile ${Number(startMi).toFixed(1)} → ${Number(endMi).toFixed(1)} Segment Narrative`,
    summaryParagraph,
    townsAndServices,
    milestones,
    tips,
  };
}