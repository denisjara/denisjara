/**
 * Jugadores: nota de partido, tabla de temporada con forma y props de jugador para un partido.
 *
 * Nota de partido (0..10, heurística transparente):
 *   Δ = goles·1.2 + asistencias·0.8 + tiros a puerta·0.3 + tiros·0.1 − amarilla·0.3 − roja·1.5 − autogol·1.0
 *   porteros: Δ += paradas·0.25 − goles encajados·0.3 (+0.8 si portería a cero jugando >= 60')
 *   escala por minutos: Δ·clamp(0.5 + 0.5·min/90, 0.5, 1) (una aparición corta pesa como mínimo la mitad)
 *   nota = clamp(6.0 + Δ·escala, 3, 10)
 *
 * Índice de forma (0..100): EWMA (α = 0.3) de las notas en los 5 últimos partidos del EQUIPO, contando 0 si el
 * jugador no jugó, más un bonus por minutos:  8.5·r̄ + 15·(minutos medios/90), recortado a 0..100.
 * (6.0 jugando siempre ≈ 66; 8.0 jugando siempre ≈ 83; no jugar ninguno = 0. Lineal: no satura en 100.)
 *
 * Props (probabilidades para un partido):
 *   minutos esperados = EWMA (α = 0.35) de los minutos en los 5 últimos partidos del equipo (0 si no jugó);
 *   λ_gol = shrink(goles/90, n90, xG/90 proxy, 8) · minEsp/90 · (λ_equipo / media de goles del equipo)
 *     xG/90 proxy = CAL · (0.09·tiros/90 + 0.22·tiros a puerta/90), CAL = 0.66 medido en los datos reales
 *     (8.672 goles frente a 13.192 de proxy sin calibrar en 6,0 M de minutos);
 *   asistencias análogo (prior por posición); tiros y tiros a puerta Poisson con el factor del rival;
 *   tarjeta: λ = tarjetas/90 · minEsp/90 · factor de tarjetas; faltas P(>=2).
 *   Todas las tasas por 90 se contraen hacia la media de su posición (`shrink`) para jugadores con pocos minutos.
 */
import type { PlayerProp, PlayerRef, PlayerSeasonRow, TeamRef } from '../../src/types/data';
import { clamp, ewma, round, shrink } from '../../src/lib/models';
import type { PlayerLine } from '../types';

// ---------------------------------------------------------------------------
// Nota de partido
// ---------------------------------------------------------------------------

export const RATING_BASE = 6.0;

