import { copyTextToClipboard } from '../checklist.js';
/**
 * ui/segmentDrawer.js — Slide-up Segment Analytics Drawer component.
 *
 * Renders an interactive modal drawer displaying detailed terrain, pacing,
 * Hike-a-Bike, towns passed, key milestones, and logistical tips for any selected segment or route leg.
 *
 * @module ui/segmentDrawer
 */

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
    analytics.difficulty?.hikeABike && analytics.difficulty.hikeABike.distanceMi > 0
      ? `<div class="segment-drawer__alert segment-drawer__alert--warning">
          <strong>⚠️ Hike-a-Bike Alert:</strong> ${analytics.difficulty.hikeABike.distanceMi} mi predicted HAB 
          (${analytics.difficulty.hikeABike.percent}% of segment · ${analytics.difficulty.hikeABike.pitchCount} steep pitches ≥15%)
         </div>`
      : `<div class="segment-drawer__alert segment-drawer__alert--success">
          <strong>🟢 Minimal Hike-a-Bike:</strong> No sustained steep pitches (≥15%) detected on this segment.
         </div>`;

  const narrative = analytics.narrative || {};
  const towns = narrative.townsAndServices || [];
  const milestones = narrative.milestones || [];
  const tips = narrative.tips || [];

  // Towns & Services HTML
  const townsHTML =
    towns.length > 0
      ? `
    <div style="margin-top: 14px;">
      <h4 style="margin: 0 0 8px 0; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.85;">
        🏙️ Towns & Resupply Hubs Passed (${towns.length})
      </h4>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        ${towns
          .map(
            (t) => `
          <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--md-sys-color-outline-variant); border-radius: 6px; padding: 8px 10px; font-size: 11px; display: flex; justify-content: space-between; align-items: center; gap: 8px;">
            <div>
              <div style="font-weight: 600; font-size: 12px; display: flex; align-items: center; gap: 6px;">
                <span>🛒 ${t.name}</span>
                <span style="font-size: 10px; opacity: 0.75; font-weight: 400;">@ Mile ${t.mile.toFixed(1)}${t.detourText}</span>
              </div>
              <div style="font-size: 10.5px; opacity: 0.8; margin-top: 2px;">${t.description}</div>
            </div>
            <span style="font-size: 10px; background: var(--md-sys-color-primary-container, #00522a); color: var(--md-sys-color-on-primary-container, #9af0ae); padding: 2px 6px; border-radius: 4px; font-weight: 700; white-space: nowrap;">
              ${t.type}
            </span>
          </div>`,
          )
          .join('')}
      </div>
    </div>`
      : '';

  // Chronological Milestones HTML
  const milestonesHTML =
    milestones.length > 0
      ? `
    <div style="margin-top: 16px;">
      <h4 style="margin: 0 0 8px 0; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.85;">
        📍 Key Trail Milestones & Waypoints (${milestones.length})
      </h4>
      <div style="display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow-y: auto; padding-right: 4px;">
        ${milestones
          .map(
            (m) => `
          <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--md-sys-color-outline-variant); border-radius: 6px; padding: 6px 10px; font-size: 11px; display: flex; justify-content: space-between; align-items: center; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 14px;">${m.icon}</span>
              <div>
                <div style="font-weight: 600;">${m.name}</div>
                <div style="font-size: 10px; opacity: 0.75;">${m.detail || m.category}</div>
              </div>
            </div>
            <span style="font-size: 11px; font-weight: 700; opacity: 0.9; white-space: nowrap; font-variant-numeric: tabular-nums;">
              mi ${m.mile.toFixed(1)}
            </span>
          </div>`,
          )
          .join('')}
      </div>
    </div>`
      : '';

  // Trail Tips & Watchouts HTML
  const tipsHTML =
    tips.length > 0
      ? `
    <div style="margin-top: 16px;">
      <h4 style="margin: 0 0 8px 0; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.85;">
        💡 Field Tips & What to Look Out For
      </h4>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        ${tips
          .map(
            (tip) => `
          <div style="
            background: ${
              tip.severity === 'warning'
                ? 'rgba(244, 180, 0, 0.12)'
                : tip.severity === 'tip'
                  ? 'rgba(41, 182, 246, 0.1)'
                  : 'rgba(255,255,255,0.03)'
            };
            border: 1px solid ${
              tip.severity === 'warning'
                ? 'rgba(244, 180, 0, 0.35)'
                : tip.severity === 'tip'
                  ? 'rgba(41, 182, 246, 0.35)'
                  : 'var(--md-sys-color-outline-variant)'
            };
            border-radius: 8px;
            padding: 8px 12px;
            font-size: 11.5px;
            line-height: 1.4;
          ">
            <div style="font-weight: 700; margin-bottom: 2px; display: flex; align-items: center; gap: 6px; color: ${
              tip.severity === 'warning'
                ? '#ffd54f'
                : tip.severity === 'tip'
                  ? '#81d4fa'
                  : 'inherit'
            };">
              <span>${tip.icon}</span>
              <span>${tip.title}</span>
            </div>
            <div style="opacity: 0.9;">${tip.text}</div>
          </div>`,
          )
          .join('')}
      </div>
    </div>`
      : '';

  // Comprehensive Markdown Summary for Clipboard
  const townLines =
    towns.length > 0
      ? `\n### 🏙️ Towns & Services Passed\n${towns
          .map(
            (t) =>
              `- **${t.name}** (Mile ${t.mile.toFixed(1)}${t.detourText}): ${t.description}`,
          )
          .join('\n')}`
      : '';

  const milestoneLines =
    milestones.length > 0
      ? `\n### 📍 Key Milestones\n${milestones
          .map(
            (m) =>
              `- Mile ${m.mile.toFixed(1)}: ${m.icon} ${m.name} (${m.detail || m.category})`,
          )
          .join('\n')}`
      : '';

  const tipLines =
    tips.length > 0
      ? `\n### 💡 Trail Tips & Watchouts\n${tips
          .map((t) => `- **${t.icon} ${t.title}**: ${t.text}`)
          .join('\n')}`
      : '';

  const summaryMarkdown = `# Segment Analytics & Narrative (Mile ${Number(analytics.startMi).toFixed(1)} → ${Number(analytics.endMi).toFixed(1)})

${narrative.summaryParagraph || ''}

### 📊 Key Metrics
• Distance: ${Number(analytics.distanceMi).toFixed(1)} mi (+${analytics.gainFt.toLocaleString()} ft / -${analytics.lossFt.toLocaleString()} ft, ${analytics.hillinessFtPerMi} ft/mi)
• Difficulty: ${analytics.difficulty?.difficultyRating.label || 'Moderate'} (Score: ${analytics.difficulty?.difficultyScore})
• Hike-a-Bike: ${analytics.difficulty?.hikeABike.distanceMi || 0} mi (${analytics.difficulty?.hikeABike.pitchCount || 0} steep pitches ≥15%)
• Est. Moving Time: ${analytics.pacing.formattedMovingTime} (Total Elapsed: ${analytics.pacing.formattedElapsedTime})
• Water Required: ${analytics.logistics.waterNeededOz} oz (${analytics.logistics.waterNeededLiters} L)
• Food Required: ${analytics.logistics.caloriesNeededKcal.toLocaleString()} kcal (${analytics.logistics.campMealsNeeded} camp meals)
${townLines}
${milestoneLines}
${tipLines}`;

  container.innerHTML = `
    <div class="segment-drawer__backdrop" data-action="close-drawer"></div>
    <div class="segment-drawer__content">
      <div class="segment-drawer__header">
        <div>
          <h3 class="segment-drawer__title">Mile ${Number(analytics.startMi).toFixed(1)} to Mile ${Number(analytics.endMi).toFixed(1)} Segment</h3>
          <div style="display: flex; gap: 8px; align-items: center; margin-top: 4px;">
            <span style="font-size: 13px; font-weight: 600;">${Number(analytics.distanceMi).toFixed(1)} mi</span>
            ${diffBadge}
          </div>
        </div>
        <button class="segment-drawer__close" data-action="close-drawer" aria-label="Close drawer">&times;</button>
      </div>

      <div class="segment-drawer__body">
        ${
          narrative.summaryParagraph
            ? `<div style="margin-top: 12px; background: rgba(255,255,255,0.03); border: 1px solid var(--md-sys-color-outline-variant); border-radius: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.5; color: var(--md-sys-color-on-surface);">
                 <strong>📖 Route Overview:</strong> ${narrative.summaryParagraph}
               </div>`
            : ''
        }

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

        ${townsHTML}
        ${milestonesHTML}
        ${tipsHTML}

        <div class="segment-drawer__actions" style="display: flex; gap: 8px; margin-top: 20px; flex-wrap: wrap;">
          <button class="segment-btn segment-btn--primary" id="btn-segment-copy" style="flex: 1;">
            📋 Copy Segment Narrative
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
  for (const btn of container.querySelectorAll('[data-action="close-drawer"]')) {
    btn.addEventListener('click', closeSegmentDrawer);
  }

  const copyBtn = container.querySelector('#btn-segment-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      await copyTextToClipboard(summaryMarkdown);
      copyBtn.textContent = '✅ Copied Narrative!';
      setTimeout(() => {
        if (copyBtn) copyBtn.textContent = '📋 Copy Segment Narrative';
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
