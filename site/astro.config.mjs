import { defineConfig } from 'astro/config';

// BASE_PATH is set when the site is served from a subpath (GitHub Pages: /claimable-bot-promises/).
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  compressHTML: true,
  build: { inlineStylesheets: 'auto' },
  devToolbar: { enabled: false },
});
