import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dev server and the proxy both listen on loopback only. API calls go to /api and are
// proxied to the backend, so the browser sees a single origin (no CORS, no token leaks).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: process.env.API_TARGET ?? 'http://127.0.0.1:8080', changeOrigin: false } },
  },
  preview: { host: '127.0.0.1', port: 4173 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.js'],
    globals: false,
    css: false,
  },
});
