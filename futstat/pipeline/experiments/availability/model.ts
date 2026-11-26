/**
 * Factor DISPONIBILIDAD DE JUGADORES (bajas probables y sanciones), variantes availability-*.ts.
 *
 * Todo se calcula con la vista del pasado del partido (HistoryView: `playerLines` y `teamMatches`, cortadas en su
 * inicio) o con las líneas de la entrada de las props (`base.lines`, ya anteriores al partido). Sin estado global,
 * determinista.
 *
 * Bajas probables de un equipo para un partido de la competición C (cada jugador entra en UNA clase, en este orden):
 *   - 'susp'   : expulsado (roja, también por doble amarilla) en el ÚLTIMO partido terminado del equipo en C (por los
 *                eventos del partido con `playerId` o por su línea de jugador) ⇒ sanción probable en este partido.
 *   - 'miss2'  : habitual (>= 60 % de los minutos del equipo en sus 5 últimos partidos con líneas) que no jugó NINGUNO
 *                de los 2 últimos ⇒ lesión probable.
 *   - 'miss1s' : habitual que no jugó el último, y ese último era de la MISMA competición C.
 *   - 'miss1o' : habitual que no jugó el último, de OTRA competición (rotación de copa/liga, sobre todo).
 * Probabilidad de que no juegue (P_OUT) y corrección de sus minutos esperados en las props (MINUTES_FACTOR, relativa a
 * la EWMA de producción, que ya cuenta 0 minutos en los partidos que faltó): fijadas ANTES de evaluar con una
 * exploración descriptiva SOLO de T1 (06-01..07-31, jugadores publicables por producción; ver la cabecera de
 * availability-susp.ts): roja → juega 0/35; faltó los 2 últimos → 23,5 % (n 34; minutos reales/esperados 0,55 frente a
 * 0,86 de los habituales que sí jugaron el último); faltó el último de la misma competición → 46,4 % (n 207; 0,79);
 * de otra competición → 74 % (n 50; 1,22).
 *
 * Peso de cada baja en el equipo (efecto de equipo, hipótesis a): su participación en los 10 últimos partidos del
 * equipo con líneas (365 días como máximo):
 *   ataque  = (goles + proxy de xG) del jugador / total del equipo, proxy = 0,66·(0,09·tiros + 0,22·tiros a puerta);
 *   tiros   = tiros del jugador / tiros del equipo;  a puerta = ídem.
 * Multiplicador del equipo = max(FLOOR, 1 − K·Σ P_OUT·participación): K = 0,5 porque el sustituto aporta (en media)
 * la mitad de lo que se pierde. Sin líneas suficientes (o sin bajas) = 1 = producción.
 */
import { teamGamesFromLines, XG_PER_SHOT, XG_PER_SOT, XG_PROXY_CALIBRATION } from '../../analytics/players';
import type { MatchRecord, PlayerLine } from '../../types';
import type { HistoryView, PreMatch, StatPairs } from '../types';

const DAY_MS = 86_400_000;
/** ventana de las líneas (igual que las props de producción: TEAM_WINDOW_DAYS) */
export const LINES_WINDOW_DAYS = 365;
/** habitual: >= 60 % de los minutos (máx. 90 por partido) de los 5 últimos partidos del equipo con líneas */
export const REGULAR_SHARE = 0.6;
export const REGULAR_GAMES = 5;
/** partidos del equipo (con líneas) de la participación de cada jugador */
export const SHARE_GAMES = 10;

export type AbsenceKind = 'susp' | 'miss2' | 'miss1s' | 'miss1o';

/** P(no juega) por clase (exploración de T1, redondeada). */
export const P_OUT: Record<AbsenceKind, number> = { susp: 1, miss2: 0.75, miss1s: 0.5, miss1o: 0.25 };

/** Factor de minutos esperados de las props por clase (relativo a producción). 'susp' casi 0: ver SUSP_MINUTES_FACTOR. */
export const MINUTES_FACTOR: Record<AbsenceKind, number> = { susp: 0.03, miss2: 0.65, miss1s: 0.9, miss1o: 1 };

