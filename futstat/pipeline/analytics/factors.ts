/**
 * «Factores del partido» (MatchFile.factors): contexto previo al partido que se publica en cada ficha.
 *
 * TODO sale de información ANTERIOR al inicio del partido (también en los terminados: es lo que se sabía antes del
 * pitido inicial): la vista del pasado `history` (HistoryView, partidos terminados con inicio estrictamente anterior),
 * las líneas de jugador (se filtran aquí por el corte) y las props del partido (que propsFor ya calcula con líneas
 * anteriores). Determinista y sin estado global; reutiliza los módulos del núcleo y de los experimentos:
 *
 *  - árbitro:   analytics/referee.ts (refereeRatio, MODEL.referee): USADO por el modelo (tarjetas y faltas) si se conoce.
 *  - bajas:     analytics/availability.ts (teamAbsences, MODEL.availability.minutesFactor): USADAS en las props.
 *  - casa/fuera: descriptivo; las proyecciones de córners/tarjetas/tiros ya separan casa y fuera por equipo.
 *  - eliminatoria: experiments/stakes/legs.ts (tieState), SOLO informativo (variante stakes-legs no adoptada).
 *  - lo que se juega: experiments/stakes/table.ts (matchStakes, modo matemático), SOLO informativo.
 *  - forma: experiments/form/features.ts (goalForm, xgOf), SOLO informativo (variantes form-* no adoptadas).
 *  - jugadores en forma: PlayerProp.formIndex de las props publicadas, SOLO informativo.
 */
import type {
  FactorAbsence,
  FactorForm,
  FactorInFormPlayer,
  FactorReferee,
  FactorStake,
  FactorStakeStatus,
  FactorStakes,
  FactorTeamForm,
  FactorTie,
  FactorVenue,
  FactorVenueSide,
  MatchFactors,
  PlayerProp,
} from '../../src/types/data';
import { MODEL, type CompetitionConfig } from '../config';
import type { MatchRecord, PlayerLine } from '../types';
import type { HistoryView, PreMatch } from '../experiments/types';
import { tieState } from '../experiments/stakes/legs';
import { isRegularRound, matchStakes, STAKES_LEAGUES } from '../experiments/stakes/table';
import { FORM_MAX_DAYS, FORM_MIN, FORM_N, goalForm, xgOf } from '../experiments/form/features';
import { refereeRatio, type RefereeMemo } from './referee';
import { PRODUCTION_MINUTES_FACTOR, recentLines, REGULAR_GAMES, teamAbsences, type AbsenceKind } from './availability';
import { teamGamesFromLines } from './players';
import { computeStandingsFromMatches } from './teamStats';

const DAY_MS = 86_400_000;
/** umbral (goles/partido) de la etiqueta de forma */
export const FORM_LABEL_THRESHOLD = 0.25;
/** mínimo de partidos de la competición y temporada para el rendimiento casa/fuera (si no, todas las competiciones) */
export const VENUE_MIN_COMP = 3;
const VENUE_DAYS = 365;
/** jugadores en forma: mínimos de índice, minutos esperados y partidos */
export const IN_FORM_MIN_INDEX = 60;
const IN_FORM_MIN_MINUTES = 30;
const IN_FORM_MIN_APPS = 3;
export const IN_FORM_MAX = 3;
export const ABSENCES_MAX = 11;
export const NOTES_MAX = 8;

export const ABSENCE_REASON: Readonly<Record<AbsenceKind, string>> = {
  susp: 'sancionado (expulsado en el último partido)',
  miss2: 'no jugó los 2 últimos partidos',
  miss1s: 'no jugó el último partido',
  miss1o: 'no jugó el último partido (otra competición)',
};
const ABSENCE_ORDER: Readonly<Record<AbsenceKind, number>> = { susp: 0, miss2: 1, miss1s: 2, miss1o: 3 };

export const VENUE_NOTE = 'ya incluido en córners/tarjetas/tiros por condición (casa/fuera de cada equipo); en goles solo cuenta la ventaja de local de la liga';

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface MatchFactorsInput {
  /** el partido (se usan solo campos previos: equipos, competición, temporada, ronda, fecha y árbitro) */
  match: Pick<PreMatch, 'id' | 'compId' | 'season' | 'date' | 'round' | 'home' | 'away' | 'neutral' | 'referee'>;
  comp: CompetitionConfig;
  /** vista del pasado con corte en el inicio del partido */
  history: HistoryView;
  /** líneas de jugador de cada equipo (cualquier fecha: se cortan aquí en el inicio del partido) */
  lines: { home: readonly PlayerLine[]; away: readonly PlayerLine[] };
  /** props publicadas del partido (ya calculadas con datos anteriores); sin ellas no hay «jugadores en forma» */
  players?: { home: readonly PlayerProp[]; away: readonly PlayerProp[] };
  /** qué ajustes aplica de verdad el modelo en este build (producción: los dos; una variante puede sustituirlos) */
  modelUses?: { referee: boolean; availability: boolean };
  /** caché de medias del árbitro (la del contexto del build; la clave incluye el corte exacto) */
  refereeMemo?: RefereeMemo;
}

