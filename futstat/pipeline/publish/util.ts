/**
 * Utilidades del build: saneado/redondeo de JSON, escritura compacta, fechas por zona horaria, cronómetro.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAY_MS = 86_400_000;
export { DAY_MS };

// ---------------------------------------------------------------------------
// Saneado de JSON
// ---------------------------------------------------------------------------

export interface CleanStats {
  /** valores no finitos (o URLs no permitidas) eliminados (claves de objeto) */
  droppedKeys: number;
  /** valores no finitos sustituidos por 0 dentro de arrays */
  zeroedItems: number;
  /** textos corregidos (caracteres de control, `<script`, `javascript:`) */
  sanitizedStrings?: number;
  /** rutas de ejemplo de los valores corregidos (máx. 20) */
  examples: string[];
}

export function newCleanStats(): CleanStats {
  return { droppedKeys: 0, zeroedItems: 0, sanitizedStrings: 0, examples: [] };
}

// Texto publicado: defensa en profundidad (la normalización de ESPN ya sanea, pero el almacén puede traer datos
// antiguos). Las URLs solo se publican si son https en el CDN de ESPN; el resto de textos pierde los caracteres de
// control y cualquier `<script` / `javascript:` / `data:text/html`.
const URLISH = /^\s*[a-z][a-z0-9+.-]*:\/\//i;
const ALLOWED_URL = /^https:\/\/([a-z0-9-]+\.)*espncdn\.com\/[^\s"'<>]*$/i;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;
const DANGEROUS = /<\s*script|(?:java|vb)script\s*:|data\s*:\s*text\/html/gi;

/** Texto apto para publicar, o undefined si es una URL no permitida. */
export function sanitizePublishedString(s: string): string | undefined {
  if (URLISH.test(s)) {
    const u = secureEspnUrl(s.trim());
    return ALLOWED_URL.test(u) ? u : undefined;
  }
  // Hasta que no cambie: una sola pasada se salta con anidamientos ("<<script" → "<script",
  // "javajavascript:script:" → "javascript:"), que luego el validador rechaza bloqueando toda la publicación.
  let out = s.replace(CONTROL_CHARS, '');
  for (let i = 0; i < 20; i++) {
    const next = out.replace(DANGEROUS, (m) => m.replace(/[<:]/g, ' ').trim());
    if (next === out) return out;
    out = next;
  }
  return out.replace(/[<:]/g, ' '); // anidamiento absurdo: fuera todos los '<' y ':'
}

function roundTo(x: number, digits: number): number {
  if (Number.isInteger(x)) return x;
  const f = 10 ** digits;
  const r = Math.round(Math.abs(x) * f) / f;
  return x < 0 ? (r === 0 ? 0 : -r) : r;
}

/**
 * Copia profunda apta para JSON: redondea los números no enteros a `digits` decimales (máximo), elimina las
 * claves con valores no finitos/undefined/null (el contrato omite los opcionales) y sustituye por 0 los no
 * finitos dentro de arrays. Cuenta las correcciones en `stats` para poder avisar en el log.
 */
export function cleanJson<T>(value: T, digits = 5, stats: CleanStats = newCleanStats(), at = '$'): T {
  const note = (p: string) => {
    if (stats.examples.length < 20) stats.examples.push(p);
  };
  const walk = (v: unknown, p: string): unknown => {
    if (typeof v === 'number') return Number.isFinite(v) ? roundTo(v, digits) : undefined;
    if (typeof v === 'string') {
      const w = sanitizePublishedString(v);
      if (w !== v && w !== undefined) {
        stats.sanitizedStrings = (stats.sanitizedStrings ?? 0) + 1;
        note(p);
      }
      return w;
    }
    if (v === null || v === undefined) return undefined;
    if (Array.isArray(v)) {
      // un elemento inválido se sustituye por un valor del MISMO tipo (0 para números, '' para textos como una URL no
      // permitida) para no romper arrays tipados (string[] con un 0 dentro rompería el contrato)
      return v.map((x, i) => {
        const w = walk(x, `${p}[${i}]`);
        if (w === undefined) {
          stats.zeroedItems++;
          note(`${p}[${i}]`);
          return typeof x === 'string' ? '' : 0;
        }
        return w;
      });
    }
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (x === undefined) continue;
        const w = walk(x, `${p}.${k}`);
        if (w === undefined) {
          stats.droppedKeys++;
          note(`${p}.${k}`);
          continue;
        }
        out[k] = w;
      }
      return out;
    }
    return v;
  };
  return walk(value, at) as T;
}

