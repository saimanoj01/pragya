import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { injectIntoDist } from './scripts/swPrecache.mjs';

/** B3.1: write the build manifest + versioned cache key into dist/sw.js. */
function pragyaSwPrecache(): Plugin {
  let outDir = 'dist';
  let templatePath: string | undefined;
  let buildFailed = false;
  return {
    name: 'pragya-sw-precache',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      templatePath = config.publicDir ? path.join(config.publicDir, 'sw.js') : undefined;
    },
    buildStart() {
      buildFailed = false;
    },
    buildEnd(error) {
      if (error) buildFailed = true;
    },
    renderError() {
      buildFailed = true;
    },
    closeBundle() {
      // R1#5: never mask the real build error with an injection failure.
      if (buildFailed) return;
      let result: ReturnType<typeof injectIntoDist>;
      try {
        result = injectIntoDist(outDir, { templatePath });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`[pragya-sw-precache] ${message}`);
      }
      if (result) {
        console.info(`sw.js: ${result.list.length} precached files, build ${result.buildId}`);
      } else {
        console.warn(
          `[pragya-sw-precache] ${path.join(outDir, 'sw.js')} is missing — the build ships without a service worker.`
        );
      }
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), pragyaSwPrecache()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    host: true,
  },
  base: process.env.VITE_BASE_PATH || './',
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/scheduler/')
          ) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/framer-motion')) {
            return 'vendor-motion';
          }
          if (id.includes('node_modules/lucide-react')) {
            return 'vendor-icons';
          }
        },
      },
    },
  },
});
