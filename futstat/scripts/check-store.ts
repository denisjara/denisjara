/**
 * Puerta de calidad del almacén incremental (data-store/) antes de guardarlo en la caché de CI.
 *
 *   npx tsx scripts/check-store.ts snapshot <archivo.json> [dir]            resumen (partidos, jugadores, filas) por competición
 *   npx tsx scripts/check-store.ts check [--baseline=<archivo.json>] [dir]   valida el almacén y lo compara con el resumen
 *
 * `check` falla (código 1) si:
 *  - algún <compId>.json no se puede leer o no tiene forma de almacén (validación profunda de pipeline/store.ts);
 *  - más del 5 % de los registros de una competición están mal formados;
 *  - respecto al resumen tomado ANTES de la descarga, una competición desaparece o pierde más del 25 % de sus partidos,
 *    líneas de jugador o filas de clasificación (un fallo que vacía o recorta el almacén no debe sustituir en la caché
 *    al último almacén bueno: si esto falla, la caché no se guarda y la siguiente ejecución parte del anterior).
 * Un almacén que crece o se mantiene pasa; las podas normales (partidos de hace más de 900 días) son mucho menores.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { STORE_DIR } from '../pipeline/config';
import { readStoreFile } from '../pipeline/store';

export interface StoreSummary {
  [compId: string]: { matches: number; players: number; standingRows: number };
}

/** Pérdida máxima tolerada entre el almacén restaurado y el que se va a guardar. */
export const MAX_SHRINK = 0.25;
/** Por debajo de estos tamaños no se comprueba la pérdida (competiciones nuevas o casi vacías). */
const MIN_FOR_SHRINK = { matches: 40, players: 200, standingRows: 8 };
const MAX_DROPPED_SHARE = 0.05;

const storeFiles = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^[a-z0-9-]+\.json$/.test(f)).sort() : []);

export function summarizeStore(dir: string = STORE_DIR): { summary: StoreSummary; problems: string[] } {
  const summary: StoreSummary = {};
  const problems: string[] = [];
  for (const f of storeFiles(dir)) {
    const compId = f.replace(/\.json$/, '');
    let raw: { matches?: unknown[]; players?: unknown[] } | undefined;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (e) {
      problems.push(`${f}: JSON ilegible (${(e as Error).message})`);
      continue;
    }
    const r = readStoreFile(path.join(dir, f), compId);
    if (!r) {
      problems.push(`${f}: no tiene la forma de un almacén de FutStat`);
      continue;
    }
    const total = (Array.isArray(raw?.matches) ? raw.matches.length : 0) + (Array.isArray(raw?.players) ? raw.players.length : 0);
    if (total > 0 && r.dropped / total > MAX_DROPPED_SHARE) problems.push(`${f}: ${r.dropped} de ${total} registros mal formados`);
    summary[compId] = {
      matches: r.store.matches.length,
      players: r.store.players.length,
      standingRows: r.store.standings.reduce((n, g) => n + g.rows.length, 0),
    };
  }
  return { summary, problems };
}

/** Problemas de "encogimiento" entre el resumen anterior (`before`) y el actual (`after`). */
export function shrinkProblems(before: StoreSummary, after: StoreSummary, maxShrink = MAX_SHRINK): string[] {
  const out: string[] = [];
  for (const [comp, b] of Object.entries(before)) {
    const a = after[comp];
    if (!a) {
      if (b.matches > 0) out.push(`${comp}: el almacén ha desaparecido (antes ${b.matches} partidos)`);
      continue;
    }
    for (const k of ['matches', 'players', 'standingRows'] as const) {
      if (b[k] >= MIN_FOR_SHRINK[k] && a[k] < b[k] * (1 - maxShrink)) {
        out.push(`${comp}: ${k} ha bajado de ${b[k]} a ${a[k]} (más del ${Math.round(maxShrink * 100)} %)`);
      }
    }
  }
  return out;
}

function annotate(level: 'error' | 'notice', title: string, msg: string): void {
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::${level} title=${title}::${msg.replace(/\r?\n/g, ' ')}`);
  else console.log(`${level === 'error' ? 'ERROR' : 'Aviso'}: ${title}. ${msg}`);
}

export function main(args: string[]): number {
  const [cmd, ...rest] = args;
  const positional = rest.filter((a) => !a.startsWith('--'));
  if (cmd === 'snapshot') {
    const file = positional[0];
    if (!file) throw new Error('Uso: check-store.ts snapshot <archivo.json> [dir]');
    const { summary } = summarizeStore(positional[1] ?? STORE_DIR);
    fs.writeFileSync(file, JSON.stringify(summary));
    console.log(`Resumen del almacén restaurado: ${Object.keys(summary).length} competiciones → ${file}`);
    return 0;
  }
  if (cmd === 'check') {
    const dir = positional[0] ?? STORE_DIR;
    if (!fs.existsSync(dir)) {
      console.log('Sin almacén todavía (primera ejecución).');
      return 0;
    }
    const { summary, problems } = summarizeStore(dir);
    const baselineArg = rest.find((a) => a.startsWith('--baseline='))?.slice('--baseline='.length);
    if (baselineArg && fs.existsSync(baselineArg)) {
      let before: StoreSummary = {};
      try {
        before = JSON.parse(fs.readFileSync(baselineArg, 'utf8')) as StoreSummary;
      } catch {
        problems.push(`resumen previo ilegible: ${baselineArg}`);
      }
      problems.push(...shrinkProblems(before, summary));
    }
    if (problems.length) {
      annotate('error', 'Almacén dañado o recortado', `${problems.slice(0, 10).join('; ')}. No se guarda en caché: la próxima ejecución parte del último almacén bueno.`);
      return 1;
    }
    const totals = Object.values(summary).reduce((t, s) => ({ m: t.m + s.matches, p: t.p + s.players }), { m: 0, p: 0 });
    console.log(`Almacén correcto: ${Object.keys(summary).length} competiciones, ${totals.m} partidos, ${totals.p} líneas de jugador.`);
    return 0;
  }
  console.error('Uso: check-store.ts snapshot <archivo.json> [dir] | check [--baseline=<archivo.json>] [dir]');
  return 2;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
