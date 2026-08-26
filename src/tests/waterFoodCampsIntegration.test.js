import { describe, expect, it, vi } from 'vitest';
import { fetchLandOwnership } from '../camp.js';
import { mergeResupplySources } from '../resupply.js';
import { parseUSGSPercentileRdb } from '../water.js';

/**
 * Each of these pins an integration fault that passed every existing test
 * because the tests mirrored the code's assumptions rather than the API's
 * actual behaviour. All three failed silently in production.
 */

// ---------------------------------------------------------------------------
// Water — percentile stats
// ---------------------------------------------------------------------------

const RDB = [
  '# comment line',
  '# another',
  'agency_cd\tsite_no\tparameter_cd\tmonth_nu\tday_nu\tp10_va\tp25_va\tp50_va\tp75_va\tp90_va',
  '5s\t15s\t5s\t3n\t3n\t12s\t12s\t12s\t12s\t12s',
  'USGS\t09066510\t00060\t6\t1\t15\t17\t20\t22\t30',
  'USGS\t09066510\t00060\t9\t14\t3\t4\t6\t8\t11',
  'USGS\t09999999\t00060\t9\t14\t100\t200\t300\t400\t500',
].join('\n');

describe('parseUSGSPercentileRdb', () => {
  it('reads the percentiles for the current calendar day', () => {
    const stats = parseUSGSPercentileRdb(RDB, new Date(2026, 8, 14)); // 14 Sep
    expect(stats.get('09066510')).toEqual({ p10: 3, p25: 4, p50: 6, p75: 8, p90: 11 });
  });

  it('picks a different row on a different day, which is the point of asking', () => {
    const june = parseUSGSPercentileRdb(RDB, new Date(2026, 5, 1));
    // 20 cfs in June and in September mean very different things about a creek.
    expect(june.get('09066510').p50).toBe(20);
    expect(parseUSGSPercentileRdb(RDB, new Date(2026, 8, 14)).get('09066510').p50).toBe(6);
  });

  it('skips the column-type row rather than reading it as data', () => {
    const stats = parseUSGSPercentileRdb(RDB, new Date(2026, 8, 14));
    expect([...stats.keys()]).not.toContain('15s');
  });

  it('survives an empty, header-only or malformed body', () => {
    expect(parseUSGSPercentileRdb('').size).toBe(0);
    expect(parseUSGSPercentileRdb('# only comments').size).toBe(0);
    expect(parseUSGSPercentileRdb('a\tb\nc\td\n').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Food — ways as well as nodes
// ---------------------------------------------------------------------------

function routeFixture() {
  const trackPoints = [];
  for (let i = 0; i <= 40; i++) trackPoints.push([39.5 + i * 0.001, -106.0, 2800]);
  return { trackPoints, waypoints: [] };
}

describe('mergeResupplySources — ways', () => {
  it('accepts a way, whose position is a centroid rather than lat/lon', () => {
    // Supermarkets and hotels are routinely mapped as building polygons. The
    // node-only merge dropped every one of them.
    const way = {
      type: 'way',
      id: 42,
      center: { lat: 39.51, lon: -106.0 },
      tags: { shop: 'supermarket', name: 'Trail Market' },
    };
    const merged = mergeResupplySources(routeFixture(), [way]);
    expect(merged).toHaveLength(1);
    expect(merged[0].lat).toBeCloseTo(39.51);
    expect(merged[0].name).toContain('Trail Market');
  });

  it('keeps node ids unchanged so saved skip/force choices still match', () => {
    const node = { type: 'node', id: 7, lat: 39.51, lon: -106.0, tags: { shop: 'convenience' } };
    const merged = mergeResupplySources(routeFixture(), [node]);
    expect(merged[0].id).toBe('osm-resupply-7');
  });

  it('namespaces way ids, which share a numeric space with nodes', () => {
    const node = { type: 'node', id: 7, lat: 39.51, lon: -106.0, tags: { shop: 'convenience' } };
    const way = {
      type: 'way',
      id: 7,
      center: { lat: 39.53, lon: -106.0 },
      tags: { shop: 'supermarket' },
    };
    const merged = mergeResupplySources(routeFixture(), [node, way]);
    expect(new Set(merged.map((m) => m.id)).size).toBe(2);
    expect(merged.map((m) => m.id)).toContain('osm-resupply-way-7');
  });
});

// ---------------------------------------------------------------------------
// Camps — land ownership
// ---------------------------------------------------------------------------

describe('fetchLandOwnership', () => {
  it('treats an ArcGIS error body as a failure despite its HTTP 200', () => {
    // A missing service answers 200 with {"error":{...}}, so res.ok was true
    // and the old code read it as "no features" — silently returning the
    // permissive default for every camp.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ error: { code: 404, message: 'Service not found' } }),
      }),
    );
    return fetchLandOwnership(39.5, -106.0).then((r) => {
      expect(warn).toHaveBeenCalled();
      expect(r.landManager).toBeDefined();
      warn.mockRestore();
      vi.unstubAllGlobals();
    });
  });

  it('queries the Surface Management Agency layer, not the IDENTIFY layer', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ features: [] }) });
    vi.stubGlobal('fetch', spy);
    await fetchLandOwnership(39.5, -106.0);
    const url = spy.mock.calls[0][0];
    expect(url).toContain('BLM_Natl_SMA_Cached_with_PriUnk');
    expect(url).toMatch(/MapServer\/1\/query/);
    // HOLDING_NAME is not a field on this layer and fails the whole query.
    expect(url).not.toContain('HOLDING_NAME');
    vi.unstubAllGlobals();
  });

  it('reads the agency code and reports private land as not dispersible', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ features: [{ attributes: { ADMIN_AGENCY_CODE: 'PVT' } }] }),
      }),
    );
    const r = await fetchLandOwnership(39.5, -106.0);
    expect(r.landManager).toBe('Private');
    expect(r.isDispersedLegal).toBe(false);
    vi.unstubAllGlobals();
  });
});
