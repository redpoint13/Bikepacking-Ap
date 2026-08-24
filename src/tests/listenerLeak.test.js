import 'fake-indexeddb/auto';
/**
 * listenerLeak.test.js — Regression guard for unbounded listener growth.
 *
 * The 'bpnav-highlight-segment' listener used to be registered inside
 * showMapSection, which runs on every route load, so handlers accumulated
 * without bound across route changes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../app.js';

// Capture initMap's arguments while still running the real implementation.
const { initMapArgs } = vi.hoisted(() => ({ initMapArgs: [] }));

vi.mock('../map.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initMap: (...args) => {
      initMapArgs.push(args);
      return actual.initMap(...args);
    },
  };
});

const SMALL_GPX = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Leak Test</name><trkseg>
    <trkpt lat="35.000" lon="-111.000"><ele>2000</ele></trkpt>
    <trkpt lat="35.010" lon="-111.010"><ele>2010</ele></trkpt>
    <trkpt lat="35.020" lon="-111.020"><ele>2020</ele></trkpt>
  </trkseg></trk>
</gpx>`;

let added;
let origAdd;

beforeEach(() => {
  // jsdom implements neither of these; showMapSection calls both.
  Element.prototype.scrollIntoView = vi.fn();
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null);

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, text: async () => SMALL_GPX })),
  );

  added = [];
  initMapArgs.length = 0;
  origAdd = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, fn, opts) => {
    added.push(type);
    return origAdd(type, fn, opts);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const countHighlight = () => added.filter((t) => t === 'bpnav-highlight-segment').length;

describe('map initialisation', () => {
  // Regression: initMap was called as initMap('map', route, [], []).
  // The [] for activeStopIds is an Array where a Set is required — .has() would
  // throw — and the [] for customWaypoints suppressed every marker at init,
  // leaving the map bare until the first syncMapState.
  it('passes a Set for activeStopIds and the route waypoints', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    renderApp(container);

    const demoBtn = container.querySelector('#load-demo-btn');
    demoBtn.click();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 80));

    expect(initMapArgs).toHaveLength(1);
    const [, route, activeStopIds, customWaypoints] = initMapArgs[0];
    expect(activeStopIds).toBeInstanceOf(Set);
    expect(Array.isArray(customWaypoints)).toBe(true);
    expect(customWaypoints).toBe(route.waypoints);
  });
});

describe('bpnav-highlight-segment listener', () => {
  it('is registered exactly once when the app mounts', () => {
    renderApp(document.createElement('div'));
    expect(countHighlight()).toBe(1);
  });

  it('does not accumulate across repeated route loads', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    renderApp(container);

    const afterMount = countHighlight();

    // Load the demo route several times over — each load previously added
    // another listener that was never removed.
    const demoBtn = container.querySelector('#load-demo-btn');
    expect(demoBtn).toBeTruthy();

    for (let i = 0; i < 5; i++) {
      demoBtn.click();
      // Let the async import flow (fetch + parseGPXAsync + applyRoute) settle.
      // The wait must exceed syncMapState's 40ms debounce so its timer fires
      // inside the test rather than escaping into a later test file.
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 80));
    }

    expect(countHighlight()).toBe(afterMount);
  });
});
