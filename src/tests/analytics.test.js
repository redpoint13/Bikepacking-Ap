import { describe, expect, it } from 'vitest';
import {
  buildDaySegmentAnalytics,
  computeSegmentAnalytics,
  formatDuration,
  generateSegmentNarrative,
} from '../analytics.js';

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
        { id: 'w1', name: 'Spring 1', type: 'water', distanceFromStartMi: 15, reliability: 90 },
        { id: 'w2', name: 'Cottonwood General Store', type: 'resupply', distanceFromStartMi: 30, description: 'Town market and cafe' },
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
    expect(analytics.narrative).toBeDefined();
    expect(analytics.narrative.summaryParagraph).toContain('Mile 0.0 to Mile 50.0');
    expect(analytics.narrative.townsAndServices).toHaveLength(1);
    expect(analytics.narrative.townsAndServices[0].name).toBe('Cottonwood General Store');
    expect(analytics.narrative.milestones.length).toBeGreaterThanOrEqual(3);
    expect(analytics.narrative.tips.length).toBeGreaterThan(0);
  });

  it('generates segment narrative with pro-tips, towns, and dry gap warnings', () => {
    const segmentData = {
      startMi: 10,
      endMi: 40,
      distanceMi: 30,
      gainFt: 2500,
      lossFt: 1200,
      hillinessFtPerMi: 83,
      difficulty: {
        difficultyRating: { label: 'Strenuous', cls: 'strenuous', badge: 'STRENUOUS' },
        difficultyScore: 78,
        hikeABike: { distanceMi: 2.1, pitchCount: 3, percent: 7 },
      },
      pacing: {
        formattedMovingTime: '3h 45m',
        formattedElapsedTime: '4h 40m',
      },
      logistics: {
        waterNeededOz: 150,
        waterNeededLiters: 4.4,
        caloriesNeededKcal: 2600,
        campMealsNeeded: 1,
      },
      waypoints: {
        all: [
          { name: 'Sedona Red Rock Market', type: 'resupply', distanceFromStartMi: 18, offCourseDistanceMi: 0.2, description: 'Full grocery and water spigot' },
          { name: 'Oak Creek Crossing', type: 'water', distanceFromStartMi: 22, reliability: 95, seasonalStatus: 'Perennial flow' },
        ],
        waterSources: [
          { name: 'Oak Creek Crossing', type: 'water', distanceFromStartMi: 22, reliability: 95, seasonalStatus: 'Perennial flow' },
        ],
        resupplyPoints: [
          { name: 'Sedona Red Rock Market', type: 'resupply', distanceFromStartMi: 18, offCourseDistanceMi: 0.2, description: 'Full grocery and water spigot' },
        ],
        campSpots: [],
      },
    };

    const narrative = generateSegmentNarrative(segmentData);

    expect(narrative.headline).toBe('Mile 10.0 → 40.0 Segment Narrative');
    expect(narrative.summaryParagraph).toContain('Sedona Red Rock Market');
    expect(narrative.summaryParagraph).toContain('hike-a-bike');
    expect(narrative.townsAndServices[0].name).toBe('Sedona Red Rock Market');
    expect(narrative.milestones).toHaveLength(2);
    expect(narrative.tips.some((t) => t.title.includes('Hike-a-Bike'))).toBe(true);
    expect(narrative.tips.some((t) => t.title.includes('Climbing'))).toBe(true);
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
