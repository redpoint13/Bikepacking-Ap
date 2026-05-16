# Water Sources Research
> Last updated: 2026-05-14

This document covers every available data source for water source discovery and real-time flow verification, assessed for integration into Bikepacker Navigator.

---

## Summary: Recommended Stack

| Priority | Source | What it covers | Key gap |
|----------|--------|---------------|---------|
| **1** | USGS Monitoring Locations API | Gauged streams/rivers — real-time flow in cfs | Only ~10,000 gauged sites nationally; misses springs, wells, spigots |
| **2** | USGS Daily Values + Statistics API | Historical flow data for seasonal reliability scoring | Same coverage gap as above |
| **3** | OSM Overpass API | Springs, wells, water points, drinking water taps, troughs | Data quality varies; many entries are outdated or sparse in wilderness |
| **4** | iOverlander | Community-reported water caches, spigots, seasonal sources | Coverage spotty outside popular routes; requires periodic refresh |
| **5** | Custom cuesheet waypoints | Route-specific named sources imported from GPX metadata | Static — no live data, but highest reliability for specific routes |

---

## Source 1: USGS Water Data for the Nation

**Portal:** https://waterdata.usgs.gov/  
**New API home:** https://api.waterdata.usgs.gov/  
**Auth:** None required (optional API key for higher rate limits)  
**Cost:** Free, public domain data

### What changed: Legacy → Modern API

USGS has modernized their APIs. The legacy NWIS IV service (`waterservices.usgs.gov`) still works but the new **OGC-compliant REST API** at `api.waterdata.usgs.gov` is the preferred interface going forward. It returns standard GeoJSON, supports spatial queries natively, and has much better documentation.

### API Endpoints We'll Use

#### A. Monitoring Locations API
Find all USGS gauge stations within a geographic bounding box.

```
GET https://api.waterdata.usgs.gov/ogcapi/v0/collections/monitoring-locations/items
  ?f=json
  &bbox={minLon},{minLat},{maxLon},{maxLat}
  &limit=100
```

**Returns per station:**
- `stationNm` — human-readable name (e.g., "OAK CREEK NEAR SEDONA, AZ")
- `monitoringLocationNumber` — station ID (e.g., "09504500")
- `monLocTypeName` — type: Stream, Lake, Spring, Well, Atmosphere, etc.
- `geometry.coordinates` — [lon, lat]
- `drainageAreaSqMi` — watershed size
- `hucCd` — Hydrologic Unit Code (for watershed grouping)

**Query strategy for our app:**
- Compute a corridor buffer polygon around the imported route
- Query with bounding box of that corridor (typically 1–2 miles per side)
- Cache all results to IndexedDB during the pre-ride sync

#### B. Continuous Values API
Real-time measurements at a specific station or set of stations.

```
GET https://api.waterdata.usgs.gov/ogcapi/v0/collections/continuous/items
  ?f=json
  &monitoringLocationIdentifier=USGS-09504500
  &parameterName=Streamflow
  &startDateTime=2026-05-14T00:00:00Z
```

**Key parameters:**
- `parameterName=Streamflow` — discharge in cubic feet per second (cfs)
- `parameterName=Gage+height` — water level in feet
- Data updates every 15 minutes at most stations

**Interpreting flow values for our reliability score:**

| Flow (cfs) | Condition | Reliability score |
|------------|-----------|------------------|
| > 50 cfs | Strong flow, safe crossing likely | 90–100 |
| 10–50 cfs | Moderate flow, water available | 75–90 |
| 1–10 cfs | Low flow, trickle / pools likely | 50–75 |
| 0.1–1 cfs | Very low, seasonal pools only | 20–50 |
| 0 cfs / "Ice" / "Dry" | No flow recorded | 0–10 |
| No data / offline | Station not reporting | Show cached value + age |

#### C. Daily Values API
Historical daily summaries (mean, min, max, median) for a station.

```
GET https://api.waterdata.usgs.gov/ogcapi/v0/collections/daily/items
  ?f=json
  &monitoringLocationIdentifier=USGS-09504500
  &parameterName=Streamflow
  &startDateTime=2025-05-01T00:00:00Z
  &endDateTime=2026-05-14T00:00:00Z
```

