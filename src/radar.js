/**
 * radar.js — Smart Resource Radar for Bikepacker Navigator.
 *
 * Provides live proximity lookahead for water, camp, and resupply resources.
 * Drives the UI updates for the bottom sheet and triggers haptic alerts.
 *
 * @module radar
 */

import { speak } from './audio.js';
import { distanceFromStart, waypointsOfType } from './gpx.js';

export class RadarController {
  /**
   * @param {import('./gpx.js').RouteContext} route
   * @param {import('./gps.js').GPSManager} gpsManager
   */
  constructor(route, gpsManager) {
    this.route = route;
    this.gpsManager = gpsManager;
    this.unsubscribeGps = null;

    // Internal state
    this.currentMile = 0;
    this.capacityOz = 64; // Default to 64oz
    this.temperature = 70; // Default to 70F

    // Haptic state tracking to prevent duplicate fires
    this.hapticFired = {
      water: { '1.0': null, 0.3: null }, // 0.3mi ~ 500m
      camp: { '1.0': null, 0.3: null },
      resupply: { '1.0': null, 0.3: null },
    };

    // UI Elements
    this.sheetEl = document.getElementById('radar-bottom-sheet');
    this.waterNextEl = document.getElementById('radar-water-next');
    this.waterListEl = document.getElementById('radar-water-list');
    this.campNextEl = document.getElementById('radar-camp-next');
    this.resupplyNextEl = document.getElementById('radar-resupply-next');
    this.carryReqEl = document.getElementById('radar-carry-req');
    this.dryStretchEl = document.getElementById('radar-dry-stretch');

    // Inputs
    this.tempInput = document.getElementById('radar-temp-input');
    this.capInput = document.getElementById('radar-cap-input');

    this._bindUI();
  }

  _bindUI() {
    if (this.sheetEl) {
      const handle = this.sheetEl.querySelector('.radar-handle');
      if (handle) {
        handle.addEventListener('click', () => {
          this.sheetEl.classList.toggle('collapsed');
        });
      }
    }

    if (this.tempInput) {
      const savedTemp = localStorage.getItem('bpnav-radarTemp');
      if (savedTemp) this.temperature = Number(savedTemp);
      this.tempInput.value = this.temperature;

      this.tempInput.addEventListener('change', (e) => {
        this.temperature = Number(e.target.value);
        localStorage.setItem('bpnav-radarTemp', this.temperature);
        this.updateUI();
      });
    }

    if (this.capInput) {
      const savedCap = localStorage.getItem('bpnav-waterCapacityOz');
      if (savedCap) this.capacityOz = Number(savedCap);
      this.capInput.value = this.capacityOz;

      this.capInput.addEventListener('change', (e) => {
        this.capacityOz = Number(e.target.value);
        localStorage.setItem('bpnav-waterCapacityOz', this.capacityOz);
        this.updateUI();
      });
    }
  }

  start() {
    if (this.unsubscribeGps) return; // already started

    if (this.sheetEl) {
      this.sheetEl.style.display = 'flex';
    }

    this.unsubscribeGps = this.gpsManager.onLocationUpdate((pos) => {
      this.currentMile = distanceFromStart(pos.lat, pos.lon, this.route.trackPoints);
      this.updateUI();
      this.checkHaptics();
    });

    // Initial update
    this.updateUI();
  }

  stop() {
    if (this.unsubscribeGps) {
      this.unsubscribeGps();
      this.unsubscribeGps = null;
    }
    if (this.sheetEl) {
      this.sheetEl.style.display = 'none';
    }
  }

  _getNextWaypoints(type, count) {
    const wpts = waypointsOfType(this.route, type);
    return wpts
      .filter((w) => w.distanceFromStartMi > this.currentMile)
      .sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi)
      .slice(0, count);
  }

  updateUI() {
    if (!this.sheetEl) return;

    // --- Water ---
    const nextWaterSources = this._getNextWaypoints('water', 3);
    const nextWater = nextWaterSources[0];

    if (nextWater) {
      const distMi = (nextWater.distanceFromStartMi - this.currentMile).toFixed(1);
      this.waterNextEl.textContent = `${distMi} mi`;
      this.dryStretchEl.textContent = distMi;

      this.waterListEl.innerHTML = nextWaterSources
        .map((w, idx) => {
          const d = (w.distanceFromStartMi - this.currentMile).toFixed(1);
          return `<div class="radar-item ${idx === 0 ? 'primary' : ''}">
          <span>${w.name || 'Water Source'}</span>
          <span>${d} mi</span>
        </div>`;
        })
        .join('');

      // Carry Calculator
      const ozPerMile = this.temperature > 85 ? 12 : this.temperature > 70 ? 8 : 6;
      const reqOz = (nextWater.distanceFromStartMi - this.currentMile) * ozPerMile;
      this.carryReqEl.textContent = Math.round(reqOz);

      if (reqOz > this.capacityOz) {
        this.carryReqEl.classList.add('alert-red');
      } else {
        this.carryReqEl.classList.remove('alert-red');
      }
    } else {
      this.waterNextEl.textContent = '--';
      this.dryStretchEl.textContent = '--';
      this.waterListEl.innerHTML = '<div class="radar-item">No upcoming water</div>';
      this.carryReqEl.textContent = '--';
    }

    // --- Camp ---
    const nextCamp = this._getNextWaypoints('camp', 1)[0];
    if (nextCamp) {
      const distMi = (nextCamp.distanceFromStartMi - this.currentMile).toFixed(1);
      this.campNextEl.textContent = `${distMi} mi`;
    } else {
      this.campNextEl.textContent = '--';
    }

    // --- Resupply ---
    const nextResupply = this._getNextWaypoints('resupply', 1)[0];
    if (nextResupply) {
      const distMi = (nextResupply.distanceFromStartMi - this.currentMile).toFixed(1);
      this.resupplyNextEl.textContent = `${distMi} mi`;
    } else {
      this.resupplyNextEl.textContent = '--';
    }
  }

  checkHaptics() {
    this._checkHapticForType('water', [1.0, 0.3]);
    this._checkHapticForType('camp', [1.0, 0.3]);
    this._checkHapticForType('resupply', [1.0, 0.3]);
  }

  _checkHapticForType(type, thresholds) {
    const nextWp = this._getNextWaypoints(type, 1)[0];
    if (!nextWp) return;

    const distMi = nextWp.distanceFromStartMi - this.currentMile;

    for (const thresh of thresholds) {
      const threshStr = thresh.toFixed(1);

      // If we are within the threshold + 0.1 miles of it (e.g. 1.0 to 1.1)
      if (distMi <= thresh && distMi > thresh - 0.1) {
        if (this.hapticFired[type][threshStr] !== nextWp.id) {
          this._fireHaptic();
          this.hapticFired[type][threshStr] = nextWp.id;

          if (thresh === 1.0) {
            const typeLabel = type === 'camp' ? 'camping' : type;
            speak(`Approaching ${typeLabel} in 1 mile.`);
          }
        }
      }

      // Reset if we passed it or are far away (handle looping)
      if (distMi > thresh + 0.2 || distMi < -0.1) {
        if (this.hapticFired[type][threshStr] === nextWp.id) {
          this.hapticFired[type][threshStr] = null;
        }
      }
    }
  }

  _fireHaptic() {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate([200, 100, 200]);
      } catch (e) {
        console.warn('Haptic feedback failed:', e);
      }
    }
  }
}
