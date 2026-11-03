/**
 * Partidos: predicción completa (con proyecciones de estadísticas), ficha compacta MatchSummary y ficha de
 * análisis MatchFile (public/data/matches/<id>.json).
 *
 *  - Próximos / en vivo: modelos a la fecha del build.
 *  - Terminados: contexto "pre-partido" (Elo previo + Dixon-Coles walk-forward + proyecciones con datos anteriores),
 *    de modo que la predicción mostrada y `predictionHit` son las que el modelo habría dado antes del partido.
 */
import type {
  ComparisonRow,
  LeagueAverages,
  MatchEventPublic,
  MatchFile,
  MatchSummary,
  OddsSnapshot,
  PlayerProp,
  StatProjection,
  TeamMatchStatsPublic,
  TeamSeasonStats,
} from '../../src/types/data';
import { argmax3, mean, round } from '../../src/lib/models';
import { isPlausibleMargin, overroundOf, type CompetitionConfig } from '../config';
import { hasAnyPrice, stripImplausibleOdds } from '../oddsGuard';
import type { MatchRecord, PlayerLine, TeamMatchStats } from '../types';
import { predictMatch, type PredictionResult } from '../analytics/predict';
import { projectMatchStats } from '../analytics/projections';
import { toMatchSummary } from '../analytics/summary';
import { buildComparison, buildFormBlock, buildH2H } from '../analytics/form';
import { buildPlayerProps } from '../analytics/players';
import { popularityScore } from '../analytics/popularity';
import { computeLeagueAverages, computeTeamSeasonStats, formStringOf, teamView, type TeamView } from '../analytics/teamStats';
import {
  baseContext,
  currentFinished,
  isFinishedRecord,
  resultsFrom,
  statContext,
  teamRef,
  TEAM_WINDOW_DAYS,
  wfContext,
  type BuildContext,
  type FullPrediction,
} from './context';
import { enrichedStandings } from './standings';
import { DAY_MS, rp } from './util';

// ---------------------------------------------------------------------------
// Predicciones
// ---------------------------------------------------------------------------

function compOf(ctx: BuildContext, m: MatchRecord): CompetitionConfig {
  return ctx.configById.get(m.compId)!;
}

/** Predicciones de la caché calculadas con proyecciones de estadísticas. */
const projected = new WeakSet<FullPrediction>();

/** Predicción completa (cacheada). Terminados: contexto pre-partido; resto: modelos actuales. */
export function fullPrediction(ctx: BuildContext, m: MatchRecord, withProjections = true): FullPrediction {
  const cached = ctx.predictions.get(m.id);
  if (cached && (projected.has(cached) || !withProjections)) return cached;
  const comp = compOf(ctx, m);
  const finished = isFinishedRecord(m);
  const pctx = finished ? wfContext(ctx, m) : baseContext(ctx, comp);
  const projections = withProjections
    ? projectMatchStats(m.home.id, m.away.id, statContext(ctx, comp.id, finished ? Date.parse(m.date) : undefined))
    : [];
  // ESPN solo da la forma en partidos programados: en el resto se calcula con nuestros datos (antes del partido)
  const t = Date.parse(m.date);
  const rec: MatchRecord = {
    ...m,
    homeForm: m.homeForm ?? formBefore(ctx, m.home.id, t),
    awayForm: m.awayForm ?? formBefore(ctx, m.away.id, t),
  };
  const result: PredictionResult = predictMatch(rec, pctx, { projections });
  const fp: FullPrediction = { result, projections };
  if (withProjections) projected.add(fp);
  ctx.predictions.set(m.id, fp);
  return fp;
}

// ---------------------------------------------------------------------------
// MatchSummary
// ---------------------------------------------------------------------------

const PRICE_KEYS: (keyof OddsSnapshot)[] = [
  'home',
  'draw',
  'away',
  'homeOpen',
  'drawOpen',
  'awayOpen',
  'over',
  'under',
  'overOpen',
  'underOpen',
  'spreadHome',
  'spreadAway',
];

