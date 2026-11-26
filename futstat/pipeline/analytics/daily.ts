/**
 * Motor del apartado «PRONÓSTICOS DEL DÍA» (public/data/daily.json; publicación en publish/daily.ts).
 *
 * Amplía los pronósticos de alta confianza (analytics/confidence.ts, que NO cambia de alcance: confidence.json sigue con
 * resultado, goles, córners y tarjetas) con familias ADICIONALES que solo alimentan el apartado diario:
 *
 *   'tiros'      tiros a puerta totales (más de 6.5/7.5/8.5, menos de 11.5/12.5/13.5), tiros a puerta de un equipo
 *                (más de 2.5/3.5) y tiros totales (más de 19.5/21.5/23.5, menos de 31.5/33.5/35.5)
 *   'faltas'     faltas totales (más de 17.5/19.5, menos de 27.5/29.5/31.5)
 *   'jugadores'  props de jugador: «1+ tiro a puerta», «1+ tiro», «2+ tiros» y «marca gol»
 *
 * MISMO RIGOR que las familias existentes, con el mismo código (fitConfidenceProcedure / walkForwardConfidence):
 *   - candidatos SIN FUGA: proyecciones binomial negativa de statContext(antes del partido); props con buildPlayerProps
 *     usando solo líneas de jugador anteriores, el λ del equipo de la predicción walk-forward y los factores del rival
 *     de esas mismas proyecciones;
 *   - recalibración de Platt por familia|fuente, umbral, solo la franja «oro» (>= 85 % en el histórico de la regla);
 *   - validación FUERA DE MUESTRA: walk-forward mensual (cada mes, reglas ajustadas con todo lo anterior); una regla
 *     solo se publica con >= 30 picks y >= 80 % acumulados en los tramos anteriores. En estas familias la validación
 *     cuenta TODOS los candidatos que superan la regla (no hay tope por partido en esta fase).
 *   - resolución: stats.shotsOnTarget / shots / fouls del partido (sin dato → no se evalúa; prórroga o penaltis →
 *     excluido). Props: si el jugador no aparece en las líneas del partido (no jugó) → nulo, como hacen las casas; si
 *     jugó, acierto según su línea. Solo partidos con resumen descargado (líneas de jugador de los dos equipos).
 *   - jugadores elegibles: minutos esperados >= 60, jugó alguno de los 2 últimos partidos de su equipo y suma >= 270
 *     minutos en la ventana (para que su tasa no sea solo el prior de su posición).
 *
 * REGLA DE SELECCIÓN DIARIA (selectDailyPicks): de todos los candidatos de un partido que superan una regla VALIDADA
 * (existentes + adicionales), ordenados por puntuación, como mucho 2 por categoría y 8 por partido, sin redundancias
 * (un solo pick por grupo: resultado; goles más/menos; goles de cada equipo; cada estadística y sentido; cada jugador).
 *
 * PUNTUACIÓN 0..100 (dailyScore): 50 % probabilidad recalibrada, 30 % límite inferior de Wilson (90 %) del récord fuera
 * de muestra de su regla, 20 % lift sobre la tasa base de su familia (acierto de la regla − acierto de la selección
 * natural sin umbral); −8 puntos si el lift es <= 0 (acierto puramente estructural).
 *
 * COMBINADAS (buildCombos): patas de PARTIDOS DISTINTOS (independientes), la mejor de cada partido (primero las de lift
 * positivo, luego por puntuación): 'segura' 2 patas, 'equilibrada' 3, 'atrevida' 4–5. Probabilidad = producto de las
 * probabilidades recalibradas.
 *
 * RÉCORD (dailyWalkForward): la MISMA regla de selección aplicada fuera de muestra en cada tramo mensual, con las reglas
 * validadas hasta ese momento y la puntuación calculada solo con datos anteriores al tramo.
 */
import type { PlayerProp, StatProjection } from '../../src/types/data';
import { fairOdds, nbPmfArray, overUnderFromDist } from '../../src/lib/models';
import type { MatchRecord } from '../types';
import { predictMatch } from './predict';
import { dispersionFromProjection, projectMatchStats, STAT_DEF_BY_KEY, type StatContext } from './projections';
import {
  candidatesFromPrediction,
  teamHistoryBefore,
  DAILY_EXTRA_FAMILIES,
  FAMILY_BY_ID,
  WILSON_Z90,
  confidenceHistory,
  familyBaseRates,
  filterValidatedRules,
  fitConfidenceProcedure,
  ruleKey,
  ruleValidation,
  selectConfidencePicks,
  settleCandidate,
  walkForwardConfidence,
  wilsonInterval,
  type CandidateInput,
  type CandidateOptions,
  type CandidateResult,
  type ConfidenceCandidate,
  type ConfidenceFamily,
  type ConfidenceHistoryItem,
  type ConfidencePick,
  type ConfidenceRules,
  type ConfidenceSegment,
  type ConfidenceTheme,
  type ExtraSettleData,
  type ExtraStat,
  type HistoryOptions,
  type HitStats,
  type ProcedureLevelLog,
  type ProcedureOptions,
  type ProcedureResult,
  type RejectedFamily,
  type RuleValidation,
  type SelectOptions,
  type SettledCandidate,
  type UnvalidatedRule,
  type WalkForwardResult,
  DEFAULT_MAX_PROB,
  DEFAULT_MIN_PROB,
  DEFAULT_MIN_STAT_GAMES,
} from './confidence';
import type { SettleData } from './settle';
import { baseContext, statContext, TEAM_WINDOW_DAYS, type BuildContext, type FullPrediction } from '../publish/context';
import { fullPrediction, propsFor } from '../publish/matches';
import { localDay } from '../publish/util';

const DAY_MS = 86_400_000;
const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Familias adicionales: candidatos
// ---------------------------------------------------------------------------

