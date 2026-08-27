/**
 * gpx.js — GPX file parser for Bikepacker Navigator.
 *
 * Parses a GPX XML string into a RouteContext object.
 * All computation is on-device — no server, no network.
 *
 * @module gpx
 */

import { calculateRouteDifficulty } from './difficulty.js';
import { describeError } from './errorBoundary.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EARTH_RADIUS_MILES = 3958.8;

/** Keywords used to classify waypoint types from name/description text. */
const WAYPOINT_KEYWORDS = {
  water: [
    'water',
    'creek',
    'river',
    'spring',
    'spigot',
    'well',
    'tank',
    'trough',
    'pond',
    'lake',
    'stream',
    'fountain',
    'cistern',
    'cache',
    'faucet',
    'tap',
    'oak creek',
    'verde',
    'wash',
  ],
  camping: [
    'camp',
    'campground',
    'campsite',
    'bivvy',
    'bivy',
    'sleep',
    'stay',
    'ranch',
    'state park',
    'dispersed',
    'hostel',
  ],
  resupply: [
    'food',
    'store',
    'market',
    'grocery',
    'restaurant',
    'cafe',
    'café',
    'brewing',
    'brewery',
    'fuel',
    'gas',
    'station',
    'resupply',
    'options',
    'convenience',
    'pharmacy',
    'whole foods',
    'pilot',
    'travel center',
    'route 66',
    'diner',
    'pizza',
    'burger',
    'taco',
    'sushi',
    'hotel',
    'motel',
  ],
  summit: ['pass', 'summit', 'peak', 'mountain', 'mount', 'ridge', 'saddle', 'crest', 'elevation'],
};

// ---------------------------------------------------------------------------
// Core distance math (Haversine formula)
// ---------------------------------------------------------------------------

/**
 * Calculates the great-circle distance between two points in miles.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} Distance in miles
 */
export function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.sqrt(a));
}

/**
 * Sums the total distance along an array of [lat, lon] track points.
 * @param {Array<[number, number]>} points
 * @returns {number} Total distance in miles
 */
export function computeRouteDistance(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineDistance(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  }
  return total;
}

/**
 * Cached helper to get or compute the cumulative along-track distance array.
 * @param {Array<[number, number]>} trackPoints
 * @returns {Float64Array}
 */

/**
 * Computes and caches a cumulative elevation gain array (in meters) for trackPoints.
 * Enables O(1) elevation gain queries between any two track points.
 * @param {Array<[number, number, number]>} trackPoints
 * @returns {Float64Array}
 */
export function getOrCreateCumulativeGain(trackPoints) {
  if (!trackPoints || trackPoints.length === 0) return new Float64Array(0);
  if (trackPoints._cumulativeGain && trackPoints._cumulativeGain.length === trackPoints.length) {
    return trackPoints._cumulativeGain;
  }
  const gains = new Float64Array(trackPoints.length);
  let accGain = 0;
  let lastEle = trackPoints[0][2] || 0;
  const THRESHOLD_M = 3; // ~10ft noise filter

  for (let i = 1; i < trackPoints.length; i++) {
    const ele = trackPoints[i][2] || 0;
    const diff = ele - lastEle;
    if (Math.abs(diff) > THRESHOLD_M) {
      if (diff > 0) accGain += diff;
      lastEle = ele;
    }
    gains[i] = accGain;
  }

  trackPoints._cumulativeGain = gains;
  return gains;
}

export function getOrCreateCumulativeDistances(trackPoints) {
  if (!trackPoints || trackPoints.length === 0) return new Float64Array(0);
  if (
    trackPoints._cumulativeDistances &&
    trackPoints._cumulativeDistances.length === trackPoints.length
  ) {
    return trackPoints._cumulativeDistances;
  }
  const distances = new Float64Array(trackPoints.length);
  let acc = 0;
  distances[0] = 0;
  for (let i = 1; i < trackPoints.length; i++) {
    acc += haversineDistance(
      trackPoints[i - 1][0],
      trackPoints[i - 1][1],
      trackPoints[i][0],
      trackPoints[i][1],
    );
    distances[i] = acc;
  }
  trackPoints._cumulativeDistances = distances;
  trackPoints._totalDistance = acc;
  return distances;
}

/**
 * Finds the index of the track point closest to a given lat/lon.
 * Uses fast equirectangular projection distance squared for high performance.
 * @param {number} lat
 * @param {number} lon
 * @param {Array<[number, number]>} trackPoints
 * @returns {number} Index into trackPoints
 */
