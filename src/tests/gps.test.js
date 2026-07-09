/**
 * gps.test.js — Unit tests for GPS tracking and simulation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GPSManager } from '../gps.js';

/** @returns {import('../gpx.js').RouteContext} */
function makeRoute() {
  return {
    name: 'Test Route',
    totalDistanceMiles: 10,
    trackPoints: [
      [34.0, -118.0], // 0 miles
      [34.1, -118.0], // ~6.9 miles
      [34.2, -118.0], // ~13.8 miles
    ],
    bounds: { minLat: 34.0, maxLat: 34.2, minLon: -118.0, maxLon: -118.0 },
    startOffsetMi: 0,
    isLoop: false,
    waypoints: [],
    startPoint: { lat: 34.0, lon: -118.0 },
  };
}

describe('GPSManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows registering and triggering callbacks', () => {
    const manager = new GPSManager(makeRoute());
    let called = false;
    let dataReceived = null;

    manager.onLocationUpdate((data) => {
      called = true;
      dataReceived = data;
    });

    manager._trigger({ lat: 34.5, lon: -118.5, accuracy: 10 });

    expect(called).toBe(true);
    expect(dataReceived).toEqual({ lat: 34.5, lon: -118.5, accuracy: 10 });
  });

  it('simulates movement along the route track points', () => {
    const route = makeRoute();
    const manager = new GPSManager(route);
    const updates = [];

    manager.onLocationUpdate((data) => {
      updates.push(data);
    });

    // Start simulation at 1800 mph (30 miles per minute, 1 mile every 2 seconds)
    // with 2-second tick interval.
    manager.startSimulation(1800, 2000);

    // Initial state: no updates yet
    expect(updates.length).toBe(0);

    // Fast-forward 2 seconds (1 tick) -> should have moved 1 mile
    vi.advanceTimersByTime(2000);
    expect(updates.length).toBe(1);
    // The rider is at 1 mile, which is between point 0 and point 1.
    // The simulator snaps to the point corresponding to the distance, so it should be at index 0.
    expect(updates[0].lat).toBe(34.0);
    expect(updates[0].lon).toBe(-118.0);

    // Fast-forward another 12 seconds (6 ticks total = 7 miles) -> should snap to point 1 (34.1)
    vi.advanceTimersByTime(12000);
    expect(updates.length).toBe(7);
    expect(updates[6].lat).toBe(34.1);
    expect(updates[6].lon).toBe(-118.0);

    manager.stop();
  });
});
