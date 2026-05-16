/**
 * import.js — URL-based route import for Bikepacker Navigator.
 *
 * Detects RideWithGPS and Komoot route URLs, fetches their public JSON
 * APIs, and parses the responses into the same RouteContext shape that
 * parseGPX() produces, so the rest of the app is source-agnostic.
 *
 * @module import
 */

import { distanceFromStart, haversineDistance } from './gpx.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// URL detection
// ---------------------------------------------------------------------------

/**
 * Parses a pasted URL and returns a descriptor if it matches a supported
 * import service, or null if unrecognised.
 *
 * @param {string} raw  - Raw string from the URL input (may include spaces)
 * @returns {{ service: 'ridewithgps' | 'komoot', id: string } | null}
 */
export function detectImportURL(raw) {
  const url = raw.trim();

  // RideWithGPS — /routes/{id} or /trips/{id}
  const rwgps = url.match(/ridewithgps\.com\/(?:routes|trips)\/(\d+)/i);
  if (rwgps) return { service: 'ridewithgps', id: rwgps[1] };

  // Komoot — /tour/{id} or /tours/{id}
  const komoot = url.match(/komoot\.com\/(?:tour|tours)\/(\d+)/i);
  if (komoot) return { service: 'komoot', id: komoot[1] };

  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Builds the geographic bounding box for a set of track points.
 * @param {Array<[number, number]>} trackPoints  - [lat, lon] pairs
 * @returns {{ minLat: number, maxLat: number, minLon: number, maxLon: number }}
 */
function boundsFromTrackPoints(trackPoints) {
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  for (const [lat, lon] of trackPoints) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

/**
 * Returns true if the route appears to be a loop (start ≈ end within 1 mi).
 * @param {Array<[number, number]>} trackPoints
 */
function isLoop(trackPoints) {
  if (trackPoints.length < 2) return false;
  const [sLat, sLon] = trackPoints[0];
  const [eLat, eLon] = trackPoints[trackPoints.length - 1];
  return haversineDistance(sLat, sLon, eLat, eLon) < 1.0;
}

// ---------------------------------------------------------------------------
// RideWithGPS
// ---------------------------------------------------------------------------

/**
 * Fetches a public RideWithGPS route by numeric ID.
 * Returns an empty-array-safe RouteContext on network failure — never throws.
 *
 * @param {string} id  - Numeric route/trip ID from the URL
 * @returns {Promise<import('./gpx.js').RouteContext>}
 */
export async function fetchRideWithGPS(id) {
  const url = `https://ridewithgps.com/routes/${id}.json`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`RideWithGPS HTTP ${res.status}`);
  const data = await res.json();
  return parseRideWithGPS(data);
}

/**
 * Parses a RideWithGPS route JSON payload into a RouteContext.
 *
 * RideWithGPS track_points use { x: lon, y: lat, e: elevation, d: distance_m }.
 * course_points use { x: lon, y: lat, d: distance_m, type, description }.
 *
 * @param {object} data  - Raw JSON from the RideWithGPS API
 * @returns {import('./gpx.js').RouteContext}
 */
export function parseRideWithGPS(data) {
  // The payload may be nested under a "route" key
  const route = data.route ?? data;

  const rawPoints = route.track_points ?? [];
  /** @type {Array<[number, number]>} */
  const trackPoints = rawPoints.map((tp) => [tp.y, tp.x]);

  const totalDistanceMiles = (route.distance ?? 0) / 1609.344;

  // Classify and convert course_points to Waypoints
  const coursePoints = route.course_points ?? [];
  const waypoints = coursePoints
    .filter((cp) => cp.y != null && cp.x != null)
    .map((cp, idx) => {
      const lat = cp.y;
      const lon = cp.x;
      const distMi = cp.d != null ? cp.d / 1609.344 : distanceFromStart(lat, lon, trackPoints);
      return {
        id: `rwgps-cp-${cp.id ?? idx}`,
        lat,
        lon,
        name: cp.description || cp.type || 'Waypoint',
        description: '',
        type: classifyRWGPSPoint(cp),
        source: 'ridewithgps',
        distanceFromStartMi: distMi,
      };
    });

  const bounds = boundsFromTrackPoints(trackPoints);
  const loop = isLoop(trackPoints);

  return {
    name: route.name || `RideWithGPS Route ${route.id ?? ''}`.trim(),
    totalDistanceMiles,
    trackPoints,
    waypoints,
    bounds,
    startOffsetMi: 0,
    isLoop: loop,
    source: 'ridewithgps',
  };
}

/**
 * Maps a RideWithGPS course_point type string to an internal waypoint type.
 * @param {{ type?: string, description?: string }} cp
 * @returns {'water' | 'resupply' | 'camping' | 'navigation'}
 */
export function classifyRWGPSPoint(cp) {
  const type = (cp.type ?? '').toLowerCase();
  const desc = (cp.description ?? '').toLowerCase();
  const combined = `${type} ${desc}`;

  if (/water|spring|creek|river|stream|fountain/.test(combined)) return 'water';
  if (/camp|bivouac|sleep/.test(combined)) return 'camping';
  if (/store|food|resupply|grocery|gas|fuel|cafe|coffee|restaurant/.test(combined))
    return 'resupply';
  return 'navigation';
}

// ---------------------------------------------------------------------------
// Komoot
// ---------------------------------------------------------------------------

/**
 * Fetches a public Komoot tour by numeric ID.
 * @param {string} id  - Numeric tour ID from the URL
 * @returns {Promise<import('./gpx.js').RouteContext>}
 */
export async function fetchKomoot(id) {
  const url = `https://api.komoot.de/v007/tours/${id}?_embedded=coordinates,way_types,surfaces,directions,participants,timeline`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Komoot HTTP ${res.status}`);
  const data = await res.json();
  return parseKomoot(data);
}

/**
 * Parses a Komoot tour JSON payload into a RouteContext.
 *
 * Komoot coordinate items use { lat, lng, alt } and are embedded under
 * _embedded.coordinates.items.
 *
 * @param {object} data  - Raw JSON from the Komoot API
 * @returns {import('./gpx.js').RouteContext}
 */
export function parseKomoot(data) {
  const coordItems = data._embedded?.coordinates?.items ?? [];
  /** @type {Array<[number, number]>} */
  const trackPoints = coordItems.map((c) => [c.lat, c.lng]);

  const totalDistanceMiles = (data.distance ?? 0) / 1000 / 1.60934;

  // Komoot highlights / segments as navigation waypoints
  const timeline = data._embedded?.timeline?.items ?? [];
  const waypoints = timeline
    .filter((item) => item.reference?.lat != null)
    .map((item, idx) => {
      const lat = item.reference.lat;
      const lon = item.reference.lng;
      return {
        id: `komoot-tl-${idx}`,
        lat,
        lon,
        name: item.reference.text ?? item.type ?? 'Highlight',
        description: '',
        type: classifyKomootItem(item),
        source: 'komoot',
        distanceFromStartMi: distanceFromStart(lat, lon, trackPoints),
      };
    });

  const bounds = boundsFromTrackPoints(trackPoints);
  const loop = isLoop(trackPoints);

  return {
    name: data.name || `Komoot Tour ${data.id ?? ''}`.trim(),
    totalDistanceMiles,
    trackPoints,
    waypoints,
    bounds,
    startOffsetMi: 0,
    isLoop: loop,
    source: 'komoot',
  };
}

/**
 * Maps a Komoot timeline item type to an internal waypoint type.
 * @param {{ type?: string }} item
 * @returns {'water' | 'resupply' | 'camping' | 'navigation'}
 */
export function classifyKomootItem(item) {
  const type = (item.type ?? '').toLowerCase();
  if (/poi/.test(type)) return 'navigation';
  return 'navigation';
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * Detects the service from a pasted URL and imports the route.
 * Throws with a human-readable message on failure.
 *
 * @param {string} url  - Raw URL string from the input
 * @returns {Promise<import('./gpx.js').RouteContext>}
 */
export async function importFromURL(url) {
  const detected = detectImportURL(url);
  if (!detected) {
    throw new Error(
      'Unrecognised URL. Paste a RideWithGPS route link (ridewithgps.com/routes/…) or a Komoot tour link (komoot.com/tour/…).',
    );
  }

  if (detected.service === 'ridewithgps') return fetchRideWithGPS(detected.id);
  if (detected.service === 'komoot') return fetchKomoot(detected.id);

  throw new Error(`Unsupported service: ${detected.service}`);
}