// ---------------------------------------------------------------------------
// Árbitro
// ---------------------------------------------------------------------------

export function refereeFactor(i: Pick<MatchFactorsInput, 'match' | 'history' | 'refereeMemo'>, used: boolean): FactorReferee {
  const ref = i.match.referee;
  if (!ref?.id || !ref.name?.trim()) return { status: 'no publicado', usedInModel: false };
  const memo = i.refereeMemo ?? new Map();
  const cards = refereeRatio(i.match, i.history, 'cards', MODEL.referee.kCards, memo);
  const fouls = refereeRatio(i.match, i.history, 'fouls', MODEL.referee.kFouls, memo);
  const out: FactorReferee = {
    status: 'conocido',
    name: ref.name.trim(),
    matches: cards.n,
    cardsRatio: r3(cards.ratio),
    usedInModel: used && (cards.n > 0 || fouls.n > 0),
  };
  if (cards.n > 0) out.cardsPerMatch = r2(cards.observed / cards.n);
  if (fouls.n > 0) out.foulsRatio = r3(fouls.ratio);
  return out;
}

// ---------------------------------------------------------------------------
// Eliminatoria
// ---------------------------------------------------------------------------

export function tieFactor(i: Pick<MatchFactorsInput, 'match' | 'history'>): FactorTie | undefined {
  const st = tieState(i.match, i.history);
  if (!st) return undefined;
  const fl = i.history.compMatches(i.match.compId).find((m) => m.id === st.firstLegId);
  if (!fl?.score) return undefined;
  const swapped = fl.home.id === i.match.away.id;
  const aggregate = swapped ? { home: fl.score.away, away: fl.score.home } : { home: fl.score.home, away: fl.score.away };
  const leader: FactorTie['leader'] = aggregate.home > aggregate.away ? 'home' : aggregate.home < aggregate.away ? 'away' : 'none';
  let summary: string;
  if (leader === 'none') {
    summary = `Global igualado ${aggregate.home}-${aggregate.away} tras la ida: quien gane la vuelta pasa; con empate decide el reglamento (prórroga o penaltis).`;
  } else {
    const trailing = leader === 'home' ? i.match.away : i.match.home;
    const tg = leader === 'home' ? aggregate.away : aggregate.home;
    const lg = leader === 'home' ? aggregate.home : aggregate.away;
    const k = lg - tg;
    summary = `${trailing.name} pierde ${tg}-${lg} en el global: necesita ganar por ${plural(k, 'gol', 'goles')} para forzar la prórroga o los penaltis (por ${k + 1}, pasa directamente).`;
  }
  return { leg: 2, firstLegId: fl.id, firstLegDate: fl.date, firstLeg: { home: fl.score.home, away: fl.score.away }, aggregate, leader, summary, usedInModel: false };
}

// ---------------------------------------------------------------------------
// Lo que se juega cada equipo (recta final de liga)
// ---------------------------------------------------------------------------

/** Categoría de una zona de la configuración por su etiqueta. */
export function zoneCategory(label: string): Exclude<FactorStakeStatus, 'sin nada en juego'> {
  if (/campe|líder|lider/i.test(label)) return 'título';
  if (/descenso/i.test(label)) return 'descenso';
  if (/ascenso|playoff/i.test(label)) return 'ascenso';
  return 'plazas continentales';
}
const STATUS_PRIORITY: FactorStakeStatus[] = ['título', 'plazas continentales', 'ascenso', 'descenso'];

