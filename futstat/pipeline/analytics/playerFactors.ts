/**
 * Ajustes de producción de la entrada de las props de jugadores (en PRODUCCIÓN desde el 26-nov-2026; antes, variantes
 * availability-props y playerform-fac6x40 del banco, juntas en factors-combo):
 *
 *  1. Bajas probables (analytics/availability.ts): `minutesFactor` de sancionados (0: no se publican) y habituales
 *     ausentes.
 *  2. Factores del rival con otra contracción de las tasas de equipo (MODEL.propsOppShrink): el factor de producción
 *     de tiros, tiros a puerta y tarjetas (proyección del equipo / su media en los partidos de las líneas) se
 *     multiplica por proyección(forN, agN) / proyección(40, 40). Diagnóstico: las tasas por 90 del jugador ya llevan el
 *     nivel de SU equipo; con 40 partidos ficticios también en el «a favor» del propio equipo, ese nivel se contraía
 *     dos veces (los jugadores de equipos que tiran mucho perdían tiros). Con 6 en el «a favor» propio y 40 en el «en
 *     contra» del rival se deshace. Las proyecciones de equipo publicadas (córners, tarjetas, tiros…) NO cambian.
 *     El cociente se calcula sobre un contexto de estadísticas propio (`statPool`, solo con la vista del pasado: así
 *     el gancho del banco y producción dan exactamente lo mismo), sin árbitro; como `base.cardsFactor` ya lleva el
 *     multiplicador del árbitro, árbitro × contracción se componen multiplicativamente.
 *
 * Se aplican en propsFor (publish/matches.ts) cuando la variante no trae players.adjust. Todo con el pasado del
 * partido (`base.lines`, ya cortadas por propsFor, y la HistoryView). Sin estado global: la caché opcional de los
 * contextos (`OppFactorCache`) la crea el build por contexto, y su clave fija TODO lo que entra en el contexto.
 */
import { MODEL } from '../config';
import type { MatchRecord } from '../types';
import type { HistoryView, PreMatch } from '../experiments/types';
import { availabilityAdjust, PRODUCTION_MINUTES_FACTOR } from './availability';
import type { PlayerPropsInput } from './players';
import { buildStatContext, expectedSideMixed, PRIOR_N, type StatContext, type StatKey } from './projections';

const DAY_MS = 86_400_000;
/** misma ventana que las tasas de equipo de producción (TEAM_WINDOW_DAYS de publish/context.ts) */
const WINDOW_DAYS = 365;

export const FACTOR_KEYS: StatKey[] = ['shots', 'shotsOnTarget', 'cards'];

/** Caché de contextos de estadísticas de los factores del rival (null = sin partidos). */
export type OppFactorCache = Map<string, StatContext | null>;

/** Límite (inicio del día UTC del corte) del contexto: producción corta las estadísticas por día. */
function dayLimit(history: HistoryView): number {
  return Math.floor(history.cutoff / DAY_MS) * DAY_MS;
}

/**
 * Partidos del contexto de estadísticas del partido, imitando statContext (publish/context.ts) con lo que da la
 * HistoryView: partidos terminados de la competición en la MISMA temporada que el partido + partidos de los dos
 * equipos (todas las competiciones) de los últimos 365 días, todo anterior al DÍA del partido.
 * Aproximación: statContext añade los partidos de todos los equipos de la competición (solo cambian las normas de
 * otras competiciones); como se usa un cociente entre dos contracciones del MISMO contexto, el efecto es de segundo
 * orden.
 */
export function statPool(match: Pick<PreMatch, 'compId' | 'season' | 'home' | 'away'>, history: HistoryView): MatchRecord[] {
  const limit = dayLimit(history);
  const from = limit - WINDOW_DAYS * DAY_MS;
  const pool = new Map<string, MatchRecord>();
  for (const m of history.compMatches(match.compId)) {
    if (m.season === match.season && Date.parse(m.date) < limit) pool.set(m.id, m);
  }
  for (const team of [match.home.id, match.away.id]) {
    for (const m of history.teamMatches(team)) {
      const t = Date.parse(m.date);
      if (t >= from && t < limit) pool.set(m.id, m);
    }
  }
  return [...pool.values()];
}