export const EXTRA_FAMILY_IDS: ConfidenceFamily[] = DAILY_EXTRA_FAMILIES.map((f) => f.id);
const EXTRA_ORDER = new Map<ConfidenceFamily, number>(EXTRA_FAMILY_IDS.map((id, i) => [id, i]));

/** Jugadores elegibles para un prop. */
export const PLAYER_MIN_EXP_MINUTES = 60;
export const PLAYER_RECENT_GAMES = 2;
export const PLAYER_MIN_MINUTES = 270;
/** Líneas de jugador mínimas (con minutos) de cada equipo para resolver los props de un partido. */
export const PLAYER_MIN_LINES_PER_TEAM = 7;

interface StatLines {
  stat: ExtraStat;
  word: string;
  label: string;
  idPrefix: string;
  total: [ConfidenceFamily, number, 'over' | 'under'][];
  team: [ConfidenceFamily, number][];
}

const STAT_LINES: StatLines[] = [
  {
    stat: 'shotsOnTarget',
    word: 'tiros a puerta',
    label: 'Tiros a puerta',
    idPrefix: 'sot',
    total: [
      ['sot-over-6.5', 6.5, 'over'],
      ['sot-over-7.5', 7.5, 'over'],
      ['sot-over-8.5', 8.5, 'over'],
      ['sot-under-11.5', 11.5, 'under'],
      ['sot-under-12.5', 12.5, 'under'],
      ['sot-under-13.5', 13.5, 'under'],
    ],
    team: [
      ['sot-team-over-2.5', 2.5],
      ['sot-team-over-3.5', 3.5],
    ],
  },
  {
    stat: 'shots',
    word: 'tiros',
    label: 'Tiros',
    idPrefix: 'shots',
    total: [
      ['shots-over-19.5', 19.5, 'over'],
      ['shots-over-21.5', 21.5, 'over'],
      ['shots-over-23.5', 23.5, 'over'],
      ['shots-under-31.5', 31.5, 'under'],
      ['shots-under-33.5', 33.5, 'under'],
      ['shots-under-35.5', 35.5, 'under'],
    ],
    team: [],
  },
  {
    stat: 'fouls',
    word: 'faltas',
    label: 'Faltas',
    idPrefix: 'fouls',
    total: [
      ['fouls-over-17.5', 17.5, 'over'],
      ['fouls-over-19.5', 19.5, 'over'],
      ['fouls-under-27.5', 27.5, 'under'],
      ['fouls-under-29.5', 29.5, 'under'],
      ['fouls-under-31.5', 31.5, 'under'],
    ],
    team: [],
  },
];

export interface ExtraInput {
  homeName: string;
  awayName: string;
  homeId: string;
  awayId: string;
  /** proyecciones NB (se usan 'shotsOnTarget', 'shots' y 'fouls') */
  projections?: StatProjection[];
  /** fuente de la predicción del partido (la misma de los candidatos existentes) */
  segment: ConfidenceSegment;
  /** partidos previos con cada estadística del equipo con menos historial (undefined = no se comprueba) */
  statGames?: Partial<Record<ExtraStat, number>>;
  /** props de los jugadores ELEGIBLES de cada equipo (eligibleProps); undefined = sin props */
  players?: { home: PlayerProp[]; away: PlayerProp[] };
}

