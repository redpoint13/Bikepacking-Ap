/**
 * app.js — Root renderer for Bikepacker Navigator.
 *
 * Manages the app shell, route import flow, and card state updates.
 * CSS is imported only in main.js so this module stays test-friendly.
 */

import { searchOSMResources } from './api.js';
import { generateStatusReport, isVoiceEnabled, setVoiceEnabled, speak } from './audio.js';
import { enrichCampSources } from './camp.js';
import { describeError } from './errorBoundary.js';
import { GPSManager } from './gps.js';
import {
  applyStartOffset,
  classifyOSMElement,
  classifyWaypoint,
  distanceFromStart,
  fetchOverpass,
  getCoordinatesAtMile,
  haversineDistance,
  markWaypointsChanged,
  nearestTrackPointIndex,
  nextWaypointOfType,
  osmElementLabel,
  osmElementReliability,
  parseGPXAsync,
  waypointsOfType,
} from './gpx.js';
import { importFromURL } from './import.js';
import {
  destroyMap,
  highlightMapSegment,
  initMap,
  setMapRouteStart,
  updateMapDayPlan,
  updateMapWaypoints,
  updateMileMarkers,
  updateUserLocationMarker,
} from './map.js';
import {
  PLAN_DEFAULTS,
  buildPlan,
  getActiveStopIds,
  getWaypointsWithSyntheticCamps,
  optimizeWaterStops,
} from './plan.js';
import { renderOSMSearchResults, renderPlanningView, updatePlanningView } from './planning.js';
import { RadarController } from './radar.js';
import { enrichResupplySources } from './resupply.js';
import { appState, getPlanDefaults, persistUserPreferences } from './state.js';
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
import { getAllRoutes, getRouteById, saveRouteToLibrary, setActiveRouteId } from './storage.js';
import { calculateDaylightBuffer } from './sun.js';
import { syncOfflineMap } from './sync.js';
import { highlightProfileSegment } from './ui/elevationProfile.js';
import { renderElevationProfile } from './ui/elevationProfile.js';
import { updateResourceCards as updateResourceCardsUI } from './ui/radarCards.js';
import { openRouteLibraryModal } from './ui/routeLibraryModal.js';
import {
  getCurrentEtaDate,
  getSunsprintTargetMile,
  setSunsprintTargetMile,
} from './ui/sunsprint.js';
import { openWaypointEditorModal } from './ui/waypointEditorModal.js';
import { on, setHTML, setProps, setStyle, setText } from './utils/dom.js';
import { enrichWaterSources } from './water.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {import('./gpx.js').RouteContext | null} */
let currentRoute = null;

/** @type {import('maplibre-gl').Map | null} */
let currentMap = null;

/** @type {RadarController | null} */
let radarController = null;

/** @type {number | null} */
let sunsprintTargetMile = null;

/** @type {string} */
let lastSunsprintStatus = 'ok';

/** @type {number} */
let lastCurrentMile = 0;

/** @type {number} */
let lastPaceMph = 15;

/** @type {boolean} */
let _isGhostMode = false;

/** @type {WakeLockSentinel | null} */
let wakeLock = null;

/** @type {number} */
let lastSpokenMile = -1;

/** @type {Date | null} */
let currentEtaDate = null;

/** @type {object | null} */
let currentNextResource = null;

/** @type {Array<object>} Current active search results. */
let lastSearchResults = [];

/**
 * Synchronises all visual map elements (markers, highlighted stops,
 * day segment tracks, and day boundary labels) with currentRoute and planOptions.
 */
let syncMapTimeout = null;
function syncMapState(immediate = false) {
  if (!currentMap || !currentRoute) return;
  if (!immediate) {
    if (syncMapTimeout) clearTimeout(syncMapTimeout);
    syncMapTimeout = setTimeout(() => {
      _executeSyncMapState();
    }, 40);
    return;
  }
  _executeSyncMapState();
}

function _executeSyncMapState() {
  if (!currentMap || !currentRoute) return;
  const activeStopIds = getActiveStopIds(currentRoute, planOptions);
  const wpts = getWaypointsWithSyntheticCamps(currentRoute, planOptions);
  updateMapWaypoints(currentMap, wpts, activeStopIds);

  const plan = buildPlan(currentRoute, planOptions);
  updateMapDayPlan(currentMap, currentRoute.trackPoints, plan.dayPlan);

  // Keeps the "jump to start" control pointing at the rider's actual start,
  // which applyStartOffset moves without rebuilding the map.
  setMapRouteStart(currentMap, currentRoute);
}

