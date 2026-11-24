/**
 * Carga de variantes: pipeline/experiments/<nombre>.ts con `export default` un ModelVariant. 'production' es la
 * variante vacía (producción actual) y 'baseline' la versión anterior de producción (types.ts); no necesitan archivo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASELINE_VARIANT, PRODUCTION_VARIANT, type ModelVariant } from './types';

export const EXPERIMENTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Archivos del directorio que no son variantes. */
const RESERVED = new Set(['types', 'history', 'load', 'bench', 'README', 'baseline', 'production']);

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** Comprueba la forma de una variante (lanza un Error en español si no es válida). */
export function validateVariant(v: unknown, source: string): ModelVariant {
  const fail = (why: string): never => {
    throw new Error(`Variante no válida (${source}): ${why}`);
  };
  if (!v || typeof v !== 'object') fail('el export default debe ser un objeto ModelVariant');
  const x = v as Record<string, unknown>;
  if (typeof x.name !== 'string' || !x.name) fail('falta `name`');
  if (typeof x.description !== 'string' || !x.description) fail('falta `description`');
  const fnOrUndef = (obj: unknown, key: string, where: string) => {
    const f = (obj as Record<string, unknown> | undefined)?.[key];
    if (f !== undefined && typeof f !== 'function') fail(`${where}.${key} debe ser una función`);
  };
  const numOrUndef = (obj: unknown, key: string, where: string) => {
    const n = (obj as Record<string, unknown> | undefined)?.[key];
    if (n !== undefined && !(typeof n === 'number' && Number.isFinite(n))) fail(`${where}.${key} debe ser un número finito`);
  };
  fnOrUndef(x, 'features', 'variant');
  fnOrUndef(x, 'lambdaAdjust', 'variant');
  for (const k of ['xi', 'windowDays', 'priorWeight']) numOrUndef(x.dc, k, 'dc');
  for (const k of ['fitGoals', 'weight']) fnOrUndef(x.dc, k, 'dc');
  for (const k of ['k', 'homeAdv', 'tierOffset']) numOrUndef(x.elo, k, 'elo');
  for (const k of ['kMultiplier', 'goalMultiplier']) fnOrUndef(x.elo, k, 'elo');
  const ha = (x.eloProbs as Record<string, unknown> | undefined)?.homeAdv;
  if (ha !== undefined) {
    if (!ha || typeof ha !== 'object') fail('eloProbs.homeAdv debe ser un objeto { grupo: puntos }');
    for (const [g, n] of Object.entries(ha as Record<string, unknown>)) {
      if (!/^(EU|AM)-(league|cup|continental)$/.test(g)) fail(`eloProbs.homeAdv: grupo desconocido «${g}»`);
      if (!(typeof n === 'number' && Number.isFinite(n))) fail(`eloProbs.homeAdv.${g} debe ser un número finito`);
    }
  }
  if (x.combine !== undefined) {
    const c = x.combine as Record<string, unknown>;
    if (typeof c.blend !== 'function') fail('combine.blend es obligatorio (función)');
    fnOrUndef(c, 'prepare', 'combine');
    if (c.refitEvery !== undefined && c.refitEvery !== 'monthly' && !(typeof c.refitEvery === 'number' && c.refitEvery >= 1)) {
      fail("combine.refitEvery debe ser 'monthly' o un número de días >= 1");
    }
  }
  fnOrUndef(x.totals, 'adjustTotal', 'totals');
  for (const k of ['priorN', 'halfLifeDays', 'leaguePriorN']) numOrUndef(x.stats, k, 'stats');
  const disp = (x.stats as Record<string, unknown> | undefined)?.dispersion;
  if (disp !== undefined && !['pooled', 'global', 'team', 'poisson'].includes(disp as string) && !(typeof disp === 'number' && disp > 0)) {
    fail("stats.dispersion debe ser 'pooled' | 'global' | 'team' | 'poisson' o un número > 0");
  }
  return v as ModelVariant;
}

/**
 * Accesos prohibidos en el código de una variante: leer datos por su cuenta (disco, data-store, red) es el único canal
 * de fuga que la comprobación por envenenamiento (en memoria) no vería. Los datos llegan SOLO por los ganchos.
 */
const FORBIDDEN_SOURCE: { re: RegExp; why: string }[] = [
  { re: /from\s+['"](node:)?fs(\/promises)?['"]|require\(\s*['"](node:)?fs/, why: 'importa fs (lectura de disco)' },
  { re: /\b(loadAllStores|loadStore|STORE_DIR|OUTPUT_DIR)\b|data-store|public\/data/, why: 'lee el data-store o los JSON publicados' },
  { re: /\bfetch\s*\(|from\s+['"](node:)?(https?|net)['"]/, why: 'hace peticiones de red' },
  { re: /\bcreateContext\s*\(|\bcomputeWalkForward\s*\(|\bbuildModelSuite\s*\(/, why: 'reconstruye modelos con todos los datos' },
];

/** Comprueba que el código fuente de una variante no lee datos por su cuenta (lanza un Error en español). */
export function checkVariantSource(source: string, file: string): void {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const f of FORBIDDEN_SOURCE) {
    if (f.re.test(code)) throw new Error(`${file}: la variante ${f.why}. Los datos solo pueden llegar por los ganchos (HistoryView, filas de reajuste…): ver pipeline/experiments/README.md`);
  }
}

/** Variantes disponibles (archivos .ts del directorio de experimentos, sin los módulos del banco). */
export function listVariants(): string[] {
  return fs
    .readdirSync(EXPERIMENTS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.slice(0, -3))
    .filter((n) => !RESERVED.has(n) && NAME_RE.test(n))
    .sort();
}

/** Carga una variante por nombre ('production' = producción actual; 'baseline' = versión anterior). */
export async function loadVariant(name: string): Promise<ModelVariant> {
  if (name === 'baseline') return BASELINE_VARIANT;
  if (name === 'production') return PRODUCTION_VARIANT;
  if (!NAME_RE.test(name) || RESERVED.has(name)) throw new Error(`Nombre de variante no válido: «${name}» (letras, números, - y _)`);
  const file = path.join(EXPERIMENTS_DIR, `${name}.ts`);
  if (!fs.existsSync(file)) {
    throw new Error(`No existe pipeline/experiments/${name}.ts. Disponibles: baseline, production, ${listVariants().join(', ') || '(ninguna)'}`);
  }
  checkVariantSource(fs.readFileSync(file, 'utf8'), `pipeline/experiments/${name}.ts`);
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  const v = validateVariant(mod.default, `pipeline/experiments/${name}.ts`);
  if (v.name !== name) throw new Error(`pipeline/experiments/${name}.ts exporta la variante «${v.name}»: el nombre debe coincidir con el archivo`);
  return v;
}
