import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '../app.js';

/**
 * The map overlay compacts itself in Riding mode via [data-mode='riding'], so
 * that the mile-marker toggle and add-waypoint button stop eating a corner of
 * the map on a phone. That hook is set in applyMode and is invisible to the
 * rest of the app, so nothing else would notice if it disappeared — and the
 * compaction would silently stop working.
 */

let container;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  renderApp(container);
});

describe('riding-mode overlay hook', () => {
  it('publishes the current mode on the container', () => {
    expect(container.dataset.mode).toBe('planning');
    container.querySelector('#mode-riding').click();
    expect(container.dataset.mode).toBe('riding');
    container.querySelector('#mode-planning').click();
    expect(container.dataset.mode).toBe('planning');
  });

  it('keeps the overlay controls labelled once their text is hidden', () => {
    // In Riding mode the visible text is display:none, so the accessible name
    // has to come from the element itself rather than its label text.
    const addBtn = container.querySelector('#btn-add-custom-poi');
    expect(addBtn.getAttribute('aria-label')).toMatch(/add waypoint/i);
    expect(addBtn.title).toMatch(/add waypoint/i);

    const milesToggle = container.querySelector('#map-toggle-miles');
    expect(milesToggle.getAttribute('aria-label')).toMatch(/mile markers/i);
  });

  it('marks the hideable text so the compact rule has something to target', () => {
    const texts = [...container.querySelectorAll('.map-overlay-controls__text')].map((e) =>
      e.textContent.trim(),
    );
    expect(texts).toEqual(['Mile Markers', 'Add Waypoint']);
  });
});
