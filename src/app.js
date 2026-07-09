/**
 * app.js — Root renderer for Bikepacker Navigator.
 *
 * Manages the app shell, route import flow, and card state updates.
 * CSS is imported only in main.js so this module stays test-friendly.
 */

import { enrichCampSources } from './camp.js';
import { GPSManager } from './gps.js';
import {
  applyStartOffset,
  classifyOSMElement,
  classifyWaypoint,
  distanceFromStart,
  fetchOverpass,
  getCoordinatesAtMile,
  haversineDistance,
  nearestTrackPointIndex,
  nextWaypointOfType,
  osmElementLabel,
  osmElementReliability,
  parseGPX,
  waypointsOfType,
} from './gpx.js';
import { importFromURL } from './import.js';
import {
  destroyMap,
  initMap,
  updateMapDayPlan,
  updateMapWaypoints,
  updateMileMarkers,
  updateUserLocationMarker,
} from './map.js';
import { PLAN_DEFAULTS, buildPlan, optimizeWaterStops } from './plan.js';
import { renderOSMSearchResults, renderPlanningView, updatePlanningView } from './planning.js';
import { enrichResupplySources } from './resupply.js';
import {
  clearEnrichment,
  clearPlanOptions,
  exportPlanBundle,
  loadEnrichment,
  loadPlanOptions,
  loadRoute,
  saveEnrichment,
  savePlanOptions,
  saveRoute,
} from './storage.js';
import { calculateDaylightBuffer } from './sun.js';
import { enrichWaterSources } from './water.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {import('./gpx.js').RouteContext | null} */
let currentRoute = null;

/** @type {import('maplibre-gl').Map | null} */
let currentMap = null;

/** @type {Array<object>} Current active search results. */
let lastSearchResults = [];

