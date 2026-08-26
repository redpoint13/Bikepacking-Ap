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

import { ENRICHMENT_LIMITS, capEnrichedWaypoints } from './enrichmentLimits.js';
import { describeError } from './errorBoundary.js';
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
/**
 * USGS site types a rider can actually take water from.
 *
 * The corridor for a long route returns thousands of monitoring locations, and
 * most are not water you can drink: groundwater observation wells (GW*) are
 * boreholes, AT is an atmospheric sensor, FA* are facilities — including, in
 * the Colorado Trail corridor, a sewage works. Anything not listed here is
 * dropped rather than scored, so it can never be offered as a refill.
 */
export const USGS_DRINKABLE_SITE_TYPES = {
  SP: 80, // spring — usually perennial, the best of these
  ST: 70, // stream
  LK: 65, // lake
  'ST-CA': 55, // canal — seasonal, and agricultural
  'ST-DCH': 55, // ditch — same
};

/**
 * Reads a USGS site's type. The API returns snake_case; the previous camelCase
 * lookup silently missed, which left every site scored the same.
 * @param {object} feature
 * @returns {string}
 */
export function usgsSiteType(feature) {
  const p = feature?.properties ?? {};
  return p.site_type_code ?? p.siteTypeCode ?? '';
}

/**
 * Derives a reliability score from the USGS site type. Returns 0 for anything
 * that is not a drinkable source, which keeps it below any usable threshold.
 * @param {object} feature
 * @returns {number}
 */
/**
 * Human label for a USGS site type, so a marker says what it actually is
 * rather than the uniform "USGS monitoring station".
 * @param {object} feature
 * @returns {string}
 */
export function usgsSiteLabel(feature) {
  const labels = {
    SP: 'Spring (USGS)',
    ST: 'Stream (USGS gauge)',
    LK: 'Lake (USGS)',
    'ST-CA': 'Canal (USGS)',
    'ST-DCH': 'Ditch (USGS)',
  };
  return labels[usgsSiteType(feature)] ?? 'USGS monitoring station';
}

