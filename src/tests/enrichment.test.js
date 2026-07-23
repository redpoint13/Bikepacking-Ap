import { describe, expect, it } from 'vitest';
import { inferResupplyCategory, inferCampTier, enrichWaypointMetadata } from '../enrichment.js';

describe('enrichment helpers', () => {
  it('infers 4-tier resupply category correctly', () => {
    expect(inferResupplyCategory('Safeway Grocery', '')).toBe('grocery');
    expect(inferResupplyCategory('Chevron Gas Station', '')).toBe('cstore');
    expect(inferResupplyCategory('Mountain Diner & Cafe', '')).toBe('restaurant');
  });

  it('infers camp tiers correctly', () => {
    expect(inferCampTier('Pine Ridge Short Camp', '')).toBe('short');
    expect(inferCampTier('BLM Dispersed Flat', '')).toBe('dispersed');
  });

  it('enriches waypoint metadata', () => {
    const wp = {
      id: 'w1',
      name: 'General Store',
      type: 'resupply',
      distanceFromStartMi: 12.5,
    };
    const enriched = enrichWaypointMetadata(wp);
    expect(enriched.resupplyCategory).toBe('grocery');
    expect(enriched.hours).toBe('6:00 AM - 9:00 PM');
    expect(enriched.stopState).toBe('optional');
  });
});