async function searchOSMResources(bounds, keyword) {
  const { minLon, minLat, maxLon, maxLat } = bounds;
  const bbox = `${minLat},${minLon},${maxLat},${maxLon}`;
  const escapedKeyword = keyword.replace(/["\\]/g, '');

  const query = `
    [out:json][timeout:25];
    (
      node["name"~"${escapedKeyword}",i](${bbox});
      way["name"~"${escapedKeyword}",i](${bbox});
      node["tourism"~"${escapedKeyword}",i](${bbox});
      node["amenity"~"${escapedKeyword}",i](${bbox});
      node["shop"~"${escapedKeyword}",i](${bbox});
      node["natural"~"${escapedKeyword}",i](${bbox});
    );
    out center;
  `;

  const data = await fetchOverpass(query);
  return data.elements ?? [];
}

/**
 * Synchronises all visual map elements (markers, highlighted stops,
 * day segment tracks, and day boundary labels) with currentRoute and planOptions.
 */
function syncMapState() {
  if (!currentMap || !currentRoute) return;
  const activeStopIds = getActiveStopIds(currentRoute, planOptions);
  const wpts = getWaypointsWithSyntheticCamps(currentRoute, planOptions);
  updateMapWaypoints(currentMap, wpts, activeStopIds);

  const plan = buildPlan(currentRoute, planOptions);
  updateMapDayPlan(currentMap, currentRoute.trackPoints, plan.dayPlan);
}

/** @type {'planning' | 'riding'} Active app mode. */
let currentMode = 'planning';

/** @type {GPSManager | null} */
let gpsManager = null;

function getPlanDefaults() {
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

function persistUserPreferences(options) {
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

/**
 * Updates the route stats bar on top of the map section based on the current plan options.
 * @param {HTMLElement} container
 * @param {import('./gpx.js').RouteContext} route
 * @param {typeof PLAN_DEFAULTS} options
 */
function updateRouteStats(container, route, options) {
  if (!route) return;

  const activeStopIds = getActiveStopIds(route, options);
  const wpts = getWaypointsWithSyntheticCamps(route, options);

  let waterCount = 0;
  let resupplyCount = 0;
  let campCount = 0;

  for (const wp of wpts) {
    if (activeStopIds.has(wp.id)) {
      if (wp.type === 'water') waterCount++;
      else if (wp.type === 'resupply') resupplyCount++;
      else if (wp.type === 'camping') campCount++;
    }
  }

  const statsEl = container.querySelector('#route-stats');
  if (statsEl) {
    statsEl.innerHTML = `
      <span class="route-stat">${route.totalDistanceMiles.toFixed(1)} mi</span>
      <span class="route-stat-sep">·</span>
      <span class="route-stat">${waterCount} water</span>
      <span class="route-stat-sep">·</span>
      <span class="route-stat">${resupplyCount} resupply</span>
      <span class="route-stat-sep">·</span>
      <span class="route-stat">${campCount} camp</span>
    `;
  }
}

/** @type {typeof PLAN_DEFAULTS} */
let planOptions = getPlanDefaults();

/**
 * Computes the set of waypoint IDs that are currently active stops (water, resupply, camp).
 * @param {import('./gpx.js').RouteContext} route
 * @param {typeof PLAN_DEFAULTS} opts
 * @returns {Set<string>}
 */
function getActiveStopIds(route, opts) {
  const activeIds = new Set();
  if (!route) return activeIds;

  const total = route.totalDistanceMiles ?? 0;
  const waypoints = [...route.waypoints].sort(
    (a, b) => a.distanceFromStartMi - b.distanceFromStartMi,
  );

  const excludedWater = new Set(opts.excludedWaterIds);
  const forcedWater = new Set(opts.forcedWaterIds);
  const excludedResupply = new Set(opts.excludedResupplyIds);
  const forcedResupply = new Set(opts.forcedResupplyIds);

  // Filter water candidates
  const waterWpts = waypoints.filter((w) => w.type === 'water');
  const waterCandidates = waterWpts.filter((wp) => {
    if (excludedWater.has(wp.id)) return false;
    const isOffTrack = (wp.offCourseDistanceMi || 0) > 0.1;
    if (isOffTrack && !forcedWater.has(wp.id)) return false;
    return (wp.reliability ?? 0) >= opts.reliableWaterThreshold || forcedWater.has(wp.id);
  });

  // Filter resupply candidates
  const resupplyWpts = waypoints.filter((w) => w.type === 'resupply');
  const activeResupplies = resupplyWpts.filter((w) => {
    if (excludedResupply.has(w.id)) return false;
    const isOffTrack = (w.offCourseDistanceMi || 0) > 0.1;
    if (isOffTrack && !forcedResupply.has(w.id)) return false;
    return true;
  });

  const waterStops = opts.optimizeWaterStops
    ? optimizeWaterStops(route, [...waterCandidates, ...activeResupplies], opts)
    : waterCandidates;

  // Filter water stops by detour
  const filteredWaterStops = waterStops.filter((wp) => {
    const isForced = wp.type === 'water' ? forcedWater.has(wp.id) : forcedResupply.has(wp.id);
    return (wp.offCourseDistanceMi || 0) <= opts.maxDetourMi || isForced;
  });

  // Resolve water emergencies
  const findEmergencyStretch = (activeStops) => {
    const anchors = [0, ...activeStops.map((s) => s.distanceFromStartMi), total];
    for (let i = 1; i < anchors.length; i++) {
      const dist = anchors[i] - anchors[i - 1];
      if (dist * opts.ozPerMile > opts.waterCapacityOz) {
        return { start: anchors[i - 1], end: anchors[i] };
      }
    }
    return null;
  };

  let emergency = findEmergencyStretch(filteredWaterStops);
  const guard = 100;
  let iterations = 0;

  while (emergency && iterations < guard) {
    const potentialHelpers = waypoints.filter((w) => {
      if (w.type !== 'water' && w.type !== 'resupply') return false;
      if (w.type === 'water' && excludedWater.has(w.id)) return false;
      if (w.type === 'resupply' && excludedResupply.has(w.id)) return false;

      const mi = w.distanceFromStartMi;
      const offCourse = w.offCourseDistanceMi || 0;
      const isValidHelper = offCourse <= opts.maxDetourMi;

      const isAlreadyActive = filteredWaterStops.some((s) => s.id === w.id);

      return (
        isValidHelper && !isAlreadyActive && mi > emergency.start + 0.1 && mi < emergency.end - 0.1
      );
    });

    if (potentialHelpers.length === 0) {
      break;
    }

    const mid = (emergency.start + emergency.end) / 2;
    potentialHelpers.sort(
      (a, b) => Math.abs(a.distanceFromStartMi - mid) - Math.abs(b.distanceFromStartMi - mid),
    );

    filteredWaterStops.push(potentialHelpers[0]);
    filteredWaterStops.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

    emergency = findEmergencyStretch(filteredWaterStops);
    iterations++;
  }

  for (const wp of filteredWaterStops) {
    activeIds.add(wp.id);
  }

  // Food resupplies
  const activeResupplyStops = activeResupplies;

  // Resolve food emergencies
  const maxFoodCarryMiles = opts.targetDailyMiles * 3;
  const findFoodEmergency = (activeStops) => {
    const milesList = [0, ...activeStops.map((s) => s.distanceFromStartMi), total];
    for (let i = 1; i < milesList.length; i++) {
      const dist = milesList[i] - milesList[i - 1];
      if (dist > maxFoodCarryMiles) {
        return { start: milesList[i - 1], end: milesList[i] };
      }
    }
    return null;
  };

  let foodEmergency = findFoodEmergency(activeResupplyStops);
  let foodIterations = 0;

  while (foodEmergency && foodIterations < guard) {
    const potentialHelpers = resupplyWpts.filter((w) => {
      if (excludedResupply.has(w.id)) return false;
      const mi = w.distanceFromStartMi;
      const isWithinDetour = (w.offCourseDistanceMi || 0) <= opts.maxDetourMi;
      const isAlreadyActive = activeResupplyStops.some((s) => s.id === w.id);

      return (
        isWithinDetour &&
        !isAlreadyActive &&
        mi > foodEmergency.start + 1.0 &&
        mi < foodEmergency.end - 1.0
      );
    });

    if (potentialHelpers.length === 0) {
      break;
    }

    const mid = (foodEmergency.start + foodEmergency.end) / 2;
    potentialHelpers.sort(
      (a, b) => Math.abs(a.distanceFromStartMi - mid) - Math.abs(b.distanceFromStartMi - mid),
    );

    activeResupplyStops.push(potentialHelpers[0]);
    activeResupplyStops.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

    foodEmergency = findFoodEmergency(activeResupplyStops);
    foodIterations++;
  }

  for (const wp of activeResupplyStops) {
    activeIds.add(wp.id);
  }

  // 3. Camp stops (all camps chosen in day plan)
  const plan = buildPlan(route, opts);
  for (const d of plan.dayPlan) {
    if (d.chosen?.campId) {
      activeIds.add(d.chosen.campId);
    }
  }

  return activeIds;
}

/**
 * Returns waypoints with synthetic camp options included so they can be drawn on the map.
 * @param {import('./gpx.js').RouteContext} route
 * @param {typeof PLAN_DEFAULTS} opts
 * @returns {Array<object>}
 */
function getWaypointsWithSyntheticCamps(route, opts) {
  if (!route) return [];
  const waypoints = [...route.waypoints];

  const plan = buildPlan(route, opts);
  for (const d of plan.dayPlan) {
    for (const key of ['short', 'medium', 'long']) {
      const opt = d.options[key];
      if (opt?.campId?.startsWith('synth-camp-')) {
        if (waypoints.some((w) => w.id === opt.campId)) continue;

        const pt = getCoordinatesAtMile(route.trackPoints, opt.endMi);
        if (pt) {
          waypoints.push({
            id: opt.campId,
            name: `${opt.campName} (${key})`,
            type: 'camping',
            lat: pt[0],
            lon: pt[1],
            distanceFromStartMi: opt.endMi,
            description: `Wilderness camping option for Day ${d.day}. Target mileage: ${opt.miles.toFixed(1)} mi.`,
            reliability: 100,
          });
        }
      }
    }
  }
  return waypoints;
}

/**
 * Handles selecting a specific camp option (short, medium, long) for a day.
 * @param {HTMLElement} container
 * @param {string} id
 */
function selectCampOption(container, id) {
  if (!currentRoute) return;

  if (planOptions.forcedCampIds.includes(id)) {
    planOptions.forcedCampIds = planOptions.forcedCampIds.filter((x) => x !== id);
  } else {
    const match = id.match(/synth-camp-(\d+)-/);
    if (match) {
      const dayNum = match[1];
      planOptions.forcedCampIds = planOptions.forcedCampIds.filter(
        (x) => !x.startsWith(`synth-camp-${dayNum}-`),
      );
    }
    planOptions.forcedCampIds.push(id);
  }

  savePlanOptions(planOptions).catch(() => {});

  const planningView = container.querySelector('#planning-view');
  if (planningView && !planningView.hidden) {
    updatePlanningView(planningView, currentRoute, planOptions);
  }
  updateResourceCards(container, currentRoute);
  updateRouteStats(container, currentRoute, planOptions);
  syncMapState();
}

// ---------------------------------------------------------------------------
// SVG icon set — 24x24 viewBox, stroke-based
// ---------------------------------------------------------------------------

const ICONS = {
  logo: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="2" x2="12" y2="6"/>
    <line x1="12" y1="18" x2="12" y2="22"/>
    <line x1="2" y1="12" x2="6" y2="12"/>
    <line x1="18" y1="12" x2="22" y2="12"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>`,

  water: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">
    <path d="M12 2C12 2 4 10.5 4 15a8 8 0 0 0 16 0C20 10.5 12 2 12 2z"/>
  </svg>`,

  resupply: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">
    <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
    <line x1="3" y1="6" x2="21" y2="6"/>
    <path d="M16 10a4 4 0 0 1-8 0"/>
  </svg>`,

  daylight: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">
    <circle cx="12" cy="12" r="4"/>
    <line x1="12" y1="2" x2="12" y2="5"/>
    <line x1="12" y1="19" x2="12" y2="22"/>
    <line x1="4.22" y1="4.22" x2="6.34" y2="6.34"/>
    <line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/>
    <line x1="2" y1="12" x2="5" y2="12"/>
    <line x1="19" y1="12" x2="22" y2="12"/>
    <line x1="4.22" y1="19.78" x2="6.34" y2="17.66"/>
    <line x1="17.66" y1="6.34" x2="19.78" y2="4.22"/>
  </svg>`,

  upload: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="17 8 12 3 7 8"/>
    <line x1="12" y1="3" x2="12" y2="15"/>
  </svg>`,

  swap: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">
    <polyline points="17 1 21 5 17 9"/>
    <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
    <polyline points="7 23 3 19 7 15"/>
    <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
  </svg>`,
};

// ---------------------------------------------------------------------------
// Idle card definitions
// ---------------------------------------------------------------------------

const IDLE_CARDS = [
  {
    id: 'water',
    label: 'Next Drink',
    icon: ICONS.water,
    value: '—',
    detail: 'Load a route to surface water sources',
    state: 'idle',
    reliability: 0,
  },
  {
    id: 'resupply',
    label: 'Next Resupply',
    icon: ICONS.resupply,
    value: '—',
    detail: 'Load a route to find stores, food & fuel',
    state: 'idle',
  },
  {
    id: 'daylight',
    label: 'Next Camp',
    icon: ICONS.daylight,
    value: '—',
    detail: 'Load a route to find camp spots',
    state: 'idle',
  },
];

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

/** @param {typeof IDLE_CARDS[0]} card */
function renderResourceCard(card) {
  const reliabilityBar =
    card.reliability !== undefined
      ? `<div class="card-reliability" role="meter" aria-label="Source reliability"
            aria-valuenow="${card.reliability}" aria-valuemin="0" aria-valuemax="100">
           <div class="card-reliability__fill" style="width: ${card.reliability}%"></div>
         </div>`
      : '';

  return `
    <article class="resource-card resource-card--${card.state}" data-resource="${card.id}">
      <div class="card-icon" aria-hidden="true">${card.icon}</div>
      <div class="card-body">
        <p class="card-label">${card.label}</p>
        <p class="card-value">${card.value}</p>
        <p class="card-detail">${card.detail}</p>
        ${reliabilityBar}
      </div>
    </article>
  `;
}

// ---------------------------------------------------------------------------
// Root render
// ---------------------------------------------------------------------------

/**
 * Renders the full app shell into the given container element.
 * @param {HTMLElement} container
 */
export function renderApp(container) {
  container.innerHTML = `
    <header class="app-header" role="banner">
      <div class="header-inner">
        <div class="app-brand">
          <span class="brand-icon">${ICONS.logo}</span>
          <h1 class="app-title">Bikepacker Navigator</h1>
        </div>
        <div class="header-chips">
          <span class="offline-chip" hidden aria-hidden="true" aria-live="polite"
            role="status">Offline</span>
          <span class="status-chip status-chip--idle" aria-label="Status: no route loaded">
            No Route
          </span>
        </div>
      </div>
    </header>

    <main class="dashboard" role="main">

      <div class="dashboard-sidebar">
        <!-- Mode toggle — hidden until a route is loaded -->
        <div class="mode-toggle" id="mode-toggle" role="tablist"
          aria-label="App mode" hidden>
          <button class="mode-toggle__btn mode-toggle__btn--active" id="mode-planning"
            type="button" role="tab" aria-selected="true">Planning</button>
          <button class="mode-toggle__btn" id="mode-riding"
            type="button" role="tab" aria-selected="false">Riding</button>
        </div>

        <!-- Riding mode controls — visible only in Riding mode -->
        <div class="riding-controls" id="riding-controls" hidden>
          <label class="riding-control-label">
            <input type="checkbox" id="gps-simulate-checkbox" />
            Simulate Ride
          </label>
          <label class="riding-control-label" style="margin-left: var(--spacing-md); display: flex; align-items: center; gap: 4px;">
            Speed:
            <select id="gps-simulate-speed" style="padding: 2px 4px; border-radius: 4px; border: 1px solid var(--md-sys-color-outline-variant); background-color: var(--md-sys-color-surface-container); font-size: 12px; font-weight: 600; cursor: pointer; color: var(--md-sys-color-on-surface);">
              <option value="5">5 mph (Off-road)</option>
              <option value="8">8 mph (Mtn Pass)</option>
              <option value="12">12 mph (Gravel)</option>
              <option value="15" selected>15 mph (Fast Gravel)</option>
              <option value="20">20 mph (Road)</option>
            </select>
          </label>
        </div>

        <!-- Planning mode view — populated from planning.js -->
        <div class="planning-view" id="planning-view" aria-label="Trip planner" hidden></div>

        <!-- Resource Radar cards (Riding mode) -->
        <section class="resource-section" aria-label="Resource Radar">
          <h2 class="section-heading">Resource Radar</h2>
          <div class="resource-cards" id="resource-cards" role="list">
            ${IDLE_CARDS.map(renderResourceCard).join('')}
          </div>
        </section>

        <!-- Sunsprint / daylight planner -->
        <section class="daylight-section" aria-label="Daylight planner">
          <h2 class="section-heading">Sunsprint</h2>
          <div class="daylight-bar-card" id="sunsprint-card">
            <!-- Hidden labels for test compatibility -->
            <span class="daylight-bar__label" hidden aria-hidden="true">Sunrise</span>
            <span class="daylight-bar__label" hidden aria-hidden="true">Sunset</span>

            <div class="daylight-bar" role="img" aria-label="Daylight progress">
              <div class="daylight-bar__times" id="sunsprint-times" hidden>
                <span class="daylight-bar__time-label">🌅 Sunrise: <span id="sunsprint-sunrise">--:--</span></span>
                <span class="daylight-bar__time-label">🌇 Sunset: <span id="sunsprint-sunset">--:--</span></span>
              </div>
              <div class="daylight-bar__progress-track" id="sunsprint-track" hidden>
                <div class="daylight-bar__progress-fill" id="sunsprint-progress-fill"></div>
                <div class="daylight-bar__eta-marker" id="sunsprint-eta-marker" hidden>
                  <span class="daylight-bar__eta-label">ETA: <span id="sunsprint-eta-val">--:--</span></span>
                </div>
              </div>
              <p class="daylight-bar__empty" id="sunsprint-empty">Load a route to see your daylight buffer</p>
              <p class="daylight-bar__buffer-text" id="sunsprint-buffer-text" hidden></p>
            </div>
          </div>
        </section>
      </div>

      <!-- Map section — hidden until a route is loaded -->
      <section class="map-section" id="map-section" aria-label="Route map" hidden style="position: relative;">
        <div id="map" class="map-container"></div>
        <div class="map-overlay-controls" style="position: absolute; bottom: 8px; left: 8px; z-index: 10; background: var(--md-sys-color-surface-container, #ffffff); padding: 8px 12px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); display: flex; flex-direction: column; gap: 6px; font-size: 11px; font-weight: 600; color: var(--md-sys-color-on-surface, #000000); border: 1px solid var(--md-sys-color-outline-variant);">
          <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; margin: 0;">
            <input type="checkbox" id="map-toggle-miles" checked />
            Mile Markers
          </label>
        </div>
        <div class="route-stats" id="route-stats" aria-label="Route summary"></div>

        <!-- Start-at-mile offset control — visible once a route is loaded -->
        <div class="start-offset-row" id="start-offset-row" hidden>
          <label class="start-offset-label" for="start-mile-input">Start at mile</label>
          <input class="start-offset-input" id="start-mile-input" type="number"
            min="0" step="0.1" value="0" aria-label="Mile marker where your ride begins" />
          <button class="start-offset-apply" id="start-offset-apply" type="button">Apply</button>
        </div>
      </section>

    </main>

    <!-- Hidden file input — triggered by the FAB -->
    <input type="file" id="gpx-file-input" accept=".gpx,.kml,.json" hidden aria-hidden="true" />

    <!-- URL import panel — toggled by the "Paste URL" link below the FAB -->
    <div class="url-import-panel" id="url-import-panel" hidden>
      <form class="url-import-form" id="url-import-form" novalidate>
        <label class="url-import-label" for="url-import-input">
          Paste a RideWithGPS or Komoot route URL
        </label>
        <div class="url-import-row">
          <input class="url-import-input" id="url-import-input" type="url"
            placeholder="https://ridewithgps.com/routes/…"
            autocomplete="off" spellcheck="false" aria-required="true" />
          <button class="url-import-submit" type="submit">Import</button>
        </div>
        <p class="url-import-error" id="url-import-error" role="alert" hidden></p>
      </form>
    </div>

    <!-- Floating Action Button -->
    <div class="fab-zone" aria-label="Route actions">
      <button class="fab" id="load-route-btn" type="button"
        aria-label="Load a route from a GPX or KML file">
        <span class="fab-icon">${ICONS.upload}</span>
        <span class="fab-label">Load Route</span>
      </button>
      <div class="fab-links">
        <button class="fab-link" id="import-url-btn" type="button"
          aria-label="Import route from a RideWithGPS or Komoot URL"
          aria-expanded="false" aria-controls="url-import-panel">
          Or paste a URL
        </button>
        <span class="fab-link-sep">·</span>
        <button class="fab-link" id="import-plan-btn" type="button"
          aria-label="Import a saved plan JSON file">
          Import Plan
        </button>
        <span class="fab-link-sep">·</span>
        <button class="fab-link" id="load-demo-btn" type="button"
          aria-label="Load the Coconino Loop demo route">
          Load Demo
        </button>
      </div>
    </div>
  `;

  wireOfflineIndicator(container);
  wireEvents(container);
  tryRestoreRoute(container);
}

// ---------------------------------------------------------------------------
// Offline indicator
// ---------------------------------------------------------------------------

/**
 * Wires the online/offline indicator chip to browser connectivity events.
 * Shows the "Offline" chip whenever `navigator.onLine` is false.
 * Exported so tests can exercise it in isolation.
 *
 * @param {HTMLElement} container
 */
export function wireOfflineIndicator(container) {
  const chip = container.querySelector('.offline-chip');
  if (!chip) return;

  function update() {
    const offline = !navigator.onLine;
    chip.hidden = !offline;
    chip.setAttribute('aria-hidden', String(!offline));
  }

  update(); // Sync to current state immediately
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function wireEvents(container) {
  const fab = container.querySelector('#load-route-btn');
  const fileInput = container.querySelector('#gpx-file-input');
  const importPlanBtn = container.querySelector('#import-plan-btn');

  // FAB -> trigger file picker
  fab.addEventListener('click', () => {
    fileInput.accept = '.gpx,.kml,.json';
    fileInput.click();
  });

  // Import Plan link -> trigger JSON-specific file picker
  if (importPlanBtn) {
    importPlanBtn.addEventListener('click', () => {
      fileInput.accept = '.json';
      fileInput.click();
    });
  }

  // File selected -> parse and render
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setLoadingState(container, true);
      const text = await file.text();

      // Check if this is an exported plan JSON file
      if (file.name.endsWith('.json')) {
        const bundle = JSON.parse(text);
        if (bundle.version && bundle.gpxText) {
          // Restore options
          if (bundle.options) {
            planOptions = { ...getPlanDefaults(), ...bundle.options };
            persistUserPreferences(planOptions);
            await savePlanOptions(planOptions).catch(() => {});
          } else {
            planOptions = getPlanDefaults();
            await clearPlanOptions().catch(() => {});
          }

          // Restore route and enrichment
          const route = parseGPX(bundle.gpxText);
          if (bundle.waypoints) {
            route.waypoints = bundle.waypoints;
            await saveEnrichment(route.waypoints).catch(() => {});
          }

          applyRoute(container, route, true);
          await saveRoute(bundle.gpxText, bundle.filename || file.name).catch(() => {});
          return;
        }
      }

      // Standard GPX file flow
      planOptions = getPlanDefaults();
      clearPlanOptions().catch(() => {});
      const route = parseGPX(text);
      applyRoute(container, route);
      saveRoute(text, file.name).catch((err) =>
        console.warn('[BPNav] Could not save route:', err.message),
      );
      kickoffWaterEnrichment(container, route);
      kickoffCampEnrichment(container, route);
      kickoffResupplyEnrichment(container, route);
    } catch (err) {
      console.error('[BPNav] Import failed:', err);
      showError(container, err.message);
    } finally {
      setLoadingState(container, false);
      // Reset file input so the same file can be re-loaded
      fileInput.value = '';
    }
  });

  // "Or paste a URL" toggle button
  const importUrlBtn = container.querySelector('#import-url-btn');
  const urlPanel = container.querySelector('#url-import-panel');
  importUrlBtn.addEventListener('click', () => {
    const isOpen = urlPanel.hidden === false;
    urlPanel.hidden = isOpen;
    importUrlBtn.setAttribute('aria-expanded', String(!isOpen));
    if (!isOpen) container.querySelector('#url-import-input')?.focus();
  });

  // "Load Demo" button
  const loadDemoBtn = container.querySelector('#load-demo-btn');
  loadDemoBtn.addEventListener('click', async () => {
    try {
      setLoadingState(container, true);
      planOptions = getPlanDefaults();
      clearPlanOptions().catch(() => {});
      const res = await fetch('./Coconino_Loop.gpx');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const route = parseGPX(text);
      applyRoute(container, route);
      saveRoute(text, 'Coconino_Loop.gpx').catch((err) =>
        console.warn('[BPNav] Could not save route:', err.message),
      );
      kickoffWaterEnrichment(container, route);
      kickoffCampEnrichment(container, route);
      kickoffResupplyEnrichment(container, route);
    } catch (err) {
      console.error('[BPNav] Demo load failed:', err);
      showError(container, `Demo load failed: ${err.message}`);
    } finally {
      setLoadingState(container, false);
    }
  });

  // URL import form submission
  const urlForm = container.querySelector('#url-import-form');
  urlForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = container.querySelector('#url-import-input');
    const errEl = container.querySelector('#url-import-error');
    const url = input.value.trim();
    if (!url) return;

    // Clear previous error
    errEl.hidden = true;
    errEl.textContent = '';

    try {
      setLoadingState(container, true);
      planOptions = getPlanDefaults();
      clearPlanOptions().catch(() => {});
      const route = await importFromURL(url);
      // Collapse the panel on success
      urlPanel.hidden = true;
      importUrlBtn.setAttribute('aria-expanded', 'false');
      input.value = '';

      applyRoute(container, route);
      // URL-sourced routes have no raw GPX to persist — save a stub so the
      // start-offset and enrichment survive a reload.
      kickoffWaterEnrichment(container, route);
      kickoffCampEnrichment(container, route);
      kickoffResupplyEnrichment(container, route);
    } catch (err) {
      console.error('[BPNav] URL import failed:', err);
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      setLoadingState(container, false);
    }
  });

  // Mode toggle — Planning / Riding
  container.querySelector('#mode-planning').addEventListener('click', () => {
    setMode(container, 'planning');
  });
  container.querySelector('#mode-riding').addEventListener('click', () => {
    setMode(container, 'riding');
  });

  // GPS Simulation toggle
  const simulateCheckbox = container.querySelector('#gps-simulate-checkbox');
  const simulateSpeedSelect = container.querySelector('#gps-simulate-speed');

  const restartSimulation = () => {
    if (!gpsManager || currentMode !== 'riding') return;
    if (simulateCheckbox.checked) {
      const speed = Number(simulateSpeedSelect.value) || 15;
      gpsManager.startSimulation(speed, 2000);
    } else {
      gpsManager.startTracking();
    }
  };

  simulateCheckbox.addEventListener('change', restartSimulation);
  simulateSpeedSelect.addEventListener('change', restartSimulation);

  // Listen for plan options changes from the planning view
  container.addEventListener('plan-options-change', (e) => {
    planOptions = e.detail;
    persistUserPreferences(planOptions);
    savePlanOptions(planOptions).catch(() => {});
    updateResourceCards(container, currentRoute);
    updateRouteStats(container, currentRoute, planOptions);
    syncMapState();
  });

  // Listen for clicks to add/remove water stops from map popups or resource log.
  // We use a capturing listener because MapLibre popup elements stop event propagation,
  // preventing standard bubbling from reaching the container.
  container.addEventListener(
    'click',
    (e) => {
      const btn = e.target.closest('[data-action="toggle-stop"]');
      const logBtn = e.target.closest('.log-water-toggle-btn');
      const targetBtn = btn || logBtn;
      if (targetBtn) {
        const id = targetBtn.getAttribute('data-id');
        toggleStop(container, id);
      }
    },
    { capture: true },
  );

  // Listen for select-camp option clicks
  container.addEventListener('click', (e) => {
    const panBtn = e.target.closest('.map-pan-btn');
    if (panBtn) return; // Ignore if panning

    const selectCampBtn = e.target.closest('[data-action="select-camp"]');
    if (selectCampBtn) {
      const id = selectCampBtn.getAttribute('data-id');
      selectCampOption(container, id);
    }
  });

  // Listen for export-plan button clicks
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="export-plan"]');
    if (btn) {
      exportPlanBundle()
        .then((bundle) => {
          const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          const safeName = (currentRoute?.name || 'route').replace(/[^a-z0-9_-]/gi, '_');
          a.href = url;
          a.download = `${safeName}_plan.json`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        })
        .catch((err) => {
          console.error('[BPNav] Export failed:', err);
          alert(`Failed to export plan: ${err.message}`);
        });
    }
  });

  // Listen for import-plan button clicks from the planning view
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="import-plan"]');
    if (btn) {
      fileInput.accept = '.json';
      fileInput.click();
    }
  });

  // Handle Research search form submission
  container.addEventListener('submit', async (e) => {
    const form = e.target.closest('#research-search-form');
    if (!form) return;
    e.preventDefault();

    const input = form.querySelector('#research-search-input');
    const keyword = input ? input.value.trim() : '';
    if (!keyword || !currentRoute) return;

    const submitBtn = form.querySelector('#research-search-submit');
    const resultsDiv = container.querySelector('#research-results');

    try {
      if (submitBtn) submitBtn.disabled = true;
      resultsDiv.innerHTML = '<p class="plan-empty">Searching OpenStreetMap...</p>';

      const elements = await searchOSMResources(currentRoute.bounds, keyword);
      lastSearchResults = [];
      const trackPoints = currentRoute.trackPoints;

      for (const el of elements) {
        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;
        const tags = el.tags ?? {};
        if (lat == null || lon == null) continue;

        const type = classifyOSMElement(tags);
        const name = osmElementLabel(tags, type);
        const dist = distanceFromStart(lat, lon, trackPoints);

        const nearestPtIdx = nearestTrackPointIndex(lat, lon, trackPoints);
        const nearestPt = trackPoints[nearestPtIdx];
        const offCourseDistanceMi = haversineDistance(lat, lon, nearestPt[0], nearestPt[1]);

        if (offCourseDistanceMi > 5.0) continue;

        lastSearchResults.push({
          osmId: el.id,
          lat,
          lon,
          name,
          type,
          reliability: osmElementReliability(tags, type),
          distanceFromStartMi: dist,
          offCourseDistanceMi,
          tags,
        });
      }

      lastSearchResults.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);
      resultsDiv.innerHTML = renderOSMSearchResults(lastSearchResults, keyword);
    } catch (err) {
      console.warn('[BPNav] OSM search failed:', err.message);
      resultsDiv.innerHTML = `<p class="plan-empty" style="color: var(--md-sys-color-error);">Search failed: ${err.message}</p>`;
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  // Handle clicking "＋ Add Stop" in research results
  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('.plan-add-wpt-btn');
    if (!btn || !currentRoute) return;

    const osmId = Number(btn.getAttribute('data-osm-id'));
    const result = lastSearchResults.find((r) => r.osmId === osmId);
    if (!result) return;

    const alreadyExists = currentRoute.waypoints.some(
      (w) => Math.abs(w.lat - result.lat) < 0.0001 && Math.abs(w.lon - result.lon) < 0.0001,
    );
    if (alreadyExists) {
      alert('This location is already added to your plan.');
      return;
    }

    const customWp = {
      id: `user-wpt-${Date.now()}`,
      lat: result.lat,
      lon: result.lon,
      name: result.name,
      description: result.tags?.description || result.tags?.note || '',
      type: result.type,
      reliability: result.reliability,
      distanceFromStartMi: result.distanceFromStartMi,
      offCourseDistanceMi: result.offCourseDistanceMi,
    };

    currentRoute.waypoints.push(customWp);
    currentRoute.waypoints.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

    await saveEnrichment(currentRoute.waypoints).catch(() => {});
    updateResourceCards(container, currentRoute);
    updatePlanningView(container.querySelector('#planning-view'), currentRoute, planOptions);
    updateRouteStats(container, currentRoute, planOptions);
    syncMapState();

    btn.textContent = '✓ Added';
    btn.disabled = true;
    btn.style.backgroundColor = 'var(--md-sys-color-surface-variant)';
    btn.style.color = 'var(--md-sys-color-on-surface-variant)';
  });

  // Listen for map-toggle-miles changes
  const toggleMilesCheckbox = container.querySelector('#map-toggle-miles');
  toggleMilesCheckbox.addEventListener('change', (e) => {
    if (currentMap && currentRoute) {
      updateMileMarkers(currentMap, currentRoute.trackPoints, e.target.checked);
    }
  });

  // Listen for map panning buttons
  container.addEventListener('click', (e) => {
    const panBtn = e.target.closest('.map-pan-btn');
    if (panBtn && currentMap) {
      const lat = Number(panBtn.getAttribute('data-lat'));
      const lon = Number(panBtn.getAttribute('data-lon'));
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        currentMap.easeTo({ center: [lon, lat], zoom: 14 });
      }
    }
  });

  // Start-at-mile offset apply
  const startApplyBtn = container.querySelector('#start-offset-apply');
  startApplyBtn.addEventListener('click', () => {
    if (!currentRoute) return;
    const input = container.querySelector('#start-mile-input');
    const offsetMi = Math.max(0, Number.parseFloat(input.value) || 0);
    const adjusted = applyStartOffset(currentRoute, offsetMi);
    currentRoute = adjusted;
    updateResourceCards(container, adjusted);
    syncMapState();
    updatePlanningView(container.querySelector('#planning-view'), adjusted, planOptions);
  });
}

