import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// maplibre-gl v4 doesn't export its CSS sub-path in package.json "exports",
// so Rollup can't resolve it. We read the "style" field from maplibre-gl's
// own package.json to find the actual CSS path regardless of version layout.
const maplibrePkgDir = path.dirname(require.resolve('maplibre-gl/package.json'));
const maplibrePkg = require('maplibre-gl/package.json');
const MAPLIBRE_CSS = path.resolve(maplibrePkgDir, maplibrePkg.style ?? 'dist/maplibre-gl.css');

export default defineConfig({
  server: {
    port: 5173,
    strictPort: false,
    host: true,
  },
  preview: {
    // Must NOT share a port with `server` above. Preview serves the built app,
    // which registers the real Workbox service worker; a service worker controls
    // its whole origin, and localhost:<port> is the origin. Running preview on
    // the dev port therefore leaves a worker that serves its precached
    // production bundle to the dev server afterwards — dev edits stop appearing,
    // and the only tells are that a different port or a private window works.
    port: 4173,
    strictPort: true,
  },
  resolve: {
    alias: {
      'maplibre-gl/dist/maplibre-gl.css': MAPLIBRE_CSS,
    },
  },

  // Vitest runs in the same config — no separate vitest.config.js needed
  test: {
    environment: 'jsdom',
    include: ['src/tests/**/*.test.js'],
    alias: {
      'maplibre-gl/dist/maplibre-gl.css': MAPLIBRE_CSS,
      'maplibre-gl': path.resolve(__dirname, 'src/tests/__mocks__/maplibre-gl.js'),
    },
  },

  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Bikepacker Navigator',
        short_name: 'BPNav',
        description: 'Active logistical partner for multi-day bikepacking routes',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        runtimeCaching: [
          // USGS — both hosts. api.waterdata serves monitoring locations, and
          // waterservices serves live flow and percentile stats; only the first
          // was cached, so streamflow vanished offline. NetworkFirst keeps fresh
          // data winning while there is signal. The old 2 h expiry meant a cached
          // copy was already gone by the second morning of a trip; 30 days keeps
          // a stale reading available, which beats no reading in the backcountry.
          {
            urlPattern: /^https:\/\/(api\.waterdata|waterservices)\.usgs\.gov\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'usgs-water-data',
              networkTimeoutSeconds: 10,
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 30, maxEntries: 500 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // OSM Overpass — all four mirrors that fetchOverpass rotates through.
          // Only the primary was cached before, so whether water, camp and
          // resupply data survived offline depended on which mirror happened to
          // answer. 30-day expiry covers planning well ahead of a trip.
          {
            urlPattern:
              /^https:\/\/(overpass-api\.de|lz4\.overpass-api\.de|z\.overpass-api\.de|overpass\.kumi\.systems)\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'osm-overpass',
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 30, maxEntries: 500 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // Designated Wilderness boundaries. Bikes are barred from these, so a
          // rider needs the answer out of signal as much as in it — and the
          // polygons only change when Congress designates a new area.
          {
            urlPattern: /^https:\/\/apps\.fs\.usda\.gov\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'wilderness-boundaries',
              networkTimeoutSeconds: 15,
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 365, maxEntries: 100 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // Weather, elevation fallback and BLM land ownership. None were cached,
          // so all three simply failed once out of signal. They are advisory
          // rather than safety-critical, but a stale forecast still beats none.
          {
            urlPattern:
              /^https:\/\/(api\.open-meteo\.com|api\.opentopodata\.org|gis\.blm\.gov)\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'route-context-data',
              networkTimeoutSeconds: 10,
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 14, maxEntries: 500 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // OpenFreeMap style JSON + tiles — CacheFirst, large entry limit for full-route tiles.
          // Covers: style endpoint, vector tiles, raster tiles, terrain.
          {
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              // A 240 mi route needs ~2,100 tiles at z10-15 and ~4,300 at z10-16,
              // and the count scales with route length — a 2,700 mi route at
              // z10-15 is ~23,000, which the old 15,000 cap would have evicted
              // mid-ride, silently, starting with the tiles fetched first.
              // A year of expiry suits a route planned well in advance.
              expiration: {
                maxAgeSeconds: 60 * 60 * 24 * 365,
                maxEntries: 60000,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // MapLibre GL fonts (glyphs) — served from various CDN origins; cache aggressively.
          {
            urlPattern: /\/fonts\/.*\.pbf$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-fonts',
              expiration: {
                maxAgeSeconds: 60 * 60 * 24 * 90,
                maxEntries: 200,
              },
            },
          },
          // MapLibre GL sprites (icons) — small set, cache long-term.
          {
            urlPattern: /\/sprites\/.*\.(json|png)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-sprites',
              expiration: {
                maxAgeSeconds: 60 * 60 * 24 * 90,
                maxEntries: 50,
              },
            },
          },
        ],
      },
    }),
  ],
});
