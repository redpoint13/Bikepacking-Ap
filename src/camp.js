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

export function mergeCampSources(route, osmElements) {
  const { trackPoints } = route;
  const sampled = sampleTrackPoints(trackPoints);
  const existing = route.waypoints.filter((w) => w.type === 'camping');
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
    });
  }

  return merged.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);
}

export async function enrichCampSources(route) {
  const osmElements = await fetchOSMCampSites(route.bounds);
  return mergeCampSources(route, osmElements);
}
