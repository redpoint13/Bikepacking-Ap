/**
 * errorBoundary.js — Global crash handling for Bikepacker Navigator.
 *
 * Without this, a single uncaught error leaves a blank, unrecoverable page with
 * nothing logged. This converts any uncaught error or unhandled promise
 * rejection into a visible, dismissable panel the rider can recover from.
 *
 * Every function here is written to be non-throwing: the error handler must
 * never itself become a source of errors.
 */

const PANEL_ID = 'bpnav-crash-panel';

/** Recent messages, used to collapse repeats of the same failing frame. */
const seen = new Set();

/**
 * Coerces anything throwable — Error, string, null, a rejected undefined — into
 * a readable message. Reading `.message` off a non-Error is a crash in itself.
 * @param {unknown} value
 * @returns {string}
 */
export function describeError(value) {
  if (value == null) return 'Unknown error';
  if (value instanceof Error) return value.message || value.name || 'Error';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const maybe = /** @type {{ message?: unknown }} */ (value).message;
    if (typeof maybe === 'string' && maybe) return maybe;
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

/**
 * Renders (or updates) the crash panel.
 * @param {string} message
 */
function showCrashPanel(message) {
  try {
    if (!document.body) return;

    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.setAttribute('role', 'alert');
      panel.className = 'bpnav-crash-panel';

      const title = document.createElement('strong');
      title.textContent = 'Something went wrong';
      panel.appendChild(title);

      const detail = document.createElement('p');
      detail.className = 'bpnav-crash-detail';
      panel.appendChild(detail);

      const actions = document.createElement('div');
      actions.className = 'bpnav-crash-actions';

      const reload = document.createElement('button');
      reload.type = 'button';
      reload.textContent = 'Reload';
      reload.addEventListener('click', () => window.location.reload());
      actions.appendChild(reload);

      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.textContent = 'Dismiss';
      dismiss.addEventListener('click', () => {
        panel.remove();
        // Allow a recurrence to notify again — the collapse below exists to
        // stop a failing render loop spamming the panel, not to silence an
        // error permanently once the rider has acknowledged it.
        seen.clear();
      });
      actions.appendChild(dismiss);

      panel.appendChild(actions);
      document.body.appendChild(panel);
    }

    const detail = panel.querySelector('.bpnav-crash-detail');
    if (detail) detail.textContent = message;
  } catch {
    // A failure to render the error UI must never escalate.
  }
}

/**
 * Handles one captured failure: logs it and surfaces the panel.
 * @param {string} source
 * @param {unknown} value
 */
function handle(source, value) {
  const message = describeError(value);
  try {
    console.error(`[BPNav] Uncaught (${source}):`, value);
  } catch {
    /* console can be unavailable in some embedded webviews */
  }

  // Collapse identical repeats so a failure inside a render loop cannot
  // spam the panel (or the console) unboundedly.
  const key = `${source}:${message}`;
  if (seen.has(key)) return;
  seen.add(key);

  showCrashPanel(message);
}

/**
 * Installs global handlers for uncaught errors and unhandled promise
 * rejections. Safe to call once at startup.
 * @param {Window} [target]
 */
export function installErrorBoundary(target = window) {
  target.addEventListener('error', (event) => {
    // Resource load failures (img/script) surface here too but carry no
    // `error` value and should not raise a crash panel.
    if (!event.error && event.target !== target) return;
    handle('error', event.error ?? event.message);
  });

  target.addEventListener('unhandledrejection', (event) => {
    handle('unhandledrejection', event.reason);
  });
}

/**
 * Runs the app's mount step, surfacing any synchronous failure through the
 * same panel rather than leaving a blank page.
 * @param {() => void} mount
 */
export function guardStartup(mount) {
  try {
    mount();
  } catch (err) {
    handle('startup', err);
  }
}
