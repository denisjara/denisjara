/**
 * Forma de equipos para la página de partido/equipo: últimos 10 partidos con estadísticas, PPG, índice de forma,
 * rachas en español, split casa/fuera, comparación estadística local vs visitante y cara a cara (H2H).
 *
 * Índice de forma (0..100): ver computeFormIndex en teamStats.ts
 *   50 % EWMA de puntos ajustados por el Elo pre-partido del rival, 25 % diferencia de goles, 25 % diferencia xG.
 */
import type {
  ComparisonRow,
  FormMatch,
  H2HSummary,
  LeagueAverages,
  SplitStat,
  TeamFormBlock,
  TeamRef,
  TeamSeasonStats,
} from '../../src/types/data';
import { mean, round } from '../../src/lib/models';
import { MODEL } from '../config';
import type { MatchRecord } from '../types';
import { toMatchSummary } from './summary';
import { cardsOf, computeFormIndex, finishedSorted, teamView, type TeamView, type XgMap } from './teamStats';

export interface FormBlockOptions {
  /** Elo pre-partido por id de partido (para ajustar los puntos por la fuerza del rival) */
  preElo?: Map<string, { home: number; away: number }>;
  /** Elo de referencia del ajuste por rival (por defecto: media de los rivales de la ventana) */
  eloRef?: number;
  /** solo partidos anteriores a esta fecha ISO (forma "pre-partido" para partidos ya jugados) */
  before?: string;
  /** TeamRef de respaldo si el equipo no tiene partidos */
  team?: TeamRef;
  /** Elo actual (por defecto el último valor de eloHistory) */
  currentElo?: number;
}

export function toFormMatch(v: TeamView): FormMatch {
  const fm: FormMatch = {
    matchId: v.match.id,
    date: v.match.date,
    compId: v.match.compId,
    opponent: v.opponent,
    isHome: v.isHome,
    gf: v.gf,
    ga: v.ga,
    result: v.result,
  };
  if (v.own?.shots !== undefined) fm.shots = v.own.shots;
  if (v.own?.shotsOnTarget !== undefined) fm.shotsOnTarget = v.own.shotsOnTarget;
  if (v.own?.corners !== undefined) fm.corners = v.own.corners;
  if (v.opp?.corners !== undefined) fm.cornersAgainst = v.opp.corners;
  const cards = cardsOf(v.own);
  if (cards !== undefined) fm.cards = cards;
  if (v.own?.fouls !== undefined) fm.fouls = v.own.fouls;
  if (v.own?.possession !== undefined) fm.possession = v.own.possession;
  if (v.xg !== undefined) fm.xg = round(v.xg, 2);
  if (v.xga !== undefined) fm.xga = round(v.xga, 2);
  return fm;
}

/** Longitud de la racha final (desde el partido más reciente hacia atrás) que cumple `pred`. */
function runLength(views: TeamView[], pred: (v: TeamView) => boolean): number {
  let n = 0;
  for (let i = views.length - 1; i >= 0 && pred(views[i]); i--) n++;
  return n;
}

/**
 * Rachas legibles (español) a partir de los partidos cronológicos (el más reciente al final). Máximo 6.
 * Umbrales: victorias/derrotas >= 3, invicto/sin ganar >= 4 (y mayor que la racha de victorias/derrotas),
 * marcando >= 4, sin marcar >= 2, porterías a cero >= 2, sin portería a cero >= 4,
 * Over/Under 2.5 y ambos marcan en >= 5 de los últimos 6.
 */
export function computeStreaks(views: TeamView[]): string[] {
  const out: string[] = [];
  if (views.length === 0) return out;
  const wins = runLength(views, (v) => v.result === 'W');
  const unbeaten = runLength(views, (v) => v.result !== 'L');
  const losses = runLength(views, (v) => v.result === 'L');
  const winless = runLength(views, (v) => v.result !== 'W');
  if (wins >= 3) out.push(`${wins} victorias seguidas`);
  if (unbeaten >= 4 && unbeaten > wins) out.push(`Invicto en ${unbeaten}`);
  if (losses >= 3) out.push(`${losses} derrotas seguidas`);
  if (winless >= 4 && winless > losses) out.push(`Sin ganar en ${winless}`);
  const scoring = runLength(views, (v) => v.gf > 0);
  const blanks = runLength(views, (v) => v.gf === 0);
  if (scoring >= 4) out.push(`Marca en los últimos ${scoring}`);
  if (blanks >= 2) out.push(`${blanks} partidos sin marcar`);
  const cleanSheets = runLength(views, (v) => v.ga === 0);
  const conceding = runLength(views, (v) => v.ga > 0);
  if (cleanSheets >= 2) out.push(`${cleanSheets} porterías a cero seguidas`);
  if (conceding >= 4) out.push(`${conceding} partidos sin portería a cero`);
  const last6 = views.slice(-6);
  const n = last6.length;
  if (n >= 5) {
    const over = last6.filter((v) => v.gf + v.ga > 2.5).length;
    if (over >= n - 1) out.push(`Over 2.5 en ${over} de ${n}`);
    else if (over <= 1) out.push(`Under 2.5 en ${n - over} de ${n}`);
    const btts = last6.filter((v) => v.gf > 0 && v.ga > 0).length;
    if (btts >= n - 1) out.push(`Ambos marcan en ${btts} de ${n}`);
    else if (btts <= 1) out.push(`No marcan ambos en ${n - btts} de ${n}`);
  }
  return out.slice(0, 6);
}

