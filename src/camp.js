/**
 * camp.js — Camp site enrichment for Bikepacker Navigator.
 */

import { ENRICHMENT_LIMITS, capEnrichedWaypoints } from './enrichmentLimits.js';
import { describeError } from './errorBoundary.js';
import { distanceFromStart, fetchOverpass, haversineDistance } from './gpx.js';
/** Surface Management Agency layer. Layer 0 is IDENTIFY and is not queryable. */
const BLM_SMA_LAYER =
  'https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_with_PriUnk/MapServer/1';

export const ROUTE_PROXIMITY_MI = 2.0;
const DEDUP_THRESHOLD_MI = 0.1;
const SAMPLE_STEP = 20;

export function sampleTrackPoints(trackPoints) {
  if (trackPoints.length <= SAMPLE_STEP) return [...trackPoints];
  const out = [];
  for (let i = 0; i < trackPoints.length; i += SAMPLE_STEP) {
    out.push(trackPoints[i]);
  }
  return out;
}

export function isNearRoute(lat, lon, sampledPoints) {
  return sampledPoints.some(
    ([tLat, tLon]) => haversineDistance(lat, lon, tLat, tLon) <= ROUTE_PROXIMITY_MI,
  );
}

export function osmCampTier(tags) {
  if (tags.access === 'private' || tags.access === 'no') return null;
  const op = (tags.operator ?? '').toLowerCase();
  const isPublicLand =
    op.includes('blm') ||
    op.includes('bureau of land management') ||
    op.includes('usfs') ||
    op.includes('forest service') ||
    op.includes('us forest') ||
    op.includes('nps') ||
    op.includes('national park') ||
    op.includes('state park') ||
    op.includes('state forest');
  if (
    tags.backcountry === 'yes' ||
    tags.camp_site === 'backcountry' ||
    tags.camp_site === 'dispersed' ||
    tags.informal === 'yes'
  ) {
    return 'dispersed';
  }
  if (isPublicLand) return 'dispersed';
  return 'official';
}

export function osmCampLabel(tags) {
  if (tags.name) return tags.name;
  const tier = osmCampTier(tags);
  if (tier === 'dispersed') return 'Dispersed Camping';
  return 'Camp Site';
}

export function osmCampReliability(tags) {
  const tier = osmCampTier(tags);
  if (tier === null) return 0;
  if (tier === 'official') return 90;
  if (tags.backcountry === 'yes' || tags.camp_site === 'backcountry') return 75;
  return 80;
}

/**
 * Infers water availability and details for a campground from OSM tags or descriptions.
 * @param {Object} tags
 * @param {string} [name='']
 * @param {string} [desc='']
 * @returns {{ waterAvailable: 'potable' | 'natural' | 'none' | 'unknown', waterDetails: string }}
 */
export function osmCampWater(tags = {}, name = '', desc = '') {
  if (
    tags.drinking_water === 'yes' ||
    tags['drinking_water:legal'] === 'yes' ||
    tags.water === 'potable'
  ) {
    return {
      waterAvailable: 'potable',
      waterDetails: tags.waterDetails || 'Potable water available',
    };
  }
  if (tags.drinking_water === 'no') {
    return { waterAvailable: 'none', waterDetails: 'No potable water' };
  }
  if (tags.water === 'yes' || tags.natural === 'spring' || tags.waterway) {
    return { waterAvailable: 'natural', waterDetails: 'Natural water source (filter required)' };
  }

  const text = `${name} ${desc} ${tags.description || ''} ${tags.note || ''}`.toLowerCase();
  if (
    text.includes('potable water') ||
    text.includes('drinking water') ||
    text.includes('spigot') ||
    text.includes('hand pump') ||
    text.includes('pump available') ||
    text.includes('faucet')
  ) {
    const details = text.includes('hand pump')
      ? 'Potable water available (hand pump)'
      : 'Potable water available';
    return { waterAvailable: 'potable', waterDetails: details };
  }
  if (
    text.includes('no water') ||
    text.includes('dry camp') ||
    text.includes('bring all water') ||
    text.includes('carry all water') ||
    text.includes('no potable water')
  ) {
    return { waterAvailable: 'none', waterDetails: 'No water (dry camp — carry all water)' };
  }
  if (
    text.includes('creek') ||
    text.includes('stream') ||
    text.includes('river') ||
    text.includes('spring') ||
    text.includes('lake') ||
    text.includes('filter required')
  ) {
    return { waterAvailable: 'natural', waterDetails: 'Stream / natural water (filter required)' };
  }

  return { waterAvailable: 'unknown', waterDetails: '' };
}

