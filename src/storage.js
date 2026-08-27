/**
 * storage.js -- IndexedDB persistence for Bikepacker Navigator.
 *
 * Supports multi-route library storage, active route tracking, automated
 * v1-to-v2 migration, and route bundle exports.
 *
 * @module storage
 */

import { describeError } from './errorBoundary.js';

const DB_NAME = 'bpnav-v1';
const DB_VERSION = 2;
const STORE_NAME = 'route';
const ROUTES_STORE = 'routes';
const ROUTE_KEY = 'current';
const ACTIVE_ID_KEY = 'active-route-id';
const ENRICHMENT_KEY = 'current-enrichment';
const PERSONAL_WAYPOINTS_KEY = 'personal-waypoints';
const OPTIONS_KEY = 'current-options';
const METADATA_KEY = 'current-metadata';

// ---------------------------------------------------------------------------
// DB bootstrap & migration
// ---------------------------------------------------------------------------

/**
 * Opens (or creates/upgrades) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      /** @type {IDBDatabase} */
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(ROUTES_STORE)) {
        db.createObjectStore(ROUTES_STORE, { keyPath: 'id' });
      }
    };

    req.onsuccess = async (e) => {
      const db = e.target.result;
      try {
        await migrateV1IfNeeded(db);
      } catch (err) {
        console.warn('[BPNav] DB migration notice:', describeError(err));
      }
      resolve(db);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Migrates existing v1 single-route storage into the v2 multi-route library store.
 * @param {IDBDatabase} db
 */
async function migrateV1IfNeeded(db) {
  if (!db.objectStoreNames.contains(ROUTES_STORE)) return;

  const count = await new Promise((res) => {
    const tx = db.transaction(ROUTES_STORE, 'readonly');
    const req = tx.objectStore(ROUTES_STORE).count();
    req.onsuccess = () => res(req.result);
    req.onerror = () => res(0);
  });

  if (count > 0) return; // Already migrated or has items

  // Check if v1 route exists
  const v1Route = await new Promise((res) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(ROUTE_KEY);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror = () => res(null);
  });

  if (v1Route?.gpxText) {
    const routeId = `route-${Date.now()}`;
    const routeRecord = {
      id: routeId,
      name: v1Route.filename ? v1Route.filename.replace(/\.gpx$/i, '') : 'Saved Route',
      filename: v1Route.filename || 'route.gpx',
      gpxText: v1Route.gpxText,
      savedAt: v1Route.savedAt || Date.now(),
      waypoints: [],
      options: null,
    };

    // Load enrichment and options if present
    const waypoints = await new Promise((res) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(ENRICHMENT_KEY);
      req.onsuccess = () => res(req.result?.waypoints ?? []);
      req.onerror = () => res([]);
    });
    routeRecord.waypoints = waypoints;

    const options = await new Promise((res) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(OPTIONS_KEY);
      req.onsuccess = () => res(req.result?.options ?? null);
      req.onerror = () => res(null);
    });
    routeRecord.options = options;

    // Save to routes store and set active
    await new Promise((res, rej) => {
      const tx = db.transaction([ROUTES_STORE, STORE_NAME], 'readwrite');
      tx.objectStore(ROUTES_STORE).put(routeRecord);
      tx.objectStore(STORE_NAME).put(routeId, ACTIVE_ID_KEY);
      tx.oncomplete = () => res();
      tx.onerror = (e) => rej(e.target.error);
    });
  }
}

// ---------------------------------------------------------------------------
// Multi-Route Library API
// ---------------------------------------------------------------------------

/**
 * Retrieves all saved routes from the library.
 * @returns {Promise<Array<object>>}
 */
