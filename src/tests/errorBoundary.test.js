/**
 * errorBoundary.test.js — Global crash handling.
 *
 * Verifies that uncaught errors and unhandled rejections surface a recoverable
 * panel instead of leaving a blank page, and that the handler itself never
 * throws on hostile input.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { describeError, guardStartup, installErrorBoundary } from '../errorBoundary.js';

beforeEach(() => {
  document.body.innerHTML = '';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('describeError', () => {
  it('reads the message off a real Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('passes strings through', () => {
    expect(describeError('plain failure')).toBe('plain failure');
  });

  // The bug this guards: `err.message` on a non-Error throws inside the
  // catch block, replacing the original failure with a second one.
  it('does not throw on null or undefined', () => {
    expect(() => describeError(null)).not.toThrow();
    expect(() => describeError(undefined)).not.toThrow();
    expect(describeError(null)).toBe('Unknown error');
  });

  it('handles objects with no message', () => {
    expect(() => describeError({ code: 42 })).not.toThrow();
    expect(describeError({ code: 42 })).toContain('42');
  });

  it('handles circular objects without throwing', () => {
    const circular = { a: 1 };
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
  });

  it('uses a message property when present', () => {
    expect(describeError({ message: 'from object' })).toBe('from object');
  });
});

describe('installErrorBoundary', () => {
  it('renders a crash panel on an uncaught error', () => {
    installErrorBoundary(window);
    window.dispatchEvent(
      new ErrorEvent('error', { error: new Error('render failed'), message: 'render failed' }),
    );

    const panel = document.getElementById('bpnav-crash-panel');
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain('render failed');
    expect(panel.getAttribute('role')).toBe('alert');
  });

  it('offers a way to recover', () => {
    installErrorBoundary(window);
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('recover-case') }));

    const buttons = [...document.querySelectorAll('#bpnav-crash-panel button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Reload', 'Dismiss']);
  });

  it('dismisses the panel when asked', () => {
    installErrorBoundary(window);
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('dismiss-case') }));

    document.querySelector('#bpnav-crash-panel button:last-child').click();
    expect(document.getElementById('bpnav-crash-panel')).toBeNull();
  });

  it('can notify again after the rider dismisses a recurring error', () => {
    installErrorBoundary(window);
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('recurring-case') }));
    document.querySelector('#bpnav-crash-panel button:last-child').click();

    window.dispatchEvent(new ErrorEvent('error', { error: new Error('recurring-case') }));
    expect(document.getElementById('bpnav-crash-panel')).toBeTruthy();
  });

  it('collapses repeats so a failing render loop cannot spam the panel', () => {
    installErrorBoundary(window);
    for (let i = 0; i < 25; i++) {
      window.dispatchEvent(new ErrorEvent('error', { error: new Error('spam-case') }));
    }
    expect(document.querySelectorAll('#bpnav-crash-panel')).toHaveLength(1);
  });
});

describe('guardStartup', () => {
  it('surfaces a mount failure instead of leaving a blank page', () => {
    guardStartup(() => {
      throw new Error('Root #app element not found');
    });

    const panel = document.getElementById('bpnav-crash-panel');
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain('Root #app element not found');
  });

  it('does not interfere with a successful mount', () => {
    const mount = vi.fn();
    guardStartup(mount);
    expect(mount).toHaveBeenCalledOnce();
    expect(document.getElementById('bpnav-crash-panel')).toBeNull();
  });
});
