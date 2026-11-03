/**
 * CSP de PRODUCCIÓN de la web (la aplica el plugin futstat:csp de vite.config.ts en `vite build`).
 *
 * index.html lleva una CSP permisiva para `npm run dev` (Vite inyecta <style> y su overlay usa innerHTML). En el build se
 * sustituye por esta, más estricta:
 *  - script-src/style-src 'self' + el sha256 de cada script/style EN LÍNEA del HTML final (sin 'unsafe-inline' y sin
 *    el hash del preámbulo de React Fast Refresh, que solo existe en desarrollo). Los hashes se calculan en cada build:
 *    no hay que mantenerlos a mano.
 *  - Trusted Types ('none'): ningún texto puede acabar en innerHTML/eval/script.src aunque algún día se añada un
 *    sumidero así (React aplica estilos y texto por DOM/CSSOM, que no se ven afectados).
 *  - Tipografías y estilos solo propios (autoalojados en src/assets/fonts).
 * frame-ancestors no funciona en <meta> (y GitHub Pages no permite cabeceras): ver .github/SECURITY.md.
 */
import { createHash } from 'node:crypto';

const sha256 = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

/** HTML sin comentarios: un comentario puede mencionar etiquetas (<script>…) sin serlo. */
const withoutComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');

/** Contenidos de los <script> sin src y de los <style> del documento. */
export function inlineBlocks(html: string): { scripts: string[]; styles: string[] } {
  const code = withoutComments(html);
  return {
    scripts: [...code.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]),
    styles: [...code.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]),
  };
}

/** true si alguna etiqueta tiene atributo style="" (quedaría bloqueado sin 'unsafe-inline'). */
export function inlineStyleAttributes(html: string): boolean {
  return /<[^>]+\sstyle\s*=/i.test(withoutComments(html));
}

export function productionCspPolicy(html: string): string {
  const { scripts, styles } = inlineBlocks(html);
  return [
    "default-src 'self'",
    ["script-src 'self'", ...scripts.map(sha256)].join(' '),
    ["style-src 'self'", ...styles.map(sha256)].join(' '),
    "font-src 'self'",
    "img-src 'self' data: https://a.espncdn.com https://*.espncdn.com",
    "connect-src 'self' https://site.api.espn.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}
