/**
 * checklist.js — Stop-by-stop & start-of-ride packing checklist engine for Bikepacker Navigator.
 *
 * Generates dynamic, logistical packing and action checklists for the start of the ride
 * and for each active stop (water refills, food resupply purchases, camp setup, bike checks).
 *
 * @module checklist
 */

import { buildPlan, getActiveStopIds } from './plan.js';

const round1 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : 0);

/**
 * Standard essential bikepacking gear categories for departure.
 */
export const ESSENTIAL_GEAR_TEMPLATES = {
  repair: [
    { id: 'gear-multitool', label: 'Multitool with chain breaker & Torx T25', category: 'repair' },
    {
      id: 'gear-plugs',
      label: 'Tubeless tire plugs (bacon strips) & insertion tool',
      category: 'repair',
    },
    { id: 'gear-pump', label: 'High-volume mini hand pump & CO2 inflator', category: 'repair' },
    { id: 'gear-tube', label: 'Spare lightweight TPU / butyl inner tube', category: 'repair' },
    { id: 'gear-lube', label: 'Chain lube (dry / wet formula) & rag', category: 'repair' },
    {
      id: 'gear-links',
      label: '2x Quick-links / master links matching chain speed',
      category: 'repair',
    },
    {
      id: 'gear-zipties',
      label: 'Emergency zip ties & small roll of Gorilla tape',
      category: 'repair',
    },
  ],
  shelter: [
    {
      id: 'gear-tent',
      label: 'Shelter (bikepacking tent / bivy / tarp & stakes)',
      category: 'shelter',
    },
    {
      id: 'gear-quilt',
      label: 'Sleeping bag / down quilt rated for route lows',
      category: 'shelter',
    },
    {
      id: 'gear-pad',
      label: 'Insulated sleeping pad & pillow / inflator sack',
      category: 'shelter',
    },
  ],
  electronics: [
    {
      id: 'gear-gps',
      label: 'GPS navigation unit / smartphone with offline route cached',
      category: 'electronics',
    },
    {
      id: 'gear-powerbank',
      label: 'Fully charged 10,000-20,000 mAh power bank',
      category: 'electronics',
    },
    {
      id: 'gear-cables',
      label: 'Charging cables (USB-C / micro-USB / watch charger)',
      category: 'electronics',
    },
    {
      id: 'gear-headlamp',
      label: 'Headlamp / handlebar riding light & helmet mount',
      category: 'electronics',
    },
  ],
  essentials: [
    {
      id: 'gear-firstaid',
      label: 'First aid kit (bandages, antiseptic, ibuprofen, blister tape)',
      category: 'essentials',
    },
    {
      id: 'gear-hygiene',
      label: 'Chamois cream, sunscreen, bug spray & wet wipes',
      category: 'essentials',
    },
    {
      id: 'gear-layers',
      label: 'Packable rain shell, wind vest & warm puffy jacket',
      category: 'essentials',
    },
    {
      id: 'gear-cash',
      label: 'Wallet (ID, credit cards, $40-$60 emergency cash for camp fee tubes)',
      category: 'essentials',
    },
  ],
};

/**
 * Generates the Start of Ride Base Packing Checklist.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {ReturnType<typeof buildPlan>} plan
 * @returns {Array<{
 *   category: string,
 *   title: string,
 *   items: Array<{ id: string, label: string, checked?: boolean, detail?: string }>
 * }>}
 */
