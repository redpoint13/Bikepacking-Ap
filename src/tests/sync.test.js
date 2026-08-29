/**
 * sync.test.js — Offline map pre-download.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncOfflineMap } from '../sync.js';

/** @returns {import('../gpx.js').RouteContext} */
function makeRoute() {
  return {
    name: 'Tiny Route',
    totalDistanceMiles: 1,
    trackPoints: [
      [35.0, -111.0, 2000],
      [35.01, -111.01, 2050],
    ],
    waypoints: [],
    bounds: { minLat: 35.0, maxLat: 35.01, minLon: -111.01, maxLon: -111.0 },
    startPoint: [35.0, -111.0],
    isLoop: false,
  };
}

describe('syncOfflineMap', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never requests tiles or style assets in no-cors mode', async () => {
    // Regression: `mode: 'no-cors'` yields an opaque response, the Workbox rule
    // caches it (statuses [0, 200]), and the browser then refuses to hand an
    // opaque response to MapLibre's CORS-mode request — so pre-downloading a
    // route poisoned the cache and broke the offline map it was meant to
    // guarantee. OpenFreeMap sends `access-control-allow-origin: *`, so a
    // plain CORS fetch works and is cacheable.
    await syncOfflineMap(makeRoute(), () => {});

    expect(fetchMock).toHaveBeenCalled();
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.mode).not.toBe('no-cors');
    }
  });

  it('fetches the style, sprites and vector tiles, reporting progress to completion', async () => {
    const progress = [];
    await syncOfflineMap(makeRoute(), (current, total) => progress.push([current, total]));

    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toContain('https://tiles.openfreemap.org/styles/liberty');
    expect(urls.some((u) => /\/planet\/\d+\/\d+\/\d+\.pbf$/.test(u))).toBe(true);

    const [lastCurrent, lastTotal] = progress[progress.length - 1];
    expect(lastCurrent).toBe(lastTotal);
  });

  it('keeps going when individual tiles fail', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const progress = [];
    await expect(
      syncOfflineMap(makeRoute(), (c, t) => progress.push([c, t])),
    ).resolves.toBeUndefined();
    const [lastCurrent, lastTotal] = progress[progress.length - 1];
    expect(lastCurrent).toBe(lastTotal);
  });
});
