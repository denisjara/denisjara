/**
 * Guardas del pipeline añadidas tras la revisión adversarial:
 *  - estados incoherentes con la fecha (PIPE-09), cuotas con margen imposible (PIPE-03),
 *  - jugadores sin nombre (PIPE-14) y props coherentes (PIPE-13),
 *  - puerta de calidad del almacén en CI: encogimiento respecto al almacén restaurado (R4-04).
 */
import { describe, expect, it } from 'vitest';
import { coherentStatus } from '../pipeline/publish/context';
import { stripImplausibleOdds } from '../pipeline/oddsGuard';
import { normalizeScoreboard, normalizeSummary } from '../pipeline/espn/normalize';
import { buildPlayerProps } from '../pipeline/analytics/players';
import { shrinkProblems } from '../scripts/check-store';
import type { MatchRecord, PlayerLine } from '../pipeline/types';
import { NOW, comp, fixture } from './espn/helpers';

const H = 3_600_000;
const rec = (over: Partial<MatchRecord>): MatchRecord => ({
  id: '1',
  compId: 'premier',
  season: 2026,
  currentSeason: true,
  date: '2026-11-01T15:00:00Z',
  status: 'finished',
  home: { id: 'a', name: 'A', short: 'A', abbr: 'A' },
  away: { id: 'b', name: 'B', short: 'B', abbr: 'B' },
  score: { home: 1, away: 0 },
  ...over,
});

describe('coherentStatus (PIPE-09)', () => {
  const now = Date.parse('2026-11-03T18:00:00Z');
  it('un "en juego" de hace días se publica como pendiente, sin marcador ni minuto', () => {
    const m = coherentStatus(rec({ status: 'live', statusDetail: "67'", date: '2026-10-25T16:30:00Z' }), now);
    expect(m.status).toBe('scheduled');
    expect(m.score).toBeUndefined();
    expect(m.statusDetail).toBeUndefined();
  });
  it('un "terminado" en el futuro no entra en los modelos', () => {
    const m = coherentStatus(rec({ date: '2026-11-06T20:00:00Z', stats: { home: { goals: 3 }, away: { goals: 0 } } }), now);
    expect(m.status).toBe('scheduled');
    expect(m.score).toBeUndefined();
    expect(m.stats).toBeUndefined();
  });
  it('los estados normales no cambian (mismo objeto)', () => {
    const live = rec({ status: 'live', date: new Date(now - 1 * H).toISOString() });
    expect(coherentStatus(live, now)).toBe(live);
    const fin = rec({});
    expect(coherentStatus(fin, now)).toBe(fin);
  });
});

describe('stripImplausibleOdds (PIPE-03)', () => {
  it('quita solo el mercado con margen imposible y conserva el resto', () => {
    const s = { provider: 'DK', home: 1.01, draw: 2, away: 2, margin: 0.99, over: 1.9, under: 1.9, totalLine: 2.5 };
    expect(stripImplausibleOdds(s)).toEqual(['1x2']);
    expect(s).toEqual({ provider: 'DK', over: 1.9, under: 1.9, totalLine: 2.5 });
    const arb = { provider: 'DK', home: 5, draw: 5, away: 5 };
    expect(stripImplausibleOdds(arb)).toEqual(['1x2']);
    const real = { provider: 'DK', home: 2.1, draw: 3.4, away: 3.6 };
    expect(stripImplausibleOdds(real)).toEqual([]);
    expect(real.home).toBe(2.1);
  });
});

