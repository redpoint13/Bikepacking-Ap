import 'fake-indexeddb/auto';
/**
 * app.test.js — Unit tests for the root app renderer.
 *
 * These run in a jsdom environment (no browser, no CSS).
 * They verify the DOM structure and wiring — not visual styling.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../app.js';

// ---------------------------------------------------------------------------
// Setup — fresh container before each test
// ---------------------------------------------------------------------------

let container;

beforeEach(() => {
  container = document.createElement('div');
  renderApp(container);
});

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

describe('App header', () => {
  it('renders a banner landmark', () => {
    expect(container.querySelector('[role="banner"]')).toBeTruthy();
  });

  it('displays the app title', () => {
    const title = container.querySelector('.app-title');
    expect(title).toBeTruthy();
    expect(title.textContent).toBe('Bikepacker Navigator');
  });

  it('shows the "No Route" status chip in idle state', () => {
    const chip = container.querySelector('.status-chip');
    expect(chip).toBeTruthy();
    expect(chip.classList.contains('status-chip--idle')).toBe(true);
    expect(chip.textContent.trim()).toBe('No Route');
  });
});

// ---------------------------------------------------------------------------
// Riding controls
// ---------------------------------------------------------------------------

describe('Riding controls', () => {
  it('has a GPS status line that starts hidden', () => {
    // GPS trouble (a denied permission above all) used to be a console warning
    // only, leaving the rider with a radar stuck at mile 0 and no explanation.
    const status = container.querySelector('#gps-status');
    expect(status).toBeTruthy();
    expect(status.hidden).toBe(true);
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.closest('#riding-controls')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Resource cards
// ---------------------------------------------------------------------------

describe('Resource Radar cards', () => {
  it('renders exactly three resource cards', () => {
    const cards = container.querySelectorAll('.resource-card');
    expect(cards.length).toBe(3);
  });

  it('renders a water card', () => {
    const card = container.querySelector('[data-resource="water"]');
    expect(card).toBeTruthy();
  });

  it('renders a resupply card', () => {
    const card = container.querySelector('[data-resource="resupply"]');
    expect(card).toBeTruthy();
  });

  it('renders a daylight card', () => {
    const card = container.querySelector('[data-resource="daylight"]');
    expect(card).toBeTruthy();
  });

  it('all cards start in idle state', () => {
    const idleCards = container.querySelectorAll('.resource-card--idle');
    expect(idleCards.length).toBe(3);
  });

  it('every card has a label, value, and detail', () => {
    const cards = container.querySelectorAll('.resource-card');
    for (const card of cards) {
      expect(card.querySelector('.card-label')).toBeTruthy();
      expect(card.querySelector('.card-value')).toBeTruthy();
      expect(card.querySelector('.card-detail')).toBeTruthy();
    }
  });

  it('idle card values show em dash placeholder', () => {
    const values = container.querySelectorAll('.card-value');
    for (const v of values) {
      expect(v.textContent.trim()).toBe('—');
    }
  });

  it('water card renders a reliability bar', () => {
    const card = container.querySelector('[data-resource="water"]');
    expect(card.querySelector('.card-reliability')).toBeTruthy();
    expect(card.querySelector('.card-reliability__fill')).toBeTruthy();
  });

  it('water card reliability starts at 0%', () => {
    const fill = container.querySelector('[data-resource="water"] .card-reliability__fill');
    expect(fill.style.width).toBe('0%');
  });
});

// ---------------------------------------------------------------------------
// Daylight section
// ---------------------------------------------------------------------------

describe('Daylight / Sunsprint section', () => {
  it('renders the daylight bar card', () => {
    expect(container.querySelector('.daylight-bar-card')).toBeTruthy();
  });

  it('shows sunrise and sunset labels', () => {
    const labels = container.querySelectorAll('.daylight-bar__label');
    const texts = Array.from(labels).map((l) => l.textContent.trim());
    expect(texts).toContain('Sunrise');
    expect(texts).toContain('Sunset');
  });

  it('shows an empty-state message when no route is loaded', () => {
    const empty = container.querySelector('.daylight-bar__empty');
    expect(empty).toBeTruthy();
    expect(empty.textContent.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Load Route FAB
// ---------------------------------------------------------------------------

describe('Load Route FAB', () => {
  it('renders the FAB button', () => {
    const btn = container.querySelector('#load-route-btn');
    expect(btn).toBeTruthy();
    expect(btn.tagName).toBe('BUTTON');
  });

  it('FAB has an accessible label', () => {
    const btn = container.querySelector('#load-route-btn');
    expect(btn.getAttribute('aria-label')).toBeTruthy();
  });

  it('FAB label text includes "Load Route"', () => {
    const label = container.querySelector('#load-route-btn .fab-label');
    expect(label.textContent.trim()).toBe('Load Route');
  });

  it('clicking the FAB does not throw', () => {
    const btn = container.querySelector('#load-route-btn');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(() => btn.click()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe('Accessibility landmarks', () => {
  it('has a main landmark', () => {
    expect(container.querySelector('[role="main"]')).toBeTruthy();
  });

  it('resource cards list has role="list"', () => {
    expect(container.querySelector('.resource-cards[role="list"]')).toBeTruthy();
  });

  it('daylight bar has an accessible label', () => {
    const bar = container.querySelector('.daylight-bar');
    expect(bar.getAttribute('aria-label')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Offline indicator
// ---------------------------------------------------------------------------

describe('Offline indicator', () => {
  it('renders the offline chip in the header', () => {
    expect(container.querySelector('.offline-chip')).toBeTruthy();
  });

  it('offline chip is hidden by default (navigator.onLine is true in jsdom)', () => {
    const chip = container.querySelector('.offline-chip');
    expect(chip.hidden).toBe(true);
  });

  it('offline chip has aria-hidden="true" when initially hidden', () => {
    const chip = container.querySelector('.offline-chip');
    expect(chip.getAttribute('aria-hidden')).toBe('true');
  });

  it('offline chip has role="status" for screen readers', () => {
    const chip = container.querySelector('.offline-chip');
    expect(chip.getAttribute('role')).toBe('status');
  });

  it('shows the chip when the offline event fires', () => {
    const chip = container.querySelector('.offline-chip');
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    window.dispatchEvent(new Event('offline'));
    expect(chip.hidden).toBe(false);
    expect(chip.getAttribute('aria-hidden')).toBe('false');
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });

  it('hides the chip when the online event fires after going offline', () => {
    const chip = container.querySelector('.offline-chip');
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    window.dispatchEvent(new Event('offline'));
    expect(chip.hidden).toBe(false);
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    window.dispatchEvent(new Event('online'));
    expect(chip.hidden).toBe(true);
    expect(chip.getAttribute('aria-hidden')).toBe('true');
  });

  it('header-chips wrapper contains both the offline chip and status chip', () => {
    const chips = container.querySelector('.header-chips');
    expect(chips).toBeTruthy();
    expect(chips.querySelector('.offline-chip')).toBeTruthy();
    expect(chips.querySelector('.status-chip')).toBeTruthy();
  });
});
