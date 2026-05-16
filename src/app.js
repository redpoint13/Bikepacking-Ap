/**
 * app.js — Root renderer for Bikepacker Navigator.
 *
 * Manages the app shell, route import flow, and card state updates.
 * CSS is imported only in main.js so this module stays test-friendly.
 */

import { enrichCampSources } from './camp.js';
import {
  applyStartOffset,
  classifyWaypoint,
  nextWaypointOfType,
  parseGPX,
  waypointsOfType,
} from './gpx.js';
import { importFromURL } from './import.js';
import { destroyMap, initMap, updateMapWaypoints } from './map.js';
import { enrichResupplySources } from './resupply.js';
import { loadEnrichment, loadRoute, saveEnrichment, saveRoute } from './storage.js';
import { enrichWaterSources } from './water.js';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {import('./gpx.js').RouteContext | null} */
let currentRoute = null;

/** @type {import('maplibre-gl').Map | null} */
let currentMap = null;

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

      <!-- Map section — hidden until a route is loaded -->
      <section class="map-section" id="map-section" aria-label="Route map" hidden>
        <div id="map" class="map-container"></div>
        <div class="route-stats" id="route-stats" aria-label="Route summary"></div>

        <!-- Start-at-mile offset control — visible once a route is loaded -->
        <div class="start-offset-row" id="start-offset-row" hidden>
          <label class="start-offset-label" for="start-mile-input">Start at mile</label>
          <input class="start-offset-input" id="start-mile-input" type="number"
            min="0" step="0.1" value="0" aria-label="Mile marker where your ride begins" />
          <button class="start-offset-apply" id="start-offset-apply" type="button">Apply</button>
        </div>
      </section>

      <!-- Resource Radar cards -->
      <section class="resource-section" aria-label="Resource Radar">
        <h2 class="section-heading">Resource Radar</h2>
        <div class="resource-cards" id="resource-cards" role="list">
          ${IDLE_CARDS.map(renderResourceCard).join('')}
        </div>
      </section>

      <!-- Sunsprint / daylight planner -->
      <section class="daylight-section" aria-label="Daylight planner">
        <h2 class="section-heading">Sunsprint</h2>
        <div class="daylight-bar-card">
          <div class="daylight-bar" aria-label="Daylight window — no data" role="img">
            <div class="daylight-bar__track">
              <span class="daylight-bar__label daylight-bar__label--left">Sunrise</span>
              <span class="daylight-bar__label daylight-bar__label--right">Sunset</span>
            </div>
            <p class="daylight-bar__empty">Load a route to see your daylight buffer</p>
          </div>
        </div>
      </section>

    </main>

    <!-- Hidden file input — triggered by the FAB -->
    <input type="file" id="gpx-file-input" accept=".gpx,.kml" hidden aria-hidden="true" />

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
      <button class="fab-link" id="import-url-btn" type="button"
        aria-label="Import route from a RideWithGPS or Komoot URL"
        aria-expanded="false" aria-controls="url-import-panel">
        Or paste a URL
      </button>
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

/** @param {HTMLElement} container */
function wireEvents(container) {
  const fab = container.querySelector('#load-route-btn');
  const fileInput = container.querySelector('#gpx-file-input');

  // FAB -> trigger file picker
  fab.addEventListener('click', () => fileInput.click());

  // File selected -> parse and render
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setLoadingState(container, true);
      const text = await file.text();
      const route = parseGPX(text);
      applyRoute(container, route);
      saveRoute(text, file.name).catch((err) =>
        console.warn('[BPNav] Could not save route:', err.message),
      );
      kickoffWaterEnrichment(container, route);
      kickoffCampEnrichment(container, route);
      kickoffResupplyEnrichment(container, route);
    } catch (err) {
      console.error('[BPNav] GPX parse failed:', err);
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

  // Start-at-mile offset apply
  const startApplyBtn = container.querySelector('#start-offset-apply');
  startApplyBtn.addEventListener('click', () => {
    if (!currentRoute) return;
    const input = container.querySelector('#start-mile-input');
    const offsetMi = Math.max(0, Number.parseFloat(input.value) || 0);
    const adjusted = applyStartOffset(currentRoute, offsetMi);
    currentRoute = adjusted;
    updateResourceCards(container, adjusted);
    updateMapWaypoints(currentMap, adjusted.waypoints);
  });
}

