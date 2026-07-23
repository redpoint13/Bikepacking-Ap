/**
 * camp.js — Camp site enrichment for Bikepacker Navigator.
 */

import { distanceFromStart, fetchOverpass, haversineDistance } from './gpx.js';
const ROUTE_PROXIMITY_MI = 2.0;
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
    console.warn('[BPNav] OSM camp fetch failed:', err.message);
    return [];
  }
}

export function classifyLandManager(tags = {}, agencyCode = '') {
  const code = (agencyCode || '').toUpperCase();
  const op = `${tags.operator ?? ''} ${tags.name ?? ''} ${tags.description ?? ''}`.toLowerCase();

  if (code.includes('BLM') || op.includes('blm') || op.includes('bureau of land management')) {
    return { landManager: 'BLM', isDispersedLegal: true };
  }
  if (code.includes('USFS') || op.includes('usfs') || op.includes('forest service') || op.includes('national forest')) {
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
  const url = `https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached/MapServer/0/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=ADMIN_AGENCY_CODE,HOLDING_NAME,ADMIN_UNIT_NAME&f=json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`BLM REST HTTP ${res.status}`);
    const data = await res.json();
    const attrs = data.features?.[0]?.attributes ?? {};
    const agencyCode = attrs.ADMIN_AGENCY_CODE || attrs.HOLDING_NAME || '';
    return classifyLandManager({}, agencyCode);
  } catch (_err) {
    return classifyLandManager({}, '');
  }
}

export function mergeCampSources(route, osmElements) {
  const { trackPoints } = route;
  const sampled = sampleTrackPoints(trackPoints);
  const existing = route.waypoints
    .filter((w) => w.type === 'camping')
    .map((w) => {
      const { landManager, isDispersedLegal } = classifyLandManager({ name: w.name, description: w.description });
      return {
        ...w,
        landManager: w.landManager || landManager,
        isDispersedLegal: w.isDispersedLegal ?? isDispersedLegal,
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
    });
  }

  return merged.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);
}

export async function enrichCampSources(route) {
  const osmElements = await fetchOSMCampSites(route.bounds);
  const merged = mergeCampSources(route, osmElements);
  return merged;
}

