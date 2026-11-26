/**
 * Factor ÁRBITRO (variantes referee-*.ts): multiplicador walk-forward de la severidad del árbitro designado.
 *
 * Para el árbitro del partido (`match.referee.id`) se toman sus partidos terminados ANTERIORES al inicio
 * (`history.refereeMatches`, todas las competiciones) y se compara lo observado con lo esperado:
 *   - observado: tarjetas (amarillas + rojas) del partido; mismas reglas que el banco (settleDataOf): sin prórroga y
 *     0 tarjetas = dato ausente. Faltas: sin prórroga y total > 0.
 *   - esperado (aproximación, no la proyección completa de producción): media por partido de esa estadística en la
 *     competición y temporada del partido del árbitro, calculada con `history.compMatches` (solo partidos anteriores al
 *     corte del partido que se predice). Con < MIN_COMP_N partidos con dato en esa temporada se usan todas las
 *     temporadas de la competición; con < MIN_COMP_N_ALL, el partido no cuenta.
 *   - ratio con contracción empírico-bayesiana hacia 1 con k partidos ficticios:
 *       R = (ΣO + k·ē) / (ΣE + k·ē),   ē = ΣE / n  (media esperada por partido de la muestra del árbitro)
 *     n = 0 (o sin árbitro) ⇒ R = 1 (producción). Sin decaimiento temporal (los árbitros existen desde 2025-01).
 *
 * Determinista, sin estado global: las medias por competición se memorizan SOLO dentro de una llamada.
 * El multiplicador se aplica igual a los dos equipos (stats.adjust); las tarjetas llegan así también a las props de
 * tarjeta de los jugadores (cardsFactor).
 */
import { settleDataOf } from '../../analytics/settle';
import type { MatchRecord } from '../../types';
import type { HistoryView, PreMatch, StatPairs } from '../types';

/** mínimo de partidos con dato de la temporada de la competición para usar su media (si no, todas las temporadas) */
export const MIN_COMP_N = 20;
/** mínimo de partidos con dato de la competición (todas las temporadas); por debajo el partido del árbitro no cuenta */
export const MIN_COMP_N_ALL = 10;

export type RefStat = 'cards' | 'fouls';

export interface RefereeOptions {
  /** partidos ficticios del prior (ratio 1) de las tarjetas */
  kCards: number;
  /** partidos ficticios del prior de las faltas; ausente = las faltas no se tocan */
  kFouls?: number;
}

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
 * `history`. `memo` vive solo durante una llamada.
 */
export function expectedFor(m: MatchRecord, stat: RefStat, history: HistoryView, memo: Map<string, number | null>): number | undefined {
  const key = `${stat}|${m.compId}|${m.season}`;
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
export function refereeRatio(match: Pick<PreMatch, 'referee'>, history: HistoryView, stat: RefStat, k: number, memo = new Map<string, number | null>()): RefereeRatio {
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

/** Multiplicadores de stats.adjust (mismo factor para los dos equipos). */
export function refereeMultipliers(match: PreMatch, history: HistoryView, base: StatPairs, opts: RefereeOptions): StatPairs {
  const out: StatPairs = {};
  if (!match.referee?.id) return out;
  const memo = new Map<string, number | null>();
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
