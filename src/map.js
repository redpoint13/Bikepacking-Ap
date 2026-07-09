/**
 * map.js — MapLibre GL JS wrapper for Bikepacker Navigator.
 *
 * Renders the route line and typed waypoint markers.
 * Tile source: OpenFreeMap (free, no API key required).
 *
 * @module map
 */

import maplibregl from 'maplibre-gl';
import { getCoordinatesAtMile, getTrackSegmentForMiles, haversineDistance } from './gpx.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TILE_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

/** Marker colours keyed by waypoint type — matches MD3 colour system. */
const MARKER_COLORS = {
  water: '#29b6f6', // Light blue (water drop)
  resupply: '#1565c0', // Dark blue (town/resupply circle)
  camping: '#795548', // Brown (campsite tent square)
  summit: '#ff6d00', // Vibrant orange (summit peak)
  navigation: '#78909c', // Cool slate grey (info notes)
};

const MARKER_SIZES = {
  water: 18,
  resupply: 18,
  camping: 18,
  summit: 18,
  navigation: 14,
};

/** Tracks active markers per map instance so they can be removed on update. */
const mapMarkers = new WeakMap();

// ---------------------------------------------------------------------------
// Map initialisation
// ---------------------------------------------------------------------------

/**
 * Creates and mounts a MapLibre map into the given container element,
 * then adds the route line and waypoint markers.
 *
 * @param {string | HTMLElement} container  - Element ID or DOM element
 * @param {import('./gpx.js').RouteContext} route
 * @returns {maplibregl.Map}
 */
export function initMap(container, route, activeStopIds = new Set(), customWaypoints = null) {
  const { bounds, trackPoints } = route;
  const waypoints = customWaypoints ?? route.waypoints;

  const map = new maplibregl.Map({
    container,
    style: TILE_STYLE,
    bounds: [
      [bounds.minLon, bounds.minLat],
      [bounds.maxLon, bounds.maxLat],
    ],
    fitBoundsOptions: { padding: 40 },
    // Attribution required by tile provider
    attributionControl: { compact: true },
  });

  // Initialise marker tracking for this map instance
  mapMarkers.set(map, []);

  map.on('load', () => {
    addRouteLayer(map, trackPoints);
    addWaypointMarkers(map, waypoints, activeStopIds);
  });

  // Add navigation controls (zoom +/-) — top-right, out of thumb reach
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  // Geolocation — shows a "locate me" button; tracks the rider's position
  // with a pulsing dot and optional heading arrow as they move.
  map.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserHeading: true,
    }),
    'top-right',
  );

  return map;
}

// ---------------------------------------------------------------------------
// Route line
// ---------------------------------------------------------------------------

/**
 * Adds the route as a GeoJSON LineString layer.
 * @param {maplibregl.Map} map
 * @param {Array<[number, number]>} trackPoints  - [lat, lon] pairs
 */
function addRouteLayer(map, trackPoints) {
  // MapLibre expects [lon, lat] (GeoJSON standard)
  const coordinates = trackPoints.map(([lat, lon]) => [lon, lat]);

  map.addSource('route', {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
      properties: {},
    },
  });

  // Subtle glow layer underneath
  map.addLayer({
    id: 'route-glow',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#78dc95',
      'line-width': 8,
      'line-opacity': 0.25,
      'line-blur': 4,
    },
  });

  // Main route line
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#78dc95',
      'line-width': 3,
      'line-opacity': 0.9,
    },
  });
}

// ---------------------------------------------------------------------------
// Waypoint markers
// ---------------------------------------------------------------------------

/**
 * Creates a circular or diamond SVG marker element for a waypoint type.
 * @param {'water' | 'resupply' | 'camping' | 'summit' | 'navigation'} type
 * @param {boolean} [isStop=true]
 * @param {boolean} [isOffCourse=false]
 * @returns {HTMLElement}
 */