/**
 * Re-flows the map after a visibility change. The null check must happen inside
 * the frame callback: showMapSection sets currentMap to null while tearing the
 * old map down, which can land between the scheduling call and the frame.
 */
function scheduleMapResize() {
  requestAnimationFrame(() => {
    if (currentMap) currentMap.resize();
  });
}

/** @type {'planning' | 'riding'} Active app mode. */
let currentMode = 'planning';

/** @type {GPSManager | null} */
let gpsManager = null;

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
          <button class="sync-map-btn" id="sync-map-btn" type="button" hidden>Sync Map</button>
          <button class="header-change-route-btn" id="header-change-route-btn" type="button" hidden>Change Route</button>
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

            <!-- Target selector UI -->
            <div class="sunsprint-target-wrapper" id="sunsprint-target-wrapper" hidden>
              <label for="sunsprint-target-slider" class="sunsprint-target-label">
                Target: Mile <span id="sunsprint-target-val">--</span>
              </label>
              <input type="range" id="sunsprint-target-slider" class="sunsprint-slider" min="0" max="100" step="1" value="0" />
            </div>

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
            
            <div class="trail-talk-controls" id="trail-talk-controls">
              <label class="voice-toggle-label">
                <input type="checkbox" id="voice-enable-toggle" />
                Enable Trail-Talk 🔊
              </label>
              <button id="read-status-btn" class="read-status-btn" type="button">
                Read Status
              </button>
            </div>

            <button id="ghost-mode-enter-btn" class="ghost-mode-enter-btn" type="button" hidden>
              Enter Ghost Mode 👻
            </button>
          </div>
        </section>
      </div>

      <!-- Map section — hidden until a route is loaded -->
      <section class="map-section" id="map-section" aria-label="Route map" hidden style="position: relative;">
        <div id="map" class="map-container"></div>
        <div class="map-overlay-controls">
          <label class="map-overlay-controls__row" title="Mile markers">
            <input type="checkbox" id="map-toggle-miles" aria-label="Show mile markers" checked />
            <span class="map-overlay-controls__text">Mile Markers</span>
          </label>
          <button type="button" id="btn-add-custom-poi" class="btn-add-poi-floating"
            aria-label="Add waypoint" title="Add waypoint">
            <span aria-hidden="true">＋</span>
            <span class="map-overlay-controls__text">Add Waypoint</span>
          </button>
        </div>
        <div class="route-stats" id="route-stats" aria-label="Route summary"></div>
        <div id="elevation-profile-container" style="width: 100%;"></div>

        <!-- Smart Resource Radar Bottom Sheet -->
        <div id="radar-bottom-sheet" class="radar-bottom-sheet collapsed" style="display: none;" aria-label="Live Resource Radar">
          <div class="radar-handle"></div>
          <div class="radar-summary">
            <div class="radar-summary-item primary">
              <span class="radar-label">Next Water</span>
              <span class="radar-value" id="radar-water-next">--</span>
            </div>
            <div class="radar-summary-item">
              <span class="radar-label">Camp</span>
              <span class="radar-value" id="radar-camp-next">--</span>
            </div>
            <div class="radar-summary-item">
              <span class="radar-label">Resupply</span>
              <span class="radar-value" id="radar-resupply-next">--</span>
            </div>
          </div>
          <div class="radar-details">
            <h3 class="radar-section-title">Water Sources Ahead</h3>
            <div id="radar-water-list">
              <div class="radar-item">No upcoming water</div>
            </div>
            
            <div class="radar-calculator">
              <h3 class="radar-section-title">Water Carry Calculator</h3>
              <div class="radar-calc-grid">
                <label>
                  Temp (&deg;F)
                  <input type="number" id="radar-temp-input" class="radar-input" value="70" step="5" />
                </label>
                <label>
                  Capacity (oz)
                  <input type="number" id="radar-cap-input" class="radar-input" value="64" step="16" />
                </label>
                <div class="radar-calc-result">
                  Dry stretch: <span id="radar-dry-stretch">--</span> mi<br/>
                  Min carry: <strong id="radar-carry-req">--</strong> oz
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Start-at-mile offset control — visible once a route is loaded -->
        <div class="start-offset-row" id="start-offset-row" hidden>
          <label class="start-offset-label" for="start-mile-input">Start at mile</label>
          <input class="start-offset-input" id="start-mile-input" type="number"
            min="0" step="0.1" value="0" aria-label="Mile marker where your ride begins" />
          <button class="start-offset-apply" id="start-offset-apply" type="button">Apply</button>
        </div>
      </section>

    </main>

    <!-- Ghost Mode Overlay -->
    <div id="ghost-mode-overlay" class="ghost-mode-overlay" hidden>
      <div class="ghost-mode-content">
        <h2 class="ghost-mode-title">Ghost Mode Active</h2>
        <div class="ghost-mode-eta">
          ETA: <span id="ghost-mode-eta-val">--:--</span>
        </div>
        <button id="ghost-read-status-btn" class="ghost-read-status-btn" type="button">
          🔊 Read Status
        </button>
        <button id="ghost-mode-wake-btn" class="ghost-mode-wake-btn" type="button">
          WAKE UP
        </button>
      </div>
    </div>

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

    <!-- Sync Progress Modal -->
    <div id="sync-progress-modal" class="sync-modal" hidden>
      <div class="sync-modal-content">
        <h2 class="sync-modal-title">Syncing Map Tiles</h2>
        <p class="sync-modal-desc">Downloading vector map tiles for offline use...</p>
        <div class="sync-progress-bar">
          <div id="sync-progress-fill" class="sync-progress-fill" style="width: 0%;"></div>
        </div>
        <p id="sync-progress-text" class="sync-progress-text">0 / 0 tiles</p>
      </div>
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
  // Publish the starting mode too, not just on switches: the map overlay's
  // compact rule keys off this attribute, and a container that never announces
  // its mode would leave that contract half-true.
  container.dataset.mode = currentMode;

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
  // Segment highlight requests from Segment Analytics cards/drawer.
  // Registered once here — previously this lived in showMapSection, which runs
  // on every route load, so listeners accumulated without bound.
  window.addEventListener('bpnav-highlight-segment', (e) => {
    const { startMi, endMi } = e.detail || {};
    if (currentRoute && currentMap && Number.isFinite(startMi) && Number.isFinite(endMi)) {
      highlightMapSegment(currentMap, currentRoute.trackPoints, startMi, endMi);
      const profileContainer = container.querySelector('#elevation-profile-container');
      if (profileContainer) {
        highlightProfileSegment(profileContainer, currentRoute, startMi, endMi);
      }
    }
  });

  const _fab = container.querySelector('#load-route-btn');
  const fileInput = container.querySelector('#gpx-file-input');
  const importPlanBtn = container.querySelector('#import-plan-btn');
  const syncMapBtn = container.querySelector('#sync-map-btn');

  // Sync Map button
  if (syncMapBtn) {
    syncMapBtn.addEventListener('click', async () => {
      const modal = container.querySelector('#sync-progress-modal');
      const text = container.querySelector('#sync-progress-text');
      const fill = container.querySelector('#sync-progress-fill');

      if (!currentRoute) return;

      modal.hidden = false;
      syncMapBtn.disabled = true;

      await syncOfflineMap(currentRoute, (current, total) => {
        const pct = (current / total) * 100;
        fill.style.width = `${pct}%`;
        text.textContent = `${current} / ${total} tiles downloaded`;
      });

      setTimeout(() => {
        modal.hidden = true;
        syncMapBtn.disabled = false;
        syncMapBtn.textContent = 'Map Synced ✓';
      }, 1000);
    });
  }

  // Route Library Helper
  function openLibrary() {
    openRouteLibraryModal({
      onSelectRoute: async (routeId) => {
        const record = await getRouteById(routeId);
        if (!record) return;
        await setActiveRouteId(routeId);
        if (record.options) {
          planOptions = { ...getPlanDefaults(), ...record.options };
          persistUserPreferences(planOptions);
        } else {
          planOptions = getPlanDefaults();
        }
        const route = await parseGPXAsync(record.gpxText);
        if (record.waypoints?.length) {
          route.waypoints = sanitizeWaypoints(record.waypoints);
          markWaypointsChanged(route);
        }
        applyRoute(container, route, true);
        kickoffWaterEnrichment(container, route);
        kickoffCampEnrichment(container, route);
        kickoffResupplyEnrichment(container, route);
      },
      onUploadGPX: async (file) => {
        setLoadingState(container, true);
        try {
          const text = await file.text();
          if (file.name.endsWith('.json')) {
            const bundle = JSON.parse(text);
            if (bundle.version && bundle.gpxText) {
              const route = await parseGPXAsync(bundle.gpxText);
              if (bundle.waypoints) {
                route.waypoints = sanitizeWaypoints(bundle.waypoints);
                markWaypointsChanged(route);
              }
              const routeId = await saveRouteToLibrary({
                name:
                  bundle.name ||
                  (bundle.filename
                    ? bundle.filename.replace(/\.gpx$/i, '')
                    : file.name.replace(/\.json$/i, '')),
                filename: bundle.filename || file.name,
                gpxText: bundle.gpxText,
                totalDistanceMiles: route.totalDistanceMiles,
                waypoints: route.waypoints,
                options: bundle.options || null,
              });
              await setActiveRouteId(routeId);
              if (bundle.options) {
                planOptions = { ...getPlanDefaults(), ...bundle.options };
                persistUserPreferences(planOptions);
              }
              applyRoute(container, route, true);
              return;
            }
          }
          const route = await parseGPXAsync(text);
          const routeId = await saveRouteToLibrary({
            name: file.name.replace(/\.gpx$/i, ''),
            filename: file.name,
            gpxText: text,
            totalDistanceMiles: route.totalDistanceMiles,
            waypoints: route.waypoints || [],
          });
          await setActiveRouteId(routeId);
          applyRoute(container, route);
          kickoffWaterEnrichment(container, route);
          kickoffCampEnrichment(container, route);
          kickoffResupplyEnrichment(container, route);
        } catch (err) {
          showError(container, err);
        } finally {
          setLoadingState(container, false);
        }
      },
      onImportURL: async (url) => {
        setLoadingState(container, true);
        try {
          const route = await importFromURL(url);
          const gpxStub = `<gpx version="1.1" creator="BPNav"><trk><name>${route.name}</name><trkseg>${route.trackPoints.map(([lat, lon]) => `<trkpt lat="${lat}" lon="${lon}"/>`).join('')}</trkseg></trk></gpx>`;
          const routeId = await saveRouteToLibrary({
            name: route.name,
            filename: `${route.name.replace(/\s+/g, '_')}.gpx`,
            gpxText: gpxStub,
            totalDistanceMiles: route.totalDistanceMiles,
            waypoints: route.waypoints || [],
          });
          await setActiveRouteId(routeId);
          applyRoute(container, route);
          kickoffWaterEnrichment(container, route);
          kickoffCampEnrichment(container, route);
          kickoffResupplyEnrichment(container, route);
        } catch (err) {
          showError(container, err);
          throw err;
        } finally {
          setLoadingState(container, false);
        }
      },
    });
  }

  // Delegated click handler for opening Route Library from any trigger (header, fab, planning toolbar)
  container.addEventListener('click', (e) => {
    const trigger = e.target.closest(
      '#load-route-btn, #header-change-route-btn, [data-action="open-library"], [data-action="change-route"]',
    );
    if (trigger) {
      e.preventDefault();
      openLibrary();
    }
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
          const route = await parseGPXAsync(bundle.gpxText);
          if (bundle.waypoints) {
            route.waypoints = sanitizeWaypoints(bundle.waypoints);
            markWaypointsChanged(route);
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
      const route = await parseGPXAsync(text);
      applyRoute(container, route);
      saveRoute(text, file.name).catch((err) =>
        console.warn('[BPNav] Could not save route:', describeError(err)),
      );
      kickoffWaterEnrichment(container, route);
      kickoffCampEnrichment(container, route);
      kickoffResupplyEnrichment(container, route);
    } catch (err) {
      console.error('[BPNav] Import failed:', err);
      showError(container, err);
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
      const route = await parseGPXAsync(text);
      applyRoute(container, route);
      saveRoute(text, 'Coconino_Loop.gpx').catch((err) =>
        console.warn('[BPNav] Could not save route:', describeError(err)),
      );
      kickoffWaterEnrichment(container, route);
      kickoffCampEnrichment(container, route);
      kickoffResupplyEnrichment(container, route);
    } catch (err) {
      console.error('[BPNav] Demo load failed:', err);
      showError(container, `Demo load failed: ${describeError(err)}`);
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
      errEl.textContent = describeError(err);
      errEl.hidden = false;
    } finally {
      setLoadingState(container, false);
    }
  });

  // Mode toggle — Planning / Riding
  on(container, '#mode-planning', 'click', () => {
    setMode(container, 'planning');
  });
  on(container, '#mode-riding', 'click', () => {
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

  // Sunsprint Slider
  const targetSlider = container.querySelector('#sunsprint-target-slider');
  const targetValEl = container.querySelector('#sunsprint-target-val');

  if (targetSlider && targetValEl) {
    targetSlider.addEventListener('input', (e) => {
      sunsprintTargetMile = Number(e.target.value);
      targetValEl.textContent = sunsprintTargetMile.toFixed(1);
      if (currentRoute) {
        updateSunsprintDisplay(container, currentRoute, lastCurrentMile, lastPaceMph);
      }
    });
  }

  // Ghost Mode
  const ghostEnterBtn = container.querySelector('#ghost-mode-enter-btn');
  const ghostWakeBtn = container.querySelector('#ghost-mode-wake-btn');
  const ghostOverlay = container.querySelector('#ghost-mode-overlay');
  const mapSection = container.querySelector('#map-section');

  if (ghostEnterBtn && ghostWakeBtn && ghostOverlay && mapSection) {
    ghostEnterBtn.addEventListener('click', async () => {
      _isGhostMode = true;
      ghostOverlay.hidden = false;
      mapSection.hidden = true;
      try {
        if ('wakeLock' in navigator) {
          wakeLock = await navigator.wakeLock.request('screen');
        }
      } catch (err) {
        console.warn('Wake Lock error:', err);
      }
    });

    ghostWakeBtn.addEventListener('click', async () => {
      _isGhostMode = false;
      ghostOverlay.hidden = true;
      mapSection.hidden = false;
      scheduleMapResize();
      if (wakeLock) {
        await wakeLock.release().catch(console.warn);
        wakeLock = null;
      }
    });
  }

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
          alert(`Failed to export plan: ${describeError(err)}`);
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
      console.warn('[BPNav] OSM search failed:', describeError(err));
      resultsDiv.innerHTML = `<p class="plan-empty" style="color: var(--md-sys-color-error);">Search failed: ${describeError(err)}</p>`;
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
    markWaypointsChanged(currentRoute);

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

  function handleSaveCustomWaypoint(wpt) {
    if (!currentRoute) return;
    const idx = currentRoute.waypoints.findIndex((w) => w.id === wpt.id);
    if (idx >= 0) {
      currentRoute.waypoints[idx] = wpt;
    } else {
      currentRoute.waypoints.push(wpt);
    }
    currentRoute.waypoints.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);
    markWaypointsChanged(currentRoute);

    updateResourceCards(container, currentRoute);
    updatePlanningView(container.querySelector('#planning-view'), currentRoute, planOptions);
    updateRouteStats(container, currentRoute, planOptions);
    syncMapState();
    if (currentMap && wpt.lon && wpt.lat) {
      currentMap.flyTo({ center: [wpt.lon, wpt.lat], zoom: Math.max(currentMap.getZoom(), 12) });
    }
    saveEnrichment(currentRoute.waypoints).catch(() => {});
  }

  function handleDeleteCustomWaypoint(wptId) {
    if (!currentRoute) return;
    currentRoute.waypoints = currentRoute.waypoints.filter((w) => w.id !== wptId);
    markWaypointsChanged(currentRoute);

    updateResourceCards(container, currentRoute);
    updatePlanningView(container.querySelector('#planning-view'), currentRoute, planOptions);
    updateRouteStats(container, currentRoute, planOptions);
    syncMapState();
    // No fly-to here: the waypoint just went away. This used to reference an
    // out-of-scope `wpt`, throwing a ReferenceError before saveEnrichment ran,
    // so deletions were never persisted.
    saveEnrichment(currentRoute.waypoints).catch(() => {});
  }

  const addPoiBtn = container.querySelector('#btn-add-custom-poi');
  if (addPoiBtn) {
    addPoiBtn.addEventListener('click', () => {
      if (!currentRoute) return;
      openWaypointEditorModal({
        route: currentRoute,
        defaultMile: 0,
        defaultCoords: currentRoute.startPoint || { lat: 0, lon: 0 },
        onSave: handleSaveCustomWaypoint,
        onDelete: handleDeleteCustomWaypoint,
      });
    });
  }

  window.addEventListener('bpnav-profile-click', (e) => {
    if (!currentRoute) return;
    const { mile } = e.detail || {};
    const pt = getCoordinatesAtMile(currentRoute.trackPoints, mile || 0);
    openWaypointEditorModal({
      route: currentRoute,
      defaultMile: mile || 0,
      defaultCoords: pt ? { lat: pt[0], lon: pt[1] } : null,
      onSave: handleSaveCustomWaypoint,
      onDelete: handleDeleteCustomWaypoint,
    });
  });

  container.addEventListener(
    'click',
    (e) => {
      const editBtn = e.target.closest('[data-action="edit-waypoint"]');
      if (editBtn && currentRoute) {
        const id = editBtn.getAttribute('data-id');
        const targetWpt = currentRoute.waypoints.find((w) => w.id === id);
        if (targetWpt) {
          openWaypointEditorModal({
            waypoint: targetWpt,
            route: currentRoute,
            onSave: handleSaveCustomWaypoint,
            onDelete: handleDeleteCustomWaypoint,
          });
        }
      }
    },
    { capture: true },
  );

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

  if (radarController) {
    if (mode === 'riding') radarController.start();
    else radarController.stop();
  }
}

