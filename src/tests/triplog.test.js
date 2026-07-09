/**
 * triplog.test.js — Unit tests for the resource-log builder.
 */

import { describe, expect, it } from 'vitest';
import ctrLog from '../data/ctrTrailLog.json';
import { buildResourceLog, isReliableWater, logType, milesToNext } from '../triplog.js';

// ---------------------------------------------------------------------------
// Fixture: a synthetic enriched route
// ---------------------------------------------------------------------------

/** @returns {import('../gpx.js').RouteContext} */
function makeRoute() {
  return {
    name: 'Test Loop',
    totalDistanceMiles: 100,
    trackPoints: [
      [0, 0],
      [1, 1],
    ],
    bounds: { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 },
    startOffsetMi: 0,
    isLoop: true,
    waypoints: [
      { name: 'Spring A', type: 'water', reliability: 80, distanceFromStartMi: 10 },
      { name: 'Trough B', type: 'water', reliability: 30, distanceFromStartMi: 18 },
      { name: 'Store', type: 'resupply', reliability: 90, distanceFromStartMi: 20 },
      { name: 'Camp 1', type: 'camping', reliability: 80, distanceFromStartMi: 22 },
      { name: 'Creek C', type: 'water', reliability: 70, distanceFromStartMi: 45 },
      { name: 'Turn', type: 'navigation', reliability: 0, distanceFromStartMi: 50 },
      { name: 'Diner', type: 'resupply', reliability: 90, distanceFromStartMi: 60 },
      { name: 'Camp 2', type: 'camping', reliability: 80, distanceFromStartMi: 90 },
    ],
  };
}

describe('logType', () => {
  it('maps app types to log labels', () => {
    expect(logType('water')).toBe('WATER');
    expect(logType('resupply')).toBe('FOOD');
    expect(logType('camping')).toBe('CAMP');
    expect(logType('navigation')).toBe('GENERIC');
    expect(logType('unknown')).toBe('GENERIC');
  });
});

describe('isReliableWater', () => {
  it('only counts water at or above the threshold', () => {
    expect(isReliableWater({ type: 'water', reliability: 60 }, 50)).toBe(true);
    expect(isReliableWater({ type: 'water', reliability: 40 }, 50)).toBe(false);
    expect(isReliableWater({ type: 'resupply', reliability: 90 }, 50)).toBe(false);
  });
});

describe('milesToNext', () => {
  it('returns distance ahead to the next matching waypoint', () => {
    const wps = [
      { type: 'water', distanceFromStartMi: 10 },
      { type: 'water', distanceFromStartMi: 25 },
    ];
    expect(milesToNext(wps, 0, (w) => w.type === 'water')).toBe(10);
    expect(milesToNext(wps, 10, (w) => w.type === 'water')).toBe(15);
    expect(milesToNext(wps, 25, (w) => w.type === 'water')).toBeNull();
  });
});

describe('buildResourceLog', () => {
  it('synthesizes Start and Finish rows', () => {
    const log = buildResourceLog(makeRoute());
    expect(log.entries[0].landmark).toBe('Start');
    expect(log.entries[0].cumulativeMi).toBe(0);
    expect(log.entries[log.entries.length - 1].landmark).toBe('Finish');
    expect(log.entries[log.entries.length - 1].cumulativeMi).toBe(100);
  });

  it('excludes navigation waypoints from the log', () => {
    const log = buildResourceLog(makeRoute());
    expect(log.entries.some((e) => e.landmark === 'Turn')).toBe(false);
  });

  it('miles-to-next-water skips unreliable sources', () => {
    const log = buildResourceLog(makeRoute(), { reliableWaterThreshold: 50 });
    // Start (mile 0) → next reliable water is Spring A at mile 10 (Trough B @18 is 30%)
    const start = log.entries.find((e) => e.landmark === 'Start');
    expect(start.milesToNextWater).toBe(10);
    // From Spring A (mile 10) the next reliable water is Creek C at 45 → 35 mi
    const springA = log.entries.find((e) => e.landmark === 'Spring A');
    expect(springA.milesToNextWater).toBe(35);
  });

  it('records reliability only on water rows', () => {
    const log = buildResourceLog(makeRoute());
    const springA = log.entries.find((e) => e.landmark === 'Spring A');
    const store = log.entries.find((e) => e.landmark === 'Store');
    expect(springA.reliability).toBe(80);
    expect(store.reliability).toBeNull();
  });
});

describe('CTR reference dataset', () => {
  it('ships the converted Colorado Trail master log', () => {
    expect(ctrLog.entries.length).toBe(64);
    expect(ctrLog.totalMiles).toBe(529.4);
    expect(ctrLog.entries[0].landmark).toBe('Start');
  });

  it('matches the resource-log schema', () => {
    expect(ctrLog.schema).toEqual([
      'cumulativeMi',
      'landmark',
      'type',
      'elevationFt',
      'milesToNextWater',
      'milesToNextFood',
    ]);
    for (const e of ctrLog.entries) {
      expect(typeof e.cumulativeMi).toBe('number');
      expect(typeof e.landmark).toBe('string');
      expect(['WATER', 'FOOD', 'STORE', 'SUMMIT', 'GENERIC', 'CAMP']).toContain(e.type);
    }
  });
});