/**
 * Infers fee information for a campground from OSM tags or descriptions.
 * @param {Object} tags
 * @param {string} [name='']
 * @param {string} [desc='']
 * @returns {string|null}
 */
export function osmCampFee(tags = {}, name = '', desc = '') {
  if (tags.charge) return tags.charge;
  if (tags.fee === 'no') return 'Free';
  if (tags.fee === 'yes') return 'Fee required';

  const text = `${name} ${desc} ${tags.description || ''} ${tags.note || ''}`.toLowerCase();
  const feeMatch = text.match(/\$(\d+(?:\.\d+)?(?:\/(?:night|site|day))?)/i);
  if (feeMatch) {
    return feeMatch[0].includes('/') ? feeMatch[0] : `${feeMatch[0]}/night`;
  }
  if (text.includes('free') || text.includes('dispersed') || text.includes('no fee')) {
    return 'Free';
  }
  if (text.includes('fee required') || text.includes('permit required')) {
    return 'Fee / Permit Required';
  }

  return null;
}

export async function fetchOSMCampSites(bounds) {
  const { minLon, minLat, maxLon, maxLat } = bounds;
  const bbox = `${minLat},${minLon},${maxLat},${maxLon}`;
  const query = [
    '[out:json][timeout:25];',
    '(',
    `node["tourism"="camp_site"](${bbox});`,
    `node["tourism"="caravan_site"](${bbox});`,
    `way["tourism"="camp_site"](${bbox});`,
    `way["tourism"="caravan_site"](${bbox});`,
    ');',
    'out center;',
  ].join('');

  try {
    const data = await fetchOverpass(query);
    return data.elements ?? [];
  } catch (err) {
    console.warn('[BPNav] OSM camp fetch failed:', describeError(err));
    return [];
  }
}

export function classifyLandManager(tags = {}, agencyCode = '') {
  const code = (agencyCode || '').toUpperCase();
  const op = `${tags.operator ?? ''} ${tags.name ?? ''} ${tags.description ?? ''}`.toLowerCase();

  if (code.includes('BLM') || op.includes('blm') || op.includes('bureau of land management')) {
    return { landManager: 'BLM', isDispersedLegal: true };
  }
  if (
    code.includes('USFS') ||
    op.includes('usfs') ||
    op.includes('forest service') ||
    op.includes('national forest')
  ) {
    return { landManager: 'USFS', isDispersedLegal: true };
  }
  if (code.includes('NPS') || op.includes('nps') || op.includes('national park')) {
    return { landManager: 'NPS', isDispersedLegal: false };
  }
  if (code.includes('STATE') || op.includes('state park') || op.includes('state forest')) {
    return { landManager: 'State Land', isDispersedLegal: false };
  }
  if (code.includes('PVT') || op.includes('private')) {
    return { landManager: 'Private', isDispersedLegal: false };
  }

  return { landManager: 'Public Land', isDispersedLegal: true };
}