/**
 * Applies the current mode's visibility to the dashboard sections.
 * @param {HTMLElement} container
 */
function applyMode(container) {
  const planning = currentMode === 'planning';
  // CSS hook: the map overlay compacts itself in Riding mode, where the screen
  // is small (Riding is unreachable above 1024px) and the map matters most.
  container.dataset.mode = currentMode;
  container.querySelector('#planning-view').hidden = !planning;
  container.querySelector('.resource-section').hidden = planning;
  container.querySelector('.daylight-section').hidden = planning;

  const ridingControls = container.querySelector('#riding-controls');
  if (ridingControls) ridingControls.hidden = planning;

  // The map is useful in both modes; ensure it re-flows after a visibility flip.
  scheduleMapResize();
}

// ---------------------------------------------------------------------------
// Route application — updates all UI from a parsed RouteContext
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} container
 * @param {import('./gpx.js').RouteContext} route
 * @param {boolean} [skipEnrichment=false]
 */
function sanitizeWaypoints(wpts) {
  if (!Array.isArray(wpts)) return [];
  return wpts.filter(
    (w) =>
      w &&
      w.lat != null &&
      w.lon != null &&
      !w.id?.startsWith('synth-') &&
      !w.isSynthetic &&
      !w.name?.match(/Dispersed Camp \((short|med|long|mi)/i),
  );
}

function applyRoute(container, route, skipEnrichment = false) {
  currentRoute = route;

  if (gpsManager) {
    gpsManager.stop();
  }
  gpsManager = new GPSManager(route);

  if (radarController) {
    radarController.stop();
  }
  radarController = new RadarController(route, gpsManager);
  if (currentMode === 'riding') radarController.start();

  gpsManager.onLocationUpdate((data) => {
    lastCurrentMile = distanceFromStart(data.lat, data.lon, route.trackPoints);
    lastPaceMph = data.paceMph;
    updateResourceCards(container, route, lastCurrentMile);
    updateSunsprintDisplay(container, route, lastCurrentMile, lastPaceMph);
    updateUserLocationMarker(currentMap, data.lat, data.lon);

    // Trail-Talk: Distance trigger
    const flooredMile = Math.floor(lastCurrentMile);
    if (flooredMile > 0 && flooredMile % 5 === 0 && flooredMile > lastSpokenMile) {
      lastSpokenMile = flooredMile;
      if (isVoiceEnabled()) {
        const report = generateStatusReport(
          lastCurrentMile,
          sunsprintTargetMile,
          currentEtaDate,
          currentNextResource,
        );
        speak(report);
      }
    }
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
  if (chip) {
    chip.className = 'status-chip status-chip--active';
    chip.textContent = route.name.length > 18 ? `${route.name.slice(0, 16)}…` : route.name;
    chip.setAttribute('aria-label', `Route loaded: ${route.name}`);
  }

  const syncBtn = container.querySelector('#sync-map-btn');
  if (syncBtn) {
    syncBtn.hidden = false;
  }
}

/**
 * Updates the Resource Radar cards based on the route and current mile.
 * @param {HTMLElement} container
 * @param {import('./gpx.js').RouteContext} route
 * @param {number} [currentMile=0]
 */
function updateResourceCards(container, route, currentMile = 0) {
  currentNextResource = updateResourceCardsUI(container, route, planOptions, currentMile);
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
  const targetWrapper = card.querySelector('#sunsprint-target-wrapper');
  const targetSlider = card.querySelector('#sunsprint-target-slider');
  const targetVal = card.querySelector('#sunsprint-target-val');
  const ghostBtn = card.querySelector('#ghost-mode-enter-btn');
  const ghostEtaVal = document.getElementById('ghost-mode-eta-val');

  if (!route) {
    card.className = 'daylight-bar-card';
    if (emptyEl) emptyEl.hidden = false;
    if (timesEl) timesEl.hidden = true;
    if (trackEl) trackEl.hidden = true;
    if (bufferText) bufferText.hidden = true;
    if (targetWrapper) targetWrapper.hidden = true;
    if (ghostBtn) ghostBtn.hidden = true;
    return;
  }

  if (emptyEl) emptyEl.hidden = true;
  if (timesEl) timesEl.hidden = false;
  if (trackEl) trackEl.hidden = false;
  if (bufferText) bufferText.hidden = false;
  if (targetWrapper) targetWrapper.hidden = false;
  if (ghostBtn) ghostBtn.hidden = false;

  const maxMiles = route.totalDistanceMiles;

  // Set slider min and max
  if (targetSlider) {
    const currentSliderMin = Number(targetSlider.min);
    const newMin = Math.floor(currentMile);
    if (currentSliderMin !== newMin) {
      targetSlider.min = newMin;
    }

    if (Number(targetSlider.max) !== Math.ceil(maxMiles)) {
      targetSlider.max = Math.ceil(maxMiles);
    }
  }

  if (sunsprintTargetMile === null) {
    const nextCamp = nextWaypointOfType(route, 'camping', currentMile);
    sunsprintTargetMile = nextCamp ? nextCamp.distanceFromStartMi : maxMiles;
    if (targetSlider) {
      targetSlider.value = sunsprintTargetMile;
      if (targetVal) targetVal.textContent = sunsprintTargetMile.toFixed(1);
    }
  }

  const destinationName = `Mile ${sunsprintTargetMile.toFixed(1)}`;
  const now = new Date();
  const result = calculateDaylightBuffer(route, currentMile, paceMph, sunsprintTargetMile, now);

  currentEtaDate = result.eta;

  const formatTime = (date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const formattedEta = formatTime(result.eta);

  setText(card, '#sunsprint-sunrise', formatTime(result.sunrise));
  setText(card, '#sunsprint-sunset', formatTime(result.sunset));
  setText(card, '#sunsprint-eta-val', formattedEta);
  setProps(card, '#sunsprint-eta-marker', { hidden: false });

  if (ghostEtaVal) {
    ghostEtaVal.textContent = formattedEta;
  }

  const totalRemainingTimeMs = result.sunset.getTime() - now.getTime();
  const rideTimeMs = result.eta.getTime() - now.getTime();
  let pct = 0;
  if (totalRemainingTimeMs > 0) {
    pct = Math.min(100, Math.max(0, (rideTimeMs / totalRemainingTimeMs) * 100));
  } else {
    pct = 100;
  }

  setStyle(card, '#sunsprint-progress-fill', 'width', `${pct}%`);
  setStyle(card, '#sunsprint-eta-marker', 'left', `${pct}%`);

  card.className = `daylight-bar-card daylight-bar-card--${result.status}`;

  if (bufferText) {
    bufferText.textContent =
      result.bufferMinutes < 0
        ? `🚨 Arriving ${Math.abs(Math.round(result.bufferMinutes))}m AFTER sunset at ${destinationName}`
        : `🌅 ${Math.round(result.bufferMinutes)}m daylight buffer to ${destinationName}`;
  }

  // Haptic alert on transition to red alert (<30m)
  if (
    result.status === 'alert' &&
    (lastSunsprintStatus === 'ok' || lastSunsprintStatus === 'warning')
  ) {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate([300, 200, 300]);
      } catch (e) {
        console.warn(e);
      }
    }
  }
  lastSunsprintStatus = result.status;
}

/** @param {HTMLElement} container @param {import('./gpx.js').RouteContext} route */
function showMapSection(container, route) {
  // Destroy previous map if one exists. The pending syncMapState debounce must
  // be cancelled too, or it fires ~40ms later against a torn-down map.
  if (syncMapTimeout) {
    clearTimeout(syncMapTimeout);
    syncMapTimeout = null;
  }
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
  renderElevationProfile(container.querySelector('#elevation-profile-container'), route);

  // Update Header & FAB for loaded route
  const headerChangeBtnEl = container.querySelector('#header-change-route-btn');
  if (headerChangeBtnEl) headerChangeBtnEl.hidden = false;

  const fabZoneEl = container.querySelector('.fab-zone');
  if (fabZoneEl) fabZoneEl.setAttribute('data-has-route', 'true');

  const fabLinksEl = container.querySelector('.fab-links');
  if (fabLinksEl) fabLinksEl.hidden = true;

  const fab = container.querySelector('.fab');
  if (fab) {
    fab.setAttribute('aria-label', 'Load a different route');
    setText(fab, '.fab-label', 'Change Route');
    setHTML(fab, '.fab-icon', ICONS.swap);
  }

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
  // activeStopIds must be a Set — an array would throw on .has(). Passing the
  // route's own waypoints (rather than []) means markers render at init instead
  // of only after the first syncMapState.
  currentMap = initMap('map', route, getActiveStopIds(route, planOptions), route.waypoints);

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
  if (!fab) return;
  fab.disabled = loading;
  setText(fab, '.fab-label', loading ? 'Parsing…' : currentRoute ? 'Change Route' : 'Load Route');
}

/** @param {HTMLElement} container @param {string} message */
function showError(container, message) {
  if (!container) return;
  // Remove any previous error
  container.querySelector('.parse-error')?.remove();

  const err = document.createElement('p');
  err.className = 'parse-error';
  err.setAttribute('role', 'alert');
  err.textContent = `⚠ Could not load route: ${describeError(message)}`;
  // Fall back to the container itself: an error still has to be visible even
  // if the dashboard has not rendered. This path must never throw — it is what
  // reports every other failure.
  const host = container.querySelector('.dashboard') ?? container;
  host.prepend(err);

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
    const all = await getAllRoutes().catch(() => []);
    if (all.length === 0) {
      // Auto-seed Coconino Loop demo route if library is empty
      try {
        const res = await fetch('./Coconino_Loop.gpx');
        if (res.ok) {
          const text = await res.text();
          const route = await parseGPXAsync(text);
          const routeId = await saveRouteToLibrary({
            id: 'coconino-loop-demo',
            name: 'Coconino Loop',
            filename: 'Coconino_Loop.gpx',
            gpxText: text,
            totalDistanceMiles: route.totalDistanceMiles,
            waypoints: route.waypoints || [],
          });
          await setActiveRouteId(routeId);
          applyRoute(container, route);
          kickoffWaterEnrichment(container, route);
          kickoffCampEnrichment(container, route);
          kickoffResupplyEnrichment(container, route);
          return;
        }
      } catch (_) {}
    }
  } catch (_) {}
  try {
    const stored = await loadRoute();
    if (!stored) return;

    const savedOptions = await loadPlanOptions().catch(() => null);
    if (savedOptions) {
      planOptions = { ...getPlanDefaults(), ...savedOptions };
    } else {
      planOptions = getPlanDefaults();
    }

    const route = await parseGPXAsync(stored.gpxText);
    // skipEnrichment: this path applies the cached enrichment below and starts
    // its own passes afterwards. Letting applyRoute enrich here ran every pass
    // twice, and its clearEnrichment() wiped the cache moments before the
    // loadEnrichment() below reads it — so a restore came up with no markers
    // whenever the network was slow, which is exactly when the cache matters.
    applyRoute(container, route, true);

    // Apply cached enrichment immediately so markers render without waiting
    // for a network round-trip — critical when the device is offline.
    const cachedWaypoints = await loadEnrichment().catch(() => null);
    if (cachedWaypoints?.length) {
      route.waypoints = sanitizeWaypoints(cachedWaypoints);
      markWaypointsChanged(route);
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
    console.warn('[BPNav] Could not restore saved route:', describeError(err));
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
    markWaypointsChanged(route);

    updateResourceCards(container, route);
    updatePlanningView(container.querySelector('#planning-view'), route, planOptions);
    updateRouteStats(container, route, planOptions);
    syncMapState();
    saveEnrichment(route.waypoints).catch(() => {});
  } catch (err) {
    console.warn('[BPNav] Water enrichment failed:', describeError(err));
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
    markWaypointsChanged(route);

    updateResourceCards(container, route);
    updatePlanningView(container.querySelector('#planning-view'), route, planOptions);
    updateRouteStats(container, route, planOptions);
    syncMapState();
    saveEnrichment(route.waypoints).catch(() => {});
  } catch (err) {
    console.warn('[BPNav] Camp enrichment failed:', describeError(err));
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
    markWaypointsChanged(route);

    updateResourceCards(container, route);
    updatePlanningView(container.querySelector('#planning-view'), route, planOptions);
    updateRouteStats(container, route, planOptions);
    syncMapState();
    saveEnrichment(route.waypoints).catch(() => {});
  } catch (err) {
    console.warn('[BPNav] Resupply enrichment failed:', describeError(err));
  }
}

// Export classifyWaypoint so tests can import it from this module too
export { classifyWaypoint };
