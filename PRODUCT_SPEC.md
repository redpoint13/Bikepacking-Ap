# Bikepacker Navigator — Generalized Product Specification

> **Working title:** Bikepacker Navigator  
> **Status:** Pre-development design document  
> **Last updated:** 2026-05-14  
> **Reference implementation:** Coconino Loop (250mi, Arizona)

---

## 1. Vision

**Bikepacker Navigator** is a route-agnostic, offline-first Progressive Web App that acts as an active logistical partner for multi-day cycling adventures. It transforms any imported route into a live, predictive dashboard that answers the three questions every bikepacker asks continuously:

1. **Where is my next drink?**
2. **Where am I eating / resupplying?**
3. **Will I make it to camp before dark?**

Unlike general navigation apps (Komoot, Gaia GPS, RideWithGPS), this app does not compete on route discovery or social features. It competes on **decision support** — surfacing the right information at the right moment to reduce cognitive load during solo, multi-day efforts.

---

## 2. Scope & Constraints

### In scope
- Bikepacking and multi-day gravel/road cycling routes
- Routes imported via GPX/KML file or link (Komoot, RideWithGPS)
- Water source discovery with live reliability data (USGS + community)
- Camping spot discovery across three tiers (dispersed, official, community)
- Resupply point identification along the route corridor
- Daylight-aware pacing and ETA prediction
- Offline-first operation via PWA / Service Worker
- Mobile-first UI (iOS Safari + Android Chrome primary targets)

### Out of scope (v1)
- Route creation / drawing
- Social features, ride sharing, segment leaderboards
- Native iOS / Android apps
- Motorized vehicle or hiking/running use cases
- International routes (US focus for data source coverage in v1)

---

## 3. Core Architecture

### 3.1 The Route Context Object

Every feature in the app operates on a single `RouteContext` object. This is the core abstraction that makes the app route-agnostic.

```
RouteContext {
  id: string                    // UUID, generated on import
  name: string                  // From GPX metadata or user-defined
  source: "gpx" | "komoot" | "ridewithgps"
  importedAt: timestamp
  geometry: GeoJSON LineString  // The full route geometry
  totalDistanceMiles: number
  elevationProfile: number[]    // meters, sampled every 100m
  waypoints: Waypoint[]         // Named points from source file
  startPoint: PointOnRoute      // Adjustable — default is waypoints[0]
  direction: "forward" | "reverse"
  userPreferences: Preferences
}

Preferences {
  paceMovingAvgMph: number      // Rolling 2-hr average, updated live
  maxDailyMiles: number         // For multi-day segment planning
  noNightRiding: boolean        // Triggers Sunsprint warnings
  waterCarryCapacityOz: number  // Used for carry calculations
  dietaryFilter: "none" | "vegetarian" | "vegan"
  campingTiers: ("dispersed" | "official" | "community")[]
}
```

### 3.2 The Data Layer System

Data is applied on top of the RouteContext in independent, pluggable layers. Each layer can be cached offline independently.

```
RouteContext
    └── WaterLayer        (USGS + OSM + community reports)
    └── CampLayer         (BLM/USFS + Recreation.gov + iOverlander)
    └── ResupplyLayer     (OSM POIs + USPS)
    └── DaylightLayer     (SunCalc — fully local, no API needed)
    └── PaceLayer         (device GPS, rolling average — fully local)
```

Each layer exposes:
- `fetch(routeCorridorGeoJSON, preferences)` — called pre-ride on WiFi
- `cache()` — persists to IndexedDB for offline use
- `query(positionOnRoute)` — called live during the ride, reads from cache

### 3.3 The Route Corridor

All external data queries use a **corridor buffer** around the route geometry — a configurable strip (default: 1 mile each side, expandable to 5 miles for resupply) rather than a bounding box. This keeps data payloads small and avoids loading irrelevant POIs in cities the route passes near but not through.

---

## 4. Route Import

### 4.1 GPX / KML File Upload

- User drags a file or uses a file picker
- App parses with `toGeoJSON` (client-side, no server upload)
- Extracts: geometry, named waypoints, track name, total distance
- If multiple tracks exist, user selects one
- Elevation profile fetched from Open-Topo-Data API (free, open source) if not embedded in file

