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

import { PLAN_DEFAULTS, buildPlan, optimizeWaterStops } from './plan.js';

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

function getActiveStopIdsLocal(route, opts) {
  const activeIds = new Set();
  if (!route) return activeIds;

  const total = route.totalDistanceMiles ?? 0;
  const waypoints = [...route.waypoints].sort(
    (a, b) => a.distanceFromStartMi - b.distanceFromStartMi,
  );

  const excludedWater = new Set(opts.excludedWaterIds);
  const forcedWater = new Set(opts.forcedWaterIds);
  const excludedResupply = new Set(opts.excludedResupplyIds);
  const forcedResupply = new Set(opts.forcedResupplyIds);

  // Filter water candidates
  const waterWpts = waypoints.filter((w) => w.type === 'water');
  const waterCandidates = waterWpts.filter((wp) => {
    if (excludedWater.has(wp.id)) return false;
    const isOffTrack = (wp.offCourseDistanceMi || 0) > 0.1;
    if (isOffTrack && !forcedWater.has(wp.id)) return false;
    return (wp.reliability ?? 0) >= opts.reliableWaterThreshold || forcedWater.has(wp.id);
  });

  // Filter resupply candidates
  const resupplyWpts = waypoints.filter((w) => w.type === 'resupply');
  const activeResupplies = resupplyWpts.filter((w) => {
    if (excludedResupply.has(w.id)) return false;
    const isOffTrack = (w.offCourseDistanceMi || 0) > 0.1;
    if (isOffTrack && !forcedResupply.has(w.id)) return false;
    return true;
  });

  const waterStops = opts.optimizeWaterStops
    ? optimizeWaterStops(route, [...waterCandidates, ...activeResupplies], opts)
    : waterCandidates;

  // Filter water stops by detour
  const filteredWaterStops = waterStops.filter((wp) => {
    const isForced = wp.type === 'water' ? forcedWater.has(wp.id) : forcedResupply.has(wp.id);
    return (wp.offCourseDistanceMi || 0) <= opts.maxDetourMi || isForced;
  });

  // Resolve water emergencies
  const findEmergencyStretch = (activeStops) => {
    const anchors = [0, ...activeStops.map((s) => s.distanceFromStartMi), total];
    for (let i = 1; i < anchors.length; i++) {
      const dist = anchors[i] - anchors[i - 1];
      if (dist * opts.ozPerMile > opts.waterCapacityOz) {
        return { start: anchors[i - 1], end: anchors[i] };
      }
    }
    return null;
  };

  let emergency = findEmergencyStretch(filteredWaterStops);
  const guard = 100;
  let iterations = 0;

  while (emergency && iterations < guard) {
    const potentialHelpers = waypoints.filter((w) => {
      if (w.type !== 'water' && w.type !== 'resupply') return false;
      if (w.type === 'water' && excludedWater.has(w.id)) return false;
      if (w.type === 'resupply' && excludedResupply.has(w.id)) return false;

      const mi = w.distanceFromStartMi;
      const offCourse = w.offCourseDistanceMi || 0;
      const isValidHelper = offCourse <= opts.maxDetourMi;

      const isAlreadyActive = filteredWaterStops.some((s) => s.id === w.id);

      return (
        isValidHelper && !isAlreadyActive && mi > emergency.start + 0.1 && mi < emergency.end - 0.1
      );
    });

    if (potentialHelpers.length === 0) {
      break;
    }

    const mid = (emergency.start + emergency.end) / 2;
    potentialHelpers.sort(
      (a, b) => Math.abs(a.distanceFromStartMi - mid) - Math.abs(b.distanceFromStartMi - mid),
    );

    filteredWaterStops.push(potentialHelpers[0]);
    filteredWaterStops.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

    emergency = findEmergencyStretch(filteredWaterStops);
    iterations++;
  }

  for (const wp of filteredWaterStops) {
    activeIds.add(wp.id);
  }

  // Food resupplies
  const activeResupplyStops = activeResupplies;

  // Resolve food emergencies
  const maxFoodCarryMiles = opts.targetDailyMiles * 3;
  const findFoodEmergency = (activeStops) => {
    const milesList = [0, ...activeStops.map((s) => s.distanceFromStartMi), total];
    for (let i = 1; i < milesList.length; i++) {
      const dist = milesList[i] - milesList[i - 1];
      if (dist > maxFoodCarryMiles) {
        return { start: milesList[i - 1], end: milesList[i] };
      }
    }
    return null;
  };

  let foodEmergency = findFoodEmergency(activeResupplyStops);
  let foodIterations = 0;

  while (foodEmergency && foodIterations < guard) {
    const potentialHelpers = resupplyWpts.filter((w) => {
      if (excludedResupply.has(w.id)) return false;
      const mi = w.distanceFromStartMi;
      const isWithinDetour = (w.offCourseDistanceMi || 0) <= opts.maxDetourMi;
      const isAlreadyActive = activeResupplyStops.some((s) => s.id === w.id);

      return (
        isWithinDetour &&
        !isAlreadyActive &&
        mi > foodEmergency.start + 1.0 &&
        mi < foodEmergency.end - 1.0
      );
    });

    if (potentialHelpers.length === 0) {
      break;
    }

    const mid = (foodEmergency.start + foodEmergency.end) / 2;
    potentialHelpers.sort(
      (a, b) => Math.abs(a.distanceFromStartMi - mid) - Math.abs(b.distanceFromStartMi - mid),
    );

    activeResupplyStops.push(potentialHelpers[0]);
    activeResupplyStops.sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

    foodEmergency = findFoodEmergency(activeResupplyStops);
    foodIterations++;
  }

  for (const wp of activeResupplyStops) {
    activeIds.add(wp.id);
  }

  // 3. Camp stops
  const plan = buildPlan(route, opts);
  for (const d of plan.dayPlan) {
    if (d.chosen?.campId) {
      activeIds.add(d.chosen.campId);
    }
  }

  return activeIds;
}
import { buildResourceLog } from './triplog.js';

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
        <span class="plan-field__label">Max detour distance (exclude stops further off-route unless necessary)</span>
        <span class="plan-field__inputwrap">
          <input class="plan-input" type="number" id="plan-detour" min="0.1" max="25" step="0.1"
            value="${o.maxDetourMi}" /> <span class="plan-field__unit">mi</span>
        </span>
      </label>
      <label class="plan-field plan-field--checkbox" style="grid-column: span 2; display: flex; align-items: center; gap: 8px; cursor: pointer;">
        <input class="plan-checkbox" type="checkbox" id="plan-optimize-water"
          ${o.optimizeWaterStops ? 'checked' : ''} />
        <span class="plan-field__label" style="margin: 0; font-weight: 600;">Optimize Water Stops (Balance stops vs weight)</span>
      </label>
      <div class="plan-controls__sub" id="plan-optimize-details" style="grid-column: span 2; display: ${o.optimizeWaterStops ? 'flex' : 'none'}; gap: 16px; width: 100%; border-top: 1px dashed var(--md-sys-color-outline-variant); padding-top: 12px; margin-top: 4px;">
        <label class="plan-field">
          <span class="plan-field__label">Stop overhead</span>
          <span class="plan-field__inputwrap">
            <input class="plan-input" type="number" id="plan-stop-overhead" min="1" step="5"
              value="${o.stopOverheadMinutes}" /> <span class="plan-field__unit">min</span>
          </span>
        </label>
        <label class="plan-field">
          <span class="plan-field__label">Weight penalty</span>
          <span class="plan-field__inputwrap">
            <input class="plan-input" type="number" id="plan-weight-penalty" min="0.01" max="1" step="0.05"
              value="${o.waterWeightPenalty}" /> <span class="plan-field__unit">cost</span>
          </span>
        </label>
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
      return `
        <li class="plan-row${alert}">
          <div class="plan-row__main">
            <span class="plan-row__span">${mapPanLink(s.fromName, s.fromMi)} → ${mapPanLink(s.toName, s.toMi)}</span>
            <span class="plan-row__miles">${s.miles} mi</span>
          </div>
          <div class="plan-row__sub">
            Carry ≈ ${oz(s.recommendedOz)} ${warn}
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
  const rows = spans
    .map((s) => {
      const lbs = (s.weightOz / 16).toFixed(1);
      return `
        <li class="plan-row" style="display: flex; flex-direction: column; gap: 4px; padding: var(--spacing-sm); border-bottom: 1px solid var(--md-sys-color-outline-variant);">
          <div class="plan-row__main" style="display: flex; justify-content: space-between; font-weight: 600; width: 100%;">
            <span class="plan-row__span">${mapPanLink(s.fromName, s.fromMi)} → ${mapPanLink(s.toName, s.toMi)}</span>
            <span class="plan-row__miles" style="font-variant-numeric: tabular-nums;">${s.miles} mi</span>
          </div>
          <div class="plan-row__sub" style="display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--md-sys-color-on-surface-variant); width: 100%; text-align: left;">
            <div>📅 Carry duration: <strong>${s.daysFloat}</strong> days</div>
            <div style="display: flex; gap: 12px; margin-top: 2px; flex-wrap: wrap;">
              <span>🔥 <strong>${s.calories.toLocaleString()}</strong> kcal</span>
              <span>🍽️ <strong>${s.campMeals}</strong> meals</span>
              <span>⚖️ <strong>${s.weightOz} oz</strong> (${lbs} lbs) food weight</span>
            </div>
          </div>
        </li>`;
    })
    .join('');
  return `<ul class="plan-list" style="list-style: none; padding: 0; margin: 0; width: 100%;">${rows}</ul>`;
}

/** One camp option chip within a day card. @param {string} kind @param {object|null} opt */
function renderDayOption(kind, opt, isChosen) {
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
  return `
    <div class="day-option${chosen}" data-action="select-camp" data-id="${opt.campId}" style="cursor: pointer;">
      <div class="day-option__head">
        <span class="day-option__kind">${kind}</span>
        <span class="day-option__miles">${opt.miles} mi</span>
      </div>
      <p class="day-option__camp">${mapPanLink(opt.campName, opt.endMi)}</p>
      <p class="day-option__meta" style="margin-top: 4px; display: flex; flex-direction: column; gap: 2px;">
        <span style="font-weight: 500;">@ mile ${opt.endMi}</span>
        <span>💧 ${water}</span>
        <span>🛒 ${food}</span>
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
        renderDayOption('Short', d.options.short, d.options.short?.campId === chosenId),
        renderDayOption('Medium', d.options.medium, d.options.medium?.campId === chosenId),
        renderDayOption('Long', d.options.long, d.options.long?.campId === chosenId),
      ].join('');
      const optionsHtml =
        opts.trim().length > 0
          ? opts
          : renderDayOption(d.chosen?.isFinish ? 'Finish' : 'Camp', d.chosen, true);
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

      let toggleBtn = '';
      if (
        (e.type === 'WATER' || e.type === 'FOOD' || e.type === 'CAMP') &&
        !e.landmark.includes('Start') &&
        !e.landmark.includes('Finish')
      ) {
        const isStop = activeStopIds.has(e.id);
        const icon = e.type === 'WATER' ? '💧' : e.type === 'FOOD' ? '🛒' : '⛺';
        toggleBtn = `
          <button class="log-water-toggle-btn" data-action="toggle-stop" data-id="${e.id}" title="${isStop ? 'Skip this stop' : 'Stop here'}" style="
            background: none;
            border: none;
            cursor: pointer;
            font-size: 14px;
            margin-right: 4px;
            padding: 0;
          ">
            ${isStop ? icon : '🚫'}
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
          <td class="log-mi">${e.cumulativeMi}</td>
          <td class="log-name">
            ${toggleBtn}
            ${mapPanLink(e.landmark, e.cumulativeMi)}
            <span class="log-badge log-badge--${badge.cls}">${badge.label}${rel}</span>
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

  // Extract the set of active water stops for popup and log rendering
  const activeStopIds = getActiveStopIdsLocal(planRoute, planOptions);

  const longest = plan.waterCarry.reduce((m, s) => Math.max(m, s.miles), 0);
  root.querySelector('#plan-summary').innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; flex-wrap: wrap; gap: 8px;">
      <div style="display: flex; gap: 12px; flex-wrap: wrap;">
        <span class="plan-stat"><strong>${planRoute.totalDistanceMiles.toFixed(0)}</strong> mi</span>
        <span class="plan-stat"><strong>${plan.dayPlan.length}</strong> days</span>
        <span class="plan-stat"><strong>${longest.toFixed(1)}</strong> mi longest dry</span>
        <span class="plan-stat"><strong>${plan.foodCarry.length}</strong> food legs</span>
      </div>
      <div style="display: flex; gap: 8px;">
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
  `;
  root.querySelector('#plan-water').innerHTML = renderWaterCarry(plan.waterCarry);
  root.querySelector('#plan-food').innerHTML = renderFoodCarry(plan.foodCarry);
  root.querySelector('#plan-days').innerHTML = renderDayPlan(plan.dayPlan);
  root.querySelector('#plan-log').innerHTML = renderLogTable(log, activeStopIds);
}

