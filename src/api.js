/**
 * api.js — Network and API query services.
 *
 * Encapsulates OSM Overpass queries and external resource fetching logic.
 */

import { fetchOverpass } from './gpx.js';

/**
 * Searches OSM for resources within a given bounding box matching a keyword.
 * @param {{ minLon: number, minLat: number, maxLon: number, maxLat: number }} bounds
 * @param {string} keyword
 * @returns {Promise<Array<object>>} Array of OSM elements.
 */
export async function searchOSMResources(bounds, keyword) {
  const { minLon, minLat, maxLon, maxLat } = bounds;
  const bbox = `${minLat},${minLon},${maxLat},${maxLon}`;
  const escapedKeyword = keyword.replace(/["\\]/g, '');

  const query = `
    [out:json][timeout:25];
    (
      node["name"~"${escapedKeyword}",i](${bbox});
      way["name"~"${escapedKeyword}",i](${bbox});
      node["tourism"~"${escapedKeyword}",i](${bbox});
      node["amenity"~"${escapedKeyword}",i](${bbox});
      node["shop"~"${escapedKeyword}",i](${bbox});
      node["natural"~"${escapedKeyword}",i](${bbox});
    );
    out center;
  `;

  const data = await fetchOverpass(query);
  return data.elements ?? [];
}
