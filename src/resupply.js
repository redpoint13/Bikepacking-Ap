/**
 * resupply.js — Resupply point enrichment for Bikepacker Navigator.
 *
 * Fetches shops, food, fuel, and lodging from OSM Overpass, filters to
 * sources near the route, deduplicates against GPX waypoints, and returns
 * a merged set of resupply stops with category labels and reliability scores.
 *
 * @module resupply
 */

import { ENRICHMENT_LIMITS, capEnrichedWaypoints } from './enrichmentLimits.js';
import { describeError } from './errorBoundary.js';
import { distanceFromStart, fetchOverpass, haversineDistance } from './gpx.js';

/** Resupply stops within this many miles of the route are included. */
const ROUTE_PROXIMITY_MI = 1.5;

/** Stops within this distance of an existing waypoint are deduplicated. */
const DEDUP_THRESHOLD_MI = 0.1;

/** Sample every Nth track point for proximity checks (performance). */
const SAMPLE_STEP = 20;

// ---------------------------------------------------------------------------
// Tag → category mapping
// ---------------------------------------------------------------------------

/**
 * OSM tag categories and their display labels / reliability scores.
 * Priority: first match wins.
 */
const CATEGORIES = [
  // Grocery / general store
  {
    id: 'grocery',
    label: 'Grocery Store',
    reliability: 90,
    match: (tags) =>
      tags.shop === 'supermarket' ||
      tags.shop === 'grocery' ||
      tags.shop === 'general' ||
      tags.shop === 'convenience',
  },
  // Outdoor / bike shop
  {
    id: 'outdoor',
    label: 'Outdoor / Bike Shop',
    reliability: 85,
    match: (tags) => tags.shop === 'outdoor' || tags.shop === 'bicycle' || tags.shop === 'sports',
  },
  // Fuel / gas station
  {
    id: 'fuel',
    label: 'Gas Station',
    reliability: 80,
    match: (tags) => tags.amenity === 'fuel',
  },
  // Sit-down restaurant / diner
  {
    id: 'restaurant',
    label: 'Restaurant',
    reliability: 70,
    match: (tags) =>
      tags.amenity === 'restaurant' || tags.amenity === 'pub' || tags.amenity === 'bar',
  },
  // Cafe / coffee shop
  {
    id: 'cafe',
    label: 'Café',
    reliability: 70,
    match: (tags) => tags.amenity === 'cafe',
  },
  // Fast food
  {
    id: 'fast_food',
    label: 'Fast Food',
    reliability: 75,
    match: (tags) => tags.amenity === 'fast_food',
  },
  // Lodging
  {
    id: 'lodging',
    label: 'Lodging',
    reliability: 65,
    match: (tags) =>
      tags.tourism === 'hostel' ||
      tags.tourism === 'motel' ||
      tags.tourism === 'hotel' ||
      tags.tourism === 'guest_house',
  },
];

// ---------------------------------------------------------------------------
// Internal helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Returns a sparse sample of track points for fast proximity checks.
 * Short tracks return all points so proximity checks are not silently skipped.
 * @param {Array<[number, number]>} trackPoints
 * @returns {Array<[number, number]>}
 */
export function sampleTrackPoints(trackPoints) {
  if (trackPoints.length <= SAMPLE_STEP) return [...trackPoints];
  const out = [];
  for (let i = 0; i < trackPoints.length; i += SAMPLE_STEP) {
    out.push(trackPoints[i]);
  }
  return out;
}

/**
 * Returns true if (lat, lon) lies within ROUTE_PROXIMITY_MI of any sampled point.
 * @param {number} lat
 * @param {number} lon
 * @param {Array<[number, number]>} sampledPoints
 * @returns {boolean}
 */
export function isNearRoute(lat, lon, sampledPoints) {
  return sampledPoints.some(
    ([tLat, tLon]) => haversineDistance(lat, lon, tLat, tLon) <= ROUTE_PROXIMITY_MI,
  );
}

/**
 * Returns the first matching CATEGORIES entry for the given OSM tags,
 * or null if no category matches.
 * @param {object} tags
 * @returns {{ id: string, label: string, reliability: number } | null}
 */
export function osmResupplyCategory(tags) {
  return CATEGORIES.find((cat) => cat.match(tags)) ?? null;
}

/**
 * Returns a human-readable label for an OSM resupply node.
 * Prefers the OSM name tag; falls back to the category label.
 * @param {object} tags
 * @returns {string}
 */
export function osmResupplyLabel(tags) {
  if (tags.name) return tags.name;
  const cat = osmResupplyCategory(tags);
  return cat ? cat.label : 'Resupply Stop';
}

/**
 * Returns a reliability score (0-100) for an OSM resupply node.
 * @param {object} tags
 * @returns {number}
 */
export function osmResupplyReliability(tags) {
  const cat = osmResupplyCategory(tags);
  return cat ? cat.reliability : 60;
}

// ---------------------------------------------------------------------------
// Network fetch
// ---------------------------------------------------------------------------

/**
 * Fetches OSM resupply nodes (shops, food, fuel, lodging) within bounds.
 * Returns an empty array on network failure — never throws.
 *
 * @param {{ minLat: number, maxLat: number, minLon: number, maxLon: number }} bounds
 * @returns {Promise<object[]>} OSM elements
 */