/** Nota 0..10 (en la práctica 3..10) de una actuación. Un jugador sin minutos no tiene nota (devuelve 0). */
export function matchRating(l: PlayerLine): number {
  const minutes = clamp(Number.isFinite(l.minutes) ? l.minutes : 0, 0, 130);
  if (minutes <= 0) return 0;
  let delta =
    l.goals * 1.2 +
    l.assists * 0.8 +
    l.shotsOnTarget * 0.3 +
    l.shots * 0.1 -
    l.yellow * 0.3 -
    l.red * 1.5 -
    (l.ownGoals ?? 0) * 1.0;
  if (l.position === 'G') {
    delta += (l.saves ?? 0) * 0.25;
    if (l.goalsConceded !== undefined) {
      delta -= l.goalsConceded * 0.3;
      if (l.goalsConceded === 0 && minutes >= 60) delta += 0.8;
    }
  }
  const scale = clamp(0.5 + (0.5 * minutes) / 90, 0.5, 1);
  return round(clamp(RATING_BASE + delta * scale, 3, 10), 1);
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

export interface TeamGame {
  matchId: string;
  date: string;
  opponentId: string;
  isHome: boolean;
}

/** Partidos de cada equipo deducidos de las líneas de jugadores (cronológicos). */
export function teamGamesFromLines(lines: PlayerLine[]): Map<string, TeamGame[]> {
  const seen = new Map<string, Map<string, TeamGame>>();
  for (const l of lines) {
    let m = seen.get(l.teamId);
    if (!m) seen.set(l.teamId, (m = new Map()));
    if (!m.has(l.matchId)) m.set(l.matchId, { matchId: l.matchId, date: l.date, opponentId: l.opponentId, isHome: l.isHome });
  }
  const out = new Map<string, TeamGame[]>();
  for (const [teamId, m] of seen) {
    out.set(
      teamId,
      [...m.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.matchId.localeCompare(b.matchId)),
    );
  }
  return out;
}

/** EWMA de las notas en los últimos partidos del equipo (0 si no jugó) + bonus de minutos → 0..100. */
export function playerFormIndex(ratings: number[], minutes: number[]): number {
  if (ratings.length === 0) return 0;
  const r = ewma(ratings, 0.3);
  const m = minutes.reduce((s, x) => s + clamp(x / 90, 0, 1), 0) / minutes.length;
  return round(clamp(8.5 * r + 15 * m, 0, 100), 1);
}

/** Minutos esperados: EWMA (α 0.35) de los minutos en los últimos partidos del equipo (cronológico, 0 si no jugó). */
export function expectedMinutes(minutes: number[]): number {
  if (minutes.length === 0) return 0;
  return clamp(ewma(minutes.map((x) => clamp(x, 0, 120)), 0.35), 0, 95);
}

const per90 = (x: number, minutes: number) => (minutes >= 1 ? (x * 90) / minutes : 0);

function fallbackTeam(id: string): TeamRef {
  return { id, name: id, short: id, abbr: id.slice(0, 3).toUpperCase() };
}

interface Aggregate {
  ref: PlayerRef;
  lines: PlayerLine[]; // cronológicas
  byMatch: Map<string, PlayerLine>;
  minutes: number;
  starts: number;
  goals: number;
  assists: number;
  shots: number;
  shotsOnTarget: number;
  yellow: number;
  red: number;
  foulsCommitted: number;
  foulsSuffered: number;
  offsides: number;
  saves?: number;
}

/** Agrega las líneas por jugador. Equipo/posición/nombre = los de su línea más reciente. */
function aggregate(lines: PlayerLine[]): Map<string, Aggregate> {
  const sorted = [...lines].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const out = new Map<string, Aggregate>();
  for (const l of sorted) {
    if (!(l.minutes > 0)) continue;
    let a = out.get(l.playerId);
    if (!a) {
      a = {
        ref: { id: l.playerId, name: l.name, short: l.short, position: l.position, teamId: l.teamId },
        lines: [],
        byMatch: new Map(),
        minutes: 0,
        starts: 0,
        goals: 0,
        assists: 0,
        shots: 0,
        shotsOnTarget: 0,
        yellow: 0,
        red: 0,
        foulsCommitted: 0,
        foulsSuffered: 0,
        offsides: 0,
      };
      out.set(l.playerId, a);
    }
    if (a.byMatch.has(l.matchId)) continue; // línea duplicada
    a.ref = {
      id: l.playerId,
      name: l.name || a.ref.name,
      short: l.short || a.ref.short,
      position: l.position !== '?' ? l.position : a.ref.position,
      teamId: l.teamId,
    };
    a.lines.push(l);
    a.byMatch.set(l.matchId, l);
    a.minutes += l.minutes;
    if (l.starter) a.starts++;
    a.goals += l.goals;
    a.assists += l.assists;
    a.shots += l.shots;
    a.shotsOnTarget += l.shotsOnTarget;
    a.yellow += l.yellow;
    a.red += l.red;
    a.foulsCommitted += l.foulsCommitted;
    a.foulsSuffered += l.foulsSuffered;
    a.offsides += l.offsides;
    if (l.saves !== undefined) a.saves = (a.saves ?? 0) + l.saves;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tabla de temporada
// ---------------------------------------------------------------------------

/**
 * Filas de temporada de los jugadores de una competición (líneas de esa competición y temporada).
 * `last5`/`formTrend` usan los 5 últimos partidos del equipo actual del jugador (minutos 0 y nota 0 si no jugó).
 * Ordenadas por índice de forma descendente (desempate: minutos).
 */
export function buildPlayerSeasonRows(lines: PlayerLine[], teams: Map<string, TeamRef>, compId: string): PlayerSeasonRow[] {
  const games = teamGamesFromLines(lines);
  const agg = aggregate(lines);
  const rows: PlayerSeasonRow[] = [];
  for (const a of agg.values()) {
    const teamId = a.ref.teamId;
    const last5Games = (games.get(teamId) ?? []).slice(-5);
    const ratings: number[] = [];
    const mins: number[] = [];
    for (const g of last5Games) {
      const l = a.byMatch.get(g.matchId);
      ratings.push(l ? matchRating(l) : 0);
      mins.push(l ? l.minutes : 0);
    }
    const cards = a.yellow + a.red;
    const row: PlayerSeasonRow = {
      player: a.ref,
      team: teams.get(teamId) ?? fallbackTeam(teamId),
      compId,
      apps: a.lines.length,
      starts: a.starts,
      minutes: a.minutes,
      goals: a.goals,
      assists: a.assists,
      shots: a.shots,
      shotsOnTarget: a.shotsOnTarget,
      yellow: a.yellow,
      red: a.red,
      foulsCommitted: a.foulsCommitted,
      foulsSuffered: a.foulsSuffered,
      offsides: a.offsides,
      per90: {
        goals: round(per90(a.goals, a.minutes), 3),
        assists: round(per90(a.assists, a.minutes), 3),
        shots: round(per90(a.shots, a.minutes), 3),
        shotsOnTarget: round(per90(a.shotsOnTarget, a.minutes), 3),
        cards: round(per90(cards, a.minutes), 3),
        foulsCommitted: round(per90(a.foulsCommitted, a.minutes), 3),
      },
      formIndex: playerFormIndex(ratings, mins),
      formTrend: ratings,
      last5: last5Games
        .slice()
        .reverse()
        .map((g) => {
          const l = a.byMatch.get(g.matchId);
          const opp = teams.get(g.opponentId);
          return {
            matchId: g.matchId,
            date: g.date,
            opponent: opp?.short || opp?.name || g.opponentId,
            minutes: l?.minutes ?? 0,
            goals: l?.goals ?? 0,
            assists: l?.assists ?? 0,
            shots: l?.shots ?? 0,
            shotsOnTarget: l?.shotsOnTarget ?? 0,
            cards: l ? l.yellow + l.red : 0,
            rating: l ? matchRating(l) : 0,
          };
        }),
    };
    if (a.saves !== undefined) row.saves = a.saves;
    rows.push(row);
  }
  return rows.sort((x, y) => y.formIndex - x.formIndex || y.minutes - x.minutes);
}

// ---------------------------------------------------------------------------
// Props de jugador
// ---------------------------------------------------------------------------

type Pos = PlayerRef['position'];

/** Medias por 90 por posición medidas en el data-store (≈ 6 M de minutos, 28 competiciones). */
export const POSITION_PRIORS: Record<Pos, { goals: number; assists: number; shots: number; sot: number; cards: number; fouls: number }> = {
  G: { goals: 0.001, assists: 0.005, shots: 0.01, sot: 0.003, cards: 0.045, fouls: 0.03 },
  D: { goals: 0.045, assists: 0.05, shots: 0.59, sot: 0.16, cards: 0.2, fouls: 0.96 },
  M: { goals: 0.136, assists: 0.128, shots: 1.47, sot: 0.48, cards: 0.21, fouls: 1.22 },
  F: { goals: 0.37, assists: 0.144, shots: 2.49, sot: 0.98, cards: 0.16, fouls: 1.24 },
  '?': { goals: 0.15, assists: 0.12, shots: 1.6, sot: 0.55, cards: 0.2, fouls: 1.2 },
};

/** Coeficientes del proxy de xG por 90 y su calibración contra los goles reales. */
export const XG_PER_SHOT = 0.09;
export const XG_PER_SOT = 0.22;
export const XG_PROXY_CALIBRATION = 0.66;
/** Partidos (de 90') equivalentes del prior en la contracción de cada tasa. */
export const PRIOR_N_GOALS = 8;
export const PRIOR_N_RATES = 3;
export const PRIOR_N_CARDS = 5;
/** Máximo de props por equipo. */
export const MAX_PROPS_PER_TEAM = 14;

export interface PlayerPropsInput {
  teamId: string;
  opponentId: string;
  /** líneas del equipo en todas sus competiciones (se filtran por teamId) */
  lines: PlayerLine[];
  /** goles esperados del equipo en el partido (λ del modelo) */
  teamLambda: number;
  /** media de goles por partido del equipo en el periodo de las líneas */
  teamAvgGoals: number;
  /** multiplicador de tiros concedidos por el rival (1 = media) */
  oppShotsFactor: number;
  oppSotFactor: number;
  /** multiplicador de tarjetas esperado para el partido (árbitro/rivalidad/λ de tarjetas del equipo) */
  cardsFactor: number;
  foulsFactor: number;
}

const pAtLeast1 = (l: number) => 1 - Math.exp(-l);
const pAtLeast2 = (l: number) => 1 - Math.exp(-l) * (1 + l);
const safeFactor = (x: number, lo = 0.3, hi = 3) => (Number.isFinite(x) && x > 0 ? clamp(x, lo, hi) : 1);

/**
 * Props de los jugadores de un equipo para un partido (máx. 14, ordenadas por P(gol)).
 * Excluye a quien no jugó ninguno de los 3 últimos partidos del equipo.
 */
export function buildPlayerProps(input: PlayerPropsInput): PlayerProp[] {
  const lines = input.lines.filter((l) => l.teamId === input.teamId);
  if (lines.length === 0) return [];
  const games = teamGamesFromLines(lines).get(input.teamId) ?? [];
  const last5 = games.slice(-5);
  const last3 = new Set(games.slice(-3).map((g) => g.matchId));
  const teamFactor =
    input.teamAvgGoals > 0 && Number.isFinite(input.teamLambda) && input.teamLambda > 0
      ? clamp(input.teamLambda / input.teamAvgGoals, 0.3, 3)
      : 1;
  const shotsF = safeFactor(input.oppShotsFactor);
  const sotF = safeFactor(input.oppSotFactor);
  const cardsF = safeFactor(input.cardsFactor);
  const foulsF = safeFactor(input.foulsFactor);

  const props: PlayerProp[] = [];
  for (const a of aggregate(lines).values()) {
    if (![...last3].some((id) => a.byMatch.has(id))) continue;
    const mins = last5.map((g) => a.byMatch.get(g.matchId)?.minutes ?? 0);
    const ratings = last5.map((g) => {
      const l = a.byMatch.get(g.matchId);
      return l ? matchRating(l) : 0;
    });
    const expMin = expectedMinutes(mins);
    if (expMin < 1) continue;
    const prior = POSITION_PRIORS[a.ref.position] ?? POSITION_PRIORS['?'];
    const n90 = a.minutes / 90;
    const s90 = shrink(per90(a.shots, a.minutes), n90, prior.shots, PRIOR_N_RATES);
    const t90 = shrink(per90(a.shotsOnTarget, a.minutes), n90, prior.sot, PRIOR_N_RATES);
    const xg90 = XG_PROXY_CALIBRATION * (XG_PER_SHOT * s90 + XG_PER_SOT * t90);
    const g90 = shrink(per90(a.goals, a.minutes), n90, xg90, PRIOR_N_GOALS);
    const a90 = shrink(per90(a.assists, a.minutes), n90, prior.assists, PRIOR_N_GOALS);
    const c90 = shrink(per90(a.yellow + a.red, a.minutes), n90, prior.cards, PRIOR_N_CARDS);
    const f90 = shrink(per90(a.foulsCommitted, a.minutes), n90, prior.fouls, PRIOR_N_RATES);
    const share = expMin / 90;
    const lGoal = g90 * share * teamFactor;
    const lAssist = a90 * share * teamFactor;
    const lShots = s90 * share * shotsF;
    const lSot = t90 * share * sotF;
    const lCard = c90 * share * cardsF;
    const lFouls = f90 * share * foulsF;
    props.push({
      player: a.ref,
      apps: a.lines.length,
      minutes: a.minutes,
      goals: a.goals,
      assists: a.assists,
      expMinutes: Math.round(expMin),
      formIndex: playerFormIndex(ratings, mins),
      pGoal: round(pAtLeast1(lGoal), 4),
      pAssist: round(pAtLeast1(lAssist), 4),
      pGoalOrAssist: round(pAtLeast1(lGoal + lAssist), 4),
      pShots1: round(pAtLeast1(lShots), 4),
      pShots2: round(pAtLeast2(lShots), 4),
      pSot1: round(pAtLeast1(lSot), 4),
      pSot2: round(pAtLeast2(lSot), 4),
      pCard: round(pAtLeast1(lCard), 4),
      pFouls2: round(pAtLeast2(lFouls), 4),
    });
  }
  return props.sort((x, y) => y.pGoal - x.pGoal || y.expMinutes - x.expMinutes).slice(0, MAX_PROPS_PER_TEAM);
}
