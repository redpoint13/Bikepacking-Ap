# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev            # Vite dev server on :5173
npm run check          # Biome lint + format check (CI gate)
npm run format         # Biome auto-fix in place
npm test               # Vitest, single run
npm run test:watch
npm run build          # → dist/
```

Run a single test file or test name:

```bash
npx vitest run src/tests/plan.test.js
```

```bash
npx vitest run -t 'optimizes stops'
```

CI (`.github/workflows/ci-deploy.yml`) runs **check → test → build** on every push/PR, then deploys `dist/` to Cloudflare Pages only on push to `main`. Run those three locally before pushing.

Android (Capacitor wrapper around the same `dist/`):

```bash
npm run build:android  # vite build && cap sync android
```

## Git workflow

- Before editing, make sure the working tree is current — `git status` for uncommitted work, `git pull` if the branch tracks a remote — and read the file as it exists on the branch you are on rather than assuming an earlier version.
- **Never commit to `main`.** A push to `main` runs the deploy job and ships straight to Cloudflare Pages. Branch first whenever the change is more than a throwaway experiment: `git checkout -b fix/<slug>`. Existing prefixes in this repo are `fix/`, `feature/`, and `claude/`.
- Land changes through a PR against `main` so the CI job (check → test → build) gates the deploy.
- Commit messages follow Conventional Commits with an optional scope — `feat(analytics):`, `fix(plan):`, `perf(gps):`, `test(map):`, `refactor:`, `chore:`.
- Run `npm run check && npm test && npm run build` before committing; CI blocks the deploy on any of the three.

## Architecture

Vanilla ES modules — no framework, no JSX, no build-time templating. The DOM is built by string templates + `querySelector` wiring in `app.js` and `planning.js`. Vitest config lives inside `vite.config.js` (there is no separate vitest config).

### RouteContext — the one central object

Everything operates on a single `RouteContext` produced by `parseGPX`/`parseGPXAsync` ([src/gpx.js](src/gpx.js)) or by URL import ([src/import.js](src/import.js), which produces the same shape so the rest of the app is source-agnostic):

```
{ name, totalDistanceMiles, trackPoints, waypoints, bounds, startPoint,
  startOffsetMi, isLoop, difficulty, metadata: { forced*Ids } }
