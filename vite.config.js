import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5180,
    strictPort: true,
    // `npm run dev` starts the API on 8788; forward it (and the admin dashboard) through Vite
    proxy: { '/api': 'http://localhost:8788', '/admin': 'http://localhost:8788' },
  },
  build: { target: ['es2019', 'chrome80', 'safari13', 'firefox78'], chunkSizeWarningLimit: 700 },   // runs on phones from ~2019 onwards
});