export function nearestTrackPointIndex(lat, lon, trackPoints, hintIndex = -1) {
  if (!trackPoints || trackPoints.length === 0) return 0;
  const cosLat = Math.cos((lat * Math.PI) / 180);

  // Fast localized search if a valid hintIndex is provided
  if (hintIndex >= 0 && hintIndex < trackPoints.length) {
    const windowStart = Math.max(0, hintIndex - 50);
    const windowEnd = Math.min(trackPoints.length, hintIndex + 150);
    let localIdx = hintIndex;
    let localDistSq = Number.POSITIVE_INFINITY;

    for (let i = windowStart; i < windowEnd; i++) {
      const pt = trackPoints[i];
      const dLat = pt[0] - lat;
      const dLon = (pt[1] - lon) * cosLat;
      const distSq = dLat * dLat + dLon * dLon;
      if (distSq < localDistSq) {
        localDistSq = distSq;
        localIdx = i;
      }
    }
    // If local minimum is reasonably close (~150 meters / 0.0015 deg), return it immediately
    if (localDistSq < 0.000005) {
      return localIdx;
    }
  }

  let nearestIdx = 0;
  let nearestDistSq = Number.POSITIVE_INFINITY;

  for (let i = 0; i < trackPoints.length; i++) {
    const pt = trackPoints[i];
    const dLat = pt[0] - lat;
    const dLon = (pt[1] - lon) * cosLat;
    const distSq = dLat * dLat + dLon * dLon;
    if (distSq < nearestDistSq) {
      nearestDistSq = distSq;
      nearestIdx = i;
    }
  }
  return nearestIdx;
}

/**
 * Calculates the along-track distance from the route start to a waypoint.
 * Finds the nearest track point, then returns the cumulative distance in O(1).
 * @param {number} lat
 * @param {number} lon
 * @param {Array<[number, number]>} trackPoints
 * @returns {number} Distance in miles from route start
 */
export function distanceFromStart(lat, lon, trackPoints, hintIndex = -1) {
  if (!trackPoints || trackPoints.length === 0) return 0;
  const idx = nearestTrackPointIndex(lat, lon, trackPoints, hintIndex);
  const distances = getOrCreateCumulativeDistances(trackPoints);
  return distances[idx] ?? 0;
}

// ---------------------------------------------------------------------------
// Waypoint type classification
// ---------------------------------------------------------------------------

/**
 * Classifies a waypoint into a resource type based on its name and description.
 * @param {string} name
 * @param {string} [description]
 * @returns {'water' | 'resupply' | 'camping' | 'navigation'}
 */
export function classifyWaypoint(name, description = '') {
  const text = `${name} ${description}`.toLowerCase();

  for (const [type, keywords] of Object.entries(WAYPOINT_KEYWORDS)) {
    if (keywords.some((kw) => text.includes(kw))) {
      return type;
    }
  }

  return 'navigation';
}

/**
 * Assigns a default reliability score based on waypoint type and name.
 * Real scores will be enriched by the USGS/OSM data layer in Phase 2.
 * @param {'water' | 'resupply' | 'camping' | 'navigation'} type
 * @param {string} name
 * @returns {number} 0–100
 */
function defaultReliability(type, name) {
  if (type !== 'water') return 0;
  const lower = name.toLowerCase();
  if (lower.includes('river') || lower.includes('creek')) return 80;
  if (lower.includes('spigot') || lower.includes('faucet') || lower.includes('tap')) return 70;
  if (lower.includes('spring')) return 65;
  if (lower.includes('well')) return 55;
  return 50;
}

// ---------------------------------------------------------------------------
// GPX XML parsing
// ---------------------------------------------------------------------------

/** Track/way points processed between event-loop yields during async parsing. */
const PARSE_CHUNK_SIZE = 2000;

/**
 * Yields control to the event loop, letting the browser paint and handle input.
 * Prefers the scheduler API where available; falls back to a macrotask.
 * @returns {Promise<void>}
 */
