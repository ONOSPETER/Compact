import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The UI talks to the Compact bridge (src/ui-server/server.mjs) through /api.
const bridge = `http://127.0.0.1:${(globalThis as any).process?.env?.COMPACT_UI_PORT ?? 8788}`;

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', port: 3001, allowedHosts: true, proxy: { '/api': bridge } }, // 3001 = the port your .replit already exposes
  preview: { host: '0.0.0.0', port: 3001, allowedHosts: true, proxy: { '/api': bridge } },
});
