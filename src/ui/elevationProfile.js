/**
 * elevationProfile.js — Interactive Elevation Profile & Climbing Analytics.
 */

import { computeElevationProfileSamples } from '../gpx.js';

/**
 * Renders the interactive elevation profile SVG bar.
 * @param {HTMLElement} container - The container element to attach the profile
 * @param {import('../gpx.js').RouteContext} route
 * @param {(sample: object|null) => void} [onHover] - Callback when hovering a point on the chart
 */
export function renderElevationProfile(container, route, onHover = null) {
  if (!container || !route || !route.trackPoints || route.trackPoints.length < 2) {
    if (container) container.innerHTML = '';
    return;
  }

  const samples = computeElevationProfileSamples(route, 180);
  if (!samples.length) return;

  const minEle = Math.min(...samples.map((s) => s.elevationFt));
  const maxEle = Math.max(...samples.map((s) => s.elevationFt));
  const eleRange = Math.max(100, maxEle - minEle);
  const totalMi = samples[samples.length - 1].distanceMi;

  const width = 600;
  const height = 120;
  const padding = { top: 16, bottom: 24, left: 40, right: 16 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const getX = (mi) => padding.left + (mi / totalMi) * chartW;
  const getY = (ele) => padding.top + chartH - ((ele - minEle) / eleRange) * chartH;

  // Build SVG path segments color-coded by grade steepness
  let pathSegments = '';
  for (let i = 1; i < samples.length; i++) {
    const p1 = samples[i - 1];
    const p2 = samples[i];
    const x1 = getX(p1.distanceMi);
    const y1 = getY(p1.elevationFt);
    const x2 = getX(p2.distanceMi);
    const y2 = getY(p2.elevationFt);

    pathSegments += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${p2.gradeColor}" stroke-width="2.5" />`;
  }

  // Summit pass markers
  const summitMarkers = samples
    .filter((s) => s.isSummit)
    .map((s) => {
      const cx = getX(s.distanceMi);
      const cy = getY(s.elevationFt);
      return `<g transform="translate(${cx.toFixed(1)}, ${cy.toFixed(1)})" style="cursor: pointer;">
        <circle r="4" fill="#f44336" stroke="#ffffff" stroke-width="1.5" />
        <text y="-8" font-size="9" font-weight="700" fill="var(--md-sys-color-on-surface)" text-anchor="middle">🏔️ ${s.elevationFt}ft</text>
      </g>`;
    })
    .join('');

  container.innerHTML = `
    <div class="elevation-profile-card" style="
      background: var(--md-sys-color-surface-container, #1a1c1e);
      border-top: 1px solid var(--md-sys-color-outline-variant, #46444a);
      padding: 8px 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-family: inherit;
    ">
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; font-weight: 600; color: var(--md-sys-color-on-surface-variant);">
        <span>🏔️ ELEVATION PROFILE & GRADIENT HEATMAP</span>
        <div style="display: flex; gap: 12px; font-size: 10px;">
          <span>🟢 &lt;5% Grade</span>
          <span>🟡 5-9% Moderate</span>
          <span>🔴 &gt;10% Steep</span>
        </div>
      </div>
      <div style="position: relative; width: 100%;">
        <svg viewBox="0 0 ${width} ${height}" style="width: 100%; height: 110px; display: block; overflow: visible;">
          <!-- Grid lines -->
          <line x1="${padding.left}" y1="${padding.top}" x2="${width - padding.right}" y2="${padding.top}" stroke="var(--md-sys-color-outline-variant)" stroke-dasharray="2 2" stroke-opacity="0.5" />
          <line x1="${padding.left}" y1="${padding.top + chartH / 2}" x2="${width - padding.right}" y2="${padding.top + chartH / 2}" stroke="var(--md-sys-color-outline-variant)" stroke-dasharray="2 2" stroke-opacity="0.5" />
          <line x1="${padding.left}" y1="${padding.top + chartH}" x2="${width - padding.right}" y2="${padding.top + chartH}" stroke="var(--md-sys-color-outline-variant)" stroke-opacity="0.8" />
          
          <!-- Axis labels -->
          <text x="${padding.left - 6}" y="${padding.top + 4}" font-size="9" fill="var(--md-sys-color-on-surface-variant)" text-anchor="end">${maxEle}ft</text>
          <text x="${padding.left - 6}" y="${padding.top + chartH + 3}" font-size="9" fill="var(--md-sys-color-on-surface-variant)" text-anchor="end">${minEle}ft</text>
          <text x="${padding.left}" y="${height - 4}" font-size="9" fill="var(--md-sys-color-on-surface-variant)">0 mi</text>
          <text x="${width - padding.right}" y="${height - 4}" font-size="9" fill="var(--md-sys-color-on-surface-variant)" text-anchor="end">${totalMi.toFixed(0)} mi</text>
          
          <!-- Profile lines -->
          ${pathSegments}
          ${summitMarkers}
          
          <!-- Hover cursor line -->
          <line id="profile-hover-line" x1="0" y1="${padding.top}" x2="0" y2="${padding.top + chartH}" stroke="var(--md-sys-color-primary, #9af0ae)" stroke-width="1.5" stroke-dasharray="3 3" style="display: none;" />
        </svg>
        <div id="profile-tooltip" style="
          position: absolute;
          display: none;
          top: 4px;
          background: rgba(0,0,0,0.85);
          color: #ffffff;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 600;
          pointer-events: none;
          white-space: nowrap;
          z-index: 10;
        "></div>
      </div>
    </div>
  `;

  // Attach hover interactions
  const svg = container.querySelector('svg');
  const hoverLine = container.querySelector('#profile-hover-line');
  const tooltip = container.querySelector('#profile-tooltip');

  if (svg && hoverLine && tooltip) {
    svg.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const svgX = (mouseX / rect.width) * width;

      if (svgX >= padding.left && svgX <= width - padding.right) {
        const ratio = (svgX - padding.left) / chartW;
        const targetMi = ratio * totalMi;

        // Find closest sample
        let closest = samples[0];
        let minDist = Infinity;
        for (const s of samples) {
          const d = Math.abs(s.distanceMi - targetMi);
          if (d < minDist) {
            minDist = d;
            closest = s;
          }
        }

        const cx = getX(closest.distanceMi);
        hoverLine.setAttribute('x1', cx);
        hoverLine.setAttribute('x2', cx);
        hoverLine.style.display = 'block';

        tooltip.style.display = 'block';
        tooltip.style.left = `${Math.min(rect.width - 110, Math.max(10, (cx / width) * rect.width - 40))}px`;
        tooltip.innerHTML = `📍 ${closest.distanceMi} mi | 🏔️ ${closest.elevationFt} ft | 📈 ${closest.gradePercent}%`;

        if (onHover) onHover(closest);
      }
    });

    svg.addEventListener('mouseleave', () => {
      hoverLine.style.display = 'none';
      tooltip.style.display = 'none';
      if (onHover) onHover(null);
    });

    svg.addEventListener('click', (e) => {
      const rect = svg.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const svgX = (mouseX / rect.width) * width;

      if (svgX >= padding.left && svgX <= width - padding.right) {
        const ratio = (svgX - padding.left) / chartW;
        const targetMi = ratio * totalMi;

        let closest = samples[0];
        let minDist = Infinity;
        for (const s of samples) {
          const d = Math.abs(s.distanceMi - targetMi);
          if (d < minDist) {
            minDist = d;
            closest = s;
          }
        }

        window.dispatchEvent(
          new CustomEvent('bpnav-profile-click', {
            detail: { sample: closest, mile: closest.distanceMi, elevationFt: closest.elevationFt },
          }),
        );
        // click dispatched via bpnav-profile-click
      }
    });
  }
}

