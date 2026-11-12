/**
 * Versión PORTÁTIL de FutStat Lab: un único archivo HTML con la app, las tipografías, TODOS los datos del día y los
 * escudos de los equipos.
 *
 *   npm run build:standalone   →  standalone/FutStat-Lab.html
 *
 * Se abre con doble clic (file://) en cualquier navegador moderno, sin servidor, sin instalar nada y sin conexión
 * (con internet además funciona el marcador en vivo).
 *
 *  - Datos: los ~900 JSON de public/data, cada uno comprimido con gzip y en base64 dentro de un bloque
 *    <script type="application/json"> inerte. La app descomprime cada archivo solo cuando se visita
 *    (DecompressionStream), así abre rápido y usa poca memoria.
 *  - Escudos: se descargan de ESPN a 64 px (con caché en .cache/logos) y van como data: URIs en otro bloque JSON.
 *    Se incluyen por prioridad (ligas y competiciones principales primero) hasta el tope de tamaño; los que no
 *    caben muestran las iniciales del equipo y, con internet, se cargan de ESPN.
 *  - Seguridad: CSP propia calculada sobre el HTML final (sha256 de cada bloque en línea, sin 'unsafe-inline',
 *    Trusted Types); el JSON incrustado lleva '<' escapado; los datos se validan igual que los descargados.
 *
 * Requiere: public/data generado (npm run data:build) y `VITE_STANDALONE=1 vite build` (dist-standalone/).
 */
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { COMPETITIONS, OUTPUT_DIR, ROOT_DIR } from '../pipeline/config';

const BUILD_DIR = path.join(ROOT_DIR, 'dist-standalone');
const OUT_DIR = path.join(ROOT_DIR, 'standalone');
const OUT_FILE = path.join(OUT_DIR, 'FutStat-Lab.html');
const LOGO_CACHE = path.join(ROOT_DIR, '.cache', 'logos');
/** Tope del archivo final: por debajo de 16 MB para que también se pueda publicar como página única. */
const MAX_FILE_BYTES = Number(process.env.STANDALONE_MAX_BYTES ?? 15_700_000);
const LOGO_SIZE = 64;
const LOGO_MAX_BYTES = 60_000;
const LOGO_CONCURRENCY = 8;
const PACKED_FORMAT = 'futstat-gz64-v1';
/**
 * Web publicada de la que el archivo descargado se actualiza solo cuando hay internet (GitHub Pages del repo).
 * En CI se deriva del repositorio; en local, de esta variable o del valor por defecto.
 */
export const REMOTE_DATA_URL = (process.env.STANDALONE_REMOTE_URL ?? 'https://denisjara.github.io/denisjara/data/').trim();

type Json = Record<string, unknown>;
const sha256 = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------

function listDataFiles(dir = OUTPUT_DIR): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && /^[a-z0-9/.-]+\.json$/i.test(r)) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

/** Todos los JSON publicados, cada uno validado como JSON y comprimido (gzip + base64). */
export function packData(dir = OUTPUT_DIR): { files: Record<string, string>; rawBytes: number; texts: string[] } {
  const files: Record<string, string> = {};
  const texts: string[] = [];
  let rawBytes = 0;
  for (const rel of listDataFiles(dir)) {
    const text = fs.readFileSync(path.join(dir, rel), 'utf8');
    JSON.parse(text); // un JSON roto no se empaqueta: mejor fallar aquí que en el navegador
    rawBytes += Buffer.byteLength(text);
    texts.push(text);
    files[rel] = gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).toString('base64');
  }
  if (!files['meta.json'] || !files['home.json']) throw new Error('Faltan meta.json/home.json en public/data: ejecuta npm run data:build');
  return { files, rawBytes, texts };
}

// ---------------------------------------------------------------------------
// Escudos
// ---------------------------------------------------------------------------

const LOGO_PATH = /^\/i\/(?:teamlogos|leaguelogos)\/soccer\/(?:500|500-dark)\/[0-9]+\.png$/;

