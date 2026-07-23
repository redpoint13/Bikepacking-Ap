/**
 * ui/segmentDrawer.js — Slide-up Segment Analytics Drawer component.
 *
 * Renders an interactive modal drawer displaying detailed terrain, pacing,
 * Hike-a-Bike, and logistical metrics for any selected segment or route leg.
 *
 * @module ui/segmentDrawer
 */

import { formatDuration } from '../analytics.js';

let activeDrawerEl = null;

/**
 * Renders and opens the Segment Analytics Drawer for a given segment analytics object.
 *
 * @param {Object} analytics - Output from computeSegmentAnalytics
 * @param {Object} [callbacks={}] - Optional event callbacks (e.g. onHighlightMap)
 */
export function openSegmentDrawer(analytics, callbacks = {}) {
  if (!analytics) return;

  // Remove existing drawer if open
  closeSegmentDrawer();

  const container = document.createElement('div');
  container.id = 'segment-analytics-drawer';
  container.className = 'segment-drawer segment-drawer--open';
  container.setAttribute('role', 'dialog');
  container.setAttribute('aria-label', 'Segment Analytics');

  const diffBadge = analytics.difficulty
    ? `<span class="difficulty-chip difficulty-chip--${analytics.difficulty.difficultyRating.cls}" style="font-weight: 700; padding: 2px 8px; border-radius: 4px; font-size: 11px;">${analytics.difficulty.difficultyRating.badge} (Score: ${analytics.difficulty.difficultyScore})</span>`
    : '';

  const habSection =
    analytics.difficulty && analytics.difficulty.hikeABike && analytics.difficulty.hikeABike.distanceMi > 0
      ? `<div class="segment-drawer__alert segment-drawer__alert--warning">
          <strong>⚠️ Hike-a-Bike Alert:</strong> ${analytics.difficulty.hikeABike.distanceMi} mi predicted HAB 
          (${analytics.difficulty.hikeABike.percent}% of segment · ${analytics.difficulty.hikeABike.pitchCount} steep pitches ≥15%)
         </div>`
      : `<div class="segment-drawer__alert segment-drawer__alert--success">
          <strong>🟢 Minimal Hike-a-Bike:</strong> No sustained steep pitches (≥15%) detected on this segment.
         </div>`;

  const waterCount = analytics.waypoints.waterSources.length;
  const foodCount = analytics.waypoints.resupplyPoints.length;
  const campCount = analytics.waypoints.campSpots.length;

  const summaryMarkdown = `Segment Analytics (Mile ${analytics.startMi} -> ${analytics.endMi}):
• Distance: ${analytics.distanceMi} mi (+${analytics.gainFt.toLocaleString()} ft / -${analytics.lossFt.toLocaleString()} ft, ${analytics.hillinessFtPerMi} ft/mi)
• Difficulty: ${analytics.difficulty?.difficultyRating.label || 'Moderate'} (Score: ${analytics.difficulty?.difficultyScore})
• Hike-a-Bike: ${analytics.difficulty?.hikeABike.distanceMi || 0} mi
• Est. Moving Time: ${analytics.pacing.formattedMovingTime} (Elapsed: ${analytics.pacing.formattedElapsedTime})
• Water Required: ${analytics.logistics.waterNeededOz} oz (${analytics.logistics.waterNeededLiters} L)
• Food Required: ${analytics.logistics.caloriesNeededKcal} kcal (${analytics.logistics.campMealsNeeded} camp meals)`;

  container.innerHTML = `
    <div class="segment-drawer__backdrop" data-action="close-drawer"></div>
    <div class="segment-drawer__content">
      <div class="segment-drawer__header">
        <div>
          <h3 class="segment-drawer__title">Mile ${analytics.startMi} to Mile ${analytics.endMi} Segment</h3>
          <div style="display: flex; gap: 8px; align-items: center; margin-top: 4px;">
            <span style="font-size: 13px; font-weight: 600;">${analytics.distanceMi} mi</span>
            ${diffBadge}
          </div>
        </div>
        <button class="segment-drawer__close" data-action="close-drawer" aria-label="Close drawer">&times;</button>
      </div>

      <div class="segment-drawer__body">
        ${habSection}

        <div class="segment-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-top: 12px;">
          <div class="segment-metric-card">
            <span class="segment-metric-card__label">Elevation</span>
            <span class="segment-metric-card__value">📈 +${analytics.gainFt.toLocaleString()} ft</span>
            <span class="segment-metric-card__sub">📉 -${analytics.lossFt.toLocaleString()} ft (${analytics.hillinessFtPerMi} ft/mi)</span>
          </div>

          <div class="segment-metric-card">
            <span class="segment-metric-card__label">Est. Moving Time</span>
            <span class="segment-metric-card__value">⏱️ ${analytics.pacing.formattedMovingTime}</span>
            <span class="segment-metric-card__sub">Total Elapsed: ${analytics.pacing.formattedElapsedTime}</span>
          </div>

          <div class="segment-metric-card">
            <span class="segment-metric-card__label">Water Required</span>
            <span class="segment-metric-card__value">💧 ${analytics.logistics.waterNeededOz} oz</span>
            <span class="segment-metric-card__sub">~${analytics.logistics.waterNeededLiters} Liters</span>
          </div>

          <div class="segment-metric-card">
            <span class="segment-metric-card__label">Food Required</span>
            <span class="segment-metric-card__value">🛒 ${analytics.logistics.caloriesNeededKcal.toLocaleString()} kcal</span>
            <span class="segment-metric-card__sub">~${analytics.logistics.campMealsNeeded} camp meals</span>
          </div>
        </div>

        <div style="margin-top: 16px; background: rgba(255,255,255,0.02); padding: 10px; border-radius: 8px; border: 1px solid var(--md-sys-color-outline-variant);">
          <h4 style="margin: 0 0 6px 0; font-size: 12px; opacity: 0.9;">Waypoint Inventory (${analytics.waypoints.all.length} total)</h4>
          <div style="display: flex; gap: 12px; font-size: 11px; flex-wrap: wrap;">
            <span>💧 <strong>${waterCount}</strong> water sources</span>
            <span>🛒 <strong>${foodCount}</strong> resupply stops</span>
            <span>⛺ <strong>${campCount}</strong> camp spots</span>
          </div>
        </div>

        <div class="segment-drawer__actions" style="display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap;">
          <button class="segment-btn segment-btn--primary" id="btn-segment-copy" style="flex: 1;">
            📋 Copy Segment Summary
          </button>
          <button class="segment-btn segment-btn--secondary" id="btn-segment-highlight" style="flex: 1;">
            🔍 Highlight on Map
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(container);
  activeDrawerEl = container;

  // Event handlers
  container.querySelectorAll('[data-action="close-drawer"]').forEach((btn) => {
    btn.addEventListener('click', closeSegmentDrawer);
  });

  const copyBtn = container.querySelector('#btn-segment-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(summaryMarkdown);
      copyBtn.textContent = '✅ Copied!';
      setTimeout(() => {
        if (copyBtn) copyBtn.textContent = '📋 Copy Segment Summary';
      }, 2000);
    });
  }

  const highlightBtn = container.querySelector('#btn-segment-highlight');
  if (highlightBtn) {
    highlightBtn.addEventListener('click', () => {
      if (callbacks.onHighlightMap) {
        callbacks.onHighlightMap(analytics.startMi, analytics.endMi);
      }
      closeSegmentDrawer();
    });
  }
}

/** Closes the Segment Analytics Drawer if open. */
export function closeSegmentDrawer() {
  if (activeDrawerEl) {
    activeDrawerEl.remove();
    activeDrawerEl = null;
  }
}
