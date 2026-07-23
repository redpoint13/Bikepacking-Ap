let voiceEnabled = localStorage.getItem('bpnav-voiceEnabled') === 'true';

/**
 * Initializes voice state from localStorage.
 * @returns {boolean}
 */
export function initVoiceFromStorage() {
  voiceEnabled = localStorage.getItem('bpnav-voiceEnabled') === 'true';
  return voiceEnabled;
}

/**
 * Enable or disable voice navigation.
 * @param {boolean} enabled 
 */
export function setVoiceEnabled(enabled) {
  voiceEnabled = enabled;
  try {
    localStorage.setItem('bpnav-voiceEnabled', String(enabled));
  } catch (_e) {}
  if (!enabled && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

/**
 * Checks if voice navigation is currently enabled.
 * @returns {boolean}
 */
export function isVoiceEnabled() {
  return voiceEnabled;
}

/**
 * Speaks a given text using the Web Speech API.
 * Cancels any ongoing speech before starting.
 * @param {string} text 
 */
export function speak(text) {
  if (!voiceEnabled || !('speechSynthesis' in window)) return;
  
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  
  // Optional: Pick a specific voice if desired, for now we use default.
  window.speechSynthesis.speak(utterance);
}

/**
 * Generates a human-readable status report for TTS.
 * @param {number} currentMile 
 * @param {number} targetMile 
 * @param {Date} etaDate 
 * @param {object} nextResource { type: 'water' | 'camp', distance: number }
 * @returns {string}
 */
export function generateStatusReport(currentMile, targetMile, etaDate, nextResource = null) {
  const parts = [];
  parts.push(`You are at mile ${Math.round(currentMile)}.`);
  
  if (nextResource) {
    const roundedDist = Math.round(nextResource.distance * 10) / 10;
    const typeLabel = nextResource.type === 'camp' ? 'camping' : nextResource.type;
    parts.push(`Next ${typeLabel} is in ${roundedDist} miles.`);
  }

  if (etaDate) {
    // Format ETA specifically for speech: "5 30 PM"
    const timeStr = etaDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    parts.push(`E T A to your target is ${timeStr}.`);
  }

  return parts.join(' ');
}

export const TIERED_TRIGGER_DISTANCES = {
  water: 0.5,      // 0.5 miles (800m)
  camping: 1.0,    // 1.0 mile (1.6km)
  resupply: 2.0,   // 2.0 miles (3.2km)
  offCourse: 0.06, // 100 meters (~0.06 mi)
};

/**
 * Determines if a resource waypoint is within its tiered audio trigger range.
 * @param {'water' | 'camping' | 'resupply' | 'navigation'} type
 * @param {number} distanceMi
 * @returns {boolean}
 */
export function shouldAnnounceResource(type, distanceMi) {
  const threshold = TIERED_TRIGGER_DISTANCES[type] ?? 0.5;
  return distanceMi > 0 && distanceMi <= threshold;
}

/**
 * Generates structured SpeechSynthesis text for a resource waypoint.
 * @param {object} wp
 * @param {number} distanceMi
 * @returns {string}
 */
export function generateProximityAnnouncement(wp, distanceMi) {
  const distStr = distanceMi.toFixed(1);
  const reliability = wp.reliability != null ? `Reliability rating ${wp.reliability} percent.` : '';
  const landInfo = wp.landManager ? `Located on ${wp.landManager} land.` : '';

  if (wp.type === 'water') {
    return `Water source ahead in ${distStr} miles. ${wp.name}. ${reliability}`;
  }
  if (wp.type === 'camping') {
    return `Camp spot ahead in ${distStr} miles. ${wp.name}. ${landInfo}`;
  }
  if (wp.type === 'resupply') {
    return `Resupply point ahead in ${distStr} miles. ${wp.name}.`;
  }
  return `${wp.name} ahead in ${distStr} miles.`;
}

/**
 * Generates an urgent speech warning when off course.
 * @param {number} offCourseDistMi
 * @returns {string}
 */
export function generateOffCourseAlert(offCourseDistMi) {
  const yards = Math.round(offCourseDistMi * 1760);
  return `Warning. Route deviation detected. You are ${yards} yards off course. Please check your map.`;
}