export function stakesFactor(i: Pick<MatchFactorsInput, 'match' | 'history' | 'comp'>): FactorStakes | undefined {
  const st = matchStakes(i.comp, i.match, i.history, 'strict');
  if (!st) return undefined;
  // posición actual: misma tabla que matchStakes (fase regular de la temporada, partidos anteriores)
  const ms: MatchRecord[] = i.history.compMatches(i.match.compId).filter((m) => m.season === i.match.season && isRegularRound(m.round) && !!m.score);
  const rank = new Map(computeStandingsFromMatches(ms).rows.map((r) => [r.team.id, r.rank]));
  const zones = (i.comp.simulationZones ?? []).map((z) => {
    const f = z.from < 0 ? st.n + z.from + 1 : z.from;
    const t = z.to < 0 ? st.n + z.to + 1 : z.to;
    return { label: z.label, from: Math.min(f, t), to: Math.max(f, t) };
  });
  const side = (id: string, s: typeof st.home): FactorStake | undefined => {
    const position = rank.get(id);
    if (position === undefined) return undefined;
    // zona en juego: el rango [mejor, peor] la corta (ni entero dentro ni entero fuera)
    const inPlay = zones.filter((z) => !((s.best >= z.from && s.worst <= z.to) || s.worst < z.from || s.best > z.to)).map((z) => z.label);
    const cats = new Set<FactorStakeStatus>(inPlay.map(zoneCategory));
    const status = STATUS_PRIORITY.find((c) => cats.has(c)) ?? 'sin nada en juego';
    return { position, points: s.points, played: s.played, remaining: s.remaining, best: s.best, worst: s.worst, status, inPlay };
  };
  const home = side(i.match.home.id, st.home);
  const away = side(i.match.away.id, st.away);
  if (!home || !away) return undefined;
  return { teams: st.n, home, away, usedInModel: false };
}

// ---------------------------------------------------------------------------
// Forma reciente
// ---------------------------------------------------------------------------

export function teamForm(history: HistoryView, teamId: string): FactorTeamForm | undefined {
  const gf = goalForm(history, teamId);
  if (gf.n < FORM_MIN) return undefined;
  // los mismos partidos que goalForm: últimos FORM_N de los FORM_MAX_DAYS días anteriores al corte
  const all = history.teamMatches(teamId);
  const recent: MatchRecord[] = [];
  for (let k = all.length - 1; k >= 0 && recent.length < FORM_N; k--) {
    if (history.cutoff - Date.parse(all[k].date) > FORM_MAX_DAYS * DAY_MS) break;
    recent.push(all[k]);
  }
  let goalsF = 0;
  let goalsA = 0;
  let xf = 0;
  let xa = 0;
  let nx = 0;
  for (const m of recent) {
    const home = m.home.id === teamId;
    goalsF += home ? m.score!.home : m.score!.away;
    goalsA += home ? m.score!.away : m.score!.home;
    const xF = xgOf(home ? m.stats?.home : m.stats?.away);
    const xA = xgOf(home ? m.stats?.away : m.stats?.home);
    if (xF !== undefined && xA !== undefined) {
      xf += xF;
      xa += xA;
      nx++;
    }
  }
  const n = recent.length;
  const netRes = r2(nx > 0 ? gf.xgfRes - gf.xgaRes : gf.gfRes - gf.gaRes);
  const out: FactorTeamForm = {
    last: n,
    goalsFor: r2(goalsF / n),
    goalsAgainst: r2(goalsA / n),
    netRes,
    label: netRes > FORM_LABEL_THRESHOLD ? 'rinde por encima de lo esperado' : netRes < -FORM_LABEL_THRESHOLD ? 'rinde por debajo de lo esperado' : 'en línea con lo esperado',
  };
  if (nx > 0) {
    out.xgFor = r2(xf / nx);
    out.xgAgainst = r2(xa / nx);
  }
  return out;
}

export function formFactor(history: HistoryView, match: Pick<PreMatch, 'home' | 'away'>): FactorForm | undefined {
  const home = teamForm(history, match.home.id);
  const away = teamForm(history, match.away.id);
  if (!home && !away) return undefined;
  return { ...(home ? { home } : {}), ...(away ? { away } : {}), usedInModel: false };
}

// ---------------------------------------------------------------------------
// Casa / fuera
// ---------------------------------------------------------------------------

export function venueSide(history: HistoryView, match: Pick<PreMatch, 'compId' | 'season'>, teamId: string, atHome: boolean): FactorVenueSide | undefined {
  const atVenue = history.teamMatches(teamId).filter((m) => !m.neutral && (atHome ? m.home.id === teamId : m.away.id === teamId));
  let scope: FactorVenueSide['scope'] = 'competición';
  let ms = atVenue.filter((m) => m.compId === match.compId && m.season === match.season);
  if (ms.length < VENUE_MIN_COMP) {
    scope = 'todas';
    ms = atVenue.filter((m) => history.cutoff - Date.parse(m.date) <= VENUE_DAYS * DAY_MS);
  }
  if (!ms.length) return undefined;
  let w = 0;
  let d = 0;
  let gf = 0;
  let ga = 0;
  for (const m of ms) {
    const f = atHome ? m.score!.home : m.score!.away;
    const a = atHome ? m.score!.away : m.score!.home;
    gf += f;
    ga += a;
    if (f > a) w++;
    else if (f === a) d++;
  }
  const played = ms.length;
  return { played, w, d, l: played - w - d, gfPerMatch: r2(gf / played), gaPerMatch: r2(ga / played), scope };
}

