/**
 * CompetitionFile (public/data/competitions/<id>.json) y CompetitionMeta.
 */
import type {
  BacktestSummary,
  CompetitionFile,
  CompetitionMeta,
  PlayerSeasonRow,
  Prob1X2,
  TeamRating,
} from '../../src/types/data';
import { round } from '../../src/lib/models';
import type { CompetitionConfig } from '../config';
import type { MatchRecord } from '../types';
import { runBacktest, type BacktestItem } from '../analytics/backtest';
import { competitionInsights } from '../analytics/insights';
import { buildPlayerSeasonRows } from '../analytics/players';
import { MAX_EV } from '../analytics/value';
import {
  competitionTeams,
  currentElo,
  currentFinished,
  isFinishedRecord,
  storeDataUpdatedAt,
  teamRef,
  type BuildContext,
} from './context';
import { compAverages, compTeamStats, matchSummary, windowMatches } from './matches';
import { simulateCompetition } from './simulation';
import { enrichedStandings } from './standings';

/** Máximo de jugadores publicados por competición y minutos mínimos. */
export const COMP_MAX_PLAYERS = 150;
export const COMP_MIN_MINUTES = 90;
/** Partidos mínimos para publicar un backtest de competición. */
export const MIN_BACKTEST_MATCHES = 10;
/** Puntos del historial Elo publicados por equipo en la pestaña de ratings. */
export const RATING_HISTORY = 30;

export interface CompetitionBuild {
  file: CompetitionFile;
  meta: CompetitionMeta;
  /** partidos simulados (y cuántos se añadieron para completar el calendario) */
  stats: { simulatedFixtures: number; syntheticFixtures: number };
}

function closingOf(m: MatchRecord): BacktestItem['closing'] {
  const o = m.odds;
  if (!o || !(o.home! > 1) || !(o.draw! > 1) || !(o.away! > 1)) return undefined;
  return { home: o.home!, draw: o.draw!, away: o.away! };
}

/**
 * Frecuencias 1X2 de referencia (línea base del backtest): partidos de temporadas anteriores de la competición
 * (>= 100) o, si no hay bastantes, de todas las competiciones.
 */
export function baselineFor(ctx: BuildContext, compId: string): Prob1X2 {
  const freq = (ms: MatchRecord[]): Prob1X2 | undefined => {
    let h = 0;
    let d = 0;
    let a = 0;
    for (const m of ms) {
      if (!isFinishedRecord(m)) continue;
      if (m.score.home > m.score.away) h++;
      else if (m.score.home === m.score.away) d++;
      else a++;
    }
    const n = h + d + a;
    return n >= 100 ? { home: h / n, draw: d / n, away: a / n } : undefined;
  };
  const own = freq((ctx.matchesByComp.get(compId) ?? []).filter((m) => !m.currentSeason));
  if (own) return own;
  return freq(ctx.allMatches.filter((m) => !m.currentSeason)) ?? { home: 0.45, draw: 0.27, away: 0.28 };
}

/** Backtest walk-forward de la temporada actual de una competición (undefined si hay pocos partidos). */
export function competitionBacktest(ctx: BuildContext, compId: string): BacktestSummary | undefined {
  const items: BacktestItem[] = [];
  for (const m of currentFinished(ctx, compId)) {
    const wf = ctx.wf.get(m.id);
    if (!wf) continue;
    items.push({
      match: m,
      pred: {
        p: wf.p,
        over25: wf.over25,
        btts: wf.btts,
        sources: { elo: wf.sources.elo, dc: wf.sources.dc, market: wf.sources.market },
      },
      closing: closingOf(m),
    });
  }
  if (items.length < MIN_BACKTEST_MATCHES) return undefined;
  return runBacktest(items, baselineFor(ctx, compId), { maxEv: MAX_EV });
}

