import {
  generateStartChecklist,
  generateStopChecklists,
  getChecklistSummaryMarkdown,
} from './checklist.js';
/**
 * planning.js — Planning mode UI for Bikepacker Navigator.
 *
 * Renders the pre-ride planning surface: tunable parameters, water-carry and
 * food-carry summaries, a multi-day plan with short/medium/long camp options,
 * and the full resource log (the on-device equivalent of the curated trip
 * spreadsheet). Pure rendering + event wiring; all computation lives in
 * plan.js and triplog.js.
 *
 * @module planning
 */

import { buildDaySegmentAnalytics, computeSegmentAnalytics } from './analytics.js';
import { isVoiceEnabled, setVoiceEnabled, speak } from './audio.js';
import { calculateRouteDifficulty } from './difficulty.js';
import { exportPDFItinerary, generateGPX, sharePlan } from './export.js';
import { PLAN_DEFAULTS, buildPlan, getActiveStopIds, optimizeWaterStops } from './plan.js';
import { exportPlanBundle } from './storage.js';
import { openSegmentDrawer } from './ui/segmentDrawer.js';

// ---------------------------------------------------------------------------
// Helpers for coordinate mapping and map panning links
// ---------------------------------------------------------------------------

let planRoute = null;

function findWpCoords(name, mi) {
  if (!planRoute) return null;
  let match = planRoute.waypoints.find((w) => w.name === name);
  if (!match && mi != null) {
    match = planRoute.waypoints.find((w) => Math.abs(w.distanceFromStartMi - mi) < 0.15);
  }
  return match ? { lat: match.lat, lon: match.lon } : null;
}

function mapPanLink(name, mi) {
  const coords = findWpCoords(name, mi);
  if (coords) {
    return `<button class="map-pan-btn" data-lat="${coords.lat}" data-lon="${coords.lon}" title="Pan to map location" style="
      background: none;
      border: none;
      color: var(--md-sys-color-primary, #1b5e20);
      text-decoration: underline dashed;
      cursor: pointer;
      padding: 0;
      font: inherit;
      text-align: left;
    ">${name}</button>`;
  }
  return name;
}

import { describeError } from './errorBoundary.js';
import { buildResourceLog } from './triplog.js';
import { setHTML } from './utils/dom.js';

// ---------------------------------------------------------------------------
// Module state — current planning parameters (persist across re-renders)
// ---------------------------------------------------------------------------

function getPlanDefaults() {
  const defaults = { ...PLAN_DEFAULTS };

  const targetDailyMiles = localStorage.getItem('bpnav-targetDailyMiles');
  if (targetDailyMiles !== null) defaults.targetDailyMiles = Number(targetDailyMiles);

  const waterCapacityOz = localStorage.getItem('bpnav-waterCapacityOz');
  if (waterCapacityOz !== null) defaults.waterCapacityOz = Number(waterCapacityOz);

  const ozPerMile = localStorage.getItem('bpnav-ozPerMile');
  if (ozPerMile !== null) defaults.ozPerMile = Number(ozPerMile);

  const reliableWaterThreshold = localStorage.getItem('bpnav-reliableWaterThreshold');
  if (reliableWaterThreshold !== null)
    defaults.reliableWaterThreshold = Number(reliableWaterThreshold);

  return defaults;
}

/** @type {typeof PLAN_DEFAULTS} */
let planOptions = getPlanDefaults();

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const mi = (n) => (n == null ? '—' : `${n} mi`);
const oz = (n) => (n == null ? '—' : `${n} oz`);

const TYPE_BADGE = {
  WATER: { label: 'Water', cls: 'water' },
  FOOD: { label: 'Resupply', cls: 'resupply' },
  CAMP: { label: 'Camp', cls: 'camping' },
  SUMMIT: { label: 'Summit', cls: 'summit' },
  GENERIC: { label: '·', cls: 'generic' },
};

// ---------------------------------------------------------------------------
// Sub-renderers
// ---------------------------------------------------------------------------

/** Tunable parameter controls. @param {typeof PLAN_DEFAULTS} o */
function renderControls(o) {
  return `
    <div class="plan-controls" id="plan-controls">
      <label class="plan-field">
        <span class="plan-field__label">Daily target</span>
        <span class="plan-field__inputwrap">
          <input class="plan-input" type="number" id="plan-daily" min="5" step="5"
            value="${o.targetDailyMiles}" /> <span class="plan-field__unit">mi</span>
        </span>
      </label>
      <label class="plan-field">
        <span class="plan-field__label">Water capacity</span>
        <span class="plan-field__inputwrap">
          <input class="plan-input" type="number" id="plan-capacity" min="16" step="8"
            value="${o.waterCapacityOz}" /> <span class="plan-field__unit">oz</span>
        </span>
      </label>
      <label class="plan-field">
        <span class="plan-field__label">Use rate</span>
        <span class="plan-field__inputwrap">
          <input class="plan-input" type="number" id="plan-ozmile" min="1" step="1"
            value="${o.ozPerMile}" /> <span class="plan-field__unit">oz/mi</span>
        </span>
      </label>
      <label class="plan-field">
        <span class="plan-field__label">Reliable water ≥</span>
        <span class="plan-field__inputwrap">
          <input class="plan-input" type="number" id="plan-reliability" min="0" max="100" step="5"
            value="${o.reliableWaterThreshold}" /> <span class="plan-field__unit">%</span>
        </span>
      </label>
      <label class="plan-field">
        <span class="plan-field__label">Calorie target</span>
        <span class="plan-field__inputwrap">
          <input class="plan-input" type="number" id="plan-calories" min="1000" max="10000" step="100"
            value="${o.caloriesPerDay}" /> <span class="plan-field__unit">kcal/day</span>
        </span>
      </label>
      <label class="plan-field">
        <span class="plan-field__label">Camp meals/day</span>
        <span class="plan-field__inputwrap">
          <input class="plan-input" type="number" id="plan-campmeals" min="0" max="5" step="1"
            value="${o.campMealsPerDay}" /> <span class="plan-field__unit">meals</span>
        </span>
      </label>
      <label class="plan-field">
        <span class="plan-field__label">Camp meal cal</span>
        <span class="plan-field__inputwrap">
          <input class="plan-input" type="number" id="plan-campcal" min="200" max="2000" step="50"
            value="${o.caloriesPerCampMeal}" /> <span class="plan-field__unit">kcal</span>
        </span>
      </label>
      <label class="plan-field">
        <span class="plan-field__label">Avg snack cal</span>
        <span class="plan-field__inputwrap">
          <input class="plan-input" type="number" id="plan-snackcal" min="50" max="1000" step="10"
            value="${o.avgSnackCalories}" /> <span class="plan-field__unit">kcal</span>
        </span>
      </label>
      <label class="plan-field" style="grid-column: span 2;">
        <span class="plan-field__label">Terrain Surface Type</span>
        <span class="plan-field__inputwrap">
          <select class="plan-input" id="plan-surface-factor" style="padding: 4px 8px; font-size: 12px; height: 32px; width: 100%; border-radius: 4px;">
            <option value="1.0" ${o.surfaceFactor === 1.0 ? 'selected' : ''}>🛣️ Paved Road (1.0x)</option>
            <option value="1.2" ${o.surfaceFactor === 1.2 || !o.surfaceFactor ? 'selected' : ''}>🏔️ Gravel / Dirt Road (1.2x)</option>
            <option value="1.6" ${o.surfaceFactor === 1.6 ? 'selected' : ''}>🌲 Technical Singletrack (1.6x)</option>
            <option value="2.0" ${o.surfaceFactor === 2.0 ? 'selected' : ''}>🏜️ Rough / Sand / Rock (2.0x)</option>
          </select>
        </span>
      </label>
      <label class="plan-field" style="grid-column: span 2;">
        <span class="plan-field__label">Max detour distance (exclude stops further off-route unless necessary)</span>
        <span class="plan-field__inputwrap">
          <input class="plan-input" type="number" id="plan-detour" min="0.1" max="25" step="0.1"
            value="${o.maxDetourMi}" /> <span class="plan-field__unit">mi</span>
        </span>
      </label>
      <label class="plan-field plan-field--checkbox" style="grid-column: span 2; display: flex; align-items: center; gap: 8px; cursor: pointer;">
        <input class="plan-checkbox" type="checkbox" id="plan-optimize-water"
          ${o.optimizeWaterStops ? 'checked' : ''} />
        <span class="plan-field__label" style="margin: 0; font-weight: 600;">Smart Water Refill Optimization (Skip intermediate sources)</span>
      </label>
      <div class="plan-controls__sub" id="plan-optimize-details" style="grid-column: span 2; display: ${o.optimizeWaterStops ? 'flex' : 'none'}; flex-wrap: wrap; gap: 12px; width: 100%; border-top: 1px dashed var(--md-sys-color-outline-variant); padding-top: 12px; margin-top: 4px;">
        <label class="plan-field" style="flex: 1 1 140px;">
          <span class="plan-field__label">Target Refill Distance</span>
          <span class="plan-field__inputwrap">
            <input class="plan-input" type="number" id="plan-target-water-interval" min="5" max="80" step="1"
              value="${o.targetWaterIntervalMi ?? 20}" /> <span class="plan-field__unit">mi</span>
          </span>
        </label>
        <label class="plan-field" style="flex: 1 1 140px;">
          <span class="plan-field__label">Safety Reserve Margin</span>
          <span class="plan-field__inputwrap">
            <input class="plan-input" type="number" id="plan-water-safety-margin" min="5" max="50" step="5"
              value="${o.waterSafetyMarginPercent ?? 20}" /> <span class="plan-field__unit">%</span>
          </span>
        </label>
        <label class="plan-field" style="flex: 1 1 140px;">
          <span class="plan-field__label">Camp Water Reserve</span>
          <span class="plan-field__inputwrap">
            <input class="plan-input" type="number" id="plan-camp-water-reserve" min="0" max="150" step="10"
              value="${o.campWaterReserveOz ?? 40}" /> <span class="plan-field__unit">oz</span>
          </span>
        </label>
      </div>
      <div style="grid-column: span 2; display: flex; align-items: center; justify-content: space-between; gap: 8px; background: var(--md-sys-color-surface-container, #1a1c1e); padding: 10px 14px; border-radius: 8px; border: 1px solid var(--md-sys-color-outline-variant); margin-top: 4px;">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; margin: 0;">
          <input class="plan-checkbox" type="checkbox" id="plan-voice-toggle" ${isVoiceEnabled() ? 'checked' : ''} />
          <span style="font-weight: 600; font-size: 12px; color: var(--md-sys-color-on-surface);">Enable Trail-Talk Audio Prompts 🔊</span>
        </label>
        <button type="button" id="plan-read-summary-btn" style="
          background-color: var(--md-sys-color-secondary-container, #e8f5e9);
          color: var(--md-sys-color-on-secondary-container, #1b5e20);
          border: 1px solid var(--md-sys-color-outline-variant);
          border-radius: 100px;
          padding: 4px 12px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
        ">
          Read Summary 🔊
        </button>
      </div>
    </div>
  `;
}