/** Copia de las cuotas sin precios inválidos (<= 1 o no finitos); undefined si no queda ningún precio. */
export function cleanOdds(o: OddsSnapshot | undefined): OddsSnapshot | undefined {
  if (!o) return undefined;
  const out: OddsSnapshot = { provider: o.provider || 'Casa de apuestas' };
  for (const k of PRICE_KEYS) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 1) (out as unknown as Record<string, number>)[k] = round(v, 3);
  }
  // Feed errors (impossible overround): the 1X2 trio / O-U pair is dropped, so one bad external price never makes the
  // validator reject the whole publication (store.ts already applies this on load: defence in depth).
  stripImplausibleOdds(out);
  if (!hasAnyPrice(out)) return undefined;
  if (typeof o.totalLine === 'number' && Number.isFinite(o.totalLine) && (out.over !== undefined || out.under !== undefined)) out.totalLine = o.totalLine;
  if (typeof o.spreadLine === 'number' && Number.isFinite(o.spreadLine)) out.spreadLine = o.spreadLine;
  if (out.home && out.draw && out.away) out.margin = round(overroundOf(out.home, out.draw, out.away)!, 4);
  else if (isPlausibleMargin(o.margin)) out.margin = round(o.margin, 4);
  if (o.capturedAt) out.capturedAt = o.capturedAt;
  return out;
}

/** Cadena de forma (últimos 5 resultados, cronológica) de un equipo antes de un instante, con nuestros datos. */
export function formBefore(ctx: BuildContext, teamId: string, before: number, n = 5): string | undefined {
  const views: TeamView[] = [];
  const list = ctx.matchesByTeam.get(teamId) ?? [];
  for (let i = list.length - 1; i >= 0 && views.length < n; i--) {
    const m = list[i];
    if (!isFinishedRecord(m) || !(Date.parse(m.date) < before)) continue;
    const v = teamView(m, teamId);
    if (v) views.unshift(v);
  }
  const s = formStringOf(views, n);
  return s || undefined;
}

/** Ficha compacta de un partido (cacheada). Incluye predicción para próximos, en vivo y resultados recientes. */
export function matchSummary(ctx: BuildContext, m: MatchRecord): MatchSummary {
  const cached = ctx.summaries.get(m.id);
  if (cached) return cached;
  const comp = compOf(ctx, m);
  const t = Date.parse(m.date);
  const extra: Partial<MatchSummary> = { hasDetail: ctx.detailIds.has(m.id) };
  const isPending = ctx.upcomingIds.has(m.id) || ctx.liveIds.has(m.id);
  const isRecentResult = isFinishedRecord(m) && m.currentSeason && t >= resultsFrom(ctx) && t <= ctx.now;
  if (isPending || isRecentResult || extra.hasDetail) {
    const fp = fullPrediction(ctx, m, !!extra.hasDetail);
    extra.prediction = fp.result.quick;
    if (isPending) {
      extra.popularity = popularityScore({
        compTier: comp.tier,
        eloHome: fp.result.model.elo.home,
        eloAway: fp.result.model.elo.away,
        eloP90: ctx.eloP90,
        pHome: fp.result.quick.p.home,
        pAway: fp.result.quick.p.away,
        hoursToKickoff: (t - ctx.now) / 3_600_000,
      });
    }
    if (isFinishedRecord(m)) {
      const outcome = m.score.home > m.score.away ? 0 : m.score.home === m.score.away ? 1 : 2;
      extra.predictionHit = argmax3(fp.result.quick.p) === outcome;
    }
  }
  const s = toMatchSummary(m, comp.name, extra);
  const odds = cleanOdds(m.odds);
  if (odds) s.odds = odds;
  else delete s.odds;
  if (!s.homeForm) {
    const f = formBefore(ctx, m.home.id, t);
    if (f) s.homeForm = f;
  }
  if (!s.awayForm) {
    const f = formBefore(ctx, m.away.id, t);
    if (f) s.awayForm = f;
  }
  ctx.summaries.set(m.id, s);
  return s;
}

/** Ficha compacta de un partido arbitrario (H2H...) con hasDetail coherente con los archivos publicados. */
export function withDetailFlag(ctx: BuildContext, s: MatchSummary): MatchSummary {
  const cached = ctx.summaries.get(s.id);
  if (cached) return cached;
  return { ...s, hasDetail: ctx.detailIds.has(s.id) };
}