export function usgsReliability(feature) {
  return USGS_DRINKABLE_SITE_TYPES[usgsSiteType(feature)] ?? 0;
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
  const bbox = `${minLon},${minLat},${maxLon},${maxLat}`;

  // Ask the server for only the site types a rider can drink from, and only
  // the fields we use. The Colorado Trail corridor holds ~5,100 sites, of which
  // ~2,100 are drinkable — the old single unfiltered request capped at 200
  // returned 4% of them, mostly monitoring wells. site_type_code takes one
  // value per request (comma lists return nothing), so these go in parallel.
  const fields = 'monitoring_location_name,monitoring_location_number,site_type_code';
  const types = Object.keys(USGS_DRINKABLE_SITE_TYPES);

  try {
    const responses = await Promise.all(
      types.map(async (siteType) => {
        const params = new URLSearchParams({
          f: 'json',
          bbox,
          limit: '2000',
          properties: fields,
          site_type_code: siteType,
        });
        const res = await fetch(`${USGS_BASE}?${params}`, {
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`USGS HTTP ${res.status} for ${siteType}`);
        const data = await res.json();
        return data.features ?? [];
      }),
    );
    return responses.flat();
  } catch (err) {
    console.warn('[BPNav] USGS fetch failed:', describeError(err));
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
    console.warn('[BPNav] OSM fetch failed:', describeError(err));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

/**
 * Classifies a stream gauge's real-time discharge against historical percentiles.
 * @param {number} currentFlow - Current flow rate in cubic feet per second (cfs)
 * @param {{ p10?: number, p25?: number, p75?: number, p90?: number }} [stats={}] - Historical percentile thresholds
 * @returns {string} Seasonal flow status description
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

  // This service does not speak JSON — it answers `format=json` with an HTTP
  // 400 and an HTML error page reading "unknown format: json", so the previous
  // request failed on every call and seasonal classification never once ran.
  // RDB is tab-delimited with a leading block of # comments and a column-type
  // row beneath the header. It also needs statTypeCd (not statType) and a
  // parameterCd, both of which were missing.
  const params = new URLSearchParams({
    format: 'rdb',
    sites: siteIds.join(','),
    statReportType: 'daily',
    statTypeCd: 'p10,p25,p50,p75,p90',
    parameterCd: '00060',
  });

  try {
    const res = await fetch(`https://waterservices.usgs.gov/nwis/stat/?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`USGS Stat HTTP ${res.status}`);
    return parseUSGSPercentileRdb(await res.text());
  } catch (err) {
    console.warn('[BPNav] USGS statistics fetch failed:', describeError(err));
  }

  return statsMap;
}

/**
 * Parses the RDB percentile table into per-site stats for today's date.
 *
 * The service returns one row per site per calendar day, so a rider gets the
 * percentiles that actually apply now rather than an annual average — which is
 * the whole point of asking: 20 cfs in June and 20 cfs in September mean very
 * different things about whether a creek is running.
 *
 * @param {string} text
 * @param {Date} [today]
 * @returns {Map<string, {p10?: number, p25?: number, p50?: number, p75?: number, p90?: number}>}
 */
export function parseUSGSPercentileRdb(text, today = new Date()) {
  const statsMap = new Map();
  const lines = (text ?? '').split('\n').filter((l) => l && !l.startsWith('#'));
  if (lines.length < 2) return statsMap;

  const header = lines[0].split('\t');
  const col = (name) => header.indexOf(name);
  const iSite = col('site_no');
  const iMonth = col('month_nu');
  const iDay = col('day_nu');
  if (iSite < 0 || iMonth < 0 || iDay < 0) return statsMap;

  const wantMonth = today.getMonth() + 1;
  const wantDay = today.getDate();
  const percentiles = ['p10', 'p25', 'p50', 'p75', 'p90'];

  // lines[1] is the column-type row (e.g. "5s\t15s"), not data.
  for (const line of lines.slice(2)) {
    const f = line.split('\t');
    if (Number(f[iMonth]) !== wantMonth || Number(f[iDay]) !== wantDay) continue;
    const site = f[iSite];
    if (!site) continue;
    const stats = {};
    for (const key of percentiles) {
      const idx = col(`${key}_va`);
      const val = idx >= 0 ? Number.parseFloat(f[idx]) : Number.NaN;
      if (Number.isFinite(val)) stats[key] = val;
    }
    if (Object.keys(stats).length > 0) statsMap.set(site, stats);
  }

  return statsMap;
}

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
 * @param {object[]} usgsFeatures - Raw USGS GeoJSON features
 * @param {object[]} osmElements - Raw OSM elements
 * @param {Map<string, number>} [flowMap] - Real-time flow data (siteId -> cfs)
 * @param {Map<string, object>} [statsMap] - Historical percentile stats (siteId -> stats)
 * @returns {import('./gpx.js').Waypoint[]}
 */
export function mergeWaterSources(
  route,
  usgsFeatures,
  osmElements,
  flowMap = new Map(),
  statsMap = new Map(),
) {
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
    // snake_case, as the API returns it. The old camelCase reads produced
    // undefined, which gave every station the id "usgs-undefined" and the name
    // "USGS Station", and meant the live-flow lookup below never matched.
    const siteId = props.monitoring_location_number ?? props.monitoringLocationNumber;
    let reliability = usgsReliability(feature);
    // Defence in depth: if a response ever carries a type we do not serve
    // water from, drop it rather than let it through with a zero score.
    if (reliability === 0 && !USGS_DRINKABLE_SITE_TYPES[usgsSiteType(feature)]) continue;
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
      name: props.monitoring_location_name ?? props.monitoringLocationName ?? 'USGS Station',
      description: `${usgsSiteLabel(feature)}${flowDesc}`,
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

  return capEnrichedWaypoints(merged, ENRICHMENT_LIMITS.water);
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
    console.warn('[BPNav] USGS NWIS streamflow fetch failed:', describeError(err));
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