/** Water-carry dry stretches. @param {ReturnType<typeof buildPlan>['waterCarry']} stretches */
function renderWaterCarry(stretches) {
  if (!stretches.length) {
    return '<p class="plan-empty">No reliable water sources mapped yet.</p>';
  }
  const rows = stretches
    .map((s) => {
      const alert = s.exceedsCapacity ? ' plan-row--alert' : '';
      const warn = s.exceedsCapacity ? `<span class="plan-flag">over capacity</span>` : '';
      const campTag = s.isCampRefill
        ? `<span style="background: rgba(41, 182, 246, 0.18); color: #29b6f6; border-radius: 4px; padding: 2px 6px; font-size: 10px; font-weight: 700; margin-left: 6px;">⛺ Camp Refill (+${planOptions.campWaterReserveOz ?? 40} oz)</span>`
        : '';
      return `
        <li class="plan-row${alert}">
          <div class="plan-row__main">
            <span class="plan-row__span">${mapPanLink(s.fromName, s.fromMi)} → ${mapPanLink(s.toName, s.toMi)}</span>
            <span class="plan-row__miles">${Number(s.miles).toFixed(1)} mi</span>
          </div>
          <div class="plan-row__sub">
            Carry ≈ ${oz(s.recommendedOz)} ${warn} ${campTag}
          </div>
        </li>`;
    })
    .join('');
  return `<ul class="plan-list">${rows}</ul>`;
}

/** Food-carry spans. @param {ReturnType<typeof buildPlan>['foodCarry']} spans */
function renderFoodCarry(spans) {
  if (!spans.length) {
    return '<p class="plan-empty">No resupply points mapped yet.</p>';
  }

  const startLeg = spans[0];
  const startLbs = (startLeg.weightOz / 16).toFixed(1);

  const startBanner = `
    <div class="starting-food-card" style="
      background-color: var(--md-sys-color-primary-container, #00522a);
      color: var(--md-sys-color-on-primary-container, #9af0ae);
      padding: var(--spacing-md);
      border-radius: var(--md-sys-shape-corner-medium, 12px);
      margin-bottom: var(--spacing-md);
      border: 1px solid var(--md-sys-color-primary);
    ">
      <div style="font-weight: 700; font-size: 13px; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between;">
        <span>📦 INITIAL STARTING FOOD PACKAGE</span>
        <span style="font-size: 11px; background: rgba(0,0,0,0.3); padding: 2px 8px; border-radius: 12px;">Pack at Start</span>
      </div>
      <div style="font-size: 12px; line-height: 1.5; margin-bottom: 8px;">
        To reach your first resupply at <strong>${mapPanLink(startLeg.toName, startLeg.toMi)}</strong> (mile ${Number(startLeg.toMi).toFixed(1)}, ${Number(startLeg.miles).toFixed(1)} mi away / ${startLeg.daysFloat} days), start your ride with:
      </div>
      <div style="display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; font-weight: 600;">
        <span>🍽️ <strong>${startLeg.campMeals}</strong> camp meals</span>
        <span>🍫 <strong>${startLeg.snacks}</strong> snacks</span>
        <span>🔥 <strong>${startLeg.calories.toLocaleString()}</strong> kcal</span>
        <span>⚖️ <strong>${startLeg.weightOz} oz</strong> (${startLbs} lbs)</span>
      </div>
    </div>`;

  const rows = spans
    .map((s, idx) => {
      const lbs = (s.weightOz / 16).toFixed(1);
      const isStart = idx === 0;
      const badge = isStart
        ? `<span style="font-size: 10px; background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container); padding: 2px 6px; border-radius: 4px; font-weight: 700;">START PACK</span>`
        : `<span style="font-size: 10px; background: var(--md-sys-color-surface-container-high); color: var(--md-sys-color-on-surface); padding: 2px 6px; border-radius: 4px; font-weight: 700;">REFILL</span>`;

      return `
        <li class="plan-row" style="display: flex; flex-direction: column; gap: 6px; padding: var(--spacing-sm); border-bottom: 1px solid var(--md-sys-color-outline-variant);">
          <div class="plan-row__main" style="display: flex; justify-content: space-between; align-items: center; font-weight: 600; width: 100%;">
            <span class="plan-row__span">${badge} ${mapPanLink(s.fromName, s.fromMi)} → ${mapPanLink(s.toName, s.toMi)}</span>
            <span class="plan-row__miles" style="font-variant-numeric: tabular-nums;">${s.miles} mi</span>
          </div>
          <div class="plan-row__sub" style="display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--md-sys-color-on-surface-variant); width: 100%; text-align: left;">
            <div>📅 Carry duration: <strong>${s.daysFloat}</strong> days (${Number(s.miles).toFixed(1)} mi)</div>
            <div style="display: flex; gap: 12px; margin-top: 2px; flex-wrap: wrap;">
              <span>🍽️ <strong>${s.campMeals}</strong> meals</span>
              <span>🍫 <strong>${s.snacks}</strong> snacks</span>
              <span>🔥 <strong>${s.calories.toLocaleString()}</strong> kcal</span>
              <span>⚖️ <strong>${s.weightOz} oz</strong> (${lbs} lbs)</span>
            </div>
          </div>
        </li>`;
    })
    .join('');

  return `${startBanner}<ul class="plan-list" style="list-style: none; padding: 0; margin: 0; width: 100%;">${rows}</ul>`;
}

