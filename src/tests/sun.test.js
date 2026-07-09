/**
 * sun.test.js — Unit tests for solar and daylight buffer calculations.
 */

import { describe, expect, it } from 'vitest';
import { calculateDaylightBuffer, getSolarTimes } from '../sun.js';

/** @returns {import('../gpx.js').RouteContext} */
function makeRoute() {
  return {
    name: 'Test Route',
    totalDistanceMiles: 50,
    trackPoints: [
      [51.5074, -0.1278], // London (start)
      [51.5074, -0.0278], // midpoint
      [51.5074, 0.0722], // end
    ],
    bounds: { minLat: 51.4, maxLat: 51.6, minLon: -0.2, maxLon: 0.1 },
    startOffsetMi: 0,
    isLoop: false,
    waypoints: [],
    startPoint: { lat: 51.5074, lon: -0.1278 },
  };
}

describe('getSolarTimes', () => {
  it('returns sunrise and sunset Dates', () => {
    const times = getSolarTimes(51.5074, -0.1278, new Date('2026-06-30T12:00:00Z'));
    expect(times.sunrise).toBeInstanceOf(Date);
    expect(times.sunset).toBeInstanceOf(Date);
  });
});

describe('calculateDaylightBuffer', () => {
  it('returns status ok when arrival is well before sunset', () => {
    const route = makeRoute();
    const baseTime = new Date('2026-06-30T12:00:00Z');
    const { sunset } = getSolarTimes(51.5074, 0.0722, baseTime);

    // London sunset in June is around 20:20 UTC.
    // Set currentTime to 4 hours before sunset. Both are on June 30th UTC.
    const currentTime = new Date(sunset.getTime() - 4 * 60 * 60 * 1000);
    // We want a 180 minute (3 hour) buffer.
    // timeNeeded = 4h - 3h = 1 hour.
    // pace = 10 / 1 = 10 mph.
    const result = calculateDaylightBuffer(route, 40, 10, 50, currentTime);

    expect(result.status).toBe('ok');
    expect(result.bufferMinutes).toBeCloseTo(180, 0);
  });

  it('returns status warning when arrival is 30-60 minutes before sunset', () => {
    const route = makeRoute();
    const baseTime = new Date('2026-06-30T12:00:00Z');
    const { sunset } = getSolarTimes(51.5074, 0.0722, baseTime);

    // Set currentTime to 2 hours before sunset.
    const currentTime = new Date(sunset.getTime() - 2 * 60 * 60 * 1000);
    // We want a 45 minute buffer.
    // timeNeeded = 120m - 45m = 75m = 1.25h.
    // pace = 10 / 1.25 = 8 mph.
    const result = calculateDaylightBuffer(route, 40, 8, 50, currentTime);
    expect(result.status).toBe('warning');
    expect(result.bufferMinutes).toBeCloseTo(45, 0);
  });

  it('returns status alert when arrival is less than 30 minutes before sunset', () => {
    const route = makeRoute();
    const baseTime = new Date('2026-06-30T12:00:00Z');
    const { sunset } = getSolarTimes(51.5074, 0.0722, baseTime);

    // Set currentTime to 2 hours before sunset.
    const currentTime = new Date(sunset.getTime() - 2 * 60 * 60 * 1000);
    // We want a 15 minute buffer.
    // timeNeeded = 120m - 15m = 105m = 1.75h.
    // pace = 10 / 1.75 = 5.714 mph.
    const result = calculateDaylightBuffer(route, 40, 5.714, 50, currentTime);
    expect(result.status).toBe('alert');
    expect(result.bufferMinutes).toBeCloseTo(15, 0);
  });

  it('returns status alert when arrival is after sunset', () => {
    const route = makeRoute();
    const baseTime = new Date('2026-06-30T12:00:00Z');
    const { sunset } = getSolarTimes(51.5074, 0.0722, baseTime);

    // Set currentTime to 2 hours before sunset.
    const currentTime = new Date(sunset.getTime() - 2 * 60 * 60 * 1000);
    // We want a negative 30 minute buffer (arrival 30m after sunset).
    // timeNeeded = 120m - (-30m) = 150m = 2.5h.
    // pace = 10 / 2.5 = 4 mph.
    const result = calculateDaylightBuffer(route, 40, 4, 50, currentTime);
    expect(result.status).toBe('alert');
    expect(result.bufferMinutes).toBeCloseTo(-30, 0);
  });
});
