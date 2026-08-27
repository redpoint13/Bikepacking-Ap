import { describe, expect, it } from 'vitest';
import { rebaseWaypointsOntoTrack } from '../gpx.js';

/**
 * Swapping the GPX under an existing set of markers is only safe if their
 * route-relative fields are recomputed. distanceFromStartMi and
 * offCourseDistanceMi are measured against the track a waypoint was created
 * with; carried across unchanged they read plausibly and are wrong, which
 * corrupts water carries and day planning without looking broken.
 */

/** A due-north track from (39.0, -106.0), roughly 0.069 mi per step. */
function track(n = 300) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([39.0 + i * 0.001, -106.0, 3000]);
  return pts;
}

const wp = (over) => ({ id: 'w1', type: 'water', lat: 39.05, lon: -106.0, ...over });

describe('rebaseWaypointsOntoTrack', () => {
  it('recomputes distance along the new track', () => {
    const { kept } = rebaseWaypointsOntoTrack([wp({ distanceFromStartMi: 999 })], track());
    expect(kept).toHaveLength(1);
    // 50 steps up a ~0.069 mi/step track ≈ 3.5 mi, and nowhere near the stale 999.
    expect(kept[0].distanceFromStartMi).toBeGreaterThan(3);
    expect(kept[0].distanceFromStartMi).toBeLessThan(4);
  });

  it('recomputes how far off the new line each waypoint sits', () => {
    const onLine = wp({ id: 'on', lat: 39.05, lon: -106.0, offCourseDistanceMi: 99 });
    const { kept } = rebaseWaypointsOntoTrack([onLine], track());
    expect(kept[0].offCourseDistanceMi).toBeLessThan(0.1);
  });

  it('drops a waypoint now beyond the corridor', () => {
    // ~0.5 degrees of longitude out — tens of miles from the new track.
    const far = wp({ id: 'far', lon: -105.5 });
    const { kept, dropped } = rebaseWaypointsOntoTrack([far], track(), { maxOffCourseMi: 1.5 });
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].offCourseDistanceMi).toBeGreaterThan(1.5);
  });

  it('keeps a hand-placed waypoint even when it is now far off route', () => {
    // User waypoints are not reproducible, so losing them silently is worse
    // than carrying one that no longer sits near the line.
    const mine = wp({ id: 'user-1', lon: -105.5 });
    const { kept, dropped } = rebaseWaypointsOntoTrack([mine], track());
    expect(kept.map((k) => k.id)).toContain('user-1');
    expect(dropped).toHaveLength(0);
    expect(kept[0].offCourseDistanceMi).toBeGreaterThan(1.5); // reported truthfully
  });

  it('discards synthetic camps, which the planner regenerates', () => {
    const synth = wp({ id: 'synth-camp-d1-med', type: 'camping', isSynthetic: true });
    const { kept, dropped } = rebaseWaypointsOntoTrack([synth], track());
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(0); // not "dropped" — simply not carried over
  });

  it('returns results in route order', () => {
    const pts = track();
    const far = [pts[200][0], pts[200][1]];
    const near = [pts[20][0], pts[20][1]];
    const { kept } = rebaseWaypointsOntoTrack(
      [
        wp({ id: 'later', lat: far[0], lon: far[1] }),
        wp({ id: 'earlier', lat: near[0], lon: near[1] }),
      ],
      pts,
    );
    expect(kept.map((k) => k.id)).toEqual(['earlier', 'later']);
  });

  it('survives empty or malformed input', () => {
    expect(rebaseWaypointsOntoTrack([], track())).toEqual({ kept: [], dropped: [] });
    expect(rebaseWaypointsOntoTrack(null, track())).toEqual({ kept: [], dropped: [] });
    expect(rebaseWaypointsOntoTrack([wp()], [])).toEqual({ kept: [], dropped: [] });
    expect(rebaseWaypointsOntoTrack([{ id: 'nolatlon' }], track()).kept).toHaveLength(0);
  });
});
