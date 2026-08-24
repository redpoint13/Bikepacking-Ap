/**
 * domGuards.test.js — Guarded DOM helpers and the call sites that use them.
 *
 * The unguarded form (`root.querySelector('#x').textContent = …`) throws a
 * TypeError whenever the element is absent, aborting the rest of the update and
 * leaving the UI half-written. These verify the guards hold.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { updateSunsprintDisplay } from '../app.js';
import { find, on, readValue, setHTML, setProps, setStyle, setText } from '../utils/dom.js';

let root;

beforeEach(() => {
  root = document.createElement('div');
  root.innerHTML = '<span id="present"></span><input id="field" value="  hi  " />';
});

describe('guarded DOM helpers', () => {
  it('write to elements that exist', () => {
    setText(root, '#present', 'hello');
    expect(root.querySelector('#present').textContent).toBe('hello');

    setHTML(root, '#present', '<b>x</b>');
    expect(root.querySelector('#present').innerHTML).toBe('<b>x</b>');

    setStyle(root, '#present', 'width', '50%');
    expect(root.querySelector('#present').style.width).toBe('50%');

    setProps(root, '#present', { hidden: true });
    expect(root.querySelector('#present').hidden).toBe(true);
  });

  it('are no-ops when the selector matches nothing', () => {
    expect(() => setText(root, '#missing', 'x')).not.toThrow();
    expect(() => setHTML(root, '#missing', 'x')).not.toThrow();
    expect(() => setStyle(root, '#missing', 'width', '1px')).not.toThrow();
    expect(() => setProps(root, '#missing', { hidden: true })).not.toThrow();
    expect(setText(root, '#missing', 'x')).toBeNull();
  });

  it('tolerate a null or undefined root', () => {
    expect(() => setText(null, '#present', 'x')).not.toThrow();
    expect(() => setHTML(undefined, '#present', 'x')).not.toThrow();
    expect(find(null, '#present')).toBeNull();
  });

  it('only attach listeners to elements that exist', () => {
    let fired = 0;
    on(root, '#present', 'click', () => fired++);
    expect(() => on(root, '#missing', 'click', () => fired++)).not.toThrow();

    root.querySelector('#present').click();
    expect(fired).toBe(1);
  });

  it('readValue trims, and returns empty string when absent', () => {
    expect(readValue(root, '#field')).toBe('hi');
    expect(readValue(root, '#missing')).toBe('');
    expect(readValue(null, '#field')).toBe('');
  });
});

describe('updateSunsprintDisplay', () => {
  const ROUTE = {
    name: 'Guard Test',
    totalDistanceMiles: 30,
    trackPoints: Array.from({ length: 40 }, (_, i) => [35.0 + i * 0.002, -111.0, 2000]),
    waypoints: [],
    bounds: { minLat: 35, maxLat: 35.1, minLon: -111.1, maxLon: -111 },
    startPoint: { lat: 35, lon: -111 },
    startOffsetMi: 0,
    isLoop: false,
    metadata: {},
  };

  it('does nothing when the card is absent', () => {
    const container = document.createElement('div');
    expect(() => updateSunsprintDisplay(container, ROUTE, 5, 10)).not.toThrow();
  });

  // The card exists but its inner nodes do not — the partial-render case that
  // previously threw on `card.querySelector('#sunsprint-sunrise').textContent`.
  it('survives a card whose inner nodes are missing', () => {
    const container = document.createElement('div');
    container.innerHTML = '<div id="sunsprint-card"></div>';
    expect(() => updateSunsprintDisplay(container, ROUTE, 5, 10)).not.toThrow();
  });
});