export function createMarkerElement(type, isStop = true, isOffCourse = false) {
  const size = MARKER_SIZES[type] ?? 10;
  const color = MARKER_COLORS[type] ?? '#9e9e9e';

  const el = document.createElement('div');
  el.className = `map-marker map-marker--${type}${isStop ? '' : ' map-marker--skipped'}${isOffCourse ? ' map-marker--off-course' : ''}`;
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', `${type} waypoint`);

  const isCamp = type === 'camping';

  const borderStyle = isOffCourse
    ? '2.5px dashed #ba1a1a'
    : `2px solid ${isStop ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.25)'}`;

  el.style.cssText = `
    width: ${size}px;
    height: ${size}px;
    background: ${color};
    border: ${borderStyle};
    border-radius: ${isCamp ? '4px' : '50%'};
    cursor: pointer;
    box-shadow: ${isStop ? '0 2px 6px rgba(0,0,0,0.5)' : 'none'};
    opacity: ${isStop ? '1' : '0.45'};
    pointer-events: auto !important;
    z-index: ${isStop ? '2' : '1'};
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.15s ease;
  `;

  const iconColor = isStop ? 'white' : 'rgba(255, 255, 255, 0.7)';
  let svgHtml = '';

  if (type === 'water') {
    svgHtml = `
      <svg viewBox="0 0 24 24" style="width: 70%; height: 70%; fill: ${iconColor}; pointer-events: none;">
        <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
      </svg>
    `;
  } else if (type === 'camping') {
    svgHtml = `
      <svg viewBox="0 0 24 24" style="width: 75%; height: 75%; fill: none; stroke: ${iconColor}; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; pointer-events: none;">
        <path d="M19 20L12 4L5 20" />
        <path d="M12 4v16" />
        <path d="M7 20h10" />
      </svg>
    `;
  } else if (type === 'resupply') {
    svgHtml = `
      <svg viewBox="0 0 24 24" style="width: 65%; height: 65%; fill: none; stroke: ${iconColor}; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; pointer-events: none;">
        <circle cx="9" cy="21" r="1" fill="${iconColor}" />
        <circle cx="20" cy="21" r="1" fill="${iconColor}" />
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
      </svg>
    `;
  } else if (type === 'summit') {
    svgHtml = `
      <svg viewBox="0 0 24 24" style="width: 70%; height: 70%; fill: none; stroke: ${iconColor}; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; pointer-events: none;">
        <path d="M3 20h18L12 4z" />
        <path d="M9 14l3-3 3 3" />
      </svg>
    `;
  } else if (type === 'navigation') {
    svgHtml = `
      <svg viewBox="0 0 24 24" style="width: 65%; height: 65%; fill: none; stroke: ${iconColor}; stroke-width: 3.5; stroke-linecap: round; stroke-linejoin: round; pointer-events: none;">
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    `;
  }

  el.innerHTML = svgHtml;

  el.addEventListener('mouseenter', () => {
    const current = el.style.transform || '';
    el.style.transform = `${current.replace(/\s*scale\([^)]*\)/g, '')} scale(1.4)`;
  });
  el.addEventListener('mouseleave', () => {
    const current = el.style.transform || '';
    el.style.transform = `${current.replace(/\s*scale\([^)]*\)/g, '')} scale(1)`;
  });

  return el;
}

/**
 * Builds the HTML content for a waypoint popup.
 * @param {import('./gpx.js').Waypoint} waypoint
 * @param {boolean} [isActiveStop=true]
 * @returns {string}
 */
