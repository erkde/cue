import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const buildId =
  process.env.GITHUB_SHA?.slice(0, 8) ||
  process.env.CF_VERSION_METADATA_ID ||
  new Date().toISOString();

export default defineConfig({
  define: {
    __CUE_BUILD__: JSON.stringify(buildId),
  },
  worker: {
    format: 'es',
  },
  plugins: [
    cloudflare(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['icons/icon.svg'],
      manifest: {
        name: 'Cue — voice-tracking teleprompter',
        short_name: 'Cue',
        description: 'A teleprompter that listens to the narrator and follows along.',
        start_url: '.',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0b0f14',
        theme_color: '#0b0f14',
        icons: [
          {
            src: 'icons/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
      workbox: {
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{html,js,css,md}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/hf\//, /^\/lib\//, /^\/log$/],
      },
    }),
  ],
});
