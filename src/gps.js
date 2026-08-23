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
import { haversineDistance } from './gpx.js';
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

    if (Capacitor.isNativePlatform()) {
      try {
        const perm = await Geolocation.checkPermissions();
        if (perm.location !== 'granted') {
          const req = await Geolocation.requestPermissions({ permissions: ['location'] });
          if (req.location !== 'granted') {
            console.warn('[BPNav] Location permission denied by user.');
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
              console.warn('[BPNav] Native geolocation error:', err.message);
              return;
            }
            if (!position?.coords) return;
            const { latitude, longitude, accuracy } = position.coords;
            const paceMph = this._calculatePace(latitude, longitude);
            this._trigger({ lat: latitude, lon: longitude, accuracy, paceMph });
          },
        );
        return;
      } catch (err) {
        console.warn('[BPNav] Native Geolocation failed, falling back to web:', err.message);
      }
    }

    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      this.watchId = navigator.geolocation.watchPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;
          const paceMph = this._calculatePace(latitude, longitude);
          this._trigger({ lat: latitude, lon: longitude, accuracy, paceMph });
        },
        (error) => {
          console.warn('[BPNav] Web geolocation error:', error.message);
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        },
      );
    } else {
      console.warn('[BPNav] Geolocation is not supported in this environment.');
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
      return;
    }

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
      this._trigger({ lat, lon, accuracy: 5, paceMph: speedMph });
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
              console.warn('[BPNav] Native low-power geolocation error:', err.message);
              return;
            }
            if (!position?.coords) return;
            const { latitude, longitude, accuracy } = position.coords;
            this._trigger({ lat: latitude, lon: longitude, accuracy, paceMph: 10 });
          },
        );
        return;
      } catch (err) {
        console.warn('[BPNav] Native low-power Geolocation failed, fallback to web:', err.message);
      }
    }

    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      this.watchId = navigator.geolocation.watchPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;
          this._trigger({ lat: latitude, lon: longitude, accuracy, paceMph: 10 });
        },
        (error) => {
          console.warn('[BPNav] Geolocation error:', error.message);
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