function fallbackTeam(teamId: string): TeamRef {
  return { id: teamId, name: teamId, short: teamId, abbr: teamId.slice(0, 3).toUpperCase() };
}

/**
 * Bloque de forma de un equipo.
 * @param teamMatches partidos del equipo (todas las competiciones; se filtran los terminados y se ordenan)
 * @param eloHistory evolución Elo cronológica del equipo
 * @param venue 'home' si el equipo juega en casa el partido analizado (split de partidos en casa), 'away' si fuera
 * @param xg mapa matchId → λ del modelo (xG proxy) de cada lado
 */
export function buildFormBlock(
  teamId: string,
  teamMatches: MatchRecord[],
  eloHistory: { date: string; elo: number }[],
  venue: 'home' | 'away',
  xg?: XgMap,
  opts: FormBlockOptions = {},
): TeamFormBlock {
  const before = opts.before ? Date.parse(opts.before) : undefined;
  const views: TeamView[] = [];
  for (const m of finishedSorted(teamMatches)) {
    if (before !== undefined && !(Date.parse(m.date) < before)) continue;
    const v = teamView(m, teamId, xg);
    if (v) views.push(v);
  }
  const last10 = views.slice(-10);
  const last5 = views.slice(-5);
  const entries = last10.map((v) => {
    const pre = opts.preElo?.get(v.match.id);
    return {
      pts: v.pts,
      gd: v.gf - v.ga,
      xgd: v.xg !== undefined && v.xga !== undefined ? v.xg - v.xga : undefined,
      oppElo: pre ? (v.isHome ? pre.away : pre.home) : undefined,
    };
  });
  const hist = eloHistory.filter((h) => before === undefined || Date.parse(h.date) < before);
  const elo = opts.currentElo ?? (hist.length ? hist[hist.length - 1].elo : MODEL.eloInit);
  const venueViews = views.filter((v) => !v.match.neutral && v.isHome === (venue === 'home')).slice(-10);
  return {
    team: views.length ? views[views.length - 1].team : opts.team ?? fallbackTeam(teamId),
    last: last10.slice().reverse().map(toFormMatch),
    formString: last5.map((v) => v.result).join(''),
    ppg5: round(mean(last5.map((v) => v.pts)), 2),
    ppg10: round(mean(last10.map((v) => v.pts)), 2),
    gf5: round(mean(last5.map((v) => v.gf)), 2),
    ga5: round(mean(last5.map((v) => v.ga)), 2),
    formIndex: computeFormIndex(entries, { eloRef: opts.eloRef }),
    streaks: computeStreaks(views),
    elo: round(elo, 1),
    eloTrend: hist.slice(-15).map((h) => round(h.elo, 1)),
    venueSplit: {
      played: venueViews.length,
      ppg: round(mean(venueViews.map((v) => v.pts)), 2),
      gf: round(mean(venueViews.map((v) => v.gf)), 2),
      ga: round(mean(venueViews.map((v) => v.ga)), 2),
    },
  };
}

// ---------------------------------------------------------------------------
// Comparación local vs visitante
// ---------------------------------------------------------------------------

/** Mínimo de partidos en casa/fuera para usar el split en lugar del total. */
export const MIN_SPLIT_MATCHES = 3;

function sideValue(stat: SplitStat, played: SplitStat, side: 'home' | 'away'): number {
  return played[side] >= MIN_SPLIT_MATCHES ? stat[side] : stat.all;
}

/**
 * Filas de comparación: el local usa su split en casa y el visitante su split fuera (si tienen >= 3 partidos
 * en ese split; si no, el total). Los porcentajes (over 2.5, ambos marcan, porterías a cero) son del total.
 * Se omiten las filas sin datos en ambos equipos (p. ej. xG o córners no disponibles).
 */