### 4.2 RideWithGPS Link

- User pastes a route URL (e.g., `ridewithgps.com/routes/12345678`)
- App calls the **RideWithGPS Public API v2** (no auth required for public routes)
- Endpoint: `GET https://ridewithgps.com/routes/{id}.json`
- Extracts geometry, waypoints, elevation, name

### 4.3 Komoot Link

- User pastes a tour URL (e.g., `komoot.com/tour/12345678`)
- App calls the **Komoot Public API** (public tours, no auth required)
- Endpoint: `GET https://api.komoot.de/v007/tours/{id}`
- Extracts geometry, waypoints, name

### 4.4 Starting Point Adjustment

After import, a slider UI allows the user to move the start point to any location along the route. The route "rotates" — it becomes a loop starting at the new point, or a linear segment starting mid-route. This is essential for:

- Riders who are dropped at a mid-point by a shuttle
- Multi-attempt riders who want to resume from a specific location
- Linking segments of multiple routes together in the future (v2)

---

## 5. Feature Suite

### 5.1 Smart Resource Radar (generalization of Coconino "Dynamic Resource Radar")

A persistent, haptic-enabled overlay that shows the nearest resources ahead on the route.

**Displays:**
- Next 3 water sources (distance, reliability, type)
- Next resupply point within preferences (dietary filter applied)
- Next viable camp option matching user's tier preferences
- Miles of "dry stretch" ahead (distance to next water)

**Water carry calculator:**  
Given `waterCarryCapacityOz` and estimated sweat rate (configurable by temperature bracket), displays: *"Current carry: 64oz. Next water: 18.2 miles. At your pace and today's conditions, you need 48oz minimum. You have a 16oz buffer."*

---

### 5.2 Daylight & Pace Planner (generalization of "Sunsprint Engine")

**Pre-ride (planning mode):**
- User inputs target daily mileage or target camp waypoints
- App generates multi-day segment plan: Day 1, Day 2, etc.
- Each day shows: start/end waypoints, mileage, climbing, projected time, sunset time at camp location, nearest water, nearest resupply

**Live (riding mode):**
- Rolling 2-hour GPS moving average updates `paceMovingAvgMph`
- ETA projected to next "Sleep" waypoint or user-defined camp target
- SunCalc provides precise sunset at the camp location's coordinates
- UI color states:
  - **Forest Green:** >60 min daylight buffer at projected arrival
  - **Amber Alert:** 30–60 min buffer
  - **Red Alert:** <30 min buffer (with persistent vibration pulse)

---

### 5.3 Ghost Mode (unchanged — already route-agnostic)

Battery conservation mode for multi-day efforts.

