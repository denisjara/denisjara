/**
 * Contexto compartido del build: índices de partidos/equipos/jugadores, modelos ajustados a la fecha actual
 * (Elo global, Dixon-Coles por liga, Elo→goles), modelos Dixon-Coles walk-forward y predicciones "pre-partido"
 * de los partidos ya jugados de la temporada actual.
 *
 * Sin fuga de información en el backtest: Elo pre-partido, Dixon-Coles re-ajustado cada semana con partidos
 * anteriores y, por competición, parámetros de empate del Elo, coeficientes Elo→goles y medias de goles ajustados
 * SOLO con partidos anteriores al inicio de la temporada evaluada (ctx.preSeason). Lo único que usa información
 * posterior es la asignación de liga doméstica de cada equipo (homeLeague), que solo decide qué modelo se usa.
 */
import type {
  LeagueAverages,
  MatchSummary,
  Prob1X2,
  StandingGroup,
  StatProjection,
  TeamRef,
  TeamSeasonStats,
} from '../../src/types/data';
import { fitEloDrawParams, type DCModel } from '../../src/lib/models';
import { MODEL, RESULTS_DAYS, UPCOMING_DAYS, type CompetitionConfig } from '../config';
import type { CompetitionStore, MatchRecord, PlayerLine } from '../types';
import {
  buildModelSuite,
  fitEloGoalModel,
  isNationalTeamComp,
  leagueAverageGoals,
  type EloDrawParams,
  type EloGoalCoeffs,
  type ModelSuite,
} from '../analytics/ratings';
import { contextFor, predictProbsOnly, type PredictContext, type PredictionResult, type ProbsOnlyResult } from '../analytics/predict';
import { walkForwardDC } from '../analytics/backtest';
import { eloPercentile } from '../analytics/popularity';
import { buildStatContext, type StatContext } from '../analytics/projections';
import type { XgMap } from '../analytics/teamStats';
import { DAY_MS, pushTo } from './util';

/** Partidos programados cuya hora de inicio pasó hace menos de esto siguen contando como próximos. */
export const UPCOMING_GRACE_MS = 3 * 3_600_000;
/** Días de partidos terminados con ficha de análisis completa. */
export const DETAIL_FINISHED_DAYS = 3;
/** Ventana (días) de partidos de cada equipo usada para estadísticas de partido, props y medias. */
export const TEAM_WINDOW_DAYS = 365;

export interface BuildOptions {
  stores: CompetitionStore[];
  configs: CompetitionConfig[];
  now: Date;
  /** competiciones a publicar (por defecto todas las que tienen store); los modelos usan siempre todos los stores */
  only?: string[];
  /** menos iteraciones (simulación, re-ajustes walk-forward) para depurar */
  fast?: boolean;
  log?: (msg: string) => void;
}

export interface WfPrediction {
  p: Prob1X2;
  over25: number;
  btts: number;
  lambdaHome: number;
  lambdaAway: number;
  sources: ProbsOnlyResult['sources'];
}

export interface FullPrediction {
  result: PredictionResult;
  projections: StatProjection[];
}

/** Parámetros ajustados solo con partidos anteriores al inicio de una temporada (backtest sin fuga). */
export interface PreSeasonParams {
  /** instante de corte (ms): inicio de la temporada evaluada */
  cutoff: number;
  drawParams: EloDrawParams;
  eloGoal: EloGoalCoeffs;
  leagueAvgGoals: Map<string, number>;
  /** partidos terminados anteriores al corte usados en el ajuste */
  samples: number;
}

/** Partidos mínimos anteriores al corte para ajustar parámetros propios (si no, se usan los actuales). */
export const PRESEASON_MIN_SAMPLES = 300;

