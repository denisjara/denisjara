import { describe, expect, it } from 'vitest';
import { mapPosition, normalizeScoreboard, normalizeSummary, summaryHasContent } from '../../pipeline/espn/normalize';
import type { MatchRecord, PlayerLine } from '../../pipeline/types';
import { NOW, comp, fixture } from './helpers';

function matchFrom(sbFixture: string, compId: string, id: string): MatchRecord {
  const m = normalizeScoreboard(fixture(sbFixture), comp(compId), { now: NOW }).matches.find((x) => x.id === id);
  if (!m) throw new Error(`no match ${id}`);
  return m;
}

const byName = (players: PlayerLine[], name: string) => {
  const p = players.find((x) => x.name === name);
  if (!p) throw new Error(`no player ${name}`);
  return p;
};

describe('normalizeSummary · Betis 2-5 Barcelona', () => {
  const match = matchFrom('scoreboard-laliga-2026.json', 'laliga', '401882846');
  const res = normalizeSummary(fixture('summary-laliga-401882846.json'), match);

  it('extended boxscore stats', () => {
    expect(res.stats?.home).toEqual({
      goals: 2,
      shots: 6,
      shotsOnTarget: 5,
      corners: 2,
      fouls: 10,
      yellow: 3,
      red: 1,
      offsides: 1,
      possession: 30.7,
      saves: 5,
      passes: 324,
      passPct: 0.79, // 256 / 324
      crosses: 6,
      tackles: 17,
      interceptions: 14,
      clearances: 20,
      blockedShots: 1,
    });
    expect(res.stats?.away).toMatchObject({ goals: 5, shots: 18, passes: 751, passPct: 0.923, saves: 3 });
  });

  it('half-time, neutral flag and extra-time detection', () => {
    expect(res.ht).toEqual({ home: 1, away: 2 });
    expect(res.neutral).toBe(false);
    expect(res.extraTime).toBe(false);
    expect(res.pens).toBeUndefined();
  });

  it('key events incl. substitutions with the player going off', () => {
    const subs = res.events!.filter((e) => e.type === 'sub');
    expect(subs).toHaveLength(10);
    expect(subs[0]).toEqual({ minute: 45, clock: "45'", type: 'sub', teamId: '83', playerId: '128714', player: 'Eric García', playerOutId: '312015' });
    expect(res.events!.filter((e) => e.type === 'goal')).toHaveLength(7);
    expect(res.events!.filter((e) => e.type === 'red')).toHaveLength(1);
  });

  it('closing odds from pickcenter', () => {
    expect(res.closingOdds).toMatchObject({
      provider: 'DraftKings',
      home: 6.5, // +550
      draw: 5.5, // +450
      away: 1.408, // -245
      homeOpen: 4.3, // +330
      awayOpen: 1.526, // -190
      totalLine: 3.5,
      over: 1.625, // -160
      under: 2.3, // +130
      spreadLine: 1.5,
      spreadHome: 1.769, // -130
      spreadAway: 1.909, // -110
      capturedAt: '2026-10-17T16:30:00Z',
    });
    expect(res.closingOdds!.margin).toBeCloseTo(1 / 6.5 + 1 / 5.5 + 1 / 1.408 - 1, 3);
  });

  it('player lines with minutes from substitutions and red cards', () => {
    const ps = res.players;
    expect(ps).toHaveLength(32); // 22 starters + 10 substitutes used; unused subs excluded
    expect(ps.some((p) => p.name === 'Marc Roca')).toBe(false);
    expect(new Set(ps.map((p) => p.matchId))).toEqual(new Set(['401882846']));

    const valles = byName(ps, 'Álvaro Valles');
    expect(valles).toMatchObject({ teamId: '244', opponentId: '83', isHome: true, position: 'G', starter: true, minutes: 90, saves: 5, goalsConceded: 5 });
    expect(byName(ps, 'Héctor Bellerín')).toMatchObject({ position: 'D', minutes: 70, yellow: 1 });
    expect(byName(ps, 'Dani Ceballos').minutes).toBe(45); // off at half-time
    expect(byName(ps, 'Facundo Bernal')).toMatchObject({ minutes: 54, red: 1 }); // sent off
    expect(byName(ps, 'Nelson Deossa')).toMatchObject({ starter: false, minutes: 45, position: '?' });
    expect(byName(ps, 'Gavi')).toMatchObject({ isHome: false, teamId: '83', opponentId: '244', minutes: 11 });
    const yamal = byName(ps, 'Lamine Yamal');
    expect(yamal).toMatchObject({ goals: 1, assists: 1, minutes: 70, position: 'M', short: 'L. Yamal', compId: 'laliga', date: '2026-10-17T16:30:00Z' });
    // outfield players carry no goalkeeper fields
    expect(yamal.saves).toBeUndefined();
    expect(yamal.goalsConceded).toBeUndefined();
    // goals of the player lines add up to the score
    expect(ps.filter((p) => p.isHome).reduce((n, p) => n + p.goals, 0)).toBe(2);
    expect(ps.filter((p) => !p.isHome).reduce((n, p) => n + p.goals, 0)).toBe(5);
    expect(summaryHasContent(res)).toBe(true);
  });
});