/** URLs de escudos/logos referenciadas en los datos, por prioridad (competiciones top primero). */
export function logoUrlsByPriority(texts: string[], dir = OUTPUT_DIR): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const add = (u: unknown) => {
    if (typeof u !== 'string') return;
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      return;
    }
    if (url.protocol !== 'https:' || url.hostname !== 'a.espncdn.com' || !LOGO_PATH.test(url.pathname)) return;
    if (!seen.has(url.href)) {
      seen.add(url.href);
      order.push(url.href);
    }
  };
  const byTier = [...COMPETITIONS].sort((a, b) => b.tier - a.tier || (a.kind === 'league' ? -1 : 1));
  for (const c of byTier) {
    const f = path.join(dir, 'competitions', `${c.id}.json`);
    if (!fs.existsSync(f)) continue;
    const comp = JSON.parse(fs.readFileSync(f, 'utf8')) as Json;
    const meta = comp.meta as Json | undefined;
    add(meta?.logo);
    add(meta?.logoDark);
    for (const g of (comp.standings as Json[] | undefined) ?? []) for (const r of (g.rows as Json[] | undefined) ?? []) add((r.team as Json)?.logo);
    for (const t of (comp.teams as Json[] | undefined) ?? []) add((t.team as Json)?.logo);
  }
  for (const text of texts) for (const m of text.matchAll(/"(https:\/\/a\.espncdn\.com\/i\/[^"]+\.png)"/g)) add(m[1]);
  return order;
}

const isPng = (b: Buffer) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a;

