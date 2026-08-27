import { generateStartChecklist, generateStopChecklists } from './checklist.js';
import { getCoordinatesAtMile } from './gpx.js';
import { buildPlan, getActiveStopIds, getWaypointsWithSyntheticCamps } from './plan.js';

/**
 * Generates a new GPX string containing the original track plus all active waypoints.
 * @param {string} originalGpxText
 * @param {import('./gpx.js').RouteContext} route
 * @param {object} planOptions
 * @returns {string} The new GPX XML string
 */
export function generateGPX(originalGpxText, route, planOptions) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(originalGpxText, 'application/xml');
  const gpxNode = doc.querySelector('gpx');

  if (!gpxNode) {
    throw new Error('Invalid GPX document');
  }

  // Remove existing <wpt> elements so we don't duplicate them
  const existingWpts = doc.querySelectorAll('wpt');
  for (const node of existingWpts) node.remove();

  // Get actual waypoints (excluding synthetic/imaginary placeholders)
  const allWaypoints = (route.waypoints || []).filter(
    (w) => !w.id?.startsWith('synth-') && !w.isSynthetic && !w.name?.includes('Dispersed Camp ('),
  );
  const activeStopIds = getActiveStopIds(route, planOptions);

  const activeWaypoints = allWaypoints.filter(
    (wp) => activeStopIds.has(wp.id) || wp.source === 'user',
  );

  // Append new <wpt> elements
  for (const wp of activeWaypoints) {
    const wptNode = doc.createElement('wpt');
    wptNode.setAttribute('lat', wp.lat.toString());
    wptNode.setAttribute('lon', wp.lon.toString());

    const nameNode = doc.createElement('name');
    nameNode.textContent = wp.name;
    wptNode.appendChild(nameNode);

    // `description`, not `desc`. Nothing has ever set `desc`, so every exported
    // GPX silently dropped its waypoint notes — reliability, seasonal flow,
    // camp details — which is most of what makes an export worth having.
    if (wp.description) {
      const descNode = doc.createElement('desc');
      descNode.textContent = wp.description;
      wptNode.appendChild(descNode);
    }

    const typeNode = doc.createElement('type');
    typeNode.textContent = wp.type;
    wptNode.appendChild(typeNode);

    // Insert before the first <trk> or <rte> to be safe, or just append
    const firstTrk = doc.querySelector('trk, rte');
    if (firstTrk) {
      gpxNode.insertBefore(wptNode, firstTrk);
    } else {
      gpxNode.appendChild(wptNode);
    }

    // Generate a spur trail for off-route points
    if ((wp.offCourseDistanceMi || 0) > 0.05) {
      const nearest = getCoordinatesAtMile(route.trackPoints, wp.distanceFromStartMi);
      if (nearest) {
        const trkNode = doc.createElement('trk');
        const spurNameNode = doc.createElement('name');
        spurNameNode.textContent = `Spur to ${wp.name || 'POI'}`;
        trkNode.appendChild(spurNameNode);

        const trksegNode = doc.createElement('trkseg');

        const pt1 = doc.createElement('trkpt');
        pt1.setAttribute('lat', nearest[0].toString());
        pt1.setAttribute('lon', nearest[1].toString());
        trksegNode.appendChild(pt1);

        const pt2 = doc.createElement('trkpt');
        pt2.setAttribute('lat', wp.lat.toString());
        pt2.setAttribute('lon', wp.lon.toString());
        trksegNode.appendChild(pt2);

        trkNode.appendChild(trksegNode);
        // Append spur tracks at the very end of the GPX document
        gpxNode.appendChild(trkNode);
      }
    }
  }

  const serializer = new XMLSerializer();
  return serializer.serializeToString(doc);
}

/**
 * Initiates the Web Share API if available, or falls back to standard download.
 * @param {string} filename
 * @param {string} gpxString
 */
export async function sharePlan(filename, gpxString) {
  const file = new File([gpxString], filename, { type: 'application/gpx+xml' });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        title: 'Bikepacking Route Plan',
        text: 'Here is my customized bikepacking route with planned camps and water stops.',
        files: [file],
      });
      return; // Share succeeded
    } catch (err) {
      console.warn('Web Share API failed or cancelled:', err);
      if (err.name !== 'AbortError') {
        downloadFile(filename, gpxString);
      }
    }
  } else {
    downloadFile(filename, gpxString);
  }
}

