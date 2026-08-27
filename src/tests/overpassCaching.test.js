import { afterEach, describe, expect, it, vi } from 'vitest';
import { OVERPASS_CLIENT_TIMEOUT_MS, fetchOverpass } from '../gpx.js';

/**
 * Overpass must be queried with POST. #13 switched it to GET so the service
 * worker could cache the responses — the Cache API cannot store a response to a
 * POST — and that broke enrichment outright: measured back to back on the same
 * query and endpoint, POST returned HTTP 200 with 1,221 campsites while GET
 * returned HTTP 429. Overpass rate-limits GET far more aggressively and
 * documents POST as the interface for real queries.
 *
 * Nothing is given up by that. Water, camp and resupply data survives a ride out
 * of signal through the IndexedDB enrichment cache in storage.js, which is
 * method-agnostic; there is deliberately no service-worker rule for Overpass,
 * since with POST it could never match.
 *
 * These pin the method, and that the client abort outlasts the server-side
 * timeout the queries ask for — a regression in either is invisible until a
 * rider is somewhere without campsites.
 */

afterEach(() => vi.unstubAllGlobals());

function stubFetch(impl) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

const ok = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ elements: [] }) });

describe('fetchOverpass', () => {
  it('POSTs the query, because GET is rate-limited into uselessness', async () => {
    // Measured back to back on the same query and endpoint: POST returned
    // HTTP 200 with 1,221 campsites, GET returned HTTP 429. #13 switched this
    // to GET so the service worker could cache responses and broke enrichment
    // outright; offline survival comes from the IndexedDB cache instead.
    const spy = stubFetch(ok);
    await fetchOverpass('[out:json];node(1,2,3,4);out;');
    const [url, init] = spy.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(url).not.toContain('?data=');
    expect(init.body).toContain('data=');
    expect(decodeURIComponent(init.body)).toContain('[out:json];node(1,2,3,4);out;');
  });

  it('waits longer than the server-side timeout the query asks for', async () => {
    // The queries declare [out:json][timeout:25]. Aborting the client at 15s
    // cancelled queries the server was still legitimately working on — a camp
    // query over a long corridor takes about 12s.
    const spy = stubFetch(ok);
    await fetchOverpass('[out:json][timeout:25];node(1);out;');
    const signal = spy.mock.calls[0][1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    // Recreate what the code passes: anything at or below 25s is too short.
    expect(OVERPASS_CLIENT_TIMEOUT_MS).toBeGreaterThan(25_000);
  });

  it('rotates mirrors on failure, all of which are tried before giving up', async () => {
    const seen = [];
    stubFetch((url) => {
      seen.push(new URL(url).host);
      return seen.length < 3 ? Promise.reject(new Error('down')) : ok();
    });
    await fetchOverpass('[out:json];node(1);out;');
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen).size).toBeGreaterThan(1);
  });
});

describe('fetchOverpass mirror coverage', () => {
  it('tries every mirror before giving up', async () => {
    // The loop ran three attempts over a four-entry list, so the last mirror
    // was unreachable code. On a network where only that one is reachable —
    // which is exactly the case this was found on — enrichment could never
    // succeed at all.
    const tried = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        tried.push(new URL(url).host);
        throw new Error('unreachable');
      }),
    );
    await expect(fetchOverpass('[out:json];node(1);out;')).rejects.toThrow();
    expect(new Set(tried).size).toBeGreaterThanOrEqual(4);
    expect(tried).toContain('overpass.kumi.systems');
    vi.unstubAllGlobals();
  });
});
