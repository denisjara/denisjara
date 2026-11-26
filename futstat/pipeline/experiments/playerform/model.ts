/**
 * Factor FORMA DE JUGADORES (props): piezas de las variantes playerform-*.ts. Pre-registro en la cabecera de
 * playerform-hl60.ts.
 *
 *  - `formMultipliers`: multiplicador de «forma» por jugador con sus 5 últimas apariciones (hipótesis b). La tasa
 *    reciente de xG aproximado por 90 (0,09·tiros + 0,22·a puerta) se contrae hacia la de toda la ventana con K
 *    partidos (de 90') ficticios; multiplicador = reciente contraída / larga, recortado. Con todas las líneas dentro de
 *    las 5 últimas el multiplicador es exactamente 1.
 *  - `scaleLines`: aplica los multiplicadores a goles, tiros y tiros a puerta de las líneas (copias nuevas; minutos,
 *    tarjetas y faltas intactos). Como buildPlayerProps suma las líneas, equivale a multiplicar las tasas por 90 del
 *    jugador antes de su contracción hacia el prior de su posición. Los minutos esperados no cambian.
 *  - `factorRatios`: cociente entre la proyección del equipo con otra contracción de las tasas de equipo (priorN para
 *    el «a favor» del propio equipo y para el «en contra» del rival) y la de producción (40/40), por estadística. Se
 *    multiplica por el factor del rival de producción de las props (proyección / media del equipo), así que solo
 *    cambia la contracción: las proyecciones de equipo publicadas (córners, tarjetas, tiros…) NO se tocan.
 *
 * Todo con el pasado del partido: `base.lines` (ya cortadas por propsFor) y la HistoryView. Sin estado global.
 */
import { clamp, shrink } from '../../../src/lib/models';
import { buildStatContext, PRIOR_N, type StatContext, type StatKey } from '../../analytics/projections';
import type { MatchRecord, PlayerLine } from '../../types';
import type { HistoryView, PreMatch } from '../types';

const DAY_MS = 86_400_000;
/** misma ventana que las tasas de equipo de producción (TEAM_WINDOW_DAYS de publish/context.ts) */
const WINDOW_DAYS = 365;

// ---------------------------------------------------------------------------
// (b) forma de las 5 últimas apariciones
// ---------------------------------------------------------------------------

export interface FormOptions {
  /** apariciones recientes */
  last: number;
  /** partidos (de 90') ficticios de la contracción de la tasa reciente hacia la larga */
  k: number;
  /** recorte del multiplicador */
  lo: number;
  hi: number;
}

export const FORM_DEFAULTS: FormOptions = { last: 5, k: 4, lo: 0.67, hi: 1.5 };

const xgOf = (l: PlayerLine) => 0.09 * l.shots + 0.22 * l.shotsOnTarget;

/** Multiplicador de forma por jugador (solo líneas del equipo `teamId` con minutos; 1 si no hay base). */
export function formMultipliers(lines: readonly PlayerLine[], teamId: string, o: FormOptions = FORM_DEFAULTS): Map<string, number> {
  const byPlayer = new Map<string, PlayerLine[]>();
  const seen = new Set<string>();
  for (const l of lines) {
    if (l.teamId !== teamId || !(l.minutes > 0)) continue;
    const key = `${l.playerId}|${l.matchId}`;
    if (seen.has(key)) continue; // línea duplicada (buildPlayerProps se queda con la primera)
    seen.add(key);
    let xs = byPlayer.get(l.playerId);
    if (!xs) byPlayer.set(l.playerId, (xs = []));
    xs.push(l);
  }
  const out = new Map<string, number>();
  for (const [id, xs] of byPlayer) {
    xs.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.matchId.localeCompare(b.matchId));
    let xgAll = 0;
    let minAll = 0;
    for (const l of xs) {
      xgAll += xgOf(l);
      minAll += l.minutes;
    }
    const rLong = minAll > 0 ? (xgAll * 90) / minAll : 0;
    if (!(rLong > 0)) {
      out.set(id, 1);
      continue;
    }
    let xg5 = 0;
    let min5 = 0;
    for (const l of xs.slice(-o.last)) {
      xg5 += xgOf(l);
      min5 += l.minutes;
    }
    // tasa reciente por 90 contraída hacia la larga: (xG5 + K·rLong) / (min5/90 + K)
    const recent = (xg5 + o.k * rLong) / (min5 / 90 + o.k);
    const m = clamp(recent / rLong, o.lo, o.hi);
    out.set(id, Number.isFinite(m) ? m : 1);
  }
  return out;
}

