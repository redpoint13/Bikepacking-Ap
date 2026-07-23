import { getActiveStopIds, getWaypointsWithSyntheticCamps } from './plan.js';
import { getCoordinatesAtMile } from './gpx.js';

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
  existingWpts.forEach(node => node.remove());

  // Get all active waypoints (including synthetics) based on user's plan
  const allWaypoints = getWaypointsWithSyntheticCamps(route, planOptions);
  const activeStopIds = getActiveStopIds(route, planOptions);
  
  const activeWaypoints = allWaypoints.filter(wp => activeStopIds.has(wp.id));

  // Append new <wpt> elements
  activeWaypoints.forEach(wp => {
    const wptNode = doc.createElement('wpt');
    wptNode.setAttribute('lat', wp.lat.toString());
    wptNode.setAttribute('lon', wp.lon.toString());

    const nameNode = doc.createElement('name');
    nameNode.textContent = wp.name;
    wptNode.appendChild(nameNode);

    if (wp.desc) {
      const descNode = doc.createElement('desc');
      descNode.textContent = wp.desc;
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
  });

  const serializer = new XMLSerializer();
  return serializer.serializeToString(doc);
}

/**
 * Initiates the Web Share API if available, or falls back to standard download.
 * @param {string} filename 
 * @param {string} gpxText 
 */
export async function sharePlan(filename, gpxString) {
  const file = new File([gpxString], filename, { type: 'application/gpx+xml' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        title: 'Bikepacking Route Plan',
        text: 'Here is my customized bikepacking route with planned camps and water stops.',
        files: [file],
      });
      return; // Share succeeded
    } catch (err) {
      console.warn('Web Share API failed or cancelled:', err);
      // Fall through to standard download if error is not just a user cancellation
      if (err.name !== 'AbortError') {
         downloadFile(filename, gpxString);
      }
    }
  } else {
    // Fallback for Desktop browsers without Web Share API
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
 * Generates a clean, print-optimized HTML document for the route itinerary.
 * @param {import('./gpx.js').RouteContext} route
 * @param {object} planOptions
 * @returns {string} HTML string
 */
export function generatePrintableItineraryHTML(route, planOptions) {
  const plan = buildPlan(route, planOptions);
  const dayPlan = plan.dayPlan || [];

  const waterWpts = route.waypoints.filter((w) => w.type === 'water');

  const daysHTML = dayPlan
    .map(
      (d) => `
    <tr>
      <td>Day ${d.day}</td>
      <td>${d.startMi.toFixed(1)} mi</td>
      <td>${d.chosen?.endMi != null ? d.chosen.endMi.toFixed(1) : '—'} mi</td>
      <td>${d.chosen?.name ?? 'Camp'} (${d.chosen?.landManager ?? 'Public Land'})</td>
      <td>${d.chosen?.sunsetTime ?? '—'}</td>
    </tr>
  `,
    )
    .join('');

  const waterHTML = waterWpts
    .map(
      (w) => `
    <tr>
      <td>${w.distanceFromStartMi.toFixed(1)} mi</td>
      <td>${w.name}</td>
      <td>${w.source || 'Water'}</td>
      <td>${w.seasonalStatus || 'Normal Seasonal Flow'}</td>
      <td>${w.reliability}%</td>
    </tr>
  `,
    )
    .join('');

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${route.name || 'Bikepacking Itinerary'} — PDF Itinerary</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.4; color: #111; padding: 24px; max-width: 900px; margin: 0 auto; }
      h1 { margin-bottom: 4px; font-size: 24px; }
      .subtitle { color: #555; margin-bottom: 24px; font-size: 14px; }
      h2 { margin-top: 24px; font-size: 18px; border-bottom: 2px solid #222; padding-bottom: 4px; }
      table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
      th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #ddd; }
      th { background: #f4f4f4; font-weight: 600; }
      @media print {
        body { padding: 0; }
      }
    </style>
  </head>
  <body>
    <h1>${route.name || 'Bikepacking Route'}</h1>
    <p class="subtitle">Total Distance: ${route.totalDistanceMiles.toFixed(1)} miles | Days: ${dayPlan.length} | Exported via Bikepacker Navigator</p>

    <h2>Daily Itinerary</h2>
    <table>
      <thead>
        <tr>
          <th>Day</th>
          <th>Start</th>
          <th>End</th>
          <th>Camp Destination & Land Owner</th>
          <th>Camp Sunset</th>
        </tr>
      </thead>
      <tbody>
        ${daysHTML || '<tr><td colspan="5">No day plan generated yet.</td></tr>'}
      </tbody>
    </table>

    <h2>Water Sources</h2>
    <table>
      <thead>
        <tr>
          <th>Mile</th>
          <th>Source Name</th>
          <th>Type</th>
          <th>Seasonal Flow Status</th>
          <th>Reliability</th>
        </tr>
      </thead>
      <tbody>
        ${waterHTML || '<tr><td colspan="5">No water sources recorded.</td></tr>'}
      </tbody>
    </table>
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
    alert('Pop-up window was blocked. Please allow pop-ups for this site to view/print the itinerary.');
    return;
  }
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => {
    printWindow.print();
  }, 500);
}

