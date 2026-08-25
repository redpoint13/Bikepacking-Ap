import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGPX } from '../gpx.js';
import { PLAN_DEFAULTS, clearPlanCache } from '../plan.js';
import { renderPlanningView } from '../planning.js';

/**
 * The numeric controls declare their own min/max. The reader used to keep a
 * second, partial copy of those bounds and enforce them exclusively, so values
 * the markup forbids reached the planner.
 */

const xml = fs.readFileSync(path.resolve(process.cwd(), 'public/Coconino_Loop.gpx'), 'utf8');
let route;
let root;
let seen;

function commit(selector, value) {
  const el = root.querySelector(selector);
  el.value = String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  vi.advanceTimersByTime(1000);
  return el;
}

beforeEach(() => {
  vi.useFakeTimers();
  clearPlanCache();
  document.body.innerHTML = '';
  route ??= parseGPX(xml);
  root = document.createElement('div');
  root.id = 'planning-view';
  document.body.appendChild(root);
  renderPlanningView(root, route, { ...PLAN_DEFAULTS });
  seen = null;
  document.body.addEventListener('plan-options-change', (e) => {
    seen = e.detail;
  });
});

afterEach(() => vi.useRealTimers());

describe('planning control bounds', () => {
  it('clamps a daily target below the declared minimum', () => {
    commit('#plan-daily', 3);
    expect(seen.targetDailyMiles).toBe(5); // min="5", was silently jumping to 45
  });

  it('accepts a value sitting exactly on the minimum', () => {
    // The old check was exclusive, so the boundary itself bounced to the default.
    commit('#plan-daily', 5);
    expect(seen.targetDailyMiles).toBe(5);
    commit('#plan-capacity', 16);
    expect(seen.waterCapacityOz).toBe(16);
  });

  it('clamps a water capacity below the declared minimum', () => {
    // The old reader used its own min of 10 here, so 12 reached the planner
    // despite the field declaring min="16".
    commit('#plan-capacity', 12);
    expect(seen.waterCapacityOz).toBe(16);
    commit('#plan-capacity', 10.5);
    expect(seen.waterCapacityOz).toBe(16);
  });

  it('clamps above a declared maximum', () => {
    commit('#plan-reliability', 5000);
    expect(seen.reliableWaterThreshold).toBe(100); // max="100"
    commit('#plan-campmeals', 99);
    expect(seen.campMealsPerDay).toBe(5); // max="5"
    commit('#plan-detour', 999);
    expect(seen.maxDetourMi).toBe(25); // max="25"
  });

  it('accepts a legitimate zero the markup allows', () => {
    // min="0" on these — the old exclusive check bounced 0 back to the default.
    commit('#plan-reliability', 0);
    expect(seen.reliableWaterThreshold).toBe(0);
    commit('#plan-campmeals', 0);
    expect(seen.campMealsPerDay).toBe(0);
  });

  it('passes an in-range value through untouched', () => {
    commit('#plan-daily', 60);
    expect(seen.targetDailyMiles).toBe(60);
    commit('#plan-capacity', 72);
    expect(seen.waterCapacityOz).toBe(72);
  });

  it('falls back to the default when the field is empty', () => {
    commit('#plan-daily', '');
    expect(seen.targetDailyMiles).toBe(PLAN_DEFAULTS.targetDailyMiles);
  });

  it('rewrites the field to the clamped value on commit', () => {
    // The displayed number must not disagree with the plan being computed.
    const el = commit('#plan-reliability', 5000);
    expect(el.value).toBe('100');
  });

  it('leaves a half-typed value alone while the user is still typing', () => {
    const el = root.querySelector('#plan-capacity');
    el.value = '1'; // en route to 120
    el.dispatchEvent(new Event('input', { bubbles: true }));
    expect(el.value).toBe('1'); // not rewritten to 16 mid-keystroke
  });

  it('no longer marks the label as explicitly labelling its own descendant', () => {
    for (const input of root.querySelectorAll('#plan-controls input.plan-input')) {
      const label = input.closest('label');
      if (label) expect(label.getAttribute('for')).toBeNull();
    }
  });
});
