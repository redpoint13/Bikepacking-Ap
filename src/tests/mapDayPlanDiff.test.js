import maplibregl from 'maplibre-gl';
import { beforeEach, describe, expect, it } from 'vitest';
import { updateMapDayPlan } from '../map.js';

/**
 * Day segments used to be torn down and rebuilt in full on every update, which
 * forced MapLibre to re-tile the whole route on each planning-control edit.
 * These tests pin the diffing that replaced it.
 */

/** A straight north-running track, one point roughly every 0.07 mi. */
function makeTrackPoints(n = 600) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([35.0 + i * 0.001, -111.0, 1000 + (i % 10) * 5]);
  return pts;
}

/** A day plan of `count` equal spans over `total` miles. */
function makeDayPlan(count, total = 40) {
  const days = [];
  const span = total / count;
  for (let i = 0; i < count; i++) {
    days.push({
      day: i + 1,
      startMi: i * span,
      chosen: { endMi: (i + 1) * span, campName: `Camp ${i + 1}`, isFinish: i === count - 1 },
    });
  }
  return days;
}

let map;
let trackPoints;

beforeEach(() => {
  map = maplibregl.Map();
  trackPoints = makeTrackPoints();
  // Stand in for the base route layers updateMapDayPlan toggles.
  map.addSource('route', { type: 'geojson', data: {} });
  map.addLayer({ id: 'route-glow', type: 'line', source: 'route' });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route' });
});

describe('updateMapDayPlan diffing', () => {
  it('creates one source and two layers per day on first render', () => {
    map._resetStats();
    updateMapDayPlan(map, trackPoints, makeDayPlan(5));
    expect(map._stats.addSource).toBe(5);
    expect(map._stats.addLayer).toBe(10);
    expect(map._stats.removeSource).toBe(0);
    expect(map._stats.removeLayer).toBe(0);
  });

  it('rebuilds nothing when the same plan is re-rendered', () => {
    const plan = makeDayPlan(5);
    updateMapDayPlan(map, trackPoints, plan);
    map._resetStats();
    updateMapDayPlan(map, trackPoints, plan);
    expect(map._stats.addSource).toBe(0);
    expect(map._stats.removeSource).toBe(0);
    expect(map._stats.addLayer).toBe(0);
    expect(map._stats.removeLayer).toBe(0);
    expect(map._stats.setData).toBe(5); // geometry refreshed in place
  });

  it('only adds what is new when the day count grows', () => {
    updateMapDayPlan(map, trackPoints, makeDayPlan(5));
    map._resetStats();
    updateMapDayPlan(map, trackPoints, makeDayPlan(8));
    expect(map._stats.addSource).toBe(3); // days 6, 7, 8
    expect(map._stats.addLayer).toBe(6);
    expect(map._stats.removeSource).toBe(0);
    expect(map._stats.setData).toBe(5); // days 1-5 reused
  });

  it('only removes what disappeared when the day count shrinks', () => {
    updateMapDayPlan(map, trackPoints, makeDayPlan(8));
    map._resetStats();
    updateMapDayPlan(map, trackPoints, makeDayPlan(5));
    expect(map._stats.removeSource).toBe(3); // days 6, 7, 8
    expect(map._stats.removeLayer).toBe(6);
    expect(map._stats.addSource).toBe(0);
    expect(map._stats.setData).toBe(5);
  });

  it('leaves exactly the current plan on the map after a shrink', () => {
    updateMapDayPlan(map, trackPoints, makeDayPlan(8));
    updateMapDayPlan(map, trackPoints, makeDayPlan(3));
    const daySources = [...map._sources.keys()].filter((k) => k.startsWith('route-day-'));
    const dayLayers = [...map._layers.keys()].filter((k) => k.includes('-day-'));
    expect(daySources.sort()).toEqual(['route-day-1', 'route-day-2', 'route-day-3']);
    expect(dayLayers).toHaveLength(6);
  });

  it('recolours a reused layer when its position in the plan shifts', () => {
    // Colours cycle by position in the plan, not by day number, so a day that
    // survives a re-plan at a different index must be repainted in place.
    const full = makeDayPlan(9);
    updateMapDayPlan(map, trackPoints, full);
    const before = map._layers.get('route-line-day-8').paint['line-color'];

    map._resetStats();
    // Same day 8, now at index 1 of a three-day plan.
    updateMapDayPlan(map, trackPoints, full.filter((d) => d.day >= 7));
    const after = map._layers.get('route-line-day-8').paint['line-color'];

    expect(after).not.toBe(before);
    expect(map._stats.addLayer).toBe(0); // reused, not rebuilt
    expect(map._stats.setPaintProperty).toBeGreaterThan(0);
  });

  it('clears every day layer and restores the base route when the plan empties', () => {
    updateMapDayPlan(map, trackPoints, makeDayPlan(6));
    map._resetStats();
    updateMapDayPlan(map, trackPoints, []);
    expect(map._stats.removeSource).toBe(6);
    expect(map._stats.removeLayer).toBe(12);
    expect([...map._sources.keys()].filter((k) => k.startsWith('route-day-'))).toEqual([]);
  });

  it('removes layers before their source, as MapLibre requires', () => {
    // The mock throws if a source is removed while a layer still reads from it.
    updateMapDayPlan(map, trackPoints, makeDayPlan(4));
    expect(() => updateMapDayPlan(map, trackPoints, makeDayPlan(1))).not.toThrow();
    expect(() => updateMapDayPlan(map, trackPoints, [])).not.toThrow();
  });

  it('skips a day with no chosen camp instead of throwing', () => {
    const plan = makeDayPlan(4);
    plan[2].chosen = null;
    expect(() => updateMapDayPlan(map, trackPoints, plan)).not.toThrow();
    const daySources = [...map._sources.keys()].filter((k) => k.startsWith('route-day-'));
    expect(daySources).not.toContain('route-day-3');
    expect(daySources).toHaveLength(3);
  });

  it('does not read the whole style back on update', () => {
    let getStyleCalls = 0;
    const realGetStyle = map.getStyle;
    map.getStyle = (...args) => {
      getStyleCalls++;
      return realGetStyle(...args);
    };
    updateMapDayPlan(map, trackPoints, makeDayPlan(5));
    updateMapDayPlan(map, trackPoints, makeDayPlan(7));
    expect(getStyleCalls).toBe(0);
  });
});
