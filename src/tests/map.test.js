/**
 * map.test.js — Unit tests for the map module.
 *
 * MapLibre GL is replaced by the jsdom-compatible mock in __mocks__/maplibre-gl.js.
 * The mock fires the 'load' callback synchronously, so addWaypointMarkers runs
 * during initMap and WeakMap marker tracking is active for all tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPopupHTML,
  createMarkerElement,
  destroyMap,
  highlightMapSegment,
  initMap,
  updateMapDayPlan,
  updateMapWaypoints,
  updateMileMarkers,
} from '../map.js';

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const WATER_WP = {
  id: 'w1',
  lat: 35.2,
  lon: -111.6,
  name: 'Ponderosa Spring',
  description: 'Seasonal — verify before relying',
  type: 'water',
  source: 'osm',
  reliability: 60,
  distanceFromStartMi: 12.4,
};

const CAMP_WP = {
  id: 'c1',
  lat: 35.1,
  lon: -111.7,
  name: 'Pine Flat',
  description: '',
  type: 'camping',
  source: 'osm',
  tier: 'dispersed',
  reliability: 80,
  distanceFromStartMi: 8.0,
};

const CAMP_WP_OFFICIAL = {
  id: 'c2',
  lat: 35.0,
  lon: -111.8,
  name: 'Manzanita Campground',
  description: '',
  type: 'camping',
  source: 'osm',
  tier: 'official',
  reliability: 90,
  distanceFromStartMi: 20.0,
};

const RESUPPLY_WP = {
  id: 'r1',
  lat: 34.9,
  lon: -111.9,
  name: 'Williams General Store',
  description: '',
  type: 'resupply',
  distanceFromStartMi: 30.0,
};

const NAV_WP = {
  id: 'n1',
  lat: 35.0,
  lon: -111.5,
  name: 'Turn left at junction',
  description: '',
  type: 'navigation',
  distanceFromStartMi: 4.0,
};

const MINIMAL_ROUTE = {
  name: 'Test Route',
  totalDistanceMiles: 50,
  bounds: { minLat: 34, maxLat: 36, minLon: -112, maxLon: -111 },
  trackPoints: [
    [35.0, -111.5],
    [35.2, -111.6],
  ],
  waypoints: [WATER_WP, CAMP_WP],
};

// ---------------------------------------------------------------------------
// createMarkerElement
// ---------------------------------------------------------------------------

describe('createMarkerElement', () => {
  it('sets the correct base and type class for water', () => {
    const el = createMarkerElement('water');
    expect(el.className).toContain('map-marker');
    expect(el.className).toContain('map-marker--water');
  });

  it('sets the correct class for camping', () => {
    const el = createMarkerElement('camping');
    expect(el.className).toContain('map-marker--camping');
  });

  it('sets the correct class for resupply', () => {
    const el = createMarkerElement('resupply');
    expect(el.className).toContain('map-marker--resupply');
  });

  it('sets the correct class for navigation', () => {
    const el = createMarkerElement('navigation');
    expect(el.className).toContain('map-marker--navigation');
  });

  it('sets role="button" for keyboard accessibility', () => {
    const el = createMarkerElement('water');
    expect(el.getAttribute('role')).toBe('button');
  });

  it('sets tabindex="0" so the marker is focusable', () => {
    const el = createMarkerElement('water');
    expect(el.getAttribute('tabindex')).toBe('0');
  });

  it('sets a descriptive aria-label', () => {
    const el = createMarkerElement('camping');
    expect(el.getAttribute('aria-label')).toContain('camping');
  });

  it('applies inline size styles', () => {
    const el = createMarkerElement('water');
    expect(el.style.cssText).toContain('18px');
  });

  it('scales up on mouseenter and back on mouseleave', () => {
    const el = createMarkerElement('water');
    el.dispatchEvent(new Event('mouseenter'));
    expect(el.style.transform).toContain('scale(1.4)');
    el.dispatchEvent(new Event('mouseleave'));
    expect(el.style.transform).toContain('scale(1)');
  });
});

// ---------------------------------------------------------------------------
// buildPopupHTML
// ---------------------------------------------------------------------------

describe('buildPopupHTML', () => {
  it('includes the waypoint name', () => {
    const html = buildPopupHTML(WATER_WP);
    expect(html).toContain('Ponderosa Spring');
  });

  it('includes the distance from start', () => {
    const html = buildPopupHTML(WATER_WP);
    expect(html).toContain('12.4 mi');
  });

  it('includes the Water type label', () => {
    const html = buildPopupHTML(WATER_WP);
    expect(html).toContain('Water');
  });

  it('includes the Camp type label for camping waypoints', () => {
    const html = buildPopupHTML(CAMP_WP);
    expect(html).toContain('Camp');
  });

  it('includes the Resupply type label', () => {
    const html = buildPopupHTML(RESUPPLY_WP);
    expect(html).toContain('Resupply');
  });

  it('includes a reliability bar for water waypoints', () => {
    const html = buildPopupHTML(WATER_WP);
    expect(html).toContain('popup-reliability');
    expect(html).toContain('60%');
  });

  it('includes a reliability bar for camping waypoints', () => {
    const html = buildPopupHTML(CAMP_WP);
    expect(html).toContain('popup-reliability');
    expect(html).toContain('80%');
  });

  it('does not include a reliability bar for resupply waypoints', () => {
    const html = buildPopupHTML(RESUPPLY_WP);
    expect(html).not.toContain('popup-reliability');
  });

  it('does not include a reliability bar for navigation waypoints', () => {
    const html = buildPopupHTML(NAV_WP);
    expect(html).not.toContain('popup-reliability');
  });

  it('includes a dispersed tier badge for dispersed camp sites', () => {
    const html = buildPopupHTML(CAMP_WP);
    expect(html).toContain('popup-tier--dispersed');
    expect(html).toContain('Dispersed');
  });

  it('includes a Campground tier badge for official camp sites', () => {
    const html = buildPopupHTML(CAMP_WP_OFFICIAL);
    expect(html).toContain('popup-tier--official');
    expect(html).toContain('Campground');
  });

  it('does not include a tier badge for water waypoints', () => {
    const html = buildPopupHTML(WATER_WP);
    expect(html).not.toContain('popup-tier');
  });

  it('includes the description when present', () => {
    const html = buildPopupHTML(WATER_WP);
    expect(html).toContain('Seasonal — verify before relying');
  });

  it('omits the description element when description is empty', () => {
    const html = buildPopupHTML(CAMP_WP);
    expect(html).not.toContain('popup-desc');
  });

  it('includes water amenity badge for potable water campgrounds', () => {
    const wp = {
      ...CAMP_WP_OFFICIAL,
      waterAvailable: 'potable',
      waterDetails: 'Potable water (hand pump)',
    };
    const html = buildPopupHTML(wp);
    expect(html).toContain('popup-amenity--water-potable');
    expect(html).toContain('Potable water (hand pump)');
  });

  it('includes fee badge for paid campgrounds', () => {
    const wp = {
      ...CAMP_WP_OFFICIAL,
      fee: '$27/night',
    };
    const html = buildPopupHTML(wp);
    expect(html).toContain('popup-amenity--fee');
    expect(html).toContain('$27/night');
  });

  it('includes free badge for free camping', () => {
    const wp = {
      ...CAMP_WP,
      fee: 'Free',
    };
    const html = buildPopupHTML(wp);
    expect(html).toContain('popup-amenity--fee-free');
    expect(html).toContain('Free');
  });
});

// ---------------------------------------------------------------------------
// initMap
// ---------------------------------------------------------------------------

describe('initMap', () => {
  it('returns a map object', () => {
    const map = initMap('map', MINIMAL_ROUTE);
    expect(map).toBeDefined();
  });

  it('does not throw for a route with no waypoints', () => {
    const route = { ...MINIMAL_ROUTE, waypoints: [] };
    expect(() => initMap('map', route)).not.toThrow();
  });

  it('does not throw for a route with navigation waypoints', () => {
    const route = { ...MINIMAL_ROUTE, waypoints: [NAV_WP] };
    expect(() => initMap('map', route)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// updateMapWaypoints
// ---------------------------------------------------------------------------

describe('updateMapWaypoints', () => {
  let map;

  beforeEach(() => {
    map = initMap('map', MINIMAL_ROUTE);
  });

  it('does not throw when called with an empty waypoints array', () => {
    expect(() => updateMapWaypoints(map, [])).not.toThrow();
  });

  it('does not throw when called with the same waypoints', () => {
    expect(() => updateMapWaypoints(map, MINIMAL_ROUTE.waypoints)).not.toThrow();
  });

  it('does not throw when called with new waypoints after initial load', () => {
    const enriched = [...MINIMAL_ROUTE.waypoints, CAMP_WP_OFFICIAL, RESUPPLY_WP];
    expect(() => updateMapWaypoints(map, enriched)).not.toThrow();
  });

  it('can be called multiple times without error', () => {
    expect(() => {
      updateMapWaypoints(map, [WATER_WP]);
      updateMapWaypoints(map, [WATER_WP, CAMP_WP]);
      updateMapWaypoints(map, []);
    }).not.toThrow();
  });

  it('is a no-op when map is null', () => {
    expect(() => updateMapWaypoints(null, [WATER_WP])).not.toThrow();
  });

  it('is a no-op when map is undefined', () => {
    expect(() => updateMapWaypoints(undefined, [WATER_WP])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// destroyMap
// ---------------------------------------------------------------------------

describe('destroyMap', () => {
  it('calls remove() on the map', () => {
    const map = initMap('map', MINIMAL_ROUTE);
    const removeSpy = vi.spyOn(map, 'remove');
    destroyMap(map);
    expect(removeSpy).toHaveBeenCalledOnce();
  });

  it('is a no-op when passed null', () => {
    expect(() => destroyMap(null)).not.toThrow();
  });

  it('is a no-op when passed undefined', () => {
    expect(() => destroyMap(undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// updateMapDayPlan & updateMileMarkers
// ---------------------------------------------------------------------------

describe('updateMapDayPlan', () => {
  let map;

  beforeEach(() => {
    map = initMap('map', MINIMAL_ROUTE);
  });

  it('updates map day plan without throwing errors', () => {
    const dayPlan = [
      {
        day: 1,
        startMi: 0,
        chosen: { endMi: 15, isFinish: false },
      },
      {
        day: 2,
        startMi: 15,
        chosen: { endMi: 30, isFinish: true },
      },
    ];

    expect(() => {
      updateMapDayPlan(map, MINIMAL_ROUTE.trackPoints, dayPlan);
    }).not.toThrow();
  });

  it('handles empty dayPlan gracefully', () => {
    expect(() => {
      updateMapDayPlan(map, MINIMAL_ROUTE.trackPoints, []);
    }).not.toThrow();
  });

  it('handles null map gracefully', () => {
    expect(() => {
      updateMapDayPlan(null, MINIMAL_ROUTE.trackPoints, []);
    }).not.toThrow();
  });

  it('adds a source and layers per day segment', () => {
    updateMapDayPlan(map, MINIMAL_ROUTE.trackPoints, [
      { day: 1, startMi: 0, chosen: { endMi: 15, isFinish: false } },
      { day: 2, startMi: 15, chosen: { endMi: 30, isFinish: true } },
    ]);

    expect(map.getSource('route-day-1')).toBeTruthy();
    expect(map.getSource('route-day-2')).toBeTruthy();
    expect(map.getLayer('route-line-day-1')).toBeTruthy();
  });

  it('clears stale day layers and sources on re-render', () => {
    updateMapDayPlan(map, MINIMAL_ROUTE.trackPoints, [
      { day: 1, startMi: 0, chosen: { endMi: 15, isFinish: false } },
      { day: 2, startMi: 15, chosen: { endMi: 30, isFinish: true } },
    ]);
    // Re-render with a single day — day 2's source and layer must be gone.
    updateMapDayPlan(map, MINIMAL_ROUTE.trackPoints, [
      { day: 1, startMi: 0, chosen: { endMi: 15, isFinish: true } },
    ]);

    expect(map.getSource('route-day-1')).toBeTruthy();
    expect(map.getSource('route-day-2')).toBeFalsy();
    expect(map.getLayer('route-line-day-2')).toBeFalsy();
  });
});

describe('highlightMapSegment style-load race', () => {
  /** Minimal fake whose style starts unloaded, so the deferral path is exercised. */
  function makeUnloadedMap() {
    const calls = { addSource: 0, addLayer: 0, deferred: [] };
    const sources = new Map();
    const map = {
      isStyleLoaded: () => calls.styleLoaded === true,
      once: (event, cb) => {
        if (event === 'style.load') calls.deferred.push(cb);
        return map;
      },
      getSource: (id) => sources.get(id) ?? null,
      addSource: (id, src) => {
        calls.addSource++;
        sources.set(id, { ...src, setData: () => {} });
        return map;
      },
      addLayer: () => {
        calls.addLayer++;
        return map;
      },
      fitBounds: () => map,
      calls,
    };
    return map;
  }

  const trackPoints = Array.from({ length: 60 }, (_, i) => [35.0 + i * 0.002, -111.0, 2000 + i]);

  // Regression: addSource/addLayer throw "Style is not done loading" when the
  // rider clicks a segment before the style settles.
  it('defers instead of touching the style before it loads', () => {
    const map = makeUnloadedMap();

    expect(() => highlightMapSegment(map, trackPoints, 0, 2)).not.toThrow();
    expect(map.calls.addSource).toBe(0);
    expect(map.calls.addLayer).toBe(0);
    expect(map.calls.deferred).toHaveLength(1);
  });

  it('applies the highlight once the style loads', () => {
    const map = makeUnloadedMap();
    highlightMapSegment(map, trackPoints, 0, 2);

    map.calls.styleLoaded = true;
    for (const cb of map.calls.deferred) cb();

    expect(map.calls.addSource).toBe(1);
    expect(map.calls.addLayer).toBeGreaterThan(0);
    expect(map.getSource('route-segment-highlight')).toBeTruthy();
  });

  it('adds the highlight immediately when the style is already loaded', () => {
    const map = makeUnloadedMap();
    map.calls.styleLoaded = true;

    highlightMapSegment(map, trackPoints, 0, 2);

    expect(map.calls.deferred).toHaveLength(0);
    expect(map.calls.addSource).toBe(1);
  });
});

describe('updateMileMarkers', () => {
  let map;

  beforeEach(() => {
    map = initMap('map', MINIMAL_ROUTE);
  });

  it('renders mile markers along the route without throwing', () => {
    expect(() => {
      updateMileMarkers(map, MINIMAL_ROUTE.trackPoints, true);
    }).not.toThrow();
  });

  it('clears mile markers when show is false', () => {
    expect(() => {
      updateMileMarkers(map, MINIMAL_ROUTE.trackPoints, false);
    }).not.toThrow();
  });
});