function ratingsFor(ctx: BuildContext, comp: CompetitionConfig, teamIds: string[]): TeamRating[] {
  const elo = ctx.suite.eloBuild.elo;
  const own = comp.kind === 'league' ? ctx.suite.dcModels.get(comp.id) : undefined;
  const rows = teamIds.map((id) => {
    const r: TeamRating = {
      team: teamRef(ctx, id),
      elo: currentElo(ctx, id),
      eloRank: 0,
      eloHistory: elo
        .history(id)
        .slice(-RATING_HISTORY)
        .map((h) => ({ date: h.date, elo: round(h.elo, 1) })),
    };
    const g = ctx.globalEloRank.get(id);
    if (g !== undefined) r.globalEloRank = g;
    const lg = ctx.suite.eloBuild.homeLeague.get(id);
    const model = own && own.attack[id] !== undefined ? own : lg ? ctx.suite.dcModels.get(lg) : undefined;
    if (model && model.attack[id] !== undefined && model.defence[id] !== undefined) {
      r.attack = round(model.attack[id], 3);
      r.defence = round(model.defence[id], 3);
    }
    return r;
  });
  rows.sort((a, b) => b.elo - a.elo || a.team.name.localeCompare(b.team.name, 'es'));
  rows.forEach((r, i) => (r.eloRank = i + 1));
  return rows;
}

/** Fecha ISO del próximo partido programado de la competición (aunque esté fuera de la ventana de 14 días). */
export function nextMatchDate(ctx: BuildContext, compId: string): string | undefined {
  let best: number | undefined;
  let iso: string | undefined;
  for (const m of ctx.matchesByComp.get(compId) ?? []) {
    if (m.status !== 'scheduled') continue;
    const t = Date.parse(m.date);
    if (!Number.isFinite(t) || t < ctx.now) continue;
    if (best === undefined || t < best) {
      best = t;
      iso = m.date;
    }
  }
  return iso;
}

/** Jugadores de la competición (temporada actual), ordenados por índice de forma. */
export function competitionPlayers(ctx: BuildContext, compId: string): PlayerSeasonRow[] {
  const lines = ctx.currentLines.filter((l) => l.compId === compId);
  if (!lines.length) return [];
  return buildPlayerSeasonRows(lines, ctx.teamRefs, compId);
}

export function buildCompetition(ctx: BuildContext, comp: CompetitionConfig): CompetitionBuild {
  const store = ctx.stores.get(comp.id);
  const fin = currentFinished(ctx, comp.id);
  const standings = enrichedStandings(ctx, comp);
  const win = windowMatches(ctx, comp.id);
  // resúmenes primero: dejan en caché las predicciones (λ) que reutiliza la simulación
  const upcoming = win.upcoming.map((m) => matchSummary(ctx, m));
  const live = win.live.map((m) => matchSummary(ctx, m));
  const results = win.results.map((m) => matchSummary(ctx, m));

  const teamStats = [...compTeamStats(ctx, comp.id).values()].sort((a, b) => a.team.name.localeCompare(b.team.name, 'es'));
  const leagueAverages = compAverages(ctx, comp.id);
  const ratings = ratingsFor(ctx, comp, competitionTeams(ctx, comp.id));
  const sim = simulateCompetition(ctx, comp, standings);
  const allPlayers = competitionPlayers(ctx, comp.id);
  const players = allPlayers.filter((p) => p.minutes >= COMP_MIN_MINUTES).slice(0, COMP_MAX_PLAYERS);
  const backtest = competitionBacktest(ctx, comp.id);
  const insights = competitionInsights(teamStats, leagueAverages, allPlayers, standings);

  const league = store?.league;
  const meta: CompetitionMeta = {
    id: comp.id,
    slug: comp.slug,
    name: comp.name,
    shortName: comp.shortName,
    country: comp.country,
    flag: comp.flag,
    kind: comp.kind,
    tier: comp.tier,
    hasTable: standings.length > 0,
    hasSimulation: sim.simulations.length > 0,
    upcomingCount: upcoming.length,
    finishedCount: fin.length,
  };
  if (league?.logo) meta.logo = league.logo;
  if (league?.logoDark) meta.logoDark = league.logoDark;
  if (league?.seasonLabel) meta.seasonLabel = league.seasonLabel;
  if (meta.hasSimulation) meta.simulationColumns = (comp.simulationZones ?? []).map((z) => z.label);
  const next = nextMatchDate(ctx, comp.id);
  if (next) meta.nextMatchDate = next;
  const dataAt = storeDataUpdatedAt(store, ctx.now);
  if (dataAt) meta.dataUpdatedAt = dataAt;

  const file: CompetitionFile = {
    generatedAt: ctx.refDate,
    meta,
    standings,
    upcoming,
    results,
    live,
    teams: teamStats,
    ratings,
    simulations: sim.simulations,
    players,
    leagueAverages,
    insights,
  };
  if (backtest) file.backtest = backtest;
  return { file, meta, stats: { simulatedFixtures: sim.fixtures, syntheticFixtures: sim.synthetic } };
}
