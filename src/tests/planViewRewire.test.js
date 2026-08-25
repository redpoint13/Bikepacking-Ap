import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGPX } from '../gpx.js';
import { PLAN_DEFAULTS, clearPlanCache } from '../plan.js';
import { renderPlanningView } from '../planning.js';

/**
 * renderPlanningView runs again on every route load, but `root` survives — only
 * its innerHTML is replaced. The delegated click handler used to be re-attached
 * each time, so one click ran the stop-state toggle once per route the rider had
 * loaded. After three loads a click cycled optional -> planned -> skipped ->
 * optional, leaving the button looking dead.
 */

const xml = fs.readFileSync(path.resolve(process.cwd(), 'public/Coconino_Loop.gpx'), 'utf8');
let route;

function mountTimes(n) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.id = 'planning-view';
  document.body.appendChild(root);
  for (let i = 0; i < n; i++) renderPlanningView(root, route, { ...PLAN_DEFAULTS });

  let syncs = 0;
  let detail = null;
  document.body.addEventListener('plan-options-change', (e) => {
    syncs++;
    detail = e.detail;
  });
  return { root, stats: () => ({ syncs, detail }) };
}

function clickToggle(root, id = 'wpt-0') {
  const btn = document.createElement('button');
  btn.setAttribute('data-action', 'toggle-stop');
  btn.setAttribute('data-id', id);
  root.appendChild(btn);
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  btn.remove();
}

beforeEach(() => {
  vi.useFakeTimers();
  clearPlanCache();
  route ??= parseGPX(xml);
});
afterEach(() => vi.useRealTimers());

describe('renderPlanningView re-entry', () => {
  it.each([1, 2, 3, 5])('advances a stop exactly one step after %i route load(s)', (loads) => {
    const { root, stats } = mountTimes(loads);
    clickToggle(root);
    const { syncs, detail } = stats();
    expect(syncs).toBe(1);
    expect(detail.userStopStates['wpt-0']).toBe('planned');
  });

  it('keeps cycling correctly across successive clicks', () => {
    const { root, stats } = mountTimes(3);
    clickToggle(root);
    expect(stats().detail.userStopStates['wpt-0']).toBe('planned');
    clickToggle(root);
    expect(stats().detail.userStopStates['wpt-0']).toBe('skipped');
    clickToggle(root);
    expect(stats().detail.userStopStates['wpt-0']).toBe('optional');
  });

  it('handles a day camp selection once per click after repeated loads', () => {
    const { root, stats } = mountTimes(4);
    const btn = document.createElement('button');
    btn.setAttribute('data-action', 'select-day-camp');
    btn.setAttribute('data-day', '2');
    btn.setAttribute('data-target-kind', 'long');
    root.appendChild(btn);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const { syncs, detail } = stats();
    expect(syncs).toBe(1);
    expect(detail.dayCampSelections[2]).toBe('long');
  });

  it('wires a genuinely new root independently', () => {
    const first = mountTimes(2);
    clickToggle(first.root);
    expect(first.stats().syncs).toBe(1);

    const second = mountTimes(1); // fresh element, fresh listener
    clickToggle(second.root);
    expect(second.stats().syncs).toBe(1);
  });

  it('still rebuilds the controls on every call', () => {
    // Re-rendering must refresh the shell even though listeners are not re-added.
    const { root } = mountTimes(1);
    root.querySelector('#plan-daily').value = '99';
    renderPlanningView(root, route, { ...PLAN_DEFAULTS, targetDailyMiles: 30 });
    expect(root.querySelector('#plan-daily').value).toBe('30');
  });
});
