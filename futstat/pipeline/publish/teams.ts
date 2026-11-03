/**
 * TeamFile (public/data/teams/<id>.json) de cada equipo presente en ligas y competiciones continentales.
 */
import type { FormMatch, MatchSummary, PlayerSeasonRow, TeamFile } from '../../src/types/data';
import { round } from '../../src/lib/models';
import type { MatchRecord } from '../types';
import { buildFormBlock, toFormMatch } from '../analytics/form';
import { teamView } from '../analytics/teamStats';
import { competitionTeams, currentElo, isFinishedRecord, teamRef, type BuildContext } from './context';
import { matchSummary, teamStatsFor } from './matches';
import { enrichedStandings } from './standings';

/** Puntos del historial Elo publicados en la ficha de equipo. */
export const TEAM_ELO_HISTORY = 100;

/** Competiciones publicadas (temporada actual) de cada equipo, en el orden de la configuración. */
export function teamCompetitions(ctx: BuildContext): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of ctx.publish) {
    for (const t of competitionTeams(ctx, c.id)) {
      const arr = out.get(t);
      if (arr) arr.push(c.id);
      else out.set(t, [c.id]);
    }
  }
  return out;
}

/** Equipos con ficha: los que aparecen en ligas o competiciones continentales publicadas. */
export function teamsToPublish(ctx: BuildContext, comps: Map<string, string[]>): string[] {
  const out: string[] = [];
  for (const [team, list] of comps) {
    if (list.some((id) => ctx.configById.get(id)?.kind !== 'cup')) out.push(team);
  }
  return out.sort();
}

/** Competición principal: su liga doméstica si se publica; si no, la primera no-copa; si no, la primera. */
export function primaryCompetition(ctx: BuildContext, teamId: string, comps: string[]): string {
  const lg = ctx.suite.eloBuild.homeLeague.get(teamId);
  if (lg && comps.includes(lg)) return lg;
  return comps.find((id) => ctx.configById.get(id)?.kind === 'league') ?? comps.find((id) => ctx.configById.get(id)?.kind !== 'cup') ?? comps[0];
}

export function buildTeamFile(ctx: BuildContext, teamId: string, comps: string[], players: PlayerSeasonRow[]): TeamFile {
  const primaryCompId = primaryCompetition(ctx, teamId, comps);
  const elo = ctx.suite.eloBuild.elo;
  const history = elo.history(teamId);
  const all = ctx.matchesByTeam.get(teamId) ?? [];

  const upcomingRecords: MatchRecord[] = all.filter((m) => ctx.upcomingIds.has(m.id));
  const upcoming: MatchSummary[] = upcomingRecords.map((m) => matchSummary(ctx, m));
  const next = upcomingRecords[0];
  const venue: 'home' | 'away' = next && next.away.id === teamId ? 'away' : 'home';

  const matches: FormMatch[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    if (!m.currentSeason || !isFinishedRecord(m)) continue;
    const v = teamView(m, teamId, ctx.xg);
    if (v) matches.push(toFormMatch(v));
  }

  const form = buildFormBlock(teamId, all, history, venue, ctx.xg, {
    preElo: ctx.suite.eloBuild.preMatch,
    team: teamRef(ctx, teamId),
    currentElo: currentElo(ctx, teamId),
  });

  const file: TeamFile = {
    generatedAt: ctx.refDate,
    team: teamRef(ctx, teamId),
    competitions: comps,
    primaryCompId,
    elo: currentElo(ctx, teamId),
    globalEloRank: ctx.globalEloRank.get(teamId) ?? ctx.globalEloRank.size + 1,
    eloHistory: history.slice(-TEAM_ELO_HISTORY).map((h) => ({ date: h.date, elo: round(h.elo, 1) })),
    stats: teamStatsFor(ctx, teamId, primaryCompId),
    form,
    matches,
    upcoming,
    players: players.filter((p) => p.team.id === teamId),
  };
  const comp = ctx.configById.get(primaryCompId);
  if (comp) {
    for (const g of enrichedStandings(ctx, comp)) {
      const row = g.rows.find((r) => r.team.id === teamId);
      if (row) {
        file.standing = row;
        break;
      }
    }
  }
  return file;
}