async function fetchLogo(href: string): Promise<Buffer | null> {
  const key = createHash('sha1').update(`${href}@${LOGO_SIZE}`).digest('hex');
  const cached = path.join(LOGO_CACHE, `${key}.png`);
  if (fs.existsSync(cached)) {
    const b = fs.readFileSync(cached);
    if (isPng(b) && b.length <= LOGO_MAX_BYTES) return b;
  }
  const { pathname } = new URL(href);
  const src = `https://a.espncdn.com/combiner/i?img=${pathname}&w=${LOGO_SIZE}&h=${LOGO_SIZE}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(src, { signal: ctrl.signal, headers: { 'User-Agent': 'FutStatLab/1.0' } });
      if (res.status === 404) return null;
      if (res.ok) {
        const b = Buffer.from(await res.arrayBuffer());
        if (!isPng(b) || b.length > LOGO_MAX_BYTES) return null;
        fs.mkdirSync(LOGO_CACHE, { recursive: true });
        fs.writeFileSync(`${cached}.tmp`, b);
        fs.renameSync(`${cached}.tmp`, cached);
        return b;
      }
    } catch {
      /* reintento */
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  return null;
}

/** Descarga (o lee de la caché) los escudos y devuelve url → data URI, respetando el presupuesto de bytes. */
export async function collectLogos(urls: string[], budget: number): Promise<{ logos: Record<string, string>; missing: number; overBudget: number }> {
  const results = new Array<Buffer | null>(urls.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: LOGO_CONCURRENCY }, async () => {
      while (next < urls.length) {
        const i = next++;
        results[i] = await fetchLogo(urls[i]);
      }
    }),
  );
  const logos: Record<string, string> = {};
  let used = 0;
  let missing = 0;
  let overBudget = 0;
  urls.forEach((u, i) => {
    const b = results[i];
    if (!b) return void missing++;
    const uri = `data:image/png;base64,${b.toString('base64')}`;
    const cost = uri.length + u.length + 6;
    if (used + cost > budget) return void overBudget++;
    logos[u] = uri;
    used += cost;
  });
  return { logos, missing, overBudget };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** JSON seguro dentro de <script type="application/json">: ningún '<' puede cerrar la etiqueta ni abrir un comentario. */
export function embedJson(v: unknown): string {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return JSON.stringify(v).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');
}

/** Código JS dentro de <script>: neutraliza cualquier '</script' literal. */
const inlineScript = (code: string) => code.replace(/<\/(script)/gi, '<\\/$1');
const inlineStyle = (css: string) => css.replace(/<\/(style)/gi, '<\\/$1');

export function standaloneCsp(html: string, remote: string = REMOTE_DATA_URL): string {
  const code = html.replace(/<!--[\s\S]*?-->/g, '');
  const scripts = [...code.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/\bsrc\s*=/.test(m[1]) && !/type\s*=\s*["']application\/json["']/i.test(m[1]))
    .map((m) => m[2]);
  const styles = [...code.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  return [
    "default-src 'none'",
    ['script-src', ...scripts.map(sha256)].join(' '),
    ['style-src', ...styles.map(sha256)].join(' '),
    'font-src data:',
    'img-src data: https://a.espncdn.com https://*.espncdn.com',
    ['connect-src https://site.api.espn.com', ...(remote ? [new URL(remote).origin] : [])].join(' '),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join('; ');
}

/** index.html de dist-standalone con CSS y JS en línea (sin datos todavía). */
function inlineApp(): { html: string; app: string; marker: string } {
  const indexPath = path.join(BUILD_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) throw new Error('Falta dist-standalone/index.html: ejecuta `npm run build:standalone`.');
  let html = fs.readFileSync(indexPath, 'utf8');
  const js = [...html.matchAll(/<script\b[^>]*\bsrc="\.\/(assets\/[^"]+\.js)"[^>]*><\/script>/gi)];
  const css = [...html.matchAll(/<link\b[^>]*\bhref="\.\/(assets\/[^"]+\.css)"[^>]*>/gi)];
  if (js.length !== 1) throw new Error(`Se esperaba 1 script de la app y hay ${js.length}.`);
  for (const m of css) {
    const content = fs.readFileSync(path.join(BUILD_DIR, m[1]), 'utf8');
    if (/url\(\s*["']?\.\.?\//.test(content)) throw new Error(`${m[1]} aún referencia archivos externos.`);
    html = html.replace(m[0], () => `<style>${inlineStyle(content)}</style>`);
  }
  const marker = '<!--futstat:payload-->';
  html = html.replace(js[0][0], () => marker);
  if (/(?:src|href)="\.\/assets\//.test(html)) throw new Error('Quedan referencias a ./assets en el HTML.');
  // El enlace «Recargar» de la pantalla de arranque apunta a ./?recarga=1, que en un archivo local no existe.
  html = html.replace('href="./?recarga=1"', 'href=""');
  return { html, app: fs.readFileSync(path.join(BUILD_DIR, js[0][1]), 'utf8'), marker };
}

function assemble(base: { html: string; app: string; marker: string }, data: Record<string, string>, logos: Record<string, string>): string {
  const payload =
    `<script id="futstat-data" type="application/json">${embedJson({ format: PACKED_FORMAT, remote: REMOTE_DATA_URL || undefined, files: data })}</script>\n` +
    `<script id="futstat-logos" type="application/json">${embedJson(logos)}</script>\n` +
    `<script type="module">${inlineScript(base.app)}</script>`;
  let html = base.html.replace(base.marker, () => payload);
  const meta = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/i;
  if (!meta.test(html)) throw new Error('Falta la meta CSP en index.html.');
  html = html.replace(meta, (_, a: string, b: string) => `${a}${standaloneCsp(html)}${b}`);
  return html;
}

async function main() {
  if (REMOTE_DATA_URL && !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])[^\s"']+\/$/.test(REMOTE_DATA_URL)) {
    throw new Error(`STANDALONE_REMOTE_URL no válida: ${REMOTE_DATA_URL} (https y terminada en /)`);
  }
  const base = inlineApp();
  const { files, rawBytes, texts } = packData();
  const withoutLogos = Buffer.byteLength(assemble(base, files, {}));
  const urls = logoUrlsByPriority(texts);
  const { logos, missing, overBudget } = await collectLogos(urls, Math.max(0, MAX_FILE_BYTES - withoutLogos - 20_000));
  const html = assemble(base, files, logos);
  const size = Buffer.byteLength(html);
  if (size > MAX_FILE_BYTES) throw new Error(`El archivo pesa ${(size / 1_048_576).toFixed(1)} MB (máximo ${(MAX_FILE_BYTES / 1_048_576).toFixed(1)}).`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = `${OUT_FILE}.tmp`;
  fs.writeFileSync(tmp, html);
  fs.renameSync(tmp, OUT_FILE);
  const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;
  console.log(`✓ ${path.relative(ROOT_DIR, OUT_FILE)} · ${mb(size)}`);
  console.log(`  datos: ${Object.keys(files).length} archivos (${mb(rawBytes)} → comprimidos en el HTML)`);
  console.log(`  escudos: ${Object.keys(logos).length} de ${urls.length} incluidos · no disponibles en ESPN: ${missing} · fuera por tamaño: ${overBudget}`);
  console.log(`  se actualiza solo (con internet) desde: ${REMOTE_DATA_URL || '— (desactivado)'}`);
}

const invokedDirectly = !!process.argv[1] && /build-standalone\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((e: unknown) => {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
