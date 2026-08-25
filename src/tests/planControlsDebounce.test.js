import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGPX } from '../gpx.js';
import { PLAN_DEFAULTS, clearPlanCache } from '../plan.js';
import { renderPlanningView } from '../planning.js';

/**
 * A full plan recompute is expensive on an OSM-enriched route. These tests pin
 * the coalescing that keeps a burst of control edits — typing, and especially
 * spinner-arrow auto-repeat — down to one recompute, which is what stopped the
 * Planning tab from wedging the main thread.
 */

const xml = fs.readFileSync(path.resolve(process.cwd(), 'public/Coconino_Loop.gpx'), 'utf8');
let route;

function mount() {
  const root = document.createElement('div');
  root.id = 'planning-view';
  document.body.appendChild(root);
  renderPlanningView(root, route, { ...PLAN_DEFAULTS });
  let recomputes = 0;
  document.body.addEventListener('plan-options-change', () => {
    recomputes++;
  });
  return { root, count: () => recomputes };
}

/** A spinner-arrow click: browsers fire input, then change. */
function stepInput(el, value) {
  el.value = String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  clearPlanCache();
  document.body.innerHTML = '';
  route ??= parseGPX(xml);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('planning control debounce', () => {
  it('runs no recompute synchronously while the user is still editing', () => {
    const { root, count } = mount();
    stepInput(root.querySelector('#plan-daily'), 40);
    expect(count()).toBe(0);
  });

  it('collapses one spinner click (input + change) into a single recompute', () => {
    const { root, count } = mount();
    stepInput(root.querySelector('#plan-daily'), 40);
    vi.advanceTimersByTime(1000);
    expect(count()).toBe(1);
  });

  it('collapses spinner auto-repeat into a single recompute', () => {
    // Holding the arrow used to queue one synchronous full rebuild per tick.
    const { root, count } = mount();
    const daily = root.querySelector('#plan-daily');
    for (let i = 0; i < 20; i++) stepInput(daily, 45 - i);
    expect(count()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(count()).toBe(1);
  });

  it('collapses rapid typing into a single recompute', () => {
    const { root, count } = mount();
    const cap = root.querySelector('#plan-capacity');
    for (const v of ['1', '12', '120']) {
      cap.value = v;
      cap.dispatchEvent(new Event('input', { bubbles: true }));
      vi.advanceTimersByTime(80); // faster than the debounce window
    }
    expect(count()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(count()).toBe(1);
  });

  it('recomputes once per distinct edit when edits are spaced out', () => {
    const { root, count } = mount();
    const daily = root.querySelector('#plan-daily');
    stepInput(daily, 40);
    vi.advanceTimersByTime(1000);
    stepInput(daily, 35);
    vi.advanceTimersByTime(1000);
    expect(count()).toBe(2);
  });

  it('applies the edited value once the debounce fires', () => {
    const { root } = mount();
    let seen = null;
    document.body.addEventListener('plan-options-change', (e) => {
      seen = e.detail;
    });
    stepInput(root.querySelector('#plan-capacity'), 64);
    vi.advanceTimersByTime(1000);
    expect(seen?.waterCapacityOz).toBe(64);
  });

  it('toggles the optimizer detail panel immediately, without waiting on the debounce', () => {
    const { root } = mount();
    const box = root.querySelector('#plan-optimize-water');
    const details = root.querySelector('#plan-optimize-details');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(details.style.display).toBe('none');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(details.style.display).toBe('flex');
  });
});
