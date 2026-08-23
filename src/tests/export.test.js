/**
 * export.test.js — Unit tests for GPX and Mobile-Optimized PDF Export.
 */

import { describe, expect, it } from 'vitest';
import { generatePrintableItineraryHTML, generateGPX } from '../export.js';
import { PLAN_DEFAULTS } from '../plan.js';

const MOCK_ROUTE = {
  name: 'Coconino Loop Trail',
  totalDistanceMiles: 120.0,
  trackPoints: [
    [35.1, -111.6],
    [35.2, -111.7],
  ],
  waypoints: [
    {
      id: 'w1',
      name: 'Schnebly Hill Spring',
      type: 'water',
      distanceFromStartMi: 25.0,
      waterAvailable: 'natural',
      reliability: 85,
      seasonalStatus: 'Flowing',
    },
    {
      id: 'w2',
      name: 'Sedona Market',
      type: 'resupply',
      distanceFromStartMi: 45.0,
      resupplyCategory: 'grocery',
    },
    {
      id: 'w3',
      name: 'Goose Creek Campground',
      type: 'camping',
      distanceFromStartMi: 60.0,
      waterAvailable: 'potable',
      fee: '$27/night',
      landManager: 'USFS',
    },
  ],
};

describe('Mobile PDF / Printable Itinerary Generation', () => {
  it('includes viewport meta tag for mobile phone viewing', () => {
    const html = generatePrintableItineraryHTML(MOCK_ROUTE, PLAN_DEFAULTS);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0');
  });

  it('renders stats grid, daily camp itinerary, and water sources', () => {
    const html = generatePrintableItineraryHTML(MOCK_ROUTE, PLAN_DEFAULTS);
    expect(html).toContain('Coconino Loop Trail');
    expect(html).toContain('120.0 mi');
    expect(html).toContain('Schnebly Hill Spring');
    expect(html).toContain('Daily Camp Itinerary');
  });

  it('includes campground water availability and fee badges', () => {
    const html = generatePrintableItineraryHTML(MOCK_ROUTE, PLAN_DEFAULTS);
    expect(html).toContain('Goose Creek Campground');
    expect(html).toContain('$27/night');
  });

  it('includes start-of-ride and stop-by-stop packing checklists', () => {
    const html = generatePrintableItineraryHTML(MOCK_ROUTE, PLAN_DEFAULTS);
    expect(html).toContain('Departure: Start of Ride Base Pack');
    expect(html).toContain('Stop-by-Stop Action & Resupply Checklists');
    expect(html).toContain('checkbox-box');
  });
});
