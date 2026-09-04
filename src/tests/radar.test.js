/**
 * radar.test.js — Riding-mode Resource Radar bottom sheet.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RadarController } from '../radar.js';

vi.mock('../audio.js', () => ({ speak: vi.fn() }));

/** @returns {import('../gpx.js').RouteContext} */
function makeRoute() {
  const trackPoints = [];
  for (let i = 0; i < 60; i++) trackPoints.push([35 + i * 0.01, -111, 2000]);
  return {
    name: 'Radar Route',
    totalDistanceMiles: 30,
    trackPoints,
    waypoints: [
      {
        id: 'w1',
        lat: 35.1,
        lon: -111,
        name: 'Oak Creek Spring',
        type: 'water',
        reliability: 90,
        distanceFromStartMi: 5,
      },
      {
        id: 'c1',
        lat: 35.2,
        lon: -111,
        name: 'Stealth Pine Camp',
        type: 'camping',
        distanceFromStartMi: 10,
      },
      {
        id: 'r1',
        lat: 35.3,
        lon: -111,
        name: 'Corner Store',
        type: 'resupply',
        distanceFromStartMi: 15,
      },
    ],
    bounds: { minLat: 35, maxLat: 35.6, minLon: -111, maxLon: -111 },
    startPoint: [35, -111],
    isLoop: false,
  };
}

function mountSheet() {
  document.body.innerHTML = `
    <div id="radar-bottom-sheet"><div class="radar-handle"></div></div>
    <span id="radar-water-next"></span>
    <div id="radar-water-list"></div>
    <span id="radar-camp-next"></span>
    <span id="radar-resupply-next"></span>
    <span id="radar-carry-req"></span>
    <span id="radar-dry-stretch"></span>`;
}

describe('RadarController', () => {
  beforeEach(() => {
    mountSheet();
    localStorage.clear();
  });

  it('reads camps by their real waypoint type, not "camp"', () => {
    // Regression: the sheet looked up type 'camp' while gpx.js assigns
    // 'camping', so the camp readout was permanently '--' on every route.
    const radar = new RadarController(makeRoute(), { onLocationUpdate: () => () => {} });
    radar.currentMile = 0;
    radar.updateUI();

    expect(document.getElementById('radar-water-next').textContent).toBe('5.0 mi');
    expect(document.getElementById('radar-camp-next').textContent).toBe('10.0 mi');
    expect(document.getElementById('radar-resupply-next').textContent).toBe('15.0 mi');
  });

  it('fires the camp proximity haptic on approach', async () => {
    const { speak } = await import('../audio.js');
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, vibrate });

    const radar = new RadarController(makeRoute(), { onLocationUpdate: () => () => {} });
    // 0.95 mi out from the camp at mile 10 — inside the 1.0 mi threshold band.
    radar.currentMile = 9.05;
    radar.checkHaptics();

    expect(vibrate).toHaveBeenCalled();
    expect(radar.hapticFired.camping['1.0']).toBe('c1');
    expect(speak).toHaveBeenCalledWith('Approaching camping in 1 mile.');

    vi.unstubAllGlobals();
  });
});