/**
 * ESPN devuelve algunos logos con `http://` (p. ej. LaLiga 2, Copa Chile). En una web servida por HTTPS son
 * contenido mixto (bloqueado o con aviso), así que se publican siempre como `https://` (el CDN lo soporta).
 */
export function secureEspnUrl(s: string): string {
  return /^http:\/\/([a-z0-9-]+\.)*(espncdn|espn)\.com\//i.test(s) ? `https://${s.slice(7)}` : s;
}

/** Redondeo de probabilidades publicadas (4 decimales). */
export const rp = (x: number): number => roundTo(x, 4);

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

const SAFE_REL = /^(?:[a-z]+\/)?[A-Za-z0-9_-]{1,40}\.json$/;

export class JsonWriter {
  readonly root: string;
  files = 0;
  bytes = 0;
  readonly bytesByDir = new Map<string, { files: number; bytes: number }>();
  readonly clean = newCleanStats();

  constructor(root: string) {
    this.root = root;
  }

  /** Escribe `rel` (relativo a la raíz) como JSON compacto saneado. Devuelve los bytes escritos. */
  write(rel: string, data: unknown): number {
    // los nombres salen de ids de ESPN: nunca rutas (../), solo `nombre.json` o `dir/nombre.json` seguros
    if (!SAFE_REL.test(rel)) throw new Error(`Nombre de archivo de salida no permitido: ${JSON.stringify(rel)}`);
    const file = path.join(this.root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = JSON.stringify(cleanJson(data, 5, this.clean, rel));
    fs.writeFileSync(file, body);
    const n = Buffer.byteLength(body);
    this.files++;
    this.bytes += n;
    const dir = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '.';
    const e = this.bytesByDir.get(dir) ?? { files: 0, bytes: 0 };
    e.files++;
    e.bytes += n;
    this.bytesByDir.set(dir, e);
    return n;
  }
}

/** Directorio donde se aparta la versión publicada anterior mientras se sustituye. */
export function previousDirFor(target: string): string {
  return `${target.replace(/[\\/]+$/, '')}.prev`;
}

/** Directorio temporal donde se genera la salida antes de validarla. */
export function stagingDirFor(outDir: string): string {
  return `${outDir.replace(/[\\/]+$/, '')}.tmp`;
}

// ---------------------------------------------------------------------------
// Guardia del directorio de salida (protege el equipo del desarrollador)
// ---------------------------------------------------------------------------
// El build SUSTITUYE la salida (y borra <salida>.tmp / <salida>.prev). Con `--out=.`, `--out=src` o
// `--out=~/Documents` eso borraría código o documentos. Regla: solo se sustituye/borra un directorio que no existe,
// está vacío o tiene la forma de una salida de FutStat: meta.json (salvo el temporal, que se escribe al final) y
// EXCLUSIVAMENTE archivos .json con nombre seguro en la raíz y en competitions/, matches/ y teams/. Cualquier otra
// cosa (código, documentos, carpetas ajenas, enlaces) se rechaza sin tocar nada.
const OUT_SUB_DIRS = new Set(['competitions', 'matches', 'teams']);
const OUT_SAFE_FILE = /^[A-Za-z0-9_-]{1,40}\.json$/;

/** El destino no es una salida de FutStat: no se puede sustituir ni borrar. */
export class UnsafeOutputError extends Error {
  constructor(dir: string, reason: string) {
    super(
      `No se escribe en ${dir}: ${reason}. El build sustituye por completo el directorio de salida, así que solo acepta ` +
        'uno que no exista, esté vacío o contenga únicamente una salida anterior de FutStat (meta.json, home.json… y ' +
        'competitions/, matches/, teams/). Elige otro --out (por defecto public/data).',
    );
    this.name = 'UnsafeOutputError';
  }
}

/** Motivo por el que `dir` no puede sustituirse/borrarse (undefined = seguro: no existe, vacío o solo salida de FutStat). */
export function foreignContent(dir: string, opts: { requireMeta?: boolean } = {}): string | undefined {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return undefined; // no existe
  }
  if (st.isSymbolicLink()) return 'es un enlace simbólico';
  if (!st.isDirectory()) return 'no es un directorio';
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory() && OUT_SUB_DIRS.has(e.name)) {
      for (const f of fs.readdirSync(path.join(dir, e.name), { withFileTypes: true })) {
        if (!f.isFile() || !OUT_SAFE_FILE.test(f.name)) return `contiene ${e.name}/${f.name}, que no es un archivo de datos de FutStat`;
      }
    } else if (!(e.isFile() && OUT_SAFE_FILE.test(e.name))) {
      return `contiene ${e.name}${e.isDirectory() ? '/' : ''}, que no es un archivo de datos de FutStat`;
    }
  }
  if (opts.requireMeta && entries.length > 0 && !entries.some((e) => e.isFile() && e.name === 'meta.json')) {
    return 'no está vacío y no contiene meta.json (no parece una salida de FutStat)';
  }
  return undefined;
}

