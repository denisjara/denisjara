/**
 * Versión PORTÁTIL de FutStat Lab: un único archivo HTML con la app, las tipografías y los datos del día.
 *
 *   npm run build:standalone   →  standalone/FutStat-Lab.html
 *
 * Se abre con doble clic (file://) en cualquier navegador, sin servidor, sin instalar nada y sin conexión (solo el
 * marcador en vivo y los escudos necesitan internet). Para que el archivo quede en un tamaño manejable (< ~14 MB) se
 * incluyen todas las competiciones, la portada, jugadores, valor y modelo, y una selección de fichas de partido y de
 * equipo (las más relevantes primero) hasta llenar el presupuesto; los enlaces a fichas no incluidas se desactivan.
 *
 * Seguridad: CSP propia calculada sobre el HTML final (sha256 de cada bloque en línea, sin 'unsafe-inline', Trusted
 * Types), datos incrustados como JSON inerte (<script type="application/json">, con '<' escapado) y validados por la
 * app igual que los descargados.
 *
 * Requiere: public/data generado (npm run data:build) y `VITE_STANDALONE=1 vite build` (dist-standalone/).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { OUTPUT_DIR, ROOT_DIR } from '../pipeline/config';

const BUILD_DIR = path.join(ROOT_DIR, 'dist-standalone');
const OUT_DIR = path.join(ROOT_DIR, 'standalone');
const OUT_FILE = path.join(OUT_DIR, 'FutStat-Lab.html');
/** Presupuesto para los datos incrustados (bytes). El archivo final queda ~1,2 MB por encima. */
const DATA_BUDGET = Number(process.env.STANDALONE_DATA_BUDGET ?? 12_500_000);
const MAX_FILE_BYTES = 15_500_000;
const COMP_PLAYERS = 60;
const GLOBAL_PLAYERS = 300;
const TOP_COMPS = ['champions', 'laliga', 'premier', 'seriea', 'bundesliga', 'ligue1', 'chile', 'libertadores', 'europa', 'brasileirao', 'argentina', 'ligamx', 'primeira', 'eredivisie', 'mls', 'superlig'];

type Json = Record<string, unknown>;
const sha256 = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

