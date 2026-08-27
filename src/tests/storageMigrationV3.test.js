import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { findRouteByContent, getRouteById, openDB, routeFingerprint } from '../storage.js';

/**
 * The v2 -> v3 upgrade adds a fingerprint index to the routes store and
 * backfills records saved before fingerprints existed. Without the backfill the
 * index would cover only routes imported from that point on, so an existing
 * library would keep duplicating on re-import — and a rider's hand-placed
 * waypoints would keep being stranded on the older record.
 *
 * This lives in its own file deliberately: openDB never closes its connections,
 * and IndexedDB blocks a database delete while any are open, so recreating the
 * database at v2 is only possible in a module context nothing else has touched.
 */

const GPX = '<gpx><trk><name>A</name><trkseg><trkpt lat="39" lon="-106"/></trkseg></trk></gpx>';

/** Recreates the database exactly as v2 left it: no fingerprint index. */
function createV2Database() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('bpnav-v1', 2);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      db.createObjectStore('route');
      db.createObjectStore('routes', { keyPath: 'id' });
    };
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction('routes', 'readwrite');
      tx.objectStore('routes').put({
        id: 'legacy-1',
        name: 'Legacy CT',
        filename: 'ct.gpx',
        gpxText: GPX,
        waypoints: [{ id: 'user-wpt-1', name: 'My spring', lat: 39, lon: -106 }],
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = (ev) => reject(ev.target.error);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

describe('v2 -> v3 fingerprint migration', () => {
  it('backfills a record that predates fingerprints, and makes it findable', async () => {
    await createV2Database();

    // Opening through the app runs the v3 upgrade.
    await openDB();

    const migrated = await getRouteById('legacy-1');
    expect(migrated.fingerprint).toBe(routeFingerprint(GPX));

    // Which is the point: re-importing that file now reuses the record rather
    // than duplicating it, so the hand-placed waypoint is still there.
    const found = await findRouteByContent(GPX);
    expect(found?.id).toBe('legacy-1');
    expect(found.waypoints.map((w) => w.id)).toContain('user-wpt-1');
  }, 20000);
});
