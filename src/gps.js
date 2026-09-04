/**
 * gps.js — GPS tracking and simulation for Bikepacker Navigator.
 *
 * Handles Capacitor native Geolocation API tracking and browser Geolocation
 * with high-accuracy GPS, auto WakeLock, and simulation mode.
 *
 * @module gps
 */

import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { describeError } from './errorBoundary.js';
import {
  getOrCreateCumulativeDistances,
  haversineDistance,
  nearestTrackPointIndex,
} from './gpx.js';
import { setKeepAwake } from './mobile.js';

export class GPSManager {
  /**
   * @param {import("./gpx.js").RouteContext} route
   */
  constructor(route) {
    this.route = route;
    this.watchId = null;
    this.nativeWatchId = null;
    this.simIntervalId = null;
    this.simDistanceMi = 0;
    this.callbacks = new Set();
    this.lastPos = null;
    this.lastTime = null;
    /**
     * Index of the track point the last fix snapped to, fed back into
     * nearestTrackPointIndex as a search hint. Without it every fix ran a
     * global nearest scan, which picks the geometrically closest point
     * anywhere on the route — so on an out-and-back or a lollipop loop, a
     * few metres of GPS error would snap the rider onto the leg running
     * alongside and jump the reported mile by the length of the loop.
     * -1 means "no hint yet", which is also the fallback the hinted search
     * takes itself whenever the local window holds nothing plausible.
     * @type {number}
     */
    this.lastTrackIndex = -1;
    /**
     * Subscribers to tracking-status changes. Location failures used to be a
     * console.warn and nothing else, so a rider who declined the permission
     * prompt (or rode into a spot with no fix) saw Riding mode sit at mile 0
     * with no explanation at all.
     * @type {Set<function({ state: string, message: string }): void>}
     */
    this.statusCallbacks = new Set();
    /** @type {{ state: string, message: string }} */
    this.status = { state: 'idle', message: '' };
  }

  /**
   * Registers a callback for tracking-status changes, and immediately replays
   * the current status so a late subscriber is not left blank.
   * @param {function({ state: string, message: string }): void} callback
   * @returns {() => void} Unsubscribe
   */
  onStatusChange(callback) {
    this.statusCallbacks.add(callback);
    try {
      callback(this.status);
    } catch (err) {
      console.error('[BPNav] Error in GPS status callback:', err);
    }
    return () => this.statusCallbacks.delete(callback);
  }

  /**
   * @param {'idle'|'searching'|'ok'|'simulating'|'denied'|'unavailable'|'unsupported'} state
   * @param {string} message
   * @private
   */
  _setStatus(state, message) {
    if (this.status.state === state && this.status.message === message) return;
    this.status = { state, message };
    for (const cb of this.statusCallbacks) {
      try {
        cb(this.status);
      } catch (err) {
        console.error('[BPNav] Error in GPS status callback:', err);
      }
    }
  }

  /**
   * Maps a browser GeolocationPositionError onto a status.
   * @param {GeolocationPositionError} error
   * @private
   */
  _setStatusFromWebError(error) {
    // 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT
    if (error?.code === 1) {
      this._setStatus(
        'denied',
        'Location permission denied — Riding mode cannot track your position. Enable location for this site, then switch back to Riding.',
      );
    } else if (error?.code === 3) {
      this._setStatus('unavailable', 'Waiting for a GPS fix — no signal yet.');
    } else {
      this._setStatus('unavailable', 'GPS position unavailable right now.');
    }
  }

