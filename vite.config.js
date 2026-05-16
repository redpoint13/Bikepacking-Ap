import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// maplibre-gl v4 doesn't export its CSS sub-path in package.json "exports",
// so Rollup can't resolve it. We read the "style" field from maplibre-gl's
// own package.json to find the actual CSS path regardless of version layout.
const maplibrePkgDir = path.dirname(require.resolve('maplibre-gl/package.json'));
const maplibrePkg = require('maplibre-gl/package.json');
const MAPLIBRE_CSS = path.resolve(maplibrePkgDir, maplibrePkg.style ?? 'dist/maplibre-gl.css');

export default defineConfig({
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
          // USGS water data — NetworkFirst so fresh data wins; 2 h cache as offline fallback.
          {
            urlPattern: /^https:\/\/api\.waterdata\.usgs\.gov\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'usgs-water-data',
              expiration: { maxAgeSeconds: 60 * 60 * 2 },
            },
          },
          // OSM Overpass — StaleWhileRevalidate: serve cached instantly, refresh in background.
          // 7-day expiry covers a typical multi-day route planning window.
          {
            urlPattern: /^https:\/\/overpass-api\.de\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'osm-overpass',
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
          // OpenFreeMap style JSON + tiles — CacheFirst, large entry limit for full-route tiles.
          // Covers: style endpoint, vector tiles, raster tiles, terrain.
          {
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: {
                maxAgeSeconds: 60 * 60 * 24 * 30,
                maxEntries: 1000,
              },
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