/**
 * Triggers a standard browser file download.
 * @param {string} filename
 * @param {string} content
 */
function downloadFile(filename, content) {
  const blob = new Blob([content], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Generates a clean, mobile-phone and print-optimized HTML document for the route itinerary.
 * @param {import('./gpx.js').RouteContext} route
 * @param {object} planOptions
 * @returns {string} HTML string
 */
export function generatePrintableItineraryHTML(route, planOptions) {
  const plan = buildPlan(route, planOptions);
  const dayPlan = plan.dayPlan || [];
  const _waterCarry = plan.waterCarry || [];
  const foodCarry = plan.foodCarry || [];

  const startChecklist = generateStartChecklist(route, plan);
  const stopChecklists = generateStopChecklists(route, plan);

  const waterWpts = route.waypoints
    .filter((w) => w.type === 'water')
    .sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

  // Day cards HTML
  const daysCardsHTML = dayPlan
    .map((d) => {
      const c = d.chosen;
      const endMi = c?.endMi != null ? c.endMi.toFixed(1) : '—';
      const gain = c?.eleGainFt ? `+${c.eleGainFt.toLocaleString()} ft` : '';
      const loss = c?.eleLossFt ? `-${c.eleLossFt.toLocaleString()} ft` : '';
      const eleStr = gain || loss ? `${gain} / ${loss}` : '';

      const waterStatus =
        c?.waterAvailable === 'potable'
          ? '💧 Potable Water'
          : c?.waterAvailable === 'natural'
            ? '💧 Stream (Filter)'
            : c?.waterAvailable === 'none'
              ? '🚫 Dry Camp'
              : '';

      const feeStatus = c?.fee ? (c.fee.toLowerCase() === 'free' ? '🆓 Free' : `💲 ${c.fee}`) : '';

      return `
      <div class="trail-card">
        <div class="trail-card__head">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="badge badge--camp">Day ${d.day}</span>
            <span class="trail-card__title">${c?.campName || c?.name || 'Camp Spot'}</span>
          </div>
          <span class="trail-card__mile">Mile ${d.startMi.toFixed(1)} → ${endMi} (${c?.miles ? `${c.miles.toFixed(1)} mi` : ''})</span>
        </div>
        <div class="amenities-row">
          ${c?.landManager ? `<span style="opacity: 0.85;">🏛️ ${c.landManager}</span>` : ''}
          ${eleStr ? `<span>📈 ${eleStr}</span>` : ''}
          ${waterStatus ? `<span style="font-weight: 600; color: #2e7d32;">${waterStatus}</span>` : ''}
          ${feeStatus ? `<span class="badge badge--fee">${feeStatus}</span>` : ''}
          ${c?.sunsetTime ? `<span>🌅 Sunset: ${c.sunsetTime}</span>` : ''}
        </div>
      </div>`;
    })
    .join('');

  // Water Sources HTML
  const waterCardsHTML = waterWpts
    .map((w) => {
      const waterStatus =
        w.waterAvailable === 'potable'
          ? '💧 Potable'
          : w.waterAvailable === 'natural'
            ? '💧 Natural Stream / Filter'
            : w.waterAvailable === 'none'
              ? '🚫 Dry'
              : '💧 Water Source';

      return `
      <div class="trail-card">
        <div class="trail-card__head">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="badge badge--water">Mile ${w.distanceFromStartMi.toFixed(1)}</span>
            <span class="trail-card__title">${w.name}</span>
          </div>
          <span style="font-size: 11px; font-weight: 600; color: #0277bd;">Reliability: ${w.reliability ?? 50}%</span>
        </div>
        <div class="amenities-row">
          <span>${waterStatus}</span>
          ${w.seasonalStatus ? `<span style="opacity: 0.85;">· ${w.seasonalStatus}</span>` : ''}
          ${w.waterDetails ? `<span style="opacity: 0.85;">· ${w.waterDetails}</span>` : ''}
        </div>
        ${w.description ? `<p style="margin: 4px 0 0 0; font-size: 11px; color: #555;">${w.description}</p>` : ''}
      </div>`;
    })
    .join('');

  // Food Resupply HTML
  const foodCardsHTML = foodCarry
    .map(
      (f) => `
      <div class="trail-card">
        <div class="trail-card__head">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="badge badge--food">Mile ${f.fromMi.toFixed(1)} → ${f.toMi.toFixed(1)}</span>
            <span class="trail-card__title">${f.fromName} → ${f.toName}</span>
          </div>
          <span class="trail-card__mile">${f.miles.toFixed(1)} mi (${f.days.toFixed(1)} days)</span>
        </div>
        <div class="amenities-row">
          <span>🍲 <strong>${f.campMeals}</strong> camp meals</span>
          <span>🍫 <strong>${f.snacks}</strong> trail snacks</span>
          <span>⚡ ~${(f.calories || 0).toLocaleString()} kcal (${f.weightOz} oz)</span>
        </div>
      </div>`,
    )
    .join('');

  // Checklists HTML
  const departureItemsHTML = startChecklist
    .map(
      (cat) => `
      <div style="margin-bottom: 8px;">
        <span style="font-size: 12px; font-weight: 700; color: #006c4c;">${cat.title}</span>
        <ul class="checklist-list">
          ${cat.items.map((i) => `<li><span class="checkbox-box"></span> <div><strong>${i.label}</strong>${i.detail ? `<br><span style="font-size: 10px; color: #666;">${i.detail}</span>` : ''}</div></li>`).join('')}
        </ul>
      </div>`,
    )
    .join('');

  const stopChecklistsHTML = stopChecklists
    .map(
      (s) => `
      <div class="trail-card">
        <div class="trail-card__head">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="badge ${s.type === 'water' ? 'badge--water' : s.type === 'resupply' ? 'badge--food' : 'badge--camp'}">${s.badge}</span>
            <span class="trail-card__title">${s.name}</span>
          </div>
          <span class="trail-card__mile">Mile ${s.mile.toFixed(1)}</span>
        </div>
        <ul class="checklist-list">
          ${s.items.map((i) => `<li><span class="checkbox-box"></span> <div><strong>${i.label}</strong>${i.detail ? `<br><span style="font-size: 10px; color: #666;">${i.detail}</span>` : ''}</div></li>`).join('')}
        </ul>
      </div>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0" />
    <title>${route.name || 'Bikepacking Itinerary'} — Mobile PDF Itinerary</title>
    <style>
      :root {
        --primary: #006c4c;
        --surface: #ffffff;
        --surface-alt: #f8f9fa;
        --text: #1a1a1a;
        --text-muted: #555555;
        --border: #e0e0e0;
        --water-bg: #e1f5fe;
        --water-text: #0277bd;
        --food-bg: #fff3e0;
        --food-text: #e65100;
        --camp-bg: #e8f5e9;
        --camp-text: #2e7d32;
      }
      * { box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        line-height: 1.45;
        color: var(--text);
        background: var(--surface);
        padding: 16px;
        margin: 0 auto;
        max-width: 800px;
        font-size: 14px;
        -webkit-font-smoothing: antialiased;
      }
      .itinerary-header {
        border-bottom: 2px solid var(--primary);
        padding-bottom: 12px;
        margin-bottom: 16px;
      }
      .title { font-size: 22px; font-weight: 800; margin: 0 0 4px 0; color: #111; }
      .meta-line { font-size: 12px; color: var(--text-muted); margin: 0; }
      
      .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
        gap: 8px;
        margin: 12px 0 20px 0;
      }
      .stat-card {
        background: var(--surface-alt);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 8px 10px;
        text-align: center;
      }
      .stat-card__val { font-size: 16px; font-weight: 700; color: #111; display: block; }
      .stat-card__lbl { font-size: 10px; text-transform: uppercase; color: var(--text-muted); font-weight: 600; }

      .section-title {
        font-size: 16px;
        font-weight: 700;
        margin: 24px 0 10px 0;
        display: flex;
        align-items: center;
        gap: 6px;
        border-bottom: 1px solid var(--border);
        padding-bottom: 4px;
      }

      .trail-card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 10px;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      .trail-card__head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 6px;
        flex-wrap: wrap;
        gap: 4px;
      }
      .trail-card__title { font-size: 14px; font-weight: 700; margin: 0; }
      .trail-card__mile { font-size: 12px; font-weight: 600; color: var(--text-muted); }
      .badge {
        display: inline-block;
        font-size: 10px;
        font-weight: 700;
        padding: 2px 6px;
        border-radius: 4px;
        text-transform: uppercase;
      }
      .badge--water { background: var(--water-bg); color: var(--water-text); }
      .badge--food { background: var(--food-bg); color: var(--food-text); }
      .badge--camp { background: var(--camp-bg); color: var(--camp-text); }
      .badge--fee { background: #f3e5f5; color: #7b1fa2; }

      .amenities-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin: 4px 0 0 0;
        font-size: 11px;
      }

      .checklist-list {
        list-style: none;
        padding: 0;
        margin: 6px 0 0 0;
      }
      .checklist-list li {
        font-size: 12px;
        padding: 4px 0;
        border-bottom: 1px dashed #eee;
        display: flex;
        align-items: flex-start;
        gap: 6px;
      }
      .checklist-list li:last-child { border-bottom: none; }
      .checkbox-box {
        display: inline-block;
        width: 13px;
        height: 13px;
        border: 1.5px solid #666;
        border-radius: 2px;
        margin-top: 2px;
        flex-shrink: 0;
      }

      .screen-actions {
        display: flex;
        gap: 10px;
        margin-bottom: 16px;
      }
      .btn-print {
        background: var(--primary);
        color: #fff;
        border: none;
        border-radius: 6px;
        padding: 8px 16px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
      }

      @media print {
        .screen-actions { display: none !important; }
        body { padding: 0; max-width: 100%; font-size: 10.5pt; }
        .trail-card { border: 1px solid #ccc; break-inside: avoid; }
      }
    </style>
  </head>
  <body>
    <div class="screen-actions">
      <button class="btn-print" onclick="window.print()">🖨️ Print / Save to PDF</button>
    </div>

    <header class="itinerary-header">
      <h1 class="title">${route.name || 'Bikepacking Expedition Itinerary'}</h1>
      <p class="meta-line">Exported for Trail Use via Bikepacker Navigator · Ready for Offline & Mobile Viewing</p>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-card__val">${route.totalDistanceMiles.toFixed(1)} mi</span>
        <span class="stat-card__lbl">Total Distance</span>
      </div>
      <div class="stat-card">
        <span class="stat-card__val">${dayPlan.length} Days</span>
        <span class="stat-card__lbl">Planned Duration</span>
      </div>
      <div class="stat-card">
        <span class="stat-card__val">${waterWpts.length}</span>
        <span class="stat-card__lbl">Water Points</span>
      </div>
      <div class="stat-card">
        <span class="stat-card__val">${foodCarry.length}</span>
        <span class="stat-card__lbl">Food Legs</span>
      </div>
    </div>

    <h2 class="section-title">⛺ Daily Camp Itinerary</h2>
    <div>${daysCardsHTML || '<p style="color: #666;">No day plan generated.</p>'}</div>

    <h2 class="section-title">💧 Water Sources & Refill Strategy</h2>
    <div>${waterCardsHTML || '<p style="color: #666;">No water sources mapped.</p>'}</div>

    <h2 class="section-title">🛒 Food Resupply Legs</h2>
    <div>${foodCardsHTML || '<p style="color: #666;">No food resupply legs needed.</p>'}</div>

    <h2 class="section-title">🚀 Departure: Start of Ride Base Pack</h2>
    <div class="trail-card">${departureItemsHTML}</div>

    <h2 class="section-title">📍 Stop-by-Stop Action & Resupply Checklists</h2>
    <div>${stopChecklistsHTML}</div>
  </body>
</html>`;
}

/**
 * Triggers printable PDF itinerary window.
 * @param {import('./gpx.js').RouteContext} route
 * @param {object} planOptions
 */
export function exportPDFItinerary(route, planOptions) {
  const html = generatePrintableItineraryHTML(route, planOptions);
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert(
      'Pop-up window was blocked. Please allow pop-ups for this site to view/print the itinerary.',
    );
    return;
  }
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => {
    printWindow.print();
  }, 500);
}
