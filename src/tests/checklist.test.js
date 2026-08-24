/**
 * checklist.test.js — Unit tests for start-of-ride & stop-by-stop packing checklists.
 */

import { describe, expect, it } from 'vitest';
import {
  ESSENTIAL_GEAR_TEMPLATES,
  copyTextToClipboard,
  generateStartChecklist,
  generateStopChecklists,
  getChecklistSummaryMarkdown,
} from '../checklist.js';
import { buildPlan } from '../plan.js';

const MOCK_ROUTE = {
  name: 'Sedona to Flagstaff Epic',
  totalDistanceMiles: 80.0,
  trackPoints: [
    [34.8, -111.7],
    [35.0, -111.7],
    [35.2, -111.6],
  ],
  waypoints: [
    {
      id: 'w-water-1',
      name: 'Oak Creek Spring',
      type: 'water',
      distanceFromStartMi: 15.0,
      waterAvailable: 'natural',
      reliability: 90,
      source: 'osm',
    },
    {
      id: 'w-resupply-1',
      name: 'Sedona Supermarket',
      type: 'resupply',
      distanceFromStartMi: 35.0,
      resupplyCategory: 'grocery',
      source: 'osm',
    },
    {
      id: 'w-camp-1',
      name: 'Goose Creek Campground',
      type: 'camping',
      distanceFromStartMi: 55.0,
      tier: 'official',
      waterAvailable: 'potable',
      fee: '$27/night',
      reliability: 95,
      source: 'osm',
    },
  ],
};

const COLORADO_TRAIL_MOCK = {
  name: 'Colorado Trail Segment',
  totalDistanceMiles: 150.0,
  trackPoints: [
    [39.0, -106.0],
    [39.5, -106.5],
  ],
  waypoints: [
    {
      id: 'ct-water-1',
      name: 'Creek',
      type: 'water',
      distanceFromStartMi: 20.0,
      waterAvailable: 'natural',
      reliability: 80,
      source: 'osm',
    },
    {
      id: 'ct-camp-1',
      name: 'Creek Campsite',
      type: 'camping',
      distanceFromStartMi: 20.0, // co-located with water point
      waterAvailable: 'natural',
      source: 'osm',
    },
    {
      id: 'ct-water-2',
      name: 'Alpine Spring',
      type: 'water',
      distanceFromStartMi: 45.0,
      waterAvailable: 'natural',
      reliability: 95,
      source: 'osm',
    },
  ],
};

