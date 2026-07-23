import { describe, it, expect } from 'vitest';
import { calculateSegmentDifficulty, calculateRouteDifficulty, SURFACE_FACTORS } from '../difficulty.js';

describe('difficulty.js', () => {
  it('handles empty or small track point arrays gracefully', () => {
    const res = calculateSegmentDifficulty([], 0, 10);
    expect(res.distanceMi).toBe(0);
    expect(res.difficultyScore).toBe(0);
    expect(res.difficultyRating.label).toBe('Easy');
    expect(res.hikeABike.severity).toBe('None');
  });

  it('calculates distance, gain, and difficulty score for a flat route', () => {
    // 2 points ~ 10 miles apart at 0 elevation
    const trackPoints = [
      [34.0522, -118.2437, 100],
      [34.1950, -118.2437, 100],
    ];
    const res = calculateSegmentDifficulty(trackPoints, 0, 20);
    expect(res.distanceMi).toBeGreaterThan(5);
    expect(res.gainFt).toBe(0);
    expect(res.hillinessFtPerMi).toBe(0);
    expect(res.difficultyRating.label).toBe('Easy');
    expect(res.hikeABike.distanceMi).toBe(0);
  });

  it('detects steep pitches and Hike-a-Bike warnings for steep climbs', () => {
    // Construct a route with steep 20% incline over several miles
    const trackPoints = [];
    const numPoints = 50;
    for (let i = 0; i < numPoints; i++) {
      const lat = 34.0 + i * 0.005; // ~0.35 mi steps
      const lon = -118.0;
      const eleMeters = 100 + i * 120; // 120m rise per 0.35mi = ~20% grade
      trackPoints.push([lat, lon, eleMeters]);
    }

    const res = calculateSegmentDifficulty(trackPoints, 0, 50, { surfaceFactor: 1.6, habGradeThreshold: 15 });
    expect(res.gainFt).toBeGreaterThan(1000);
    expect(res.hillinessFtPerMi).toBeGreaterThan(50);
    expect(res.hikeABike.pitchCount).toBeGreaterThan(0);
    expect(res.hikeABike.distanceMi).toBeGreaterThan(0);
    expect(res.difficultyScore).toBeGreaterThan(20);
  });

  it('evaluates full route difficulty via calculateRouteDifficulty', () => {
    const route = {
      totalDistanceMiles: 30,
      trackPoints: [
        [34.0, -118.0, 100],
        [34.1, -118.0, 500],
        [34.2, -118.0, 1200],
      ],
    };
    const res = calculateRouteDifficulty(route, { surfaceFactor: 1.2 });
    expect(res).not.toBeNull();
    expect(res.difficultyScore).toBeGreaterThan(0);
    expect(res.difficultyRating).toHaveProperty('badge');
  });
});