export function generateStartChecklist(route, plan) {
  if (!route || !plan) return [];

  const startWaterSpan = plan.waterCarry?.[0];
  const startFoodSpan = plan.foodCarry?.[0];

  const firstWaterDist =
    startWaterSpan && startWaterSpan.miles > 0
      ? `${startWaterSpan.miles.toFixed(1)} mi to ${startWaterSpan.toName}`
      : 'the first stretch';

  const rawWaterOz = startWaterSpan?.recommendedOz ?? startWaterSpan?.demandOz;
  const startWaterOz = Number.isFinite(rawWaterOz) && rawWaterOz > 0 ? rawWaterOz : 64;
  const startWaterLiters = (startWaterOz * 0.0295735).toFixed(1);

  const hydrationItems = [
    {
      id: 'start-water-fill',
      label: `Fill ${startWaterLiters} L (${startWaterOz} oz) water capacity for ${firstWaterDist}`,
      detail: 'Ensure all bottles and hydration bladder are topped off before roll-out.',
      checked: false,
    },
    {
      id: 'start-water-filter',
      label: 'Pack water filter / chemical purification tablets & squeeze pouch',
      detail: 'Keep accessible in cockpit / handlebar bag for quick trail refills.',
      checked: false,
    },
    {
      id: 'start-electrolytes',
      label: 'Pack electrolyte drink mix / salt tabs for first day riding',
      detail: 'Plan ~1 serving per 2 hours of warm riding.',
      checked: false,
    },
  ];

  const firstFoodDist =
    startFoodSpan && startFoodSpan.miles > 0
      ? `${startFoodSpan.miles.toFixed(1)} mi to ${startFoodSpan.toName}`
      : 'first resupply';

  const startMeals = startFoodSpan?.campMeals ?? 2;
  const startSnacks = startFoodSpan?.snacks ?? 8;
  const startCalories =
    startFoodSpan?.calories ?? startFoodSpan?.totalCalories ?? startMeals * 650 + startSnacks * 200;

  const nutritionItems = [
    {
      id: 'start-camp-meals',
      label: `Pack ${startMeals} camp meal(s) (dehydrated dinners / breakfast packs) for ${firstFoodDist}`,
      detail: `High-calorie, compact meals (${plan.options?.caloriesPerCampMeal ?? 650} kcal avg).`,
      checked: false,
    },
    {
      id: 'start-trail-snacks',
      label: `Pack ${startSnacks} trail snacks (~${startCalories.toLocaleString()} total kcal) for first stretch`,
      detail: 'Mix of fast sugars (bars, chews) and sustained fats (nuts, nut butter, jerky).',
      checked: false,
    },
    {
      id: 'start-cook-gear',
      label: 'Pack titanium mug/pot, ultralight stove, full fuel canister & lighter/matches',
      detail: 'Or verify cold-soaking jar if stoveless.',
      checked: false,
    },
  ];

  return [
    {
      category: 'hydration',
      title: '💧 Starting Hydration Load',
      items: hydrationItems,
    },
    {
      category: 'nutrition',
      title: '🛒 Starting Food Pack',
      items: nutritionItems,
    },
    {
      category: 'repair',
      title: '🔧 Bike Repair & Spares Kit',
      items: ESSENTIAL_GEAR_TEMPLATES.repair.map((g) => ({ ...g, checked: false })),
    },
    {
      category: 'shelter',
      title: '⛺ Sleep & Shelter System',
      items: ESSENTIAL_GEAR_TEMPLATES.shelter.map((g) => ({ ...g, checked: false })),
    },
    {
      category: 'electronics',
      title: '⚡ Electronics & Navigation',
      items: ESSENTIAL_GEAR_TEMPLATES.electronics.map((g) => ({ ...g, checked: false })),
    },
    {
      category: 'essentials',
      title: '📋 Clothing, Layering & Permits',
      items: ESSENTIAL_GEAR_TEMPLATES.essentials.map((g) => ({ ...g, checked: false })),
    },
  ];
}

/**
 * Generates stop-by-stop action and packing checklists for all active stops along the route.
 *
 * @param {import('./gpx.js').RouteContext} route
 * @param {ReturnType<typeof buildPlan>} plan
 * @returns {Array<{
 *   stopId: string,
 *   name: string,
 *   mile: number,
 *   type: 'water' | 'resupply' | 'camping' | 'finish',
 *   badge: string,
 *   items: Array<{ id: string, label: string, checked?: boolean, detail?: string }>
 * }>}
 */