describe('jugadores (PIPE-13 / PIPE-14)', () => {
  it('un jugador sin nombre utilizable se publica como "Jugador <id>"', () => {
    const match = normalizeScoreboard(fixture('scoreboard-laliga-2026.json'), comp('laliga'), { now: NOW }).matches.find((x) => x.id === '401882846')!;
    const raw = fixture('summary-laliga-401882846.json') as { rosters: { roster: { athlete: { displayName?: string; shortName?: string; id: string } }[] }[] };
    const victim = raw.rosters[0].roster[0];
    victim.athlete.displayName = '<>';
    delete victim.athlete.shortName;
    const res = normalizeSummary(raw, match);
    const line = res.players.find((p) => p.playerId === victim.athlete.id)!;
    expect(line.name).toBe(`Jugador ${victim.athlete.id}`);
    expect(res.players.every((p) => p.name.trim() !== '')).toBe(true);
  });

  const lines: PlayerLine[] = [];
  for (let i = 0; i < 10; i++) {
    const date = new Date(Date.UTC(2026, 8, 1 + i * 7)).toISOString();
    const base = { matchId: `m${i}`, compId: 'laliga', date, teamId: 'T', opponentId: `O${i}`, isHome: i % 2 === 0, starter: true, minutes: 90, assists: 0, yellow: 0, red: 0, foulsCommitted: 1, foulsSuffered: 1, offsides: 0, ownGoals: 0 };
    lines.push({ ...base, playerId: 'p1', name: 'Delantero', short: 'D.', position: 'F', goals: 1, shots: 2, shotsOnTarget: 2 });
    lines.push({ ...base, playerId: 'gk', name: 'Portero', short: 'P.', position: 'G', goals: i < 2 ? 2 : 0, shots: 0, shotsOnTarget: 0, saves: 3, goalsConceded: 2 });
  }
  it('P(≥1 a puerta) nunca supera P(≥1 tiro) aunque los factores del rival sean dispares', () => {
    for (const [sf, tf] of [[1, 1], [0.8, 1.3], [0.6, 1.6]]) {
      const props = buildPlayerProps({ teamId: 'T', opponentId: 'X', lines, teamLambda: 1.5, teamAvgGoals: 1.5, oppShotsFactor: sf, oppSotFactor: tf, cardsFactor: 1, foulsFactor: 1 });
      for (const p of props) {
        expect(p.pSot1).toBeLessThanOrEqual(p.pShots1 + 1e-9);
        expect(p.pSot2).toBeLessThanOrEqual(p.pShots2 + 1e-9);
      }
    }
  });
  it('los "goles" de un portero sin tiros (goles encajados mal atribuidos) no inflan su P(gol)', () => {
    const props = buildPlayerProps({ teamId: 'T', opponentId: 'X', lines, teamLambda: 1.5, teamAvgGoals: 1.5, oppShotsFactor: 1, oppSotFactor: 1, cardsFactor: 1, foulsFactor: 1 });
    expect(props.find((p) => p.player.id === 'gk')!.pGoal).toBeLessThan(0.01);
  });
});

describe('puerta de calidad del almacén (R4-04)', () => {
  const before = { laliga: { matches: 1000, players: 9000, standingRows: 20 }, nueva: { matches: 5, players: 0, standingRows: 0 } };
  it('un almacén vaciado, recortado o desaparecido no pasa', () => {
    expect(shrinkProblems(before, { laliga: { matches: 0, players: 0, standingRows: 0 } }).join('\n')).toMatch(/laliga: matches ha bajado de 1000 a 0/);
    expect(shrinkProblems(before, { laliga: { matches: 700, players: 9000, standingRows: 20 }, nueva: before.nueva })).toHaveLength(1);
    expect(shrinkProblems(before, {}).join('\n')).toMatch(/laliga: el almacén ha desaparecido/);
  });
  it('crecer, mantenerse o podas pequeñas pasan; competiciones diminutas no se comparan', () => {
    expect(shrinkProblems(before, { laliga: { matches: 1010, players: 9100, standingRows: 20 }, nueva: { matches: 1, players: 0, standingRows: 0 } })).toEqual([]);
    expect(shrinkProblems(before, { laliga: { matches: 950, players: 8800, standingRows: 20 }, nueva: { matches: 5, players: 0, standingRows: 0 } })).toEqual([]);
  });
});
