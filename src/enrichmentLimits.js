/**
 * enrichmentLimits.js — Volume control for OSM-derived waypoints.
 *
 * Lives apart from enrichment.js so the three enrichment modules (water, camp,
 * resupply) can use it without forming an import cycle — enrichment.js already
 * imports from camp.js.
 *
 * @module enrichmentLimits
 */

/**
 * Per-type limits on how many OSM-derived waypoints survive enrichment.
 *
 * The Overpass queries are bbox-wide and uncapped, so a route through a town
 * returns every cafe, bar and hotel in it. Hundreds of near-coincident stops add
 * nothing to a plan — you are choosing *where* to stop, not which restaurant —
 * but they multiply the cost of every planning recompute and bury the useful
 * stops on the map.
 *
 * `minSpacingMi` keeps the best stop in each neighbourhood; `maxCount` is the
 * backstop for a route that runs through several towns.
 */
export const ENRICHMENT_LIMITS = {
  water: { maxCount: 250, minSpacingMi: 0.25 },
  camping: { maxCount: 150, minSpacingMi: 0.5 },
  resupply: { maxCount: 200, minSpacingMi: 0.5 },
};

/**
 * Thins OSM-derived waypoints so a dense town cannot flood the planner, keeping
 * the highest-reliability stop in each neighbourhood.
 *
 * Waypoints that did not come from OSM — GPX, user-added, USGS gauges, imported
 * routes — are never dropped and always reserve their own spacing, so a thinned
 * OSM stop never sits on top of one the rider put there deliberately.
 *
 * @param {import('./gpx.js').Waypoint[]} waypoints - merged list, any order
 * @param {{ maxCount: number, minSpacingMi: number }} limits
 * @returns {import('./gpx.js').Waypoint[]} sorted by distanceFromStartMi
 */
export function capEnrichedWaypoints(waypoints, limits) {
  const byDistance = (a, b) => a.distanceFromStartMi - b.distanceFromStartMi;
  if (!Array.isArray(waypoints) || waypoints.length === 0) return [];
  if (!limits) return [...waypoints].sort(byDistance);

  const { maxCount, minSpacingMi } = limits;
  const kept = [];
  const candidates = [];
  for (const wp of waypoints) {
    if (wp.source === 'osm') candidates.push(wp);
    else kept.push(wp);
  }
  if (candidates.length === 0) return kept.sort(byDistance);

  // Best first, so the survivor of a cluster is the most dependable one.
  // Distance breaks ties to keep the result stable across runs.
  candidates.sort(
    (a, b) => (b.reliability ?? 0) - (a.reliability ?? 0) || a.distanceFromStartMi - b.distanceFromStartMi,
  );

  // Accepted positions along the route, kept sorted so the spacing check is a
  // binary search and the insertion point falls out of the same search.
  const takenMiles = kept.map((w) => w.distanceFromStartMi).sort((a, b) => a - b);

  /** First index in takenMiles holding a value >= mi. */
  const insertionPoint = (mi) => {
    let lo = 0;
    let hi = takenMiles.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (takenMiles[mid] < mi) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  let accepted = 0;
  for (const wp of candidates) {
    if (accepted >= maxCount) break;
    const mi = wp.distanceFromStartMi;
    const at = insertionPoint(mi);
    const crowdedAfter = at < takenMiles.length && takenMiles[at] - mi < minSpacingMi;
    const crowdedBefore = at > 0 && mi - takenMiles[at - 1] < minSpacingMi;
    if (crowdedAfter || crowdedBefore) continue;

    kept.push(wp);
    takenMiles.splice(at, 0, mi);
    accepted++;
  }

  return kept.sort(byDistance);
}
