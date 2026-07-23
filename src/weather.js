/**
 * weather.js — Open-Meteo Weather & Wind Vector Engine.
 */

/**
 * Fetches hourly weather forecast for a lat/lon coordinate from Open-Meteo API.
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<{
 *   tempF: number,
 *   windSpeedMph: number,
 *   windDirDeg: number,
 *   precipProbPercent: number,
 *   cachedAt: string
 * }|null>}
 */
export async function fetchWeatherForecast(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&hourly=temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=3`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();

    const hourly = data.hourly || {};
    const temps = hourly.temperature_2m || [];
    const winds = hourly.wind_speed_10m || [];
    const dirs = hourly.wind_direction_10m || [];
    const precips = hourly.precipitation_probability || [];

    if (!temps.length) return null;

    // Pick current hour or first available forecast
    const currentIdx = 0;

    return {
      tempF: Math.round(temps[currentIdx] ?? 70),
      windSpeedMph: Math.round(winds[currentIdx] ?? 5),
      windDirDeg: Math.round(dirs[currentIdx] ?? 0),
      precipProbPercent: Math.round(precips[currentIdx] ?? 0),
      cachedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn('[BPNav] Failed to fetch Open-Meteo weather:', err);
    return null;
  }
}

/**
 * Returns wind direction compass cardinal (N, NE, E, SE, S, SW, W, NW).
 * @param {number} deg
 * @returns {string}
 */
export function windDirectionCardinal(deg) {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round(((deg % 360) / 45)) % 8;
  return directions[idx];
}