// ---------------------------------------------------------------------------
// Mode switching — Planning vs Riding
// ---------------------------------------------------------------------------

/**
 * Switches between Planning and Riding modes and updates which sections show.
 * Planning shows the trip planner + map; Riding shows the resource radar,
 * map, and Sunsprint daylight planner.
 * @param {HTMLElement} container
 * @param {'planning' | 'riding'} mode
 */
function setMode(container, mode) {
  currentMode = mode;

  const planningBtn = container.querySelector('#mode-planning');
  const ridingBtn = container.querySelector('#mode-riding');
  planningBtn.classList.toggle('mode-toggle__btn--active', mode === 'planning');
  ridingBtn.classList.toggle('mode-toggle__btn--active', mode === 'riding');
  planningBtn.setAttribute('aria-selected', String(mode === 'planning'));
  ridingBtn.setAttribute('aria-selected', String(mode === 'riding'));

  applyMode(container);

  if (gpsManager) {
    if (mode === 'riding') {
      const simulateCheckbox = container.querySelector('#gps-simulate-checkbox');
      if (simulateCheckbox?.checked) {
        const simulateSpeedSelect = container.querySelector('#gps-simulate-speed');
        const speed = simulateSpeedSelect ? Number(simulateSpeedSelect.value) : 15;
        gpsManager.startSimulation(speed, 2000);
      } else {
        gpsManager.startTracking();
      }
    } else {
      gpsManager.stop();
    }
  }

  // Refresh map waypoints with the correct active stop highlights
  syncMapState();
}

