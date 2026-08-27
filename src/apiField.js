/**
 * apiField.js — Reading fields off external API responses, loudly.
 *
 * The recurring fault in this app has been a field name that does not exist:
 * monitoringLocationType for site_type_code, monitoringLocationNumber for
 * monitoring_location_number, HOLDING_NAME on a layer without it, WILDERNESSNAME
 * where the service answers wildernessname. Every one produced `undefined`,
 * every one failed silently, and several shipped — because reading a missing
 * key off a parsed JSON object is not an error in JavaScript, and the tests
 * were written from the same assumption as the code.
 *
 * A type checker cannot help here: the response is `any`. What helps is saying
 * something the first time a key is absent, so the failure announces itself on
 * the first run rather than in the backcountry.
 *
 * @module apiField
 */

/** Warn once per source+field, so a per-element loop cannot flood the console. */
const warned = new Set();

/**
 * Reads the first present key from an API object, warning when none match.
 *
 * Accepts several candidate names because these services are inconsistent about
 * case and separators — and because a rename upstream should degrade to a warning
 * rather than a silent undefined.
 *
 * @param {Record<string, unknown> | null | undefined} obj
 * @param {string[]} names   candidate keys, most-preferred first
 * @param {string} context   what is being read, for the warning
 * @returns {unknown} the first defined value, or undefined
 */
export function readApiField(obj, names, context) {
  if (obj) {
    for (const name of names) {
      const value = obj[name];
      if (value !== undefined && value !== null) return value;
    }
    // Case-insensitive second pass: the USFS wilderness layer accepts
    // WILDERNESSNAME in outFields and answers with wildernessname.
    const lowered = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
    for (const name of names) {
      const actual = lowered.get(name.toLowerCase());
      if (actual !== undefined) {
        const value = obj[actual];
        if (value !== undefined && value !== null) {
          warnOnce(
            `${context}: found "${actual}" but asked for "${name}" — case differs`,
            `${context}:case:${name}`,
          );
          return value;
        }
      }
    }
  }
  warnOnce(
    `${context}: none of [${names.join(', ')}] present. Keys: ${
      obj ? Object.keys(obj).slice(0, 12).join(', ') || '(none)' : '(no object)'
    }`,
    `${context}:${names.join('|')}`,
  );
  return undefined;
}

/**
 * @param {string} message
 * @param {string} key
 */
function warnOnce(message, key) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[BPNav] ${message}`);
}

/** Exported for tests, which need each case to warn independently. */
export function _resetApiFieldWarnings() {
  warned.clear();
}
