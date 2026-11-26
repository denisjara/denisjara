/**
 * Ventana prev del banco (temporadas pasadas): la liga doméstica de cada equipo debe ser la de ESA temporada. La
 * asignación actual (homeLeague de producción) delataría los ascensos y descensos de final de temporada, es decir,
 * información posterior al partido predicho (fuga en el walk-forward). En producción (sin pastSeasonsFrom) no cambia.
 */
import { describe, expect, it } from 'vitest';
import type { CompetitionConfig } from '../../pipeline/config';
import type { CompetitionStore, MatchRecord } from '../../pipeline/types';
import { createContext, homeLeagueFor, wfContext } from '../../pipeline/publish/context';

const A: CompetitionConfig = { id: 'liga-a', slug: 'syn.1', name: 'Liga A', shortName: 'A', country: 'Sintetia', flag: '🏳️', kind: 'league', tier: 1 };
const B: CompetitionConfig = { id: 'liga-b', slug: 'syn.2', name: 'Liga B', shortName: 'B', country: 'Sintetia', flag: '🏳️', kind: 'league', tier: 2 };
const C: CompetitionConfig = { id: 'copa-s', slug: 'syn.copa', name: 'Copa S', shortName: 'Copa', country: 'Sintetia', flag: '🏳️', kind: 'cup', tier: 5 };
const team = (id: string) => ({ id, name: id, short: id, abbr: id.slice(0, 3) });

let n = 1;
function match(compId: string, date: string, h: string, a: string, season: number, current: boolean): MatchRecord {
  return {
    id: String(9000 + n++),
    compId,
    season,
    currentSeason: current,
    date,
    status: 'finished',
    home: team(h),
    away: team(a),
    score: { home: n % 3, away: (n + 1) % 2 },
  };
}

/** Temporada 2025 (pasada): A0..A3 en A, B0..B3 en B. Temporada 2026 (actual): B0 sube y A3 baja; N0 llega de fuera. */
function world(): { stores: CompetitionStore[]; cupPast: MatchRecord } {
  const ms: Record<string, MatchRecord[]> = { [A.id]: [], [B.id]: [], [C.id]: [] };
  const rr = (comp: string, ts: string[], season: number, current: boolean, from: number) => {
    let d = from;
    for (const h of ts)
      for (const a of ts) {
        if (h === a) continue;
        ms[comp].push(match(comp, new Date(d).toISOString(), h, a, season, current));
        d += 7 * 86_400_000;
      }
  };
  rr(A.id, ['A0', 'A1', 'A2', 'A3'], 2025, false, Date.UTC(2025, 7, 16, 15));
  rr(B.id, ['B0', 'B1', 'B2', 'B3'], 2025, false, Date.UTC(2025, 7, 16, 18));
  rr(A.id, ['A0', 'A1', 'A2', 'B0'], 2026, true, Date.UTC(2026, 7, 15, 15));
  rr(B.id, ['A3', 'B1', 'B2', 'N0'], 2026, true, Date.UTC(2026, 7, 15, 18));
  const cupPast = match(C.id, '2026-02-11T20:00:00Z', 'B0', 'A3', 2025, false);
  ms[C.id].push(cupPast);
  const store = (c: CompetitionConfig): CompetitionStore => ({ compId: c.id, slug: c.slug, updatedAt: '2026-11-20T00:00:00Z', matches: ms[c.id], players: [], standings: [] });
  return { stores: [store(A), store(B), store(C)], cupPast };
}

describe('liga doméstica en temporadas pasadas (ventana prev, sin fuga)', () => {
  const { stores, cupPast } = world();
  const configs = [A, B, C];
  const now = new Date('2026-11-20T00:00:00Z');

  it('producción: la asignación actual, sin cambios', () => {
    const ctx = createContext({ stores, configs, now });
    expect(homeLeagueFor(ctx, cupPast)).toBe(ctx.suite.eloBuild.homeLeague);
    expect(ctx.suite.eloBuild.homeLeague.get('B0')).toBe(A.id);
    expect(wfContext(ctx, cupPast).homeLeague).toBe(ctx.suite.eloBuild.homeLeague);
  });

  it('banco: un partido de la temporada pasada ve la liga de ESA temporada (ni el ascenso ni el descenso posteriores)', () => {
    const ctx = createContext({ stores, configs, now, pastSeasonsFrom: '2026-01-01T00:00:00Z' });
    const hl = homeLeagueFor(ctx, cupPast);
    expect(hl.get('B0')).toBe(B.id);
    expect(hl.get('A3')).toBe(A.id);
    expect(hl.has('N0')).toBe(false);
    expect(wfContext(ctx, cupPast).homeLeague).toBe(hl);
    // la temporada actual sigue con la asignación de producción
    const cur = stores[0].matches.find((m) => m.currentSeason)!;
    expect(homeLeagueFor(ctx, cur)).toBe(ctx.suite.eloBuild.homeLeague);
  });
});