export interface ExtraCandidateOptions extends CandidateOptions {
  /** selección «natural» de cada familia sin umbral: la más probable de la familia, cualquier probabilidad (tasa base) */
  natural?: boolean;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

function cand(
  segment: ConfidenceSegment,
  family: ConfidenceFamily,
  marketId: string,
  market: string,
  selection: string,
  prob: number,
  settle: ConfidenceCandidate['settle'],
): ConfidenceCandidate {
  const p = clamp01(prob);
  return { family, theme: FAMILY_BY_ID.get(family)!.theme, marketId, market, selection, prob: p, fairOdds: fairOdds(p), settle, segment };
}

/**
 * Candidatos de las familias adicionales de un partido. Totales: uno por familia. Por equipo y por jugador: uno por
 * equipo / jugador (pueden salir varios de la misma familia). Solo dentro de [minProb = 0.5, maxProb = 0.93], como las
 * familias existentes. Con `natural`: la selección más probable de cada familia, sin umbral.
 */
export function extraCandidates(input: ExtraInput, opts: ExtraCandidateOptions = {}): ConfidenceCandidate[] {
  const maxProb = opts.natural ? 1 : (opts.maxProb ?? DEFAULT_MAX_PROB);
  const minProb = opts.natural ? 0 : (opts.minProb ?? DEFAULT_MIN_PROB);
  const minStat = opts.minStatGames ?? DEFAULT_MIN_STAT_GAMES;
  const H = input.homeName?.trim() || 'Local';
  const A = input.awayName?.trim() || 'Visitante';
  const seg = input.segment;
  const all: ConfidenceCandidate[] = [];

  for (const def of STAT_LINES) {
    const proj = input.projections?.find((p) => p.key === def.stat);
    if (!proj) continue;
    const games = input.statGames?.[def.stat];
    if (input.statGames !== undefined && !(games !== undefined && games >= minStat)) continue;
    const dist = proj.totalDist;
    if (!Array.isArray(dist) || dist.length < 2 || !dist.every((v) => Number.isFinite(v) && v >= 0)) continue;
    for (const [family, line, side] of def.total) {
      const r = overUnderFromDist(dist, line);
      all.push(
        cand(seg, family, `${def.idPrefix}-ou-${line}`, `${def.label}: más/menos ${line}`, `${side === 'over' ? 'Más' : 'Menos'} de ${line} ${def.word}`, r[side], {
          kind: 'stat',
          stat: def.stat,
          side,
          line,
        }),
      );
    }
    if (def.team.length && Number.isFinite(proj.home) && Number.isFinite(proj.away)) {
      const maxK = STAT_DEF_BY_KEY.get(def.stat)?.maxK ?? 40;
      const disp = dispersionFromProjection(proj);
      for (const team of ['home', 'away'] as const) {
        const name = team === 'home' ? H : A;
        const td = nbPmfArray(team === 'home' ? proj.home : proj.away, disp, maxK);
        for (const [family, line] of def.team) {
          all.push(
            cand(seg, family, `${def.idPrefix}-${team}-ou-${line}`, `${def.label} de ${name}: más/menos ${line}`, `${name}: más de ${line} ${def.word}`, overUnderFromDist(td, line).over, {
              kind: 'stat',
              stat: def.stat,
              team,
              side: 'over',
              line,
            }),
          );
        }
      }
    }
  }

  for (const side of ['home', 'away'] as const) {
    const teamName = side === 'home' ? H : A;
    for (const p of input.players?.[side] ?? []) {
      const pl = p.player;
      if (!pl?.id) continue;
      const who = `${pl.name} (${teamName})`;
      const player = { id: pl.id, name: pl.name, short: pl.short || pl.name, teamId: pl.teamId, position: pl.position, expMinutes: p.expMinutes };
      const mk = (family: ConfidenceFamily, slug: string, market: string, what: string, prob: number, stat: 'shotsOnTarget' | 'shots' | 'goals', min = 1) => {
        const c = cand(seg, family, `player-${pl.id}-${slug}`, market, `${who}: ${what}`, prob, { kind: 'player', playerId: pl.id, stat, min });
        c.player = player;
        all.push(c);
      };
      mk('player-sot-1', 'sot-1', 'Jugador: tiros a puerta', 'al menos 1 tiro a puerta', p.pSot1, 'shotsOnTarget');
      mk('player-shot-1', 'shots-1', 'Jugador: tiros', 'al menos 1 tiro', p.pShots1, 'shots');
      mk('player-shot-2', 'shots-2', 'Jugador: tiros', 'al menos 2 tiros', p.pShots2, 'shots', 2);
      mk('player-goal', 'goal', 'Jugador: goleador', 'marca gol', p.pGoal, 'goals');
    }
  }

  const inRange = all.filter((c) => c.prob >= minProb - EPS && c.prob <= maxProb + EPS);
  let out = inRange;
  if (opts.natural) {
    const best = new Map<ConfidenceFamily, ConfidenceCandidate>();
    for (const c of inRange) {
      const prev = best.get(c.family);
      if (!prev || c.prob > prev.prob) best.set(c.family, c);
    }
    out = [...best.values()];
  }
  return out.sort((a, b) => EXTRA_ORDER.get(a.family)! - EXTRA_ORDER.get(b.family)! || b.prob - a.prob || a.marketId.localeCompare(b.marketId));
}

// ---------------------------------------------------------------------------
// Entrada de los candidatos adicionales (sin fuga)
// ---------------------------------------------------------------------------

/** Jugadores (con minutos) de los `n` últimos partidos del equipo con líneas anteriores a `before`. */
export function recentPlayers(ctx: BuildContext, teamId: string, before: number, n = PLAYER_RECENT_GAMES): Set<string> {
  const lines = ctx.linesByTeam.get(teamId) ?? [];
  const from = before - TEAM_WINDOW_DAYS * DAY_MS;
  const games: string[] = [];
  const out = new Set<string>();
  // las líneas de cada equipo están en orden cronológico (createContext)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const t = Date.parse(l.date);
    if (!(t < before)) continue;
    if (t < from) break;
    if (!games.includes(l.matchId)) {
      if (games.length >= n) break;
      games.push(l.matchId);
    }
    if (l.minutes > 0) out.add(l.playerId);
  }
  return out;
}

/**
 * Props de los jugadores ELEGIBLES de un equipo con datos anteriores a `before`: minutos esperados >= 60, jugó alguno
 * de los 2 últimos partidos del equipo y >= 270 minutos en la ventana.
 */
export function eligibleProps(
  ctx: BuildContext,
  m: Pick<MatchRecord, 'home' | 'away'>,
  side: 'home' | 'away',
  lambda: number,
  projections: StatProjection[],
  before: number,
): PlayerProp[] {
  const teamId = side === 'home' ? m.home.id : m.away.id;
  const oppId = side === 'home' ? m.away.id : m.home.id;
  const props = propsFor(ctx, teamId, oppId, side, lambda, projections, before);
  if (!props.length) return [];
  const recent = recentPlayers(ctx, teamId, before);
  return props.filter((p) => p.expMinutes >= PLAYER_MIN_EXP_MINUTES && p.minutes >= PLAYER_MIN_MINUTES && recent.has(p.player.id));
}

function extraStatGames(sc: StatContext, m: Pick<MatchRecord, 'home' | 'away'>): Partial<Record<ExtraStat, number>> {
  const g = (k: ExtraStat) => Math.min(sc.teams.get(m.home.id)?.[k]?.n ?? 0, sc.teams.get(m.away.id)?.[k]?.n ?? 0);
  return { shotsOnTarget: g('shotsOnTarget'), shots: g('shots'), fouls: g('fouls') };
}

/**
 * Entrada de los candidatos adicionales de un partido a partir de la entrada (sin fuga) de los existentes:
 * mismas proyecciones, misma fuente y los λ finales. `before` = inicio del partido; `sc` = el contexto de
 * estadísticas con el que se hicieron esas proyecciones.
 */
