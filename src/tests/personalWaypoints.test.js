import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { rebaseWaypointsOntoTrack } from '../gpx.js';
import { deletePersonalWaypoint, getPersonalWaypoints, savePersonalWaypoint } from '../storage.js';

/**
 * Enrichment and route records are both scoped to a single route, so a place
 * that matters regardless of route — home, a trailhead, a water cache — had
 * nowhere to live and had to be re-added every time. These are held separately
 * and projected onto whatever route is loaded, the way wilderness boundaries
 * are.
 */

const place = (over = {}) => ({
  id: 'user-wpt-1',
  name: 'My spring',
  type: 'water',
  lat: 39.05,
  lon: -106.0,
  reliability: 90,
  ...over,
});

/** A due-north track from (39.0, -106.0). */
function track(n = 300) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([39.0 + i * 0.001, -106.0, 3000]);
  return pts;
}

beforeEach(async () => {
  for (const w of await getPersonalWaypoints()) await deletePersonalWaypoint(w.id);
});

describe('the personal waypoint store', () => {
  it('keeps a place across routes', async () => {
    await savePersonalWaypoint(place());
    expect((await getPersonalWaypoints()).map((w) => w.id)).toEqual(['user-wpt-1']);
  });

  it('replaces rather than duplicates when saved again', async () => {
    await savePersonalWaypoint(place());
    await savePersonalWaypoint(place({ name: 'Renamed' }));
    const all = await getPersonalWaypoints();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Renamed');
  });

  it('drops route-relative fields, which mean nothing off that track', async () => {
    // distanceFromStartMi of 12 is a fact about the route that happened to be
    // loaded, not about the place. Storing it would carry a stale number onto
    // every future route.
    await savePersonalWaypoint(place({ distanceFromStartMi: 12, offCourseDistanceMi: 0.4 }));
    const [stored] = await getPersonalWaypoints();
    expect(stored).not.toHaveProperty('distanceFromStartMi');
    expect(stored).not.toHaveProperty('offCourseDistanceMi');
  });

  it('deletes cleanly, and tolerates deleting what is not there', async () => {
    await savePersonalWaypoint(place());
    expect(await deletePersonalWaypoint('user-wpt-1')).toEqual([]);
    expect(await deletePersonalWaypoint('nope')).toEqual([]);
  });

  it('ignores a waypoint with no id rather than storing a nameless entry', async () => {
    await savePersonalWaypoint({ name: 'No id' });
    expect(await getPersonalWaypoints()).toEqual([]);
  });
});

describe('projecting places onto a route', () => {
  it('computes position against the loaded track', async () => {
    await savePersonalWaypoint(place());
    const { kept } = rebaseWaypointsOntoTrack(await getPersonalWaypoints(), track());
    expect(kept).toHaveLength(1);
    expect(kept[0].distanceFromStartMi).toBeGreaterThan(3);
    expect(kept[0].offCourseDistanceMi).toBeLessThan(0.1);
  });

  it('leaves out a place far from this route without forgetting it', async () => {
    // Personal places carry user- ids, and rebase keeps those regardless of
    // distance so a route swap cannot destroy hand-placed work. That exception
    // is wrong here: these live in their own store, so leaving one out loses
    // nothing — and without opting out, a place in Colorado would be pinned
    // onto an Arizona route.
    await savePersonalWaypoint(place({ lon: -105.5 }));
    const stored = await getPersonalWaypoints();
    const { kept } = rebaseWaypointsOntoTrack(stored, track(), { keepUserPlaced: false });
    expect(kept).toHaveLength(0);
    expect(await getPersonalWaypoints()).toHaveLength(1); // still remembered

    // And the default still protects a route swap.
    expect(rebaseWaypointsOntoTrack(stored, track()).kept).toHaveLength(1);
  });
});

describe('unticking removes the place', () => {
  it('stops it reappearing on other routes', async () => {
    // The modal save path deletes when the box is clear, so a place taken out
    // of the store does not keep coming back. Wiring this to the wrong handler
    // is how the feature first shipped doing nothing at all.
    await savePersonalWaypoint(place());
    expect(await getPersonalWaypoints()).toHaveLength(1);
    await deletePersonalWaypoint(place().id);
    expect(await getPersonalWaypoints()).toHaveLength(0);
  });
});