export async function fetchOSMResupply(bounds) {
  const { minLon, minLat, maxLon, maxLat } = bounds;
  // Overpass bbox order: south,west,north,east
  const bbox = `${minLat},${minLon},${maxLat},${maxLon}`;

  const query = [
    '[out:json][timeout:25];',
    '(',
    // Grocery / general
    `node["shop"="supermarket"](${bbox});`,
    `node["shop"="grocery"](${bbox});`,
    `node["shop"="general"](${bbox});`,
    `node["shop"="convenience"](${bbox});`,
    // Outdoor / bike
    `node["shop"="outdoor"](${bbox});`,
    `node["shop"="bicycle"](${bbox});`,
    `node["shop"="sports"](${bbox});`,
    // Fuel
    `node["amenity"="fuel"](${bbox});`,
    // Food
    `node["amenity"="restaurant"](${bbox});`,
    `node["amenity"="cafe"](${bbox});`,
    `node["amenity"="fast_food"](${bbox});`,
    `node["amenity"="pub"](${bbox});`,
    `node["amenity"="bar"](${bbox});`,
    // Lodging
    `node["tourism"="hostel"](${bbox});`,
    `node["tourism"="motel"](${bbox});`,
    `node["tourism"="hotel"](${bbox});`,
    `node["tourism"="guest_house"](${bbox});`,
    // Ways: shops, restaurants and lodgings are routinely mapped as building
    // polygons rather than points. Querying nodes only made all of those
    // invisible to resupply planning.
    `way["shop"="supermarket"](${bbox});`,
    `way["shop"="grocery"](${bbox});`,
    `way["shop"="general"](${bbox});`,
    `way["shop"="convenience"](${bbox});`,
    `way["shop"="outdoor"](${bbox});`,
    `way["shop"="bicycle"](${bbox});`,
    `way["shop"="sports"](${bbox});`,
    `way["amenity"="fuel"](${bbox});`,
    `way["amenity"="restaurant"](${bbox});`,
    `way["amenity"="cafe"](${bbox});`,
    `way["amenity"="fast_food"](${bbox});`,
    `way["amenity"="pub"](${bbox});`,
    `way["amenity"="bar"](${bbox});`,
    `way["tourism"="hostel"](${bbox});`,
    `way["tourism"="motel"](${bbox});`,
    `way["tourism"="hotel"](${bbox});`,
    `way["tourism"="guest_house"](${bbox});`,
    ');',
    'out center;',
  ].join('');

  try {
    const data = await fetchOverpass(query);
    return data.elements ?? [];
  } catch (err) {
    console.warn('[BPNav] OSM resupply fetch failed:', describeError(err));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

/**
 * Merges OSM resupply stops with existing GPX resupply waypoints.
 *
 * Rules:
 * - External sources filtered to within ROUTE_PROXIMITY_MI of the route.
 * - Sources within DEDUP_THRESHOLD_MI of an existing waypoint are skipped.
 * - Result is sorted by distanceFromStartMi.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {object[]} osmElements - Raw OSM elements
 * @returns {import('./gpx.js').Waypoint[]}
 */
export function mergeResupplySources(route, osmElements) {
  const { trackPoints } = route;
  const sampled = sampleTrackPoints(trackPoints);
  const existing = route.waypoints.filter((w) => w.type === 'resupply');
  const merged = [...existing];

  for (const el of osmElements) {
    const { tags = {} } = el;
    // `out center` gives a way its centroid in el.center; nodes keep lat/lon.
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    if (!isNearRoute(lat, lon, sampled)) continue;
    if (merged.some((w) => haversineDistance(lat, lon, w.lat, w.lon) < DEDUP_THRESHOLD_MI)) {
      continue;
    }

    const cat = osmResupplyCategory(tags);

    merged.push({
      // Node and way ids share a numeric space in OSM, so a way needs its own
      // namespace. Node ids keep their original form: they are persisted in
      // excludedResupplyIds/forcedResupplyIds, and renaming them would silently
      // discard every stop a user had already skipped or forced.
      id: el.type === 'way' ? `osm-resupply-way-${el.id}` : `osm-resupply-${el.id}`,
      lat,
      lon,
      name: osmResupplyLabel(tags),
      description: tags.note ?? tags.description ?? '',
      type: 'resupply',
      source: 'osm',
      category: cat?.id ?? 'other',
      reliability: osmResupplyReliability(tags),
      distanceFromStartMi: distanceFromStart(lat, lon, trackPoints),
    });
  }

  return capEnrichedWaypoints(merged, ENRICHMENT_LIMITS.resupply);
}

// ---------------------------------------------------------------------------
// Top-level enrichment entry point
// ---------------------------------------------------------------------------

/**
 * Fetches OSM resupply data, merges with GPX waypoints, and returns the
 * enriched resupply waypoint list.
 *
 * Call this asynchronously after the route is displayed so the user sees
 * instant feedback from GPX data while live data loads in the background.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @returns {Promise<import('./gpx.js').Waypoint[]>}
 */
export async function enrichResupplySources(route) {
  const osmElements = await fetchOSMResupply(route.bounds);
  return mergeResupplySources(route, osmElements);
}