function yieldToEventLoop() {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    return scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Extracts a text value from an XML element by tag name.
 * @param {Element} el
 * @param {string} tag
 * @returns {string}
 */
function getText(el, tag) {
  return el.getElementsByTagName(tag)[0]?.textContent?.trim() ?? '';
}

/**
 * Shared parsing core, written as a generator so a single implementation can be
 * driven either synchronously ({@link parseGPX}) or with yields to the event
 * loop ({@link parseGPXAsync}). Yields a 0–1 progress fraction at each chunk
 * boundary and returns the finished RouteContext.
 *
 * @param {string} xmlString - Raw GPX file content
 * @yields {number} Progress fraction
 * @returns {RouteContext}
 *
 * These typedefs are load-bearing, not decoration. A checker can only report
 * that a producer forgot a field if the field is declared here — and worse, an
 * *undeclared* property on a returned object literal raises an excess-property
 * error that SUPPRESSES the missing-property error on the same literal. That is
 * how parseRideWithGPS came to omit startPoint undetected: it also returned an
 * undeclared `source`, which masked the real fault. Declare what the code
 * actually sets, or the checking is worse than useless.
 *
 * @typedef {Object} Waypoint
 * @property {string} id
 * @property {number} lat
 * @property {number} lon
 * @property {string} name
 * @property {string} description
 * @property {'water' | 'resupply' | 'camping' | 'navigation'} type
 * @property {number | null} reliability  - 0–100; null when nothing is known
 * @property {number} distanceFromStartMi  - Along-track miles from route start
 * @property {number} [offCourseDistanceMi] - Miles from the route line
 * @property {string} [source]            - 'usgs' | 'osm' | 'synthetic' | importer
 * @property {Record<string, string>} [tags] - Raw OSM key/value tags, where carried
 *
 * Camp-specific, set by camp.js and read by planning:
 * @property {'official' | 'dispersed' | null} [tier]
 * @property {string} [campTier]
 * @property {'potable' | 'natural' | 'none' | 'unknown'} [waterAvailable]
 * @property {string} [waterDetails]
 * @property {string | null} [fee]
 * @property {string} [landManager]
 * @property {boolean} [isDispersedLegal] - May one pitch anywhere on this land
 *
 * Water-specific, set by water.js:
 * @property {string} [seasonalStatus]
 *
 * Resupply-specific, set by resupply.js and enrichment.js:
 * @property {string} [resupplyCategory] - 'grocery' | 'cstore' | 'restaurant' | 'none'
 * @property {string} [category]         - Legacy name, still in cached waypoints
 * @property {string} [hours]
 * @property {string | null} [phone]
 * @property {string} [notes]
 * @property {'planned' | 'optional' | 'skipped'} [stopState]
 *
 * Planner- and annotation-set:
 * @property {boolean} [isSynthetic]      - Invented by the planner, not a real site
 * @property {boolean} [needsSiteSelection] - A target mile, not a known campsite
 * @property {string} [wilderness]        - Name of the Wilderness Area containing it
 * @property {boolean} [bikeAccessible]   - False when a bicycle may not legally reach it
 * @property {number} [_absDistMi]        - Pre-offset distance, kept by applyStartOffset
 *
 * @typedef {Object} RouteContext
 * @property {string} name
 * @property {number} totalDistanceMiles
 * @property {Array<[number, number]>} trackPoints  - [lat, lon] pairs
 * @property {Waypoint[]} waypoints
 * @property {{ minLat: number, maxLat: number, minLon: number, maxLon: number }} bounds
 * @property {{ lat: number, lon: number }} startPoint
 * @property {number} startOffsetMi  - Miles along the route where the rider starts (0 = true start)
 * @property {boolean} isLoop        - True when start and end are within 1 mile of each other
 * @property {Object} metadata       - Route-specific metadata (forced stops, etc.)
 * @property {string} [source]       - 'gpx' | 'ridewithgps' | 'komoot'
 * @property {Object} [difficulty]   - calculateRouteDifficulty output
 * @property {number} [waypointsRevision] - Bumped by markWaypointsChanged; the plan memo key
 * @property {Array<{name: string, rings: number[][][]}>} [wildernessAreas]
 */
function* _parseGPXSteps(xmlString) {
  // Yield before the (atomic, unchunkable) XML parse so callers that render a
  // loading state get a paint before the main thread is occupied.
  yield 0;

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error(`GPX parse error: ${parseError.textContent}`);
  }

  // --- Route name ---
  const name =
    getText(doc, 'name') || doc.querySelector('trk > name')?.textContent?.trim() || 'Unnamed Route';

  // --- Track points ---
  // querySelectorAll returns a STATIC NodeList. getElementsByTagName returns a
  // *live* HTMLCollection whose every index access re-walks the document,
  // making iteration O(n^2) — ~14s for a 15k-point route.
  const trkptEls = doc.querySelectorAll('trkpt');
  if (trkptEls.length === 0) {
    throw new Error('No track points found in GPX file. Is this a valid route file?');
  }

  const trackPoints = [];
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < trkptEls.length; i++) {
    // Hand control back to the event loop every chunk so a long route never
    // blocks paint or input for more than a few milliseconds at a time.
    if (i > 0 && i % PARSE_CHUNK_SIZE === 0) yield i / trkptEls.length;

    const pt = trkptEls[i];
    const lat = Number.parseFloat(pt.getAttribute('lat'));
    const lon = Number.parseFloat(pt.getAttribute('lon'));
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;

    const eleStr = getText(pt, 'ele');
    const ele = eleStr ? Number.parseFloat(eleStr) : 0;

    trackPoints.push([lat, lon, Number.isNaN(ele) ? 0 : ele]);
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }

  // --- Precalculate cumulative distances for O(1) waypoint distance lookup ---
  const cumDistances = getOrCreateCumulativeDistances(trackPoints);
  const totalDistanceMiles =
    trackPoints._totalDistance || cumDistances[cumDistances.length - 1] || 0;

  // --- Waypoints ---
  const wptEls = doc.querySelectorAll('wpt');
  const waypoints = [];

  for (let i = 0; i < wptEls.length; i++) {
    if (i > 0 && i % PARSE_CHUNK_SIZE === 0) yield i / wptEls.length;

    const wpt = wptEls[i];
    const lat = Number.parseFloat(wpt.getAttribute('lat'));
    const lon = Number.parseFloat(wpt.getAttribute('lon'));
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;

    const wptName = getText(wpt, 'name') || 'Unnamed';
    const description = getText(wpt, 'desc') || getText(wpt, 'cmt') || '';
    const type = classifyWaypoint(wptName, description);
    const reliability = defaultReliability(type, wptName);
    const nearestIdx = nearestTrackPointIndex(lat, lon, trackPoints);
    const distanceFromStartMi = cumDistances[nearestIdx] ?? 0;
    const nearestPt = trackPoints[nearestIdx];
    const offCourseDistanceMi = haversineDistance(lat, lon, nearestPt[0], nearestPt[1]);

    waypoints.push({
      id: `wpt-${i}`,
      lat,
      lon,
      name: wptName,
      description,
      type,
      reliability,
      distanceFromStartMi,
      offCourseDistanceMi,
    });
  }

  waypoints.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);
  const startPoint = { lat: trackPoints[0][0], lon: trackPoints[0][1] };

  // Detect loop: start and end within 1 mile
  const isLoop =
    trackPoints.length >= 2 &&
    haversineDistance(
      trackPoints[0][0],
      trackPoints[0][1],
      trackPoints[trackPoints.length - 1][0],
      trackPoints[trackPoints.length - 1][1],
    ) < 1.0;

  const routeCtx = {
    name,
    totalDistanceMiles,
    trackPoints,
    waypoints,
    bounds: { minLat, maxLat, minLon, maxLon },
    startPoint,
    startOffsetMi: 0,
    isLoop,
    metadata: {
      forcedWaterIds: [],
      forcedResupplyIds: [],
      forcedCampIds: [],
    },
  };

  routeCtx.difficulty = calculateRouteDifficulty(routeCtx);
  return routeCtx;
}

