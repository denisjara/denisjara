import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MAX_ODDS_HISTORY,
  emptyStore,
  inferUnknownPositions,
  loadStore,
  mergeMatches,
  oddsChanged,
  prunePlayerLines,
  saveStore,
  upsertPlayerLines,
} from '../../pipeline/store';
import type { MatchRecord, PlayerLine } from '../../pipeline/types';
import type { OddsSnapshot } from '../../src/types/data';

const NOW = new Date('2026-11-03T12:00:00Z');
const team = (id: string) => ({ id, name: `Equipo ${id}`, short: `E${id}`, abbr: `E${id}` });

function rec(over: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id: '100',
    compId: 'laliga',
    season: 2026,
    currentSeason: true,
    date: '2026-11-08T20:00:00Z',
    status: 'scheduled',
    home: team('1'),
    away: team('2'),
    ...over,
  };
}

const odds = (home: number, capturedAt = '2026-11-03T12:00:00Z'): OddsSnapshot => ({
  provider: 'DraftKings',
  home,
  draw: 3.4,
  away: 4,
  margin: 0.05,
  capturedAt,
});

function line(over: Partial<PlayerLine> = {}): PlayerLine {
  return {
    matchId: '100',
    compId: 'laliga',
    date: '2026-10-17T16:30:00Z',
    teamId: '1',
    opponentId: '2',
    isHome: true,
    playerId: 'p1',
    name: 'Jugador Uno',
    short: 'J. Uno',
    position: 'F',
    starter: true,
    minutes: 90,
    goals: 0,
    assists: 0,
    shots: 0,
    shotsOnTarget: 0,
    yellow: 0,
    red: 0,
    foulsCommitted: 0,
    foulsSuffered: 0,
    offsides: 0,
    ownGoals: 0,
    ...over,
  };
}

describe('mergeMatches · odds history', () => {
  it('first sighting of a scheduled match seeds the history', () => {
    const [m] = mergeMatches([], [rec({ odds: odds(2) })], { now: NOW });
    expect(m.oddsHistory).toEqual([odds(2)]);
    expect(m.summaryFetched).toBeUndefined();
  });

  it('appends only when prices change (capture time ignored)', () => {
    let ms = mergeMatches([], [rec({ odds: odds(2, 'a') })], { now: NOW });
    ms = mergeMatches(ms, [rec({ odds: odds(2, 'b') })], { now: NOW });
    expect(ms[0].oddsHistory).toHaveLength(1);
    ms = mergeMatches(ms, [rec({ odds: odds(2.1, 'c') })], { now: NOW });
    expect(ms[0].oddsHistory!.map((o) => o.home)).toEqual([2, 2.1]);
    expect(ms[0].odds?.home).toBe(2.1);
    // odds disappear from the feed: keep the last snapshot
    ms = mergeMatches(ms, [rec()], { now: NOW });
    expect(ms[0].odds?.home).toBe(2.1);
    expect(ms[0].oddsHistory).toHaveLength(2);
  });

  it(`keeps at most ${MAX_ODDS_HISTORY} snapshots`, () => {
    let ms: MatchRecord[] = [];
    for (let i = 0; i < 40; i++) ms = mergeMatches(ms, [rec({ odds: odds(2 + i / 100) })], { now: NOW });
    expect(ms[0].oddsHistory).toHaveLength(MAX_ODDS_HISTORY);
    expect(ms[0].oddsHistory!.at(-1)!.home).toBeCloseTo(2.39);
    expect(ms[0].oddsHistory![0].home).toBeCloseTo(2.1);
  });

  it('oddsChanged', () => {
    expect(oddsChanged(odds(2, 'x'), odds(2, 'y'))).toBe(false);
    expect(oddsChanged(odds(2), odds(2.05))).toBe(true);
    expect(oddsChanged(undefined, odds(2))).toBe(true);
  });
});