/**
 * Reads the control inputs into planOptions and repaints.
 * @param {HTMLElement} root
 */
function syncOptionsAndRepaint(root) {
  const read = (id, fallback) => {
    const v = Number.parseFloat(root.querySelector(id)?.value);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };

  const optimizeCheckbox = root.querySelector('#plan-optimize-water');
  const optimizeWaterStops = optimizeCheckbox ? optimizeCheckbox.checked : false;

  const detailsEl = root.querySelector('#plan-optimize-details');
  if (detailsEl) {
    detailsEl.style.display = optimizeWaterStops ? 'flex' : 'none';
  }

  planOptions = {
    ...planOptions,
    targetDailyMiles: read('#plan-daily', PLAN_DEFAULTS.targetDailyMiles),
    waterCapacityOz: read('#plan-capacity', PLAN_DEFAULTS.waterCapacityOz),
    ozPerMile: read('#plan-ozmile', PLAN_DEFAULTS.ozPerMile),
    reliableWaterThreshold: read('#plan-reliability', PLAN_DEFAULTS.reliableWaterThreshold),
    caloriesPerDay: read('#plan-calories', PLAN_DEFAULTS.caloriesPerDay),
    campMealsPerDay: read('#plan-campmeals', PLAN_DEFAULTS.campMealsPerDay),
    caloriesPerCampMeal: read('#plan-campcal', PLAN_DEFAULTS.caloriesPerCampMeal),
    avgSnackCalories: read('#plan-snackcal', PLAN_DEFAULTS.avgSnackCalories),
    maxDetourMi: read('#plan-detour', PLAN_DEFAULTS.maxDetourMi),
    optimizeWaterStops,
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
    </section>
  `;

  const controls = root.querySelector('#plan-controls');
  controls.addEventListener('input', () => syncOptionsAndRepaint(root));

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