// ---------------------------------------------------------------------------
// Estadística de temporada y medias (cacheadas por competición)
// ---------------------------------------------------------------------------

export function compTeamStats(ctx: BuildContext, compId: string): Map<string, TeamSeasonStats> {
  let m = ctx.compStats.get(compId);
  if (!m) {
    m = new Map(computeTeamSeasonStats(currentFinished(ctx, compId), { xg: ctx.xg }).map((s) => [s.team.id, s]));
    ctx.compStats.set(compId, m);
  }
  return m;
}

export function compAverages(ctx: BuildContext, compId: string): LeagueAverages {
  let a = ctx.compAverages.get(compId);
  if (!a) {
    a = computeLeagueAverages(currentFinished(ctx, compId));
    ctx.compAverages.set(compId, a);
  }
  return a;
}

/** Estadísticas vacías (equipo sin partidos terminados). */
export function emptyTeamStats(ctx: BuildContext, teamId: string): TeamSeasonStats {
  const z = { all: 0, home: 0, away: 0 };
  return {
    team: teamRef(ctx, teamId),
    played: { ...z },
    goalsFor: { ...z },
    goalsAgainst: { ...z },
    xgFor: { ...z },
    xgAgainst: { ...z },
    shots: { ...z },
    shotsAgainst: { ...z },
    shotsOnTarget: { ...z },
    shotsOnTargetAgainst: { ...z },
    corners: { ...z },
    cornersAgainst: { ...z },
    cards: { ...z },
    cardsAgainst: { ...z },
    fouls: { ...z },
    possession: { ...z },
    over15Pct: 0,
    over25Pct: 0,
    over35Pct: 0,
    bttsPct: 0,
    cleanSheetPct: 0,
    failedToScorePct: 0,
    winPct: 0,
    drawPct: 0,
    lossPct: 0,
    formString: '',
    formIndex: 50,
  };
}

/**
 * Estadística de temporada "representativa" de un equipo: la de la competición si es liga; si no, la de su liga
 * doméstica; si no, la de la competición; si no, la de todos sus partidos de la temporada actual.
 */
export function teamStatsFor(ctx: BuildContext, teamId: string, compId?: string): TeamSeasonStats {
  const comp = compId ? ctx.configById.get(compId) : undefined;
  if (comp?.kind === 'league') {
    const s = compTeamStats(ctx, comp.id).get(teamId);
    if (s) return s;
  }
  const lg = ctx.suite.eloBuild.homeLeague.get(teamId);
  if (lg && ctx.configById.has(lg)) {
    const s = compTeamStats(ctx, lg).get(teamId);
    if (s) return s;
  }
  if (comp) {
    const s = compTeamStats(ctx, comp.id).get(teamId);
    if (s) return s;
  }
  const own = (ctx.matchesByTeam.get(teamId) ?? []).filter((m) => m.currentSeason && isFinishedRecord(m));
  const rows = computeTeamSeasonStats(own, { xg: ctx.xg });
  return rows.find((r) => r.team.id === teamId) ?? emptyTeamStats(ctx, teamId);
}

/** Medias de referencia para comparar: la competición si tiene >= 20 partidos; si no, la liga doméstica del local. */
function averagesFor(ctx: BuildContext, m: MatchRecord): LeagueAverages {
  const own = compAverages(ctx, m.compId);
  if (currentFinished(ctx, m.compId).length >= 20) return own;
  for (const team of [m.home.id, m.away.id]) {
    const lg = ctx.suite.eloBuild.homeLeague.get(team);
    if (lg && ctx.configById.has(lg) && currentFinished(ctx, lg).length >= 20) return compAverages(ctx, lg);
  }
  return own;
}

// ---------------------------------------------------------------------------
// Props de jugadores
// ---------------------------------------------------------------------------

function cardsOfStats(s: TeamMatchStats | undefined): number | undefined {
  if (!s || s.yellow === undefined) return undefined;
  return s.yellow + (s.red ?? 0);
}