export function buildPopupHTML(waypoint, isActiveStop = true) {
  const typeLabel =
    {
      water: '💧 Water',
      resupply: '🛒 Resupply',
      camping: '⛺ Camp',
      summit: '🏔️ Summit',
      navigation: '📍 Note',
    }[waypoint.type] ?? '📍 Note';

  const distanceStr = waypoint.distanceFromStartMi.toFixed(1);

  const showReliability =
    (waypoint.type === 'water' || waypoint.type === 'camping') && waypoint.reliability != null;

  const reliabilityBar = showReliability
    ? `<div class="popup-reliability">
         <span class="popup-reliability__label">Reliability</span>
         <div class="popup-reliability__track">
           <div class="popup-reliability__fill" style="width:${waypoint.reliability}%"></div>
         </div>
         <span class="popup-reliability__pct">${waypoint.reliability}%</span>
       </div>`
    : '';

  const tierBadge =
    waypoint.type === 'camping' && waypoint.tier
      ? `<span class="popup-tier popup-tier--${waypoint.tier}">${
          waypoint.tier === 'dispersed' ? 'Dispersed' : 'Campground'
        }</span>`
      : '';

  const desc = waypoint.description ? `<p class="popup-desc">${waypoint.description}</p>` : '';

  const offCourseDist = waypoint.offCourseDistanceMi || 0;
  const offCourseLabel =
    offCourseDist > 0.2
      ? `${offCourseDist.toFixed(1)} mi`
      : `${Math.round(offCourseDist * 5280)} ft`;
  const offCourseWarning =
    offCourseDist * 5280 > 300
      ? `<p class="popup-warning" style="
         margin: 4px 0 0 0;
         color: #ba1a1a;
         font-size: 11px;
         font-weight: 700;
         display: flex;
         align-items: center;
         gap: 4px;
       ">
         ⚠️ detour: ${offCourseLabel} off course
       </p>`
      : '';

  const toggleBtn =
    waypoint.type === 'water' || waypoint.type === 'resupply' || waypoint.type === 'camping'
      ? `<button class="popup-toggle-btn" data-action="toggle-stop" data-id="${waypoint.id}" style="
         margin-top: 8px;
         width: 100%;
         padding: 6px;
         background-color: ${isActiveStop ? 'var(--md-sys-color-error-container, #ffdad6)' : 'var(--md-sys-color-primary-container, #e8f5e9)'};
         color: ${isActiveStop ? 'var(--md-sys-color-on-error-container, #410002)' : 'var(--md-sys-color-on-primary-container, #1b5e20)'};
         border: 1px solid var(--md-sys-color-outline-variant);
         border-radius: 4px;
         font-size: 11px;
         font-weight: 600;
         cursor: pointer;
       ">
         ${isActiveStop ? '✕ Skip this stop' : '＋ Stop here'}
       </button>`
      : '';

  return `
    <div class="map-popup">
      <p class="popup-type">${typeLabel} · ${distanceStr} mi</p>
      <p class="popup-name">${waypoint.name}</p>
      ${tierBadge}
      ${desc}
      ${reliabilityBar}
      ${offCourseWarning}
      ${toggleBtn}
    </div>
  `;
}

/**
 * Adds a MapLibre Marker + Popup for every waypoint and tracks them so they
 * can be removed by updateMapWaypoints. Navigation waypoints are rendered
 * smaller and without popups.
 * @param {maplibregl.Map} map
 * @param {import('./gpx.js').Waypoint[]} waypoints
 * @param {Set<string>} [activeStopIds]
 */
function addWaypointMarkers(map, waypoints, activeStopIds = new Set()) {
  const markers = [];

  for (const waypoint of waypoints) {
    const isStop =
      waypoint.type === 'navigation' ||
      waypoint.type === 'summit' ||
      activeStopIds.has(waypoint.id);
    const isOffCourse = (waypoint.offCourseDistanceMi || 0) * 5280 > 300;
    const el = createMarkerElement(waypoint.type, isStop, isOffCourse);
    el.title = waypoint.name; // Browser native tooltip on hover

    const marker = new maplibregl.Marker({ element: el }).setLngLat([waypoint.lon, waypoint.lat]);

    // All waypoints (including skipped stops and navigation notes) are clickable with popups
    const popup = new maplibregl.Popup({
      offset: 12,
      className: 'bp-popup',
      closeButton: false,
      maxWidth: '260px',
    }).setHTML(buildPopupHTML(waypoint, isStop));

    marker.setPopup(popup);

    marker.addTo(map);
    markers.push(marker);
  }

  mapMarkers.set(map, markers);
}

/**
 * Replaces all waypoint markers on the map with a fresh set built from the
 * provided waypoints array. Call this after async enrichment (water, camp)
 * updates route.waypoints.
 *
 * @param {maplibregl.Map | null} map
 * @param {import('./gpx.js').Waypoint[]} waypoints
 * @param {Set<string>} [activeStopIds]
 */
export function updateMapWaypoints(map, waypoints, activeStopIds = new Set()) {
  if (!map) return;

  // Remove every currently tracked marker
  const existing = mapMarkers.get(map) ?? [];
  for (const marker of existing) {
    marker.remove();
  }

  // Re-add the full updated set
  addWaypointMarkers(map, waypoints, activeStopIds);
}

