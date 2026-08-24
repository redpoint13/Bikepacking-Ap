/**
 * waypointEditorModal.js — Interactive modal for creating and editing custom waypoints.
 *
 * @module ui/waypointEditorModal
 */

import { getCoordinatesAtMile } from '../gpx.js';
import { readValue } from '../utils/dom.js';

export function openWaypointEditorModal({
  waypoint = null,
  route = null,
  defaultMile = 0,
  defaultCoords = null,
  onSave,
  onDelete,
}) {
  closeWaypointEditorModal();

  const isEditing = !!waypoint;
  const type = waypoint?.type || 'water';
  const name = waypoint?.name || '';
  const description = waypoint?.description || '';
  const mile =
    waypoint?.distanceFromStartMi != null
      ? waypoint.distanceFromStartMi.toFixed(1)
      : defaultMile.toFixed(1);
  let lat = waypoint?.lat != null ? waypoint.lat : (defaultCoords?.lat ?? 0);
  let lon = waypoint?.lon != null ? waypoint.lon : (defaultCoords?.lon ?? 0);

  // If default coordinates are missing or at (0,0), interpolate from track points
  if (!lat && !lon && route?.trackPoints?.length) {
    const pt = getCoordinatesAtMile(route.trackPoints, Number.parseFloat(mile) || 0);
    if (pt) {
      lat = pt[0];
      lon = pt[1];
    }
  }

  const reliability = waypoint?.reliability || 'reliable';
  const campWater = waypoint?.waterAvailable || '';
  const campFee = waypoint?.fee || '';

  const modal = document.createElement('div');
  modal.id = 'waypoint-editor-modal';
  modal.className = 'waypoint-editor-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-label', isEditing ? 'Edit Waypoint' : 'Add Custom Waypoint');

  modal.innerHTML = `
    <div class="waypoint-editor-backdrop" data-action="close"></div>
    <div class="waypoint-editor-dialog">
      <div class="waypoint-editor-header">
        <h2 class="waypoint-editor-title">${isEditing ? 'Edit Waypoint' : 'Add Custom Waypoint'}</h2>
        <button class="waypoint-editor-close" data-action="close" aria-label="Close dialog">&times;</button>
      </div>

      <form id="waypoint-form" class="waypoint-editor-form">
        <div class="form-group">
          <label class="form-label">Waypoint Type</label>
          <div class="type-chip-group">
            <label class="type-chip ${type === 'water' ? 'type-chip--selected' : ''}">
              <input type="radio" name="wpt-type" value="water" ${type === 'water' ? 'checked' : ''} />
              <span>💧 Water</span>
            </label>
            <label class="type-chip ${type === 'camping' ? 'type-chip--selected' : ''}">
              <input type="radio" name="wpt-type" value="camping" ${type === 'camping' ? 'checked' : ''} />
              <span>⛺ Camp</span>
            </label>
            <label class="type-chip ${type === 'resupply' ? 'type-chip--selected' : ''}">
              <input type="radio" name="wpt-type" value="resupply" ${type === 'resupply' ? 'checked' : ''} />
              <span>🛒 Resupply</span>
            </label>
            <label class="type-chip ${type === 'summit' ? 'type-chip--selected' : ''}">
              <input type="radio" name="wpt-type" value="summit" ${type === 'summit' ? 'checked' : ''} />
              <span>🏔️ Summit</span>
            </label>
            <label class="type-chip ${type === 'navigation' ? 'type-chip--selected' : ''}">
              <input type="radio" name="wpt-type" value="navigation" ${type === 'navigation' ? 'checked' : ''} />
              <span>⚠️ Note / Hazard</span>
            </label>
          </div>
        </div>

        <div class="form-group">
          <label for="wpt-name" class="form-label">Waypoint Name</label>
          <input type="text" id="wpt-name" class="form-input" placeholder="e.g. Stealth Pine Camp, Oak Creek Spring" value="${name}" required />
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="wpt-mile" class="form-label">Along-Track Mile</label>
            <input type="number" step="0.1" id="wpt-mile" class="form-input" value="${mile}" required />
          </div>
          <div class="form-group">
            <label for="wpt-reliability" class="form-label">Reliability / Quality</label>
            <select id="wpt-reliability" class="form-select">
              <option value="reliable" ${reliability === 'reliable' ? 'selected' : ''}>Perennial / Reliable</option>
              <option value="seasonal" ${reliability === 'seasonal' ? 'selected' : ''}>Seasonal / Filter Required</option>
              <option value="emergency" ${reliability === 'emergency' ? 'selected' : ''}>Emergency / Water Cache</option>
            </select>
          </div>
        </div>

        <div id="camp-attributes-group" class="form-row" style="${type === 'camping' ? '' : 'display: none;'}">
          <div class="form-group">
            <label for="wpt-camp-water" class="form-label">Camp Water</label>
            <select id="wpt-camp-water" class="form-select">
              <option value="" ${!campWater ? 'selected' : ''}>Unknown / Not Specified</option>
              <option value="potable" ${campWater === 'potable' ? 'selected' : ''}>💧 Potable Water On-Site</option>
              <option value="natural" ${campWater === 'natural' ? 'selected' : ''}>💧 Natural Stream / Filter</option>
              <option value="none" ${campWater === 'none' ? 'selected' : ''}>🚫 Dry Camp (No Water)</option>
            </select>
          </div>
          <div class="form-group">
            <label for="wpt-camp-fee" class="form-label">Campground Fee</label>
            <input type="text" id="wpt-camp-fee" class="form-input" placeholder="e.g. Free, $27/night" value="${campFee}" />
          </div>
        </div>

        <div class="form-group">
          <label for="wpt-desc" class="form-label">Rider Notes & Memo (Optional)</label>
          <textarea id="wpt-desc" class="form-textarea" rows="2" placeholder="e.g. Hidden spigot behind maintenance barn. Clear cold flow.">${description}</textarea>
        </div>

        <div class="waypoint-editor-actions">
          ${isEditing ? `<button type="button" id="wpt-delete-btn" class="btn-wpt btn-wpt--delete">Delete</button>` : ''}
          <div style="margin-left: auto; display: flex; gap: 8px;">
            <button type="button" class="btn-wpt btn-wpt--cancel" data-action="close">Cancel</button>
            <button type="submit" class="btn-wpt btn-wpt--save">Save Waypoint</button>
          </div>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);

  // Highlight type chip on selection & toggle camp fields
  const chips = modal.querySelectorAll('.type-chip');
  const campGroup = modal.querySelector('#camp-attributes-group');
  for (const chip of chips) {
    chip.addEventListener('change', () => {
      for (const c of chips) c.classList.remove('type-chip--selected');
      chip.classList.add('type-chip--selected');
      const selectedVal = form.querySelector('input[name="wpt-type"]:checked')?.value;
      if (campGroup) {
        campGroup.style.display = selectedVal === 'camping' ? '' : 'none';
      }
    });
  }

  // Close handlers
  for (const el of modal.querySelectorAll('[data-action="close"]')) {
    el.addEventListener('click', closeWaypointEditorModal);
  }

  // Delete handler
  const deleteBtn = modal.querySelector('#wpt-delete-btn');
  if (deleteBtn && onDelete) {
    deleteBtn.addEventListener('click', () => {
      if (confirm(`Delete waypoint "${name || 'this waypoint'}"?`)) {
        closeWaypointEditorModal();
        onDelete(waypoint.id);
      }
    });
  }

  // Form submit handler
  const form = modal.querySelector('#waypoint-form');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const selectedType = form.querySelector('input[name="wpt-type"]:checked')?.value || 'water';
    const wptName = readValue(form, '#wpt-name');
    const wptMile = Number.parseFloat(readValue(form, '#wpt-mile')) || 0;
    const wptReliability = readValue(form, '#wpt-reliability');
    const wptDesc = readValue(form, '#wpt-desc');
    const wptCampWater = form.querySelector('#wpt-camp-water')?.value || null;
    const wptCampFee = form.querySelector('#wpt-camp-fee')?.value.trim() || null;

    let finalLat = lat;
    let finalLon = lon;
    if (
      route?.trackPoints?.length &&
      (!isEditing ||
        (waypoint && Math.abs(waypoint.distanceFromStartMi - wptMile) > 0.05) ||
        (!lat && !lon))
    ) {
      const pt = getCoordinatesAtMile(route.trackPoints, wptMile);
      if (pt) {
        finalLat = pt[0];
        finalLon = pt[1];
      }
    }

    const result = {
      id: waypoint?.id || `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: wptName,
      type: selectedType,
      lat: finalLat,
      lon: finalLon,
      distanceFromStartMi: wptMile,
      description: wptDesc,
      reliability: wptReliability,
      source: 'user',
      ...(selectedType === 'camping'
        ? {
            waterAvailable: wptCampWater,
            waterDetails:
              wptCampWater === 'potable'
                ? 'Potable water available'
                : wptCampWater === 'natural'
                  ? 'Natural water source (filter required)'
                  : wptCampWater === 'none'
                    ? 'No water (dry camp)'
                    : '',
            fee: wptCampFee,
          }
        : {}),
    };

    closeWaypointEditorModal();
    if (onSave) onSave(result);
  });
}

export function closeWaypointEditorModal() {
  const modal = document.getElementById('waypoint-editor-modal');
  if (modal) modal.remove();
}