export function venueFactor(history: HistoryView, match: Pick<PreMatch, 'compId' | 'season' | 'home' | 'away' | 'neutral'>): FactorVenue | undefined {
  if (match.neutral) return undefined;
  const home = venueSide(history, match, match.home.id, true);
  const away = venueSide(history, match, match.away.id, false);
  if (!home && !away) return undefined;
  return { ...(home ? { home } : {}), ...(away ? { away } : {}), usedInModel: true, note: VENUE_NOTE };
}

// ---------------------------------------------------------------------------
// Bajas probables
// ---------------------------------------------------------------------------

export function teamAbsenceList(
  match: Pick<PreMatch, 'compId' | 'date'>,
  teamId: string,
  lines: readonly PlayerLine[],
  history: HistoryView,
  used: boolean,
): FactorAbsence[] {
  const cutoff = Date.parse(match.date);
  const ls = recentLines(lines, teamId, cutoff);
  const abs = teamAbsences(match, teamId, ls, history);
  if (!abs.length) return [];
  const games = (teamGamesFromLines(ls).get(teamId) ?? []).slice(-REGULAR_GAMES);
  const ids = new Set(games.map((g) => g.matchId));
  const minutes = new Map<string, number>();
  const names = new Map<string, string>();
  for (const l of ls) {
    if (l.name?.trim()) names.set(l.playerId, l.name.trim()); // cronológicas: queda el nombre más reciente
    if (ids.has(l.matchId) && l.minutes > 0) minutes.set(l.playerId, (minutes.get(l.playerId) ?? 0) + Math.min(l.minutes, 90));
  }
  // sanción detectada solo por eventos: nombre del evento de roja
  for (const m of history.teamMatches(teamId)) {
    for (const e of m.events ?? []) if (e.type === 'red' && e.playerId && e.player?.trim() && !names.has(e.playerId)) names.set(e.playerId, e.player.trim());
  }
  const denom = 90 * Math.max(1, games.length);
  const out: FactorAbsence[] = [];
  for (const a of abs) {
    const name = names.get(a.playerId);
    if (!name) continue;
    const factor = used ? PRODUCTION_MINUTES_FACTOR[a.kind] : 1;
    out.push({
      playerId: a.playerId,
      name,
      kind: a.kind,
      reason: ABSENCE_REASON[a.kind],
      minutesShare: r3(Math.min(1, (minutes.get(a.playerId) ?? 0) / denom)),
      minutesFactor: factor,
      usedInModel: factor !== 1,
    });
  }
  out.sort((x, y) => ABSENCE_ORDER[x.kind] - ABSENCE_ORDER[y.kind] || y.minutesShare - x.minutesShare || (x.playerId < y.playerId ? -1 : x.playerId > y.playerId ? 1 : 0));
  return out.slice(0, ABSENCES_MAX);
}

// ---------------------------------------------------------------------------
// Jugadores en forma
// ---------------------------------------------------------------------------

/** Nota de un jugador con sus líneas de los últimos 5 partidos del equipo (anteriores al corte). */
export function inFormNote(lines: readonly PlayerLine[], teamId: string, playerId: string, cutoff: number): string {
  const ls = recentLines(lines, teamId, cutoff);
  const games = (teamGamesFromLines(ls).get(teamId) ?? []).slice(-5);
  const ids = new Set(games.map((g) => g.matchId));
  let g = 0;
  let a = 0;
  let sot = 0;
  let played = 0;
  for (const l of ls) {
    if (l.playerId !== playerId || !ids.has(l.matchId) || !(l.minutes > 0)) continue;
    g += l.goals;
    a += l.assists;
    sot += l.shotsOnTarget;
    played++;
  }
  const k = games.length;
  const tail = `en los últimos ${k} partidos del equipo`;
  const parts = [g > 0 ? plural(g, 'gol', 'goles') : '', a > 0 ? plural(a, 'asistencia', 'asistencias') : ''].filter(Boolean);
  if (parts.length) return `${parts.join(' y ')} ${tail}`;
  if (sot > 0) return `${plural(sot, 'tiro a puerta', 'tiros a puerta')} ${tail}`;
  return `jugó ${played} de los últimos ${k} partidos del equipo`;
}

