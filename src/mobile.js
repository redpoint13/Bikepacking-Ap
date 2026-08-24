/**
 * mobile.js — Native mobile integration and device handling.
 *
 * Provides Capacitor lifecycle management, Screen Wake Lock for active
 * navigation, and hierarchical Android Back Button handling.
 *
 * @module mobile
 */

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { describeError } from './errorBoundary.js';

let wakeLockSentinel = null;
let lastBackPressTime = 0;
let exitToastTimeout = null;

/**
 * Requests or releases a screen wake lock to prevent the screen from timing out.
 * Safe to call on all platforms; falls back gracefully if WakeLock is unsupported.
 *
 * @param {boolean} enable - Whether to keep the screen awake
 */
export async function setKeepAwake(enable) {
  if (enable) {
    if (wakeLockSentinel) return; // Already active
    try {
      if ('wakeLock' in navigator) {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => {
          wakeLockSentinel = null;
        });
      }
    } catch (err) {
      console.warn('[BPNav] Failed to acquire Screen WakeLock:', describeError(err));
    }
  } else {
    if (wakeLockSentinel) {
      try {
        await wakeLockSentinel.release();
      } catch (_) {}
      wakeLockSentinel = null;
    }
  }
}

/**
 * Shows a transient toast notification for mobile feedback (e.g. exit warning).
 * @param {string} message
 */
function showExitToast(message) {
  let toast = document.getElementById('bpnav-mobile-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'bpnav-mobile-toast';
    toast.style.cssText = [
      'position: fixed',
      'bottom: 80px',
      'left: 50%',
      'transform: translateX(-50%)',
      'background: rgba(20, 20, 20, 0.92)',
      'color: #fff',
      'padding: 10px 20px',
      'border-radius: 24px',
      'font-size: 14px',
      'font-weight: 500',
      'box-shadow: 0 4px 16px rgba(0,0,0,0.5)',
      'border: 1px solid rgba(255,255,255,0.15)',
      'z-index: 99999',
      'pointer-events: none',
      'transition: opacity 0.25s ease',
    ].join('; ');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';

  if (exitToastTimeout) clearTimeout(exitToastTimeout);
  exitToastTimeout = setTimeout(() => {
    if (toast) toast.style.opacity = '0';
  }, 2000);
}

/**
 * Closes active overlays/sheets in order of hierarchy.
 * @returns {boolean} true if an overlay was dismissed, false if root view
 */
export function handleHierarchicalBack() {
  // -1. Waypoint Editor Modal
  const wptEditorModal = document.getElementById('waypoint-editor-modal');
  if (wptEditorModal) {
    wptEditorModal.remove();
    return true;
  }

  // 0. Route Library Modal
  const routeLibraryModal = document.getElementById('route-library-modal');
  if (routeLibraryModal) {
    routeLibraryModal.remove();
    return true;
  }

  // 1. Segment Analytics Drawer
  const segmentDrawer = document.getElementById('segment-analytics-drawer');
  if (segmentDrawer) {
    segmentDrawer.remove();
    return true;
  }

  // 2. Sync Progress Modal
  const syncModal = document.getElementById('sync-progress-modal');
  if (syncModal && !syncModal.hidden) {
    syncModal.hidden = true;
    return true;
  }

  // 3. Open HTML <dialog> elements
  const openDialog = document.querySelector('dialog[open]');
  if (openDialog) {
    openDialog.close();
    return true;
  }

  // 4. Expanded Radar Bottom Sheet
  const radarSheet = document.getElementById('radar-bottom-sheet');
  if (
    radarSheet &&
    radarSheet.style.display !== 'none' &&
    !radarSheet.classList.contains('collapsed')
  ) {
    radarSheet.classList.add('collapsed');
    return true;
  }

  return false;
}

/**
 * Initializes mobile handlers including hardware back button and app lifecycle.
 */
export function initMobileHandlers() {
  if (!Capacitor.isNativePlatform()) {
    return;
  }

  // Re-acquire WakeLock on resume if tracking is active
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && window.__bpnav_tracking_active) {
      await setKeepAwake(true);
    }
  });

  // App Lifecycle Listeners
  App.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) {
      console.log('[BPNav] App backgrounded');
    } else {
      console.log('[BPNav] App foregrounded');
    }
  });

  // Android Hardware / Gesture Back Button
  App.addListener('backButton', () => {
    const dismissed = handleHierarchicalBack();
    if (dismissed) {
      return;
    }

    const now = Date.now();
    if (now - lastBackPressTime < 2000) {
      App.exitApp();
    } else {
      lastBackPressTime = now;
      showExitToast('Press back again to exit');
    }
  });
}