  /**
   * Registers a callback for location updates.
   * @param {function({ lat: number, lon: number, accuracy?: number, paceMph?: number }): void} callback
   */
  onLocationUpdate(callback) {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  /** @private */
  _trigger(data) {
    for (const cb of this.callbacks) {
      try {
        cb(data);
      } catch (err) {
        console.error('[BPNav] Error in GPS callback:', err);
      }
    }
  }

  /**
   * Snaps a fix onto the route, resolving both the track index and the
   * along-track mileage in a single search, and remembers the index so the
   * next fix can search locally around it.
   *
   * @param {number} lat
   * @param {number} lon
   * @returns {{ trackIndex: number, mileFromStart: number }}
   * @private
   */
  _snapToRoute(lat, lon) {
    const trackPoints = this.route?.trackPoints;
    if (!trackPoints || trackPoints.length === 0) {
      return { trackIndex: -1, mileFromStart: 0 };
    }
    const trackIndex = nearestTrackPointIndex(lat, lon, trackPoints, this.lastTrackIndex);
    this.lastTrackIndex = trackIndex;
    const distances = getOrCreateCumulativeDistances(trackPoints);
    return { trackIndex, mileFromStart: distances[trackIndex] ?? 0 };
  }

  /**
   * Calculates smoothed pace given the current coordinates.
   * @private
   */
  _calculatePace(latitude, longitude) {
    const now = Date.now();
    let paceMph = 10; // Default fallback pace

    if (this.lastPos && this.lastTime) {
      const distMi = haversineDistance(this.lastPos.lat, this.lastPos.lon, latitude, longitude);
      const timeHours = (now - this.lastTime) / (1000 * 60 * 60);
      if (timeHours > 0.005) {
        // At least 18 seconds to calculate a stable pace
        paceMph = Math.min(35, Math.max(1, distMi / timeHours));
      }
    }

    this.lastPos = { lat: latitude, lon: longitude };
    this.lastTime = now;
    return paceMph;
  }

  /**
   * Starts high-accuracy GPS tracking with screen keep-awake.
   */
  async startTracking() {
    this.stop();
    if (typeof window !== 'undefined') {
      window.__bpnav_tracking_active = true;
    }
    await setKeepAwake(true);
    this._setStatus('searching', 'Acquiring GPS…');

    if (Capacitor.isNativePlatform()) {
      try {
        const perm = await Geolocation.checkPermissions();
        if (perm.location !== 'granted') {
          const req = await Geolocation.requestPermissions({ permissions: ['location'] });
          if (req.location !== 'granted') {
            console.warn('[BPNav] Location permission denied by user.');
            this._setStatus(
              'denied',
              'Location permission denied — Riding mode cannot track your position. Grant location access in Settings, then switch back to Riding.',
            );
            return;
          }
        }

        this.nativeWatchId = await Geolocation.watchPosition(
          {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0,
          },
          (position, err) => {
            if (err) {
              console.warn('[BPNav] Native geolocation error:', describeError(err));
              this._setStatus('unavailable', 'GPS position unavailable right now.');
              return;
            }
            if (!position?.coords) return;
            const { latitude, longitude, accuracy } = position.coords;
            const paceMph = this._calculatePace(latitude, longitude);
            const snap = this._snapToRoute(latitude, longitude);
            this._setStatus('ok', '');
            this._trigger({ lat: latitude, lon: longitude, accuracy, paceMph, ...snap });
          },
        );
        return;
      } catch (err) {
        console.warn('[BPNav] Native Geolocation failed, falling back to web:', describeError(err));
      }
    }

    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      this.watchId = navigator.geolocation.watchPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;
          const paceMph = this._calculatePace(latitude, longitude);
          const snap = this._snapToRoute(latitude, longitude);
          this._setStatus('ok', '');
          this._trigger({ lat: latitude, lon: longitude, accuracy, paceMph, ...snap });
        },
        (error) => {
          console.warn('[BPNav] Web geolocation error:', describeError(error));
          this._setStatusFromWebError(error);
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        },
      );
    } else {
      console.warn('[BPNav] Geolocation is not supported in this environment.');
      this._setStatus('unsupported', 'This device or browser cannot provide GPS location.');
    }
  }

  /**
   * Starts a simulation moving along the route at a specified speed.
   * @param {number} [speedMph=15] - Simulation speed in mph
   * @param {number} [tickMs=2000] - Interval between updates in ms
   */
  startSimulation(speedMph = 15, tickMs = 2000) {
    this.stop();

    const points = this.route.trackPoints;
    if (!points || points.length < 2) {
      console.warn('[BPNav] Route has insufficient track points for simulation.');
      this._setStatus('unavailable', 'Route has too few track points to simulate.');
      return;
    }
    this._setStatus('simulating', 'Simulated ride — not using real GPS.');

    // Precompute cumulative distances for all track points to make snapping fast
    const cumulativeDistances = [0];
    let totalDist = 0;
    for (let i = 1; i < points.length; i++) {
      totalDist += haversineDistance(
        points[i - 1][0],
        points[i - 1][1],
        points[i][0],
        points[i][1],
      );
      cumulativeDistances.push(totalDist);
    }

    this.simDistanceMi = 0;

    this.simIntervalId = setInterval(() => {
      // Advance distance: speed * time
      const hoursPassed = tickMs / 1000 / 3600;
      this.simDistanceMi += speedMph * hoursPassed;

      if (this.simDistanceMi > this.route.totalDistanceMiles) {
        if (this.route.isLoop) {
          this.simDistanceMi = this.simDistanceMi % this.route.totalDistanceMiles;
        } else {
          this.simDistanceMi = this.route.totalDistanceMiles;
          this.stop();
        }
      }

      // Find the track point index corresponding to the simulated distance
      let idx = 0;
      while (
        idx < cumulativeDistances.length - 1 &&
        cumulativeDistances[idx + 1] < this.simDistanceMi
      ) {
        idx++;
      }

      const [lat, lon] = points[idx];
      // The simulator already knows exactly where it is; hand the same shape
      // the real fixes do rather than making consumers re-derive it.
      this.lastTrackIndex = idx;
      this._trigger({
        lat,
        lon,
        accuracy: 5,
        paceMph: speedMph,
        trackIndex: idx,
        mileFromStart: cumulativeDistances[idx] ?? 0,
      });
    }, tickMs);
  }

  /**
   * Starts tracking in low-power mode for Ghost Mode battery savings.
   */
  async startLowPowerTracking() {
    this.stop();
    if (typeof window !== 'undefined') {
      window.__bpnav_tracking_active = false;
    }
    await setKeepAwake(false);
    this._setStatus('searching', 'Acquiring GPS…');

    if (Capacitor.isNativePlatform()) {
      try {
        this.nativeWatchId = await Geolocation.watchPosition(
          {
            enableHighAccuracy: false,
            timeout: 20000,
            maximumAge: 10000,
          },
          (position, err) => {
            if (err) {
              console.warn('[BPNav] Native low-power geolocation error:', describeError(err));
              this._setStatus('unavailable', 'GPS position unavailable right now.');
              return;
            }
            if (!position?.coords) return;
            const { latitude, longitude, accuracy } = position.coords;
            const snap = this._snapToRoute(latitude, longitude);
            this._setStatus('ok', '');
            this._trigger({ lat: latitude, lon: longitude, accuracy, paceMph: 10, ...snap });
          },
        );
        return;
      } catch (err) {
        console.warn(
          '[BPNav] Native low-power Geolocation failed, fallback to web:',
          describeError(err),
        );
      }
    }

    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      this.watchId = navigator.geolocation.watchPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;
          const snap = this._snapToRoute(latitude, longitude);
          this._setStatus('ok', '');
          this._trigger({ lat: latitude, lon: longitude, accuracy, paceMph: 10, ...snap });
        },
        (error) => {
          console.warn('[BPNav] Geolocation error:', describeError(error));
          this._setStatusFromWebError(error);
        },
        {
          enableHighAccuracy: false,
          timeout: 20000,
          maximumAge: 10000,
        },
      );
    }
  }

  /**
   * Stops any active tracking or simulation.
   */
  stop() {
    if (typeof window !== 'undefined') {
      window.__bpnav_tracking_active = false;
    }
    // Drop the search hint: the rider may be somewhere else entirely by the
    // time tracking resumes, and a stale hint only costs a wrong first guess.
    this.lastTrackIndex = -1;
    this._setStatus('idle', '');
    setKeepAwake(false).catch(() => {});

    if (this.nativeWatchId !== null) {
      Geolocation.clearWatch({ id: this.nativeWatchId }).catch(() => {});
      this.nativeWatchId = null;
    }
    if (this.watchId !== null) {
      if (typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.clearWatch(this.watchId);
      }
      this.watchId = null;
    }
    if (this.simIntervalId !== null) {
      clearInterval(this.simIntervalId);
      this.simIntervalId = null;
    }
  }
}
