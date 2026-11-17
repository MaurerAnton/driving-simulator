// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vite';

// Relative base so the build works both on GitHub Pages (project sub-path)
// and when opened from any static file server.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
