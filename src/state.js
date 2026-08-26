/**
 * state.js — Centralized reactive application state store.
 *
 * Manages runtime application state and provides subscription mechanisms for UI updates.
 */

import { PLAN_DEFAULTS } from './plan.js';

export function getPlanDefaults() {
  const defaults = { ...PLAN_DEFAULTS };

  const readItem = (
    key,
    fallback,
    min = Number.NEGATIVE_INFINITY,
    max = Number.POSITIVE_INFINITY,
  ) => {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === '' || raw === 'undefined' || raw === 'null') return fallback;
    const num = Number(raw);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, num));
  };

  defaults.targetDailyMiles = readItem('bpnav-targetDailyMiles', defaults.targetDailyMiles, 5, 200);
  defaults.waterCapacityOz = readItem('bpnav-waterCapacityOz', defaults.waterCapacityOz, 16, 400);
  defaults.ozPerMile = readItem('bpnav-ozPerMile', defaults.ozPerMile, 1, 20);
  defaults.reliableWaterThreshold = readItem(
    'bpnav-reliableWaterThreshold',
    defaults.reliableWaterThreshold,
    0,
    100,
  );
  defaults.caloriesPerDay = readItem('bpnav-caloriesPerDay', defaults.caloriesPerDay, 1000, 10000);
  defaults.campMealsPerDay = readItem('bpnav-campMealsPerDay', defaults.campMealsPerDay, 0, 5);
  defaults.caloriesPerCampMeal = readItem(
    'bpnav-caloriesPerCampMeal',
    defaults.caloriesPerCampMeal,
    200,
    2000,
  );
  defaults.avgSnackCalories = readItem(
    'bpnav-avgSnackCalories',
    defaults.avgSnackCalories,
    50,
    1000,
  );
  defaults.maxDetourMi = readItem('bpnav-maxDetourMi', defaults.maxDetourMi, 0.1, 25);

  return defaults;
}

export function persistUserPreferences(options) {
  if (!options) return;
  const save = (key, val) => {
    if (val != null && Number.isFinite(Number(val))) {
      localStorage.setItem(key, String(val));
    }
  };
  save('bpnav-targetDailyMiles', options.targetDailyMiles);
  save('bpnav-waterCapacityOz', options.waterCapacityOz);
  save('bpnav-ozPerMile', options.ozPerMile);
  save('bpnav-reliableWaterThreshold', options.reliableWaterThreshold);
  save('bpnav-caloriesPerDay', options.caloriesPerDay);
  save('bpnav-campMealsPerDay', options.campMealsPerDay);
  save('bpnav-caloriesPerCampMeal', options.caloriesPerCampMeal);
  save('bpnav-avgSnackCalories', options.avgSnackCalories);
  save('bpnav-maxDetourMi', options.maxDetourMi);
}

class AppState {
  constructor() {
    /** @type {import('./gpx.js').RouteContext | null} */
    this.currentRoute = null;

    /** @type {import('maplibre-gl').Map | null} */
    this.currentMap = null;

    /** @type {import('./radar.js').RadarController | null} */
    this.radarController = null;

    /** @type {number | null} */
    this.sunsprintTargetMile = null;

    /** @type {string} */
    this.lastSunsprintStatus = 'ok';

    /** @type {number} */
    this.lastCurrentMile = 0;

    /** @type {number} */
    this.lastPaceMph = 15;

    /** @type {boolean} */
    this.isGhostMode = false;

    /** @type {WakeLockSentinel | null} */
    this.wakeLock = null;

    /** @type {number} */
    this.lastSpokenMile = -1;

    /** @type {Date | null} */
    this.currentEtaDate = null;

    /** @type {object | null} */
    this.currentNextResource = null;

    /** @type {Array<object>} */
    this.lastSearchResults = [];

    /** @type {'planning' | 'riding'} */
    this.currentMode = 'planning';

    /** @type {import('./gps.js').GPSManager | null} */
    this.gpsManager = null;

    /** @type {typeof PLAN_DEFAULTS} */
    this.planOptions = getPlanDefaults();

    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  /**
   * Subscribe to state changes on a specific key.
   * @param {string} key
   * @param {Function} listener
   */
  subscribe(key, listener) {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key).add(listener);
    return () => this.listeners.get(key)?.delete(listener);
  }

  /**
   * Notify listeners for a key.
   * @param {string} key
   * @param {*} value
   */
  notify(key, value) {
    const keyListeners = this.listeners.get(key);
    if (keyListeners) {
      for (const listener of keyListeners) {
        listener(value, this);
      }
    }
  }

  setRoute(route) {
    this.currentRoute = route;
    this.notify('route', route);
  }

  setMode(mode) {
    this.currentMode = mode;
    this.notify('mode', mode);
  }

  setGhostMode(enabled) {
    this.isGhostMode = enabled;
    this.notify('ghostMode', enabled);
  }

  updatePlanOptions(newOptions) {
    this.planOptions = { ...this.planOptions, ...newOptions };
    persistUserPreferences(this.planOptions);
    this.notify('planOptions', this.planOptions);
  }
}

export const appState = new AppState();
