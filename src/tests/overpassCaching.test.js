import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOverpass } from '../gpx.js';

/**
 * The service worker caches Overpass responses so water, camp and resupply data
 * survives a ride out of signal. The Cache API cannot store a response to a POST
 * request, so the request method is what makes that caching work at all — these
 * pin it, since a silent regression to POST would leave the rule inert and only
 * show up in the backcountry.
 */

afterEach(() => vi.unstubAllGlobals());

function stubFetch(impl) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

const ok = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ elements: [] }) });

describe('fetchOverpass', () => {
  it('issues a cacheable GET with the query in the URL', async () => {
    const spy = stubFetch(ok);
    await fetchOverpass('[out:json];node(1,2,3,4);out;');
    const [url, init] = spy.mock.calls[0];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(url).toContain('?data=');
    expect(decodeURIComponent(url)).toContain('[out:json];node(1,2,3,4);out;');
  });

  it('sends the same URL for the same query, so the cache can match it', async () => {
    const spy = stubFetch(ok);
    await fetchOverpass('[out:json];node(1);out;');
    await fetchOverpass('[out:json];node(1);out;');
    expect(spy.mock.calls[0][0]).toBe(spy.mock.calls[1][0]);
  });

  it('rotates mirrors on failure, all of which the service worker caches', async () => {
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