// ---------------------------------------------------------------------------
// Map cleanup
// ---------------------------------------------------------------------------

/**
 * Removes the map instance and frees GL resources.
 * Call this before re-initialising the map with a new route.
 * @param {maplibregl.Map | null | undefined} map
 */
export function destroyMap(map) {
  if (!map) return;
  mapMarkers.delete(map);
  userMarkers.delete(map);
  map.remove();
}

const userMarkers = new WeakMap();

/**
 * Updates or creates the user location marker on the map.
 * @param {maplibregl.Map | null} map
 * @param {number} lat
 * @param {number} lon
 */
export function updateUserLocationMarker(map, lat, lon) {
  if (!map) return;
  let marker = userMarkers.get(map);
  if (!marker) {
    const el = document.createElement('div');
    el.className = 'user-location-marker';
    el.style.cssText = `
      width: 18px;
      height: 18px;
      background: #78dc95; /* primary green */
      border: 3px solid #ffffff;
      border-radius: 50%;
      box-shadow: 0 0 0 4px rgba(120, 220, 149, 0.4);
      transition: transform 0.15s ease;
    `;
    marker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
    userMarkers.set(map, marker);
  } else {
    marker.setLngLat([lon, lat]);
  }
  map.panTo([lon, lat]);
}

const mileMarkers = new WeakMap();

/**
 * Renders or removes 10-mile markers along the route.
 * @param {maplibregl.Map | null} map
 * @param {Array<[number, number]>} trackPoints - [lat, lon] pairs
 * @param {boolean} show - whether to show markers
 */
export function updateMileMarkers(map, trackPoints, show) {
  if (!map) return;

  // Clear existing
  const existing = mileMarkers.get(map) ?? [];
  for (const m of existing) {
    m.remove();
  }
  mileMarkers.set(map, []);

  if (!show || !trackPoints || trackPoints.length < 2) return;

  const markers = [];
  let cumulative = 0;
  let nextTarget = 10;

  for (let i = 1; i < trackPoints.length; i++) {
    const p1 = trackPoints[i - 1];
    const p2 = trackPoints[i];
    const d = haversineDistance(p1[0], p1[1], p2[0], p2[1]);

    while (cumulative + d >= nextTarget) {
      // Interpolate point
      const ratio = (nextTarget - cumulative) / d;
      const lat = p1[0] + (p2[0] - p1[0]) * ratio;
      const lon = p1[1] + (p2[1] - p1[1]) * ratio;

      const el = document.createElement('div');
      el.className = 'map-marker map-marker--mile';
      el.style.cssText = `
        width: 16px;
        height: 16px;
        background: #37474f;
        color: #ffffff;
        border: 1.5px solid #ffffff;
        border-radius: 50%;
        font-size: 8px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 1px 3px rgba(0,0,0,0.3);
      `;
      el.textContent = nextTarget.toString();

      const m = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
      markers.push(m);

      nextTarget += 10;
    }
    cumulative += d;
  }

  mileMarkers.set(map, markers);
}

const dayLabelsMap = new WeakMap();

/**
 * Updates the map route segments and adds text pill markers for day boundaries.
 *
 * @param {maplibregl.Map | null} map
 * @param {Array<[number, number]>} trackPoints
 * @param {Array<object>} dayPlan
 */