export async function getAllRoutes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROUTES_STORE, 'readonly');
    const req = tx.objectStore(ROUTES_STORE).getAll();
    req.onsuccess = () => {
      const list = req.result || [];
      list.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
      resolve(list);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Retrieves a single route record by ID.
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function getRouteById(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROUTES_STORE, 'readonly');
    const req = tx.objectStore(ROUTES_STORE).get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Saves a route into the library store.
 * @param {object} routeData
 * @param {string} [routeData.id]
 * @param {string} routeData.name
 * @param {string} routeData.filename
 * @param {string} routeData.gpxText
 * @param {number} [routeData.totalDistanceMiles]
 * @param {Array} [routeData.waypoints]
 * @param {object} [routeData.options]
 * @returns {Promise<string>} The route ID
 */
export async function saveRouteToLibrary(routeData) {
  const db = await openDB();
  const id = routeData.id || `route-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    id,
    name: routeData.name || routeData.filename || 'Untitled Route',
    filename: routeData.filename || 'route.gpx',
    gpxText: routeData.gpxText,
    totalDistanceMiles: routeData.totalDistanceMiles || 0,
    waypoints: routeData.waypoints || [],
    options: routeData.options || null,
    savedAt: routeData.savedAt || Date.now(),
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction([ROUTES_STORE, STORE_NAME], 'readwrite');
    tx.objectStore(ROUTES_STORE).put(record);
    // Also keep legacy store in sync for immediate backward compatibility
    tx.objectStore(STORE_NAME).put(
      { gpxText: record.gpxText, filename: record.filename, savedAt: record.savedAt },
      ROUTE_KEY,
    );
    tx.objectStore(STORE_NAME).put(id, ACTIVE_ID_KEY);
    tx.oncomplete = () => resolve(id);
    tx.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Deletes a route from the library by ID.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteRouteFromLibrary(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([ROUTES_STORE, STORE_NAME], 'readwrite');
    tx.objectStore(ROUTES_STORE).delete(id);
    // If active route was deleted, clear active ID
    const activeReq = tx.objectStore(STORE_NAME).get(ACTIVE_ID_KEY);
    activeReq.onsuccess = () => {
      if (activeReq.result === id) {
        tx.objectStore(STORE_NAME).delete(ACTIVE_ID_KEY);
        tx.objectStore(STORE_NAME).delete(ROUTE_KEY);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Gets the ID of the currently active route.
 * @returns {Promise<string | null>}
 */
export async function getActiveRouteId() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(ACTIVE_ID_KEY);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Sets the currently active route ID.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function setActiveRouteId(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(id, ACTIVE_ID_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// ---------------------------------------------------------------------------
// Backward-compatible single route API
// ---------------------------------------------------------------------------

export async function saveRoute(gpxText, filename) {
  return saveRouteToLibrary({
    name: filename ? filename.replace(/\.gpx$/i, '') : 'Current Route',
    filename: filename || 'route.gpx',
    gpxText,
  });
}

export async function loadRoute() {
  const activeId = await getActiveRouteId();
  if (activeId) {
    const record = await getRouteById(activeId);
    if (record) {
      return { gpxText: record.gpxText, filename: record.filename, savedAt: record.savedAt };
    }
  }

  // Fallback to legacy key
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(ROUTE_KEY);
    req.onsuccess = (e) => resolve(e.target.result ?? null);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function clearRoute() {
  const activeId = await getActiveRouteId();
  if (activeId) {
    await deleteRouteFromLibrary(activeId);
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(ROUTE_KEY);
    tx.objectStore(STORE_NAME).delete(ACTIVE_ID_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function saveRouteMetadata(metadata) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ metadata, savedAt: Date.now() }, METADATA_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function loadRouteMetadata() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(METADATA_KEY);
    req.onsuccess = (e) => resolve(e.target.result?.metadata ?? null);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function clearRouteMetadata() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(METADATA_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Waypoints a rider keeps across every route — home, a trailhead, a water cache.
 *
 * Enrichment and route records are both scoped to one route, so a place that
 * matters regardless of route had nowhere to live and had to be re-added each
 * time. These are stored once and re-applied to whatever route is loaded, in
 * the same way wilderness boundaries are: held separately, projected on.
 *
 * @returns {Promise<import('./gpx.js').Waypoint[]>}
 */
export async function getPersonalWaypoints() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(PERSONAL_WAYPOINTS_KEY);
    req.onsuccess = (e) => resolve(e.target.result?.waypoints ?? []);
    req.onerror = () => resolve([]);
  });
}

/**
 * Adds or replaces a personal waypoint, keyed by id.
 * @param {import('./gpx.js').Waypoint} waypoint
 * @returns {Promise<import('./gpx.js').Waypoint[]>} the full list afterwards
 */
export async function savePersonalWaypoint(waypoint) {
  if (!waypoint?.id) return getPersonalWaypoints();
  const existing = await getPersonalWaypoints();
  // Store the place, not its position on the route that happened to be loaded:
  // distanceFromStartMi and offCourseDistanceMi are meaningless off that track
  // and are recomputed when the waypoint is applied to a route.
  const { distanceFromStartMi, offCourseDistanceMi, ...place } = waypoint;
  const next = [...existing.filter((w) => w.id !== waypoint.id), place];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(
      { waypoints: next, savedAt: Date.now() },
      PERSONAL_WAYPOINTS_KEY,
    );
    tx.oncomplete = () => resolve(next);
    tx.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Removes a personal waypoint.
 * @param {string} id
 * @returns {Promise<import('./gpx.js').Waypoint[]>} the full list afterwards
 */
export async function deletePersonalWaypoint(id) {
  const next = (await getPersonalWaypoints()).filter((w) => w.id !== id);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(
      { waypoints: next, savedAt: Date.now() },
      PERSONAL_WAYPOINTS_KEY,
    );
    tx.oncomplete = () => resolve(next);
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function saveEnrichment(waypoints) {
  const activeId = await getActiveRouteId();
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, ROUTES_STORE], 'readwrite');
    tx.objectStore(STORE_NAME).put({ waypoints, savedAt: Date.now() }, ENRICHMENT_KEY);

    if (activeId) {
      const routeReq = tx.objectStore(ROUTES_STORE).get(activeId);
      routeReq.onsuccess = () => {
        if (routeReq.result) {
          const updated = { ...routeReq.result, waypoints };
          tx.objectStore(ROUTES_STORE).put(updated);
        }
      };
    }

    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function loadEnrichment() {
  const activeId = await getActiveRouteId();
  if (activeId) {
    const record = await getRouteById(activeId);
    if (record?.waypoints?.length) return record.waypoints;
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(ENRICHMENT_KEY);
    req.onsuccess = (e) => resolve(e.target.result?.waypoints ?? null);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function clearEnrichment() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(ENRICHMENT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function savePlanOptions(options) {
  const activeId = await getActiveRouteId();
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, ROUTES_STORE], 'readwrite');
    tx.objectStore(STORE_NAME).put({ options, savedAt: Date.now() }, OPTIONS_KEY);

    if (activeId) {
      const routeReq = tx.objectStore(ROUTES_STORE).get(activeId);
      routeReq.onsuccess = () => {
        if (routeReq.result) {
          const updated = { ...routeReq.result, options };
          tx.objectStore(ROUTES_STORE).put(updated);
        }
      };
    }

    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function loadPlanOptions() {
  const activeId = await getActiveRouteId();
  if (activeId) {
    const record = await getRouteById(activeId);
    if (record?.options) return record.options;
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(OPTIONS_KEY);
    req.onsuccess = (e) => resolve(e.target.result?.options ?? null);
    req.onerror = (e) => reject(e.target.error);
  });
}

export async function clearPlanOptions() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(OPTIONS_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Compiles and returns the complete active plan export bundle.
 * @returns {Promise<object>}
 */
export async function exportPlanBundle() {
  const stored = await loadRoute();
  if (!stored) throw new Error('No route loaded to export.');

  const rawWaypoints = (await loadEnrichment().catch(() => [])) || [];
  const waypoints = rawWaypoints.filter(
    (w) => !w.id?.startsWith('synth-') && !w.isSynthetic && !w.name?.includes('Dispersed Camp ('),
  );
  const options = await loadPlanOptions().catch(() => null);

  return {
    version: '1.0',
    filename: stored.filename || 'route.gpx',
    gpxText: stored.gpxText,
    waypoints: waypoints,
    options: options,
  };
}
