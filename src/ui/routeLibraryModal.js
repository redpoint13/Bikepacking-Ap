/**
 * routeLibraryModal.js — Interactive Route Library for multi-track management.
 *
 * Allows users to browse saved routes, switch active route, import GPX/URL,
 * export GPX/JSON plan bundles, and delete old tracks.
 *
 * @module ui/routeLibraryModal
 */

import { describeError } from '../errorBoundary.js';
import {
  deleteRouteFromLibrary,
  getActiveRouteId,
  getAllRoutes,
  getRouteById,
} from '../storage.js';

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export async function openRouteLibraryModal({ onSelectRoute, onUploadGPX, onImportURL }) {
  /** Reads the keep-waypoints choice at the moment of import, not at render. */
  const keepWaypoints = () => document.getElementById('route-keep-waypoints')?.checked === true;

  closeRouteLibraryModal();

  const activeId = await getActiveRouteId();
  const routes = await getAllRoutes();

  const modal = document.createElement('div');
  modal.id = 'route-library-modal';
  modal.className = 'route-library-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-label', 'Route Library');

  modal.innerHTML = `
    <div class="route-library-backdrop" data-action="close"></div>
    <div class="route-library-dialog">
      <div class="route-library-header">
        <div>
          <h2 class="route-library-title">Route Library</h2>
          <p class="route-library-subtitle">Manage, switch, or export your saved bikepacking tracks</p>
        </div>
        <button class="route-library-close" data-action="close" aria-label="Close Library">&times;</button>
      </div>

      <div class="route-library-toolbar">
        <div class="route-library-search-box">
          <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input type="text" id="route-search-input" class="route-search-input" placeholder="Search routes by name..." />
        </div>

        <div class="route-library-import-actions">
          <label class="btn-import-gpx">
            <input type="file" id="route-file-input" accept=".gpx" style="display: none;" />
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="17 8 12 3 7 8"></polyline>
              <line x1="12" y1="3" x2="12" y2="15"></line>
            </svg>
            Upload GPX
          </label>
        </div>

        <label class="route-keep-waypoints" title="Carry the current route's water, camp and resupply markers onto the new track">
          <input type="checkbox" id="route-keep-waypoints" />
          <span>Keep existing waypoints</span>
        </label>
      </div>

      <div class="route-library-url-import">
        <input type="url" id="route-url-input" class="route-url-input" placeholder="Or paste RideWithGPS / Komoot route link..." />
        <button id="route-url-submit" class="btn-url-submit">Import URL</button>
      </div>

      <div id="route-cards-container" class="route-cards-container">
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const container = modal.querySelector('#route-cards-container');
  const searchInput = modal.querySelector('#route-search-input');
  const fileInput = modal.querySelector('#route-file-input');
  const urlInput = modal.querySelector('#route-url-input');
  const urlSubmit = modal.querySelector('#route-url-submit');

  function renderList() {
    const filter = (searchInput.value || '').toLowerCase().trim();
    const filtered = routes.filter((r) => (r.name || '').toLowerCase().includes(filter));

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="route-library-empty">
          <p class="empty-title">No routes found</p>
          <p class="empty-desc">Upload a .gpx file or import from RideWithGPS to add tracks to your library.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered
      .map((r) => {
        const isActive = r.id === activeId;
        const dist = r.totalDistanceMiles ? `${r.totalDistanceMiles.toFixed(1)} mi` : 'GPX Track';
        const waypointsCount = r.waypoints ? r.waypoints.length : 0;
        const dateStr = formatDate(r.savedAt);

        const activeBadge = isActive
          ? '<span class="route-badge route-badge--active">Active</span>'
          : '';
        const selectBtn = isActive
          ? '<button class="btn-card-action btn-card-action--active" disabled>Loaded</button>'
          : `<button class="btn-card-action btn-card-action--select" data-action="select" data-route-id="${r.id}">Load Route</button>`;

        return `
          <div class="route-card ${isActive ? 'route-card--active' : ''}" data-route-id="${r.id}">
            <div class="route-card__main">
              <div class="route-card__header">
                <h3 class="route-card__title">${r.name || 'Untitled Route'}</h3>
                ${activeBadge}
              </div>
              <div class="route-card__meta">
                <span class="meta-item"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg> ${dist}</span>
                <span class="meta-item"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> ${dateStr}</span>
                ${waypointsCount > 0 ? `<span class="meta-item"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg> ${waypointsCount} POIs</span>` : ''}
              </div>
            </div>

            <div class="route-card__actions">
              ${selectBtn}
              <button class="btn-card-action btn-card-action--icon" data-action="export-gpx" data-route-id="${r.id}" title="Export GPX file">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                GPX
              </button>
              <button class="btn-card-action btn-card-action--icon" data-action="export-json" data-route-id="${r.id}" title="Export Plan Bundle (JSON)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                Plan JSON
              </button>
              <button class="btn-card-action btn-card-action--delete" data-action="delete" data-route-id="${r.id}" title="Delete Route" aria-label="Delete Route">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              </button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  renderList();

  searchInput.addEventListener('input', renderList);

  for (const el of modal.querySelectorAll('[data-action="close"]')) {
    el.addEventListener('click', closeRouteLibraryModal);
  }

  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.getAttribute('data-action');
    const routeId = btn.getAttribute('data-route-id');
    const targetRoute = routes.find((r) => r.id === routeId);
    if (!targetRoute) return;

    if (action === 'select') {
      closeRouteLibraryModal();
      if (onSelectRoute) onSelectRoute(routeId);
    } else if (action === 'export-gpx') {
      const full = await getRouteById(routeId);
      if (full?.gpxText) {
        const fn = full.filename || `${(full.name || 'route').replace(/\s+/g, '_')}.gpx`;
        downloadFile(full.gpxText, fn, 'application/gpx+xml');
      }
    } else if (action === 'export-json') {
      const full = await getRouteById(routeId);
      if (full) {
        const bundle = {
          version: '1.0',
          name: full.name,
          filename: full.filename,
          gpxText: full.gpxText,
          waypoints: full.waypoints || [],
          options: full.options || null,
          savedAt: full.savedAt,
        };
        const fn = `${(full.name || 'route').replace(/\s+/g, '_')}_plan.json`;
        downloadFile(JSON.stringify(bundle, null, 2), fn, 'application/json');
      }
    } else if (action === 'delete') {
      if (confirm(`Delete "${targetRoute.name || 'this route'}" from your library?`)) {
        await deleteRouteFromLibrary(routeId);
        const idx = routes.findIndex((r) => r.id === routeId);
        if (idx !== -1) routes.splice(idx, 1);
        renderList();
      }
    }
  });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file && onUploadGPX) {
      // Read before closing: the checkbox lives in the modal being torn down.
      const keep = keepWaypoints();
      closeRouteLibraryModal();
      await onUploadGPX(file, { keepWaypoints: keep });
    }
  });

  urlSubmit.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (url && onImportURL) {
      urlSubmit.disabled = true;
      urlSubmit.textContent = 'Importing...';
      try {
        closeRouteLibraryModal();
        await onImportURL(url, { keepWaypoints: keepWaypoints() });
      } catch (err) {
        alert(`Failed to import: ${describeError(err)}`);
      } finally {
        urlSubmit.disabled = false;
        urlSubmit.textContent = 'Import URL';
      }
    }
  });
}

export function closeRouteLibraryModal() {
  const modal = document.getElementById('route-library-modal');
  if (modal) modal.remove();
}
