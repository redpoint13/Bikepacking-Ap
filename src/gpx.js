/**
 * gpx.js — GPX file parser for Bikepacker Navigator.
 *
 * Parses a GPX XML string into a RouteContext object.
 * All computation is on-device — no server, no network.
 *
 * @module gpx
 */

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
 * Finds the index of the track point closest to a given lat/lon.
 * @param {number} lat
 * @param {number} lon
 * @param {Array<[number, number]>} trackPoints
 * @returns {number} Index into trackPoints
 */
export function nearestTrackPointIndex(lat, lon, trackPoints) {
  let nearestIdx = 0;
  let nearestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < trackPoints.length; i++) {
    const d = haversineDistance(lat, lon, trackPoints[i][0], trackPoints[i][1]);
    if (d < nearestDist) {
      nearestDist = d;
      nearestIdx = i;
    }
  }
  return nearestIdx;
}

/**
 * Calculates the along-track distance from the route start to a waypoint.
 * Finds the nearest track point, then sums segment lengths to that index.
 * @param {number} lat
 * @param {number} lon
 * @param {Array<[number, number]>} trackPoints
 * @returns {number} Distance in miles from route start
 */
export function distanceFromStart(lat, lon, trackPoints) {
  const idx = nearestTrackPointIndex(lat, lon, trackPoints);
  return computeRouteDistance(trackPoints.slice(0, idx + 1));
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
 * Parses a GPX XML string into a structured RouteContext.
 *
 * @param {string} xmlString - Raw GPX file content
 * @returns {RouteContext}
 *
 * @typedef {Object} Waypoint
 * @property {string} id
 * @property {number} lat
 * @property {number} lon
 * @property {string} name
 * @property {string} description
 * @property {'water' | 'resupply' | 'camping' | 'navigation'} type
 * @property {number} reliability     - 0–100 (enriched by data layer in Phase 2)
 * @property {number} distanceFromStartMi  - Along-track miles from route start
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
 */
export function parseGPX(xmlString) {
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
  const trkptEls = doc.getElementsByTagName('trkpt');
  if (trkptEls.length === 0) {
    throw new Error('No track points found in GPX file. Is this a valid route file?');
  }

  const trackPoints = [];
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;

  for (const pt of trkptEls) {
    const lat = Number.parseFloat(pt.getAttribute('lat'));
    const lon = Number.parseFloat(pt.getAttribute('lon'));
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;

    trackPoints.push([lat, lon]);
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }

  // --- Waypoints ---
  const wptEls = doc.getElementsByTagName('wpt');
  const waypoints = [];

  for (let i = 0; i < wptEls.length; i++) {
    const wpt = wptEls[i];
    const lat = Number.parseFloat(wpt.getAttribute('lat'));
    const lon = Number.parseFloat(wpt.getAttribute('lon'));
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;

    const wptName = getText(wpt, 'name') || 'Unnamed';
    const description = getText(wpt, 'desc') || getText(wpt, 'cmt') || '';
    const type = classifyWaypoint(wptName, description);
    const reliability = defaultReliability(type, wptName);
    const distanceFromStartMi = distanceFromStart(lat, lon, trackPoints);

    waypoints.push({
      id: `wpt-${i}`,
      lat,
      lon,
      name: wptName,
      description,
      type,
      reliability,
      distanceFromStartMi,
    });
  }

  // Sort waypoints by distance from start so the "nearest ahead" logic is easy
  waypoints.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

  const totalDistanceMiles = computeRouteDistance(trackPoints);
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

  return {
    name,
    totalDistanceMiles,
    trackPoints,
    waypoints,
    bounds: { minLat, maxLat, minLon, maxLon },
    startPoint,
    startOffsetMi: 0,
    isLoop,
  };
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
