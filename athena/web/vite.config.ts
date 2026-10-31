import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development /api is proxied to the local stack (`npm run dev:stack` in ../). In production the web app is
// served from the same origin as the Worker, so /api needs no proxy.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } } },
  build: { sourcemap: true, chunkSizeWarningLimit: 900 },
});
