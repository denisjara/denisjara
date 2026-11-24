/**
 * Total de goles en partidos SIN línea de goles del mercado: contracción hacia la media de la competición.
 *
 * Diagnóstico (agente «totals», ventanas anteriores al holdout): sin mercado, el total esperado del Dixon-Coles está
 * demasiado disperso ENTRE partidos (donde predecía 1,78 goles hubo 2,12 y donde predecía 3,25 hubo 2,85; pendiente de
 * la recalibración logística de «más de 2,5» ≈ 0,63). Con línea de goles del mercado el total ya viene del mercado y
 * no se toca; en copas nacionales tampoco (los cruces entre divisiones tienen totales extremos de verdad).
 *
 * La media de la competición se calcula solo con partidos terminados que empezaron antes que el partido predicho
 * (vista del pasado): sin estado, sin fuga.
 */
import { MODEL } from '../config';
import type { MatchRecord } from '../types';

const DAY_MS = 86_400_000;

/** Total de goles de referencia cuando la competición no tiene historial. */
export const GLOBAL_TOTAL = MODEL.totalShrink.globalTotal;

export interface LeagueTotalOptions {
  /** días de historial de la competición */
  windowDays: number;
  /** vida media (días) de la ponderación temporal */
  halfLifeDays: number;
  /** partidos ficticios hacia GLOBAL_TOTAL */
  priorN: number;
}

export const LEAGUE_TOTAL_DEFAULTS: LeagueTotalOptions = {
  windowDays: MODEL.totalShrink.windowDays,
  halfLifeDays: MODEL.totalShrink.halfLifeDays,
  priorN: MODEL.totalShrink.priorN,
};

/** Lo que necesita la media de la competición: el corte y los partidos terminados anteriores (cronológicos). */
export interface PastCompMatches {
  readonly cutoff: number;
  compMatches(compId: string): readonly MatchRecord[];
}

function goalsOf(m: MatchRecord): number | undefined {
  const h = m.score?.home;
  const a = m.score?.away;
  return typeof h === 'number' && typeof a === 'number' && Number.isFinite(h) && Number.isFinite(a) ? h + a : undefined;
}

/**
 * Media de goles por partido de la competición antes del corte (ponderada por antigüedad y contraída hacia
 * GLOBAL_TOTAL). Solo usa `before.compMatches` (partidos terminados con inicio anterior al corte).
 */
export function leagueTotal(before: PastCompMatches, compId: string, o: Partial<LeagueTotalOptions> = {}): { mean: number; n: number } {
  const opt = { ...LEAGUE_TOTAL_DEFAULTS, ...o };
  const from = before.cutoff - opt.windowDays * DAY_MS;
  let sw = 0;
  let sg = 0;
  let n = 0;
  const ms = before.compMatches(compId);
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    const t = Date.parse(m.date);
    if (!(t >= from)) break;
    const g = goalsOf(m);
    if (g === undefined) continue;
    const w = Math.pow(0.5, (before.cutoff - t) / DAY_MS / opt.halfLifeDays);
    sw += w;
    sg += w * g;
    n++;
  }
  return { mean: (sg + opt.priorN * GLOBAL_TOTAL) / (sw + opt.priorN), n };
}

/**
 * Factor del total de goles que contrae el total esperado `total` hacia `league`: (L + s·(T − L)) / T, recortado a
 * [0,5; 2]. s = 1 ⇒ sin cambio; s = 0 ⇒ todos los partidos con la media de la competición.
 */
export function shrinkFactor(total: number, league: number, s: number): number {
  if (!(total > 0) || !(league > 0) || !Number.isFinite(total) || !Number.isFinite(league)) return 1;
  const f = (league + s * (total - league)) / total;
  return Number.isFinite(f) && f > 0 ? Math.min(2, Math.max(0.5, f)) : 1;
}

/**
 * Factor de producción del total de goles de un partido: 1 con línea de goles del mercado o en copas nacionales; si
 * no, contracción MODEL.totalShrink.s hacia la media de su competición.
 */
export function productionTotalFactor(o: {
  hasMarketTotal: boolean;
  kind: 'league' | 'cup' | 'continental';
  compId: string;
  before: PastCompMatches | undefined;
  lambdaHome: number;
  lambdaAway: number;
}): number {
  if (o.hasMarketTotal || o.kind === 'cup' || !o.before) return 1;
  return shrinkFactor(o.lambdaHome + o.lambdaAway, leagueTotal(o.before, o.compId).mean, MODEL.totalShrink.s);
}
