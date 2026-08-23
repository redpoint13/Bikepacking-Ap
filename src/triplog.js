/**
 * triplog.js — Resource-log builder for Bikepacker Navigator.
 *
 * Transforms an enriched RouteContext into a flat "resource log" — the same
 * shape as the curated Colorado Trail master log in src/data/ctrTrailLog.json:
 *
 *   { cumulativeMi, landmark, type, elevationFt, milesToNextWater, milesToNextFood }
 *
 * This log is the substrate the Planning mode (plan.js) reasons over. It is
 * generated live from whatever route is loaded — no spreadsheet required — but
 * matches the spreadsheet schema so curated logs and generated logs are
 * interchangeable.
 *
 * @module triplog
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Water below this reliability score does not count as "reliable" for the
 * purpose of dry-stretch / carry calculations. A rider should not bank on
 * refilling at a cattle trough or a seasonal trickle.
 */
export const DEFAULT_RELIABLE_WATER_THRESHOLD = 50;

/** App waypoint type → resource-log type label (matches the CTR schema). */
const TYPE_LABEL = {
  water: 'WATER',
  resupply: 'FOOD',
  camping: 'CAMP',
  summit: 'SUMMIT',
  navigation: 'GENERIC',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the resource-log type label for an app waypoint type.
 * @param {'water' | 'resupply' | 'camping' | 'summit' | 'navigation'} type
 * @returns {'WATER' | 'FOOD' | 'CAMP' | 'SUMMIT' | 'GENERIC'}
 */
export function logType(type) {
  return TYPE_LABEL[type] ?? 'GENERIC';
}

/**
 * Returns true if a water waypoint is reliable enough to plan a refill on.
 * Non-water waypoints are never "reliable water".
 * @param {import('./gpx.js').Waypoint} wp
 * @param {number} threshold
 * @returns {boolean}
 */
export function isReliableWater(wp, threshold) {
  return wp.type === 'water' && (wp.reliability ?? 0) >= threshold;
}

/**
 * Finds the distance (miles ahead) from `fromMi` to the next waypoint matching
 * `predicate`, or null if none lies ahead.
 *
 * @param {import('./gpx.js').Waypoint[]} sortedWaypoints  - ascending by distanceFromStartMi
 * @param {number} fromMi
 * @param {(wp: import('./gpx.js').Waypoint) => boolean} predicate
 * @param {number} [epsilon=0.01]  - Ignore points essentially at fromMi
 * @returns {number | null}
 */
export function milesToNext(sortedWaypoints, fromMi, predicate, epsilon = 0.01) {
  for (const wp of sortedWaypoints) {
    if (wp.distanceFromStartMi > fromMi + epsilon && predicate(wp)) {
      return Number((wp.distanceFromStartMi - fromMi).toFixed(1));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Log construction
// ---------------------------------------------------------------------------

/**
 * Builds a resource log from an enriched RouteContext.
 *
 * Only resource-bearing waypoints (water / resupply / camping) become log
 * rows; raw turn-by-turn navigation cues are excluded so the log stays
 * scannable. Synthetic Start (mile 0) and Finish (total) rows bookend the log.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {{ reliableWaterThreshold?: number }} [opts]
 * @returns {{
 *   name: string,
 *   totalMiles: number,
 *   reliableWaterThreshold: number,
 *   schema: string[],
 *   entries: Array<{
 *     cumulativeMi: number,
 *     landmark: string,
 *     type: 'WATER'|'FOOD'|'CAMP'|'GENERIC',
 *     elevationFt: number|null,
 *     reliability: number|null,
 *     milesToNextWater: number|null,
 *     milesToNextFood: number|null,
 *   }>
 * }}
 */
export function buildResourceLog(route, opts = {}) {
  const threshold = opts.reliableWaterThreshold ?? DEFAULT_RELIABLE_WATER_THRESHOLD;
  const total = Number((route.totalDistanceMiles ?? 0).toFixed(1));

  // Resource waypoints only, ascending by distance, clamped to [0, total].
  const rawResources = [...route.waypoints]
    .filter(
      (w) =>
        w.type === 'water' || w.type === 'resupply' || w.type === 'camping' || w.type === 'summit',
    )
    .filter((w) => w.distanceFromStartMi >= 0 && w.distanceFromStartMi <= total + 0.01)
    .sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

  // Deduplicate resources that are at the exact same location or within 0.01 miles and have the same name/type
  const resources = [];
  for (const wp of rawResources) {
    const isDup = resources.some(
      (u) =>
        u.type === wp.type &&
        Math.abs(u.distanceFromStartMi - wp.distanceFromStartMi) < 0.01 &&
        (u.name || '') === (wp.name || ''),
    );
    if (!isDup) {
      resources.push(wp);
    }
  }

  // For "next water" we only count *reliable* water.
  const isWater = (w) => isReliableWater(w, threshold);
  const isFood = (w) => w.type === 'resupply';

  const rows = resources.map((wp) => ({
    id: wp.id,
    cumulativeMi: Number(wp.distanceFromStartMi.toFixed(1)),
    landmark: wp.name || logType(wp.type),
    type: logType(wp.type),
    elevationFt: wp.elevationFt ?? null,
    reliability: wp.type === 'water' ? (wp.reliability ?? null) : null,
    milesToNextWater: milesToNext(resources, wp.distanceFromStartMi, isWater),
    milesToNextFood: milesToNext(resources, wp.distanceFromStartMi, isFood),
    offCourseDistanceMi: wp.offCourseDistanceMi ?? null,
  }));

  // Synthetic Start row at mile 0 (if nothing already sits at the start).
  if (!rows.length || rows[0].cumulativeMi > 0.1) {
    rows.unshift({
      id: 'start',
      cumulativeMi: 0,
      landmark: 'Start',
      type: 'GENERIC',
      elevationFt: null,
      reliability: null,
      milesToNextWater: milesToNext(resources, 0, isWater),
      milesToNextFood: milesToNext(resources, 0, isFood),
    });
  }

  // Synthetic Finish row (if nothing sits within a tenth of a mile of the end).
  if (total > 0 && (!rows.length || total - rows[rows.length - 1].cumulativeMi > 0.1)) {
    rows.push({
      id: 'finish',
      cumulativeMi: total,
      landmark: 'Finish',
      type: 'GENERIC',
      elevationFt: null,
      reliability: null,
      milesToNextWater: null,
      milesToNextFood: null,
    });
  }

  return {
    name: route.name ?? 'Unnamed Route',
    totalMiles: total,
    reliableWaterThreshold: threshold,
    schema: [
      'cumulativeMi',
      'landmark',
      'type',
      'elevationFt',
      'milesToNextWater',
      'milesToNextFood',
    ],
    entries: rows,
  };
}