/**
 * Comprueba que se puede publicar en `outDir` sin borrar nada ajeno: ni la raíz del disco, ni la carpeta personal, ni
 * el proyecto o una carpeta que lo contenga, y que la salida, <salida>.tmp y <salida>.prev solo tengan datos de FutStat.
 */
export function assertSafeOutputDir(outDir: string, projectRoot: string): void {
  const abs = path.resolve(outDir);
  const root = path.resolve(projectRoot);
  if (abs === path.parse(abs).root) throw new UnsafeOutputError(abs, 'es la raíz del disco');
  if (abs === path.resolve(os.homedir())) throw new UnsafeOutputError(abs, 'es tu carpeta personal');
  const rel = path.relative(abs, root);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new UnsafeOutputError(abs, 'es el proyecto o una carpeta que lo contiene');
  for (const [d, requireMeta] of [[abs, true], [stagingDirFor(abs), false], [previousDirFor(abs), true]] as const) {
    const why = foreignContent(d, { requireMeta });
    if (why) throw new UnsafeOutputError(d, why);
  }
}

// ---------------------------------------------------------------------------
// Cerrojo entre procesos (dos builds o dos descargas a la vez se pisaban el directorio temporal)
// ---------------------------------------------------------------------------
/** Otro proceso de FutStat está usando el mismo recurso. */
export class LockedError extends Error {
  constructor(what: string, holder: string) {
    super(`${what} ya está en uso por otro proceso (${holder}). Espera a que termine; si no hay ninguno en marcha, vuelve a intentarlo en unos minutos.`);
    this.name = 'LockedError';
  }
}

const LOCK_MAX_AGE_MS = 6 * 3_600_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Ruta del cerrojo de un recurso (en el directorio temporal del sistema: no ensucia public/ ni data-store/). */
export function lockPathFor(kind: string, resource: string): string {
  const h = createHash('sha1').update(path.resolve(resource)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `futstat-${kind}-${h}.lock`);
}

/**
 * Cerrojo exclusivo (fs.openSync 'wx'). Un cerrojo huérfano (proceso muerto, otro equipo o más de 6 h) se sustituye.
 * Devuelve la función que lo libera (también se libera al salir del proceso).
 */