**Use case:** Build a 12-month flow history to compute "typical flow this week of the year" — essential for seasonal reliability scoring before the ride when current readings aren't available yet.

#### D. Statistics API
Precomputed percentile statistics by day-of-year.

```
GET https://api.waterdata.usgs.gov/statistics/v0/
  ?sites=09504500
  &statReportType=daily
  &statType=p10,p25,p50,p75,p90
```

**Use case:** "At this site, current flow of 8 cfs is at the 15th percentile for mid-May — lower than usual." This feeds a "below normal / normal / above normal" indicator on the water source card.

#### E. Water Quality Portal
Separate service, joint USGS + EPA.

```
GET https://www.waterqualitydata.us/data/Result/search
  ?bBox=-112.5,34.5,-111.4,35.5
  &characteristicName=Fecal+Coliform
  &mimeType=json
```

**Use case:** For sources near agricultural land or heavy cattle use, surface-level e-coli or coliform flags. Useful data but secondary priority — most bikepackers filter regardless.

---

## Source 2: data.gov Daily Streamflow Dataset

**URL:** https://catalog.data.gov/dataset/daily-streamflow-datasets-used-to-analyze-trends-in-streamflow-at-sites-also-analyzed-for--8e3a6

**Assessment:** This dataset is a **research archive**, not a live API. It contains historical daily streamflow used for trend analysis (detecting long-term drying trends due to climate change). Useful as background context for which streams are trending drier, but not appropriate as a primary data source. We can incorporate its long-term trend signal as a tertiary factor in reliability scoring ("this stream has shown declining flow trends over 20 years") but it won't be in v1.

---

## Source 3: OpenStreetMap Overpass API

**Endpoint:** `https://overpass-api.de/api/interpreter`  
**Auth:** None  
**Cost:** Free (rate-limited; self-hostable)

Covers water sources that USGS doesn't gauge: springs, hand pumps, spigots, stock tanks, cattle troughs, seasonal drainages.

### Query for all water POIs in route corridor

```
[out:json][timeout:30];
(
  node["natural"="spring"](bbox);
  node["amenity"="drinking_water"](bbox);
  node["amenity"="water_point"](bbox);
  node["man_made"="water_well"](bbox);
  node["man_made"="water_tap"](bbox);
  node["amenity"="watering_place"](bbox);
  node["natural"="water"]["water"="river"](bbox);
  node["natural"="water"]["water"="stream"](bbox);
);
out body;
```

### Key OSM tags for reliability inference

| Tag | Meaning | Reliability |
|-----|---------|------------|
| `natural=spring` + `drinking_water=yes` | Developed spring | High |
| `natural=spring` (no drinking_water tag) | Natural spring, unverified | Medium |
| `amenity=drinking_water` | Tap/fountain, usually maintained | High (if seasonal) |
| `man_made=water_well` + `pump=manual` | Hand pump | Medium |
| `amenity=watering_place` | Stock tank / cattle trough | Low (contamination risk) |
| `seasonal=yes` | Explicitly seasonal | Low in dry season |
| `intermittent=yes` | Intermittent flow | Low |

### OSM limitations for backcountry routes
- Many springs in wilderness areas are unmapped or mapped without quality data
- "Last edited 2014" entries are common — water availability may have changed
- No real-time data; purely static
- **Mitigation:** Show OSM sources with edit age. Flag entries >3 years old as "unverified."

---

## Source 4: iOverlander

**Web:** https://www.ioverlander.com  
**API status:** No official public API documented. Community data is accessible via:
- Web scraping (fragile, ToS gray area)
- Bulk data export requests (contacted separately)
- KML/GPX exports from filtered searches on the website

**Coverage for Coconino Loop corridor:** Moderate — the route is popular enough that key water sources and camps are documented. Less reliable for obscure routes.

**Alternative: WaterReport.com** — a simpler community water report site used by PCT/CDT hikers. Less relevant for bikepacking-specific water (spigots, ADOT facilities, etc.) but good for wilderness springs.

**Integration approach for v1:** Allow user to import an iOverlander KML export as a supplemental layer. v2 could negotiate an API partnership or use a community feed.

---

## Source 5: USGS NHD (National Hydrography Dataset)

**Portal:** https://www.usgs.gov/national-hydrography  
**Data type:** Static GIS layers (not real-time)

