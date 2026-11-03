/**
 * Utilidades del build: saneado/redondeo de JSON, escritura compacta, fechas por zona horaria, cronómetro.
 */
import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 86_400_000;
export { DAY_MS };

// ---------------------------------------------------------------------------
// Saneado de JSON
// ---------------------------------------------------------------------------

export interface CleanStats {
  /** valores no finitos eliminados (claves de objeto) */
  droppedKeys: number;
  /** valores no finitos sustituidos por 0 dentro de arrays */
  zeroedItems: number;
  /** rutas de ejemplo de los valores corregidos (máx. 20) */
  examples: string[];
}

export function newCleanStats(): CleanStats {
  return { droppedKeys: 0, zeroedItems: 0, examples: [] };
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
    if (typeof v === 'string') return secureEspnUrl(v);
    if (v === null || v === undefined) return undefined;
    if (Array.isArray(v)) {
      return v.map((x, i) => {
        const w = walk(x, `${p}[${i}]`);
        if (w === undefined) {
          stats.zeroedItems++;
          note(`${p}[${i}]`);
          return 0;
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

/** Sustituye `target` por el contenido de `staging` (borra solo `target`). */
export function swapDir(staging: string, target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(staging, target);
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
