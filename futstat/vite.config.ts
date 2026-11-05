import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { inlineStyleAttributes, productionCspPolicy } from './scripts/csp';

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
      if (!outDir) return;
      // Restos de una publicación interrumpida del pipeline (public/data.tmp, public/data.prev): nunca se publican.
      for (const leftover of ['data.tmp', 'data.prev', 'mock-data.tmp', 'mock-data.prev']) {
        fs.rmSync(path.join(outDir, leftover), { recursive: true, force: true });
      }
      if (dataDir === 'mock-data') return;
      fs.rmSync(path.join(outDir, 'mock-data'), { recursive: true, force: true });
    },
  };
}

/**
 * CSP de PRODUCCIÓN (solo `vite build`): sustituye la CSP de desarrollo de index.html por la de scripts/csp.ts,
 * calculada sobre el HTML final (hashes de los <script>/<style> en línea, sin 'unsafe-inline', con Trusted Types).
 */
function productionCsp(): Plugin {
  return {
    name: 'futstat:csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        // Un atributo style="" en el HTML quedaría bloqueado sin 'unsafe-inline': mejor fallar el build que publicarlo roto.
        if (inlineStyleAttributes(html)) throw new Error('futstat:csp: index.html tiene atributos style=""; usa una clase en el <style> de la cabecera.');
        const meta = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/i;
        if (!meta.test(html)) throw new Error('futstat:csp: falta <meta http-equiv="Content-Security-Policy"> en index.html.');
        return html.replace(meta, (_, a: string, b: string) => `${a}${productionCspPolicy(html)}${b}`);
      },
    },
  };
}

// base './' keeps the build portable (GitHub Pages sub-path, artifact preview, local file server).
// Routing uses HashRouter so no server rewrites are needed.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const dataDir = env.VITE_DATA_DIR || 'data';
  // Versión portátil (`npm run build:standalone`): todo el JS y el CSS en un único bloque cada uno y las tipografías
  // como data: URIs, para que scripts/build-standalone.ts lo meta todo, con los datos, en un solo HTML.
  // Su CSP la calcula ese script sobre el HTML final.
  const standalone = env.VITE_STANDALONE === '1';
  if (standalone) {
    return {
      base: './',
      plugins: [react()],
      publicDir: false,
      build: {
        outDir: 'dist-standalone',
        emptyOutDir: true,
        sourcemap: false,
        cssCodeSplit: false,
        modulePreload: false,
        assetsInlineLimit: 100_000_000,
        chunkSizeWarningLimit: 5_000,
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    };
  }
  return {
    base: './',
    plugins: [react(), dropMockData(dataDir), productionCsp()],
    // Seguridad en el equipo de desarrollo: los servidores de `npm run dev` y `npm run preview`
    // escuchan solo en 127.0.0.1 (no se exponen a la red local / wifi) y, si el puerto está
    // ocupado, fallan en lugar de saltar a otro puerto en silencio.
    server: {
      host: '127.0.0.1',
      strictPort: true,
    },
    preview: {
      host: '127.0.0.1',
      strictPort: true,
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 900,
    },
  };
});
