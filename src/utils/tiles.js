/**
 * utils/tiles.js — Slippy Map tile coordinate calculations.
 */

/**
 * Converts longitude to tile X coordinate at a given zoom level.
 * @param {number} lon
 * @param {number} zoom
 * @returns {number}
 */
export function lon2tile(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

/**
 * Converts latitude to tile Y coordinate at a given zoom level.
 * @param {number} lat
 * @param {number} zoom
 * @returns {number}
 */
export function lat2tile(lat, zoom) {
  const latRad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1.0 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2.0) *
      Math.pow(2, zoom),
  );
}

/**
 * Calculates a unique set of tile coordinates [z, x, y] needed to cover a route corridor.
 * Extends the coverage by a 1-tile buffer in all directions.
 *
 * @param {import('../gpx.js').RouteContext} route
 * @param {number} minZoom
 * @param {number} maxZoom
 * @returns {Array<[number, number, number]>} List of [z, x, y] tuples
 */
export function getTilesForRoute(route, minZoom, maxZoom) {
  const tileSet = new Set();
  const trackPoints = route.trackPoints || [];

  if (trackPoints.length === 0) return [];

  // For very long routes, checking every single track point is overkill.
  // We can sample points (e.g. every 10th point) since the 1-tile buffer
  // ensures continuous coverage at these zoom levels.
  const sampleRate = 10; 

  for (let z = minZoom; z <= maxZoom; z++) {
    for (let i = 0; i < trackPoints.length; i += sampleRate) {
      const [lat, lon] = trackPoints[i];
      const cx = lon2tile(lon, z);
      const cy = lat2tile(lat, z);

      // Add the centre tile and a 1-tile buffer in all 8 directions
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const x = cx + dx;
          const y = cy + dy;
          tileSet.add(`${z},${x},${y}`);
        }
      }
    }
  }

  return Array.from(tileSet).map((str) => {
    const [z, x, y] = str.split(',').map(Number);
    return [z, x, y];
  });
}
