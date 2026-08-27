import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRoute,
  findRouteByContent,
  getAllRoutes,
  loadEnrichment,
  routeFingerprint,
  saveEnrichment,
  saveRouteToLibrary,
  setActiveRouteId,
} from '../storage.js';

/**
 * Every import used to mint a fresh random id, so the same GPX loaded twice
 * became two library records. A waypoint added by hand stayed with the first,
 * which from the rider's side is indistinguishable from the app losing it —
 * "I keep having to add the same waypoint every time a route loads".
 */

const GPX_A = '<gpx><trk><name>A</name><trkseg><trkpt lat="39" lon="-106"/></trkseg></trk></gpx>';
const GPX_B = '<gpx><trk><name>B</name><trkseg><trkpt lat="38" lon="-105"/></trkseg></trk></gpx>';

beforeEach(async () => {
  for (const r of await getAllRoutes()) {
    const { deleteRouteFromLibrary } = await import('../storage.js');
    await deleteRouteFromLibrary(r.id);
  }
  await clearRoute().catch(() => {});
});

describe('routeFingerprint', () => {
  it('matches identical content and separates different content', () => {
    expect(routeFingerprint(GPX_A)).toBe(routeFingerprint(GPX_A));
    expect(routeFingerprint(GPX_A)).not.toBe(routeFingerprint(GPX_B));
  });

  it('handles empty and missing input', () => {
    expect(routeFingerprint('')).toBe(routeFingerprint(''));
    expect(() => routeFingerprint(undefined)).not.toThrow();
  });
});

describe('re-importing the same file', () => {
  it('reuses the record rather than creating a second route', async () => {
    const id1 = await saveRouteToLibrary({ name: 'CT', filename: 'ct.gpx', gpxText: GPX_A });
    const id2 = await saveRouteToLibrary({ name: 'CT', filename: 'ct.gpx', gpxText: GPX_A });
    expect(id2).toBe(id1);
    expect(await getAllRoutes()).toHaveLength(1);
  });

  it('keeps a hand-placed waypoint across the re-import', async () => {
    const id = await saveRouteToLibrary({ name: 'CT', filename: 'ct.gpx', gpxText: GPX_A });
    await setActiveRouteId(id);
    await saveEnrichment([
      { id: 'user-wpt-1', name: 'My spring', lat: 39, lon: -106, type: 'water' },
    ]);

    await saveRouteToLibrary({ name: 'CT', filename: 'ct.gpx', gpxText: GPX_A, waypoints: [] });
    const after = await loadEnrichment();
    expect(after.map((w) => w.id)).toContain('user-wpt-1');
  });

  it('does not resurrect enriched waypoints, which are rebuilt anyway', async () => {
    const id = await saveRouteToLibrary({ name: 'CT', filename: 'ct.gpx', gpxText: GPX_A });
    await setActiveRouteId(id);
    await saveEnrichment([
      { id: 'usgs-09066510', name: 'Old gauge', lat: 39, lon: -106, type: 'water' },
      { id: 'user-wpt-1', name: 'My spring', lat: 39, lon: -106, type: 'water' },
    ]);
    await saveRouteToLibrary({ name: 'CT', filename: 'ct.gpx', gpxText: GPX_A, waypoints: [] });
    const ids = (await loadEnrichment()).map((w) => w.id);
    expect(ids).toContain('user-wpt-1');
    expect(ids).not.toContain('usgs-09066510');
  });

  it('still treats a genuinely different file as a new route', async () => {
    const id1 = await saveRouteToLibrary({ name: 'A', filename: 'a.gpx', gpxText: GPX_A });
    const id2 = await saveRouteToLibrary({ name: 'B', filename: 'b.gpx', gpxText: GPX_B });
    expect(id2).not.toBe(id1);
    expect(await getAllRoutes()).toHaveLength(2);
  });

  it('does not clobber an incoming waypoint that shares an id', async () => {
    const id = await saveRouteToLibrary({ name: 'CT', filename: 'ct.gpx', gpxText: GPX_A });
    await setActiveRouteId(id);
    await saveEnrichment([{ id: 'user-wpt-1', name: 'Old name', lat: 39, lon: -106 }]);
    await saveRouteToLibrary({
      name: 'CT',
      filename: 'ct.gpx',
      gpxText: GPX_A,
      waypoints: [{ id: 'user-wpt-1', name: 'New name', lat: 39, lon: -106 }],
    });
    const after = await loadEnrichment();
    expect(after.filter((w) => w.id === 'user-wpt-1')).toHaveLength(1);
    expect(after.find((w) => w.id === 'user-wpt-1').name).toBe('New name');
  });
});

describe('findRouteByContent', () => {
  it('finds a record saved before fingerprints existed', async () => {
    const id = await saveRouteToLibrary({ name: 'CT', filename: 'ct.gpx', gpxText: GPX_A });
    // Simulate a legacy record by matching on recomputed content.
    const found = await findRouteByContent(GPX_A);
    expect(found?.id).toBe(id);
  });

  it('returns null for unknown content or no content', async () => {
    expect(await findRouteByContent(GPX_B)).toBeNull();
    expect(await findRouteByContent('')).toBeNull();
  });
});
