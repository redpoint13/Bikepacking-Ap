/**
 * maplibre-gl mock for vitest / jsdom.
 * Replaces the real MapLibre with no-op stubs so tests can import
 * map.js and exercise full route, waypoint, and day-plan lifecycle
 * without needing a WebGL context.
 */

function makeMap() {
  const sources = new Map();
  const layers = new Map();

  // Call counters so tests can assert that updates diff rather than rebuild.
  const stats = {
    addSource: 0,
    removeSource: 0,
    addLayer: 0,
    removeLayer: 0,
    setData: 0,
    setPaintProperty: 0,
  };

  const map = {
    _stats: stats,
    _sources: sources,
    _layers: layers,
    _resetStats: () => {
      for (const k of Object.keys(stats)) stats[k] = 0;
    },
    on: (event, cb) => {
      if (event === 'load' || event === 'style.load') cb();
      return map;
    },
    once: (event, cb) => {
      if (event === 'load' || event === 'style.load') cb();
      return map;
    },
    off: () => map,
    remove: () => {},
    isStyleLoaded: () => true,
    loaded: () => true,
    getStyle: () => {
      const srcObj = {};
      for (const [k, v] of sources.entries()) srcObj[k] = v;
      return {
        layers: Array.from(layers.values()),
        sources: srcObj,
      };
    },
    getSource: (id) => {
      if (!sources.has(id)) return null;
      return {
        setData: (data) => {
          stats.setData++;
          sources.set(id, { ...sources.get(id), data });
        },
      };
    },
    addSource: (id, source) => {
      stats.addSource++;
      sources.set(id, source);
      return map;
    },
    removeSource: (id) => {
      // Real MapLibre throws if a layer still reads from the source.
      for (const layer of layers.values()) {
        if (layer.source === id) {
          throw new Error(`Source "${id}" cannot be removed while layer "${layer.id}" is using it.`);
        }
      }
      stats.removeSource++;
      sources.delete(id);
      return map;
    },
    getLayer: (id) => layers.get(id) || null,
    addLayer: (layer) => {
      stats.addLayer++;
      layers.set(layer.id, layer);
      return map;
    },
    removeLayer: (id) => {
      stats.removeLayer++;
      layers.delete(id);
      return map;
    },
    setLayoutProperty: () => map,
    setPaintProperty: (layerId, prop, value) => {
      stats.setPaintProperty++;
      const layer = layers.get(layerId);
      if (layer) layer.paint = { ...layer.paint, [prop]: value };
      return map;
    },
    addControl: () => map,
    fitBounds: () => map,
    flyTo: () => map,
    easeTo: () => map,
    jumpTo: () => map,
    panTo: () => map,
    setZoom: () => map,
    getZoom: () => 12,
    // app.js calls resize() from requestAnimationFrame on mode/visibility flips.
    resize: () => map,
    getCenter: () => ({ lat: 35.0, lng: -111.7 }),
    getBounds: () => ({
      getNorth: () => 36.0,
      getSouth: () => 34.0,
      getEast: () => -110.0,
      getWest: () => -112.0,
    }),
    project: ([lng, lat]) => ({ x: lng * 10, y: lat * 10 }),
    unproject: ([x, y]) => ({ lat: y / 10, lng: x / 10 }),
    getCanvas: () => ({ style: {} }),
  };
  return map;
}

function makeMarker() {
  const m = {
    setLngLat: () => m,
    setPopup: () => m,
    addTo: () => m,
    remove: () => {},
    togglePopup: () => {},
  };
  return m;
}

function makePopup() {
  const p = {
    setHTML: () => p,
    setLngLat: () => p,
    addTo: () => p,
    remove: () => {},
  };
  return p;
}

/** highlightMapSegment builds one of these to frame the highlighted segment. */
class LngLatBounds {
  constructor() {
    this.points = [];
  }
  extend(coord) {
    this.points.push(coord);
    return this;
  }
}

class NavigationControl {}
class GeolocateControl {}

export default {
  Map: makeMap,
  Marker: makeMarker,
  Popup: makePopup,
  LngLatBounds,
  NavigationControl,
  GeolocateControl,
};
