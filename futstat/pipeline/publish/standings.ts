/**
 * Clasificación publicada: la de ESPN (o, en ligas sin tabla publicada, la calculada desde los partidos)
 * enriquecida con forma (últimos 5 de la competición), xPts (puntos esperados con λ pre-partido) y Elo actual.
 */
import type { StandingGroup, StandingRow } from '../../src/types/data';
import { round } from '../../src/lib/models';
import type { CompetitionConfig } from '../config';
import { computeStandingsFromMatches, computeXPts, formStringOf, viewsByTeam } from '../analytics/teamStats';
import { currentElo, currentFinished, type BuildContext } from './context';

export function enrichedStandings(ctx: BuildContext, comp: CompetitionConfig): StandingGroup[] {
  const cached = ctx.compStandings.get(comp.id);
  if (cached) return cached;
  const fin = currentFinished(ctx, comp.id);
  let groups: StandingGroup[] = (ctx.stores.get(comp.id)?.standings ?? []).filter((g) => g?.rows?.length);
  if (!groups.length && comp.kind === 'league' && fin.length) {
    groups = [computeStandingsFromMatches(fin, { name: comp.name })];
  }
  const views = viewsByTeam(fin);
  const xpts = computeXPts(fin, ctx.xg);
  const out: StandingGroup[] = groups.map((g) => ({
    name: g.name || comp.name,
    rows: [...g.rows]
      .filter((r) => r?.team?.id)
      .sort((a, b) => a.rank - b.rank)
      .map((r) => {
        const id = r.team.id;
        const ref = ctx.teamRefs.get(id);
        const row: StandingRow = {
          rank: r.rank,
          team: ref ? { ...r.team, ...ref } : r.team,
          played: r.played,
          won: r.won,
          drawn: r.drawn,
          lost: r.lost,
          gf: r.gf,
          ga: r.ga,
          gd: r.gd,
          points: r.points,
        };
        const form = formStringOf(views.get(id) ?? [], 5) || r.form;
        if (form) row.form = form;
        if (r.note?.label) row.note = { label: r.note.label, color: r.note.color || '#94a3b8' };
        const x = xpts.get(id);
        if (x !== undefined && Number.isFinite(x)) row.xPts = round(x, 1);
        if (ctx.suite.eloBuild.elo.has(id)) row.elo = Math.round(currentElo(ctx, id));
        return row;
      }),
  }));
  ctx.compStandings.set(comp.id, out);
  return out;
}
