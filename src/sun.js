/**
 * sun.js — Solar calculations for Bikepacker Navigator.
 *
 * Uses SunCalc to calculate sunrise, sunset, and daylight pacing buffers
 * completely offline.
 *
 * @module sun
 */

import * as SunCalc from 'suncalc';

/**
 * Returns sunrise and sunset Date objects for a given coordinate and date.
 *
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {Date} [date] - Date to calculate for (defaults to today)
 * @returns {{ sunrise: Date, sunset: Date }}
 */
export function getSolarTimes(lat, lon, date = new Date()) {
  const times = SunCalc.getTimes(date, lat, lon);
  return {
    sunrise: times.sunrise,
    sunset: times.sunset,
  };
}

/**
 * Calculates the daylight pacing buffer and safety status.
 *
 * @param {import('./gpx.js').RouteContext} route - Current route
 * @param {number} currentMile - Rider's current mile marker
 * @param {number} paceMph - Rider's current pace in mph (minimum 1 mph)
 * @param {number} targetEndMile - The mile marker of the target camp/destination
 * @param {Date} [currentTime] - Current time (defaults to now)
 * @returns {{
 *   sunrise: Date,
 *   sunset: Date,
 *   eta: Date,
 *   bufferMinutes: number,
 *   status: 'ok' | 'warning' | 'alert'
 * }}
 */
export function calculateDaylightBuffer(
  route,
  currentMile,
  paceMph,
  targetEndMile,
  currentTime = new Date(),
) {
  const clampedPace = Math.max(1, paceMph);
  const remainingMiles = Math.max(0, targetEndMile - currentMile);
  const hoursNeeded = remainingMiles / clampedPace;

  // Find the coordinate of the destination to get the local sunset
  const trackPoints = route.trackPoints;
  let destLat = route.startPoint.lat;
  let destLon = route.startPoint.lon;

  if (trackPoints.length > 0) {
    // Snap targetEndMile to a track point index
    const fraction = Math.min(1, Math.max(0, targetEndMile / route.totalDistanceMiles));
    const idx = Math.min(trackPoints.length - 1, Math.floor(fraction * (trackPoints.length - 1)));
    [destLat, destLon] = trackPoints[idx];
  }

  const { sunrise, sunset } = getSolarTimes(destLat, destLon, currentTime);

  const eta = new Date(currentTime.getTime() + hoursNeeded * 60 * 60 * 1000);
  const bufferMinutes = (sunset.getTime() - eta.getTime()) / (60 * 1000);

  let status = 'ok';
  if (bufferMinutes < 30) {
    status = 'alert';
  } else if (bufferMinutes <= 60) {
    status = 'warning';
  }

  return {
    sunrise,
    sunset,
    eta,
    bufferMinutes,
    status,
  };
}
