/**
 * storage.js -- IndexedDB persistence for Bikepacker Navigator.
 *
 * Stores the most recently loaded route (raw GPX text + metadata) so it
 * survives page reloads, phone sleep, and PWA cold starts.
 *
 * @module storage
 */

const DB_NAME = 'bpnav-v1';
const DB_VERSION = 1;
const STORE_NAME = 'route';
const ROUTE_KEY = 'current';
const ENRICHMENT_KEY = 'current-enrichment';

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------

/**
 * Opens (or creates) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      /** @type {IDBDatabase} */
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persists the raw GPX text for the current route.
 * @param {string} gpxText   - Raw GPX file content
 * @param {string} filename  - Original file name (for display)
 * @returns {Promise<void>}
 */
export async function saveRoute(gpxText, filename) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ gpxText, filename, savedAt: Date.now() }, ROUTE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Loads the most recently persisted route.
 * @returns {Promise<{ gpxText: string, filename: string, savedAt: number } | null>}
 */
export async function loadRoute() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(ROUTE_KEY);
    req.onsuccess = (e) => resolve(e.target.result ?? null);
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Removes the stored route (e.g. when the user explicitly clears it).
 * @returns {Promise<void>}
 */
export async function clearRoute() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(ROUTE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// ---------------------------------------------------------------------------
// Enrichment cache -- offline fallback for OSM / USGS waypoints
// ---------------------------------------------------------------------------

/**
 * Persists the merged enriched waypoint array for the current route.
 * Keyed alongside the route record so it stays in sync with saves/clears.
 *
 * @param {import('./gpx.js').Waypoint[]} waypoints
 * @returns {Promise<void>}
 */
export async function saveEnrichment(waypoints) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ waypoints, savedAt: Date.now() }, ENRICHMENT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Loads the most recently cached enrichment waypoints.
 * Returns null if no enrichment has been saved yet.
 *
 * @returns {Promise<import('./gpx.js').Waypoint[] | null>}
 */
export async function loadEnrichment() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(ENRICHMENT_KEY);
    req.onsuccess = (e) => resolve(e.target.result?.waypoints ?? null);
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Removes any cached enrichment data (use when loading a fresh route).
 * @returns {Promise<void>}
 */
export async function clearEnrichment() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(ENRICHMENT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}