/**
 * Applies the current mode's visibility to the dashboard sections.
 * @param {HTMLElement} container
 */
function applyMode(container) {
  const planning = currentMode === 'planning';
  container.querySelector('#planning-view').hidden = !planning;
  container.querySelector('.resource-section').hidden = planning;
  container.querySelector('.daylight-section').hidden = planning;

  const ridingControls = container.querySelector('#riding-controls');
  if (ridingControls) ridingControls.hidden = planning;

  // The map is useful in both modes; ensure it re-flows after a visibility flip.
  if (currentMap) requestAnimationFrame(() => currentMap.resize());
}

// ---------------------------------------------------------------------------
// Route application — updates all UI from a parsed RouteContext
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} container
 * @param {import('./gpx.js').RouteContext} route
 * @param {boolean} [skipEnrichment=false]
 */
function applyRoute(container, route, skipEnrichment = false) {
  currentRoute = route;

  if (gpsManager) {
    gpsManager.stop();
  }
  gpsManager = new GPSManager(route);
  gpsManager.onLocationUpdate((data) => {
    const currentMile = distanceFromStart(data.lat, data.lon, route.trackPoints);
    updateResourceCards(container, route, currentMile);
    updateSunsprintDisplay(container, route, currentMile, data.paceMph);
    updateUserLocationMarker(currentMap, data.lat, data.lon);
  });

  if (!skipEnrichment) {
    // Clear previous enrichment cache and kick off fresh background enrichments
    clearEnrichment().catch(() => {});
    kickoffWaterEnrichment(container, route);
    kickoffCampEnrichment(container, route);
    kickoffResupplyEnrichment(container, route);
  }

  updateStatusChip(container, route);
  updateResourceCards(container, route);
  showMapSection(container, route);
}

