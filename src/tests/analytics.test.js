import { describe, it, expect } from 'vitest';
import { computeSegmentAnalytics, buildDaySegmentAnalytics, formatDuration } from '../analytics.js';

describe('analytics.js', () => {
  it('formats duration correctly', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(0.5)).toBe('30m');
    expect(formatDuration(2.25)).toBe('2h 15m');
    expect(formatDuration(4)).toBe('4h');
  });

  it('computes segment analytics accurately', () => {
    const route = {
      totalDistanceMiles: 50,
      trackPoints: [
        [34.0, -118.0, 100],
        [34.1, -118.0, 500],
        [34.2, -118.0, 1000],
      ],
      waypoints: [
        { id: 'w1', name: 'Spring 1', type: 'water', distanceFromStartMi: 15 },
        { id: 'w2', name: 'Store A', type: 'resupply', distanceFromStartMi: 30 },
        { id: 'w3', name: 'Camp 1', type: 'camping', distanceFromStartMi: 45 },
      ],
    };

    const analytics = computeSegmentAnalytics(route, 0, 50, { paceMovingAvgMph: 10, ozPerMile: 5 });

    expect(analytics.distanceMi).toBe(50);
    expect(analytics.gainFt).toBeGreaterThan(0);
    expect(analytics.logistics.waterNeededOz).toBe(250);
    expect(analytics.waypoints.waterSources).toHaveLength(1);
    expect(analytics.waypoints.resupplyPoints).toHaveLength(1);
    expect(analytics.waypoints.campSpots).toHaveLength(1);
    expect(analytics.pacing.estimatedMovingHours).toBeGreaterThan(5);
  });

  it('builds day segment analytics and sub-legs from plan', () => {
    const route = {
      name: 'Test Route',
      totalDistanceMiles: 60,
      trackPoints: [
        [34.0, -118.0, 100],
        [34.2, -118.0, 600],
        [34.4, -118.0, 1200],
      ],
      waypoints: [
        { id: 'w1', name: 'Camp Alpha', type: 'camping', distanceFromStartMi: 25 },
        { id: 'w2', name: 'Camp Beta', type: 'camping', distanceFromStartMi: 50 },
      ],
    };

    const daySegments = buildDaySegmentAnalytics(route, { targetDailyMiles: 30 });
    expect(daySegments).toBeDefined();
    expect(Array.isArray(daySegments)).toBe(true);
    if (daySegments.length > 0) {
      expect(daySegments[0]).toHaveProperty('analytics');
      expect(daySegments[0]).toHaveProperty('legs');
    }
  });
});
