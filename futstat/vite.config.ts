import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite copia todo public/ a dist/, incluidos los datos falsos de public/mock-data (solo para desarrollar la UI).
 * En un build que usa los datos reales (VITE_DATA_DIR distinto de "mock-data") se eliminan de dist/ para no publicarlos.
 */
function dropMockData(dataDir: string): Plugin {
  let outDir = '';
  return {
    name: 'futstat:drop-mock-data',
    apply: 'build',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      if (dataDir === 'mock-data' || !outDir) return;
      fs.rmSync(path.join(outDir, 'mock-data'), { recursive: true, force: true });
    },
  };
}

// base './' keeps the build portable (GitHub Pages sub-path, artifact preview, local file server).
// Routing uses HashRouter so no server rewrites are needed.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const dataDir = env.VITE_DATA_DIR || 'data';
  return {
    base: './',
    plugins: [react(), dropMockData(dataDir)],
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 900,
    },
  };
});
