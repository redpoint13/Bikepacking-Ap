/**
 * state.js — Centralized reactive application state store.
 *
 * Manages runtime application state and provides subscription mechanisms for UI updates.
 */

import { PLAN_DEFAULTS } from './plan.js';

export function getPlanDefaults() {
  const defaults = { ...PLAN_DEFAULTS };

  const targetDailyMiles = localStorage.getItem('bpnav-targetDailyMiles');
  if (targetDailyMiles !== null) defaults.targetDailyMiles = Number(targetDailyMiles);

  const waterCapacityOz = localStorage.getItem('bpnav-waterCapacityOz');
  if (waterCapacityOz !== null) defaults.waterCapacityOz = Number(waterCapacityOz);

  const ozPerMile = localStorage.getItem('bpnav-ozPerMile');
  if (ozPerMile !== null) defaults.ozPerMile = Number(ozPerMile);

  const reliableWaterThreshold = localStorage.getItem('bpnav-reliableWaterThreshold');
  if (reliableWaterThreshold !== null)
    defaults.reliableWaterThreshold = Number(reliableWaterThreshold);

  const caloriesPerDay = localStorage.getItem('bpnav-caloriesPerDay');
  if (caloriesPerDay !== null) defaults.caloriesPerDay = Number(caloriesPerDay);

  const campMealsPerDay = localStorage.getItem('bpnav-campMealsPerDay');
  if (campMealsPerDay !== null) defaults.campMealsPerDay = Number(campMealsPerDay);

  const caloriesPerCampMeal = localStorage.getItem('bpnav-caloriesPerCampMeal');
  if (caloriesPerCampMeal !== null) defaults.caloriesPerCampMeal = Number(caloriesPerCampMeal);

  const avgSnackCalories = localStorage.getItem('bpnav-avgSnackCalories');
  if (avgSnackCalories !== null) defaults.avgSnackCalories = Number(avgSnackCalories);

  const maxDetourMi = localStorage.getItem('bpnav-maxDetourMi');
  if (maxDetourMi !== null) defaults.maxDetourMi = Number(maxDetourMi);

  return defaults;
}

export function persistUserPreferences(options) {
  localStorage.setItem('bpnav-targetDailyMiles', options.targetDailyMiles);
  localStorage.setItem('bpnav-waterCapacityOz', options.waterCapacityOz);
  localStorage.setItem('bpnav-ozPerMile', options.ozPerMile);
  localStorage.setItem('bpnav-reliableWaterThreshold', options.reliableWaterThreshold);
  localStorage.setItem('bpnav-caloriesPerDay', options.caloriesPerDay);
  localStorage.setItem('bpnav-campMealsPerDay', options.campMealsPerDay);
  localStorage.setItem('bpnav-caloriesPerCampMeal', options.caloriesPerCampMeal);
  localStorage.setItem('bpnav-avgSnackCalories', options.avgSnackCalories);
  localStorage.setItem('bpnav-maxDetourMi', options.maxDetourMi);
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