function propsFor(
  ctx: BuildContext,
  teamId: string,
  opponentId: string,
  side: 'home' | 'away',
  lambda: number,
  projections: StatProjection[],
  before: number,
): PlayerProp[] {
  const from = before - TEAM_WINDOW_DAYS * DAY_MS;
  const lines: PlayerLine[] = (ctx.linesByTeam.get(teamId) ?? []).filter((l) => {
    const t = Date.parse(l.date);
    return t < before && t >= from;
  });
  if (!lines.length) return [];
  // medias del equipo en los partidos cubiertos por las líneas (mismo periodo que las tasas de los jugadores)
  const goals: number[] = [];
  const shots: number[] = [];
  const sot: number[] = [];
  const cards: number[] = [];
  const fouls: number[] = [];
  for (const id of new Set(lines.map((l) => l.matchId))) {
    const m = ctx.matchById.get(id);
    if (!m || !isFinishedRecord(m)) continue;
    const isHome = m.home.id === teamId;
    goals.push(isHome ? m.score.home : m.score.away);
    const st = isHome ? m.stats?.home : m.stats?.away;
    if (st?.shots !== undefined) shots.push(st.shots);
    if (st?.shotsOnTarget !== undefined) sot.push(st.shotsOnTarget);
    const c = cardsOfStats(st);
    if (c !== undefined) cards.push(c);
    if (st?.fouls !== undefined) fouls.push(st.fouls);
  }
  const factor = (key: StatProjection['key'], hist: number[]) => {
    const p = projections.find((x) => x.key === key);
    const avg = mean(hist);
    if (!p || hist.length < 3 || !(avg > 0)) return 1;
    return p[side] / avg;
  };
  return buildPlayerProps({
    teamId,
    opponentId,
    lines,
    teamLambda: lambda,
    teamAvgGoals: goals.length ? mean(goals) : lambda,
    oppShotsFactor: factor('shots', shots),
    oppSotFactor: factor('shotsOnTarget', sot),
    cardsFactor: factor('cards', cards),
    foulsFactor: factor('fouls', fouls),
  });
}

// ---------------------------------------------------------------------------
// Estadísticas reales y eventos
// ---------------------------------------------------------------------------

const PUBLIC_STAT_KEYS: (keyof TeamMatchStatsPublic)[] = [
  'shots',
  'shotsOnTarget',
  'corners',
  'fouls',
  'yellow',
  'red',
  'offsides',
  'possession',
  'saves',
  'passes',
  'passPct',
  'tackles',
];

function publicStats(goals: number, s: TeamMatchStats | undefined): TeamMatchStatsPublic {
  const out: TeamMatchStatsPublic = { goals };
  if (!s) return out;
  for (const k of PUBLIC_STAT_KEYS) {
    const v = s[k as keyof TeamMatchStats];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) (out as unknown as Record<string, number>)[k] = v;
  }
  return out;
}

function publicEvents(ctx: BuildContext, m: MatchRecord): MatchEventPublic[] {
  const names = new Map<string, string>();
  for (const l of ctx.linesByMatch.get(m.id) ?? []) names.set(l.playerId, l.name);
  const evs = [...(m.events ?? [])].sort((a, b) => a.minute - b.minute);
  return evs.map((e) => {
    const ev: MatchEventPublic = { minute: e.clock || `${e.minute}'`, type: e.type, teamId: e.teamId };
    const player = e.player ?? (e.playerId ? names.get(e.playerId) : undefined);
    if (player) ev.player = player;
    if (e.playerId) ev.playerId = e.playerId;
    if (e.type === 'sub' && e.playerOutId) {
      const out = names.get(e.playerOutId);
      ev.detail = out ? `Sale ${out}` : 'Cambio';
    } else if (e.type === 'penalty') ev.detail = 'De penalti';
    else if (e.type === 'own-goal') ev.detail = 'En propia puerta';
    return ev;
  });
}

// ---------------------------------------------------------------------------
// MatchFile
// ---------------------------------------------------------------------------

/** Redondea a 4 decimales la matriz de marcadores y las distribuciones de las proyecciones (tamaño del JSON). */
function compactProjections(ps: StatProjection[]): StatProjection[] {
  return ps.map((p) => {
    const dist = p.totalDist.map(rp);
    // recorta ceros finales (la masa ya está plegada en la cola por projections.ts)
    let end = dist.length;
    while (end > 1 && dist[end - 1] === 0) end--;
    return { ...p, totalDist: dist.slice(0, end) };
  });
}