export interface BuildContext {
  now: number;
  refDate: string;
  fast: boolean;
  log: (msg: string) => void;
  configs: CompetitionConfig[];
  configById: Map<string, CompetitionConfig>;
  stores: Map<string, CompetitionStore>;
  /** competiciones publicadas (con store), en el orden de la configuración */
  publish: CompetitionConfig[];
  suite: ModelSuite;
  /** todos los partidos (sin duplicados), cronológicos */
  allMatches: MatchRecord[];
  matchById: Map<string, MatchRecord>;
  /** partidos de cada competición (sin duplicados), cronológicos */
  matchesByComp: Map<string, MatchRecord[]>;
  /** partidos de cada equipo (todas las competiciones y estados), cronológicos */
  matchesByTeam: Map<string, MatchRecord[]>;
  teamRefs: Map<string, TeamRef>;
  linesByTeam: Map<string, PlayerLine[]>;
  linesByMatch: Map<string, PlayerLine[]>;
  /** líneas de jugador de partidos de la temporada actual de su competición */
  currentLines: PlayerLine[];
  compNames: Map<string, string>;
  /** ranking Elo: clubes entre clubes (1..N) y selecciones nacionales entre selecciones (1..M) */
  globalEloRank: Map<string, number>;
  /** equipos que solo juegan competiciones de selecciones */
  nationalTeams: Set<string>;
  /** tamaño de cada ranking (posición por defecto de un equipo sin partidos = tamaño + 1) */
  rankPool: { clubs: number; national: number };
  eloP90: number;
  /** competición → parámetros ajustados antes del inicio de su temporada actual (backtest sin fuga) */
  preSeason: Map<string, PreSeasonParams>;
  /** liga → (id de partido → modelo DC walk-forward) */
  wfModels: Map<string, Map<string, DCModel>>;
  /** liga → modelos walk-forward en orden cronológico (fecha del primer partido que lo usó) */
  wfTimeline: Map<string, { t: number; model: DCModel }[]>;
  /** predicción pre-partido (walk-forward) de cada partido terminado de la temporada actual */
  wf: Map<string, WfPrediction>;
  /** λ pre-partido de los partidos terminados (proxy de xG) */
  xg: XgMap;
  upcomingIds: Set<string>;
  liveIds: Set<string>;
  /** partidos con ficha public/data/matches/<id>.json */
  detailIds: Set<string>;
  // ---- cachés rellenadas durante el build
  predictions: Map<string, FullPrediction>;
  summaries: Map<string, MatchSummary>;
  statContexts: Map<string, StatContext>;
  compStats: Map<string, Map<string, TeamSeasonStats>>;
  compAverages: Map<string, LeagueAverages>;
  compStandings: Map<string, StandingGroup[]>;
  baseContexts: Map<string, PredictContext>;
}

// ---------------------------------------------------------------------------
// Predicados de ventana
// ---------------------------------------------------------------------------

export function isUpcoming(m: MatchRecord, now: number): boolean {
  if (m.status !== 'scheduled') return false;
  const t = Date.parse(m.date);
  return t >= now - UPCOMING_GRACE_MS && t < now + UPCOMING_DAYS * DAY_MS;
}

export function isFinishedWithin(m: MatchRecord, now: number, days: number): boolean {
  if (m.status !== 'finished' || !m.score) return false;
  const t = Date.parse(m.date);
  return t <= now && t >= now - days * DAY_MS;
}

export function isFinishedRecord(m: MatchRecord): m is MatchRecord & { score: NonNullable<MatchRecord['score']> } {
  return m.status === 'finished' && !!m.score && Number.isFinite(m.score.home) && Number.isFinite(m.score.away);
}

/** A match still "live" this long after kickoff is a stale snapshot (the run that would have finished it failed). */
export const STALE_LIVE_MS = 4 * 3_600_000;
/** Tolerance for a "finished" match whose kickoff is (slightly) in the future (time zones, rescheduling). */
export const FUTURE_FINISHED_TOLERANCE_MS = 3_600_000;

/**
 * Status coherent with the reference time: a "live" match from hours/days ago is published as pending (no score,
 * no live clock) instead of "En juego 67'" for days, and a "finished" match in the future (impossible) as scheduled
 * without score/stats/events, so it never enters the models. Returns the same object when nothing changes.
 */
export function coherentStatus(m: MatchRecord, now: number): MatchRecord {
  const t = Date.parse(m.date);
  const staleLive = m.status === 'live' && t < now - STALE_LIVE_MS;
  const futureFinished = m.status === 'finished' && t > now + FUTURE_FINISHED_TOLERANCE_MS;
  if (!staleLive && !futureFinished) return m;
  const out: MatchRecord = { ...m, status: 'scheduled' };
  delete out.statusDetail;
  delete out.score;
  delete out.stats;
  delete out.events;
  delete out.summaryFetched;
  return out;
}

/** Last successful download of a competition (fetchedAt; older stores: updatedAt), never after `now`. */
export function storeDataUpdatedAt(store: CompetitionStore | undefined, now: number): string | undefined {
  const iso = store?.fetchedAt ?? store?.updatedAt;
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t) || t <= 0) return undefined;
  return new Date(Math.min(t, now)).toISOString();
}

