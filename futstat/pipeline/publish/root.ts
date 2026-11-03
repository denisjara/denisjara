/**
 * Archivos raíz: players.json, value.json, home.json, model.json y meta.json.
 */
import type {
  BacktestSummary,
  CompetitionMeta,
  HomeFile,
  MatchSummary,
  MetaFile,
  ModelFile,
  PlayerSeasonRow,
  PlayersFile,
  ValueFile,
  ValuePick,
} from '../../src/types/data';
import { HOME_TIMEZONE, MODEL } from '../config';
import type { MatchRecord } from '../types';
import { mergeBacktests } from '../analytics/backtest';
import { homeHighlights } from '../analytics/insights';
import { buildPlayerSeasonRows } from '../analytics/players';
import { pickScore } from '../analytics/value';
import type { BuildContext } from './context';
import { matchSummary } from './matches';
import { methodologySections, modelParameters } from './methodology';
import { DAY_MS, localDay, nextDay } from './util';

export const GLOBAL_MAX_PLAYERS = 600;
export const GLOBAL_MIN_MINUTES = 270;
export const HOME_POPULAR = 24;
export const HOME_TOP_VALUE = 12;
export const HOME_HOT_PLAYERS = 12;
const H = 3_600_000;

// ---------------------------------------------------------------------------
// Jugadores (todas las competiciones)
// ---------------------------------------------------------------------------

/**
 * Filas de temporada de todos los jugadores (temporada actual de cada competición, todas juntas) ordenadas por forma.
 * compId = competición donde el jugador suma más minutos (desempate: tier).
 */
export function globalPlayerRows(ctx: BuildContext): PlayerSeasonRow[] {
  const rows = buildPlayerSeasonRows(ctx.currentLines, ctx.teamRefs, 'global');
  const minutesByComp = new Map<string, Map<string, number>>();
  for (const l of ctx.currentLines) {
    let m = minutesByComp.get(l.playerId);
    if (!m) minutesByComp.set(l.playerId, (m = new Map()));
    m.set(l.compId, (m.get(l.compId) ?? 0) + (l.minutes > 0 ? l.minutes : 0));
  }
  for (const r of rows) {
    const m = minutesByComp.get(r.player.id);
    let best = r.compId;
    let bestKey = -1;
    for (const [compId, mins] of m ?? []) {
      const key = mins * 100 + (ctx.configById.get(compId)?.tier ?? 0);
      if (key > bestKey) {
        best = compId;
        bestKey = key;
      }
    }
    r.compId = best;
  }
  return rows;
}

/**
 * Jugadores elegibles para los rankings globales: >= GLOBAL_MIN_MINUTES y competición principal que no sea una copa
 * (los equipos de categorías no cubiertas solo tienen datos de copa: 2-3 partidos que inflan su forma).
 */
export function rankablePlayers(ctx: BuildContext, rows: PlayerSeasonRow[]): PlayerSeasonRow[] {
  return rows.filter((r) => r.minutes >= GLOBAL_MIN_MINUTES && ctx.configById.get(r.compId)?.kind !== 'cup');
}

export function buildPlayersFile(ctx: BuildContext, rows: PlayerSeasonRow[]): PlayersFile {
  return { generatedAt: ctx.refDate, players: rankablePlayers(ctx, rows).slice(0, GLOBAL_MAX_PLAYERS) };
}

// ---------------------------------------------------------------------------
// Apuestas de valor
// ---------------------------------------------------------------------------

export function collectValueBets(ctx: BuildContext): { match: MatchSummary; pick: ValuePick }[] {
  const out: { match: MatchSummary; pick: ValuePick }[] = [];
  for (const id of ctx.upcomingIds) {
    const fp = ctx.predictions.get(id);
    const m = ctx.matchById.get(id);
    if (!fp || !m) continue;
    const s = matchSummary(ctx, m);
    for (const pick of fp.result.valueBets) out.push({ match: s, pick });
  }
  return out.sort((a, b) => b.pick.ev - a.pick.ev || Date.parse(a.match.date) - Date.parse(b.match.date));
}

export function buildValueFile(ctx: BuildContext, bets: { match: MatchSummary; pick: ValuePick }[]): ValueFile {
  return { generatedAt: ctx.refDate, bets, minEv: MODEL.minEv, kellyFraction: MODEL.kellyFraction };
}

// ---------------------------------------------------------------------------
// Portada
// ---------------------------------------------------------------------------

function publishedMatches(ctx: BuildContext): MatchRecord[] {
  const ids = new Set(ctx.publish.map((c) => c.id));
  return ctx.allMatches.filter((m) => ids.has(m.compId));
}