describe('normalizeSummary · extra time + penalties (Tordesillas 3-3 Mirandés)', () => {
  const match = matchFrom('scoreboard-copadelrey-2026.json', 'copadelrey', '401928509');
  const res = normalizeSummary(fixture('summary-copadelrey-401928509.json'), match);

  it('detects extra time: full time = 120', () => {
    expect(res.extraTime).toBe(true);
    expect(res.pens).toEqual({ home: 2, away: 4 });
    expect(res.ht).toEqual({ home: 2, away: 0 });
    const full = res.players.filter((p) => p.starter && p.minutes === 120);
    expect(full.length).toBeGreaterThan(5);
    expect(res.players.every((p) => p.minutes >= 1 && p.minutes <= 120)).toBe(true);
  });

  it('minutes of starters and substitutes', () => {
    const ps = res.players;
    expect(byName(ps, 'Farolo')).toMatchObject({ position: 'G', starter: true, minutes: 35 });
    // substitute goalkeeper: position inferred from goalkeeper stats, on at 35' -> 85'
    expect(byName(ps, 'Jon Arrasate Barbarin')).toMatchObject({ position: 'G', starter: false, minutes: 85 });
    expect(byName(ps, 'Aritz Arambarri')).toMatchObject({ starter: true, minutes: 103 });
    expect(byName(ps, 'Dani Díez').minutes).toBe(90); // off at the start of extra time
    expect(byName(ps, 'Abraham Rodríguez').minutes).toBe(30); // on at 90'
    expect(byName(ps, 'Marcos Gracia').minutes).toBe(17); // on at 103'
  });
});

describe('normalizeSummary · penalties without extra time (Tranmere 2-2 Rochdale)', () => {
  const match = matchFrom('scoreboard-carabao-2026.json', 'carabao', '401877066');
  const res = normalizeSummary(fixture('summary-carabao-401877066.json'), match);

  it('no extra time: full time = 90', () => {
    expect(res.extraTime).toBe(false);
    expect(Math.max(...res.players.map((p) => p.minutes))).toBe(90);
  });

  it('sub on and off, and stoppage-time subs get at least 1 minute', () => {
    expect(byName(res.players, 'Casey Pettit')).toMatchObject({ starter: false, minutes: 18 }); // 72' -> 90'+2'
    expect(byName(res.players, 'Thomas Bradley').minutes).toBe(1); // on at 90'+2'
  });

  it('ignores Bet 365 in-play prices and keeps the DraftKings closing line', () => {
    expect(res.closingOdds).toMatchObject({ provider: 'DraftKings', home: 2.8, draw: 3.25, away: 2.4, totalLine: 2.5, spreadLine: 0.5 });
  });
});

describe('summary edge cases', () => {
  it('empty summary yields no content', () => {
    const match = matchFrom('scoreboard-laliga-2026.json', 'laliga', '401882846');
    const res = normalizeSummary({}, match);
    expect(res.players).toEqual([]);
    expect(res.stats).toBeUndefined();
    expect(res.closingOdds).toBeUndefined();
    expect(summaryHasContent(res)).toBe(false);
  });

  it('mapPosition', () => {
    expect(mapPosition('G')).toBe('G');
    expect(mapPosition('CD-L')).toBe('D');
    expect(mapPosition('RB')).toBe('D');
    expect(mapPosition('AM-R')).toBe('M');
    expect(mapPosition('DM')).toBe('M');
    expect(mapPosition('CF-L')).toBe('F');
    expect(mapPosition('F')).toBe('F');
    expect(mapPosition('SUB')).toBe('?');
    expect(mapPosition(undefined)).toBe('?');
  });
});
