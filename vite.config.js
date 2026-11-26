import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { SUBPAGE_PATHS } from './content/site.js';

// The homepage plus every content page listed in content/site.js. Their HTML is written by scripts/generate-pages.mjs,
// which runs first ("prebuild" / "predev" in package.json); each is built to the same path under dist/.
const input = { main: resolve(__dirname, 'index.html') };
for (const path of SUBPAGE_PATHS) input[path.slice(1).replace(/\//g, '-')] = resolve(__dirname, `.${path}/index.html`);

export default defineConfig({
  base: './',
  server: {
    port: 5180,
    strictPort: true,
    // `npm run dev` starts the API on 8788; forward it (and the admin dashboard) through Vite
    proxy: { '/api': 'http://localhost:8788', '/admin': 'http://localhost:8788', '/media': 'http://localhost:8788' },
  },
  build: {
    target: ['es2019', 'chrome80', 'safari13', 'firefox78'], chunkSizeWarningLimit: 700,   // runs on phones from ~2019 onwards
    rollupOptions: { input },
  },
});