/** Contexto de estadísticas de los factores del rival (cacheado por competición, temporada, día y equipos). */
function oppStatContext(match: Pick<PreMatch, 'compId' | 'season' | 'home' | 'away'>, history: HistoryView, cache?: OppFactorCache): StatContext | null {
  const key = `${match.compId}|${match.season}|${dayLimit(history)}|${match.home.id}|${match.away.id}`;
  if (cache?.has(key)) return cache.get(key)!;
  const pool = statPool(match, history);
  const sc = pool.length ? buildStatContext(pool, match.compId, { keys: FACTOR_KEYS, dispersion: 'poisson' }) : null;
  cache?.set(key, sc);
  return sc;
}

/** Media esperada de un lado con contracción `forN` en el «a favor» propio y `agN` en el «en contra» del rival. */
export const sideMean = expectedSideMixed;

/**
 * Cocientes (nueva contracción / producción 40-40) de la media proyectada del equipo `side` en tiros, tiros a puerta y
 * tarjetas. 1 si falta algo.
 */
export function factorRatios(
  match: Pick<PreMatch, 'compId' | 'season' | 'home' | 'away'>,
  history: HistoryView,
  side: 'home' | 'away',
  forN: number,
  agN: number,
  cache?: OppFactorCache,
): Record<'shots' | 'shotsOnTarget' | 'cards', number> {
  const out = { shots: 1, shotsOnTarget: 1, cards: 1 };
  const sc = oppStatContext(match, history, cache);
  if (!sc) return out;
  for (const key of ['shots', 'shotsOnTarget', 'cards'] as const) {
    const prod = expectedSideMixed(sc, key, match.home.id, match.away.id, side, PRIOR_N, PRIOR_N);
    const alt = expectedSideMixed(sc, key, match.home.id, match.away.id, side, forN, agN);
    if (prod && alt && prod > 0 && alt > 0 && Number.isFinite(prod) && Number.isFinite(alt)) out[key] = alt / prod;
  }
  return out;
}

/** Un factor exactamente 1 es el de respaldo de propsFor (sin proyección o con < 3 partidos): se deja. */
export const scaledFactor = (f: number, r: number): number => (f === 1 || !(r > 0) || !Number.isFinite(r) ? f : f * r);

/** Factores del rival de las props (tiros, tiros a puerta, tarjetas) con la contracción `shrink`. */
export function oppFactorAdjust(
  i: { match: Pick<PreMatch, 'compId' | 'season' | 'home' | 'away'>; side: 'home' | 'away'; history: HistoryView; base: PlayerPropsInput },
  shrink: { forN: number; agN: number } = MODEL.propsOppShrink,
  cache?: OppFactorCache,
): Pick<PlayerPropsInput, 'oppShotsFactor' | 'oppSotFactor' | 'cardsFactor'> {
  const r = factorRatios(i.match, i.history, i.side, shrink.forN, shrink.agN, cache);
  return {
    oppShotsFactor: scaledFactor(i.base.oppShotsFactor, r.shots),
    oppSotFactor: scaledFactor(i.base.oppSotFactor, r.shotsOnTarget),
    cardsFactor: scaledFactor(i.base.cardsFactor, r.cards),
  };
}

/** Entrada de los ajustes de producción de las props (la misma forma que PlayerAdjustInput del banco). */
export interface PlayerFactorsInput {
  match: PreMatch;
  teamId: string;
  side: 'home' | 'away';
  history: HistoryView;
  base: PlayerPropsInput;
}

/**
 * Ajustes de PRODUCCIÓN de la entrada de las props de un equipo: bajas probables (`minutesFactor`) + factores del
 * rival con la contracción MODEL.propsOppShrink. Claves disjuntas; los dos se calculan sobre el mismo `base`.
 */
export function productionPlayerAdjust(i: PlayerFactorsInput, cache?: OppFactorCache): Partial<PlayerPropsInput> {
  const out: Partial<PlayerPropsInput> = {};
  Object.assign(out, availabilityAdjust(i, PRODUCTION_MINUTES_FACTOR));
  Object.assign(out, oppFactorAdjust(i, MODEL.propsOppShrink, cache));
  return out;
}
