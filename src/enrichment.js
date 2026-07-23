/**
 * enrichment.js — Waypoint metadata auto-enrichment & classification helper.
 *
 * Classifies waypoints into 4-tier resupply categories, camp tiers, and water reliability
 * scores from OSM tags, names, descriptions, and user overrides.
 *
 * @module enrichment
 */

/**
 * 4-Tier Resupply Categories:
 * - 'grocery': Full Grocery / Supermarket / General Store (resets camp meals & snacks)
 * - 'cstore': Gas Station / Convenience / Truck Stop (resets snacks & basic instant trail food)
 * - 'restaurant': Restaurant / Sit-down / Cafe / Diner (immediate sit-down meal, saves 1 camp dinner)
 * - 'none': Water or Camp-only (no food resupply)
 */
export const RESUPPLY_TIERS = {
  GROCERY: { id: 'grocery', label: 'Full Grocery Store', badgeCls: 'resupply-grocery' },
  CSTORE: { id: 'cstore', label: 'Gas Station / C-Store', badgeCls: 'resupply-cstore' },
  RESTAURANT: { id: 'restaurant', label: 'Restaurant / Diner', badgeCls: 'resupply-restaurant' },
  NONE: { id: 'none', label: 'No Resupply', badgeCls: 'resupply-none' },
};

/**
 * Infers the 4-tier resupply category from waypoint attributes.
 * @param {string} name
 * @param {string} [description]
 * @param {Object} [tags]
 * @returns {'grocery' | 'cstore' | 'restaurant' | 'none'}
 */
export function inferResupplyCategory(name = '', description = '', tags = {}) {
  if (tags && tags.resupplyCategory) return tags.resupplyCategory;

  if (tags && (tags.shop === 'supermarket' || tags.shop === 'grocery' || tags.shop === 'general')) {
    return 'grocery';
  }
  if (tags && (tags.amenity === 'fuel' || tags.shop === 'convenience' || tags.amenity === 'truck_stop')) {
    return 'cstore';
  }
  if (
    tags &&
    (tags.amenity === 'restaurant' ||
      tags.amenity === 'cafe' ||
      tags.amenity === 'pub' ||
      tags.amenity === 'fast_food' ||
      tags.amenity === 'diner')
  ) {
    return 'restaurant';
  }

  const text = `${name} ${description}`.toLowerCase();

  // Full Grocery keywords
  if (
    text.includes('grocery') ||
    text.includes('supermarket') ||
    text.includes('general store') ||
    text.includes('safeway') ||
    text.includes('kroger') ||
    text.includes('walmart') ||
    text.includes('sprouts') ||
    text.includes('albertsons') ||
    text.includes('whole foods') ||
    text.includes('full resupply')
  ) {
    return 'grocery';
  }

  // Gas Station / C-Store keywords
  if (
    text.includes('gas station') ||
    text.includes('c-store') ||
    text.includes('convenience') ||
    text.includes('chevron') ||
    text.includes('shell') ||
    text.includes('7-eleven') ||
    text.includes('circle k') ||
    text.includes('maverik') ||
    text.includes('speedway') ||
    text.includes('truck stop') ||
    text.includes('pilot') ||
    text.includes('express') ||
    text.includes('fuel') ||
    text.includes('travel center')
  ) {
    return 'cstore';
  }

  // Restaurant keywords
  if (
    text.includes('restaurant') ||
    text.includes('diner') ||
    text.includes('cafe') ||
    text.includes('café') ||
    text.includes('grill') ||
    text.includes('pub') ||
    text.includes('bar') ||
    text.includes('pizza') ||
    text.includes('burger') ||
    text.includes('taco') ||
    text.includes('bistro') ||
    text.includes('eatery') ||
    text.includes('bakery') ||
    text.includes('sit-down')
  ) {
    return 'restaurant';
  }

  return 'cstore';
}

/**
 * Classifies camp tier (short, medium, long, dispersed).
 * @param {string} name
 * @param {string} [description]
 * @param {number} [distanceFromStartMi]
 * @returns {'short' | 'medium' | 'long' | 'dispersed'}
 */
export function inferCampTier(name = '', description = '', distanceFromStartMi = 0) {
  const text = `${name} ${description}`.toLowerCase();
  if (text.includes('short')) return 'short';
  if (text.includes('medium')) return 'medium';
  if (text.includes('long')) return 'long';
  if (text.includes('dispersed') || text.includes('blm') || text.includes('usfs') || text.includes('primitive')) {
    return 'dispersed';
  }
  return 'medium';
}

/**
 * Enrich a waypoint with 4-tier resupply category, camp tier, default hours, and notes.
 * @param {import('./gpx.js').Waypoint} wp
 * @returns {import('./gpx.js').Waypoint}
 */
export function enrichWaypointMetadata(wp) {
  const resupplyCategory =
    wp.type === 'resupply' ? inferResupplyCategory(wp.name, wp.description, wp.tags || {}) : 'none';
  const campTier = wp.type === 'camping' ? inferCampTier(wp.name, wp.description, wp.distanceFromStartMi) : null;

  return {
    ...wp,
    resupplyCategory: wp.resupplyCategory || resupplyCategory,
    campTier: wp.campTier || campTier,
    hours: wp.hours || (wp.type === 'resupply' ? '6:00 AM - 9:00 PM' : null),
    phone: wp.phone || null,
    notes: wp.notes || '',
    stopState: wp.stopState || 'optional', // 'planned' | 'optional' | 'skipped'
  };
}
