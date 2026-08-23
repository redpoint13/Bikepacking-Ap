/**
 * ui/radarCards.js — Resource Radar cards component controller.
 */

import { waypointsOfType } from '../gpx.js';
import { getActiveStopIds } from '../plan.js';

export const ICONS = {
  logo: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="2" x2="12" y2="6"/>
    <line x1="12" y1="18" x2="12" y2="22"/>
    <line x1="2" y1="12" x2="6" y2="12"/>
    <line x1="18" y1="12" x2="22" y2="12"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>`,

  water: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">
    <path d="M12 2C12 2 4 10.5 4 15a8 8 0 0 0 16 0C20 10.5 12 2 12 2z"/>
  </svg>`,

  resupply: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">
    <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
    <line x1="3" y1="6" x2="21" y2="6"/>
    <path d="M16 10a4 4 0 0 1-8 0"/>
  </svg>`,

  daylight: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">
    <circle cx="12" cy="12" r="4"/>
    <line x1="12" y1="2" x2="12" y2="5"/>
    <line x1="12" y1="19" x2="12" y2="22"/>
    <line x1="4.22" y1="4.22" x2="6.34" y2="6.34"/>
    <line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/>
    <line x1="2" y1="12" x2="5" y2="12"/>
    <line x1="19" y1="12" x2="22" y2="12"/>
    <line x1="4.22" y1="19.78" x2="6.34" y2="17.66"/>
    <line x1="17.66" y1="6.34" x2="19.78" y2="4.22"/>
  </svg>`,
};

export const IDLE_CARDS = [
  {
    id: 'water',
    label: 'Next Drink',
    icon: ICONS.water,
    value: '—',
    detail: 'Load a route to surface water sources',
    state: 'idle',
    reliability: 0,
  },
  {
    id: 'resupply',
    label: 'Next Resupply',
    icon: ICONS.resupply,
    value: '—',
    detail: 'Load a route to find stores, food & fuel',
    state: 'idle',
  },
  {
    id: 'daylight',
    label: 'Next Camp',
    icon: ICONS.daylight,
    value: '—',
    detail: 'Load a route to find camp spots',
    state: 'idle',
  },
];

/**
 * Renders an individual resource card template string.
 * @param {typeof IDLE_CARDS[0]} card
 */
export function renderResourceCard(card) {
  const reliabilityBar =
    card.reliability !== undefined
      ? `<div class="card-reliability" role="meter" aria-label="Source reliability"
            aria-valuenow="${card.reliability}" aria-valuemin="0" aria-valuemax="100">
           <div class="card-reliability__fill" style="width: ${card.reliability}%"></div>
         </div>`
      : '';

  return `
    <article class="resource-card resource-card--${card.state}" data-resource="${card.id}">
      <div class="card-icon" aria-hidden="true">${card.icon}</div>
      <div class="card-body">
        <p class="card-label">${card.label}</p>
        <p class="card-value">${card.value}</p>
        <p class="card-detail">${card.detail}</p>
        ${reliabilityBar}
      </div>
    </article>
  `;
}

/**
 * Updates the Resource Radar cards based on route data and position.
 * @param {HTMLElement} container
 * @param {import('../gpx.js').RouteContext} route
 * @param {object} planOptions
 * @param {number} [currentMile=0]
 * @returns {object|null} Returns next resource object for voice reporting.
 */
export function updateResourceCards(container, route, planOptions, currentMile = 0) {
  if (!container || !route) return null;

  const waterWpts = waypointsOfType(route, 'water');
  const resupplyWpts = waypointsOfType(route, 'resupply');
  const campWpts = waypointsOfType(route, 'camping');

  const activeStopIds = getActiveStopIds(route, planOptions);
  const nextWater =
    route.waypoints.find(
      (w) => w.type === 'water' && w.distanceFromStartMi > currentMile && activeStopIds.has(w.id),
    ) ?? null;
  const nextResupply =
    route.waypoints.find(
      (w) =>
        w.type === 'resupply' && w.distanceFromStartMi > currentMile && activeStopIds.has(w.id),
    ) ?? null;
  const nextCamp =
    route.waypoints.find(
      (w) => w.type === 'camping' && w.distanceFromStartMi > currentMile && activeStopIds.has(w.id),
    ) ?? null;

  const distWater = nextWater ? nextWater.distanceFromStartMi - currentMile : 0;
  const distResupply = nextResupply ? nextResupply.distanceFromStartMi - currentMile : 0;
  const distCamp = nextCamp ? nextCamp.distanceFromStartMi - currentMile : 0;

  let currentNextResource = null;
  if (nextWater && (!nextCamp || distWater < distCamp)) {
    currentNextResource = { type: 'water', distance: distWater };
  } else if (nextCamp) {
    currentNextResource = { type: 'camp', distance: distCamp };
  }

  const cards = [
    {
      id: 'water',
      label: 'Next Drink',
      icon: ICONS.water,
      value: nextWater ? `${distWater.toFixed(1)} mi` : 'None found',
      detail: nextWater ? nextWater.name : `${waterWpts.length} sources mapped`,
      state: nextWater ? 'active' : 'idle',
      reliability: nextWater?.reliability ?? 0,
    },
    {
      id: 'resupply',
      label: 'Next Resupply',
      icon: ICONS.resupply,
      value: nextResupply ? `${distResupply.toFixed(1)} mi` : 'None found',
      detail: nextResupply ? nextResupply.name : `${resupplyWpts.length} options mapped`,
      state: nextResupply ? 'active' : 'idle',
    },
    {
      id: 'daylight',
      label: 'Next Camp',
      icon: ICONS.daylight,
      value: nextCamp ? `${distCamp.toFixed(1)} mi` : '—',
      detail: nextCamp
        ? `${nextCamp.name}${nextCamp.landManager ? ` (${nextCamp.landManager})` : ''}`
        : campWpts.length > 0
          ? `${campWpts.length} camp spots mapped`
          : 'No camps found yet',
      state: nextCamp ? 'active' : 'idle',
    },
  ];

  const cardsEl = container.querySelector('#resource-cards');
  if (cardsEl) {
    cardsEl.innerHTML = cards.map(renderResourceCard).join('');
  }

  return currentNextResource;
}