function readJson(rel: string): Json | null {
  const f = path.join(OUTPUT_DIR, rel);
  if (!fs.existsSync(f)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(f, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Json[]) : []);
const idOf = (m: Json | undefined): string | null => (m && typeof m.id === 'string' ? m.id : null);

/** Selección de archivos de datos dentro del presupuesto. */
export function selectData(budget = DATA_BUDGET): { files: Record<string, Json>; skipped: { matches: number; teams: number } } {
  const files: Record<string, Json> = {};
  let used = 0;
  const put = (rel: string, v: Json) => {
    files[rel] = v;
    used += bytes(v);
  };

  for (const rel of ['meta.json', 'home.json', 'model.json', 'value.json']) {
    const v = readJson(rel);
    if (!v) throw new Error(`Falta public/data/${rel}: ejecuta npm run data:build`);
    put(rel, v);
  }
  const players = readJson('players.json');
  if (players) put('players.json', { ...players, players: arr(players.players).slice(0, GLOBAL_PLAYERS) });

  const meta = files['meta.json'];
  const compIds = arr(meta.competitions).map((c) => String(c.id));
  const comps: Record<string, Json> = {};
  for (const id of compIds) {
    const v = readJson(`competitions/${id}.json`);
    if (!v) continue;
    comps[id] = v;
    put(`competitions/${id}.json`, { ...v, players: arr(v.players).slice(0, COMP_PLAYERS) });
  }

  // Fichas de partido por relevancia: portada (populares, hoy, mañana, recientes), valor, y luego próximos de las
  // competiciones principales por turnos.
  const order: string[] = [];
  const add = (id: string | null) => {
    if (id && !order.includes(id)) order.push(id);
  };
  const home = files['home.json'];
  for (const k of ['popular', 'today', 'tomorrow', 'recent']) arr(home[k]).forEach((m) => add(idOf(m)));
  arr(home.topValue).forEach((b) => add(idOf(b.match as Json)));
  arr(files['value.json'].bets).forEach((b) => add(idOf(b.match as Json)));
  const ups = TOP_COMPS.map((c) => arr(comps[c]?.upcoming));
  for (let i = 0; i < 30; i++) ups.forEach((u) => add(idOf(u[i])));

  const matchBudget = used + (budget - used) * 0.62;
  const teamOrder: string[] = [];
  let skippedMatches = 0;
  for (const id of order) {
    const v = readJson(`matches/${id}.json`);
    if (!v) continue;
    if (used + bytes(v) > matchBudget) {
      skippedMatches++;
      continue;
    }
    put(`matches/${id}.json`, v);
    const m = v.match as Json | undefined;
    for (const side of ['home', 'away']) {
      const t = (m?.[side] as Json | undefined)?.id;
      if (typeof t === 'string' && !teamOrder.includes(t)) teamOrder.push(t);
    }
  }
  for (const c of TOP_COMPS) {
    for (const t of arr(comps[c]?.teams)) {
      const id = (t.team as Json | undefined)?.id;
      if (typeof id === 'string' && !teamOrder.includes(id)) teamOrder.push(id);
    }
  }
  let skippedTeams = 0;
  for (const id of teamOrder) {
    const v = readJson(`teams/${id}.json`);
    if (!v) continue;
    if (used + bytes(v) > budget) {
      skippedTeams++;
      continue;
    }
    put(`teams/${id}.json`, v);
  }

  // Enlaces a fichas de partido que no van en el archivo → desactivados (MatchSummary.hasDetail / FormMatch.hasDetail).
  const included = new Set(Object.keys(files).filter((k) => k.startsWith('matches/')).map((k) => k.slice(8, -5)));
  const fix = (o: unknown): void => {
    if (Array.isArray(o)) return o.forEach(fix);
    if (!o || typeof o !== 'object') return;
    const r = o as Json;
    if (r.hasDetail === true) {
      const id = 'home' in r && 'away' in r ? r.id : r.matchId;
      if (typeof id === 'string' && !included.has(id)) r.hasDetail = false;
    }
    Object.values(r).forEach(fix);
  };
  Object.values(files).forEach(fix);
  return { files, skipped: { matches: skippedMatches, teams: skippedTeams } };
}

/** JSON seguro dentro de <script type="application/json">: ningún '<' puede cerrar la etiqueta ni abrir un comentario. */
export function embedJson(v: unknown): string {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return JSON.stringify(v).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');
}

/** Código JS dentro de <script>: neutraliza cualquier '</script' literal. */
const inlineScript = (code: string) => code.replace(/<\/(script)/gi, '<\\/$1');
const inlineStyle = (css: string) => css.replace(/<\/(style)/gi, '<\\/$1');

export function standaloneCsp(html: string): string {
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
    'connect-src https://site.api.espn.com',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join('; ');
}

function main() {
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
  const { files, skipped } = selectData();
  const app = fs.readFileSync(path.join(BUILD_DIR, js[0][1]), 'utf8');
  html = html.replace(
    js[0][0],
    () => `<script id="futstat-data" type="application/json">${embedJson(files)}</script>\n<script type="module">${inlineScript(app)}</script>`,
  );
  if (/(?:src|href)="\.\/assets\//.test(html)) throw new Error('Quedan referencias a ./assets en el HTML.');

  const meta = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/i;
  if (!meta.test(html)) throw new Error('Falta la meta CSP en index.html.');
  // La CSP se calcula con el contenido definitivo (el propio atributo content no forma parte de ningún bloque).
  html = html.replace(meta, (_, a: string, b: string) => `${a}${standaloneCsp(html)}${b}`);
  // El enlace «Recargar» de la pantalla de arranque apunta a ./?recarga=1, que en un archivo local no existe.
  html = html.replace('href="./?recarga=1"', 'href=""');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = `${OUT_FILE}.tmp`;
  fs.writeFileSync(tmp, html);
  fs.renameSync(tmp, OUT_FILE);
  const size = fs.statSync(OUT_FILE).size;
  const counts = Object.keys(files).reduce<Record<string, number>>((acc, k) => {
    const g = k.includes('/') ? k.split('/')[0] : 'raíz';
    acc[g] = (acc[g] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`✓ ${path.relative(ROOT_DIR, OUT_FILE)} · ${(size / 1_048_576).toFixed(1)} MB`);
  console.log(`  datos: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')} · fuera por tamaño: ${skipped.matches} partidos, ${skipped.teams} equipos`);
  if (size > MAX_FILE_BYTES) throw new Error(`El archivo pesa ${(size / 1_048_576).toFixed(1)} MB (máximo ${(MAX_FILE_BYTES / 1_048_576).toFixed(1)}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? '')) {
  try {
    main();
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
