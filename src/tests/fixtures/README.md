# Captured API responses

These are recorded **verbatim** from the live services. They are evidence, not
source: Biome is configured to leave them alone (`files.ignore` in `biome.json`)
so a reformat cannot quietly change what they say.

They exist because every field-name fault in this app got through review the
same way — the test fixture and the buggy reader were written from the same
assumption. `water.test.js` asserted `monitoringLocationType`, a field the USGS
API has never returned, so the test passed while production read `undefined`.

A diff here is the signal that a service changed shape. Re-capture with:

```bash
# USGS monitoring locations (springs)
curl -s "https://api.waterdata.usgs.gov/ogcapi/v0/collections/monitoring-locations/items?f=json&bbox=-106.2,39.4,-105.8,39.7&limit=3&properties=monitoring_location_name,monitoring_location_number,site_type_code&site_type_code=SP" \
  -o usgs-monitoring-locations.json
```

```bash
# USGS daily percentiles — RDB only; this service rejects format=json
curl -s "https://waterservices.usgs.gov/nwis/stat/?sites=09066510&statReportType=daily&statTypeCd=p10,p25,p50,p75,p90&parameterCd=00060&format=rdb" | head -60 > usgs-percentiles.rdb
```

```bash
# BLM Surface Management Agency — layer 1; layer 0 is IDENTIFY and not queryable
curl -s "https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_with_PriUnk/MapServer/1/query?geometry=-106.0,39.5&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=ADMIN_AGENCY_CODE,ADMIN_DEPT_CODE,ADMIN_UNIT_NAME&returnGeometry=false&f=json" \
  -o blm-sma.json
```

```bash
# USFS National Wilderness Areas — answers in lowercase whatever the query casing
curl -s "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_Wilderness_01/MapServer/0/query?geometry=-105.40,39.30&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=WILDERNESSNAME&returnGeometry=false&f=json" \
  -o usfs-wilderness.json
```

Overpass has no fixture here: it is POST-only (see the note in `fetchOverpass`)
and rate-limits hard enough that a capture script is a liability. Its responses
are plain `{ elements: [...] }` with OSM tags, which the parsers already treat
as untrusted.
