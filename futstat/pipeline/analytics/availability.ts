/**
 * Bajas probables de jugadores (sanciones y habituales ausentes) en las props: en PRODUCCIÓN desde el 26-nov-2026
 * (antes, variante availability-props del banco, cuyo módulo experiments/availability/model.ts reexporta este).
 *
 * Todo se calcula con la vista del pasado del partido (HistoryView: `teamMatches`, cortada en su inicio) y con las
 * líneas de la entrada de las props (`base.lines`, ya anteriores al partido). Sin estado global, determinista.
 * No hay alineaciones ni partes médicos: las clases se deducen de quién jugó.
 *
 * Bajas probables de un equipo para un partido de la competición C (cada jugador entra en UNA clase, en este orden):
 *   - 'susp'   : expulsado (roja, también por doble amarilla) en el ÚLTIMO partido terminado del equipo en C (por los
 *                eventos del partido con `playerId` o por su línea de jugador) ⇒ sanción probable en este partido.
 *                Supone un partido de sanción en la misma competición (sin recursos, sanciones largas ni ciclos de
 *                amarillas, que dependen de cada liga).
 *   - 'miss2'  : habitual (>= regularShare de los minutos del equipo en sus regularGames últimos partidos con líneas)
 *                que no jugó NINGUNO de los 2 últimos ⇒ lesión probable.
 *   - 'miss1s' : habitual que no jugó el último, y ese último era de la MISMA competición C.
 *   - 'miss1o' : habitual que no jugó el último, de OTRA competición (rotación de copa/liga, sobre todo).
 * Corrección de sus minutos esperados en las props (MODEL.availability.minutesFactor, relativa a la EWMA de
 * producción, que ya cuenta 0 minutos en los partidos que faltó): sancionado 0 (no se publica), faltó los 2 últimos
 * 0,65, faltó el último de la misma competición 0,9, de otra 1.
 */
import { MODEL } from '../config';
import type { MatchRecord, PlayerLine } from '../types';
import type { HistoryView, PreMatch } from '../experiments/types';
import { teamGamesFromLines, type PlayerPropsInput } from './players';

const DAY_MS = 86_400_000;
/** ventana de las líneas (igual que las props de producción: TEAM_WINDOW_DAYS) */
export const LINES_WINDOW_DAYS = MODEL.availability.linesWindowDays;
/** habitual: >= 60 % de los minutos (máx. 90 por partido) de los 5 últimos partidos del equipo con líneas */
export const REGULAR_SHARE = MODEL.availability.regularShare;
export const REGULAR_GAMES = MODEL.availability.regularGames;

export type AbsenceKind = 'susp' | 'miss2' | 'miss1s' | 'miss1o';

/** Factores de los minutos esperados por clase de baja (producción: MODEL.availability.minutesFactor). */
export type MinutesFactors = Readonly<Record<AbsenceKind, number>>;

export const PRODUCTION_MINUTES_FACTOR: MinutesFactors = MODEL.availability.minutesFactor;

export interface Absence {
  playerId: string;
  kind: AbsenceKind;
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
      if (e.type === 'red' && e.teamId === teamId && e.playerId) out.set(e.playerId, { playerId: e.playerId, kind: 'susp' });
    }
    for (const l of ls) {
      if (l.matchId === lastSame.id && l.red > 0) out.set(l.playerId, { playerId: l.playerId, kind: 'susp' });
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
      out.set(pid, { playerId: pid, kind });
    }
  }
  return [...out.values()].sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
}

/**
 * minutesFactor de las props por baja (solo las clases con factor distinto de 1; `suspOnly`: solo sancionados).
 * Sin bajas = {}.
 */
export function minutesFactors(absences: readonly Pick<Absence, 'playerId' | 'kind'>[], factors: MinutesFactors = PRODUCTION_MINUTES_FACTOR, suspOnly = false): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of absences) {
    if (suspOnly && a.kind !== 'susp') continue;
    const f = factors[a.kind];
    if (f !== 1) out[a.playerId] = f;
  }
  return out;
}

/**
 * Cambio de la entrada de las props de un equipo por sus bajas probables: `minutesFactor` (sobre el que ya tuviera la
 * entrada). Sin bajas = {} (la entrada no cambia). Con factor 0 el jugador no se publica (minutos esperados < 1).
 */
export function availabilityAdjust(
  i: { match: Pick<PreMatch, 'compId' | 'date'>; teamId: string; history: HistoryView; base: PlayerPropsInput },
  factors: MinutesFactors = PRODUCTION_MINUTES_FACTOR,
  suspOnly = false,
): Partial<PlayerPropsInput> {
  const mf = minutesFactors(teamAbsences(i.match, i.teamId, i.base.lines, i.history), factors, suspOnly);
  return Object.keys(mf).length ? { minutesFactor: { ...(i.base.minutesFactor ?? {}), ...mf } } : {};
}
