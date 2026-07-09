/**
 * gps.js — GPS tracking and simulation for Bikepacker Navigator.
 *
 * Handles browser Geolocation API tracking and provides a high-fidelity
 * route simulation mode for testing.
 *
 * @module gps
 */

import { haversineDistance } from './gpx.js';

export class GPSManager {
  /**
   * @param {import('./gpx.js').RouteContext} route
   */
  constructor(route) {
    this.route = route;
    this.watchId = null;
    this.simIntervalId = null;
    this.simDistanceMi = 0;
    this.callbacks = new Set();
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
   * Starts tracking using the browser's Geolocation API.
   */
  startTracking() {
    this.stop();

    if (!navigator.geolocation) {
      console.warn('[BPNav] Geolocation is not supported by this browser.');
      return;
    }

    let lastPos = null;
    let lastTime = null;

    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        const now = Date.now();
        let paceMph = 10; // Default fallback pace

        if (lastPos && lastTime) {
          const distMi = haversineDistance(lastPos.lat, lastPos.lon, latitude, longitude);
          const timeHours = (now - lastTime) / (1000 * 60 * 60);
          if (timeHours > 0.005) {
            // At least 18 seconds to get a stable pace
            paceMph = Math.min(35, Math.max(1, distMi / timeHours));
          }
        }

        lastPos = { lat: latitude, lon: longitude };
        lastTime = now;

        this._trigger({ lat: latitude, lon: longitude, accuracy, paceMph });
      },
      (error) => {
        console.warn('[BPNav] Geolocation error:', error.message);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      },
    );
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
   * Stops any active tracking or simulation.
   */
  stop() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    if (this.simIntervalId !== null) {
      clearInterval(this.simIntervalId);
      this.simIntervalId = null;
    }
  }
}
