/**
 * library.test.js — Unit tests for the Multi-Route Library in storage.js.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRoute,
  deleteRouteFromLibrary,
  getActiveRouteId,
  getAllRoutes,
  getRouteById,
  saveRouteToLibrary,
  setActiveRouteId,
} from '../storage.js';

describe('Multi-Route Library Storage', () => {
  beforeEach(async () => {
    await clearRoute();
    const all = await getAllRoutes();
    for (const r of all) {
      await deleteRouteFromLibrary(r.id);
    }
  });

  it('saves and retrieves multiple routes from the library', async () => {
    const id1 = await saveRouteToLibrary({
      name: 'Coconino Loop',
      filename: 'coconino.gpx',
      gpxText: '<gpx>coconino</gpx>',
      totalDistanceMiles: 248.5,
    });

    const id2 = await saveRouteToLibrary({
      name: 'Black Canyon Trail',
      filename: 'bct.gpx',
      gpxText: '<gpx>bct</gpx>',
      totalDistanceMiles: 78.2,
    });

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();

    const all = await getAllRoutes();
    expect(all.length).toBe(2);
    expect(all.map((r) => r.name)).toContain('Coconino Loop');
    expect(all.map((r) => r.name)).toContain('Black Canyon Trail');
  });

  it('retrieves a single route by ID', async () => {
    const id = await saveRouteToLibrary({
      name: 'Sedona Gravel Loop',
      filename: 'sedona.gpx',
      gpxText: '<gpx>sedona</gpx>',
      totalDistanceMiles: 42.1,
      waypoints: [{ id: 'w-1', name: 'Red Rock Creek', type: 'water' }],
    });

    const route = await getRouteById(id);
    expect(route).not.toBeNull();
    expect(route.name).toBe('Sedona Gravel Loop');
    expect(route.totalDistanceMiles).toBe(42.1);
    expect(route.waypoints.length).toBe(1);
    expect(route.waypoints[0].name).toBe('Red Rock Creek');
  });

  it('deletes a route from the library', async () => {
    const id = await saveRouteToLibrary({
      name: 'Temporary Route',
      filename: 'temp.gpx',
      gpxText: '<gpx>temp</gpx>',
    });

    let all = await getAllRoutes();
    expect(all.length).toBe(1);

    await deleteRouteFromLibrary(id);

    all = await getAllRoutes();
    expect(all.length).toBe(0);
  });

  it('tracks and switches the active route ID', async () => {
    const id1 = await saveRouteToLibrary({
      name: 'Route A',
      filename: 'a.gpx',
      gpxText: '<gpx>a</gpx>',
    });
    const id2 = await saveRouteToLibrary({
      name: 'Route B',
      filename: 'b.gpx',
      gpxText: '<gpx>b</gpx>',
    });

    await setActiveRouteId(id1);
    expect(await getActiveRouteId()).toBe(id1);

    await setActiveRouteId(id2);
    expect(await getActiveRouteId()).toBe(id2);
  });
});