// ---------------------------------------------------------------------------
// Route application — updates all UI from a parsed RouteContext
// ---------------------------------------------------------------------------

/** @param {HTMLElement} container @param {import('./gpx.js').RouteContext} route */
function applyRoute(container, route) {
  currentRoute = route;

  updateStatusChip(container, route);
  updateResourceCards(container, route);
  showMapSection(container, route);
}

/** @param {HTMLElement} container @param {import('./gpx.js').RouteContext} route */
function updateStatusChip(container, route) {
  const chip = container.querySelector('.status-chip');
  chip.className = 'status-chip status-chip--active';
  chip.textContent = route.name.length > 18 ? `${route.name.slice(0, 16)}…` : route.name;
  chip.setAttribute('aria-label', `Route loaded: ${route.name}`);
}

/** @param {HTMLElement} container @param {import('./gpx.js').RouteContext} route */
function updateResourceCards(container, route) {
  const waterWpts = waypointsOfType(route, 'water');
  const resupplyWpts = waypointsOfType(route, 'resupply');
  const campWpts = waypointsOfType(route, 'camping');

  const nextWater = nextWaypointOfType(route, 'water');
  const nextResupply = nextWaypointOfType(route, 'resupply');
  const nextCamp = nextWaypointOfType(route, 'camping');

  const cards = [
    {
      id: 'water',
      label: 'Next Drink',
      icon: ICONS.water,
      value: nextWater ? `${nextWater.distanceFromStartMi.toFixed(1)} mi` : 'None found',
      detail: nextWater ? nextWater.name : `${waterWpts.length} sources mapped`,
      state: nextWater ? 'active' : 'idle',
      reliability: nextWater?.reliability ?? 0,
    },
    {
      id: 'resupply',
      label: 'Next Resupply',
      icon: ICONS.resupply,
      value: nextResupply ? `${nextResupply.distanceFromStartMi.toFixed(1)} mi` : 'None found',
      detail: nextResupply ? nextResupply.name : `${resupplyWpts.length} options mapped`,
      state: nextResupply ? 'active' : 'idle',
    },
    {
      id: 'daylight',
      label: 'Next Camp',
      icon: ICONS.daylight,
      value: nextCamp ? `${nextCamp.distanceFromStartMi.toFixed(1)} mi` : '—',
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

  // Populate the route stats bar
  const waterCount = waypointsOfType(route, 'water').length;
  const resupplyCount = waypointsOfType(route, 'resupply').length;
  const campCount = waypointsOfType(route, 'camping').length;
  container.querySelector('#route-stats').innerHTML = `
    <span class="route-stat">${route.totalDistanceMiles.toFixed(1)} mi</span>
    <span class="route-stat-sep">·</span>
    <span class="route-stat">${waterCount} water</span>
    <span class="route-stat-sep">·</span>
    <span class="route-stat">${resupplyCount} resupply</span>
    <span class="route-stat-sep">·</span>
    <span class="route-stat">${campCount} camp</span>
  `;

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
  currentMap = initMap('map', route);
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
    const route = parseGPX(stored.gpxText);
    applyRoute(container, route);

    // Apply cached enrichment immediately so markers render without waiting
    // for a network round-trip — critical when the device is offline.
    const cachedWaypoints = await loadEnrichment().catch(() => null);
    if (cachedWaypoints?.length) {
      route.waypoints = cachedWaypoints;
      updateMapWaypoints(currentMap, route.waypoints);
      updateResourceCards(container, route);
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

    route.waypoints = [...route.waypoints.filter((w) => w.type !== 'water'), ...enrichedWater].sort(
      (a, b) => a.distanceFromStartMi - b.distanceFromStartMi,
    );

    updateMapWaypoints(currentMap, route.waypoints);
    updateResourceCards(container, route);
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
      ...route.waypoints.filter((w) => w.type !== 'camping'),
      ...enrichedCamps,
    ].sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

    updateMapWaypoints(currentMap, route.waypoints);
    updateResourceCards(container, route);
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
      ...route.waypoints.filter((w) => w.type !== 'resupply'),
      ...enrichedResupply,
    ].sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

    updateMapWaypoints(currentMap, route.waypoints);
    updateResourceCards(container, route);
    saveEnrichment(route.waypoints).catch(() => {});
  } catch (err) {
    console.warn('[BPNav] Resupply enrichment failed:', err.message);
  }
}

// Export classifyWaypoint so tests can import it from this module too
export { classifyWaypoint };