/**
 * Parses a GPX XML string into a structured RouteContext, synchronously.
 *
 * Blocks the main thread for the whole parse. Prefer {@link parseGPXAsync} in
 * UI code; this remains for tests and non-UI callers.
 *
 * @param {string} xmlString - Raw GPX file content
 * @returns {RouteContext}
 */
export function parseGPX(xmlString) {
  const steps = _parseGPXSteps(xmlString);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * Parses a GPX XML string into a structured RouteContext without blocking the
 * main thread, yielding to the event loop between chunks.
 *
 * Produces a result identical to {@link parseGPX} — both drive the same
 * generator; only the scheduling differs.
 *
 * @param {string} xmlString - Raw GPX file content
 * @param {{ onProgress?: (fraction: number) => void }} [options]
 * @returns {Promise<RouteContext>}
 */
export async function parseGPXAsync(xmlString, { onProgress } = {}) {
  const steps = _parseGPXSteps(xmlString);
  let step = steps.next();
  while (!step.done) {
    if (onProgress && typeof step.value === 'number') onProgress(step.value);
    await yieldToEventLoop();
    step = steps.next();
  }
  return step.value;
}

/**
 * Recomputes waypoints against a different track, for swapping the GPX under an
 * existing set of markers.
 *
 * A waypoint is not just a coordinate: `distanceFromStartMi` and
 * `offCourseDistanceMi` are measured against the track it was created with.
 * Carry them onto a different GPX unchanged and every mile marker lies — a
 * spring at "mile 47" may sit at mile 52 on the new line, or nine miles off it —
 * which silently corrupts water carries and day planning. That is worse than
 * losing the waypoints, because the plan still looks reasonable.
 *
 * Anything now further from the route than the enrichment corridor is dropped:
 * a marker that far off is no longer a source you can ride to. User-created
 * waypoints are kept regardless of distance, because they were placed by hand
 * and are not reproducible — they are returned with their true off-course
 * distance so the caller can report it. Synthetic camps are discarded outright;
 * the planner regenerates them for the new route.
 *
 * @param {import('./gpx.js').Waypoint[]} waypoints
 * @param {Array<[number, number, number]>} trackPoints
 * @param {{maxOffCourseMi?: number}} [options]
 * @returns {{kept: import('./gpx.js').Waypoint[], dropped: import('./gpx.js').Waypoint[]}}
 */
export function rebaseWaypointsOntoTrack(waypoints, trackPoints, { maxOffCourseMi = 1.5 } = {}) {
  const kept = [];
  const dropped = [];
  if (!Array.isArray(waypoints) || !trackPoints?.length) return { kept, dropped };

  const cumulative = getOrCreateCumulativeDistances(trackPoints);

  for (const wp of waypoints) {
    if (!wp || !Number.isFinite(wp.lat) || !Number.isFinite(wp.lon)) continue;
    // The planner rebuilds these for whatever the new route needs.
    if (wp.isSynthetic || wp.id?.startsWith('synth-')) continue;

    const index = nearestTrackPointIndex(wp.lat, wp.lon, trackPoints);
    const nearest = trackPoints[index];
    const offCourseDistanceMi = haversineDistance(wp.lat, wp.lon, nearest[0], nearest[1]);
    const rebased = {
      ...wp,
      distanceFromStartMi: cumulative[index] ?? 0,
      offCourseDistanceMi,
    };

    const isUserPlaced = wp.id?.startsWith('user-');
    if (offCourseDistanceMi > maxOffCourseMi && !isUserPlaced) {
      dropped.push(rebased);
      continue;
    }
    kept.push(rebased);
  }

  kept.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// Start offset adjustment
// ---------------------------------------------------------------------------

/**
 * Returns a new RouteContext where every waypoint's distanceFromStartMi is
 * recalculated relative to offsetMi (the mile marker where the rider starts).
 *
 * For loops, distances wrap around using modular arithmetic so every waypoint
 * always has a non-negative "miles ahead" value:
 *   adjustedDist = (absDistMi - offsetMi + totalDistanceMiles) % totalDistanceMiles
 *
 * For point-to-point routes, distances are clamped so waypoints behind the
 * start offset get a negative value (they are "behind" the rider):
 *   adjustedDist = absDistMi - offsetMi
 *
 * Waypoints are re-sorted by their adjusted distance after recalculation.
 * The original `distanceFromStartMi` values on each waypoint are preserved
 * in `_absDistMi` for reference.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {number} offsetMi  - Mile marker of the actual start point
 * @returns {import('./gpx.js').RouteContext}  - New RouteContext (does not mutate input)
 */
export function applyStartOffset(route, offsetMi) {
  const { totalDistanceMiles, isLoop, waypoints } = route;
  const clampedOffset = Math.max(0, Math.min(offsetMi, totalDistanceMiles));

  const adjustedWaypoints = waypoints.map((wp) => {
    const abs = wp.distanceFromStartMi;
    const adjusted = isLoop
      ? (abs - clampedOffset + totalDistanceMiles) % totalDistanceMiles
      : abs - clampedOffset;
    return { ...wp, _absDistMi: abs, distanceFromStartMi: adjusted };
  });

  adjustedWaypoints.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

  return { ...route, startOffsetMi: clampedOffset, waypoints: adjustedWaypoints };
}

/**
 * Marks a route's waypoints as changed.
 *
 * The planning engine memoizes on the waypoint array, so any mutation has to be
 * visible to it. Reassignment and push/filter are visible through array identity
 * and length, but replacing an element in place (`waypoints[i] = wp`) or sorting
 * in place changes neither — which would serve a stale plan after editing an
 * existing waypoint.
 *
 * Call this after ANY change to route.waypoints. It re-seats the array so
 * identity-based consumers invalidate, and bumps an explicit revision so the
 * memo has an O(1) signal that does not depend on what changed.
 *
 * @param {RouteContext} route
 * @returns {RouteContext} the same route, for chaining
 */
export function markWaypointsChanged(route) {
  if (!route) return route;
  route.waypoints = Array.isArray(route.waypoints) ? [...route.waypoints] : [];
  route.waypointsRevision = (route.waypointsRevision ?? 0) + 1;
  return route;
}

// ---------------------------------------------------------------------------
// Convenience query helpers (used by status cards)
// ---------------------------------------------------------------------------

/**
 * Returns the first waypoint of a given type ahead of the current position.
 * @param {RouteContext} route
 * @param {'water' | 'resupply' | 'camping'} type
 * @param {number} [currentMile=0]
 * @returns {Waypoint | null}
 */
export function nextWaypointOfType(route, type, currentMile = 0) {
  return (
    route.waypoints.find((w) => w.type === type && w.distanceFromStartMi > currentMile) ?? null
  );
}

/**
 * Returns all waypoints of a given type.
 * @param {RouteContext} route
 * @param {'water' | 'resupply' | 'camping' | 'navigation'} type
 * @returns {Waypoint[]}
 */
export function waypointsOfType(route, type) {
  return route.waypoints.filter((w) => w.type === type);
}

/**
 * Interpolates coordinate position along the track points for a target mileage.
 * Uses fast binary search over cumulative distances array.
 * @param {Array<[number, number]>} trackPoints
 * @param {number} targetMile
 * @returns {[number, number] | null}
 */
export function getCoordinatesAtMile(trackPoints, targetMile) {
  if (!trackPoints || trackPoints.length === 0) return null;
  if (targetMile <= 0) return trackPoints[0];

  const distances = getOrCreateCumulativeDistances(trackPoints);
  const total = trackPoints._totalDistance || distances[distances.length - 1] || 0;
  if (targetMile >= total) return trackPoints[trackPoints.length - 1];

  let low = 0;
  let high = distances.length - 1;
  let idx = distances.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (distances[mid] >= targetMile) {
      idx = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  if (idx <= 0) return trackPoints[0];
  const p1 = trackPoints[idx - 1];
  const p2 = trackPoints[idx];
  const d1 = distances[idx - 1];
  const d2 = distances[idx];
  const segLen = d2 - d1;
  if (segLen <= 0) return p1;
  const ratio = (targetMile - d1) / segLen;
  const lat = p1[0] + (p2[0] - p1[0]) * ratio;
  const lon = p1[1] + (p2[1] - p1[1]) * ratio;
  return [lat, lon];
}

/**
 * Extracts a segment of track points between two mile marks using binary search.
 * @param {Array<[number, number]>} trackPoints
 * @param {number} startMi
 * @param {number} endMi
 * @returns {Array<[number, number]>}
 */
export function getTrackSegmentForMiles(trackPoints, startMi, endMi) {
  if (!trackPoints || trackPoints.length === 0) return [];
  const distances = getOrCreateCumulativeDistances(trackPoints);
  const total = trackPoints._totalDistance || distances[distances.length - 1] || 0;

  if (startMi <= 0 && endMi >= total) {
    return trackPoints;
  }

  let startIdx = 0;
  let endIdx = trackPoints.length - 1;

  let low = 0;
  let high = distances.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (distances[mid] < startMi) {
      low = mid + 1;
    } else {
      startIdx = mid;
      high = mid - 1;
    }
  }

  low = startIdx;
  high = distances.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (distances[mid] <= endMi) {
      endIdx = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return trackPoints.slice(startIdx, Math.min(trackPoints.length, endIdx + 1));
}

/**
 * Calculates elevation gain and loss (in feet) for a segment of track points.
 * Applies a 10ft noise filter threshold.
 * @param {Array<[number, number, number]>} trackPoints
 * @param {number} startMi
 * @param {number} endMi
 * @returns {{gainFt: number, lossFt: number}}
 */
export function calculateElevation(trackPoints, startMi, endMi) {
  if (!trackPoints || trackPoints.length < 2) return { gainFt: 0, lossFt: 0 };
  const cumDist = getOrCreateCumulativeDistances(trackPoints);

  let startIdx = 0;
  let endIdx = trackPoints.length - 1;

  let low = 0;
  let high = cumDist.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cumDist[mid] < startMi) low = mid + 1;
    else {
      startIdx = mid;
      high = mid - 1;
    }
  }

  low = startIdx;
  high = cumDist.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cumDist[mid] <= endMi) {
      endIdx = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (endIdx <= startIdx) return { gainFt: 0, lossFt: 0 };

  const cumGain = getOrCreateCumulativeGain(trackPoints);
  const gainM = cumGain[endIdx] - cumGain[startIdx];
  const startEleM = trackPoints[startIdx][2] || 0;
  const endEleM = trackPoints[endIdx][2] || 0;
  const netEleM = endEleM - startEleM;
  const lossM = Math.max(0, gainM - netEleM);

  return {
    gainFt: Math.round(gainM * 3.28084),
    lossFt: Math.round(lossM * 3.28084),
  };
}

/**
 * Classifies an OSM tag dictionary into a resource type.
 * @param {object} tags
 * @returns {'water' | 'camping' | 'resupply' | 'navigation'}
 */
export function classifyOSMElement(tags) {
  if (
    tags.tourism === 'camp_site' ||
    tags.tourism === 'caravan_site' ||
    tags.camp_site ||
    tags.backcountry === 'yes'
  ) {
    return 'camping';
  }

  const waterKeywords = [
    'water',
    'spring',
    'well',
    'drinking_water',
    'spigot',
    'river',
    'stream',
    'creek',
    'lake',
    'pond',
    'basin',
    'reservoir',
    'water_point',
  ];
  const hasWaterTag =
    tags.amenity === 'drinking_water' ||
    tags.natural === 'water' ||
    tags.natural === 'spring' ||
    tags.waterway === 'river' ||
    tags.waterway === 'stream' ||
    tags.waterway === 'creek' ||
    tags.man_made === 'water_well' ||
    tags.man_made === 'water_tap' ||
    tags.man_made === 'spigot';
  if (hasWaterTag) return 'water';

  const nameDesc = `${tags.name || ''} ${tags.description || ''} ${tags.amenity || ''} ${
    tags.natural || ''
  } ${tags.waterway || ''}`.toLowerCase();
  if (waterKeywords.some((k) => nameDesc.includes(k))) return 'water';

  const resupplyTags =
    tags.shop === 'supermarket' ||
    tags.shop === 'convenience' ||
    tags.shop === 'grocery' ||
    tags.amenity === 'cafe' ||
    tags.amenity === 'restaurant' ||
    tags.amenity === 'fuel' ||
    tags.amenity === 'fast_food' ||
    tags.amenity === 'pub' ||
    tags.tourism === 'hotel' ||
    tags.tourism === 'motel' ||
    tags.tourism === 'hostel';
  if (resupplyTags) return 'resupply';

  const resupplyKeywords = [
    'store',
    'market',
    'food',
    'grocery',
    'restaurant',
    'cafe',
    'diner',
    'gas',
    'station',
    'resupply',
    'hotel',
    'motel',
  ];
  if (resupplyKeywords.some((k) => nameDesc.includes(k))) return 'resupply';

  const campKeywords = ['camp', 'campground', 'campsite', 'bivvy', 'bivy'];
  if (campKeywords.some((k) => nameDesc.includes(k))) return 'camping';

  return 'navigation';
}

/**
 * Returns a human-friendly name for an OSM element.
 * @param {object} tags
 * @param {'water' | 'camping' | 'resupply' | 'navigation'} type
 * @returns {string}
 */
export function osmElementLabel(tags, type) {
  if (tags.name) return tags.name;
  if (type === 'water') {
    if (tags.natural === 'spring') return 'Spring';
    if (tags.amenity === 'drinking_water') return 'Drinking Water';
    if (tags.waterway) return tags.waterway.charAt(0).toUpperCase() + tags.waterway.slice(1);
    return 'Water Source';
  }
  if (type === 'camping') {
    return 'Camp Site';
  }
  if (type === 'resupply') {
    if (tags.shop) return tags.shop.charAt(0).toUpperCase() + tags.shop.slice(1);
    if (tags.amenity === 'cafe') return 'Café';
    if (tags.amenity === 'fuel') return 'Gas Station';
    return 'Resupply Stop';
  }
  return 'Waymark';
}

/**
 * Assigns a default reliability score for an OSM element.
 * @param {object} tags
 * @param {'water' | 'camping' | 'resupply' | 'navigation'} type
 * @returns {number}
 */
export function osmElementReliability(tags, type) {
  if (type !== 'water') return 0;
  if (tags.amenity === 'drinking_water') return 90;
  if (tags.natural === 'spring') return 65;
  if (tags.natural === 'water' || tags.waterway === 'river') return 80;
  return 50;
}

/**
 * Safely fetches from Overpass API, falling back to mirrors and retrying on 429 rate limits.
 * @param {string} query - Overpass QL query string
 * @returns {Promise<any>} Parsed JSON response
 */
/** Overpass mirrors, tried in order, once each. */
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * Waits before trying the next mirror, and not at all after the last one —
 * a delay there only postpones a failure the caller is already blocked on.
 * @param {number} attempt
 */
function backoffBeforeNextMirror(attempt) {
  if (attempt >= OVERPASS_MIRRORS.length - 1) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
}

export async function fetchOverpass(query) {
  let lastError = null;

  // Every mirror, once each. This ran `attempt < 3` against a four-entry list,
  // so index 3 was unreachable code — the last mirror was never tried, however
  // completely the others failed.
  for (let attempt = 0; attempt < OVERPASS_MIRRORS.length; attempt++) {
    const url = OVERPASS_MIRRORS[attempt];
    try {
      // GET, not POST: the Cache API cannot store a response to a POST, so the
      // service worker's Overpass rule silently cached nothing while this used
      // POST. Overpass documents ?data= as an equivalent interface, and the
      // query lands well inside URL length limits, so this is what makes the
      // offline replay of water, camp and resupply queries actually work.
      const res = await fetch(`${url}?data=${encodeURIComponent(query)}`, {
        method: 'GET',
        signal: AbortSignal.timeout(15_000),
      });

      if (res.status === 429) {
        console.warn(`[BPNav] Overpass mirror ${url} rate-limited (429). Trying next...`);
        await backoffBeforeNextMirror(attempt);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      return await res.json();
    } catch (err) {
      console.warn(`[BPNav] Overpass query failed on ${url}:`, describeError(err));
      lastError = err;
      await backoffBeforeNextMirror(attempt);
    }
  }

  throw new Error(`All Overpass mirrors failed. Last error: ${lastError?.message}`);
}

/**
 * Fetches elevation profile from Open-Topo-Data API if track points lack elevation data.
 * @param {import('./gpx.js').RouteContext} route
 * @returns {Promise<import('./gpx.js').RouteContext>}
 */
export async function fetchElevationFallback(route) {
  if (!route || !route.trackPoints || route.trackPoints.length === 0) return route;

  const hasElevation = route.trackPoints.some((pt) => pt[2] != null && pt[2] !== 0);
  if (hasElevation) return route;

  const total = route.trackPoints.length;
  const step = Math.max(1, Math.floor(total / 80));
  const sampledIndices = [];
  for (let i = 0; i < total; i += step) {
    sampledIndices.push(i);
  }
  if (sampledIndices[sampledIndices.length - 1] !== total - 1) {
    sampledIndices.push(total - 1);
  }

  const locationsStr = sampledIndices
    .map((idx) => `${route.trackPoints[idx][0].toFixed(5)},${route.trackPoints[idx][1].toFixed(5)}`)
    .join('|');

  const url = `https://api.opentopodata.org/v1/ned10m?locations=${locationsStr}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Open-Topo-Data HTTP ${res.status}`);
    const data = await res.json();
    const results = data.results ?? [];

    if (results.length > 0) {
      let rIdx = 0;
      for (let i = 0; i < total; i++) {
        if (rIdx < results.length) {
          const ele = results[rIdx].elevation ?? 0;
          route.trackPoints[i][2] = ele;
          if (sampledIndices[rIdx + 1] != null && i >= sampledIndices[rIdx + 1]) {
            rIdx++;
          }
        }
      }
    }
  } catch (err) {
    console.warn('[BPNav] Open-Topo-Data elevation fallback fetch failed:', describeError(err));
  }

  return route;
}

