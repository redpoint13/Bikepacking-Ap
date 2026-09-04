/**
 * sync.js — Offline Map Sync Orchestrator
 */

import { getTilesForRoute } from './utils/tiles.js';

/**
 * Downloads all required map tiles and style assets for the given route
 * to guarantee offline rendering. Relies on the Service Worker to intercept
 * and cache the requests.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {(current: number, total: number) => void} onProgress
 */
export async function syncOfflineMap(route, onProgress) {
  if (!route || !route.trackPoints) return;

  const styleAssets = [
    'https://tiles.openfreemap.org/styles/liberty',
    'https://tiles.openfreemap.org/sprites/ofm_f384/ofm.json',
    'https://tiles.openfreemap.org/sprites/ofm_f384/ofm.png',
  ];

  // MapLibre glyphs (fonts) we might need for typical names.
  // PWA workbox handles fonts, but we could pre-fetch a few common ranges if desired.
  // We'll skip fonts for now to save bandwidth, as they cache well during normal usage.

  // z16 doubles the tile count but is the difference between "there is a town
  // here" and being able to find the spigot in it. Sync is an explicit,
  // progress-reported action taken on wifi, so the cost is the user's to accept.
  const tiles = getTilesForRoute(route, 10, 16);
  const totalAssets = styleAssets.length + tiles.length;
  let currentAssets = 0;

  // 1. Fetch style and sprites
  for (const url of styleAssets) {
    try {
      // A plain CORS fetch on purpose. OpenFreeMap sends
      // `access-control-allow-origin: *`, so `no-cors` bought nothing and cost
      // everything: it yields an *opaque* response, the Workbox rule caches it
      // (statuses [0, 200]), and the browser then refuses to hand an opaque
      // response back to MapLibre's CORS-mode request. CacheFirst keeps serving
      // that poisoned entry, so pre-downloading a route was what *broke* the
      // offline map for every tile the map had not already fetched itself.
      await fetch(url);
    } catch (e) {
      console.warn('Failed to fetch style asset:', url, e);
    }
    currentAssets++;
    onProgress(currentAssets, totalAssets);
  }

  // 2. Fetch all vector tiles in small batches to avoid exhausting connections
  const BATCH_SIZE = 10;

  for (let i = 0; i < tiles.length; i += BATCH_SIZE) {
    const batch = tiles.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async ([z, x, y]) => {
        const url = `https://tiles.openfreemap.org/planet/${z}/${x}/${y}.pbf`;
        try {
          // fetch will be intercepted by the Service Worker and cached.
          // CORS mode, not no-cors — see the note on the style assets above.
          await fetch(url);
        } catch (e) {
          console.warn('Failed to fetch tile:', url, e);
        }
      }),
    );

    currentAssets += batch.length;
    onProgress(currentAssets, totalAssets);
  }

  // 3. Pre-cache weather forecasts for route waypoints
  if (route.waypoints?.length) {
    const sampleWps = route.waypoints.slice(0, 5);
    for (const wp of sampleWps) {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${wp.lat.toFixed(4)}&longitude=${wp.lon.toFixed(4)}&hourly=temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=3`;
        await fetch(url);
      } catch (e) {
        console.warn('Failed to pre-cache weather:', wp.name, e);
      }
    }
  }
}