describe('mergeMatches · summary-derived fields', () => {
  const summarised = rec({
    date: '2026-10-17T16:30:00Z',
    status: 'finished',
    statusDetail: 'Final',
    score: { home: 2, away: 5, htHome: 1, htAway: 2 },
    stats: {
      home: { goals: 2, shots: 6, passes: 324, passPct: 0.79, saves: 5 },
      away: { goals: 5, shots: 18, passes: 751, passPct: 0.923, saves: 3 },
    },
    events: [
      { minute: 10, clock: "10'", type: 'goal', teamId: '2' },
      { minute: 45, clock: "45'", type: 'sub', teamId: '2', playerId: 'a', playerOutId: 'b' },
    ],
    odds: { provider: 'DraftKings', home: 6.5, draw: 5.5, away: 1.408, capturedAt: '2026-10-17T16:30:00Z' },
    oddsHistory: [odds(5)],
    neutral: true,
    summaryFetched: true,
  });
  const fromScoreboard = rec({
    date: '2026-10-17T16:30:00Z',
    status: 'finished',
    statusDetail: 'Final',
    score: { home: 2, away: 5 },
    stats: { home: { goals: 2, shots: 7, corners: 2 }, away: { goals: 5, shots: 18, corners: 5 } },
    events: [{ minute: 10, clock: "10'", type: 'goal', teamId: '2' }],
  });

  it('keeps extended stats, richer events, closing odds, HT and the summary flag', () => {
    const [m] = mergeMatches([summarised], [fromScoreboard], { now: NOW });
    expect(m.summaryFetched).toBe(true);
    expect(m.stats?.home).toEqual({ goals: 2, shots: 7, corners: 2, passes: 324, passPct: 0.79, saves: 5 });
    expect(m.events).toHaveLength(2);
    expect(m.odds?.home).toBe(6.5);
    expect(m.oddsHistory).toHaveLength(1);
    expect(m.score).toEqual({ home: 2, away: 5, htHome: 1, htAway: 2 });
    expect(m.neutral).toBe(true);
  });

  it('a match that just finished keeps its last pre-match odds and will be summarised', () => {
    const pre = mergeMatches([], [rec({ date: '2026-11-02T20:00:00Z', odds: odds(2) })], { now: NOW });
    const [m] = mergeMatches(pre, [rec({ date: '2026-11-02T20:00:00Z', status: 'finished', score: { home: 1, away: 0 } })], { now: NOW });
    expect(m.summaryFetched).toBe(false);
    expect(m.odds?.home).toBe(2);
    expect(m.oddsHistory).toHaveLength(1);
  });

  it('a postponed match drops score/stats and the summary flag', () => {
    const [m] = mergeMatches([summarised], [rec({ date: summarised.date, status: 'postponed', statusDetail: 'Aplazado' })], { now: NOW });
    expect(m.status).toBe('postponed');
    expect(m.score).toBeUndefined();
    expect(m.stats).toBeUndefined();
    expect(m.summaryFetched).toBeUndefined();
  });

  it('drops matches older than 900 days and keeps the result sorted', () => {
    const old = rec({ id: 'old', date: '2024-04-01T18:00:00Z', status: 'finished', score: { home: 0, away: 0 } });
    const recent = rec({ id: 'b', date: '2026-10-01T18:00:00Z', status: 'finished', score: { home: 1, away: 1 } });
    const ms = mergeMatches([old], [rec({ id: 'a' }), recent], { now: NOW });
    expect(ms.map((m) => m.id)).toEqual(['b', 'a']);
  });
});

describe('player lines', () => {
  it('upsert by (matchId, playerId)', () => {
    const a = line({ playerId: 'p1', goals: 0 });
    const b = line({ playerId: 'p2' });
    const out = upsertPlayerLines([a, b], [line({ playerId: 'p1', goals: 2 }), line({ matchId: '200', date: '2026-10-24T16:30:00Z' })]);
    expect(out).toHaveLength(3);
    expect(out.find((p) => p.matchId === '100' && p.playerId === 'p1')?.goals).toBe(2);
    expect(out.at(-1)?.matchId).toBe('200');
  });

  it('infers the position of substitutes from their other appearances', () => {
    const lines = [
      line({ matchId: '1', playerId: 'x', position: 'D' }),
      line({ matchId: '2', playerId: 'x', position: 'D' }),
      line({ matchId: '3', playerId: 'x', position: 'M' }),
      line({ matchId: '4', playerId: 'x', position: '?', starter: false }),
      line({ matchId: '4', playerId: 'y', position: '?', starter: false }),
    ];
    expect(inferUnknownPositions(lines)).toBe(1);
    expect(lines[3].position).toBe('D');
    expect(lines[4].position).toBe('?');
  });

  it('prune lines of removed or old matches', () => {
    const lines = [line(), line({ matchId: 'gone' }), line({ matchId: '100', playerId: 'old', date: '2024-01-01T00:00:00Z' })];
    const out = prunePlayerLines(lines, [rec()], { now: NOW });
    expect(out.map((p) => p.playerId)).toEqual(['p1']);
  });
});

describe('loadStore / saveStore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futstat-store-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('missing file -> empty store with the configured slug', () => {
    const s = loadStore('laliga', dir);
    expect(s).toMatchObject({ compId: 'laliga', slug: 'esp.1', matches: [], players: [], standings: [] });
  });

  it('round-trips as compact JSON', () => {
    const s = emptyStore('premier');
    s.matches = [rec({ compId: 'premier' })];
    s.players = [line({ compId: 'premier' })];
    saveStore(s, dir);
    const text = fs.readFileSync(path.join(dir, 'premier.json'), 'utf8');
    expect(text).not.toContain('\n');
    expect(text.startsWith('{"compId":"premier"')).toBe(true);
    const back = loadStore('premier', dir);
    expect(back.matches).toEqual(s.matches);
    expect(back.players).toEqual(s.players);
    expect(back.slug).toBe('eng.1');
    expect(Date.parse(back.updatedAt)).toBeGreaterThan(0);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
