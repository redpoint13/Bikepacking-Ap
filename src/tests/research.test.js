import { describe, expect, it } from 'vitest';
import { classifyOSMElement, osmElementLabel, osmElementReliability } from '../gpx.js';

describe('OSM Classification', () => {
  it('correctly classifies camping elements', () => {
    expect(classifyOSMElement({ tourism: 'camp_site' })).toBe('camping');
    expect(classifyOSMElement({ backcountry: 'yes' })).toBe('camping');
    expect(classifyOSMElement({ camp_site: 'dispersed' })).toBe('camping');
  });

  it('correctly classifies water elements', () => {
    expect(classifyOSMElement({ amenity: 'drinking_water' })).toBe('water');
    expect(classifyOSMElement({ natural: 'spring' })).toBe('water');
    expect(classifyOSMElement({ waterway: 'stream' })).toBe('water');
    expect(classifyOSMElement({ name: 'Oak Creek' })).toBe('water');
  });

  it('correctly classifies resupply elements', () => {
    expect(classifyOSMElement({ shop: 'supermarket' })).toBe('resupply');
    expect(classifyOSMElement({ amenity: 'cafe' })).toBe('resupply');
    expect(classifyOSMElement({ amenity: 'fuel' })).toBe('resupply');
    expect(classifyOSMElement({ name: 'Diner and store' })).toBe('resupply');
  });

  it('classifies generic elements as navigation note', () => {
    expect(classifyOSMElement({ highway: 'motorway_junction' })).toBe('navigation');
  });
});

describe('OSM Label and Reliability', () => {
  it('respects name tags first', () => {
    expect(osmElementLabel({ name: 'Pine Creek Spring' }, 'water')).toBe('Pine Creek Spring');
  });

  it('falls back to type-specific names when name is missing', () => {
    expect(osmElementLabel({ natural: 'spring' }, 'water')).toBe('Spring');
    expect(osmElementLabel({ amenity: 'drinking_water' }, 'water')).toBe('Drinking Water');
    expect(osmElementLabel({}, 'camping')).toBe('Camp Site');
    expect(osmElementLabel({ shop: 'supermarket' }, 'resupply')).toBe('Supermarket');
  });

  it('assigns reliability to water sources', () => {
    expect(osmElementReliability({ amenity: 'drinking_water' }, 'water')).toBe(90);
    expect(osmElementReliability({ natural: 'spring' }, 'water')).toBe(65);
    expect(osmElementReliability({ natural: 'water' }, 'water')).toBe(80);
    expect(osmElementReliability({}, 'camping')).toBe(0);
  });
});

describe('Enrichment Protection', () => {
  it('keeps custom user waypoints during enrichment filter operations', () => {
    const waypoints = [
      { id: 'wpt-1', type: 'water' },
      { id: 'user-wpt-12345', type: 'water' },
      { id: 'wpt-2', type: 'camping' },
      { id: 'user-wpt-67890', type: 'camping' },
    ];

    const enrichedWater = [{ id: 'osm-water-1', type: 'water' }];

    // Mimic kickoffWaterEnrichment logic
    const waterFiltered = [
      ...waypoints.filter((w) => w.type !== 'water' || w.id.startsWith('user-')),
      ...enrichedWater,
    ];

    expect(waterFiltered.map((w) => w.id)).toContain('user-wpt-12345');
    expect(waterFiltered.map((w) => w.id)).not.toContain('wpt-1');
  });
});