/**
 * Sancionado: 0,03 de sus minutos esperados (≈ 1-3 minutos) y no 0. Con 0 el jugador deja de publicarse y el banco
 * solo puntúa los pares que publican la base y la variante: la mejora no se mediría (saldría como «solo en la base»).
 * En producción se usaría 0 (no publicar). Con menos de 1 minuto esperado tampoco se publica (≈ habitual con < 33').
 */
export const SUSP_MINUTES_FACTOR = MINUTES_FACTOR.susp;

/** K y suelo del multiplicador de equipo */
export const TEAM_K = 0.5;
export const TEAM_FLOOR = 0.85;

export interface Absence {
  playerId: string;
  kind: AbsenceKind;
  pOut: number;
}

export interface TeamShares {
  /** participación en ataque (goles + proxy de xG), tiros y tiros a puerta por jugador */
  attack: Map<string, number>;
  shots: Map<string, number>;
  sot: Map<string, number>;
}

/** Líneas del equipo anteriores al corte y dentro de la ventana, cronológicas. */
export function recentLines(lines: readonly PlayerLine[], teamId: string, cutoff: number): PlayerLine[] {
  const from = cutoff - LINES_WINDOW_DAYS * DAY_MS;
  return lines.filter((l) => {
    const t = Date.parse(l.date);
    return l.teamId === teamId && t < cutoff && t >= from;
  });
}

/** Último partido TERMINADO del equipo en la competición, anterior al corte (la vista ya está cortada). */
function lastCompMatch(history: HistoryView, teamId: string, compId: string): MatchRecord | undefined {
  const ms = history.teamMatches(teamId);
  for (let i = ms.length - 1; i >= 0; i--) if (ms[i].compId === compId) return ms[i];
  return undefined;
}

/**
 * Bajas probables del equipo `teamId` en el partido `match` (de la competición match.compId), con las líneas del
 * equipo `lines` (cualquier lista: se filtran por equipo y corte) y la vista del pasado `history`.
 */
export function teamAbsences(match: Pick<PreMatch, 'compId' | 'date'>, teamId: string, lines: readonly PlayerLine[], history: HistoryView): Absence[] {
  const cutoff = Date.parse(match.date);
  const ls = recentLines(lines, teamId, cutoff);
  const out = new Map<string, Absence>();

  // 1) sanción: roja en el último partido terminado del equipo en esta competición (eventos o líneas)
  const lastSame = lastCompMatch(history, teamId, match.compId);
  if (lastSame) {
    for (const e of lastSame.events ?? []) {
      if (e.type === 'red' && e.teamId === teamId && e.playerId) out.set(e.playerId, { playerId: e.playerId, kind: 'susp', pOut: P_OUT.susp });
    }
    for (const l of ls) {
      if (l.matchId === lastSame.id && l.red > 0) out.set(l.playerId, { playerId: l.playerId, kind: 'susp', pOut: P_OUT.susp });
    }
  }

  // 2) habituales que no jugaron el último (o los dos últimos) partido del equipo con líneas
  const games = (teamGamesFromLines(ls).get(teamId) ?? []).slice(-REGULAR_GAMES);
  if (games.length === REGULAR_GAMES) {
    const ids = new Set(games.map((g) => g.matchId));
    const last = games[REGULAR_GAMES - 1].matchId;
    const prev = games[REGULAR_GAMES - 2].matchId;
    const lastComp = ls.find((l) => l.matchId === last)?.compId;
    const minutes = new Map<string, number>();
    const played = new Map<string, Set<string>>();
    for (const l of ls) {
      if (!ids.has(l.matchId) || !(l.minutes > 0)) continue;
      minutes.set(l.playerId, (minutes.get(l.playerId) ?? 0) + Math.min(l.minutes, 90));
      let s = played.get(l.playerId);
      if (!s) played.set(l.playerId, (s = new Set()));
      s.add(l.matchId);
    }
    for (const [pid, min] of [...minutes].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      if (out.has(pid) || min < REGULAR_SHARE * 90 * REGULAR_GAMES) continue;
      const s = played.get(pid)!;
      if (s.has(last)) continue;
      const kind: AbsenceKind = !s.has(prev) ? 'miss2' : lastComp === match.compId ? 'miss1s' : 'miss1o';
      out.set(pid, { playerId: pid, kind, pOut: P_OUT[kind] });
    }
  }
  return [...out.values()].sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
}

