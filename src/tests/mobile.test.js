/**
 * mobile.test.js — Tests for native mobile features & back button navigation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleHierarchicalBack, setKeepAwake } from '../mobile.js';

describe('mobile.js', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('handleHierarchicalBack', () => {
    it('dismisses Segment Analytics Drawer first if present', () => {
      const drawer = document.createElement('div');
      drawer.id = 'segment-analytics-drawer';
      document.body.appendChild(drawer);

      const handled = handleHierarchicalBack();
      expect(handled).toBe(true);
      expect(document.getElementById('segment-analytics-drawer')).toBeNull();
    });

    it('dismisses sync modal if visible', () => {
      const modal = document.createElement('div');
      modal.id = 'sync-progress-modal';
      modal.hidden = false;
      document.body.appendChild(modal);

      const handled = handleHierarchicalBack();
      expect(handled).toBe(true);
      expect(modal.hidden).toBe(true);
    });

    it('collapses expanded radar bottom sheet', () => {
      const sheet = document.createElement('div');
      sheet.id = 'radar-bottom-sheet';
      sheet.style.display = 'flex';
      // Not collapsed
      document.body.appendChild(sheet);

      const handled = handleHierarchicalBack();
      expect(handled).toBe(true);
      expect(sheet.classList.contains('collapsed')).toBe(true);
    });

    it('returns false if no modal or overlay is open', () => {
      const handled = handleHierarchicalBack();
      expect(handled).toBe(false);
    });
  });

  describe('setKeepAwake', () => {
    it('safely handles environments with or without wakeLock API', async () => {
      await expect(setKeepAwake(true)).resolves.not.toThrow();
      await expect(setKeepAwake(false)).resolves.not.toThrow();
    });
  });
});
