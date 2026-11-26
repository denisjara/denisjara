/**
 * Factor NECESIDAD DE MARCAR (b): qué se juega cada equipo en la recta final de liga.
 *
 * Tabla a la fecha: `computeStandingsFromMatches` sobre los partidos de fase regular de la temporada del partido
 * (`history.compMatches`, solo terminados con inicio anterior). Jornadas restantes de cada equipo = 2(n − 1) − jugados
 * (doble vuelta), con n = equipos que han jugado en la temporada. Solo en ligas de doble vuelta SIN fases partidas
 * (STAKES_LEAGUES: europeas, Saudí, Brasileirão y Chile; fuera Argentina, Liga MX y MLS) y solo cuando se ha jugado
 * >= LATE_FRACTION de la fase regular (n·2(n−1)/2 partidos). Zonas: `ctx.comp.simulationZones` (negativas desde abajo).
 * No se modelan sanciones de puntos ni zonas que no estén en la configuración (p. ej. Conference).
 *
 * Rango de posición final de un equipo T (pts p, restantes r), con ritmos (lo, hi) de puntos por partido:
 *   mejor = 1 + #{j ≠ T : p_j + lo·r_j  >  p_T + hi·r_T}   (los que acaban por encima pase lo que pase)
 *   peor  = 1 + #{j ≠ T : p_j + hi·r_j  >= p_T + lo·r_T}   (los que pueden acabar por encima)
 *   - 'strict' (matemático): lo = 0, hi = 3;
 *   - 'soft' (realista): lo = 0,75, hi = 2,25.
 * NADA EN JUEGO ⇔ para cada zona [f, t] el rango [mejor, peor] está entero dentro o entero fuera (la zona no puede
 * cambiar). Con algún rango que corta una zona el equipo se juega algo.
 *
 * Determinista y sin estado: todo se recalcula en cada llamada con la vista del pasado.
 */
import { computeStandingsFromMatches } from '../../analytics/teamStats';
import type { CompetitionConfig } from '../../config';
import type { MatchRecord } from '../../types';
import type { HistoryView, PreMatch } from '../types';

/** Ligas de doble vuelta sin fases partidas en las que la tabla y las jornadas restantes están bien definidas. */
export const STAKES_LEAGUES = new Set([
  'laliga',
  'premier',
  'seriea',
  'bundesliga',
  'ligue1',
  'eredivisie',
  'primeira',
  'superlig',
  'laliga2',
  'championship',
  'saudi',
  'brasileirao',
  'chile',
]);

/** Fracción mínima de la fase regular ya jugada (la del segmento «liga: último 25 %» del banco). */
export const LATE_FRACTION = 0.75;

export type StakesMode = 'strict' | 'soft';
export const PACE: Record<StakesMode, { lo: number; hi: number }> = {
  strict: { lo: 0, hi: 3 },
  soft: { lo: 0.75, hi: 2.25 },
};

/** ¿Ronda de fase regular? (mismo criterio que el banco: sin « · » ni playoff/final) */
export function isRegularRound(round: string | undefined): boolean {
  const r = round ?? '';
  if (r.includes(' · ')) return false;
  return !/playoff|play-in|final/i.test(r);
}

export interface TeamStake {
  points: number;
  played: number;
  remaining: number;
  best: number;
  worst: number;
  /** true = nada en juego (ninguna zona puede cambiar) */
  nothing: boolean;
}

export interface MatchStakes {
  n: number;
  fraction: number;
  home: TeamStake;
  away: TeamStake;
}

/** Zonas en posiciones absolutas (1..n). */
export function absoluteZones(comp: Pick<CompetitionConfig, 'simulationZones'>, n: number): { from: number; to: number }[] {
  return (comp.simulationZones ?? []).map((z) => {
    const f = z.from < 0 ? n + z.from + 1 : z.from;
    const t = z.to < 0 ? n + z.to + 1 : z.to;
    return { from: Math.min(f, t), to: Math.max(f, t) };
  });
}

/**
 * Lo que se juega cada equipo del partido (undefined si la liga/ronda no aplica, si no es la recta final o si la tabla
 * no es coherente con una doble vuelta).
 */
export function matchStakes(comp: CompetitionConfig, match: Pick<PreMatch, 'compId' | 'season' | 'round' | 'home' | 'away'>, history: HistoryView, mode: StakesMode): MatchStakes | undefined {
  if (comp.kind !== 'league' || !STAKES_LEAGUES.has(comp.id) || comp.id !== match.compId) return undefined;
  if (!comp.simulationZones?.length || !isRegularRound(match.round)) return undefined;
  const ms: MatchRecord[] = history.compMatches(match.compId).filter((m) => m.season === match.season && isRegularRound(m.round) && !!m.score);
  if (!ms.length) return undefined;
  const table = computeStandingsFromMatches(ms);
  const n = table.rows.length;
  if (n < 10) return undefined;
  const games = 2 * (n - 1);
  let totalPlayed = 0;
  for (const r of table.rows) {
    if (r.played > games) return undefined; // formato distinto de doble vuelta
    totalPlayed += r.played;
  }
  const fraction = totalPlayed / (n * games);
  if (fraction < LATE_FRACTION) return undefined;
  const byId = new Map(table.rows.map((r) => [r.team.id, r]));
  if (!byId.has(match.home.id) || !byId.has(match.away.id)) return undefined;
  const { lo, hi } = PACE[mode];
  const zones = absoluteZones(comp, n);
  const stakeOf = (id: string): TeamStake => {
    const me = byId.get(id)!;
    const rT = games - me.played;
    const maxT = me.points + hi * rT;
    const minT = me.points + lo * rT;
    let above = 0;
    let canAbove = 0;
    for (const o of table.rows) {
      if (o.team.id === id) continue;
      const rJ = games - o.played;
      if (o.points + lo * rJ > maxT) above++;
      if (o.points + hi * rJ >= minT) canAbove++;
    }
    const best = 1 + above;
    const worst = 1 + canAbove;
    const nothing = zones.every((z) => (best >= z.from && worst <= z.to) || worst < z.from || best > z.to);
    return { points: me.points, played: me.played, remaining: rT, best, worst, nothing };
  };
  return { n, fraction, home: stakeOf(match.home.id), away: stakeOf(match.away.id) };
}

/**
 * Efectos FIJOS (pre-registrados el 2026-11-26, antes de evaluar). Razonamiento previo (literatura de partidos
 * «sensibles» de final de temporada, p. ej. Elaad, Krumer y Kantor 2018: el equipo que necesita puntos gana más de lo
 * esperado frente al que no se juega nada; y partidos sin nada en juego menos intensos, más abiertos):
 *   - uno sin nada en juego (U) contra uno que se juega algo (M): 1X2 desplazado hacia M con
 *     p(M gana)·e^{+δ}, p(U gana)·e^{−δ}, renormalizado, δ = 0,12 — SOLO sin cuotas 1X2 (con cuotas el mercado ya lo
 *     descuenta: el 80 % del ensamble es el mercado y ajustes de contexto tras él empeoraron, ver context-final);
 *   - los dos sin nada en juego: total de goles ×1,06 (SOLO sin línea de goles del mercado);
 *   - tarjetas ×0,92 y faltas ×0,95 del equipo sin nada en juego (menos intensidad; sin mercado de estadísticas).
 */
export const TABLE_EFFECTS = {
  delta: 0.12,
  bothNothingGoals: 1.06,
  nothingCards: 0.92,
  nothingFouls: 0.95,
};