```

- `trackPoints` are plain arrays `[lat, lon, elevationMeters]`.
- Memoized derived arrays are cached **as properties on the `trackPoints` array itself**: `_cumulativeDistances`, `_cumulativeGain`, `_totalDistance` (see `getOrCreateCumulativeDistances` / `getOrCreateCumulativeGain`). Mutating `trackPoints` without replacing the array leaves these stale — rebuild the array or clear the caches.
- Waypoints carry `{ id, lat, lon, name, description, type, reliability, distanceFromStartMi, offCourseDistanceMi }`. `type` is one of `water | resupply | camping | navigation`, assigned by keyword classification (`classifyWaypoint`) or OSM tags (`classifyOSMElement`).

### Waypoint identity conventions (easy to break)

- GPX-parsed waypoints get ids `wpt-<index>`; user-created ones are prefixed `user-`.
- Each background enrichment pass **replaces every waypoint of its type wholesale**, keeping only `user-`-prefixed ones (`kickoffWaterEnrichment` and siblings at the bottom of [src/app.js](src/app.js)). Any id you invent for a non-user waypoint will not survive the next enrichment cycle, and any id stored in `excludedWaterIds` / `forcedCampIds` etc. must therefore be stable across passes.
- **Call `markWaypointsChanged(route)` after ANY mutation of `route.waypoints`.** `buildPlan` and `getActiveStopIds` are memoized on a key built from `route.waypointsRevision` + array length + trackpoint count + options (`planCacheKeyFor` in [src/plan.js](src/plan.js)). Reassigning or push/filter is visible through array identity, but an in-place `waypoints[i] = wp` or an in-place sort is not — without the bump you get a stale plan. `markWaypointsChanged` re-seats the array and increments the revision; [src/app.js](src/app.js) calls it after every enrichment pass and every waypoint edit.
- OSM enrichment volume is capped per type by `capEnrichedWaypoints` / `ENRICHMENT_LIMITS` in [src/enrichmentLimits.js](src/enrichmentLimits.js) (water 250 @ 0.25 mi spacing, camping 150 @ 0.5, resupply 200 @ 0.5). It lives in its own module to avoid an import cycle — `enrichment.js` already imports from `camp.js`. Non-OSM waypoints are never dropped.

### Layers

- **Pure compute (offline, side-effect free, heavily tested):** `gpx.js`, `plan.js`, `triplog.js`, `difficulty.js`, `analytics.js`, `sun.js`, `checklist.js`, `enrichment.js`, `enrichmentLimits.js`, `utils/tiles.js`.
- **Network enrichment (all failure-tolerant, fire-and-forget):** `water.js` (USGS + OSM Overpass), `camp.js`, `resupply.js`, `weather.js`, `api.js`. These catch their own errors and log — the app must keep working with whatever data arrived.
- **UI:** `app.js` (shell, mode switching, route lifecycle), `planning.js` (planning surface), `map.js` (MapLibre wrapper), `ui/*` (modals, drawers, cards, elevation profile).
- **Platform:** `storage.js` (IndexedDB), `mobile.js` (Capacitor back button, wake lock, lifecycle), `sync.js` (offline tile prefetch), `errorBoundary.js`.

`plan.js` is the engine: `buildPlan()` returns `{ options, waterCarry, foodCarry, dayPlan }`, and `getActiveStopIds()` resolves the set of waypoint ids that count as real stops. That set is what drives map markers, checklists, and GPX/PDF export — go through it rather than re-deriving stop logic.

Planning-control edits are on a hot path: the controls share a debounce, `buildPlan`/`getActiveStopIds` are memoized, and `updateMapDayPlan` diffs day layers against a `WeakMap` rather than rebuilding them. Preserve those when touching the planning surface — before this work one control edit cost ~3.3 s at full enrichment.

`resolveOptions()` folds `userStopStates` (`planned | optional | skipped`) into the concrete `excluded*Ids` / `forced*Ids` arrays before any planning runs; always pass options through it rather than reading raw user state.

### Data & persistence

- IndexedDB `bpnav-v1` (v2, `openDB` runs `migrateV1IfNeeded` on every open to fold legacy single-route storage into the library store): raw GPX text, the multi-route library, enriched waypoints, plan options, metadata, active route id.
- `localStorage` holds user preference scalars under the `bpnav-` prefix (`state.js` `getPlanDefaults` / `persistUserPreferences`, plus `bpnav-voiceEnabled`).
- On startup `tryRestoreRoute()` restores the route, applies **cached** enrichment immediately (so markers appear offline), then kicks off live enrichment anyway — the service worker serves from cache when offline.

### Offline strategy

`vite-plugin-pwa` + Workbox `runtimeCaching` in [vite.config.js](vite.config.js) sets per-host strategies: USGS `NetworkFirst` (2h), Overpass `StaleWhileRevalidate` (7d), OpenFreeMap tiles/glyphs/sprites `CacheFirst` (30–90d). `sync.js` walks slippy-map tile coordinates for the route and fetches them so the SW caches them ahead of a ride. New external hosts need a matching `runtimeCaching` entry or they will not work offline.

### Crash-safety conventions

Recent history is largely crash-hardening; keep it that way:

- `installErrorBoundary()` runs before anything else in `main.js`, and mount is wrapped in `guardStartup`.
- Use `describeError(err)` rather than `err.message` — throwables here are not always `Error`s.
- Use the guarded helpers in [src/utils/dom.js](src/utils/dom.js) (`find`, `setText`, `setHTML`, `setStyle`, `setProps`, `on`, `readValue`) instead of unguarded `root.querySelector('#x').textContent = …`. Partial renders and mode switches routinely leave elements absent, and a throw there aborts the rest of the update.
- Long GPX parses go through `parseGPXAsync` (a generator that yields to the event loop every chunk). `parseGPX` is the blocking variant kept for tests/non-UI callers.

### State duplication to be aware of

`state.js` exports an `appState` singleton with a subscribe/notify mechanism, but [src/app.js](src/app.js) still keeps its own module-level `currentMode` and `planOptions`. Both exist; neither is authoritative for everything. Check which one a given feature reads before adding to either.

## Conventions

- Units: **miles** for distance everywhere internally; elevation stored in **meters**, displayed in feet; water in **ounces**.
- Biome: 2-space indent, 100-col lines, single quotes, trailing commas, semicolons, `const`/no-`var` enforced, `noUnusedVariables` is an error.
- **Desktop is planning-only by design.** Above 1024px `#mode-toggle` is `display: none !important` ([src/style.css:990](src/style.css:990)), so Riding mode is unreachable in a wide browser window — narrow below 1024px to reach it. Likewise the FAB links (Load Demo / paste a URL) are hidden once a route loads; route changes go through "Change Route" in the header.
- Styling is a single hand-written [src/style.css](src/style.css) using Material Design 3 `--md-sys-color-*` tokens on an OLED-black base, with BEM-ish `block__element--modifier` class names. Colors are semantic: green = on course/all clear, amber = daylight warning, red = act now.

## Tests

`src/tests/*.test.js`, jsdom environment. `maplibre-gl` is aliased to [src/tests/\_\_mocks\_\_/maplibre-gl.js](src/tests/__mocks__/maplibre-gl.js) (a stateful stub tracking sources/layers so map lifecycle is testable without WebGL); IndexedDB tests `import 'fake-indexeddb/auto'` at the top of the file. Tests build small literal `RouteContext` fixtures rather than parsing GPX — see `makeRoute()` in [src/tests/plan.test.js](src/tests/plan.test.js).

## Reference docs

[PRODUCT_SPEC.md](PRODUCT_SPEC.md) is the product source of truth (feature definitions, data-source rationale, phases). [WATER_SOURCES_RESEARCH.md](WATER_SOURCES_RESEARCH.md) documents why the water data sources and reliability scoring work the way they do. [SETUP.md](SETUP.md) covers first-time Cloudflare Pages / GitHub secrets setup.