describe('Checklist Generation Engine', () => {
  const plan = buildPlan(MOCK_ROUTE, {
    targetDailyMiles: 30,
    waterCapacityOz: 100,
    ozPerMile: 2.0,
    caloriesPerDay: 3500,
    campMealsPerDay: 2,
    caloriesPerCampMeal: 650,
  });

  describe('generateStartChecklist', () => {
    it('creates categorized base checklists for departure', () => {
      const startChecklist = generateStartChecklist(MOCK_ROUTE, plan);
      expect(startChecklist.length).toBe(6);

      const categories = startChecklist.map((c) => c.category);
      expect(categories).toContain('hydration');
      expect(categories).toContain('nutrition');
      expect(categories).toContain('repair');
      expect(categories).toContain('shelter');
      expect(categories).toContain('electronics');
      expect(categories).toContain('essentials');
    });

    it('calculates starting hydration load without NaN or undefined', () => {
      const startChecklist = generateStartChecklist(MOCK_ROUTE, plan);
      const hyd = startChecklist.find((c) => c.category === 'hydration');
      expect(hyd).toBeDefined();
      expect(hyd.items[0].label).not.toContain('NaN');
      expect(hyd.items[0].label).not.toContain('undefined');
      expect(hyd.items[0].label).toContain('Fill');
      expect(hyd.items[0].label).toContain('water capacity');
    });

    it('calculates starting meals and snacks for first food span', () => {
      const startChecklist = generateStartChecklist(MOCK_ROUTE, plan);
      const nutr = startChecklist.find((c) => c.category === 'nutrition');
      expect(nutr).toBeDefined();
      expect(nutr.items[0].label).toContain('camp meal');
      expect(nutr.items[1].label).toContain('trail snacks');
      expect(nutr.items[0].label).not.toContain('NaN');
      expect(nutr.items[1].label).not.toContain('NaN');
    });
  });

  describe('generateStopChecklists', () => {
    it('generates itemized checklists for active stops and finish', () => {
      const stopChecklists = generateStopChecklists(MOCK_ROUTE, plan);
      expect(stopChecklists.length).toBeGreaterThanOrEqual(3);

      const waterStop = stopChecklists.find((s) => s.type === 'water');
      expect(waterStop).toBeDefined();
      expect(waterStop.items.some((i) => i.label.includes('Refill'))).toBe(true);

      const resupplyStop = stopChecklists.find((s) => s.type === 'resupply');
      expect(resupplyStop).toBeDefined();
      expect(
        resupplyStop.items.some((i) => i.label.includes('Buy') || i.label.includes('Pick up')),
      ).toBe(true);

      const campStop = stopChecklists.find((s) => s.type === 'camping');
      expect(campStop).toBeDefined();
      expect(campStop.items.some((i) => i.label.includes('Pitch shelter'))).toBe(true);
      expect(campStop.items.some((i) => i.label.includes('$27/night'))).toBe(true);

      const finishStop = stopChecklists.find((s) => s.type === 'finish');
      expect(finishStop).toBeDefined();
      expect(finishStop.items[0].label).toContain('Celebrate');
    });

    it('does not produce NaN, undefined, or 0 mi stretch on co-located stops (Colorado Trail test case)', () => {
      const ctPlan = buildPlan(COLORADO_TRAIL_MOCK, {
        targetDailyMiles: 25,
        waterCapacityOz: 100,
        ozPerMile: 2.0,
      });
      const stopChecklists = generateStopChecklists(COLORADO_TRAIL_MOCK, ctPlan);

      for (const stop of stopChecklists) {
        for (const item of stop.items) {
          expect(item.label).not.toContain('NaN');
          expect(item.label).not.toContain('undefined');
          expect(item.label).not.toContain('next 0 mi stretch');
          expect(item.label).not.toContain('next 0.0 mi stretch');
        }
      }
    });
  });

  describe('getChecklistSummaryMarkdown', () => {
    it('formats clean markdown with checkbox task items', () => {
      const startChecklist = generateStartChecklist(MOCK_ROUTE, plan);
      const stopChecklists = generateStopChecklists(MOCK_ROUTE, plan);

      const md = getChecklistSummaryMarkdown(startChecklist, stopChecklists);
      expect(md).toContain('# 📋 Bikepacking Expedition Packing & Stop Checklist');
      expect(md).toContain('- [ ]');
      expect(md).toContain('Goose Creek Campground');
      expect(md).toContain('Oak Creek Spring');
      expect(md).not.toContain('NaN');
      expect(md).not.toContain('undefined');
    });
    it('formats checked items with [x] in markdown output', () => {
      const startChecklist = generateStartChecklist(MOCK_ROUTE, plan);
      const stopChecklists = generateStopChecklists(MOCK_ROUTE, plan);

      startChecklist[0].items[0].checked = true;
      stopChecklists[0].items[0].checked = true;

      const md = getChecklistSummaryMarkdown(startChecklist, stopChecklists);
      expect(md).toContain('- [x]');
      expect(md).toContain('- [ ]');
    });
  });

  describe('copyTextToClipboard', () => {
    it('returns false for non-string input', async () => {
      expect(await copyTextToClipboard(null)).toBe(false);
      expect(await copyTextToClipboard(undefined)).toBe(false);
      expect(await copyTextToClipboard(123)).toBe(false);
    });

    it('handles clipboard writing with navigator.clipboard or execCommand mock', async () => {
      Object.assign(navigator, {
        clipboard: {
          writeText: async () => {},
        },
      });
      const success = await copyTextToClipboard('# Test Markdown');
      expect(success).toBe(true);
    });
  });
});