export function buildComparison(home: TeamSeasonStats, away: TeamSeasonStats, avgs: LeagueAverages): ComparisonRow[] {
  const rows: ComparisonRow[] = [];
  const perTeam = (x: number) => (x > 0 ? round(x / 2, 2) : undefined);
  const split = (
    key: keyof TeamSeasonStats,
    label: string,
    better: 'high' | 'low',
    format: ComparisonRow['format'],
    leagueAvg?: number,
    optional = true,
  ) => {
    const hs = home[key] as SplitStat;
    const as = away[key] as SplitStat;
    const h = sideValue(hs, home.played, 'home');
    const a = sideValue(as, away.played, 'away');
    if (optional && h === 0 && a === 0) return;
    const row: ComparisonRow = { key: String(key), label, home: round(h, 2), away: round(a, 2), better, format };
    if (leagueAvg !== undefined) row.leagueAvg = leagueAvg;
    rows.push(row);
  };
  split('goalsFor', 'Goles a favor / partido', 'high', 'dec2', perTeam(avgs.goalsPerMatch), false);
  split('goalsAgainst', 'Goles en contra / partido', 'low', 'dec2', perTeam(avgs.goalsPerMatch), false);
  split('xgFor', 'xG a favor / partido', 'high', 'dec2', perTeam(avgs.goalsPerMatch));
  split('xgAgainst', 'xG en contra / partido', 'low', 'dec2', perTeam(avgs.goalsPerMatch));
  split('shots', 'Tiros / partido', 'high', 'dec1', perTeam(avgs.shotsPerMatch));
  split('shotsOnTarget', 'Tiros a puerta / partido', 'high', 'dec1', perTeam(avgs.shotsOnTargetPerMatch));
  split('corners', 'Córners a favor / partido', 'high', 'dec1', perTeam(avgs.cornersPerMatch));
  split('cornersAgainst', 'Córners en contra / partido', 'low', 'dec1', perTeam(avgs.cornersPerMatch));
  split('cards', 'Tarjetas / partido', 'low', 'dec1', perTeam(avgs.cardsPerMatch));
  split('fouls', 'Faltas / partido', 'low', 'dec1', perTeam(avgs.foulsPerMatch));
  split('possession', 'Posesión (%)', 'high', 'dec1', 50);
  const pct = (key: 'over25Pct' | 'bttsPct' | 'cleanSheetPct', label: string, better: 'high' | 'low', avg?: number) => {
    const row: ComparisonRow = { key, label, home: home[key], away: away[key], better, format: 'pct' };
    if (avg !== undefined && avg > 0) row.leagueAvg = avg;
    rows.push(row);
  };
  pct('over25Pct', 'Partidos con más de 2,5 goles', 'high', avgs.over25Pct);
  pct('bttsPct', 'Partidos con ambos marcan', 'high', avgs.bttsPct);
  pct('cleanSheetPct', 'Porterías a cero', 'high');
  return rows;
}

// ---------------------------------------------------------------------------
// Cara a cara
// ---------------------------------------------------------------------------

/**
 * Historial directo entre dos equipos (en cualquier competición del dataset), el más reciente primero.
 * homeWins/awayWins se refieren a los equipos `homeId`/`awayId` del partido analizado (no al campo de cada H2H).
 */
export function buildH2H(
  allMatches: MatchRecord[],
  homeId: string,
  awayId: string,
  compNames: Map<string, string> | Record<string, string>,
  opts: { limit?: number; before?: string; excludeId?: string } = {},
): H2HSummary {
  const nameOf = (id: string) => (compNames instanceof Map ? compNames.get(id) : compNames[id]) ?? id;
  const before = opts.before ? Date.parse(opts.before) : undefined;
  const pairs = finishedSorted(allMatches)
    .filter(
      (m) =>
        ((m.home.id === homeId && m.away.id === awayId) || (m.home.id === awayId && m.away.id === homeId)) &&
        m.id !== opts.excludeId &&
        (before === undefined || Date.parse(m.date) < before),
    )
    .reverse()
    .slice(0, opts.limit ?? 10);
  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let goals = 0;
  let btts = 0;
  let over = 0;
  for (const m of pairs) {
    const v = teamView(m, homeId)!;
    if (v.result === 'W') homeWins++;
    else if (v.result === 'D') draws++;
    else awayWins++;
    goals += v.gf + v.ga;
    if (v.gf > 0 && v.ga > 0) btts++;
    if (v.gf + v.ga > 2.5) over++;
  }
  const n = pairs.length;
  return {
    matches: pairs.map((m) => toMatchSummary(m, nameOf(m.compId))),
    homeWins,
    draws,
    awayWins,
    avgGoals: n ? round(goals / n, 2) : 0,
    bttsPct: n ? round(btts / n, 4) : 0,
    over25Pct: n ? round(over / n, 4) : 0,
  };
}
