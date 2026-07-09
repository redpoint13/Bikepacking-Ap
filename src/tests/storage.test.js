/**
 * storage.test.js -- Unit tests for the IndexedDB persistence module.
 *
 * Uses fake-indexeddb to provide a full in-memory IDB implementation
 * without needing a real browser environment.
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearEnrichment,
  clearRoute,
  exportPlanBundle,
  loadEnrichment,
  loadRoute,
  saveEnrichment,
  savePlanOptions,
  saveRoute,
} from '../storage.js';

// Reset the fake IndexedDB between tests -- clear both route and enrichment.
afterEach(async () => {
  await clearRoute();
  await clearEnrichment();
});

describe('saveRoute / loadRoute', () => {
  it('returns null when nothing has been saved', async () => {
    const result = await loadRoute();
    expect(result).toBeNull();
  });

  it('persists and retrieves gpxText and filename', async () => {
    await saveRoute('<gpx/>', 'test.gpx');
    const result = await loadRoute();
    expect(result).not.toBeNull();
    expect(result.gpxText).toBe('<gpx/>');
    expect(result.filename).toBe('test.gpx');
  });

  it('stores a savedAt timestamp', async () => {
    const before = Date.now();
    await saveRoute('<gpx/>', 'test.gpx');
    const after = Date.now();
    const result = await loadRoute();
    expect(result.savedAt).toBeGreaterThanOrEqual(before);
    expect(result.savedAt).toBeLessThanOrEqual(after);
  });

  it('overwrites the previous route on a second save', async () => {
    await saveRoute('<gpx id="first"/>', 'first.gpx');
    await saveRoute('<gpx id="second"/>', 'second.gpx');
    const result = await loadRoute();
    expect(result.gpxText).toBe('<gpx id="second"/>');
    expect(result.filename).toBe('second.gpx');
  });
});

describe('clearRoute', () => {
  it('removes a previously saved route', async () => {
    await saveRoute('<gpx/>', 'test.gpx');
    await clearRoute();
    const result = await loadRoute();
    expect(result).toBeNull();
  });

  it('is a no-op when nothing is stored', async () => {
    await expect(clearRoute()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Enrichment cache
// ---------------------------------------------------------------------------

const SAMPLE_WAYPOINTS = [
  { id: 'w1', lat: 35.1, lon: -111.5, name: 'Spring', type: 'water', distanceFromStartMi: 5.2 },
  {
    id: 'r1',
    lat: 35.2,
    lon: -111.6,
    name: 'General Store',
    type: 'resupply',
    distanceFromStartMi: 12.0,
  },
];

describe('saveEnrichment / loadEnrichment', () => {
  it('returns null when no enrichment has been saved', async () => {
    const result = await loadEnrichment();
    expect(result).toBeNull();
  });

  it('persists and retrieves the waypoints array', async () => {
    await saveEnrichment(SAMPLE_WAYPOINTS);
    const result = await loadEnrichment();
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('w1');
    expect(result[1].id).toBe('r1');
  });

  it('preserves all waypoint fields through a round-trip', async () => {
    await saveEnrichment(SAMPLE_WAYPOINTS);
    const [wp] = await loadEnrichment();
    expect(wp.lat).toBe(35.1);
    expect(wp.lon).toBe(-111.5);
    expect(wp.type).toBe('water');
    expect(wp.distanceFromStartMi).toBe(5.2);
  });

  it('overwrites previously saved enrichment on a second save', async () => {
    await saveEnrichment(SAMPLE_WAYPOINTS);
    const updated = [{ id: 'w2', type: 'water', distanceFromStartMi: 8.0 }];
    await saveEnrichment(updated);
    const result = await loadEnrichment();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('w2');
  });

  it('persists an empty array without error', async () => {
    await saveEnrichment([]);
    const result = await loadEnrichment();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});

describe('clearEnrichment', () => {
  it('removes previously saved enrichment', async () => {
    await saveEnrichment(SAMPLE_WAYPOINTS);
    await clearEnrichment();
    const result = await loadEnrichment();
    expect(result).toBeNull();
  });

  it('is a no-op when nothing is stored', async () => {
    await expect(clearEnrichment()).resolves.not.toThrow();
  });
});

describe('exportPlanBundle', () => {
  it('throws an error if no route is stored', async () => {
    await clearRoute();
    await expect(exportPlanBundle()).rejects.toThrow('No route loaded to export.');
  });

  it('compiles route GPX, enrichment waypoints, and plan options', async () => {
    await saveRoute('gpx-content', 'coconino.gpx');
    await saveEnrichment([{ id: 'wp-1', type: 'water' }]);
    await savePlanOptions({ targetDailyMiles: 45 });

    const bundle = await exportPlanBundle();
    expect(bundle.version).toBe('1.0');
    expect(bundle.filename).toBe('coconino.gpx');
    expect(bundle.gpxText).toBe('gpx-content');
    expect(bundle.waypoints).toEqual([{ id: 'wp-1', type: 'water' }]);
    expect(bundle.options.targetDailyMiles).toBe(45);
  });
});
