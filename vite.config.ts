import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const rendererRoot = fileURLToPath(new URL('./src/renderer', import.meta.url));

// The dev host runs the *real* main-process services on any OS (see dev-host/server.ts).
// In dev mode the renderer talks to it over HTTP + SSE instead of Electron IPC, which
// keeps the UI honest: every button drives real application logic.
const devHostEnabled = Boolean(process.env.CLOUDSSD_DEV_HOST);
const devHost = process.env.CLOUDSSD_DEV_HOST ?? 'http://127.0.0.1:8787';

export default defineConfig({
  root: rendererRoot,
  envDir: fileURLToPath(new URL('./', import.meta.url)),
  plugins: [react()],
  define: {
    'import.meta.env.VITE_DEV_HOST': JSON.stringify(devHostEnabled ? '1' : '0'),
  },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // The e2b preview proxies an arbitrary host name: allow any host header.
    allowedHosts: true,
    hmr: { clientPort: 443, protocol: 'wss' },
    proxy: {
      '/api': { target: devHost, changeOrigin: false },
      '/events': { target: devHost, changeOrigin: false, ws: false },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
});
