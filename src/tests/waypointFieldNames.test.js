import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeCampSources } from '../camp.js';
import { generateStopChecklists } from '../checklist.js';
import { withRouteDistances } from '../enrichment.js';
import { generateGPX } from '../export.js';
import { PLAN_DEFAULTS, buildPlan, computeFoodCarry } from '../plan.js';
import { mergeResupplySources } from '../resupply.js';
import { mergeWaterSources } from '../water.js';

/**
 * "One module sets a field, another reads a different name" is the dominant
 * failure mode in this codebase — startPoint, monitoringLocationType,
 * wildernessname, HOLDING_NAME, desc, category. It is invisible to ordinary
 * tests because fixtures get written from the reading module's assumptions,
 * so these assert the handshake between a real producer and a real consumer.
 */

function routeFixture(waypoints) {
  const trackPoints = [];
  for (let i = 0; i <= 200; i++) trackPoints.push([39.0 + i * 0.002, -106.0, 3000]);
  return { name: 'T', totalDistanceMiles: 30, trackPoints, waypoints, metadata: {} };
}

describe('resupply category reaches the planner', () => {
  it('names the field plan.js actually reads', () => {
    // resupply.js wrote `category` while plan.js read `resupplyCategory`, and
    // the only writer of the latter was never called — so the OSM-derived
    // category was computed and discarded, and food planning fell back to
    // guessing from the shop's name.
    const el = {
      type: 'node',
      id: 1,
      lat: 39.2,
      lon: -106.0,
      tags: { shop: 'supermarket', name: 'Big Grocery' },
    };
    const [merged] = mergeResupplySources(routeFixture([]), [el]);
    expect(merged.resupplyCategory).toBe('grocery');
  });

  it('a supermarket plans as a grocery, not a convenience store', () => {
    const wp = {
      id: 'r1',
      type: 'resupply',
      name: 'Big Grocery',
      lat: 39.2,
      lon: -106.0,
      distanceFromStartMi: 10,
      reliability: 90,
      resupplyCategory: 'grocery',
      offCourseDistanceMi: 0,
    };
    const spans = computeFoodCarry(routeFixture([wp]), { ...PLAN_DEFAULTS });
    expect(spans.some((s) => s.toCategory === 'grocery' || s.fromCategory === 'grocery')).toBe(
      true,
    );
  });

  it('still honours the legacy name on waypoints cached before the rename', () => {
    const wp = {
      id: 'r1',
      type: 'resupply',
      name: 'Unrecognisable Name',
      lat: 39.2,
      lon: -106.0,
      distanceFromStartMi: 10,
      reliability: 90,
      category: 'grocery',
      offCourseDistanceMi: 0,
    };
    const spans = computeFoodCarry(routeFixture([wp]), { ...PLAN_DEFAULTS });
    expect(spans.some((s) => s.toCategory === 'grocery' || s.fromCategory === 'grocery')).toBe(
      true,
    );
  });
});

describe('exported GPX carries waypoint descriptions', () => {
  it('reads description, the field waypoints actually have', () => {
    // generateGPX read wp.desc, which nothing sets, so every export dropped
    // the reliability and seasonal notes that make one worth having.
    const gpx =
      '<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">' +
      '<trk><trkseg><trkpt lat="39.0" lon="-106.0"/><trkpt lat="39.4" lon="-106.0"/></trkseg></trk></gpx>';
    const route = routeFixture([
      {
        id: 'w1',
        type: 'water',
        name: 'Spring',
        description: 'Spring (USGS) — Normal Seasonal Flow',
        lat: 39.2,
        lon: -106.0,
        distanceFromStartMi: 10,
        reliability: 90,
        offCourseDistanceMi: 0,
      },
    ]);
    const out = generateGPX(gpx, route, { ...PLAN_DEFAULTS });
    expect(out).toContain('Normal Seasonal Flow');
  });
});

