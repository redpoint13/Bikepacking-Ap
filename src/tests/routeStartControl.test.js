import { beforeEach, describe, expect, it } from 'vitest';
import { initMap, setMapRouteStart } from '../map.js';

/**
 * The map ships MapLibre's locate-me control, but getting back to the start of
 * the route after panning down it had no equivalent. "Start at mile" moves the
 * rider's start without rebuilding the map, so these pin that the control
 * follows it rather than stranding at the original trailhead.
 */

function makeRoute(extra = {}) {
  const trackPoints = [];
  for (let i = 0; i <= 100; i++) trackPoints.push([35 + i * 0.01, -111 - i * 0.01, 1000]);
  return {
    name: 'T',
    totalDistanceMiles: 50,
    trackPoints,
    waypoints: [],
    bounds: { minLat: 35, maxLat: 36, minLon: -112, maxLon: -111 },
    startOffsetMi: 0,
    ...extra,
  };
}

let container;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

describe('route start control', () => {
  it('adds a labelled button alongside the other map controls', () => {
    initMap(container, makeRoute());
    const btn = container.querySelector('.bpnav-ctrl-route-start');
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-label')).toMatch(/start of the route/i);
    expect(btn.title).toMatch(/start of the route/i);
  });

  it('flies to the start of the route when clicked', () => {
    const map = initMap(container, makeRoute());
    const calls = [];
    map.flyTo = (opts) => calls.push(opts);
    container.querySelector('.bpnav-ctrl-route-start').click();
    expect(calls).toHaveLength(1);
    const [lon, lat] = calls[0].center;
    expect(lat).toBeCloseTo(35, 1);
    expect(lon).toBeCloseTo(-111, 1);
  });

  it('follows the start when applyStartOffset moves it', () => {
    const map = initMap(container, makeRoute());
    const calls = [];
    map.flyTo = (opts) => calls.push(opts);

    // Rider now starts a good way down the route.
    setMapRouteStart(map, makeRoute({ startOffsetMi: 25 }));
    container.querySelector('.bpnav-ctrl-route-start').click();

    const [, lat] = calls[0].center;
    expect(lat).toBeGreaterThan(35.1); // moved along the track, not the trailhead
  });

  it('does nothing rather than throwing when no start is known', () => {
    const map = initMap(container, makeRoute());
    const calls = [];
    map.flyTo = (opts) => calls.push(opts);
    setMapRouteStart(map, { trackPoints: [] });
    setMapRouteStart(null, makeRoute());
    expect(() => container.querySelector('.bpnav-ctrl-route-start').click()).not.toThrow();
  });
});
