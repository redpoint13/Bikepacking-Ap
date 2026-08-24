/**
 * dom.js — Guarded DOM helpers.
 *
 * Every one of these tolerates a missing root or a selector that matches
 * nothing. The unguarded form — `root.querySelector('#x').textContent = …` —
 * throws a TypeError whenever the element is absent, which happens routinely
 * during partial renders, mode switches, and route teardown. A throw there
 * aborts the rest of the update, leaving the UI half-written.
 */

/**
 * Finds a descendant, tolerating a null root.
 * @param {ParentNode | null | undefined} root
 * @param {string} selector
 * @returns {Element | null}
 */
export function find(root, selector) {
  return root?.querySelector(selector) ?? null;
}

/**
 * Sets textContent if the element exists.
 * @returns {Element | null} The element, or null when absent.
 */
export function setText(root, selector, text) {
  const el = find(root, selector);
  if (el) el.textContent = text;
  return el;
}

/**
 * Sets innerHTML if the element exists.
 * @returns {Element | null}
 */
export function setHTML(root, selector, html) {
  const el = find(root, selector);
  if (el) el.innerHTML = html;
  return el;
}

/**
 * Sets a single inline style property if the element exists.
 * @returns {Element | null}
 */
export function setStyle(root, selector, prop, value) {
  const el = find(root, selector);
  if (el) el.style[prop] = value;
  return el;
}

/**
 * Assigns arbitrary properties (hidden, disabled, value, …) if present.
 * @returns {Element | null}
 */
export function setProps(root, selector, props) {
  const el = find(root, selector);
  if (el) Object.assign(el, props);
  return el;
}

/**
 * Attaches a listener if the element exists.
 * @returns {Element | null}
 */
export function on(root, selector, event, handler, options) {
  const el = find(root, selector);
  if (el) el.addEventListener(event, handler, options);
  return el;
}

/**
 * Reads and trims an input/select value, returning '' when absent.
 * @returns {string}
 */
export function readValue(root, selector) {
  const el = find(root, selector);
  return typeof el?.value === 'string' ? el.value.trim() : '';
}
