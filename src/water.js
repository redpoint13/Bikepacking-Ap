/**
 * water.js — Live water source enrichment for Bikepacker Navigator.
 *
 * Fetches water data from USGS and OSM Overpass, filters to sources near the
 * route, deduplicates against GPX waypoints, and returns a merged set of
 * water sources with reliability scores.
 *
 * Both fetches are fire-and-forget friendly — network errors are caught and
 * logged; the app continues with whatever data is available.
 *
 * @module water
 */

import { distanceFromStart, fetchOverpass, haversineDistance } from './gpx.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USGS_BASE = 'https://api.waterdata.usgs.gov/ogcapi/v0/collections/monitoring-locations/items';

/** Sources within this many miles of the route are included. */
const ROUTE_PROXIMITY_MI = 1.0;

/** Sources within this distance of each other are considered the same. */
const DEDUP_THRESHOLD_MI = 0.15;

/** Sample every Nth track point for proximity checks (performance). */
const SAMPLE_STEP = 20;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns a sparse sample of track points for fast proximity checks.
 * Short tracks (fewer points than SAMPLE_STEP) return all points so that
 * proximity checks are not silently skipped.
 * @param {Array<[number, number]>} trackPoints
 * @returns {Array<[number, number]>}
 */
export function sampleTrackPoints(trackPoints) {
  // Short tracks: return every point so proximity checks aren't skipped.
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
 * Derives a reliability score (0-100) from a USGS monitoring location feature.
 * @param {object} feature - GeoJSON feature from USGS OGC API
 * @returns {number}
 */
export function usgsReliability(feature) {
  const type = (feature.properties?.monitoringLocationType ?? '').toLowerCase();
  if (type.includes('stream') || type.includes('river')) return 75;
  if (type.includes('spring')) return 65;
  if (type.includes('well')) return 55;
  return 60;
}

/**
 * Derives a reliability score (0-100) from OSM node tags.
 * @param {object} tags
 * @returns {number}
 */
export function osmReliability(tags) {
  if (tags.amenity === 'drinking_water') return 85;
  if (tags.man_made === 'water_tap') return 80;
  if (tags.natural === 'spring') {
    return tags.drinking_water === 'yes' ? 75 : 60;
  }
  if (tags.man_made === 'water_well') return 55;
  if (tags.natural === 'waterhole') return 40;
  return 50;
}

/**
 * Produces a human-readable label for an OSM water node.
 * @param {object} tags
 * @returns {string}
 */
export function osmLabel(tags) {
  if (tags.name) return tags.name;
  if (tags.amenity === 'drinking_water') return 'Drinking Water';
  if (tags.man_made === 'water_tap') return 'Water Tap';
  if (tags.natural === 'spring') return 'Spring';
  if (tags.man_made === 'water_well') return 'Water Well';
  if (tags.natural === 'waterhole') return 'Waterhole';
  return 'Water Source';
}

// ---------------------------------------------------------------------------
// Network fetches
// ---------------------------------------------------------------------------

/**
 * Fetches USGS monitoring locations within the route bounding box.
 * Returns an empty array on network failure -- never throws.
 *
 * @param {{ minLat: number, maxLat: number, minLon: number, maxLon: number }} bounds
 * @returns {Promise<object[]>} GeoJSON features
 */
export async function fetchUSGSLocations(bounds) {
  const { minLon, minLat, maxLon, maxLat } = bounds;
  const params = new URLSearchParams({
    f: 'json',
    bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
    limit: '200',
  });

  try {
    const res = await fetch(`${USGS_BASE}?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);
    const data = await res.json();
    return data.features ?? [];
  } catch (err) {
    console.warn('[BPNav] USGS fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetches OSM water nodes (springs, taps, wells, drinking water) within bounds.
 * Returns an empty array on network failure -- never throws.
 *
 * @param {{ minLat: number, maxLat: number, minLon: number, maxLon: number }} bounds
 * @returns {Promise<object[]>} OSM elements
 */
export async function fetchOSMWater(bounds) {
  const { minLon, minLat, maxLon, maxLat } = bounds;
  // Overpass bbox order: south,west,north,east
  const bbox = `${minLat},${minLon},${maxLat},${maxLon}`;
  const query = [
    '[out:json][timeout:25];',
    '(',
    `node["natural"="spring"](${bbox});`,
    `node["amenity"="drinking_water"](${bbox});`,
    `node["man_made"="water_tap"](${bbox});`,
    `node["man_made"="water_well"](${bbox});`,
    `node["natural"="waterhole"](${bbox});`,
    ');',
    'out body;',
  ].join('');

  try {
    const data = await fetchOverpass(query);
    return data.elements ?? [];
  } catch (err) {
    console.warn('[BPNav] OSM fetch failed:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

/**
 * Merges USGS and OSM water sources with existing GPX water waypoints.
 *
 * Rules:
 * - External sources are filtered to within ROUTE_PROXIMITY_MI of the route.
 * - Sources within DEDUP_THRESHOLD_MI of an existing waypoint are skipped
 *   (GPX user-named waypoints take priority).
 * - Result is sorted by distanceFromStartMi.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {object[]} usgsFeatures  - Raw USGS GeoJSON features
 * @param {object[]} osmElements   - Raw OSM elements
 * @returns {import('./gpx.js').Waypoint[]}
 */
/**
 * Merges USGS and OSM water sources with existing GPX water waypoints.
 *
 * Rules:
 * - External sources are filtered to within ROUTE_PROXIMITY_MI of the route.
 * - Sources within DEDUP_THRESHOLD_MI of an existing waypoint are skipped
 *   (GPX user-named waypoints take priority).
 * - Result is sorted by distanceFromStartMi.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {object[]} usgsFeatures  - Raw USGS GeoJSON features
 * @param {object[]} osmElements   - Raw OSM elements
 * @param {Map<string, number>} [flowMap] - Real-time flow data (siteId -> cfs)
 * @returns {import('./gpx.js').Waypoint[]}
 */
export function classifyFlowPercentile(currentFlow, stats = {}) {
  if (currentFlow == null || !Number.isFinite(currentFlow)) return 'Unknown';
  if (currentFlow === 0) return 'Much Below Normal (Dry Alert)';
  const { p10 = 1, p25 = 5, p75 = 50, p90 = 100 } = stats;
  if (currentFlow < p10) return 'Much Below Normal (Dry Alert)';
  if (currentFlow < p25) return 'Below Normal';
  if (currentFlow > p90) return 'Much Above Normal';
  if (currentFlow > p75) return 'Above Normal';
  return 'Normal Seasonal Flow';
}

export async function fetchUSGSPercentileStats(siteIds) {
  const statsMap = new Map();
  if (siteIds.length === 0) return statsMap;

  const url = `https://waterservices.usgs.gov/nwis/stat/?format=json&sites=${siteIds.join(',')}&statReportType=daily&statType=p10,p25,p50,p75,p90`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`USGS Stat HTTP ${res.status}`);
    const data = await res.json();
    const timeSeries = data.value?.timeSeries ?? [];
    for (const ts of timeSeries) {
      const siteId = ts.sourceInfo?.siteCode?.[0]?.value;
      const values = ts.values?.[0]?.value ?? [];
      if (siteId && values.length > 0) {
        const stats = {};
        for (const v of values) {
          const val = Number.parseFloat(v.value);
          const name = (v.qualifiers?.[0] ?? '').toLowerCase();
          if (name.includes('p10')) stats.p10 = val;
          if (name.includes('p25')) stats.p25 = val;
          if (name.includes('p75')) stats.p75 = val;
          if (name.includes('p90')) stats.p90 = val;
        }
        statsMap.set(siteId, stats);
      }
    }
  } catch (err) {
    console.warn('[BPNav] USGS statistics fetch failed:', err.message);
  }

  return statsMap;
}

export function mergeWaterSources(route, usgsFeatures, osmElements, flowMap = new Map(), statsMap = new Map()) {
  const { trackPoints } = route;
  const sampled = sampleTrackPoints(trackPoints);

  const existing = route.waypoints.filter((w) => w.type === 'water');
  const merged = [...existing];

  // --- USGS ---
  for (const feature of usgsFeatures) {
    if (!feature.geometry?.coordinates) continue;
    const [lon, lat] = feature.geometry.coordinates;
    if (!isNearRoute(lat, lon, sampled)) continue;
    if (merged.some((w) => haversineDistance(lat, lon, w.lat, w.lon) < DEDUP_THRESHOLD_MI)) {
      continue;
    }

    const props = feature.properties ?? {};
    const siteId = props.monitoringLocationNumber;
    let reliability = usgsReliability(feature);
    let flowDesc = '';
    let seasonalStatus = 'Normal Seasonal Flow';

    if (siteId && flowMap.has(siteId)) {
      const flow = flowMap.get(siteId);
      const stats = statsMap.get(siteId) ?? {};
      seasonalStatus = classifyFlowPercentile(flow, stats);
      if (flow > 0) {
        reliability = seasonalStatus.includes('Below') ? 70 : 90;
        flowDesc = ` (${seasonalStatus} — ${flow.toFixed(1)} cfs)`;
      } else {
        reliability = 0;
        flowDesc = ' (Station reports DRY / no flow)';
      }
    }

    merged.push({
      id: `usgs-${siteId ?? feature.id}`,
      lat,
      lon,
      name: props.monitoringLocationName ?? 'USGS Station',
      description: `USGS monitoring station${flowDesc}`,
      type: 'water',
      source: 'usgs',
      reliability,
      seasonalStatus,
      distanceFromStartMi: distanceFromStart(lat, lon, trackPoints),
    });
  }

  // --- OSM ---
  for (const el of osmElements) {
    const { lat, lon, tags = {} } = el;
    if (lat == null || lon == null) continue;
    if (!isNearRoute(lat, lon, sampled)) continue;
    if (merged.some((w) => haversineDistance(lat, lon, w.lat, w.lon) < DEDUP_THRESHOLD_MI)) {
      continue;
    }

    merged.push({
      id: `osm-${el.id}`,
      lat,
      lon,
      name: osmLabel(tags),
      description: tags.note ?? tags.description ?? '',
      type: 'water',
      source: 'osm',
      reliability: osmReliability(tags),
      distanceFromStartMi: distanceFromStart(lat, lon, trackPoints),
    });
  }

  return merged.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);
}

export async function fetchUSGSFlowData(siteIds) {
  const flowMap = new Map();
  if (siteIds.length === 0) return flowMap;

  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${siteIds.join(',')}&parameterCd=00060&siteStatus=active`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`USGS NWIS HTTP ${res.status}`);
    const data = await res.json();

    const timeSeries = data.value?.timeSeries ?? [];
    for (const ts of timeSeries) {
      const siteId = ts.sourceInfo?.siteCode?.[0]?.value;
      const values = ts.values?.[0]?.value ?? [];
      if (siteId && values.length > 0) {
        const valStr = values[0].value;
        const flow = Number.parseFloat(valStr);
        if (Number.isFinite(flow)) {
          flowMap.set(siteId, flow);
        }
      }
    }
  } catch (err) {
    console.warn('[BPNav] USGS NWIS streamflow fetch failed:', err.message);
  }

  return flowMap;
}

export async function enrichWaterSources(route) {
  const [usgsFeatures, osmElements] = await Promise.all([
    fetchUSGSLocations(route.bounds),
    fetchOSMWater(route.bounds),
  ]);

  const siteIds = usgsFeatures
    .map((f) => f.properties?.monitoringLocationNumber)
    .filter((id) => typeof id === 'string' && id.length > 0);

  const [flowMap, statsMap] = await Promise.all([
    fetchUSGSFlowData(siteIds),
    fetchUSGSPercentileStats(siteIds),
  ]);

  return mergeWaterSources(route, usgsFeatures, osmElements, flowMap, statsMap);
}