Contains every mapped stream, river, spring, and water body in the US. This is the base geographic layer underlying USGS gauges. Key for our app:

- **Springs layer:** Point features for all mapped springs (regardless of USGS gauging)
- **Streams/Rivers layer:** Polylines for all watercourses — even ungauged ones
- **Waterbodies:** Lakes, reservoirs, ponds

**Integration:** Download the NHD for the relevant HUC-8 watersheds that intersect the route corridor. Cache locally as part of the offline data bundle. Use as a "potential water" layer — shows where water *might* be, then overlay USGS gauge data where available.

**Format:** GeoPackage (.gpkg) or GeoJSON — compatible with Turf.js and MapLibre.

---

## Coconino Loop: Known Water Sources Mapped to Data Sources

| Waypoint (from GPX) | Lat/Lon | Expected USGS Gauge? | OSM Coverage | Notes |
|---------------------|---------|---------------------|-------------|-------|
| Oak Creek (mile ~54) | 34.810, -111.825 | **Yes** — USGS 09504500 "Oak Creek near Sedona" | Mapped | Active gauge; ~7 cfs typical in May |
| Oak Creek (mile ~61) | 34.824, -111.796 | **Yes** — same gauge watershed | Mapped | Second crossing, slightly upstream |
| ADOT Little Antelope Spigot | 34.914, -111.645 | No — facility tap | Partial | ADOT maintenance yard; seasonal availability; confirm hours |
| Spigot (unlabeled) | 34.696, -112.121 | No — facility tap | Unknown | Likely a ranch/trailhead spigot; community-verify only |
| Verde River | 34.895, -112.206 | **Yes** — USGS 09508500 "Verde River near Clarkdale" | Mapped | Major river; reliable year-round; heavily gauged |

**Dry stretch risk:** The 165.6-mile Mogollon Rim segment (waypoints 5→6, miles 68–234) has the longest gaps between confirmed water. USGS gauges are sparse here; OSM + community data (iOverlander, CLR13 cuesheet notes) will be the primary sources in this stretch.

---

## Recommended Architecture: Water Layer Implementation

```
WaterLayer.fetch(routeCorridorGeoJSON, rideDate):

  Step 1 — USGS Monitoring Locations (bbox query)
    → Find all gauged sites within corridor
    → For each site: fetch current flow + 30-day history
    → Compute reliability score from flow percentile

  Step 2 — USGS NHD Springs (static layer, pre-downloaded by HUC-8)
    → Find all mapped springs within corridor
    → No real-time data; mark as "mapped, unverified"

  Step 3 — OSM Overpass (bbox query)
    → Find all tagged water POIs within corridor
    → Apply tag-based reliability scoring
    → Flag entries with edit age > 3 years

  Step 4 — Custom waypoints (from imported GPX)
    → Extract waypoints with water-indicating names or types
    → Override reliability with any route-specific notes

  Step 5 — Merge + deduplicate
    → Cluster sources within 100m → single source card
    → Priority: USGS gauge data > custom waypoints > OSM > NHD spring
    → Sort by route mile position

  Step 6 — Cache to IndexedDB
    → Store all sources with fetch timestamp
    → USGS data: show staleness indicator if > 2 hours old
    → OSM/NHD: treated as static (cached until manual refresh)
```

---

## API Rate Limits & Reliability

| Source | Rate limit | SLA / reliability | Notes |
|--------|-----------|------------------|-------|
| USGS OGC API | No hard limit (API key unlocks higher) | Very high (federal infrastructure) | Occasional maintenance windows |
| USGS Statistics API | Same | Very high | |
| OSM Overpass | ~10K req/day free tier | High | Self-hostable for production |
| iOverlander | None (scraping risk) | Moderate | ToS unclear; use KML import for v1 |
| WQP (Water Quality) | No limit stated | High | Large responses; cache aggressively |

---

## What the NIH Article Would Have Added

The PMC article (PMC12538040) was blocked by reCAPTCHA. Based on the citation context, it likely covers **streamflow trend analysis** — long-term drying trends in Western US streams. This aligns with the data.gov dataset also referenced. This is useful scientific background for the reliability scoring model (e.g., "streams in this HUC-8 have declined 23% in median May flow since 1980") but is secondary to real-time data. Will revisit if the article becomes accessible.