/**
 * Generates sampled elevation profile data with slope gradients and pass summits.
 * @param {import('./gpx.js').RouteContext} route
 * @param {number} [numSamples=200]
 * @returns {Array<{ distanceMi: number, elevationFt: number, gradePercent: number, gradeColor: string, isSummit: boolean, lat: number, lon: number }>}
 */
export function computeElevationProfileSamples(route, numSamples = 200) {
  if (!route || !route.trackPoints || route.trackPoints.length < 2) return [];

  const points = route.trackPoints;
  const totalDist = route.totalDistanceMiles || 0;
  if (totalDist <= 0) return [];

  const cumDist = getOrCreateCumulativeDistances(points);

  const step = totalDist / Math.max(10, numSamples);
  const samples = [];
  let currentIdx = 0;

  for (let d = 0; d <= totalDist && samples.length <= numSamples * 2; d += step) {
    const targetMi = Math.min(totalDist, d);
    while (currentIdx < cumDist.length - 1 && cumDist[currentIdx + 1] < targetMi) {
      currentIdx++;
    }
    const idx = currentIdx;

    const [lat, lon, eleMeters] = points[idx];
    const eleFt = (eleMeters ?? 0) * 3.28084;

    // Calculate grade percentage using previous sample
    let grade = 0;
    if (samples.length > 0) {
      const prev = samples[samples.length - 1];
      const distDeltaMiles = targetMi - prev.distanceMi;
      const eleDeltaFeet = eleFt - prev.elevationFt;
      if (distDeltaMiles > 0.001) {
        grade = (eleDeltaFeet / (distDeltaMiles * 5280)) * 100;
      }
    }

    let gradeColor = '#4caf50'; // Green (<5%)
    if (Math.abs(grade) >= 10) {
      gradeColor = '#f44336'; // Red (>10%)
    } else if (Math.abs(grade) >= 5) {
      gradeColor = '#ffeb3b'; // Yellow (5-9%)
    }

    samples.push({
      distanceMi: Number(targetMi.toFixed(2)),
      elevationFt: Math.round(eleFt),
      gradePercent: Number(grade.toFixed(1)),
      gradeColor,
      isSummit: false,
      lat,
      lon,
    });
  }

  // Identify local mountain pass summits (peaks higher than neighbors by >150ft)
  for (let i = 2; i < samples.length - 2; i++) {
    const curr = samples[i].elevationFt;
    const prev2 = samples[i - 2].elevationFt;
    const next2 = samples[i + 2].elevationFt;
    if (curr > prev2 + 150 && curr > next2 + 150) {
      samples[i].isSummit = true;
    }
  }

  return samples;
}
