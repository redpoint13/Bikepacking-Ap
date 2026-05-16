/**
 * maplibre-gl mock for vitest / jsdom.
 * Replaces the real MapLibre with no-op stubs so tests can import
 * map.js without needing a WebGL context.
 *
 * The 'load' event callback is fired synchronously so that addRouteLayer
 * and addWaypointMarkers run during initMap — allowing updateMapWaypoints
 * and marker tracking to be tested.
 */

function makeMap() {
  const map = {
    on: (event, cb) => {
      if (event === 'load') cb();
      return map;
    },
    off: () => map,
    remove: () => {},
    addLayer: () => map,
    addSource: () => map,
    addControl: () => map,
    fitBounds: () => map,
    getCanvas: () => ({ style: {} }),
    loaded: () => true,
  };
  return map;
}

function makeMarker() {
  const m = {
    setLngLat: () => m,
    setPopup: () => m,
    addTo: () => m,
    remove: () => {},
  };
  return m;
}

function makePopup() {
  const p = { setHTML: () => p };
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
