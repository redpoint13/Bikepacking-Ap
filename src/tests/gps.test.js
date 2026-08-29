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

describe('GPSManager route snapping', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  /**
   * Out-and-back at a realistic recorded-GPX density: ~5 mi out, then back
   * along a line roughly 60 ft to the east — the geometry of any lollipop
   * loop stem or trail that parallels itself.
   */
  function makeOutAndBack() {
    const N = 1000;
    const stepLat = 0.0000724; // ~5 mi over N points
    const pts = [];
    for (let i = 0; i <= N; i++) pts.push([35 + i * stepLat, -111.0, 2000]);
    for (let i = N; i >= 0; i--) pts.push([35 + i * stepLat, -111.0002, 2000]);
    return pts;
  }

  it('keeps the reported mile on the outbound leg when GPS error nudges onto the return leg', () => {
    const pts = makeOutAndBack();
    const manager = new GPSManager({ ...makeRoute(), trackPoints: pts });

    // A clean fix halfway up the outbound leg.
    const first = manager._snapToRoute(35 + 500 * 0.0000724, -111.0);
    expect(first.trackIndex).toBe(500);

    // The next fix carries ~60 ft of eastward error, landing it exactly on the
    // return leg. Snapped globally this reads as the far side of the loop;
    // hinted off the previous fix it stays where the rider actually is.
    const second = manager._snapToRoute(35 + 510 * 0.0000724, -111.0002);
    expect(second.trackIndex).toBeLessThan(pts.length / 2);
    expect(second.mileFromStart).toBeGreaterThan(first.mileFromStart);
    expect(second.mileFromStart - first.mileFromStart).toBeLessThan(0.5);
  });

  it('falls back to a global search when the rider is nowhere near the hint', () => {
    const pts = makeOutAndBack();
    const manager = new GPSManager({ ...makeRoute(), trackPoints: pts });
    manager._snapToRoute(35, -111.0); // hint near the start

    // Shuttled far up the outbound leg — well outside the local window.
    const jumped = manager._snapToRoute(35 + 900 * 0.0000724, -111.0);
    expect(jumped.trackIndex).toBe(900);
  });

  it('publishes the snapped mile on each simulated fix', () => {
    vi.useFakeTimers();
    const route = makeRoute();
    const manager = new GPSManager(route);
    const updates = [];
    manager.onLocationUpdate((d) => updates.push(d));

    manager.startSimulation(1800, 2000);
    vi.advanceTimersByTime(2000);

    expect(updates[0]).toHaveProperty('mileFromStart');
    expect(updates[0]).toHaveProperty('trackIndex');
    manager.stop();
    vi.useRealTimers();
  });
});

describe('GPSManager status reporting', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('reports a denied location permission instead of only logging it', async () => {
    const watchPosition = vi.fn((_success, error) => {
      error({ code: 1, message: 'User denied Geolocation' });
      return 7;
    });
    vi.stubGlobal('navigator', { ...globalThis.navigator, geolocation: { watchPosition } });

    const manager = new GPSManager(makeRoute());
    const seen = [];
    manager.onStatusChange((s) => seen.push(s));

    await manager.startTracking();

    const last = seen[seen.length - 1];
    expect(last.state).toBe('denied');
    expect(last.message).toMatch(/permission denied/i);

    vi.unstubAllGlobals();
  });

  it('reports when no geolocation provider exists at all', async () => {
    vi.stubGlobal('navigator', { ...globalThis.navigator, geolocation: undefined });

    const manager = new GPSManager(makeRoute());
    const seen = [];
    manager.onStatusChange((s) => seen.push(s));

    await manager.startTracking();

    expect(seen[seen.length - 1].state).toBe('unsupported');
    vi.unstubAllGlobals();
  });

  it('clears back to ok once a fix arrives', async () => {
    const watchPosition = vi.fn((success) => {
      success({ coords: { latitude: 34.05, longitude: -118.0, accuracy: 8 } });
      return 9;
    });
    vi.stubGlobal('navigator', { ...globalThis.navigator, geolocation: { watchPosition } });

    const manager = new GPSManager(makeRoute());
    const seen = [];
    manager.onStatusChange((s) => seen.push(s));

    await manager.startTracking();

    expect(seen[seen.length - 1].state).toBe('ok');
    vi.unstubAllGlobals();
  });
});