export function generateStopChecklists(route, plan) {
  if (!route || !plan) return [];

  const activeIds = getActiveStopIds(route, plan.options);
  const totalMi = route.totalDistanceMiles ?? 0;
  const ozPerMile = plan.options?.ozPerMile ?? 2.0;

  // Gather all active stop waypoints
  const stops = route.waypoints
    .filter((w) => activeIds.has(w.id))
    .sort((a, b) => a.distanceFromStartMi - b.distanceFromStartMi);

  const result = [];

  for (let idx = 0; idx < stops.length; idx++) {
    const stop = stops[idx];
    const mile = round1(stop.distanceFromStartMi);

    // Find next distinct subsequent stop (skipping co-located POIs within 0.05 mi)
    const nextDistinct = stops
      .slice(idx + 1)
      .find((s) => s.distanceFromStartMi > stop.distanceFromStartMi + 0.05);
    const defaultNextMile = nextDistinct ? nextDistinct.distanceFromStartMi : totalMi;
    const defaultLegDistance = round1(Math.max(0.1, defaultNextMile - stop.distanceFromStartMi));

    // Find waterCarry span leaving this stop if any
    const waterSpan = plan.waterCarry?.find(
      (s) => Math.abs(s.fromMi - stop.distanceFromStartMi) < 0.5,
    );

    // Find foodCarry span leaving this stop if any
    const foodSpan = plan.foodCarry?.find(
      (s) => Math.abs(s.fromMi - stop.distanceFromStartMi) < 0.5,
    );

    const items = [];

    if (stop.type === 'water') {
      const waterLegDist = waterSpan ? waterSpan.miles : defaultLegDistance;
      const nextTarget = waterSpan?.toName || (nextDistinct ? nextDistinct.name : 'Finish');

      const rawOz = waterSpan?.recommendedOz ?? waterSpan?.demandOz;
      const neededOz =
        Number.isFinite(rawOz) && rawOz > 0 ? rawOz : Math.round(waterLegDist * ozPerMile);
      const neededLiters = (neededOz * 0.0295735).toFixed(1);

      const isPotable = stop.waterAvailable === 'potable' || stop.drinkingWater === 'yes';
      const isNatural =
        stop.waterAvailable === 'natural' ||
        stop.waterAvailable === 'stream' ||
        (!isPotable && stop.waterAvailable !== 'none');

      items.push({
        id: `${stop.id}-refill`,
        label: `Refill ${neededLiters} L (${neededOz} oz) water for the next ${waterLegDist.toFixed(1)} mi stretch to ${nextTarget}`,
        detail: isNatural
          ? '⚠️ Natural stream/spring: Filter or treat all water thoroughly.'
          : '💧 Potable water on-site: Direct tap / spigot refill.',
        checked: false,
      });

      items.push({
        id: `${stop.id}-electrolytes`,
        label: 'Add electrolytes / hydration mix to riding bottles',
        detail: 'Replenish sodium and minerals before next climb.',
        checked: false,
      });

      items.push({
        id: `${stop.id}-inspect-water`,
        label: 'Check bladders and bottle cages for secure fit & zero leaks',
        detail: 'Ensure caps are tightly sealed and bite valve is clean.',
        checked: false,
      });
    } else if (stop.type === 'resupply') {
      const foodLegDist = foodSpan ? foodSpan.miles : defaultLegDistance;
      const nextResupplyTarget = foodSpan?.toName || 'Finish';

      const targetDailyMiles = plan.options?.targetDailyMiles ?? 30;
      const campMealsPerDay = plan.options?.campMealsPerDay ?? 2;
      const caloriesPerDay = plan.options?.caloriesPerDay ?? 3500;
      const avgSnackCalories = plan.options?.avgSnackCalories ?? 200;
      const caloriesPerCampMeal = plan.options?.caloriesPerCampMeal ?? 650;

      const mealsToBuy =
        foodSpan?.campMeals ?? Math.round((foodLegDist / targetDailyMiles) * campMealsPerDay);
      const snacksToBuy =
        foodSpan?.snacks ??
        Math.round((foodLegDist / targetDailyMiles) * (caloriesPerDay / avgSnackCalories));
      const totalKcal =
        foodSpan?.calories ??
        foodSpan?.totalCalories ??
        mealsToBuy * caloriesPerCampMeal + snacksToBuy * avgSnackCalories;

      const category = stop.resupplyCategory || 'cstore';

      if (category === 'restaurant') {
        items.push({
          id: `${stop.id}-dine`,
          label: `Eat immediate sit-down meal / hot food at ${stop.name}`,
          detail: 'Saves 1 camp dinner pack weight and recovers calories immediately.',
          checked: false,
        });
      } else {
        items.push({
          id: `${stop.id}-buy-meals`,
          label: `Buy ${mealsToBuy} camp dinner/breakfast meals for ${foodLegDist.toFixed(1)} mi to ${nextResupplyTarget}`,
          detail:
            'Look for high calorie-to-weight foods (ramen, instant potatoes, tuna/salmon pouches, freeze-dried).',
          checked: false,
        });

        items.push({
          id: `${stop.id}-buy-snacks`,
          label: `Pick up ${snacksToBuy} pocket snacks (~${totalKcal.toLocaleString()} kcal total)`,
          detail: 'Candy bars, chips, mixed nuts, dried mango, cookies, meat sticks.',
          checked: false,
        });

        items.push({
          id: `${stop.id}-fresh-calories`,
          label: 'Eat fresh calories on-site (cold chocolate milk, smoothie, fresh fruit, pastry)',
          detail: 'Top off glycogen storage without carrying the extra water weight on the bike.',
          checked: false,
        });
      }

      items.push({
        id: `${stop.id}-charge`,
        label: 'Plug in power bank and phone to recharge while shopping / eating',
        detail: 'Ask clerk politely for an available wall outlet.',
        checked: false,
      });

      items.push({
        id: `${stop.id}-trash`,
        label: 'Throw away all accumulated food wrappers and pack trash into town bins',
        detail: 'Keep gear bags clean and light.',
        checked: false,
      });

      // If also a water opportunity
      const waterLegDist = waterSpan ? waterSpan.miles : defaultLegDistance;
      const rawResupplyWaterOz = waterSpan?.recommendedOz ?? waterSpan?.demandOz;
      const resupplyWaterOz =
        Number.isFinite(rawResupplyWaterOz) && rawResupplyWaterOz > 0
          ? rawResupplyWaterOz
          : Math.round(waterLegDist * ozPerMile);
      const resupplyWaterL = (resupplyWaterOz * 0.0295735).toFixed(1);

      items.push({
        id: `${stop.id}-water-refill`,
        label: `Top off water bottles with ${resupplyWaterL} L (${resupplyWaterOz} oz) tap water`,
        detail: 'Convenience stores and gas stations usually provide sink/fountain water.',
        checked: false,
      });
    } else if (stop.type === 'camping') {
      const campWaterStatus =
        stop.waterAvailable === 'potable'
          ? '💧 Potable water available on-site'
          : stop.waterAvailable === 'natural'
            ? '💧 Natural water stream/source nearby (filter required)'
            : stop.waterAvailable === 'none'
              ? '🚫 Dry Camp — verify you carried reserve camp water'
              : '💧 Check for water spigot or nearby stream';

      items.push({
        id: `${stop.id}-shelter`,
        label: 'Pitch shelter, unpack sleeping pad & fluff down sleeping quilt/bag',
        detail: 'Set up camp before dusk while daylight permits.',
        checked: false,
      });

      const campReserve = plan.options?.campWaterReserveOz ?? 40;
      items.push({
        id: `${stop.id}-camp-water`,
        label: `Fill overnight & breakfast water (${campReserve} oz reserve)`,
        detail: campWaterStatus,
        checked: false,
      });

      if (stop.fee && stop.fee.toLowerCase() !== 'free') {
        items.push({
          id: `${stop.id}-fee`,
          label: `Pay campsite fee (${stop.fee}) at self-serve pay tube or register with camp host`,
          detail: 'Fill out fee envelope, insert cash/check, and clip stub to tent post.',
          checked: false,
        });
      }

      items.push({
        id: `${stop.id}-cook`,
        label: 'Cook camp dinner and rehydrate evening meal',
        detail: 'Consume sufficient protein & carbs to aid overnight muscle recovery.',
        checked: false,
      });

      items.push({
        id: `${stop.id}-bear-safe`,
        label: 'Store all food, trash, and toiletries in bear locker / canister / bear hang',
        detail: 'Never keep scented items, lip balm, or food inside your tent.',
        checked: false,
      });

      items.push({
        id: `${stop.id}-bike-check`,
        label: 'Inspect tires for thorns/seepage, wipe and lube chain for tomorrow',
        detail: 'Fix any mechanical issues in camp rather than on tomorrow’s morning climb.',
        checked: false,
      });

      items.push({
        id: `${stop.id}-electronics-topup`,
        label: 'Charge GPS unit, headlamp, and phone from power bank overnight',
        detail: 'Keep electronics inside sleeping bag if night temperatures drop near freezing.',
        checked: false,
      });
    }

    result.push({
      stopId: stop.id,
      name: stop.name || `${stop.type.toUpperCase()} Stop`,
      mile,
      type: stop.type,
      badge:
        stop.type === 'water'
          ? '💧 Water Stop'
          : stop.type === 'resupply'
            ? '🛒 Resupply'
            : '⛺ Camp Spot',
      items,
    });
  }

  // Finish stop
  result.push({
    stopId: 'stop-finish',
    name: 'Finish Line',
    mile: round1(totalMi),
    type: 'finish',
    badge: '🏁 Finish',
    items: [
      {
        id: 'finish-celebrate',
        label: 'Celebrate ride completion! 🎉',
        detail: `Completed full ${totalMi.toFixed(1)} miles route.`,
        checked: false,
      },
      {
        id: 'finish-save-log',
        label: 'Save and export GPS track and trip log',
        detail: 'Sync activity and review ride analytics.',
        checked: false,
      },
    ],
  });

  return result;
}