export function acquireLock(kind: string, resource: string, what: string): () => void {
  const file = lockPathFor(kind, resource);
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), resource: path.resolve(resource) });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, body);
      fs.closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.removeListener('exit', release);
        try {
          const cur = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
          if (cur.pid === process.pid) fs.rmSync(file, { force: true });
        } catch {
          /* ya no existe */
        }
      };
      process.on('exit', release);
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let holder: { pid?: number; host?: string; startedAt?: string } = {};
      try {
        holder = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        /* cerrojo ilegible: huérfano */
      }
      const age = Date.now() - Date.parse(holder.startedAt ?? '');
      const stale = typeof holder.pid !== 'number' || holder.host !== os.hostname() || !(age < LOCK_MAX_AGE_MS) || !pidAlive(holder.pid);
      if (!stale) throw new LockedError(what, `PID ${holder.pid} desde ${holder.startedAt}`);
      fs.rmSync(file, { force: true });
    }
  }
  throw new LockedError(what, 'cerrojo en disputa');
}

/**
 * Recupera un cambio de directorio interrumpido (proceso matado entre los dos renombrados): si falta `target` pero
 * existe `<target>.prev`, se restaura; si existen ambos, `.prev` sobra y se borra.
 */
export function recoverInterruptedSwap(target: string): void {
  const prev = previousDirFor(target);
  if (!fs.existsSync(prev)) return;
  if (!fs.existsSync(target)) fs.renameSync(prev, target);
  else fs.rmSync(prev, { recursive: true, force: true });
}

/**
 * Sustituye `target` por `staging` con renombrados (operaciones atómicas en el mismo sistema de archivos):
 * target → target.prev, staging → target y, solo al final, se borra target.prev. Si el segundo renombrado falla se
 * restaura la versión anterior, de modo que `target` nunca queda vacío ni a medias.
 */
export function swapDir(staging: string, target: string): void {
  const prev = previousDirFor(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(prev, { recursive: true, force: true });
  const hadTarget = fs.existsSync(target);
  if (hadTarget) fs.renameSync(target, prev);
  try {
    fs.renameSync(staging, target);
  } catch (e) {
    if (hadTarget && !fs.existsSync(target)) fs.renameSync(prev, target);
    throw e;
  }
  fs.rmSync(prev, { recursive: true, force: true });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** Día local "YYYY-MM-DD" de un instante en una zona horaria IANA. */
export function localDay(ms: number, timeZone: string): string {
  let f = dayFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(timeZone, f);
  }
  return f.format(new Date(ms));
}

/** Día local siguiente a `day` ("YYYY-MM-DD"), sin depender de la zona (aritmética de calendario). */
export function nextDay(day: string): string {
  const t = Date.parse(`${day}T12:00:00Z`) + DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Varios
// ---------------------------------------------------------------------------

/** Hash FNV-1a de 32 bits (semillas reproducibles). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Cronómetro de fases para el log del build. */
export class PhaseTimer {
  private t0 = performance.now();
  private last = this.t0;
  readonly phases: { name: string; seconds: number }[] = [];
  private readonly log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  lap(name: string, detail = ''): number {
    const now = performance.now();
    const s = (now - this.last) / 1000;
    this.last = now;
    this.phases.push({ name, seconds: s });
    this.log(`  ✓ ${name.padEnd(40)} ${s.toFixed(2).padStart(7)} s${detail ? `  ${detail}` : ''}`);
    return s;
  }

  total(): number {
    return (performance.now() - this.t0) / 1000;
  }
}

/** Añade `item` a la lista de `key` en un Map de arrays. */
export function pushTo<K, V>(map: Map<K, V[]>, key: K, item: V): void {
  const arr = map.get(key);
  if (arr) arr.push(item);
  else map.set(key, [item]);
}