- Screen and GPS polling drop to low-power state when on-course and away from resources
- **Proximity Wake:** 500m geofence around all cached resource points triggers haptic + screen wake
- **Off-Course Wake:** Detects deviation >100m from route geometry, wakes and alerts
- **OLED Mode:** True-black (#000000) background UI for maximum battery savings on modern displays
- Battery state indicator in header — warns when <20% and Ghost Mode is not enabled

---

### 5.4 Voice Navigation / Trail-Talk (generalized from Coconino "Trail-Talk")

Hands-free audio cues via Web Speech API.

**Triggered by:**
- Approaching a water source (500m): *"Water source ahead in 0.3 miles — natural spring, rated reliable year-round."*
- Approaching a camp spot (1km): *"Dispersed camping area in 0.6 miles. BLM land, no permit required."*
- Approaching a resupply (2km): *"Town ahead in 1.2 miles — grocery store and pharmacy on route."*
- Off-course detection: *"Route deviation detected. Turn around or re-route."*
- Sunsprint alert: *"Warning: projected arrival at camp is within 30 minutes of sunset."*

**Controls:** Single tap on persistent floating button toggles voice on/off. No other interaction required.

---

### 5.5 Trip Planner (new — not in Coconino version)

A pre-ride, desktop-friendly planning interface.

1. **Import route** → route displayed on map with elevation profile
2. **Set preferences** → pace, daily mileage cap, dietary filter, camping tier
3. **Generate plan** → app places optimized segment breaks at camp locations that satisfy:
   - Daily mileage target ± 15%
   - Arrival before sunset (if `noNightRiding`)
   - Proximity to water (never more than `waterCarryDistanceMiles` from last source)
4. **Review map** → each day's segment color-coded, resources marked
5. **Export** → download plan as PDF itinerary or save to device for offline riding

---

## 6. Data Sources

### 6.1 Water Sources

| Source | API / Method | Data Type | Refresh |
|--------|-------------|-----------|---------|
| **USGS NWIS** | `waterservices.usgs.gov/rest/iv-service` | Real-time streamflow at gauged sites | Live (15-min data) |
| **OpenStreetMap Overpass** | `overpass-api.de` | Springs, wells, water points, troughs | Cached weekly |
| **iOverlander** | Community feed / API | Community-reported water caches | Cached daily |
| **Custom cuesheet import** | GPX waypoints with typed metadata | Route-specific named sources | Static (from file) |

**USGS Integration detail:**  
Query by bounding box of route corridor. Filter for sites with `parameterCd=00060` (streamflow, cfs). A site with flow >0 cfs is active. Site metadata includes lat/lon for map placement. Historic median flow for the current calendar week provides a "seasonal reliability" score independent of current reading.

**Reliability Scoring:**
```
Score = 0–100
  Natural spring, perennial:         85–100
  Stream, USGS flow > 10 cfs:        75–90
  Stream, USGS flow 1–10 cfs:        50–75
  Well / pump (community confirmed):  60–80
  Seasonal stream (OSM tagged):       20–50
  Cattle trough / unclear:           10–30
  Currently dry (USGS = 0):           0
```

---

### 6.2 Camping

| Source | API / Method | Tier | Notes |
|--------|-------------|------|-------|
| **Recreation.gov RIDB** | `ridb.recreation.gov/api/v1/campsites` | Official | API key required (free), returns lat/lon, amenities, reservation status |
| **USFS Geodata Clearinghouse** | Static GeoJSON download | Dispersed | Wilderness/dispersed camping boundary polygons; rider is "in bounds" if on BLM/USFS land |
| **BLM GeoBOB** | `gis.blm.gov/arcgis/rest/services` | Dispersed | Land surface ownership layer — confirms BLM land for dispersed camping legality |
| **iOverlander** | Community feed | Community | Stealth/informal spots with recent visit reports and access notes |
| **OpenStreetMap** | Overpass: `tourism=camp_site` | Mixed | Supplement to above; good for private/commercial campgrounds not in RIDB |

---

### 6.3 Resupply

| Source | API / Method | Data |
|--------|-------------|------|
| **OSM Overpass** | `shop=supermarket`, `shop=convenience`, `amenity=restaurant`, `amenity=fuel`, `shop=bicycle` | Primary resupply POIs |
| **USPS Locator API** | `tools.usps.com/find-location.htm` (or scrape) | Post offices for mail drops |
| **Dietary filter** | Applied client-side to OSM `cuisine` and `diet:vegetarian` tags | Vegan/vegetarian restaurant flagging |

Resupply POIs are enriched with:
- Distance from route (straight-line to nearest route point)
- Hours of operation (from OSM `opening_hours` tag where available)
- Phone number (for confirming hours before arrival)

---

## 7. Offline Strategy

All data is pre-fetched and cached to **IndexedDB** during a "Sync" operation performed on WiFi before the ride.

**Sync checklist (shown to user pre-ride):**
- [ ] Map tiles (route corridor ± 1mi, zoom levels 10–17)
- [ ] Water sources fetched and scored
- [ ] Camp spots fetched and filtered by preferences
- [ ] Resupply POIs fetched
- [ ] USGS current readings snapshotted (with timestamp)
- [ ] Solar data pre-computed for all ride days

**During the ride:**
- All queries read from IndexedDB — zero network dependency
- USGS data shown with age indicator: *"Water data: 4h old"*
- If connectivity detected, USGS data silently refreshes in background
- Map tiles served from Service Worker cache

**Storage estimate per route:**
- Map tiles (250mi corridor): ~80–150MB
- Resource data (all layers): ~2–5MB
- Total: well within 250MB IndexedDB budget on modern mobile browsers

---

## 8. UI/UX Principles

- **One-handed operation:** All critical controls reachable with a thumb while the other hand holds bars. No small tap targets. Minimum 48×48dp touch zones.
- **Glove-friendly:** Large hit areas, swipe gestures preferred over small buttons.
- **Desert-readable:** High contrast ratio (≥7:1) for all text on primary backgrounds. No light gray on white.
- **OLED-optimized Ghost Mode:** True black (#000000) background. Only lit pixels are meaningful content.
- **Information hierarchy:** The three core questions are always answerable from the top of the screen without scrolling.

### Color System

| State | Background | Accent | Meaning |
|-------|-----------|--------|---------|
| Normal | `#0A0A0A` (OLED) | `#2E7D32` Forest Green | On track, resources adequate |
| Caution | `#0A0A0A` | `#F57F17` Amber | Resource or daylight concern |
| Alert | `#0A0A0A` | `#C62828` Red | Immediate action needed |

---

## 9. Technical Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Framework | Vanilla JS + Web Components **or** Svelte | Minimal bundle for fast load on mobile data |
| Maps | MapLibre GL JS + PMTiles | Fully offline-capable vector tiles, open source |
| Offline storage | IndexedDB via `idb` wrapper | Stores tiles, resource data, route context |
| Service Worker | Workbox | Pre-caching, background sync |
| GPS | Web Geolocation API + `geolocation-sensor` | Browser-native, no native shell needed |
| Voice | Web Speech API (SpeechSynthesis) | No dependency, works offline |
| Solar calculations | SunCalc.js | Pure JS, no API, fully offline |
| GPX parsing | `toGeoJSON` | Lightweight, client-side |
| Elevation | Open-Topo-Data API (pre-ride only) | Free, open source |
| Geofencing | Turf.js `booleanPointInPolygon` + `distance` | Client-side geometry, no native API |
| Styling | CSS custom properties, no framework | Keeps bundle small, full control |

---

## 10. Development Phases

### Phase 1 — Route Import & Planning Core
- GPX/KML file import and parsing
- RideWithGPS + Komoot link import
- Starting point adjustment UI
- Basic map display with route corridor
- Trip Planner: manual segment review (no auto-optimization yet)

### Phase 2 — Data Layers
- Water Layer: OSM Overpass + USGS NWIS integration
- Camp Layer: BLM/USFS geodata + Recreation.gov
- Resupply Layer: OSM POIs + dietary filter
- Offline sync workflow ("Sync before you ride" checklist)

### Phase 3 — Live Riding Mode
- Smart Resource Radar (live proximity display)
- Daylight & Pace Planner (live GPS pace + SunCalc)
- Ghost Mode power conservation
- Trail-Talk voice cues

### Phase 4 — Polish & Reference Implementation
- Coconino Loop as built-in demo route (pre-loaded, no import needed)
- CLR13 cuesheet waypoints imported as authoritative named waypoints
- PDF itinerary export from Trip Planner
- PWA install prompt + iOS "Add to Home Screen" guide

---

## 11. Reference Implementation: Coconino Loop

The 250-mile Coconino Loop (Arizona) serves as the primary test case and demo route for all development. It exercises every edge case:

- **Extended dry stretches** (tests water carry calculator)
- **Remote dispersed camping on Mogollon Rim** (tests BLM/USFS layer)
- **Three resupply towns** (Cottonwood, Williams, Flagstaff — tests OSM resupply)
- **Technical terrain + sunset timing pressure** (tests Sunsprint in real conditions)
- **USGS-gauged streams** (Oak Creek, Verde River tributaries — tests NWIS integration)

The CLR13 cuesheets provide authoritative named waypoints and legacy water reliability notes that will be imported as a supplemental annotation layer on top of the general data sources.

---

*End of specification. Next step: Phase 1 implementation — Route import engine and base map display.*