/** Copias de las líneas con goles, tiros y tiros a puerta multiplicados por el multiplicador de su jugador. */
export function scaleLines(lines: readonly PlayerLine[], teamId: string, mult: ReadonlyMap<string, number>): PlayerLine[] {
  return lines.map((l) => {
    const m = l.teamId === teamId ? mult.get(l.playerId) : undefined;
    if (m === undefined || m === 1) return l;
    return { ...l, goals: l.goals * m, shots: l.shots * m, shotsOnTarget: l.shotsOnTarget * m };
  });
}

// ---------------------------------------------------------------------------
// factores del rival con otra contracción de las tasas de equipo
// ---------------------------------------------------------------------------

export const FACTOR_KEYS: StatKey[] = ['shots', 'shotsOnTarget', 'cards'];

/**
 * Partidos del contexto de estadísticas del partido, imitando statContext (publish/context.ts) con lo que da la
 * HistoryView: partidos terminados de la competición en la MISMA temporada que el partido + partidos de los dos
 * equipos (todas las competiciones) de los últimos 365 días, todo anterior al DÍA del partido (producción corta por día).
 * Aproximación: producción añade los partidos de todos los equipos de la competición (solo cambian las normas de otras
 * competiciones); como se usa un cociente entre dos contracciones del MISMO contexto, el efecto es de segundo orden.
 */
export function statPool(match: PreMatch, history: HistoryView): MatchRecord[] {
  const limit = Math.floor(history.cutoff / DAY_MS) * DAY_MS;
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

interface Acc {
  w: number;
  obs: number;
  exp: number;
}

/** Igual que `ratio` de analytics/projections.ts (no exportada). */
function ratio(acc: Acc | undefined, prior: number, priorN: number): number {
  if (!acc || !(acc.w > 0) || !(acc.exp > 0)) return prior;
  return shrink(acc.obs / acc.exp, acc.w, prior, priorN);
}

/**
 * Media esperada de un lado con contracción `forN` en el «a favor» del equipo y `agN` en el «en contra» del rival
 * (expectedPair de producción = forN = agN = sc.priorN).
 */
export function sideMean(sc: StatContext, key: StatKey, homeId: string, awayId: string, side: 'home' | 'away', forN: number, agN: number): number | undefined {
  const L = sc.league[key];
  if (!L) return undefined;
  const ph = sc.teams.get(homeId)?.[key];
  const pa = sc.teams.get(awayId)?.[key];
  if (side === 'home') {
    const forH = ratio(ph?.forHome, ratio(ph?.forAll, 1, forN), forN);
    const agA = ratio(pa?.agAway, ratio(pa?.agAll, 1, agN), agN);
    return L.home * forH * agA;
  }
  const forA = ratio(pa?.forAway, ratio(pa?.forAll, 1, forN), forN);
  const agH = ratio(ph?.agHome, ratio(ph?.agAll, 1, agN), agN);
  return L.away * forA * agH;
}

/**
 * Cocientes (nueva contracción / producción) de la media proyectada del equipo `side` en tiros, tiros a puerta y
 * tarjetas. 1 si falta algo.
 */
export function factorRatios(match: PreMatch, history: HistoryView, side: 'home' | 'away', forN: number, agN: number): Record<'shots' | 'shotsOnTarget' | 'cards', number> {
  const out = { shots: 1, shotsOnTarget: 1, cards: 1 };
  const pool = statPool(match, history);
  if (!pool.length) return out;
  const sc = buildStatContext(pool, match.compId, { keys: FACTOR_KEYS, dispersion: 'poisson' });
  for (const key of ['shots', 'shotsOnTarget', 'cards'] as const) {
    const prod = sideMean(sc, key, match.home.id, match.away.id, side, PRIOR_N, PRIOR_N);
    const alt = sideMean(sc, key, match.home.id, match.away.id, side, forN, agN);
    if (prod && alt && prod > 0 && alt > 0 && Number.isFinite(prod) && Number.isFinite(alt)) out[key] = alt / prod;
  }
  return out;
}