/**
 * Formats the entire set of checklists into clean GitHub-flavored Markdown.
 *
 * @param {Array<ReturnType<typeof generateStartChecklist>[0]>} startChecklist
 * @param {ReturnType<typeof generateStopChecklists>} stopChecklists
 * @returns {string}
 */
export function getChecklistSummaryMarkdown(startChecklist, stopChecklists) {
  let md = '# 📋 Bikepacking Expedition Packing & Stop Checklist\n\n';

  md += '## 🚀 Departure: Start of Ride Base Packing\n\n';
  for (const cat of startChecklist) {
    md += `### ${cat.title}\n`;
    for (const item of cat.items) {
      const box = item.checked ? '[x]' : '[ ]';
      md += `- ${box} **${item.label}**\n`;
      if (item.detail) md += `  - *${item.detail}*\n`;
    }
    md += '\n';
  }

  md += '## 📍 Stop-by-Stop Route Action Checklists\n\n';
  for (const stop of stopChecklists) {
    md += `### ${stop.badge}: ${stop.name} (Mile ${stop.mile})\n`;
    for (const item of stop.items) {
      const box = item.checked ? '[x]' : '[ ]';
      md += `- ${box} **${item.label}**\n`;
      if (item.detail) md += `  - *${item.detail}*\n`;
    }
    md += '\n';
  }

  return md;
}

/**
 * Copies text to the system clipboard with fallback support for insecure contexts.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyTextToClipboard(text) {
  if (typeof text !== 'string') return false;

  if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_err) {
      // Fall through to fallback
    }
  }

  if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.setAttribute('readonly', '');
      textArea.style.position = 'fixed';
      textArea.style.top = '0';
      textArea.style.left = '0';
      textArea.style.width = '2em';
      textArea.style.height = '2em';
      textArea.style.padding = '0';
      textArea.style.border = 'none';
      textArea.style.outline = 'none';
      textArea.style.boxShadow = 'none';
      textArea.style.background = 'transparent';
      textArea.style.opacity = '0.01';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      textArea.setSelectionRange(0, text.length);
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      return Boolean(successful);
    } catch (err) {
      console.error('[BPNav] Fallback clipboard copy failed:', err);
      return false;
    }
  }

  return false;
}