/** One camp option chip within a day card. @param {string} kind @param {object|null} opt @param {boolean} isChosen @param {number} dayNum */
function renderDayOption(kind, opt, isChosen, dayNum) {
  if (!opt) return '';
  const chosen = isChosen ? ' day-option--chosen' : '';
  const water =
    opt.nextWaterMi == null
      ? 'none ahead'
      : `${opt.nextWaterMi} mi to ${opt.nextWaterName || 'water'}`;
  const food =
    opt.nextFoodMi == null
      ? 'none ahead'
      : `${opt.nextFoodMi} mi to ${opt.nextFoodName || 'resupply'}`;

  const waterLeg = opt.waterOptions > 0 ? ` · 💧 ${opt.waterOptions} on leg` : '';
  const foodLeg = opt.resupplyOptions > 0 ? ` · 🛒 ${opt.resupplyOptions} on leg` : '';

  const diffBadge = opt.difficulty
    ? `<span class="difficulty-chip difficulty-chip--${opt.difficulty.difficultyRating.cls}" style="font-size: 10px; padding: 1px 6px; border-radius: 4px; font-weight: 700;">${opt.difficulty.difficultyRating.badge} (${opt.difficulty.difficultyScore})</span>`
    : '';

  const habPill =
    opt.difficulty?.hikeABike && opt.difficulty.hikeABike.distanceMi > 0
      ? `<span style="color: var(--md-sys-color-tertiary, #f4b400); font-weight: 700; font-size: 10px;">⚠️ HAB: ${opt.difficulty.hikeABike.distanceMi} mi (${opt.difficulty.hikeABike.pitchCount} pitches ≥15%)</span>`
      : '';

  const hilliness = opt.difficulty ? ` (${opt.difficulty.hillinessFtPerMi} ft/mi)` : '';

  const campWaterChip = opt.waterAvailable
    ? opt.waterAvailable === 'potable' ||
      opt.waterAvailable === true ||
      opt.waterAvailable === 'yes'
      ? `<span style="font-size: 10px; color: #81c784; font-weight: 600;">💧 Potable Water</span>`
      : opt.waterAvailable === 'natural' || opt.waterAvailable === 'stream'
        ? `<span style="font-size: 10px; color: #4fc3f7; font-weight: 600;">💧 Stream / Filter</span>`
        : opt.waterAvailable === 'none' ||
            opt.waterAvailable === false ||
            opt.waterAvailable === 'no'
          ? `<span style="font-size: 10px; color: #ffb74d; font-weight: 600;">🚫 Dry Camp</span>`
          : ''
    : '';

  const campFeeChip = opt.fee
    ? String(opt.fee).toLowerCase() === 'free'
      ? `<span style="font-size: 10px; color: #a5d6a7; font-weight: 600;">🆓 Free</span>`
      : `<span style="font-size: 10px; color: #ce93d8; font-weight: 600;">💲 ${opt.fee}</span>`
    : '';

  const amenitiesPills =
    campWaterChip || campFeeChip
      ? `<div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px;">${campWaterChip}${campFeeChip}</div>`
      : '';

  return `
    <div class="day-option${chosen}" data-action="select-day-camp" data-day="${dayNum}" data-target-kind="${kind.toLowerCase()}" data-id="${opt.campId}" style="cursor: pointer;">
      <div class="day-option__head" style="display: flex; justify-content: space-between; align-items: center;">
        <span class="day-option__kind">${kind} Day</span>
        <span class="day-option__miles">${Number(opt.miles).toFixed(1)} mi</span>
      </div>
      <div style="margin-top: 2px;">${diffBadge}</div>
      <p class="day-option__camp" style="margin-top: 4px;">${mapPanLink(opt.campName, opt.endMi)}</p>
      ${amenitiesPills}
      <p class="day-option__meta" style="margin-top: 4px; display: flex; flex-direction: column; gap: 2px;">
        <span style="font-weight: 500;">@ mile ${Number(opt.endMi).toFixed(1)}</span>
        <span style="font-size: 10px; opacity: 0.8;">📈 +${(opt.eleGainFt || 0).toLocaleString()} ft${hilliness} &nbsp;📉 -${(opt.eleLossFt || 0).toLocaleString()} ft</span>
        ${habPill}
        <span>💧 ${water}${waterLeg}</span>
        <span>🛒 ${food}${foodLeg}</span>
      </p>
    </div>`;
}

/** Day plan cards. @param {ReturnType<typeof buildPlan>['dayPlan']} dayPlan */
function renderDayPlan(dayPlan) {
  if (!dayPlan.length) {
    return '<p class="plan-empty">No camp spots mapped yet — load camps to build a day plan.</p>';
  }
  return dayPlan
    .map((d) => {
      const chosenId = d.chosen?.campId;
      const opts = [
        renderDayOption('Short', d.options.short, d.options.short?.campId === chosenId, d.day),
        renderDayOption('Medium', d.options.medium, d.options.medium?.campId === chosenId, d.day),
        renderDayOption('Long', d.options.long, d.options.long?.campId === chosenId, d.day),
      ].join('');
      const optionsHtml =
        opts.trim().length > 0
          ? opts
          : renderDayOption(d.chosen?.isFinish ? 'Finish' : 'Camp', d.chosen, true, d.day);
      return `
        <article class="day-card">
          <header class="day-card__head">
            <span class="day-card__num">Day ${d.day}</span>
            <span class="day-card__range">mile ${d.startMi} → ${d.chosen.endMi}
              · ${d.chosen.miles} mi</span>
          </header>
          <div class="day-card__options">${optionsHtml}</div>
        </article>`;
    })
    .join('');
}

/**
 * Full resource log table.
 * @param {ReturnType<typeof buildResourceLog>} log
 * @param {Set<string>} [activeStopIds]
 */