export function buildMatchFile(ctx: BuildContext, m: MatchRecord): MatchFile {
  const { result, projections } = fullPrediction(ctx, m, true);
  const summary = matchSummary(ctx, m);
  const comp = compOf(ctx, m);
  const t = Date.parse(m.date);
  const elo = ctx.suite.eloBuild.elo;
  const preElo = ctx.suite.eloBuild.preMatch;
  const homeMatches = ctx.matchesByTeam.get(m.home.id) ?? [];
  const awayMatches = ctx.matchesByTeam.get(m.away.id) ?? [];
  const formHome = buildFormBlock(m.home.id, homeMatches, elo.history(m.home.id), 'home', ctx.xg, {
    preElo,
    before: m.date,
    team: m.home,
    currentElo: result.model.elo.home,
    detailIds: ctx.detailIds,
  });
  const formAway = buildFormBlock(m.away.id, awayMatches, elo.history(m.away.id), 'away', ctx.xg, {
    preElo,
    before: m.date,
    team: m.away,
    currentElo: result.model.elo.away,
    detailIds: ctx.detailIds,
  });
  const h2h = buildH2H(homeMatches, m.home.id, m.away.id, ctx.compNames, { before: m.date, excludeId: m.id, limit: 10 });
  h2h.matches = h2h.matches.map((s) => withDetailFlag(ctx, s));

  const comparison: ComparisonRow[] = buildComparison(
    teamStatsFor(ctx, m.home.id, comp.id),
    teamStatsFor(ctx, m.away.id, comp.id),
    averagesFor(ctx, m),
  );

  const file: MatchFile = {
    generatedAt: ctx.refDate,
    match: summary,
    model: {
      ...result.model,
      scoreMatrix: result.model.scoreMatrix.map((row) => row.map(rp)),
    },
    markets: result.markets,
    projections: compactProjections(projections),
    form: { home: formHome, away: formAway },
    h2h,
    comparison,
    players: {
      home: propsFor(ctx, m.home.id, m.away.id, 'home', result.lambdaHome, projections, t),
      away: propsFor(ctx, m.away.id, m.home.id, 'away', result.lambdaAway, projections, t),
    },
    valueBets: result.valueBets,
  };

  // clasificación: grupo con ambos equipos (o con el local / visitante)
  const groups = enrichedStandings(ctx, comp);
  if (groups.length) {
    const has = (g: (typeof groups)[number], id: string) => g.rows.some((r) => r.team.id === id);
    const g =
      groups.find((x) => has(x, m.home.id) && has(x, m.away.id)) ??
      groups.find((x) => has(x, m.home.id)) ??
      groups.find((x) => has(x, m.away.id));
    if (g) {
      const table: NonNullable<MatchFile['table']> = { group: g.name, rows: g.rows };
      const hr = g.rows.find((r) => r.team.id === m.home.id)?.rank;
      const ar = g.rows.find((r) => r.team.id === m.away.id)?.rank;
      if (hr !== undefined) table.homeRank = hr;
      if (ar !== undefined) table.awayRank = ar;
      file.table = table;
    }
  }

  if ((m.status === 'finished' || m.status === 'live') && m.score) {
    if (m.stats || m.status === 'finished') {
      file.actual = { home: publicStats(m.score.home, m.stats?.home), away: publicStats(m.score.away, m.stats?.away) };
    }
    const evs = publicEvents(ctx, m);
    if (evs.length) file.events = evs;
  }
  return file;
}

/** Ids de partidos de una competición en cada ventana publicada. */
export function windowMatches(ctx: BuildContext, compId: string): { upcoming: MatchRecord[]; results: MatchRecord[]; live: MatchRecord[] } {
  const list = ctx.matchesByComp.get(compId) ?? [];
  const from = resultsFrom(ctx);
  const upcoming = list.filter((m) => ctx.upcomingIds.has(m.id));
  const live = list.filter((m) => ctx.liveIds.has(m.id));
  const results = list
    .filter((m) => isFinishedRecord(m) && m.currentSeason && Date.parse(m.date) >= from && Date.parse(m.date) <= ctx.now)
    .reverse();
  return { upcoming, results, live };
}
