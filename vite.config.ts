import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// In dev, the sync server runs under `wrangler dev` on :8787 and Vite proxies to it,
// so the client always talks to its own origin, exactly like production.
const SERVER = process.env.KAIRO_SERVER ?? 'http://localhost:8787';
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' };

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
  server: {
    headers: isolation,
    proxy: {
      '/sync': { target: SERVER, ws: true, changeOrigin: true },
      '/ice': { target: SERVER, changeOrigin: true },
      '/debug': { target: SERVER, changeOrigin: true },
    },
  },
  preview: { headers: isolation },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