export function updateMapDayPlan(map, trackPoints, dayPlan) {
  if (!map) return;

  // --- 1. Update Day Route Line Segments ---
  const style = map.getStyle();
  if (style) {
    const dayLayers = style.layers.filter(
      (l) => l.id.startsWith('route-line-day-') || l.id.startsWith('route-glow-day-'),
    );
    for (const layer of dayLayers) {
      map.removeLayer(layer.id);
    }
    const daySources = Object.keys(style.sources).filter((s) => s.startsWith('route-day-'));
    for (const source of daySources) {
      map.removeSource(source);
    }
  }

  // If there's no day plan or it is empty, make sure the original route lines are visible
  if (!dayPlan || dayPlan.length === 0) {
    if (map.getLayer('route-line')) map.setLayoutProperty('route-line', 'visibility', 'visible');
    if (map.getLayer('route-glow')) map.setLayoutProperty('route-glow', 'visibility', 'visible');
  } else {
    // Hide default route lines
    if (map.getLayer('route-line')) map.setLayoutProperty('route-line', 'visibility', 'none');
    if (map.getLayer('route-glow')) map.setLayoutProperty('route-glow', 'visibility', 'none');

    const colors = [
      '#78dc95', // Green (primary)
      '#29b6f6', // Light Blue
      '#ab47bc', // Purple
      '#ff7043', // Orange/Coral
      '#fdd835', // Yellow
      '#26a69a', // Teal
      '#ec407a', // Pink
    ];

    dayPlan.forEach((d, index) => {
      const segmentPoints = getTrackSegmentForMiles(trackPoints, d.startMi, d.chosen.endMi);
      if (segmentPoints.length < 2) return;

      const coordinates = segmentPoints.map(([lat, lon]) => [lon, lat]);
      const sourceId = `route-day-${d.day}`;
      const lineLayerId = `route-line-day-${d.day}`;
      const glowLayerId = `route-glow-day-${d.day}`;
      const color = colors[index % colors.length];

      map.addSource(sourceId, {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates },
          properties: {},
        },
      });

      map.addLayer(
        {
          id: glowLayerId,
          type: 'line',
          source: sourceId,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': color,
            'line-width': 8,
            'line-opacity': 0.25,
            'line-blur': 4,
          },
        },
        'route-glow',
      );

      map.addLayer(
        {
          id: lineLayerId,
          type: 'line',
          source: sourceId,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': color,
            'line-width': 4.5,
            'line-opacity': 0.9,
          },
        },
        'route-line',
      );
    });
  }

  // --- 2. Update Day Boundary Labels ---
  const existingLabels = dayLabelsMap.get(map) ?? [];
  for (const marker of existingLabels) {
    marker.remove();
  }
  dayLabelsMap.set(map, []);

  if (!dayPlan || dayPlan.length === 0) return;

  const labelMarkers = [];
  const colors = [
    '#78dc95', // Green (primary)
    '#29b6f6', // Light Blue
    '#ab47bc', // Purple
    '#ff7043', // Orange/Coral
    '#fdd835', // Yellow
    '#26a69a', // Teal
    '#ec407a', // Pink
  ];

  // Start label at the beginning of Day 1
  const startPt = trackPoints[0];
  if (startPt) {
    const el = document.createElement('div');
    el.className = 'day-label-pill';
    el.style.cssText = `
      background: var(--md-sys-color-surface, #111113);
      color: #ffffff;
      border: 2px solid ${colors[0]};
      border-radius: 100px;
      padding: 3px 8px;
      font-size: 10px;
      font-weight: 700;
      box-shadow: 0 2px 6px rgba(0,0,0,0.5);
      white-space: nowrap;
      pointer-events: none;
      z-index: 10;
    `;
    el.textContent = '🏁 Start';
    const marker = new maplibregl.Marker({ element: el, offset: [0, -20] })
      .setLngLat([startPt[1], startPt[0]])
      .addTo(map);
    labelMarkers.push(marker);
  }

  // Camp labels for each day's stop
  dayPlan.forEach((d, index) => {
    const chosen = d.chosen;
    if (!chosen) return;

    const pt = getCoordinatesAtMile(trackPoints, chosen.endMi);
    if (!pt) return;

    const el = document.createElement('div');
    el.className = 'day-label-pill';
    const color = colors[index % colors.length];

    el.style.cssText = `
      background: var(--md-sys-color-surface, #111113);
      color: #ffffff;
      border: 2px solid ${color};
      border-radius: 100px;
      padding: 3px 8px;
      font-size: 10px;
      font-weight: 700;
      box-shadow: 0 2px 6px rgba(0,0,0,0.5);
      white-space: nowrap;
      pointer-events: none;
      z-index: 10;
    `;

    if (chosen.isFinish) {
      el.textContent = '🏆 Finish';
    } else {
      el.textContent = `⛺ Day ${d.day} Camp`;
    }

    // Set offset slightly higher than standard waypoints to sit cleanly above icons
    const marker = new maplibregl.Marker({ element: el, offset: [0, -28] })
      .setLngLat([pt[1], pt[0]])
      .addTo(map);
    labelMarkers.push(marker);
  });

  dayLabelsMap.set(map, labelMarkers);
}