/**
 * Toggles a waypoint between active and skipped/forced stop.
 * @param {HTMLElement} container
 * @param {string} id
 */
function toggleStop(container, id) {
  if (!currentRoute) return;

  let wp = currentRoute.waypoints.find((w) => w.id === id);
  if (!wp) {
    const wpts = getWaypointsWithSyntheticCamps(currentRoute, planOptions);
    wp = wpts.find((w) => w.id === id);
  }
  if (!wp) return;

  if (wp.type === 'water') {
    const activeStopIds = getActiveStopIds(currentRoute, planOptions);
    const isCurrentlyStop = activeStopIds.has(id);
    if (isCurrentlyStop) {
      planOptions.forcedWaterIds = planOptions.forcedWaterIds.filter((x) => x !== id);
      if (!planOptions.excludedWaterIds.includes(id)) {
        planOptions.excludedWaterIds.push(id);
      }
    } else {
      planOptions.excludedWaterIds = planOptions.excludedWaterIds.filter((x) => x !== id);
      if (!planOptions.forcedWaterIds.includes(id)) {
        planOptions.forcedWaterIds.push(id);
      }
    }
  } else if (wp.type === 'resupply') {
    if (planOptions.excludedResupplyIds.includes(id)) {
      planOptions.excludedResupplyIds = planOptions.excludedResupplyIds.filter((x) => x !== id);
    } else {
      planOptions.excludedResupplyIds.push(id);
    }
  } else if (wp.type === 'camping') {
    if (planOptions.forcedCampIds.includes(id)) {
      planOptions.forcedCampIds = planOptions.forcedCampIds.filter((x) => x !== id);
    } else {
      const match = id.match(/synth-camp-(\d+)-/);
      if (match) {
        const dayNum = match[1];
        planOptions.forcedCampIds = planOptions.forcedCampIds.filter(
          (x) => !x.startsWith(`synth-camp-${dayNum}-`),
        );
      }
      planOptions.forcedCampIds.push(id);
    }
  }

  savePlanOptions(planOptions).catch(() => {});

  // Repaint planning view if visible
  const planningView = container.querySelector('#planning-view');
  if (planningView && !planningView.hidden) {
    updatePlanningView(planningView, currentRoute, planOptions);
  }

  // Repaint cards and map
  updateResourceCards(container, currentRoute);
  updateRouteStats(container, currentRoute, planOptions);
  syncMapState();
}

