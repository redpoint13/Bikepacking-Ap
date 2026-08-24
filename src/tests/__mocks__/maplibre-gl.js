/**
 * maplibre-gl mock for vitest / jsdom.
 * Replaces the real MapLibre with no-op stubs so tests can import
 * map.js and exercise full route, waypoint, and day-plan lifecycle
 * without needing a WebGL context.
 */

function makeMap() {
  const sources = new Map();
  const layers = new Map();

  const map = {
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
          sources.set(id, { ...sources.get(id), data });
        },
      };
    },
    addSource: (id, source) => {
      sources.set(id, source);
      return map;
    },
    removeSource: (id) => {
      sources.delete(id);
      return map;
    },
    getLayer: (id) => layers.get(id) || null,
    addLayer: (layer) => {
      layers.set(layer.id, layer);
      return map;
    },
    removeLayer: (id) => {
      layers.delete(id);
      return map;
    },
    setLayoutProperty: () => map,
    setPaintProperty: () => map,
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

class NavigationControl {}
class GeolocateControl {}

export default {
  Map: makeMap,
  Marker: makeMarker,
  Popup: makePopup,
  NavigationControl,
  GeolocateControl,
};