/**
 * Highlights a segment range on the rendered elevation profile SVG.
 * @param {HTMLElement} container
 * @param {import('../gpx.js').RouteContext} route
 * @param {number} startMi
 * @param {number} endMi
 */
export function highlightProfileSegment(container, route, startMi, endMi) {
  if (!container || !route) return;
  const svg = container.querySelector('svg');
  if (!svg) return;

  // Remove existing highlight box
  const oldBox = svg.querySelector('#profile-segment-box');
  if (oldBox) oldBox.remove();

  const totalMi = route.totalDistanceMiles || 1;
  const width = 600;
  const height = 120;
  const padding = { top: 16, bottom: 24, left: 40, right: 16 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const sMi = Math.max(0, Math.min(startMi, totalMi));
  const eMi = Math.max(sMi, Math.min(endMi, totalMi));

  const x1 = padding.left + (sMi / totalMi) * chartW;
  const x2 = padding.left + (eMi / totalMi) * chartW;
  const rectW = Math.max(2, x2 - x1);

  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('id', 'profile-segment-box');
  rect.setAttribute('x', x1.toFixed(1));
  rect.setAttribute('y', padding.top);
  rect.setAttribute('width', rectW.toFixed(1));
  rect.setAttribute('height', chartH);
  rect.setAttribute('fill', 'rgba(255, 213, 79, 0.25)');
  rect.setAttribute('stroke', '#ffd54f');
  rect.setAttribute('stroke-width', '1.5');
  rect.setAttribute('stroke-dasharray', '3 3');

  svg.insertBefore(rect, svg.firstChild);
}
