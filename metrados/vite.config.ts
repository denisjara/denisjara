import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { inlineStyleAttributes, productionCspPolicy } from './scripts/csp';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * pdf.js necesita en tiempo de ejecución algunos archivos que no van en el bundle: decodificadores WebAssembly
 * (JPEG 2000, JBIG2, perfiles de color), mapas de caracteres y las tipografías estándar para los PDF que no las
 * incrustan. Se copian de node_modules/pdfjs-dist a public/pdfjs/ (no se versionan) al arrancar dev o build.
 */
function pdfjsAssets(): Plugin {
  return {
    name: 'metrados:pdfjs-assets',
    buildStart() {
      const from = path.join(ROOT, 'node_modules', 'pdfjs-dist');
      const to = path.join(ROOT, 'public', 'pdfjs');
      for (const dir of ['wasm', 'cmaps', 'standard_fonts', 'iccs']) {
        fs.cpSync(path.join(from, dir), path.join(to, dir), {
          recursive: true,
          // quickjs solo sirve para ejecutar scripts de formularios PDF: no se usa.
          filter: (src) => !/quickjs/i.test(path.basename(src)),
        });
      }
    },
  };
}

/**
 * CSP de PRODUCCIÓN (solo `vite build`): sustituye la CSP de desarrollo de index.html por la de scripts/csp.ts,
 * calculada sobre el HTML final (hashes de los <script>/<style> en línea, sin 'unsafe-inline').
 */
function productionCsp(): Plugin {
  return {
    name: 'metrados:csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (inlineStyleAttributes(html)) throw new Error('metrados:csp: index.html tiene atributos style=""; usa una clase en el <style> de la cabecera.');
        const meta = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/i;
        if (!meta.test(html)) throw new Error('metrados:csp: falta <meta http-equiv="Content-Security-Policy"> en index.html.');
        return html.replace(meta, (_, a: string, b: string) => `${a}${productionCspPolicy(html)}${b}`);
      },
    },
  };
}

// base './' mantiene el build portátil (subcarpeta de GitHub Pages, servidor local, vista previa de artefactos).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Versión portátil (`npm run build:standalone`): todo el JS y el CSS en un único bloque cada uno y las tipografías
  // como data: URIs; scripts/build-standalone.ts lo junta, con el worker de pdf.js, en un solo HTML.
  if (env.VITE_STANDALONE === '1') {
    return {
      base: './',
      plugins: [react()],
      publicDir: false,
      resolve: {
        alias: [{ find: /^\.\/worker-src$/, replacement: './worker-src.standalone' }],
      },
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
    plugins: [react(), pdfjsAssets(), productionCsp()],
    // Seguridad en el equipo de desarrollo: los servidores de `npm run dev` y `npm run preview` escuchan solo en
    // 127.0.0.1 (no se exponen a la red local) y, si el puerto está ocupado, fallan en lugar de saltar a otro.
    server: { host: '127.0.0.1', port: 5174, strictPort: true },
    preview: { host: '127.0.0.1', port: 4174, strictPort: true },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 1200,
    },
  };
});
