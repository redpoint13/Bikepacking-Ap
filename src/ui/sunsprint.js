/**
 * ui/sunsprint.js — Daylight / Sunsprint planner UI controller.
 */

import { nextWaypointOfType } from '../gpx.js';
import { calculateDaylightBuffer } from '../sun.js';

let sunsprintTargetMile = null;
let lastSunsprintStatus = 'ok';
let currentEtaDate = null;

export function getSunsprintTargetMile() {
  return sunsprintTargetMile;
}

export function setSunsprintTargetMile(val) {
  sunsprintTargetMile = val;
}

export function getCurrentEtaDate() {
  return currentEtaDate;
}

/**
 * Updates the Sunsprint daylight bar based on current position and pace.
 * @param {HTMLElement} container
 * @param {import('../gpx.js').RouteContext} route
 * @param {number} currentMile
 * @param {number} paceMph
 */
export function updateSunsprintDisplay(container, route, currentMile, paceMph) {
  const card = container.querySelector('#sunsprint-card');
  if (!card) return;

  const emptyEl = card.querySelector('#sunsprint-empty');
  const timesEl = card.querySelector('#sunsprint-times');
  const trackEl = card.querySelector('#sunsprint-track');
  const bufferText = card.querySelector('#sunsprint-buffer-text');
  const targetWrapper = card.querySelector('#sunsprint-target-wrapper');
  const targetSlider = card.querySelector('#sunsprint-target-slider');
  const targetVal = card.querySelector('#sunsprint-target-val');
  const ghostBtn = card.querySelector('#ghost-mode-enter-btn');
  const ghostEtaVal = document.getElementById('ghost-mode-eta-val');

  if (!route) {
    card.className = 'daylight-bar-card';
    if (emptyEl) emptyEl.hidden = false;
    if (timesEl) timesEl.hidden = true;
    if (trackEl) trackEl.hidden = true;
    if (bufferText) bufferText.hidden = true;
    if (targetWrapper) targetWrapper.hidden = true;
    if (ghostBtn) ghostBtn.hidden = true;
    return;
  }

  if (emptyEl) emptyEl.hidden = true;
  if (timesEl) timesEl.hidden = false;
  if (trackEl) trackEl.hidden = false;
  if (bufferText) bufferText.hidden = false;
  if (targetWrapper) targetWrapper.hidden = false;
  if (ghostBtn) ghostBtn.hidden = false;

  const maxMiles = route.totalDistanceMiles;

  if (targetSlider) {
    const currentSliderMin = Number(targetSlider.min);
    const newMin = Math.floor(currentMile);
    if (currentSliderMin !== newMin) {
      targetSlider.min = newMin;
    }

    if (Number(targetSlider.max) !== Math.ceil(maxMiles)) {
      targetSlider.max = Math.ceil(maxMiles);
    }
  }

  if (sunsprintTargetMile === null) {
    const nextCamp = nextWaypointOfType(route, 'camping', currentMile);
    sunsprintTargetMile = nextCamp ? nextCamp.distanceFromStartMi : maxMiles;
    if (targetSlider) {
      targetSlider.value = sunsprintTargetMile;
      if (targetVal) targetVal.textContent = sunsprintTargetMile.toFixed(1);
    }
  }

  const destinationName = `Mile ${sunsprintTargetMile.toFixed(1)}`;
  const now = new Date();
  const result = calculateDaylightBuffer(route, currentMile, paceMph, sunsprintTargetMile, now);

  currentEtaDate = result.eta;

  const formatTime = (date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const formattedEta = formatTime(result.eta);

  const sunriseEl = card.querySelector('#sunsprint-sunrise');
  const sunsetEl = card.querySelector('#sunsprint-sunset');
  const etaValEl = card.querySelector('#sunsprint-eta-val');
  const etaMarkerEl = card.querySelector('#sunsprint-eta-marker');

  if (sunriseEl) sunriseEl.textContent = formatTime(result.sunrise);
  if (sunsetEl) sunsetEl.textContent = formatTime(result.sunset);
  if (etaValEl) etaValEl.textContent = formattedEta;
  if (etaMarkerEl) etaMarkerEl.hidden = false;

  if (ghostEtaVal) {
    ghostEtaVal.textContent = formattedEta;
  }

  const totalRemainingTimeMs = result.sunset.getTime() - now.getTime();
  const rideTimeMs = result.eta.getTime() - now.getTime();
  let pct = 0;
  if (totalRemainingTimeMs > 0) {
    pct = Math.min(100, Math.max(0, (rideTimeMs / totalRemainingTimeMs) * 100));
  } else {
    pct = 100;
  }

  const fillEl = card.querySelector('#sunsprint-progress-fill');
  if (fillEl) fillEl.style.width = `${pct}%`;
  if (etaMarkerEl) etaMarkerEl.style.left = `${pct}%`;

  card.className = `daylight-bar-card daylight-bar-card--${result.status}`;

  if (bufferText) {
    if (result.bufferMinutes < 0) {
      bufferText.textContent = `🚨 Arriving ${Math.abs(Math.round(result.bufferMinutes))}m AFTER sunset at ${destinationName}`;
    } else {
      bufferText.textContent = `🌅 ${Math.round(result.bufferMinutes)}m daylight buffer to ${destinationName}`;
    }
  }

  if (result.status === 'alert' && (lastSunsprintStatus === 'ok' || lastSunsprintStatus === 'warning')) {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate([300, 200, 300]);
      } catch (e) {
        console.warn(e);
      }
    }
  }
  lastSunsprintStatus = result.status;
}
