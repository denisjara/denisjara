/**
 * CSP de PRODUCCIÓN de la web (la aplica el plugin metrados:csp de vite.config.ts en `vite build`).
 *
 * index.html lleva una CSP permisiva para `npm run dev`. En el build se sustituye por esta:
 *  - script-src/style-src 'self' + el sha256 de cada script/style EN LÍNEA del HTML final (sin 'unsafe-inline').
 *    Los hashes se calculan en cada build: no hay que mantenerlos a mano.
 *  - 'wasm-unsafe-eval': pdf.js decodifica JPEG 2000 y JBIG2 (planos escaneados) con WebAssembly.
 *  - worker-src 'self' blob:: el hilo de trabajo de pdf.js.
 *  - img-src data: blob:: miniaturas y planos de imagen que el usuario abre desde su equipo.
 *  - connect-src 'self': la app no habla con ningún servidor; solo descarga sus propios recursos.
 * No se exige Trusted Types porque pdf.js crea su Worker a partir de una URL en texto.
 * frame-ancestors no funciona en <meta> (y GitHub Pages no permite cabeceras): ver .github/SECURITY.md.
 */
import { createHash } from 'node:crypto';

const sha256 = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

/** HTML sin comentarios: un comentario puede mencionar etiquetas (<script>…) sin serlo. */
const withoutComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');

/** Tipos de <script> que el navegador no ejecuta (datos incrustados): no necesitan hash. */
const INERT_SCRIPT = /type\s*=\s*["'](?:application\/json|text\/plain)["']/i;

/** Contenidos de los <script> ejecutables sin src y de los <style> del documento. */
export function inlineBlocks(html: string): { scripts: string[]; styles: string[] } {
  const code = withoutComments(html);
  return {
    scripts: [...code.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc\s*=/.test(m[1]) && !INERT_SCRIPT.test(m[1])).map((m) => m[2]),
    styles: [...code.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]),
  };
}

/** true si alguna etiqueta tiene atributo style="" (quedaría bloqueado sin 'unsafe-inline'). */
export function inlineStyleAttributes(html: string): boolean {
  return /<[^>]+\sstyle\s*=/i.test(withoutComments(html));
}

export function productionCspPolicy(html: string, opts: { standalone?: boolean } = {}): string {
  const { scripts, styles } = inlineBlocks(html);
  const self = opts.standalone ? [] : ["'self'"];
  return [
    opts.standalone ? "default-src 'none'" : "default-src 'self'",
    ['script-src', ...self, "'wasm-unsafe-eval'", ...(opts.standalone ? ['blob:'] : []), ...scripts.map(sha256)].join(' '),
    ['style-src', ...self, ...styles.map(sha256)].join(' '),
    ['font-src', ...self, 'data:'].join(' '),
    ['img-src', ...self, 'data:', 'blob:'].join(' '),
    opts.standalone ? "connect-src 'none'" : "connect-src 'self'",
    ['worker-src', ...self, 'blob:'].join(' '),
    "object-src 'none'",
    opts.standalone ? "base-uri 'none'" : "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
}