export function inFormPlayers(props: readonly PlayerProp[], lines: readonly PlayerLine[], teamId: string, cutoff: number): FactorInFormPlayer[] {
  return props
    .filter((p) => p.formIndex >= IN_FORM_MIN_INDEX && p.expMinutes >= IN_FORM_MIN_MINUTES && p.apps >= IN_FORM_MIN_APPS && !!p.player.name?.trim())
    .sort((x, y) => y.formIndex - x.formIndex || y.expMinutes - x.expMinutes || (x.player.id < y.player.id ? -1 : x.player.id > y.player.id ? 1 : 0))
    .slice(0, IN_FORM_MAX)
    .map((p) => ({ playerId: p.player.id, name: p.player.name.trim(), formIndex: p.formIndex, note: inFormNote(lines, teamId, p.player.id, cutoff) }));
}

// ---------------------------------------------------------------------------
// Bloque completo
// ---------------------------------------------------------------------------

/**
 * Factores del partido. Todo con el pasado de `history` (corte = inicio del partido) y las líneas anteriores al inicio:
 * añadir partidos, líneas o árbitros POSTERIORES al inicio no cambia el bloque.
 */
export function buildMatchFactors(i: MatchFactorsInput): MatchFactors {
  const cutoff = Date.parse(i.match.date);
  if (!Number.isFinite(cutoff) || i.history.cutoff !== cutoff) throw new Error(`factores del partido ${i.match.id}: el corte de la vista no es el inicio del partido`);
  const uses = i.modelUses ?? { referee: true, availability: true };
  const out: MatchFactors = { asOf: new Date(cutoff).toISOString(), referee: refereeFactor(i, uses.referee), notes: [] };

  const tie = tieFactor(i);
  if (tie) out.tie = tie;
  if (STAKES_LEAGUES.has(i.comp.id)) {
    const stakes = stakesFactor(i);
    if (stakes) out.stakes = stakes;
  }
  const form = formFactor(i.history, i.match);
  if (form) out.form = form;
  const venue = venueFactor(i.history, i.match);
  if (venue) out.venue = venue;
  const absHome = teamAbsenceList(i.match, i.match.home.id, i.lines.home, i.history, uses.availability);
  const absAway = teamAbsenceList(i.match, i.match.away.id, i.lines.away, i.history, uses.availability);
  if (absHome.length || absAway.length) out.absences = { home: absHome, away: absAway };
  if (i.players) {
    const home = inFormPlayers(i.players.home, i.lines.home, i.match.home.id, cutoff);
    const away = inFormPlayers(i.players.away, i.lines.away, i.match.away.id, cutoff);
    if (home.length || away.length) out.inForm = { home, away, usedInModel: false };
  }

  // notas: qué usa el modelo y qué es solo informativo
  const notes = out.notes;
  const ref = out.referee;
  if (ref.status === 'no publicado') notes.push('ESPN aún no ha publicado el árbitro: sin ajuste por árbitro (se vuelve a consultar en cada actualización).');
  else if (ref.usedInModel) {
    const pct = Math.round((ref.cardsRatio - 1) * 100);
    const txt = pct === 0 ? 'en la media de tarjetas' : `${Math.abs(pct)} % ${pct > 0 ? 'más' : 'menos'} tarjetas que la media de sus competiciones`;
    notes.push(`Árbitro ${ref.name}: ${txt} (${plural(ref.matches, 'partido previo', 'partidos previos')}); el modelo lo aplica a tarjetas y faltas.`);
  } else notes.push(`Árbitro ${ref.name}: sin partidos previos suficientes en los datos, no ajusta el modelo.`);
  const susp = [...absHome, ...absAway].filter((a) => a.kind === 'susp' && a.usedInModel);
  if (susp.length) notes.push('Sancionados probables fuera de las props: se supone un partido de sanción tras una roja en la misma competición (sin recursos ni ciclos de amarillas).');
  if (out.absences && (absHome.some((a) => a.kind !== 'susp' && a.usedInModel) || absAway.some((a) => a.kind !== 'susp' && a.usedInModel))) {
    notes.push('Habituales ausentes en los últimos partidos: menos minutos esperados en sus props (sin alineaciones ni partes médicos).');
  }
  notes.push('El modelo usa el árbitro (si se conoce), las bajas probables (props de jugadores) y el rendimiento casa/fuera en córners, tarjetas y tiros.');
  notes.push('Solo informativo, no cambia las probabilidades: forma reciente, casa/fuera en goles, estado de la eliminatoria, lo que se juega cada equipo y jugadores en forma.');
  if (out.form) notes.push('La forma se mide con xG aproximado por tiros frente a lo esperado por el Elo; rendir por encima suele corregirse y el mercado ya la descuenta.');
  out.notes = notes.slice(0, NOTES_MAX);
  return out;
}