export function buildHomeFile(
  ctx: BuildContext,
  bets: { match: MatchSummary; pick: ValuePick }[],
  players: PlayerSeasonRow[],
  backtest: BacktestSummary | undefined,
): HomeFile {
  const now = ctx.now;
  const ms = publishedMatches(ctx);
  const today = localDay(now, HOME_TIMEZONE);
  const tomorrow = nextDay(today);
  const byDate = (a: MatchSummary, b: MatchSummary) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id);

  const popular = ms
    .filter((m) => (ctx.upcomingIds.has(m.id) || ctx.liveIds.has(m.id)) && Date.parse(m.date) <= now + 72 * H)
    .map((m) => matchSummary(ctx, m))
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || byDate(a, b))
    .slice(0, HOME_POPULAR);

  const dayOf = (m: MatchRecord) => localDay(Date.parse(m.date), HOME_TIMEZONE);
  const near = ms.filter((m) => m.status !== 'cancelled' && Math.abs(Date.parse(m.date) - now) <= 3 * DAY_MS);
  const todayList = near.filter((m) => dayOf(m) === today).map((m) => matchSummary(ctx, m)).sort(byDate);
  const tomorrowList = near.filter((m) => dayOf(m) === tomorrow).map((m) => matchSummary(ctx, m)).sort(byDate);

  const recent = ms
    .filter((m) => m.status === 'finished' && !!m.score && Date.parse(m.date) <= now && Date.parse(m.date) >= now - 48 * H)
    .map((m) => matchSummary(ctx, m))
    .sort((a, b) => byDate(b, a));

  const topValue = bets
    .filter((b) => Date.parse(b.match.date) <= now + 72 * H)
    .slice()
    .sort((a, b) => pickScore(b.pick, b.match.prediction?.confidence ?? 0.5) - pickScore(a.pick, a.match.prediction?.confidence ?? 0.5))
    .slice(0, HOME_TOP_VALUE);

  const hotPlayers = rankablePlayers(ctx, players).slice(0, HOME_HOT_PLAYERS);
  const modelHeadline = backtest && backtest.matches > 0
    ? {
        matches: backtest.matches,
        accuracy: backtest.model.accuracy,
        rps: backtest.model.rps,
        ...(backtest.market ? { marketRps: backtest.market.rps } : {}),
      }
    : undefined;

  const highlights = homeHighlights({
    today: todayList,
    popular,
    recent,
    topValue,
    hotPlayers,
    modelHeadline,
    upcomingCount: ctx.upcomingIds.size,
  });

  const file: HomeFile = {
    generatedAt: ctx.refDate,
    popular,
    today: todayList,
    tomorrow: tomorrowList,
    recent,
    topValue,
    hotPlayers,
    highlights,
  };
  if (modelHeadline) file.modelHeadline = modelHeadline;
  return file;
}

// ---------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------

export function emptyBacktest(): BacktestSummary {
  const z = { brier: 0, logLoss: 0, rps: 0, accuracy: 0 };
  return { matches: 0, from: '', to: '', model: { ...z }, baseline: { ...z }, calibration: [] };
}

export function aggregateBacktest(per: { compId: string; compName: string; backtest: BacktestSummary }[]): BacktestSummary | undefined {
  return mergeBacktests(per.map((p) => p.backtest));
}

export function buildModelFile(
  ctx: BuildContext,
  per: { compId: string; compName: string; backtest: BacktestSummary }[],
  backtest: BacktestSummary | undefined,
  counts: { competitions: number; teams: number; players: number; valueBets: number },
): ModelFile {
  return {
    generatedAt: ctx.refDate,
    sections: methodologySections({ ctx, backtest, ...counts }),
    backtest: backtest ?? emptyBacktest(),
    perCompetition: per,
    parameters: modelParameters(ctx),
  };
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export function buildMetaFile(
  ctx: BuildContext,
  competitions: CompetitionMeta[],
  teamIndex: MetaFile['teams'],
  counts: { players: number; valueBets: number },
  version: string,
): MetaFile {
  return {
    generatedAt: ctx.refDate,
    version,
    dataSource: 'ESPN (API pública)',
    competitions,
    counts: {
      matchesAnalyzed: ctx.suite.eloBuild.samples.length,
      upcomingMatches: ctx.upcomingIds.size,
      teams: teamIndex.length,
      players: counts.players,
      valueBets: counts.valueBets,
    },
    teams: teamIndex,
  };
}