export function extraInputOf(ctx: BuildContext, m: MatchRecord, base: CandidateInput, sc: StatContext, before: number, withPlayers = true): ExtraInput {
  const projections = base.projections ?? [];
  const input: ExtraInput = {
    homeName: m.home.name,
    awayName: m.away.name,
    homeId: m.home.id,
    awayId: m.away.id,
    projections,
    segment: base.withMarket ? 'mercado' : 'estadistico',
    statGames: extraStatGames(sc, m),
  };
  if (withPlayers && Number.isFinite(base.lambdaHome) && Number.isFinite(base.lambdaAway)) {
    input.players = {
      home: eligibleProps(ctx, m, 'home', base.lambdaHome!, projections, before),
      away: eligibleProps(ctx, m, 'away', base.lambdaAway!, projections, before),
    };
  }
  return input;
}

/** Candidatos adicionales de un partido PRÓXIMO: la predicción publicada (fullPrediction) y los props de su ficha. */
export function upcomingExtraCandidates(ctx: BuildContext, m: MatchRecord, opts: ExtraCandidateOptions = {}): ConfidenceCandidate[] {
  const fp = fullPrediction(ctx, m, true);
  const sc = statContext(ctx, m.compId);
  const t = Date.parse(m.date);
  const base: CandidateInput = {
    homeName: m.home.name,
    awayName: m.away.name,
    p: fp.result.quick.p,
    matrix: fp.result.matrix,
    projections: fp.projections,
    withMarket: !!fp.result.model.market,
    lambdaHome: fp.result.lambdaHome,
    lambdaAway: fp.result.lambdaAway,
  };
  return extraCandidates(extraInputOf(ctx, m, base, sc, Number.isFinite(t) ? t : ctx.now), opts);
}

/**
 * Un partido EN JUEGO visto como antes de empezar: sin marcador, estadísticas ni eventos y con la ÚLTIMA cuota capturada
 * antes del saque (oddsHistory solo guarda capturas previas al partido; `odds` puede ser ya una cuota en directo). Sin
 * captura previa, sin cuotas.
 */
export function preMatchRecord(m: MatchRecord): MatchRecord {
  const out: MatchRecord = { ...m, status: 'scheduled' };
  delete out.score;
  delete out.stats;
  delete out.events;
  delete out.statusDetail;
  const h = m.oddsHistory;
  if (h?.length) out.odds = h[h.length - 1];
  else delete out.odds;
  return out;
}

/**
 * Candidatos (familias existentes + adicionales) de un partido EN JUEGO con información anterior al saque: modelos del
 * build (solo usan partidos terminados), proyecciones con partidos terminados y la última cuota previa (preMatchRecord).
 * No usa ni toca la caché de predicciones (la ficha del partido en juego sigue con la suya).
 */
export function preMatchCandidates(ctx: BuildContext, m: MatchRecord, opts: ExtraCandidateOptions = {}): { fp: FullPrediction; candidates: ConfidenceCandidate[] } {
  const rec = preMatchRecord(m);
  const comp = ctx.configById.get(rec.compId)!;
  const sc = statContext(ctx, comp.id);
  const projections = projectMatchStats(rec.home.id, rec.away.id, sc);
  const result = predictMatch(rec, baseContext(ctx, comp), { projections });
  const t = Date.parse(rec.date);
  const before = Number.isFinite(t) ? t : ctx.now;
  const base = candidatesFromPrediction(rec, result, projections, { ...opts, history: teamHistoryBefore(ctx, rec, sc, before) });
  const input: CandidateInput = {
    homeName: rec.home.name,
    awayName: rec.away.name,
    p: result.quick.p,
    matrix: result.matrix,
    projections,
    withMarket: !!result.model.market,
    lambdaHome: result.lambdaHome,
    lambdaAway: result.lambdaAway,
  };
  return { fp: { result, projections }, candidates: [...base, ...extraCandidates(extraInputOf(ctx, rec, input, sc, before), opts)] };
}

// ---------------------------------------------------------------------------
// Resolución
// ---------------------------------------------------------------------------

const nonNeg = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined);

/**
 * Datos de resolución de las familias adicionales de un partido terminado. Prórroga o penaltis: nada (la fuente da las
 * estadísticas con la prórroga incluida). Un total de 0 tiros es un dato ausente. Props: solo si hay líneas de jugador
 * de los dos equipos y alguna registra tiros (hay ligas sin tiros por jugador).
 */