export async function fetchLandOwnership(lat, lon) {
  // Three separate faults lived in this URL, and every one of them failed
  // quietly. The service `BLM_Natl_SMA_Cached` does not exist — the real ones
  // are suffixed (_with_PriUnk, _without_PriUnk, _BLM_Only) — and ArcGIS
  // answers a missing service with HTTP 200 and a JSON error body, so res.ok
  // was true and the catch never fired. Layer 0 is IDENTIFY, not a queryable
  // feature layer; Surface Management Agency is layer 1. And HOLDING_NAME is
  // not a field on it, which fails the whole query with "Failed to execute
  // query" even once the service and layer are right.
  //
  // The fallback returns "Public Land" with dispersed camping legal, so while
  // this was broken every camp was labelled as legal to disperse on, private
  // land included.
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'ADMIN_AGENCY_CODE,ADMIN_DEPT_CODE,ADMIN_UNIT_NAME',
    returnGeometry: 'false',
    f: 'json',
  });
  const url = `${BLM_SMA_LAYER}/query?${params}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`BLM REST HTTP ${res.status}`);
    const data = await res.json();
    // ArcGIS reports a bad service or query in the body, with a 200 status.
    if (data.error) throw new Error(`BLM REST: ${data.error.message ?? 'query failed'}`);
    const attrs = data.features?.[0]?.attributes ?? {};
    const agencyCode = attrs.ADMIN_AGENCY_CODE || attrs.ADMIN_DEPT_CODE || '';
    return classifyLandManager({}, agencyCode);
  } catch (err) {
    console.warn('[BPNav] Land ownership lookup failed:', describeError(err));
    return classifyLandManager({}, '');
  }
}

export function mergeCampSources(route, osmElements) {
  const { trackPoints } = route;
  const sampled = sampleTrackPoints(trackPoints);
  const existing = route.waypoints
    .filter((w) => w.type === 'camping')
    .map((w) => {
      const { landManager, isDispersedLegal } = classifyLandManager({
        name: w.name,
        description: w.description,
      });
      const waterInfo = osmCampWater(w.tags || {}, w.name, w.description);
      const feeInfo = osmCampFee(w.tags || {}, w.name, w.description);
      return {
        ...w,
        landManager: w.landManager || landManager,
        isDispersedLegal: w.isDispersedLegal ?? isDispersedLegal,
        waterAvailable:
          w.waterAvailable ||
          (waterInfo.waterAvailable !== 'unknown' ? waterInfo.waterAvailable : null),
        waterDetails: w.waterDetails || waterInfo.waterDetails || '',
        fee: w.fee || feeInfo || null,
      };
    });
  const merged = [...existing];

  for (const el of osmElements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    const tags = el.tags ?? {};
    if (lat == null || lon == null) continue;
    const tier = osmCampTier(tags);
    if (tier === null) continue;
    if (!isNearRoute(lat, lon, sampled)) continue;
    if (merged.some((w) => haversineDistance(lat, lon, w.lat, w.lon) < DEDUP_THRESHOLD_MI)) {
      continue;
    }
    const { landManager, isDispersedLegal } = classifyLandManager(tags);
    const { waterAvailable, waterDetails } = osmCampWater(
      tags,
      tags.name,
      tags.description || tags.note,
    );
    const fee = osmCampFee(tags, tags.name, tags.description || tags.note);

    merged.push({
      id: `osm-camp-${el.id}`,
      lat,
      lon,
      name: osmCampLabel(tags),
      description: tags.description ?? tags.note ?? '',
      type: 'camping',
      source: 'osm',
      tier,
      reliability: osmCampReliability(tags),
      distanceFromStartMi: distanceFromStart(lat, lon, trackPoints),
      landManager,
      isDispersedLegal,
      waterAvailable: waterAvailable !== 'unknown' ? waterAvailable : null,
      waterDetails,
      fee,
    });
  }

  return capEnrichedWaypoints(merged, ENRICHMENT_LIMITS.camping);
}

export async function enrichCampSources(route) {
  const osmElements = await fetchOSMCampSites(route.bounds);
  const merged = mergeCampSources(route, osmElements);
  return merged;
}