function renderLogTable(log, activeStopIds = new Set()) {
  const rows = log.entries
    .map((e) => {
      const badge = TYPE_BADGE[e.type] ?? TYPE_BADGE.GENERIC;
      const rel = e.reliability != null ? ` · ${e.reliability}% rel` : '';

      const wp = planRoute ? planRoute.waypoints.find((w) => w.id === e.id) : null;
      const stopState = planOptions.userStopStates?.[e.id] || 'optional';

      let resupplyBadge = '';
      if (e.type === 'FOOD' || wp?.type === 'resupply') {
        const cat = wp?.resupplyCategory || 'cstore';
        const catBadges = {
          grocery: '<span class="resupply-tier-badge resupply-tier-grocery">🛒 Grocery</span>',
          cstore: '<span class="resupply-tier-badge resupply-tier-cstore">⛽ Gas/C-Store</span>',
          restaurant:
            '<span class="resupply-tier-badge resupply-tier-restaurant">🍽️ Restaurant</span>',
          none: '<span class="resupply-tier-badge resupply-tier-none">No Resupply</span>',
        };
        resupplyBadge = catBadges[cat] || catBadges.cstore;
      }

      let toggleBtn = '';
      if (
        (e.type === 'WATER' || e.type === 'FOOD' || e.type === 'CAMP') &&
        !e.landmark.includes('Start') &&
        !e.landmark.includes('Finish')
      ) {
        const isStop = activeStopIds.has(e.id);
        const stateIcons = {
          planned: '✅ Planned Stop',
          skipped: '🚫 Skipped',
          optional: isStop ? '⚪ Auto Stop' : '⚪ Pass/Optional',
        };
        const stateColors = {
          planned: 'color: var(--md-sys-color-primary); font-weight: 700;',
          skipped: 'color: var(--md-sys-color-error); text-decoration: line-through;',
          optional: 'color: var(--md-sys-color-on-surface-variant);',
        };

        toggleBtn = `
          <button class="log-water-toggle-btn" data-action="toggle-stop" data-id="${e.id}" title="Click to cycle: Auto -> Planned Stop -> Skip" style="
            background: rgba(255,255,255,0.06);
            border: 1px solid var(--md-sys-color-outline-variant);
            border-radius: 4px;
            cursor: pointer;
            font-size: 10px;
            margin-right: 6px;
            padding: 2px 6px;
            ${stateColors[stopState]}
          ">
            ${stateIcons[stopState]}
          </button>
        `;
      }

      const isSummit = e.type === 'SUMMIT';
      const rowStyle = isSummit
        ? ' style="background-color: var(--md-sys-color-surface-container-low, #f0f4f1); font-weight: 600;"'
        : '';

      const offCourseDist = e.offCourseDistanceMi || 0;
      const offCourseLabel =
        offCourseDist > 0.2
          ? `${offCourseDist.toFixed(1)} mi`
          : `${Math.round(offCourseDist * 5280)} ft`;
      const offCourseBadge =
        offCourseDist * 5280 > 300
          ? `<span class="log-badge log-badge--off-course" style="
             background-color: var(--md-sys-color-error-container, #ffdad6);
             color: var(--md-sys-color-error, #ba1a1a);
             font-size: 10px;
             font-weight: 700;
             padding: 2px 6px;
             border-radius: 4px;
             margin-left: 6px;
             display: inline-flex;
             align-items: center;
             gap: 2px;
             border: 1px solid var(--md-sys-color-error);
           ">⚠️ ${offCourseLabel} detour</span>`
          : '';

      return `
        <tr${rowStyle}>
          <td class="log-mi">${Number(e.cumulativeMi).toFixed(1)}</td>
          <td class="log-name">
            ${toggleBtn}
            ${mapPanLink(e.landmark, e.cumulativeMi)}
            <span class="log-badge log-badge--${badge.cls}">${badge.label}${rel}</span>
            ${resupplyBadge}
            ${offCourseBadge}
          </td>
          <td class="log-num">${mi(e.milesToNextWater)}</td>
          <td class="log-num">${mi(e.milesToNextFood)}</td>
        </tr>`;
    })
    .join('');
  return `
    <div class="log-table-wrap">
      <table class="log-table">
        <thead>
          <tr>
            <th>Mile</th><th>Landmark</th><th>→ Water</th><th>→ Food</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/**
 * Renders the Segment Analytics Cards section for the Planning view.
 * @param {import('./gpx.js').RouteContext} route
 * @param {Object} options
 * @returns {string} HTML string
 */
function renderSegmentAnalyticsSection(route, options) {
  if (!route) return '<p class="plan-empty">Load a route to view segment analytics.</p>';

  const dayAnalytics = buildDaySegmentAnalytics(route, options);
  if (!dayAnalytics.length) return '';

  const cardsHtml = dayAnalytics
    .map((dayItem) => {
      const a = dayItem.analytics;
      const diffBadge = a.difficulty
        ? `<span class="difficulty-chip difficulty-chip--${a.difficulty.difficultyRating.cls}" style="font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 700;">${a.difficulty.difficultyRating.badge} (Score: ${a.difficulty.difficultyScore})</span>`
        : '';

      const habBadge =
        a.difficulty?.hikeABike && a.difficulty.hikeABike.distanceMi > 0
          ? `<span style="color: var(--md-sys-color-tertiary, #f4b400); font-weight: 700; font-size: 11px;">⚠️ ${a.difficulty.hikeABike.distanceMi} mi HAB (${a.difficulty.hikeABike.pitchCount} pitches)</span>`
          : `<span style="color: var(--md-sys-color-primary, #78dc95); font-size: 11px;">🟢 Minimal HAB</span>`;

      const legsHtml = dayItem.legs
        .map((leg) => {
          const la = leg.analytics;
          const legDiff = la.difficulty
            ? `<span class="difficulty-chip difficulty-chip--${la.difficulty.difficultyRating.cls}" style="font-size: 10px; padding: 1px 5px; border-radius: 4px; font-weight: 700;">${la.difficulty.difficultyRating.badge}</span>`
            : '';
          const legHab =
            la.difficulty?.hikeABike && la.difficulty.hikeABike.distanceMi > 0
              ? `<span style="color: var(--md-sys-color-tertiary, #f4b400); font-weight: 600; font-size: 10px;">⚠️ ${la.difficulty.hikeABike.distanceMi}mi HAB</span>`
              : '';

          return `
        <div class="segment-leg-item" data-action="open-segment-drawer" data-start="${la.startMi}" data-end="${la.endMi}" style="
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: rgba(255,255,255,0.03);
          border: 1px solid var(--md-sys-color-outline-variant);
          border-radius: 6px;
          padding: 8px 10px;
          margin-top: 6px;
          font-size: 11px;
          cursor: pointer;
        ">
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <span style="font-weight: 600;">${mapPanLink(leg.fromName, leg.startMi)} → ${mapPanLink(leg.toName, leg.endMi)}</span>
            <span style="opacity: 0.8; font-size: 10px;">${la.distanceMi} mi · 📈 +${la.gainFt.toLocaleString()} ft (${la.hillinessFtPerMi} ft/mi) · ⏱️ ${la.pacing.formattedMovingTime}</span>
          </div>
          <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 2px;">
            ${legDiff}
            ${legHab}
          </div>
        </div>`;
        })
        .join('');

      return `
      <article class="segment-analytics-card" style="
        background: var(--md-sys-color-surface-container, #1c1b1f);
        border: 1px solid var(--md-sys-color-outline-variant, #49454f);
        border-radius: 12px;
        padding: 12px;
        margin-bottom: 12px;
      ">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 8px;">
          <div>
            <h4 style="margin: 0; font-size: 14px; font-weight: 700; color: var(--md-sys-color-on-surface);">
              Day ${dayItem.day} Segment (Mile ${a.startMi} → ${a.endMi})
            </h4>
            <p style="margin: 2px 0 0 0; font-size: 12px; color: var(--md-sys-color-on-surface-variant);">
              Target: ${dayItem.chosenCamp}
            </p>
          </div>
          <div style="display: flex; gap: 6px; align-items: center;">
            ${diffBadge}
            <button class="segment-btn-icon" data-action="open-segment-drawer" data-start="${a.startMi}" data-end="${a.endMi}" style="
              background: var(--md-sys-color-secondary-container, #2e312e);
              color: var(--md-sys-color-on-secondary-container, #c8ecc9);
              border: 1px solid var(--md-sys-color-outline-variant);
              border-radius: 6px;
              padding: 4px 10px;
              font-size: 11px;
              font-weight: 600;
              cursor: pointer;
            ">
              📊 Open Drawer
            </button>
          </div>
        </div>

        ${
          a.narrative?.summaryParagraph
            ? `<div style="margin-top: 8px; background: rgba(255,255,255,0.03); border: 1px solid var(--md-sys-color-outline-variant); border-radius: 6px; padding: 8px 10px; font-size: 11px; line-height: 1.4; color: var(--md-sys-color-on-surface);">
                 <strong>📖 Overview:</strong> ${a.narrative.summaryParagraph}
               </div>`
            : ''
        }

        ${
          a.narrative?.townsAndServices?.length > 0
            ? `<div style="margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center;">
                 <span style="font-size: 10.5px; font-weight: 700; opacity: 0.8;">🏙️ Towns / Services:</span>
                 ${a.narrative.townsAndServices.map((t) => `<span style="font-size: 10.5px; background: rgba(0, 82, 42, 0.35); border: 1px solid var(--md-sys-color-primary, #00522a); color: var(--md-sys-color-on-primary-container, #9af0ae); padding: 1px 6px; border-radius: 4px;">🛒 ${t.name} (mi ${t.mile.toFixed(1)})</span>`).join('')}
               </div>`
            : ''
        }

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; margin-top: 10px; font-size: 11px;">
          <div style="background: rgba(255,255,255,0.02); padding: 6px 8px; border-radius: 6px; border: 1px solid var(--md-sys-color-outline-variant);">
            <span style="opacity: 0.7; font-size: 10px; display: block;">Distance / Ele</span>
            <strong>${a.distanceMi} mi</strong> (+${a.gainFt.toLocaleString()} ft)
          </div>
          <div style="background: rgba(255,255,255,0.02); padding: 6px 8px; border-radius: 6px; border: 1px solid var(--md-sys-color-outline-variant);">
            <span style="opacity: 0.7; font-size: 10px; display: block;">Est. Moving Time</span>
            <strong>⏱️ ${a.pacing.formattedMovingTime}</strong>
          </div>
          <div style="background: rgba(255,255,255,0.02); padding: 6px 8px; border-radius: 6px; border: 1px solid var(--md-sys-color-outline-variant);">
            <span style="opacity: 0.7; font-size: 10px; display: block;">Water / Food</span>
            <strong>💧 ${a.logistics.waterNeededOz} oz</strong> · <strong>🛒 ${a.logistics.caloriesNeededKcal.toLocaleString()} kcal</strong>
          </div>
          <div style="background: rgba(255,255,255,0.02); padding: 6px 8px; border-radius: 6px; border: 1px solid var(--md-sys-color-outline-variant);">
            <span style="opacity: 0.7; font-size: 10px; display: block;">Hike-a-Bike</span>
            ${habBadge}
          </div>
        </div>

        ${
          legsHtml
            ? `
          <div style="margin-top: 10px;">
            <span style="font-size: 11px; font-weight: 600; opacity: 0.8; display: block; margin-bottom: 2px;">Waypoint-to-Waypoint Sub-Legs:</span>
            ${legsHtml}
          </div>`
            : ''
        }
      </article>`;
    })
    .join('');

  return `
    <section class="segment-analytics-section" style="margin-top: 16px;">
      <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
        <span>📊 Segment Analytics & Leg Breakdowns</span>
      </h3>
      ${cardsHtml}
    </section>`;
}

// ---------------------------------------------------------------------------
// Top-level render
// ---------------------------------------------------------------------------

/**
 * Recomputes the plan and paints the dynamic regions. Controls are left intact
 * so input focus is preserved while typing.
 * @param {HTMLElement} root  - the #planning-view element
 */
function repaint(root) {
  if (!planRoute) return;
  const plan = buildPlan(planRoute, planOptions);
  const log = buildResourceLog(planRoute, {
    reliableWaterThreshold: planOptions.reliableWaterThreshold,
  });

  const routeDiff = calculateRouteDifficulty(planRoute, {
    surfaceFactor: planOptions.surfaceFactor,
  });

  // Extract the set of active water stops for popup and log rendering
  const activeStopIds = getActiveStopIds(planRoute, planOptions);

  const longest = plan.waterCarry.reduce((m, s) => Math.max(m, s.miles), 0);

  const diffBadge = routeDiff
    ? `<span class="difficulty-chip difficulty-chip--${routeDiff.difficultyRating.cls}" style="font-weight: 700; padding: 4px 10px; border-radius: 6px; font-size: 11px;">${routeDiff.difficultyRating.badge} (Score: ${routeDiff.difficultyScore})</span>`
    : '';

  const habText =
    routeDiff && routeDiff.hikeABike.distanceMi > 0
      ? `<span style="color: var(--md-sys-color-tertiary, #f4b400); font-weight: 700;">⚠️ ${routeDiff.hikeABike.distanceMi} mi HAB (${routeDiff.hikeABike.percent}% · ${routeDiff.hikeABike.pitchCount} pitches ≥15%)</span>`
      : `<span style="color: var(--md-sys-color-primary, #78dc95); font-weight: 600;">🟢 Minimal Hike-a-Bike</span>`;

  const hillinessText = routeDiff
    ? `🏔️ Elevation Density: <strong>${routeDiff.hillinessFtPerMi} ft/mi</strong>`
    : '';

  setHTML(
    root,
    '#plan-summary',
    `
    <div style="display: flex; flex-direction: column; gap: 10px; width: 100%;">
      <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; flex-wrap: wrap; gap: 8px;">
        <div style="display: flex; gap: 12px; flex-wrap: wrap; align-items: center;">
          <span class="plan-stat"><strong>${planRoute.totalDistanceMiles.toFixed(0)}</strong> mi</span>
          <span class="plan-stat"><strong>${plan.dayPlan.length}</strong> days</span>
          <span class="plan-stat"><strong>${longest.toFixed(1)}</strong> mi longest dry</span>
          <span class="plan-stat"><strong>${plan.foodCarry.length}</strong> food legs</span>
          ${diffBadge}
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="plan-library-btn" data-action="open-library" style="
            background-color: var(--md-sys-color-surface-container-high, #2a312d);
            color: var(--md-sys-color-on-surface, #e1e3df);
            border: 1px solid var(--md-sys-color-outline-variant);
            border-radius: 100px;
            padding: 6px 14px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
          ">
            📁 Change Route
          </button>
          <button class="plan-import-btn" data-action="import-plan" style="
            background-color: var(--md-sys-color-secondary-container, #e8f5e9);
            color: var(--md-sys-color-on-secondary-container, #1b5e20);
            border: 1px solid var(--md-sys-color-outline-variant);
            border-radius: 100px;
            padding: 6px 14px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
          ">
            📤 Import Plan
          </button>
          <button class="plan-export-btn" data-action="export-plan" style="
            background-color: var(--md-sys-color-primary, #006c4c);
            color: var(--md-sys-color-on-primary, #ffffff);
            border: none;
            border-radius: 100px;
            padding: 6px 14px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            box-shadow: var(--md-sys-elevation-1);
          ">
            📥 Export Plan
          </button>
        </div>
      </div>
      <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--md-sys-color-outline-variant); border-radius: 8px; padding: 8px 12px; font-size: 11px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
        <span>${hillinessText}</span>
        <span>${habText}</span>
      </div>
    </div>
  `,
  );
  setHTML(root, '#plan-water', renderWaterCarry(plan.waterCarry));
  setHTML(root, '#plan-food', renderFoodCarry(plan.foodCarry));
  setHTML(root, '#plan-days', renderDayPlan(plan.dayPlan));
  setHTML(root, '#plan-log', renderLogTable(log, activeStopIds));
  const checklistsEl = root.querySelector('#plan-checklists');
  if (checklistsEl) {
    checklistsEl.innerHTML = renderChecklists(planRoute, plan);
    wireChecklistInteractions(root, planRoute, plan);
  }
  const analyticsEl = root.querySelector('#plan-analytics');
  if (analyticsEl) {
    analyticsEl.innerHTML = renderSegmentAnalyticsSection(planRoute, planOptions);
  }
}

/**
 * Reads the control inputs into planOptions and repaints.
 * @param {HTMLElement} root
 */
function syncOptionsAndRepaint(root) {
  const read = (id, fallback, minVal = 0) => {
    const v = Number.parseFloat(root.querySelector(id)?.value);
    return Number.isFinite(v) && v > minVal ? v : fallback;
  };

  const surfaceFactorVal = Number.parseFloat(root.querySelector('#plan-surface-factor')?.value);
  const surfaceFactor = Number.isFinite(surfaceFactorVal) ? surfaceFactorVal : 1.2;

  const optimizeCheckbox = root.querySelector('#plan-optimize-water');
  const optimizeWaterStops = optimizeCheckbox ? optimizeCheckbox.checked : false;

  const detailsEl = root.querySelector('#plan-optimize-details');
  if (detailsEl) {
    detailsEl.style.display = optimizeWaterStops ? 'flex' : 'none';
  }

  planOptions = {
    ...planOptions,
    targetDailyMiles: read('#plan-daily', PLAN_DEFAULTS.targetDailyMiles, 5),
    waterCapacityOz: read('#plan-capacity', PLAN_DEFAULTS.waterCapacityOz, 10),
    ozPerMile: read('#plan-ozmile', PLAN_DEFAULTS.ozPerMile),
    reliableWaterThreshold: read('#plan-reliability', PLAN_DEFAULTS.reliableWaterThreshold),
    caloriesPerDay: read('#plan-calories', PLAN_DEFAULTS.caloriesPerDay),
    campMealsPerDay: read('#plan-campmeals', PLAN_DEFAULTS.campMealsPerDay),
    caloriesPerCampMeal: read('#plan-campcal', PLAN_DEFAULTS.caloriesPerCampMeal),
    avgSnackCalories: read('#plan-snackcal', PLAN_DEFAULTS.avgSnackCalories),
    maxDetourMi: read('#plan-detour', PLAN_DEFAULTS.maxDetourMi),
    surfaceFactor,
    optimizeWaterStops,
    targetWaterIntervalMi: read('#plan-target-water-interval', PLAN_DEFAULTS.targetWaterIntervalMi),
    waterSafetyMarginPercent: read(
      '#plan-water-safety-margin',
      PLAN_DEFAULTS.waterSafetyMarginPercent,
    ),
    campWaterReserveOz: read('#plan-camp-water-reserve', PLAN_DEFAULTS.campWaterReserveOz),
    stopOverheadMinutes: read('#plan-stop-overhead', PLAN_DEFAULTS.stopOverheadMinutes),
    waterWeightPenalty: read('#plan-weight-penalty', PLAN_DEFAULTS.waterWeightPenalty),
  };
  repaint(root);

  // Dispatch event to app.js so it can update its state and map
  root.dispatchEvent(
    new CustomEvent('plan-options-change', {
      detail: planOptions,
      bubbles: true,
    }),
  );
}

/**
 * Builds the Planning view shell into `root` and wires the controls. Call
 * `updatePlanningView` afterwards (e.g. after enrichment) to refresh data.
 *
 * @param {HTMLElement} root  - the #planning-view container element
 * @param {import('./gpx.js').RouteContext} route
 * @param {typeof PLAN_DEFAULTS} [options=null]
 */
export function renderPlanningView(root, route, options = null) {
  if (options) planOptions = options;
  planRoute = route;
  root.innerHTML = `
    <section class="plan-section" aria-label="Trip planner">
      <div class="plan-summary" id="plan-summary"></div>
      ${renderControls(planOptions)}

      <div class="plan-tabs" style="display: flex; gap: 8px; border-bottom: 2px solid var(--md-sys-color-outline-variant); margin: 16px 0 12px 0;">
        <button class="plan-tab-btn plan-tab-btn--active" data-tab="water" style="flex: 1; padding: 10px; background: none; border: none; border-bottom: 3px solid var(--md-sys-color-primary); font-weight: 600; cursor: pointer; color: var(--md-sys-color-primary); font-size: 12px;">💧 Water</button>
        <button class="plan-tab-btn" data-tab="food" style="flex: 1; padding: 10px; background: none; border: none; border-bottom: 3px solid transparent; font-weight: 600; cursor: pointer; color: var(--md-sys-color-on-surface-variant); font-size: 12px;">🛒 Food</button>
        <button class="plan-tab-btn" data-tab="camps" style="flex: 1; padding: 10px; background: none; border: none; border-bottom: 3px solid transparent; font-weight: 600; cursor: pointer; color: var(--md-sys-color-on-surface-variant); font-size: 12px;">⛺ Camps</button>
        <button class="plan-tab-btn" data-tab="analytics" style="flex: 1; padding: 10px; background: none; border: none; border-bottom: 3px solid transparent; font-weight: 600; cursor: pointer; color: var(--md-sys-color-on-surface-variant); font-size: 12px;">📊 Analytics</button>
        <button class="plan-tab-btn" data-tab="checklists" style="flex: 1; padding: 10px; background: none; border: none; border-bottom: 3px solid transparent; font-weight: 600; cursor: pointer; color: var(--md-sys-color-on-surface-variant); font-size: 12px;">🎒 Checklists</button>
        <button class="plan-tab-btn" data-tab="log" style="flex: 1; padding: 10px; background: none; border: none; border-bottom: 3px solid transparent; font-weight: 600; cursor: pointer; color: var(--md-sys-color-on-surface-variant); font-size: 12px;">📋 Log</button>
        <button class="plan-tab-btn" data-tab="research" style="flex: 1; padding: 10px; background: none; border: none; border-bottom: 3px solid transparent; font-weight: 600; cursor: pointer; color: var(--md-sys-color-on-surface-variant); font-size: 12px;">🔍 Research</button>
      </div>

      <div class="plan-tab-content" id="tab-water">
        <h3 class="section-heading" style="margin-top: 8px;">Water carry — dry stretches</h3>
        <div id="plan-water"></div>
      </div>
      <div class="plan-tab-content" id="tab-food" style="display: none;">
        <h3 class="section-heading" style="margin-top: 8px;">Food carry — resupply legs</h3>
        <div id="plan-food"></div>
      </div>
      <div class="plan-tab-content" id="tab-camps" style="display: none;">
        <h3 class="section-heading" style="margin-top: 8px;">Day plan — camp options</h3>
        <div class="day-cards" id="plan-days"></div>
      </div>
      <div class="plan-tab-content" id="tab-analytics" style="display: none;">
        <div id="plan-analytics"></div>
      </div>
      <div class="plan-tab-content" id="tab-checklists" style="display: none;">
        <div id="plan-checklists"></div>
      </div>
      <div class="plan-tab-content" id="tab-log" style="display: none;">
        <h3 class="section-heading" style="margin-top: 8px;">Resource log</h3>
        <div id="plan-log"></div>
      </div>
      <div class="plan-tab-content" id="tab-research" style="display: none;">
        <h3 class="section-heading" style="margin-top: 8px;">OSM Resource Search</h3>
        <div id="plan-research" style="width: 100%;">
          <form id="research-search-form" style="display: flex; flex-direction: column; gap: var(--spacing-sm); margin-bottom: var(--spacing-md); text-align: left; width: 100%;">
            <label for="research-search-input" style="font-size: 11px; font-weight: 600; color: var(--md-sys-color-on-surface-variant);">Search Keyword</label>
            <div style="display: flex; gap: var(--spacing-sm); width: 100%;">
              <input class="plan-input" id="research-search-input" type="text" placeholder="e.g. spring, store, camp, creek" style="flex: 1; height: 36px; padding: 0 var(--spacing-sm); font-size: 12px;" required />
              <button class="plan-btn" type="submit" id="research-search-submit" style="
                background-color: var(--md-sys-color-primary, #006c4c);
                color: var(--md-sys-color-on-primary, #ffffff);
                border: none;
                border-radius: 4px;
                padding: 0 var(--spacing-md);
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                height: 36px;
              ">Search</button>
            </div>
          </form>
          <div id="research-results" style="display: flex; flex-direction: column; gap: 8px; width: 100%;">
            <p class="plan-empty">Search OSM to find and add custom resources to your plan.</p>
          </div>
        </div>
      </div>
      
      <div class="plan-export-container" style="margin-top: var(--spacing-xl); text-align: center; display: flex; flex-direction: column; gap: 10px;">
        <button id="export-plan-btn" class="plan-btn" style="
          background-color: var(--md-sys-color-primary, #006c4c);
          color: var(--md-sys-color-on-primary, #ffffff);
          border: none;
          border-radius: 24px;
          padding: 12px 24px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        ">
          Export / Share Plan 📤
        </button>
        <button id="export-pdf-btn" class="plan-btn" style="
          background-color: var(--md-sys-color-surface-container-high, #242427);
          color: var(--md-sys-color-on-surface, #ffffff);
          border: 1px solid var(--md-sys-color-outline-variant, #46444a);
          border-radius: 24px;
          padding: 12px 24px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        ">
          Printable PDF Itinerary 📄
        </button>
      </div>
    </section>
  `;

  const controls = root.querySelector('#plan-controls');
  let debounceTimer = null;
  const debouncedSync = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => syncOptionsAndRepaint(root), 250);
  };
  controls.addEventListener('input', debouncedSync);
  controls.addEventListener('change', () => syncOptionsAndRepaint(root));

  const voiceToggle = root.querySelector('#plan-voice-toggle');
  const readSummaryBtn = root.querySelector('#plan-read-summary-btn');

  if (voiceToggle) {
    voiceToggle.addEventListener('change', (e) => {
      setVoiceEnabled(e.target.checked);
      const appToggle = document.querySelector('#voice-enable-toggle');
      if (appToggle) appToggle.checked = e.target.checked;
      if (e.target.checked) {
        speak('Trail-Talk audio prompts enabled.');
      }
    });
  }

  if (readSummaryBtn) {
    readSummaryBtn.addEventListener('click', () => {
      if (planRoute) {
        const plan = buildPlan(planRoute, planOptions);
        const startLeg = plan.foodCarry[0];
        const startFoodText = startLeg
          ? `Starting food pack requires ${startLeg.campMeals} meals and ${startLeg.snacks} snacks.`
          : '';
        const summaryText = `Route ${planRoute.name || 'loaded'}. Total distance ${planRoute.totalDistanceMiles.toFixed(0)} miles, planned across ${plan.dayPlan.length} days. ${startFoodText}`;
        speak(summaryText);
      } else {
        speak('No route loaded.');
      }
    });
  }

  // Wire tab switching click handlers
  const tabButtons = root.querySelectorAll('.plan-tab-btn');
  for (const btn of tabButtons) {
    btn.addEventListener('click', () => {
      const activeTab = btn.getAttribute('data-tab');
      for (const b of tabButtons) {
        b.classList.toggle('plan-tab-btn--active', b === btn);
        b.style.borderBottomColor = b === btn ? 'var(--md-sys-color-primary)' : 'transparent';
        b.style.color =
          b === btn ? 'var(--md-sys-color-primary)' : 'var(--md-sys-color-on-surface-variant)';
      }
      const tabContents = root.querySelectorAll('.plan-tab-content');
      for (const content of tabContents) {
        content.style.display = content.id === `tab-${activeTab}` ? 'block' : 'none';
      }
    });
  }

  // Wire Export/Share button
  const exportBtn = root.querySelector('#export-plan-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      try {
        const bundle = await exportPlanBundle();
        if (!bundle) return;
        const gpxString = generateGPX(bundle.gpxText, planRoute, bundle.options);
        const newFilename = `${bundle.filename.replace(/\.gpx$/i, '')}-BPNav.gpx`;
        await sharePlan(newFilename, gpxString);
      } catch (err) {
        console.error('Export failed:', err);
        alert(`Could not export plan: ${describeError(err)}`);
      }
    });
  }

  // Wire Printable PDF Itinerary button
  const exportPdfBtn = root.querySelector('#export-pdf-btn');
  if (exportPdfBtn) {
    exportPdfBtn.addEventListener('click', () => {
      if (planRoute) {
        exportPDFItinerary(planRoute, planOptions);
      }
    });
  }

  // Delegated event listener for interactive stop state toggling & camp selection
  root.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('[data-action="toggle-stop"]');
    if (toggleBtn) {
      e.preventDefault();
      const id = toggleBtn.getAttribute('data-id');
      if (id) {
        const userStates = { ...(planOptions.userStopStates || {}) };
        const current = userStates[id] || 'optional';
        const next =
          current === 'optional' ? 'planned' : current === 'planned' ? 'skipped' : 'optional';
        userStates[id] = next;
        planOptions.userStopStates = userStates;
        localStorage.setItem(`bpnav-stop-state-${id}`, next);
        syncOptionsAndRepaint(root);
      }
      return;
    }

    const dayCampBtn = e.target.closest('[data-action="select-day-camp"]');
    if (dayCampBtn) {
      e.preventDefault();
      const dayNum = Number(dayCampBtn.getAttribute('data-day'));
      const targetKind = dayCampBtn.getAttribute('data-target-kind');
      if (dayNum && targetKind) {
        const selections = { ...(planOptions.dayCampSelections || {}), [dayNum]: targetKind };
        planOptions.dayCampSelections = selections;
        syncOptionsAndRepaint(root);
      }
      return;
    }

    const drawerBtn = e.target.closest('[data-action="open-segment-drawer"]');
    if (drawerBtn) {
      e.preventDefault();
      const startMi = Number(drawerBtn.getAttribute('data-start'));
      const endMi = Number(drawerBtn.getAttribute('data-end'));
      if (planRoute && Number.isFinite(startMi) && Number.isFinite(endMi)) {
        const analytics = computeSegmentAnalytics(planRoute, startMi, endMi, planOptions);
        window.dispatchEvent(
          new CustomEvent('bpnav-highlight-segment', { detail: { startMi, endMi } }),
        );
        openSegmentDrawer(analytics, {
          onHighlightMap: (sMi, eMi) => {
            window.dispatchEvent(
              new CustomEvent('bpnav-highlight-segment', { detail: { startMi: sMi, endMi: eMi } }),
            );
          },
        });
      }
      return;
    }
  });

  repaint(root);
}

/**
 * Refreshes the planning data for the current (or a new) route without
 * rebuilding the controls — used after async enrichment updates waypoints.
 * @param {HTMLElement} root
 * @param {import('./gpx.js').RouteContext} route
 * @param {typeof PLAN_DEFAULTS} [options=null]
 */
export function updatePlanningView(root, route, options = null) {
  if (!root) return;
  if (options) planOptions = options;
  planRoute = route;
  // If the shell hasn't been built yet, build it; else just repaint.
  if (!root.querySelector('#plan-summary')) {
    renderPlanningView(root, route, options);
  } else {
    repaint(root);
  }
}

/**
 * Renders the search results list HTML.
 * @param {Array<object>} results
 * @param {string} keyword
 * @returns {string}
 */
export function renderOSMSearchResults(results, keyword) {
  if (!results || results.length === 0) {
    return `<p class="plan-empty">No OSM resources matching "${keyword}" found along the route.</p>`;
  }

  const rows = results
    .map((r) => {
      // Find appropriate emoji
      const emoji =
        {
          water: '💧',
          camping: '⛺',
          resupply: '🛒',
          navigation: '📍',
        }[r.type] ?? '📍';

      // Type label
      const typeLabel =
        {
          water: 'Water',
          camping: 'Camp',
          resupply: 'Resupply',
          navigation: 'Note',
        }[r.type] ?? 'Resource';

      const detourMi = r.offCourseDistanceMi || 0;
      const detourStr =
        detourMi > 0.2
          ? `${detourMi.toFixed(1)} mi off route`
          : `${Math.round(detourMi * 5280)} ft off route`;

      const tagsDesc = r.tags?.description || r.tags?.note || '';
      const tagsList = Object.entries(r.tags || {})
        .filter(([k]) => !['name', 'description', 'note'].includes(k))
        .map(([k, v]) => `${k}=${v}`)
        .slice(0, 3)
        .join(', ');

      const details = [tagsDesc, tagsList].filter(Boolean).join(' · ');

      return `
        <li class="plan-row" style="display: flex; flex-direction: column; gap: 4px; padding: var(--spacing-sm); border-bottom: 1px solid var(--md-sys-color-outline-variant); list-style: none;">
          <div class="plan-row__main" style="display: flex; justify-content: space-between; align-items: flex-start; width: 100%;">
            <div style="display: flex; flex-direction: column; gap: 2px; text-align: left; flex: 1;">
              <span style="font-weight: 600; font-size: 13px; color: var(--md-sys-color-on-surface);">${emoji} ${mapPanLink(r.name, r.distanceFromStartMi)}</span>
              <span style="font-size: 10px; color: var(--md-sys-color-on-surface-variant);">${typeLabel} · mile ${r.distanceFromStartMi.toFixed(1)} (${detourStr})</span>
            </div>
            <button class="plan-add-wpt-btn" data-osm-id="${r.osmId}" style="
              background-color: var(--md-sys-color-secondary-container, #e8f5e9);
              color: var(--md-sys-color-on-secondary-container, #1b5e20);
              border: 1px solid var(--md-sys-color-outline-variant);
              border-radius: 4px;
              padding: 4px 8px;
              font-size: 11px;
              font-weight: 600;
              cursor: pointer;
              white-space: nowrap;
            ">＋ Add Stop</button>
          </div>
          ${details ? `<div style="font-size: 10px; color: var(--md-sys-color-on-surface-variant); text-align: left; opacity: 0.85; width: 100%; word-break: break-all;">${details}</div>` : ''}
        </li>`;
    })
    .join('');

  return `<ul class="plan-list" style="list-style: none; padding: 0; margin: 0; width: 100%;">${rows}</ul>`;
}

/**
 * Renders the interactive Start of Ride and Stop-by-Stop Packing Checklists.
 * @param {import('./gpx.js').RouteContext} route
 * @param {ReturnType<typeof buildPlan>} plan
 * @returns {string}
 */
export function renderChecklists(route, plan) {
  if (!route || !plan) {
    return '<p class="plan-empty">Load a route to generate packing and stop checklists.</p>';
  }

  const startChecklist = generateStartChecklist(route, plan);
  const stopChecklists = generateStopChecklists(route, plan);

  let _totalItems = 0;
  for (const cat of startChecklist) _totalItems += cat.items.length;
  for (const stop of stopChecklists) _totalItems += stop.items.length;

  const startCardsHtml = startChecklist
    .map((cat) => {
      const itemsHtml = cat.items
        .map(
          (item) => `
          <label class="checklist-item" style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; cursor: pointer; text-align: left;">
            <input type="checkbox" class="checklist-checkbox" data-id="${item.id}" style="margin-top: 3px; cursor: pointer; accent-color: var(--md-sys-color-primary);" />
            <div style="display: flex; flex-direction: column; gap: 2px;">
              <span class="checklist-label" style="font-size: 12px; font-weight: 500; color: var(--md-sys-color-on-surface);">${item.label}</span>
              ${item.detail ? `<span style="font-size: 10px; color: var(--md-sys-color-on-surface-variant); opacity: 0.85;">${item.detail}</span>` : ''}
            </div>
          </label>`,
        )
        .join('');

      return `
        <div class="checklist-category-card" style="background: rgba(255,255,255,0.02); border: 1px solid var(--md-sys-color-outline-variant); border-radius: 8px; padding: 12px; margin-bottom: 10px;">
          <h4 style="margin: 0 0 10px 0; font-size: 13px; color: var(--md-sys-color-primary); font-weight: 700;">${cat.title}</h4>
          <div class="checklist-items">${itemsHtml}</div>
        </div>`;
    })
    .join('');

  const stopCardsHtml = stopChecklists
    .map((stop) => {
      const typeBg =
        stop.type === 'water'
          ? 'color-mix(in srgb, #29b6f6 15%, transparent)'
          : stop.type === 'resupply'
            ? 'color-mix(in srgb, #ff9800 15%, transparent)'
            : stop.type === 'camping'
              ? 'color-mix(in srgb, #4caf50 15%, transparent)'
              : 'color-mix(in srgb, var(--md-sys-color-primary) 15%, transparent)';

      const typeColor =
        stop.type === 'water'
          ? '#4fc3f7'
          : stop.type === 'resupply'
            ? '#ffb74d'
            : stop.type === 'camping'
              ? '#81c784'
              : 'var(--md-sys-color-primary)';

      const itemsHtml = stop.items
        .map(
          (item) => `
          <label class="checklist-item" style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; cursor: pointer; text-align: left;">
            <input type="checkbox" class="checklist-checkbox" data-id="${item.id}" style="margin-top: 3px; cursor: pointer; accent-color: var(--md-sys-color-primary);" />
            <div style="display: flex; flex-direction: column; gap: 2px;">
              <span class="checklist-label" style="font-size: 12px; font-weight: 500; color: var(--md-sys-color-on-surface);">${item.label}</span>
              ${item.detail ? `<span style="font-size: 10px; color: var(--md-sys-color-on-surface-variant); opacity: 0.85;">${item.detail}</span>` : ''}
            </div>
          </label>`,
        )
        .join('');

      return `
        <div class="checklist-stop-card" style="background: rgba(255,255,255,0.02); border: 1px solid var(--md-sys-color-outline-variant); border-radius: 8px; padding: 12px; margin-bottom: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 6px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="background: ${typeBg}; color: ${typeColor}; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700;">${stop.badge}</span>
              <span style="font-size: 13px; font-weight: 700; color: var(--md-sys-color-on-surface);">${mapPanLink(stop.name, stop.mile)}</span>
            </div>
            <span style="font-size: 11px; font-weight: 600; color: var(--md-sys-color-on-surface-variant);">Mile ${stop.mile.toFixed(1)}</span>
          </div>
          <div class="checklist-items">${itemsHtml}</div>
        </div>`;
    })
    .join('');

  return `
    <div class="checklist-section" style="width: 100%; text-align: left;">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">
        <div>
          <h3 class="section-heading" style="margin: 0;">Packing & Stop Checklists</h3>
          <p style="margin: 2px 0 0 0; font-size: 11px; color: var(--md-sys-color-on-surface-variant);">
            Action items and logistics calculated specifically for your route stops.
          </p>
        </div>
        <div style="display: flex; gap: 8px;">
          <button id="btn-copy-checklists" class="plan-btn" style="
            background-color: var(--md-sys-color-surface-container-high, #242427);
            color: var(--md-sys-color-on-surface, #ffffff);
            border: 1px solid var(--md-sys-color-outline-variant, #46444a);
            border-radius: 6px;
            padding: 6px 12px;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 4px;
          ">
            📋 Copy Markdown
          </button>
          <button id="btn-reset-checklists" class="plan-btn" style="
            background: none;
            color: var(--md-sys-color-on-surface-variant);
            border: 1px solid var(--md-sys-color-outline-variant, #46444a);
            border-radius: 6px;
            padding: 6px 10px;
            font-size: 11px;
            cursor: pointer;
          ">
            🔄 Reset
          </button>
        </div>
      </div>

      <div style="margin-bottom: 16px;">
        <h4 style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--md-sys-color-on-surface-variant); margin: 0 0 8px 0;">
          🚀 Departure: Start of Ride Base Packing
        </h4>
        ${startCardsHtml}
      </div>

      <div>
        <h4 style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--md-sys-color-on-surface-variant); margin: 0 0 8px 0;">
          📍 Stop-by-Stop Route Checklists
        </h4>
        ${stopCardsHtml}
      </div>
    </div>
  `;
}

/**
 * Wires copy button and checklist checkbox change handlers.
 * @param {HTMLElement} root
 * @param {import('./gpx.js').RouteContext} route
 * @param {ReturnType<typeof buildPlan>} plan
 */
function wireChecklistInteractions(root, route, plan) {
  const copyBtn = root.querySelector('#btn-copy-checklists');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const startChecklist = generateStartChecklist(route, plan);
      const stopChecklists = generateStopChecklists(route, plan);

      // Preserve currently checked state from DOM
      const checkedIds = new Set(
        Array.from(root.querySelectorAll('.checklist-checkbox:checked')).map((cb) => cb.dataset.id),
      );

      for (const cat of startChecklist) {
        for (const item of cat.items) {
          item.checked = checkedIds.has(item.id);
        }
      }
      for (const stop of stopChecklists) {
        for (const item of stop.items) {
          item.checked = checkedIds.has(item.id);
        }
      }

      const md = getChecklistSummaryMarkdown(startChecklist, stopChecklists);
      const copied = await copyTextToClipboard(md);
      copyBtn.textContent = copied ? '✅ Copied!' : '⚠️ Copy Failed';
      setTimeout(() => {
        if (copyBtn) copyBtn.textContent = '📋 Copy Markdown';
      }, 2000);
    });
  }

  const resetBtn = root.querySelector('#btn-reset-checklists');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      for (const cb of root.querySelectorAll('.checklist-checkbox')) {
        cb.checked = false;
        const label = cb.closest('.checklist-item')?.querySelector('.checklist-label');
        if (label) label.style.textDecoration = 'none';
      }
    });
  }

  for (const cb of root.querySelectorAll('.checklist-checkbox')) {
    cb.addEventListener('change', () => {
      const label = cb.closest('.checklist-item')?.querySelector('.checklist-label');
      if (label) {
        label.style.textDecoration = cb.checked ? 'line-through' : 'none';
        label.style.opacity = cb.checked ? '0.6' : '1';
      }
    });
  }
}
