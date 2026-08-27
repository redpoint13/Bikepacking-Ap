/**
 * wilderness.js — Designated Wilderness Areas, where bikes are illegal.
 *
 * The Wilderness Act bars mechanised transport, so a bicycle may not enter a
 * designated Wilderness Area. That makes any camp, water source or resupply
 * inside one unusable however good its reliability: a rider cannot legally get
 * to it. This is a different question from who manages the land — a Wilderness
 * sits inside USFS or BLM ground, both of which otherwise permit dispersed
 * camping — so it is answered separately from classifyLandManager.
 *
 * Boundaries come from the Forest Service EDW National Wilderness Areas layer,
 * fetched once per route as simplified polygons and then tested locally: a
 * request per waypoint would be hundreds of round trips.
 *
 * @module wilderness
 */

import { readApiField } from './apiField.js';
import { describeError } from './errorBoundary.js';

const WILDERNESS_LAYER =
  'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_Wilderness_01/MapServer/0/query';

/**
 * Boundary simplification, in degrees. ~56 m, which takes the Colorado Trail
 * corridor from 5.3 MB and 129,000 vertices to 138 KB and 6,850 — small enough
 * to fetch on a trailhead connection, fine enough that the flag is meaningful.
 */
const SIMPLIFY_DEGREES = 0.0005;

/**
 * Fetches simplified Wilderness boundaries intersecting a route's bounds.
 *
 * Failure-tolerant like the other enrichment sources: a rider who cannot reach
 * the service gets no annotations rather than a broken app.
 *
 * @param {{minLat: number, maxLat: number, minLon: number, maxLon: number}} bounds
 * @returns {Promise<Array<{name: string, rings: number[][][]}>>}
 */
export async function fetchWildernessAreas(bounds) {
  if (!bounds) return [];
  const envelope = JSON.stringify({
    xmin: bounds.minLon,
    ymin: bounds.minLat,
    xmax: bounds.maxLon,
    ymax: bounds.maxLat,
    spatialReference: { wkid: 4326 },
  });
  const params = new URLSearchParams({
    geometry: envelope,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'WILDERNESSNAME',
    returnGeometry: 'true',
    maxAllowableOffset: String(SIMPLIFY_DEGREES),
    f: 'json',
  });

  try {
    const res = await fetch(`${WILDERNESS_LAYER}?${params}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Wilderness HTTP ${res.status}`);
    const data = await res.json();
    // ArcGIS reports a bad query in the body with a 200 status.
    if (data.error) throw new Error(`Wilderness: ${data.error.message ?? 'query failed'}`);
    return (data.features ?? [])
      .filter((f) => Array.isArray(f.geometry?.rings))
      .map((f) => ({
        name: readWildernessName(f.attributes),
        rings: f.geometry.rings,
      }));
  } catch (err) {
    console.warn('[BPNav] Wilderness boundary fetch failed:', describeError(err));
    return [];
  }
}

/**
 * Reads the area's name from an ArcGIS attribute bag.
 *
 * The service accepts WILDERNESSNAME in outFields but returns the key
 * lowercased, so a case-sensitive read silently produced the generic fallback
 * for every area — leaving a rider told they were in "a Wilderness Area" with
 * no idea which one, or which detour applies.
 *
 * @param {Record<string, unknown>} attrs
 * @returns {string}
 */
export function readWildernessName(attrs) {
  const value = readApiField(attrs, ['WILDERNESSNAME', 'wildernessname'], 'Wilderness name');
  return typeof value === 'string' && value.trim() ? value.trim() : 'Wilderness Area';
}

/**
 * Even-odd ray cast across every ring of a polygon.
 *
 * Counting crossings over all rings together handles holes for free: a point in
 * a hole crosses the outer ring and the hole, an even number, and so reads as
 * outside — which is correct, since a hole is land excluded from the Wilderness.
 *
 * @param {number} lon
 * @param {number} lat
 * @param {number[][][]} rings  ArcGIS rings, each an array of [lon, lat]
 * @returns {boolean}
 */
export function pointInRings(lon, lat, rings) {
  let inside = false;
  for (const ring of rings ?? []) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * Names the Wilderness Area containing a point, or null if it is outside all.
 * @param {number} lat
 * @param {number} lon
 * @param {Array<{name: string, rings: number[][][]}>} areas
 * @returns {string | null}
 */
export function wildernessAt(lat, lon, areas) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const area of areas ?? []) {
    if (pointInRings(lon, lat, area.rings)) return area.name;
  }
  return null;
}

/**
 * Marks every waypoint that sits inside a Wilderness Area, and unmarks any that
 * is no longer inside one.
 *
 * Sets `wilderness` to the area's name and `bikeAccessible` to false. Planning
 * reads bikeAccessible, so a flagged waypoint is never chosen as a stop or a
 * camp — it stays visible on the map, because knowing a Wilderness boundary is
 * there matters, but it stops being somewhere the plan sends you.
 *
 * Reports flags cleared as well as flags set. Both are in-place edits, so both
 * need markWaypointsChanged afterwards or the memoized plan keeps the old
 * answer — and a pass that only clears is exactly the case a caller counting
 * "how many are inside" would miss. That happens on restore: waypoints cached
 * with bikeAccessible false are excluded from planning, and if the boundaries
 * no longer contain them, nothing else would invalidate the memo.
 *
 * With no boundary data it changes nothing rather than clearing: a failed or
 * pending fetch is not evidence that a cached exclusion was wrong.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {Array<{name: string, rings: number[][][]}>} areas
 * @returns {{flagged: number, cleared: number, changed: number}}
 */
export function annotateWilderness(route, areas) {
  if (!route?.waypoints?.length || !areas?.length) {
    return { flagged: 0, cleared: 0, changed: 0 };
  }
  let flagged = 0;
  let cleared = 0;
  let changed = 0;
  for (const wp of route.waypoints) {
    const name = wildernessAt(wp.lat, wp.lon, areas);
    if (name) {
      // `changed` counts real mutations, so re-running against unchanged
      // boundaries does not churn the plan memo and the map for nothing.
      if (wp.wilderness !== name || wp.bikeAccessible !== false) changed++;
      wp.wilderness = name;
      wp.bikeAccessible = false;
      flagged++;
    } else if (wp.wilderness || wp.bikeAccessible === false) {
      wp.wilderness = undefined;
      wp.bikeAccessible = true;
      cleared++;
      changed++;
    }
  }
  return { flagged, cleared, changed };
}