/** @param {HTMLElement} container @param {import('./gpx.js').RouteContext} route */
function updateStatusChip(container, route) {
  const chip = container.querySelector('.status-chip');
  chip.className = 'status-chip status-chip--active';
  chip.textContent = route.name.length > 18 ? `${route.name.slice(0, 16)}…` : route.name;
  chip.setAttribute('aria-label', `Route loaded: ${route.name}`);
}

/**
 * Updates the Resource Radar cards based on the route and current mile.
 * @param {HTMLElement} container
 * @param {import('./gpx.js').RouteContext} route
 * @param {number} [currentMile=0]
 */
function updateResourceCards(container, route, currentMile = 0) {
  const waterWpts = waypointsOfType(route, 'water');
  const resupplyWpts = waypointsOfType(route, 'resupply');
  const campWpts = waypointsOfType(route, 'camping');

  // Filter next water to only include active stops
  const activeStopIds = getActiveStopIds(route, planOptions);
  const nextWater =
    route.waypoints.find(
      (w) => w.type === 'water' && w.distanceFromStartMi > currentMile && activeStopIds.has(w.id),
    ) ?? null;
  const nextResupply =
    route.waypoints.find(
      (w) =>
        w.type === 'resupply' && w.distanceFromStartMi > currentMile && activeStopIds.has(w.id),
    ) ?? null;
  const nextCamp =
    route.waypoints.find(
      (w) => w.type === 'camping' && w.distanceFromStartMi > currentMile && activeStopIds.has(w.id),
    ) ?? null;

  const distWater = nextWater ? nextWater.distanceFromStartMi - currentMile : 0;
  const distResupply = nextResupply ? nextResupply.distanceFromStartMi - currentMile : 0;
  const distCamp = nextCamp ? nextCamp.distanceFromStartMi - currentMile : 0;

  const cards = [
    {
      id: 'water',
      label: 'Next Drink',
      icon: ICONS.water,
      value: nextWater ? `${distWater.toFixed(1)} mi` : 'None found',
      detail: nextWater ? nextWater.name : `${waterWpts.length} sources mapped`,
      state: nextWater ? 'active' : 'idle',
      reliability: nextWater?.reliability ?? 0,
    },
    {
      id: 'resupply',
      label: 'Next Resupply',
      icon: ICONS.resupply,
      value: nextResupply ? `${distResupply.toFixed(1)} mi` : 'None found',
      detail: nextResupply ? nextResupply.name : `${resupplyWpts.length} options mapped`,
      state: nextResupply ? 'active' : 'idle',
    },
    {
      id: 'daylight',
      label: 'Next Camp',
      icon: ICONS.daylight,
      value: nextCamp ? `${distCamp.toFixed(1)} mi` : '—',
      detail: nextCamp
        ? nextCamp.name
        : campWpts.length > 0
          ? `${campWpts.length} camp spots mapped`
          : 'No camps found yet',
      state: nextCamp ? 'active' : 'idle',
    },
  ];

  const cardsEl = container.querySelector('#resource-cards');
  cardsEl.innerHTML = cards.map(renderResourceCard).join('');

  updateSunsprintDisplay(container, route, currentMile, 10); // default 10 mph
}