// ---------------------------------------------------------------------------
// Construcción
// ---------------------------------------------------------------------------

function richer(a: MatchRecord, b: MatchRecord): MatchRecord {
  const score = (m: MatchRecord) => (m.summaryFetched ? 4 : 0) + (m.stats ? 2 : 0) + (m.events?.length ? 1 : 0);
  return score(b) > score(a) ? b : a;
}

function betterRef(a: TeamRef | undefined, b: TeamRef): TeamRef {
  if (!a) return b;
  const sc = (t: TeamRef) => (t.logo ? 2 : 0) + (t.color ? 1 : 0) + (t.short && t.short !== t.name ? 1 : 0);
  return sc(b) >= sc(a) ? { ...a, ...b } : { ...b, ...a };
}

/** Ids aptos para nombres de archivo publicados (ESPN usa números; cualquier otra cosa se descarta). */
const SAFE_ID = /^[A-Za-z0-9_-]{1,32}$/;
const safeId = (x: unknown): x is string => typeof x === 'string' && SAFE_ID.test(x);

export function createContext(opts: BuildOptions): BuildContext {
  const log = opts.log ?? (() => {});
  const now = opts.now.getTime();
  const refDate = opts.now.toISOString();
  const configById = new Map(opts.configs.map((c) => [c.id, c]));
  const stores = new Map<string, CompetitionStore>();
  // estados incoherentes con la fecha de referencia (en juego de hace días, terminado en el futuro): ver coherentStatus
  let incoherent = 0;
  for (const s of opts.stores) {
    if (!configById.has(s.compId)) continue;
    const matches = s.matches.map((m) => {
      const c = coherentStatus(m, now);
      if (c !== m) incoherent++;
      return c;
    });
    stores.set(s.compId, { ...s, matches });
  }
  if (incoherent) log(`  aviso: ${incoherent} partidos con estado incoherente con la fecha (en juego de hace horas o terminados en el futuro) se publican como pendientes`);
  const only = opts.only?.length ? new Set(opts.only) : undefined;
  const publish = opts.configs.filter((c) => stores.has(c.id) && (!only || only.has(c.id)));

  // ---- partidos
  const matchById = new Map<string, MatchRecord>();
  const matchesByComp = new Map<string, MatchRecord[]>();
  for (const s of stores.values()) {
    const seen = new Map<string, MatchRecord>();
    for (const m of s.matches) {
      if (!m || !safeId(m.id) || !safeId(m.home?.id) || !safeId(m.away?.id) || !Number.isFinite(Date.parse(m.date))) continue;
      const prev = seen.get(m.id);
      seen.set(m.id, prev ? richer(prev, m) : m);
    }
    const list = [...seen.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id));
    matchesByComp.set(s.compId, list);
    for (const m of list) {
      const prev = matchById.get(m.id);
      matchById.set(m.id, prev ? richer(prev, m) : m);
    }
  }
  const allMatches = [...matchById.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id));
  const matchesByTeam = new Map<string, MatchRecord[]>();
  const teamRefs = new Map<string, TeamRef>();
  for (const m of allMatches) {
    pushTo(matchesByTeam, m.home.id, m);
    pushTo(matchesByTeam, m.away.id, m);
    teamRefs.set(m.home.id, betterRef(teamRefs.get(m.home.id), m.home));
    teamRefs.set(m.away.id, betterRef(teamRefs.get(m.away.id), m.away));
  }
  for (const s of stores.values()) {
    for (const g of s.standings ?? []) for (const r of g.rows ?? []) if (safeId(r?.team?.id) && !teamRefs.has(r.team.id)) teamRefs.set(r.team.id, r.team);
  }

  // ---- jugadores
  const lineSeen = new Set<string>();
  const allLines: PlayerLine[] = [];
  for (const s of stores.values()) {
    for (const l of s.players ?? []) {
      if (!l || !safeId(l.playerId) || !safeId(l.matchId) || !safeId(l.teamId)) continue;
      const k = `${l.matchId}:${l.playerId}`;
      if (lineSeen.has(k)) continue;
      lineSeen.add(k);
      allLines.push(l);
    }
  }
  allLines.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.matchId.localeCompare(b.matchId));
  const linesByTeam = new Map<string, PlayerLine[]>();
  const linesByMatch = new Map<string, PlayerLine[]>();
  const currentLines: PlayerLine[] = [];
  for (const l of allLines) {
    pushTo(linesByTeam, l.teamId, l);
    pushTo(linesByMatch, l.matchId, l);
    if (matchById.get(l.matchId)?.currentSeason) currentLines.push(l);
  }

  // ---- modelos a fecha actual
  const suite = buildModelSuite([...stores.values()], opts.configs, refDate);
  const ratings = suite.eloBuild.elo.ratings();
  // selecciones: equipos que solo aparecen en competiciones de selecciones (fuera del ranking de clubes)
  const nationalComps = new Set(opts.configs.filter((c) => isNationalTeamComp(c)).map((c) => c.id));
  const nationalTeams = new Set<string>();
  for (const [team, list] of matchesByTeam) if (list.length && list.every((m) => nationalComps.has(m.compId))) nationalTeams.add(team);
  const ranked = Object.entries(ratings)
    .filter(([team]) => (suite.eloBuild.gamesByTeam.get(team) ?? 0) > 0)
    .sort((a, b) => b[1] - a[1]);
  const clubs = ranked.filter(([team]) => !nationalTeams.has(team));
  const nationals = ranked.filter(([team]) => nationalTeams.has(team));
  const globalEloRank = new Map<string, number>();
  clubs.forEach(([team], i) => globalEloRank.set(team, i + 1));
  nationals.forEach(([team], i) => globalEloRank.set(team, i + 1));

  const upcomingIds = new Set<string>();
  const liveIds = new Set<string>();
  const detailIds = new Set<string>();
  const publishIds = new Set(publish.map((c) => c.id));
  for (const m of allMatches) {
    if (!publishIds.has(m.compId)) continue;
    if (isUpcoming(m, now)) upcomingIds.add(m.id);
    else if (m.status === 'live') liveIds.add(m.id);
    if (upcomingIds.has(m.id) || liveIds.has(m.id) || isFinishedWithin(m, now, DETAIL_FINISHED_DAYS)) detailIds.add(m.id);
  }

  return {
    now,
    refDate,
    fast: !!opts.fast,
    log,
    configs: opts.configs,
    configById,
    stores,
    publish,
    suite,
    allMatches,
    matchById,
    matchesByComp,
    matchesByTeam,
    teamRefs,
    linesByTeam,
    linesByMatch,
    currentLines,
    compNames: new Map(opts.configs.map((c) => [c.id, c.name])),
    globalEloRank,
    nationalTeams,
    rankPool: { clubs: clubs.length, national: nationals.length },
    eloP90: eloPercentile(clubs.map(([, r]) => r), 0.9),
    preSeason: new Map(),
    wfModels: new Map(),
    wfTimeline: new Map(),
    wf: new Map(),
    xg: new Map(),
    upcomingIds,
    liveIds,
    detailIds,
    predictions: new Map(),
    summaries: new Map(),
    statContexts: new Map(),
    compStats: new Map(),
    compAverages: new Map(),
    compStandings: new Map(),
    baseContexts: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Contextos de predicción
// ---------------------------------------------------------------------------

/** Contexto de predicción "actual" (modelos a la fecha del build) de una competición. */
export function baseContext(ctx: BuildContext, comp: CompetitionConfig): PredictContext {
  let c = ctx.baseContexts.get(comp.id);
  if (!c) {
    c = contextFor(ctx.suite, comp, ctx.configById);
    ctx.baseContexts.set(comp.id, c);
  }
  return c;
}

/** Último modelo walk-forward de una liga usado en o antes del instante t (sin fuga: se ajustó con datos anteriores). */
export function wfModelAt(ctx: BuildContext, leagueId: string, t: number): DCModel | undefined {
  const tl = ctx.wfTimeline.get(leagueId);
  if (!tl?.length || tl[0].t > t) return undefined;
  let lo = 0;
  let hi = tl.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tl[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return tl[lo].model;
}

/**
 * Contexto "pre-partido" de un partido ya jugado: Elo pre-partido (de buildElo) y modelos Dixon-Coles
 * walk-forward de la propia liga y de las ligas domésticas de ambos equipos a la fecha del partido.
 */
export function wfContext(ctx: BuildContext, m: MatchRecord): PredictContext {
  const comp = ctx.configById.get(m.compId)!;
  const base = baseContext(ctx, comp);
  const t = Date.parse(m.date);
  const dc = new Map<string, DCModel>();
  if (comp.kind === 'league') {
    const own = ctx.wfModels.get(comp.id)?.get(m.id) ?? wfModelAt(ctx, comp.id, t);
    if (own) dc.set(comp.id, own);
  }
  for (const team of [m.home.id, m.away.id]) {
    const lg = ctx.suite.eloBuild.homeLeague.get(team);
    if (!lg || dc.has(lg)) continue;
    const mod = wfModelAt(ctx, lg, t);
    if (mod) dc.set(lg, mod);
  }
  const pre = m.currentSeason ? ctx.preSeason.get(comp.id) : undefined;
  if (pre && t >= pre.cutoff) {
    return { ...base, dcModels: dc, drawParams: pre.drawParams, eloGoal: pre.eloGoal, leagueAvgGoals: pre.leagueAvgGoals };
  }
  return { ...base, dcModels: dc };
}

/**
 * Parámetros "de pretemporada" a un instante de corte: empates del Elo (fitEloDrawParams), medias de goles por
 * competición y modelo Elo→goles (con los Dixon-Coles walk-forward vigentes en el corte), usando solo partidos
 * anteriores al corte. undefined si hay menos de PRESEASON_MIN_SAMPLES partidos.
 */
export function preSeasonParams(ctx: BuildContext, cutoff: number): PreSeasonParams | undefined {
  const samples = ctx.suite.eloBuild.samples.filter((s) => Date.parse(s.date) < cutoff);
  if (samples.length < PRESEASON_MIN_SAMPLES) return undefined;
  const calib = samples.filter((s) => s.calibrated);
  const drawParams = fitEloDrawParams((calib.length >= 200 ? calib : samples).map((s) => ({ diff: s.diff, outcome: s.outcome })));
  const leagueAvgGoals = leagueAverageGoals([...ctx.stores.values()], new Date(cutoff).toISOString());
  const dcAt = new Map<string, DCModel>();
  for (const lg of ctx.wfTimeline.keys()) {
    const mod = wfModelAt(ctx, lg, cutoff);
    if (mod) dcAt.set(lg, mod);
  }
  const eloGoal = fitEloGoalModel(samples, ctx.suite.eloBuild.homeLeague, leagueAvgGoals, dcAt);
  return { cutoff, drawParams, eloGoal, leagueAvgGoals, samples: samples.length };
}

/**
 * Ajusta los Dixon-Coles walk-forward de cada liga (desde el inicio más temprano de las temporadas actuales, para
 * cubrir también copas y competiciones continentales) y calcula la predicción pre-partido de todos los partidos
 * terminados de la temporada actual. Rellena ctx.wfModels, ctx.wfTimeline, ctx.wf y ctx.xg.
 */
export function computeWalkForward(ctx: BuildContext): { refits: number; predictions: number } {
  let from = Infinity;
  for (const list of ctx.matchesByComp.values()) {
    for (const m of list) if (m.currentSeason && isFinishedRecord(m)) from = Math.min(from, Date.parse(m.date));
  }
  let refits = 0;
  if (Number.isFinite(from)) {
    const fromIso = new Date(from).toISOString();
    for (const comp of ctx.configs) {
      if (comp.kind !== 'league') continue;
      const list = ctx.matchesByComp.get(comp.id);
      if (!list?.length) continue;
      const models = walkForwardDC(list, MODEL.dcXi, ctx.fast ? 14 : 7, { from: fromIso, maxIter: ctx.fast ? 60 : 120 });
      ctx.wfModels.set(comp.id, models);
      const timeline: { t: number; model: DCModel }[] = [];
      for (const m of list) {
        const mod = models.get(m.id);
        if (!mod) continue;
        if (timeline.length && timeline[timeline.length - 1].model === mod) continue;
        timeline.push({ t: Date.parse(m.date), model: mod });
      }
      refits += timeline.length;
      ctx.wfTimeline.set(comp.id, timeline);
    }
  }
  // parámetros sin fuga por competición: corte = primer partido terminado de su temporada actual (por día)
  const byCutoff = new Map<number, PreSeasonParams | undefined>();
  for (const [compId, list] of ctx.matchesByComp) {
    if (!ctx.configById.has(compId)) continue;
    let first = Infinity;
    for (const m of list) if (m.currentSeason && isFinishedRecord(m)) first = Math.min(first, Date.parse(m.date));
    if (!Number.isFinite(first)) continue;
    const day = Math.floor(first / DAY_MS) * DAY_MS;
    if (!byCutoff.has(day)) byCutoff.set(day, preSeasonParams(ctx, day));
    const p = byCutoff.get(day);
    if (p) ctx.preSeason.set(compId, p);
  }
  let n = 0;
  for (const [compId, list] of ctx.matchesByComp) {
    if (!ctx.configById.has(compId)) continue;
    for (const m of list) {
      if (!m.currentSeason || !isFinishedRecord(m) || ctx.wf.has(m.id)) continue;
      const r = predictProbsOnly(m, wfContext(ctx, m));
      if (![r.p.home, r.p.draw, r.p.away, r.lambdaHome, r.lambdaAway].every(Number.isFinite)) continue;
      ctx.wf.set(m.id, { p: r.p, over25: r.over25, btts: r.btts, lambdaHome: r.lambdaHome, lambdaAway: r.lambdaAway, sources: r.sources });
      ctx.xg.set(m.id, { home: r.lambdaHome, away: r.lambdaAway });
      n++;
    }
  }
  return { refits, predictions: n };
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

/** Partidos de la temporada actual de una competición (todos los estados). */
export function currentMatches(ctx: BuildContext, compId: string): MatchRecord[] {
  return (ctx.matchesByComp.get(compId) ?? []).filter((m) => m.currentSeason);
}

/** Partidos terminados de la temporada actual de una competición. */
export function currentFinished(ctx: BuildContext, compId: string): MatchRecord[] {
  return currentMatches(ctx, compId).filter(isFinishedRecord);
}

/** Equipos de la temporada actual de una competición (partidos de cualquier estado + clasificación). */
export function competitionTeams(ctx: BuildContext, compId: string): string[] {
  const set = new Set<string>();
  for (const m of currentMatches(ctx, compId)) {
    if (m.status === 'cancelled') continue;
    set.add(m.home.id);
    set.add(m.away.id);
  }
  for (const g of ctx.stores.get(compId)?.standings ?? []) for (const r of g.rows ?? []) if (safeId(r?.team?.id)) set.add(r.team.id);
  return [...set];
}

export function teamRef(ctx: BuildContext, id: string): TeamRef {
  return ctx.teamRefs.get(id) ?? { id, name: id, short: id, abbr: id.slice(0, 3).toUpperCase() };
}

/** Elo actual (redondeado a 1 decimal) de un equipo; el inicial por defecto si no ha jugado. */
export function currentElo(ctx: BuildContext, team: string): number {
  return Math.round(ctx.suite.eloBuild.elo.get(team) * 10) / 10;
}

/**
 * Contexto de estadísticas (córners, tarjetas, tiros...) de una competición: partidos terminados de su temporada
 * actual + partidos de sus equipos (cualquier competición) de los últimos TEAM_WINDOW_DAYS días. Con `before`
 * solo usa partidos anteriores (fichas de partidos ya jugados). Cacheado por competición y día.
 */
export function statContext(ctx: BuildContext, compId: string, before?: number): StatContext {
  const cutoff = before ?? ctx.now + 1;
  const dayKey = before === undefined ? 'now' : String(Math.floor(before / DAY_MS));
  const key = `${compId}|${dayKey}`;
  let sc = ctx.statContexts.get(key);
  if (sc) return sc;
  const limit = before === undefined ? cutoff : Math.floor(before / DAY_MS) * DAY_MS;
  const from = limit - TEAM_WINDOW_DAYS * DAY_MS;
  const pool = new Map<string, MatchRecord>();
  for (const m of currentMatches(ctx, compId)) {
    if (isFinishedRecord(m) && Date.parse(m.date) < limit) pool.set(m.id, m);
  }
  for (const team of competitionTeams(ctx, compId)) {
    for (const m of ctx.matchesByTeam.get(team) ?? []) {
      if (!isFinishedRecord(m)) continue;
      const t = Date.parse(m.date);
      if (t >= from && t < limit) pool.set(m.id, m);
    }
  }
  sc = buildStatContext([...pool.values()], compId);
  ctx.statContexts.set(key, sc);
  return sc;
}

/** Fecha de inicio (ms) de la ventana de resultados publicados. */
export function resultsFrom(ctx: BuildContext): number {
  return ctx.now - RESULTS_DAYS * DAY_MS;
}