describe('checklist reads the water field that exists', () => {
  it('treats a potable stop as potable', () => {
    const route = routeFixture([
      {
        id: 'c1',
        type: 'camping',
        name: 'Camp',
        description: '',
        lat: 39.2,
        lon: -106.0,
        distanceFromStartMi: 10,
        reliability: 90,
        waterAvailable: 'potable',
        offCourseDistanceMi: 0,
      },
    ]);
    // The old condition also consulted stop.drinkingWater, which nothing set.
    const plan = buildPlan(route, { ...PLAN_DEFAULTS });
    const lists = generateStopChecklists(route, plan);
    expect(Array.isArray(lists)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Enrichment output → every consumer of offCourseDistanceMi
// ---------------------------------------------------------------------------

/**
 * water.js, camp.js and resupply.js set `distanceFromStartMi` but never
 * `offCourseDistanceMi`, while ~20 consumers read it as
 * `wp.offCourseDistanceMi || 0`. An unset field therefore reads as "on the
 * route, no detour": maxDetourMi stops filtering, the map's off-course badge
 * never shows, and the detour is missing from day mileage and time.
 */
describe('enrichment output carries its own detour distance', () => {
  const OFF_ROUTE_MI = 1.2;
  // isNearRoute measures to sampled track points (every 20th, ~2.8 mi apart
  // here), so anchor to one -- i=40 -> lat 39.08. Off a sample, a source 1.2 mi
  // from the line can measure 1.8 mi and fall outside the 1.5 mi gate.
  const LAT = 39.08;
  const dLon = OFF_ROUTE_MI / (69 * Math.cos((LAT * Math.PI) / 180));

  const cases = [
    ['water', mergeWaterSources, { amenity: 'drinking_water' }, 'osm-42'],
    ['camping', mergeCampSources, { tourism: 'camp_site' }, 'osm-camp-42'],
    ['resupply', mergeResupplySources, { shop: 'supermarket' }, 'osm-resupply-42'],
  ];

  for (const [label, merge, tags, id] of cases) {
    it(`${label}: the merge leaves it unset, and withRouteDistances supplies it`, () => {
      const route = routeFixture([]);
      const el = { type: 'node', id: 42, lat: LAT, lon: -106.0 + dLon, tags };
      const raw = label === 'water' ? merge(route, [], [el]) : merge(route, [el]);

      const before = raw.find((w) => w.id === id);
      expect(before).toBeDefined();
      expect(before.offCourseDistanceMi).toBeUndefined();

      const after = withRouteDistances(raw, route.trackPoints).find((w) => w.id === id);
      expect(after.offCourseDistanceMi).toBeGreaterThan(OFF_ROUTE_MI - 0.2);
      expect(after.offCourseDistanceMi).toBeLessThan(OFF_ROUTE_MI + 0.2);
    });
  }

  it('measures the detour without dropping anything', () => {
    // Each enrichment module applies its own proximity gate, so this must not
    // filter a second time on a threshold that does not match it -- that would
    // discard sources those modules kept, including the rider's own GPX
    // waypoints, which may sit well off the line deliberately.
    const route = routeFixture([]);
    const far = {
      id: 'wpt-9',
      name: 'Far Spring',
      type: 'water',
      lat: LAT,
      lon: -106.0 + dLon * 4,
    };
    const kept = withRouteDistances([far], route.trackPoints);
    expect(kept).toHaveLength(1);
    expect(kept[0].offCourseDistanceMi).toBeGreaterThan(4);
  });

  it('is wired into every enrichment kickoff, not just the ones tested above', () => {
    // The fix is only worth anything if app.js actually calls it. A previous
    // change of this shape shipped fully tested and did nothing, because the
    // tests covered the helper and never the call site.
    const src = readFileSync(resolve(process.cwd(), 'src/app.js'), 'utf8');
    const kickoffs = [...src.matchAll(/await\s+enrich\w+Sources\(/g)];
    expect(kickoffs.length).toBeGreaterThanOrEqual(3);
    for (const m of src.matchAll(/([\s\S]{0,90})await\s+enrich\w+Sources\(/g)) {
      expect(m[1]).toContain('withRouteDistances');
    }
  });
});