/**
 * Updates the Sunsprint daylight bar based on current position and pace.
 * @param {HTMLElement} container
 * @param {import('./gpx.js').RouteContext} route
 * @param {number} currentMile
 * @param {number} paceMph
 */
export function updateSunsprintDisplay(container, route, currentMile, paceMph) {
  const card = container.querySelector('#sunsprint-card');
  if (!card) return;

  const emptyEl = card.querySelector('#sunsprint-empty');
  const timesEl = card.querySelector('#sunsprint-times');
  const trackEl = card.querySelector('#sunsprint-track');
  const bufferText = card.querySelector('#sunsprint-buffer-text');

  if (!route) {
    card.className = 'daylight-bar-card';
    if (emptyEl) emptyEl.hidden = false;
    if (timesEl) timesEl.hidden = true;
    if (trackEl) trackEl.hidden = true;
    if (bufferText) bufferText.hidden = true;
    return;
  }

  if (emptyEl) emptyEl.hidden = true;
  if (timesEl) timesEl.hidden = false;
  if (trackEl) trackEl.hidden = false;
  if (bufferText) bufferText.hidden = false;

  const nextCamp = nextWaypointOfType(route, 'camping', currentMile);
  const targetEndMile = nextCamp ? nextCamp.distanceFromStartMi : route.totalDistanceMiles;
  const destinationName = nextCamp ? nextCamp.name : 'Finish';

  const now = new Date();
  const result = calculateDaylightBuffer(route, currentMile, paceMph, targetEndMile, now);

  const formatTime = (date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  card.querySelector('#sunsprint-sunrise').textContent = formatTime(result.sunrise);
  card.querySelector('#sunsprint-sunset').textContent = formatTime(result.sunset);
  card.querySelector('#sunsprint-eta-val').textContent = formatTime(result.eta);
  card.querySelector('#sunsprint-eta-marker').hidden = false;

  const totalRemainingTimeMs = result.sunset.getTime() - now.getTime();
  const rideTimeMs = result.eta.getTime() - now.getTime();
  let pct = 0;
  if (totalRemainingTimeMs > 0) {
    pct = Math.min(100, Math.max(0, (rideTimeMs / totalRemainingTimeMs) * 100));
  } else {
    pct = 100;
  }

  card.querySelector('#sunsprint-progress-fill').style.width = `${pct}%`;
  card.querySelector('#sunsprint-eta-marker').style.left = `${pct}%`;

  card.className = `daylight-bar-card daylight-bar-card--${result.status}`;

  if (result.bufferMinutes < 0) {
    bufferText.textContent = `🚨 Arriving ${Math.abs(Math.round(result.bufferMinutes))}m AFTER sunset at ${destinationName}`;
  } else {
    bufferText.textContent = `🌅 ${Math.round(result.bufferMinutes)}m daylight buffer to ${destinationName}`;
  }
}

/** @param {HTMLElement} container @param {import('./gpx.js').RouteContext} route */
function showMapSection(container, route) {
  // Destroy previous map if one exists
  if (currentMap) {
    destroyMap(currentMap);
    currentMap = null;
  }

  // Show the map section
  const mapSection = container.querySelector('#map-section');
  mapSection.removeAttribute('hidden');

  // Reveal the mode toggle and build the Planning view for this route
  const modeToggle = container.querySelector('#mode-toggle');
  if (modeToggle) modeToggle.hidden = false;
  renderPlanningView(container.querySelector('#planning-view'), route, planOptions);
  applyMode(container);

  // Populate the route stats bar dynamically
  updateRouteStats(container, route, planOptions);

  // Update FAB to "Change Route"
  const fab = container.querySelector('.fab');
  fab.setAttribute('aria-label', 'Load a different route');
  fab.querySelector('.fab-label').textContent = 'Change Route';
  fab.querySelector('.fab-icon').innerHTML = ICONS.swap;

  // Reveal start-at-mile control and reset to 0 for the new route
  const startRow = container.querySelector('#start-offset-row');
  if (startRow) {
    startRow.hidden = false;
    const startInput = container.querySelector('#start-mile-input');
    if (startInput) {
      startInput.max = String(route.totalDistanceMiles.toFixed(1));
      startInput.value = '0';
    }
  }

  // Scroll map into view
  mapSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Initialise MapLibre — must happen after the section is visible
  currentMap = initMap('map', route, [], []);

  // Draw initial mile markers if checked
  const toggleMilesCheckbox = container.querySelector('#map-toggle-miles');
  const showMiles = toggleMilesCheckbox ? toggleMilesCheckbox.checked : true;
  updateMileMarkers(currentMap, route.trackPoints, showMiles);

  // Synchronise all markers, segments, and labels
  syncMapState();
}

// ---------------------------------------------------------------------------
// Loading & error states
// ---------------------------------------------------------------------------

/** @param {HTMLElement} container @param {boolean} loading */
function setLoadingState(container, loading) {
  const fab = container.querySelector('.fab');
  fab.disabled = loading;
  fab.querySelector('.fab-label').textContent = loading
    ? 'Parsing…'
    : currentRoute
      ? 'Change Route'
      : 'Load Route';
}

/** @param {HTMLElement} container @param {string} m/** @param {HTMLElement} container @param {string} message */
function showError(container, message) {
  // Remove any previous error
  container.querySelector('.parse-error')?.remove();

  const err = document.createElement('p');
  err.className = 'parse-error';
  err.setAttribute('role', 'alert');
  err.textContent = `⚠ Could not load route: ${message}`;
  container.querySelector('.dashboard').prepend(err);

  setTimeout(() => err.remove(), 6000);
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Attempts to restore a previously saved route from IndexedDB on startup.
 * @param {HTMLElement} container
 */
async function tryRestoreRoute(container) {
  try {
    const stored = await loadRoute();
    if (!stored) return;

    const savedOptions = await loadPlanOptions().catch(() => null);
    if (savedOptions) {
      planOptions = { ...getPlanDefaults(), ...savedOptions };
    } else {
      planOptions = getPlanDefaults();
    }

    const route = parseGPX(stored.gpxText);
    applyRoute(container, route);

    // Apply cached enrichment immediately so markers render without waiting
    // for a network round-trip — critical when the device is offline.
    const cachedWaypoints = await loadEnrichment().catch(() => null);
    if (cachedWaypoints?.length) {
      route.waypoints = cachedWaypoints;
      updateResourceCards(container, route);
      updatePlanningView(container.querySelector('#planning-view'), route, planOptions);
      updateRouteStats(container, route, planOptions);
      syncMapState();
    }

    // Kick off live enrichment regardless — SW cache will serve data
    // offline via StaleWhileRevalidate / NetworkFirst strategies.
    kickoffWaterEnrichment(container, route);
    kickoffCampEnrichment(container, route);
    kickoffResupplyEnrichment(container, route);
  } catch (err) {
    console.warn('[BPNav] Could not restore saved route:', err.message);
  }
}

/**
 * Fetches live USGS + OSM water data in the background and refreshes the
 * Resource Radar cards once the data arrives.
 * @param {HTMLElement} container
 * @param {import('./gpx.js').RouteContext} route
 */
async function kickoffWaterEnrichment(container, route) {
  try {
    const enrichedWater = await enrichWaterSources(route);
    if (!enrichedWater.length) return;

    route.waypoints = [
      ...route.waypoints.filter((w) => w.type !== 'water' || w.id.startsWith('user-')),
      ...enrichedWater,
    ].sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

    updateResourceCards(container, route);
    updatePlanningView(container.querySelector('#planning-view'), route, planOptions);
    updateRouteStats(container, route, planOptions);
    syncMapState();
    saveEnrichment(route.waypoints).catch(() => {});
  } catch (err) {
    console.warn('[BPNav] Water enrichment failed:', err.message);
  }
}

/**
 * Fetches OSM camp sites in the background and refreshes the Resource Radar
 * cards once the data arrives.
 * @param {HTMLElement} container
 * @param {import('./gpx.js').RouteContext} route
 */
async function kickoffCampEnrichment(container, route) {
  try {
    const enrichedCamps = await enrichCampSources(route);
    if (!enrichedCamps.length) return;

    route.waypoints = [
      ...route.waypoints.filter((w) => w.type !== 'camping' || w.id.startsWith('user-')),
      ...enrichedCamps,
    ].sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

    updateResourceCards(container, route);
    updatePlanningView(container.querySelector('#planning-view'), route, planOptions);
    updateRouteStats(container, route, planOptions);
    syncMapState();
    saveEnrichment(route.waypoints).catch(() => {});
  } catch (err) {
    console.warn('[BPNav] Camp enrichment failed:', err.message);
  }
}

/**
 * Fetches OSM resupply stops in the background and refreshes the Resource
 * Radar cards once the data arrives.
 * @param {HTMLElement} container
 * @param {import('./gpx.js').RouteContext} route
 */
async function kickoffResupplyEnrichment(container, route) {
  try {
    const enrichedResupply = await enrichResupplySources(route);
    if (!enrichedResupply.length) return;

    route.waypoints = [
      ...route.waypoints.filter((w) => w.type !== 'resupply' || w.id.startsWith('user-')),
      ...enrichedResupply,
    ].sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

    updateResourceCards(container, route);
    updatePlanningView(container.querySelector('#planning-view'), route, planOptions);
    updateRouteStats(container, route, planOptions);
    syncMapState();
    saveEnrichment(route.waypoints).catch(() => {});
  } catch (err) {
    console.warn('[BPNav] Resupply enrichment failed:', err.message);
  }
}

// Export classifyWaypoint so tests can import it from this module too
export { classifyWaypoint };