export function extraSettleDataOf(ctx: BuildContext, m: MatchRecord, d: SettleData): SettleData & ExtraSettleData {
  const out: SettleData & ExtraSettleData = { ...d };
  if (d.extraTime) return out;
  const h = m.stats?.home;
  const a = m.stats?.away;
  if (h && a) {
    const sh = nonNeg(h.shots);
    const sa = nonNeg(a.shots);
    const th = nonNeg(h.shotsOnTarget);
    const ta = nonNeg(a.shotsOnTarget);
    const shotsOk = sh !== undefined && sa !== undefined && sh + sa > 0;
    if (shotsOk) out.shots = { home: sh!, away: sa! };
    // tiros a puerta: coherentes con los tiros cuando hay ambos datos (a puerta <= tiros) y con algún tiro en el partido
    if (th !== undefined && ta !== undefined && (sh === undefined || sa === undefined ? th + ta > 0 : shotsOk && th <= sh && ta <= sa)) {
      out.shotsOnTarget = { home: th, away: ta };
    }
    const fh = nonNeg(h.fouls);
    const fa = nonNeg(a.fouls);
    if (fh !== undefined && fa !== undefined && fh + fa > 0) out.fouls = { home: fh, away: fa };
  }
  const lines = ctx.linesByMatch.get(m.id);
  if (lines?.length) {
    let nh = 0;
    let na = 0;
    let shots = 0;
    const players = new Map<string, { minutes: number; shots: number; shotsOnTarget: number; goals: number }>();
    for (const l of lines) {
      if (!(l.minutes > 0)) continue;
      if (l.teamId === m.home.id) nh++;
      else if (l.teamId === m.away.id) na++;
      else continue;
      shots += l.shots;
      players.set(l.playerId, { minutes: l.minutes, shots: l.shots, shotsOnTarget: l.shotsOnTarget, goals: l.goals });
    }
    if (nh >= PLAYER_MIN_LINES_PER_TEAM && na >= PLAYER_MIN_LINES_PER_TEAM && shots > 0) out.players = players;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Historial walk-forward (existentes + adicionales en una sola pasada)
// ---------------------------------------------------------------------------

export interface DailyHistory {
  /** historial de las familias existentes: idéntico a confidenceHistory(ctx) */
  base: ConfidenceHistoryItem[];
  /** mismos partidos y orden, con los candidatos (resueltos) y la selección natural de las familias adicionales */
  extra: ConfidenceHistoryItem[];
}

function settleAll(cands: ConfidenceCandidate[], d: SettleData & ExtraSettleData): SettledCandidate[] {
  const out: SettledCandidate[] = [];
  for (const c of cands) {
    const r = settleCandidate(c, d);
    if (r) out.push({ ...c, result: r });
  }
  return out;
}

export interface DailyHistoryOptions extends HistoryOptions {
  /**
   * gancho por partido evaluado con la entrada sin fuga de las familias adicionales (props de los jugadores elegibles
   * incluidos cuando el partido tiene líneas de jugador) y los datos de resolución completos. Lo usa el apartado «Cuota
   * alta 6+» (analytics/longshots.ts) para no volver a predecir nada. No cambia el historial devuelto.
   */
  visitExtra?: (m: MatchRecord, input: CandidateInput, extra: ExtraInput, d: SettleData & ExtraSettleData, item: ConfidenceHistoryItem) => void;
}

/**
 * Historial walk-forward de las familias existentes y de las adicionales: cada partido terminado de la temporada actual
 * se predice UNA vez (walkForwardInput) y de esa misma entrada salen los dos conjuntos de candidatos.
 */
export function dailyHistory(ctx: BuildContext, opts: DailyHistoryOptions = {}): DailyHistory {
  const extraById = new Map<string, { candidates: SettledCandidate[]; base: Partial<Record<ConfidenceFamily, CandidateResult>> }>();
  const base = confidenceHistory(ctx, {
    ...opts,
    visit: (m, input, d, item) => {
      opts.visit?.(m, input, d, item);
      const t = Date.parse(m.date);
      const ed = extraSettleDataOf(ctx, m, d);
      // props: solo si el partido se puede resolver (resumen con líneas de jugador)
      const ein = extraInputOf(ctx, m, input, statContext(ctx, m.compId, t), t, !!ed.players);
      const candidates = settleAll(extraCandidates(ein, opts), ed);
      const natural: Partial<Record<ConfidenceFamily, CandidateResult>> = {};
      for (const c of settleAll(extraCandidates(ein, { ...opts, natural: true }), ed)) natural[c.family] = c.result;
      extraById.set(item.matchId, { candidates, base: natural });
      opts.visitExtra?.(m, input, ein, ed, item);
    },
  });
  const extra = base.map((it): ConfidenceHistoryItem => {
    const e = extraById.get(it.matchId);
    return { ...it, candidates: e?.candidates ?? [], base: e?.base ?? {} };
  });
  return { base, extra };
}

// ---------------------------------------------------------------------------
// Reglas de las familias adicionales (mismo procedimiento) y validación fuera de muestra
// ---------------------------------------------------------------------------

/** Validación de las familias adicionales: todos los candidatos que superan su regla (sin tope por partido). */
export const EXTRA_SELECT: SelectOptions = { maxPerMatch: Infinity, maxPerTheme: Infinity, maxPerFamily: Infinity };

export const EXTRA_PROCEDURE: ProcedureOptions = {
  families: EXTRA_FAMILY_IDS,
  rule: { familyDefs: DAILY_EXTRA_FAMILIES },
  fixedExclude: [],
  select: EXTRA_SELECT,
};

export interface ExtraEvaluation {
  /** reglas de PRODUCCIÓN (todo el historial) validadas fuera de muestra con todo el walk-forward */
  rules: ConfidenceRules;
  /** reglas del procedimiento que no superan la validación (no se publican) */
  unvalidated: UnvalidatedRule[];
  /** familias|fuente descartadas al ajustar (sin regla), con el motivo */
  rejected: RejectedFamily[];
  /** validación por regla con todo el walk-forward */
  validation: Map<string, RuleValidation>;
  wf: WalkForwardResult;
  choice: ProcedureResult['chosen'];
  log: ProcedureLevelLog[];
}

/** Procedimiento completo de las familias adicionales: walk-forward mensual + reglas de producción validadas. */
export function evaluateExtras(extra: ConfidenceHistoryItem[], opts: { minTrain?: number } = {}): ExtraEvaluation {
  const wf = walkForwardConfidence(extra, { minTrain: opts.minTrain, procedure: EXTRA_PROCEDURE, select: EXTRA_SELECT });
  const prod = fitConfidenceProcedure(extra, EXTRA_PROCEDURE);
  const validation = ruleValidation(wf.candidatePicks, prod.rules.options.segmented);
  const filtered = filterValidatedRules(prod.rules, validation);
  return { rules: filtered.rules, unvalidated: filtered.unvalidated, rejected: prod.rules.rejected, validation, wf, choice: prod.chosen, log: prod.log };
}

// ---------------------------------------------------------------------------
// Puntuación y selección diaria
// ---------------------------------------------------------------------------

export const DAILY_MAX_PER_CATEGORY = 2;
export const DAILY_MAX_PER_MATCH = 8;
/** Penalización (puntos) de una regla cuyo acierto fuera de muestra no supera la tasa base de su familia. */
export const SCORE_NO_LIFT_PENALTY = 8;

export interface OosRecord {
  n: number;
  hits: number;
  hitRate: number;
}

/** Con qué se puntúa: récord fuera de muestra de cada regla (familia|fuente) y tasa base de cada familia. */
export interface ScoreContext {
  validation: ReadonlyMap<string, OosRecord>;
  baseRates: Partial<Record<ConfidenceFamily, { n: number; hitRate: number }>>;
}

/**
 * Puntuación 0..100 de un pick: 50 % probabilidad recalibrada, 30 % límite inferior de Wilson (90 %) del récord fuera
 * de muestra de su regla, 20 % lift sobre la tasa base de su familia (0.80 + lift, acotado a [0.6, 1]); la mezcla se
 * lleva de [0.72, 0.96] a [0, 100] y se restan SCORE_NO_LIFT_PENALTY puntos si el lift es <= 0. Sin récord: Wilson 0.75
 * y lift 0 (sin penalización).
 */
export function dailyScore(calibratedProb: number, oos: OosRecord | undefined, baseRate: number | undefined): { score: number; lift?: number } {
  const q = clamp01(calibratedProb);
  const has = !!oos && oos.n > 0;
  const wl = has ? wilsonInterval(oos!.hits, oos!.n, WILSON_Z90)[0] : 0.75;
  const lift = has && baseRate !== undefined && Number.isFinite(baseRate) ? oos!.hitRate - baseRate : undefined;
  const liftTerm = Math.min(1, Math.max(0.6, 0.8 + (lift ?? 0)));
  const core = 0.5 * q + 0.3 * wl + 0.2 * liftTerm;
  let s = ((core - 0.72) / 0.24) * 100;
  if (lift !== undefined && lift <= 0) s -= SCORE_NO_LIFT_PENALTY;
  const out: { score: number; lift?: number } = { score: Math.round(Math.min(100, Math.max(0, s))) };
  if (lift !== undefined) out.lift = lift;
  return out;
}

/**
 * Grupo de redundancia de una selección: dos picks del mismo grupo en un partido dicen casi lo mismo (p. ej. «más de
 * 6.5» y «más de 7.5» tiros a puerta; «gana X» y «X o empate»; 1+ tiro y 1+ tiro a puerta del mismo jugador).
 */
export function redundancyGroup(c: Pick<ConfidenceCandidate, 'settle'>): string {
  const s = c.settle;
  switch (s.kind) {
    case 'outcome':
    case 'dnb':
    case 'handicap':
      return 'resultado';
    case 'total':
      return `${s.stat}-${s.side}`;
    case 'team-total':
      return `goles-${s.team}-${s.side}`;
    case 'btts':
      return 'btts';
    case 'stat':
      return `${s.stat}-${s.team ?? 'total'}-${s.side}`;
    case 'player':
      return `jugador-${s.playerId}`;
  }
}

export interface DailyEnginePick extends ConfidencePick {
  /** 0..100 (dailyScore) */
  score: number;
  /** acierto fuera de muestra de su regla − tasa base de su familia (undefined si falta alguno) */
  lift?: number;
  group: string;
}

export interface DailySelectOptions {
  maxPerCategory?: number;
  maxPerMatch?: number;
  minHitRate?: number;
}

/** Une dos conjuntos de reglas (existentes + adicionales): familias disjuntas, misma segmentación. */
export function mergeRules(a: ConfidenceRules, b: ConfidenceRules): ConfidenceRules {
  return { ...a, rules: [...a.rules, ...b.rules], rejected: [...a.rejected, ...b.rejected] };
}

const cmpPick = (a: DailyEnginePick, b: DailyEnginePick) =>
  b.score - a.score || b.calibratedProb - a.calibratedProb || b.prob - a.prob || a.family.localeCompare(b.family) || a.marketId.localeCompare(b.marketId);

/**
 * Picks del apartado diario de UN partido: todos los candidatos que superan una regla (franja oro), por puntuación;
 * como mucho maxPerCategory (2) por categoría, maxPerMatch (8) en total y uno por grupo de redundancia.
 */
export function selectDailyPicks(candidates: ConfidenceCandidate[], rules: ConfidenceRules, sc: ScoreContext, opts: DailySelectOptions = {}): DailyEnginePick[] {
  const maxCat = opts.maxPerCategory ?? DAILY_MAX_PER_CATEGORY;
  const maxMatch = opts.maxPerMatch ?? DAILY_MAX_PER_MATCH;
  const qualified = selectConfidencePicks(candidates, rules, { ...EXTRA_SELECT, minHitRate: opts.minHitRate });
  const scored: DailyEnginePick[] = qualified.map((p) => {
    const s = dailyScore(p.calibratedProb, sc.validation.get(ruleKey(p.family, rules.options.segmented ? p.segment : undefined)), sc.baseRates[p.family]?.hitRate);
    const out: DailyEnginePick = { ...p, score: s.score, group: redundancyGroup(p) };
    if (s.lift !== undefined) out.lift = s.lift;
    return out;
  });
  scored.sort(cmpPick);
  const out: DailyEnginePick[] = [];
  const perCat = new Map<ConfidenceTheme, number>();
  const groups = new Set<string>();
  for (const p of scored) {
    if (out.length >= maxMatch) break;
    if ((perCat.get(p.theme) ?? 0) >= maxCat || groups.has(p.group)) continue;
    perCat.set(p.theme, (perCat.get(p.theme) ?? 0) + 1);
    groups.add(p.group);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Combinadas
// ---------------------------------------------------------------------------

export const COMBO_DEFS = [
  { id: 'segura', label: 'Combinada segura', legs: 2, minLegs: 2 },
  { id: 'equilibrada', label: 'Combinada equilibrada', legs: 3, minLegs: 3 },
  { id: 'atrevida', label: 'Combinada atrevida', legs: 5, minLegs: 4 },
] as const;

/** Patas como mucho de la misma familia de mercado en una combinada (no concentrar el riesgo de modelo en un mercado). */
export const COMBO_MAX_PER_FAMILY = 2;

interface LegLike {
  family: string;
  score?: number;
  lift?: number;
  prob: number;
  calibratedProb?: number;
  marketOdds?: number;
}

export interface Combo<P> {
  id: string;
  label: string;
  legs: { matchId: string; pick: P }[];
  /** producto de las probabilidades recalibradas de las patas */
  prob: number;
  fairOdds: number;
  /** producto de las cuotas de la casa si todas las patas la tienen */
  marketOdds?: number;
}

const legProb = (p: LegLike) => clamp01(p.calibratedProb ?? p.prob);
const cmpLeg = (a: LegLike, b: LegLike) =>
  Number((b.lift ?? 0) > 0) - Number((a.lift ?? 0) > 0) || (b.score ?? 0) - (a.score ?? 0) || legProb(b) - legProb(a);

/**
 * Mejor pick de cada partido para una lista «uno por partido»: se recorren todos los picks por orden (`cmp`) y se toma
 * el primero de cada partido cuya familia no haya llegado a `maxPerFamily`; así un mismo mercado no copa la lista.
 */
export function bestPerMatch<P extends { family: string }>(matches: { matchId: string; picks: P[] }[], cmp: (a: P, b: P) => number, maxPerFamily: number, limit = Infinity): { matchId: string; pick: P }[] {
  const all: { matchId: string; pick: P }[] = [];
  for (const m of matches) for (const pick of m.picks) all.push({ matchId: m.matchId, pick });
  all.sort((a, b) => cmp(a.pick, b.pick) || a.matchId.localeCompare(b.matchId));
  const out: { matchId: string; pick: P }[] = [];
  const used = new Set<string>();
  const perFamily = new Map<string, number>();
  for (const x of all) {
    if (out.length >= limit) break;
    if (used.has(x.matchId) || (perFamily.get(x.pick.family) ?? 0) >= maxPerFamily) continue;
    used.add(x.matchId);
    perFamily.set(x.pick.family, (perFamily.get(x.pick.family) ?? 0) + 1);
    out.push(x);
  }
  return out;
}

/**
 * Combinadas de un día: una pata por partido (nunca dos del mismo), primero las de lift positivo y luego por puntuación,
 * con como mucho COMBO_MAX_PER_FAMILY patas de la misma familia. Sin partidos suficientes, la combinada no se propone.
 */
export function buildCombos<P extends LegLike>(matches: { matchId: string; picks: P[] }[]): Combo<P>[] {
  const maxLegs = Math.max(...COMBO_DEFS.map((d) => d.legs));
  const legs = bestPerMatch(matches, cmpLeg, COMBO_MAX_PER_FAMILY, maxLegs);
  const out: Combo<P>[] = [];
  for (const def of COMBO_DEFS) {
    if (legs.length < def.minLegs) continue;
    const chosen = legs.slice(0, def.legs);
    const prob = chosen.reduce((p, l) => p * legProb(l.pick), 1);
    if (!(prob > 0)) continue;
    const combo: Combo<P> = { id: def.id, label: def.label, legs: chosen, prob, fairOdds: 1 / prob };
    if (chosen.every((l) => typeof l.pick.marketOdds === 'number' && l.pick.marketOdds > 1)) combo.marketOdds = chosen.reduce((o, l) => o * l.pick.marketOdds!, 1);
    out.push(combo);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Récord fuera de muestra de la regla de selección diaria (walk-forward mensual)
// ---------------------------------------------------------------------------

export interface DailySettledPick extends DailyEnginePick {
  matchId: string;
  compId: string;
  date: string;
  home: string;
  away: string;
  result: CandidateResult;
}

export interface ComboRecord {
  id: string;
  label: string;
  /** días en los que se pudo formar (partidos suficientes con pick) y se resolvió alguna pata */
  days: number;
  hits: number;
  hitRate: number;
  avgLegs: number;
  avgFairOdds: number;
}

export interface DailyWalkForward {
  /** picks de la regla diaria en los tramos (fuera de muestra) */
  picks: DailySettledPick[];
  /** partidos de los tramos */
  matches: number;
  from: string;
  to: string;
  overall: HitStats & { picks: number };
  byTheme: Partial<Record<ConfidenceTheme, HitStats & { picks: number; baseRate?: number }>>;
  byFamily: Partial<Record<ConfidenceFamily, HitStats & { picks: number }>>;
  combos: ComboRecord[];
  folds: { start: string; matches: number; picks: number; n: number; hits: number; hitRate: number }[];
}

function hitStats(rows: { prob: number; result: CandidateResult }[]): HitStats & { picks: number } {
  let n = 0;
  let hits = 0;
  let voids = 0;
  let sp = 0;
  for (const r of rows) {
    if (r.result === 'void') {
      voids++;
      continue;
    }
    n++;
    sp += r.prob;
    if (r.result === 'hit') hits++;
  }
  const [lo, hi] = wilsonInterval(hits, n, WILSON_Z90);
  return { picks: rows.length, n, hits, voids, hitRate: n ? hits / n : 0, wilsonLow: lo, wilsonHigh: hi, avgProb: n ? sp / n : 0 };
}

const candKey = (c: Pick<ConfidenceCandidate, 'family' | 'marketId' | 'selection'>) => `${c.family}|${c.marketId}|${c.selection}`;

function validationBefore(wf: WalkForwardResult, t: number, segmented: boolean): Map<string, RuleValidation> {
  return ruleValidation(
    wf.candidatePicks.filter((p) => Date.parse(p.date) < t),
    segmented,
  );
}

/**
 * Aplica la regla de selección diaria fuera de muestra: en cada tramo mensual, reglas publicadas de ese tramo
 * (existentes + adicionales, validadas con los tramos anteriores) y puntuación con el récord y las tasas base
 * anteriores al tramo. `base` y `extra` son los walk-forward de los dos conjuntos de familias sobre el MISMO historial
 * (mismos partidos y orden); `baseHistory` / `extraHistory` son esos historiales completos.
 */
export function dailyWalkForward(
  base: WalkForwardResult,
  extra: WalkForwardResult,
  baseHistory: ConfidenceHistoryItem[],
  extraHistory: ConfidenceHistoryItem[],
  timeZone: string,
  opts: DailySelectOptions = {},
): DailyWalkForward {
  const picks: DailySettledPick[] = [];
  const folds: DailyWalkForward['folds'] = [];
  const extraById = new Map(extraHistory.map((it) => [it.matchId, it]));
  const extraFoldByStart = new Map(extra.folds.map((f, k) => [f.start, k]));
  const starts = base.folds.map((f) => Date.parse(f.start));
  for (let k = 0; k < base.folds.length; k++) {
    const start = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : Infinity;
    const ek = extraFoldByStart.get(base.folds[k].start);
    const baseRules = base.foldRules[k].published;
    const rules = ek !== undefined ? mergeRules(baseRules, extra.foldRules[ek].published) : baseRules;
    const segmented = rules.options.segmented;
    const validation = new Map<string, OosRecord>([...validationBefore(base, start, segmented), ...validationBefore(extra, start, segmented)]);
    const prior = (h: ConfidenceHistoryItem[]) => h.filter((it) => Date.parse(it.date) < start);
    const sc: ScoreContext = { validation, baseRates: { ...familyBaseRates(prior(baseHistory)), ...familyBaseRates(prior(extraHistory)) } };
    const items = base.items.filter((it) => {
      const t = Date.parse(it.date);
      return t >= start && t < end;
    });
    const foldPicks: DailySettledPick[] = [];
    for (const it of items) {
      const cands = [...it.candidates, ...(extraById.get(it.matchId)?.candidates ?? [])];
      const results = new Map(cands.map((c) => [candKey(c), c.result]));
      for (const p of selectDailyPicks(cands, rules, sc, opts)) {
        const result = results.get(candKey(p));
        if (!result) continue;
        foldPicks.push({ ...p, matchId: it.matchId, compId: it.compId, date: it.date, home: it.home, away: it.away, result });
      }
    }
    const st = hitStats(foldPicks);
    folds.push({ start: base.folds[k].start, matches: items.length, picks: st.picks, n: st.n, hits: st.hits, hitRate: st.hitRate });
    picks.push(...foldPicks);
  }

  const group = <K extends string>(key: (p: DailySettledPick) => K) => {
    const map = new Map<K, DailySettledPick[]>();
    for (const p of picks) {
      const k = key(p);
      const arr = map.get(k);
      if (arr) arr.push(p);
      else map.set(k, [p]);
    }
    return map;
  };
  const byFamily: DailyWalkForward['byFamily'] = {};
  for (const [f, arr] of group((p) => p.family)) byFamily[f] = hitStats(arr);
  // tasa base de cada categoría: la de sus familias en los partidos de los tramos, ponderada por sus picks resueltos
  const itemIds = new Set(base.items.map((it) => it.matchId));
  const baseAll = { ...familyBaseRates(base.items), ...familyBaseRates(extraHistory.filter((it) => itemIds.has(it.matchId))) };
  const byTheme: DailyWalkForward['byTheme'] = {};
  for (const [theme, arr] of group((p) => p.theme)) {
    const st: HitStats & { picks: number; baseRate?: number } = hitStats(arr);
    let w = 0;
    let s = 0;
    for (const p of arr) {
      const b = baseAll[p.family];
      if (p.result === 'void' || !b || !(b.n > 0)) continue;
      w++;
      s += b.hitRate;
    }
    if (w > 0) st.baseRate = s / w;
    byTheme[theme] = st;
  }

  // combinadas: por día local, con los picks de la regla diaria de ese día
  const acc = new Map<string, { label: string; days: number; hits: number; legs: number; odds: number }>(COMBO_DEFS.map((d) => [d.id, { label: d.label, days: 0, hits: 0, legs: 0, odds: 0 }]));
  for (const dayPicks of group((p) => localDay(Date.parse(p.date), timeZone)).values()) {
    const byMatch = new Map<string, DailySettledPick[]>();
    for (const p of dayPicks) {
      const arr = byMatch.get(p.matchId);
      if (arr) arr.push(p);
      else byMatch.set(p.matchId, [p]);
    }
    for (const combo of buildCombos([...byMatch].map(([matchId, ps]) => ({ matchId, picks: ps })))) {
      const settled = combo.legs.filter((l) => l.pick.result !== 'void');
      if (!settled.length) continue; // todas las patas nulas: la apuesta se devuelve
      const a = acc.get(combo.id)!;
      a.days++;
      a.legs += combo.legs.length;
      a.odds += combo.fairOdds;
      if (settled.every((l) => l.pick.result === 'hit')) a.hits++;
    }
  }
  const combos: ComboRecord[] = [...acc]
    .filter(([, a]) => a.days > 0)
    .map(([id, a]) => ({ id, label: a.label, days: a.days, hits: a.hits, hitRate: a.hits / a.days, avgLegs: a.legs / a.days, avgFairOdds: a.odds / a.days }));

  const dates = base.items.map((it) => it.date).sort();
  return {
    picks,
    matches: base.items.length,
    from: dates[0] ?? '',
    to: dates[dates.length - 1] ?? '',
    overall: hitStats(picks),
    byTheme,
    byFamily,
    combos,
    folds,
  };
}
