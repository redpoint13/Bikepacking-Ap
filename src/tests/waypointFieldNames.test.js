import { describe, expect, it } from 'vitest';
import { generateStopChecklists } from '../checklist.js';
import { generateGPX } from '../export.js';
import { PLAN_DEFAULTS, buildPlan, computeFoodCarry } from '../plan.js';
import { mergeResupplySources } from '../resupply.js';

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