/** Participación de cada jugador en ataque, tiros y tiros a puerta en los SHARE_GAMES últimos partidos con líneas. */
export function teamShares(teamId: string, lines: readonly PlayerLine[], cutoff: number): TeamShares {
  const ls = recentLines(lines, teamId, cutoff);
  const games = new Set((teamGamesFromLines(ls).get(teamId) ?? []).slice(-SHARE_GAMES).map((g) => g.matchId));
  const att = new Map<string, number>();
  const sh = new Map<string, number>();
  const st = new Map<string, number>();
  const seen = new Set<string>();
  for (const l of ls) {
    if (!games.has(l.matchId) || !(l.minutes > 0)) continue;
    const key = `${l.playerId}|${l.matchId}`;
    if (seen.has(key)) continue; // línea duplicada
    seen.add(key);
    const xg = XG_PROXY_CALIBRATION * (XG_PER_SHOT * l.shots + XG_PER_SOT * l.shotsOnTarget);
    att.set(l.playerId, (att.get(l.playerId) ?? 0) + l.goals + xg);
    sh.set(l.playerId, (sh.get(l.playerId) ?? 0) + l.shots);
    st.set(l.playerId, (st.get(l.playerId) ?? 0) + l.shotsOnTarget);
  }
  const norm = (m: Map<string, number>) => {
    const tot = [...m.values()].reduce((a, b) => a + b, 0);
    const out = new Map<string, number>();
    if (tot > 0) for (const [k, x] of m) out.set(k, x / tot);
    return out;
  };
  return { attack: norm(att), shots: norm(sh), sot: norm(st) };
}

export interface TeamMultipliers {
  goals: number;
  shots: number;
  sot: number;
  absences: Absence[];
}

/** Multiplicadores de equipo (λ de goles, tiros, tiros a puerta) por sus bajas probables: max(FLOOR, 1 − K·Σ P_OUT·part.). */
export function teamMultipliers(match: Pick<PreMatch, 'compId' | 'date'>, teamId: string, history: HistoryView): TeamMultipliers {
  const lines = history.playerLines(teamId);
  const absences = teamAbsences(match, teamId, lines, history);
  if (!absences.length) return { goals: 1, shots: 1, sot: 1, absences };
  const sh = teamShares(teamId, lines, Date.parse(match.date));
  const f = (m: Map<string, number>) => {
    let lost = 0;
    for (const a of absences) lost += a.pOut * (m.get(a.playerId) ?? 0);
    return Math.max(TEAM_FLOOR, 1 - TEAM_K * lost);
  };
  return { goals: f(sh.attack), shots: f(sh.shots), sot: f(sh.sot), absences };
}

/** Multiplicadores de tiros y tiros a puerta para stats.adjust (solo de las estadísticas presentes en `base`). */
export function statMultipliers(match: PreMatch, history: HistoryView, base: StatPairs): StatPairs {
  if (!base.shots && !base.shotsOnTarget) return {};
  const h = teamMultipliers(match, match.home.id, history);
  const a = teamMultipliers(match, match.away.id, history);
  const out: StatPairs = {};
  if (base.shots && (h.shots !== 1 || a.shots !== 1)) out.shots = { home: h.shots, away: a.shots };
  if (base.shotsOnTarget && (h.sot !== 1 || a.sot !== 1)) out.shotsOnTarget = { home: h.sot, away: a.sot };
  return out;
}

/** minutesFactor de las props por baja: solo sanción (`suspOnly`) o todas las clases. Sin bajas = {}. */
export function minutesFactors(absences: readonly Absence[], suspOnly: boolean): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of absences) {
    if (suspOnly && a.kind !== 'susp') continue;
    const f = MINUTES_FACTOR[a.kind];
    if (f !== 1) out[a.playerId] = f;
  }
  return out;
}
