/**
 * Árbitro designado: multiplicador walk-forward de la severidad del árbitro en tarjetas y faltas (en PRODUCCIÓN desde
 * el 26-nov-2026; antes, variante referee-fouls-k30 del banco, que ahora reexporta este módulo).
 *
 * Para el árbitro del partido (`match.referee.id`) se toman sus partidos terminados ANTERIORES al inicio
 * (`history.refereeMatches`, todas las competiciones) y se compara lo observado con lo esperado:
 *   - observado: tarjetas (amarillas + rojas) del partido; mismas reglas que el banco (settleDataOf): sin prórroga y
 *     0 tarjetas = dato ausente. Faltas: sin prórroga y total > 0.
 *   - esperado (aproximación, no la proyección completa): media por partido de esa estadística en la competición y
 *     temporada del partido del árbitro, calculada con `history.compMatches` (solo partidos anteriores al corte del
 *     partido que se predice). Con < minCompN partidos con dato en esa temporada se usan todas las temporadas de la
 *     competición; con < minCompNAll, el partido no cuenta.
 *   - ratio con contracción empírico-bayesiana hacia 1 con k partidos ficticios:
 *       R = (ΣO + k·ē) / (ΣE + k·ē),   ē = ΣE / n  (media esperada por partido de la muestra del árbitro)
 *     n = 0 (o sin árbitro) ⇒ R = 1. Sin decaimiento temporal (los árbitros existen desde 2025-01).
 *
 * El multiplicador se aplica igual a los dos equipos (publish/context.ts statMultipliers, cuando la variante no trae
 * stats.adjust); las tarjetas llegan así también a las props de tarjeta de los jugadores (cardsFactor).
 *
 * Determinista y sin estado global. `memo` (opcional) guarda las medias por (corte, estadística, competición,
 * temporada): el build pasa una caché por contexto (muchos partidos comparten hora de inicio y competición); sin ella
 * la memoria vive solo durante una llamada. La clave incluye el corte EXACTO, así que el resultado es el mismo con y sin
 * caché.
 */
import { MODEL } from '../config';
import type { MatchRecord } from '../types';
import type { HistoryView, PreMatch, StatPairs } from '../experiments/types';
import { settleDataOf } from './settle';

/** mínimo de partidos con dato de la temporada de la competición para usar su media (si no, todas las temporadas) */
export const MIN_COMP_N = MODEL.referee.minCompN;
/** mínimo de partidos con dato de la competición (todas las temporadas); por debajo el partido del árbitro no cuenta */
export const MIN_COMP_N_ALL = MODEL.referee.minCompNAll;

export type RefStat = 'cards' | 'fouls';

export interface RefereeOptions {
  /** partidos ficticios del prior (ratio 1) de las tarjetas */
  kCards: number;
  /** partidos ficticios del prior de las faltas; ausente = las faltas no se tocan */
  kFouls?: number;
}

/** Caché de medias esperadas por (corte, estadística, competición, temporada); null = sin media suficiente. */
export type RefereeMemo = Map<string, number | null>;

/** Total observado de la estadística en un partido terminado (undefined = dato ausente o prórroga). */
export function observed(m: MatchRecord, stat: RefStat): number | undefined {
  const d = settleDataOf(m);
  if (!d || d.extraTime) return undefined;
  if (stat === 'cards') return d.cards;
  const fh = m.stats?.home?.fouls;
  const fa = m.stats?.away?.fouls;
  const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  if (!ok(fh) || !ok(fa) || fh + fa <= 0) return undefined;
  return fh + fa;
}

interface Acc {
  sum: number;
  n: number;
}

/**
 * Media esperada por partido de la estadística en la competición/temporada de `m`, con lo anterior al corte de
 * `history`.
 */
export function expectedFor(m: MatchRecord, stat: RefStat, history: HistoryView, memo: RefereeMemo): number | undefined {
  const key = `${history.cutoff}|${stat}|${m.compId}|${m.season}`;
  if (memo.has(key)) return memo.get(key) ?? undefined;
  const season: Acc = { sum: 0, n: 0 };
  const all: Acc = { sum: 0, n: 0 };
  for (const c of history.compMatches(m.compId)) {
    const o = observed(c, stat);
    if (o === undefined) continue;
    all.sum += o;
    all.n++;
    if (c.season === m.season) {
      season.sum += o;
      season.n++;
    }
  }
  const v = season.n >= MIN_COMP_N ? season.sum / season.n : all.n >= MIN_COMP_N_ALL ? all.sum / all.n : null;
  memo.set(key, v);
  return v ?? undefined;
}

export interface RefereeRatio {
  ratio: number;
  /** partidos del árbitro que cuentan */
  n: number;
  observed: number;
  expected: number;
}

/** Ratio contraído observado/esperado del árbitro para una estadística (1 si no hay árbitro ni partidos). */
export function refereeRatio(match: Pick<PreMatch, 'referee'>, history: HistoryView, stat: RefStat, k: number, memo: RefereeMemo = new Map()): RefereeRatio {
  const id = match.referee?.id;
  if (!id) return { ratio: 1, n: 0, observed: 0, expected: 0 };
  let O = 0;
  let E = 0;
  let n = 0;
  for (const m of history.refereeMatches(id)) {
    const o = observed(m, stat);
    if (o === undefined) continue;
    const e = expectedFor(m, stat, history, memo);
    if (e === undefined || !(e > 0)) continue;
    O += o;
    E += e;
    n++;
  }
  if (n === 0) return { ratio: 1, n: 0, observed: 0, expected: 0 };
  const eBar = E / n;
  const ratio = (O + k * eBar) / (E + k * eBar);
  return { ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 1, n, observed: O, expected: E };
}

/**
 * Multiplicadores de tarjetas y faltas por el árbitro (mismo factor para los dos equipos), solo de las estadísticas
 * presentes en `base`. Sin árbitro o con ratio 1: {} (producción sin árbitro).
 */
export function refereeMultipliers(
  match: Pick<PreMatch, 'referee'>,
  history: HistoryView,
  base: StatPairs,
  opts: RefereeOptions = MODEL.referee,
  memo: RefereeMemo = new Map(),
): StatPairs {
  const out: StatPairs = {};
  if (!match.referee?.id) return out;
  if (base.cards) {
    const r = refereeRatio(match, history, 'cards', opts.kCards, memo).ratio;
    if (r !== 1) out.cards = { home: r, away: r };
  }
  if (opts.kFouls !== undefined && base.fouls) {
    const r = refereeRatio(match, history, 'fouls', opts.kFouls, memo).ratio;
    if (r !== 1) out.fouls = { home: r, away: r };
  }
  return out;
}
