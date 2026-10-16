import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  alias: {
    '@': path.resolve(__dirname, './src'),
  },
  vite: () => ({
    plugins: [preact(), tailwindcss()],
  }),
  manifest: {
    name: 'Vesta Dub',
    short_name: 'Vesta Dub',
    version: '0.1.0',
    description: 'YouTube videolarını Türkçe dinle. Altyazılardan seslendirme, iki Türkçe ses ve videoya uyum sağlayan konuşma hızı.',
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: 'Vesta Dub',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
      },
    },
    permissions: ['storage', 'tabs', 'offscreen'],
    host_permissions: [
      'https://www.youtube.com/*',
      'https://translation.googleapis.com/*',
      'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/*',
    ],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    web_accessible_resources: [
      {
        resources: ['models/*', '*.wasm', '*.mjs', 'icons/*'],
        matches: ['*://*.youtube.com/*', '*://youtube.com/*'],
      },
    ],
  },
});
