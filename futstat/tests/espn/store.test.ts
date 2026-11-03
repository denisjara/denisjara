import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MAX_ODDS_HISTORY,
  backupPath,
  cleanStaleTmp,
  emptyStore,
  inferUnknownPositions,
  lastLoadSource,
  loadAllStores,
  loadStore,
  DOWNGRADE_CONFIRMATIONS,
  mergeMatches,
  oddsChanged,
  prunePlayerLines,
  readStoreFile,
  saveStore,
  storeDirBytes,
  storePath,
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

  it('a finished match reported as postponed is only downgraded after several runs in a row (PIPE-06)', () => {
    const glitch = () => [rec({ date: summarised.date, status: 'postponed', statusDetail: 'Aplazado' })];
    let ms = [summarised];
    for (let run = 1; run < DOWNGRADE_CONFIRMATIONS; run++) {
      ms = mergeMatches(ms, glitch(), { now: NOW });
      // one-off glitch: score, stats, events and summary flag survive
      expect(ms[0].status).toBe('finished');
      expect(ms[0].score).toEqual(summarised.score);
      expect(ms[0].stats).toEqual(summarised.stats);
      expect(ms[0].summaryFetched).toBe(true);
      expect(ms[0].downgradeSeen).toBe(run);
    }
    // confirmed: accepted
    const [m] = mergeMatches(ms, glitch(), { now: NOW });
    expect(m.status).toBe('postponed');
    expect(m.score).toBeUndefined();
    expect(m.stats).toBeUndefined();
    expect(m.summaryFetched).toBeUndefined();
    expect(m.downgradeSeen).toBeUndefined();
  });

  it('finished → scheduled glitch → finished again keeps the summary data (PIPE-06)', () => {
    const once = mergeMatches([summarised], [rec({ date: summarised.date, status: 'scheduled' })], { now: NOW });
    const [m] = mergeMatches(once, [rec({ date: summarised.date, status: 'finished', score: summarised.score })], { now: NOW });
    expect(m.summaryFetched).toBe(true);
    expect(m.stats).toEqual(summarised.stats);
    expect(m.events).toEqual(summarised.events);
    expect(m.downgradeSeen).toBeUndefined();
  });

  it('drops records whose date cannot be parsed (they would never age out)', () => {
    const ms = mergeMatches([rec({ id: 'bad', date: 'not-a-date' })], [rec({ id: 'ok' })], { now: new Date('2035-01-01T00:00:00Z'), maxAgeDays: 100000 });
    expect(ms.map((m) => m.id)).toEqual(['ok']);
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

describe('almacén: copia de seguridad y recuperación', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futstat-store-bak-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const quiet = { warn: () => {} };

  function storeWith(n: number) {
    const s = emptyStore('laliga');
    s.matches = Array.from({ length: n }, (_, i) => rec({ id: String(100 + i) }));
    return s;
  }

  it('al sobrescribir guarda el store anterior como <compId>.json.bak', () => {
    saveStore(storeWith(1), dir);
    expect(fs.existsSync(backupPath('laliga', dir))).toBe(false); // no había versión anterior
    saveStore(storeWith(2), dir);
    const bak = JSON.parse(fs.readFileSync(backupPath('laliga', dir), 'utf8'));
    expect(bak.matches).toHaveLength(1);
    expect(loadStore('laliga', dir, quiet).matches).toHaveLength(2);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('store corrupto (JSON truncado) → se recupera del .bak con aviso, sin lanzar', () => {
    saveStore(storeWith(3), dir); // .bak = 2 partidos
    fs.writeFileSync(storePath('laliga', dir), '{"compId":"laliga","matches":[{"id":');
    const warns: string[] = [];
    const s = loadStore('laliga', dir, { warn: (m) => warns.push(m) });
    expect(s.matches).toHaveLength(2);
    expect(lastLoadSource('laliga', dir)).toBe('backup');
    expect(warns.join('\n')).toMatch(/dañado.*copia de seguridad/);
    // el siguiente guardado NO pisa la copia buena con el archivo corrupto
    saveStore(s, dir);
    expect(JSON.parse(fs.readFileSync(backupPath('laliga', dir), 'utf8')).matches).toHaveLength(2);
    expect(loadStore('laliga', dir, quiet).matches).toHaveLength(2);
  });

  it('forma inesperada (array, compId ajeno, matches no array) → .bak; ambos dañados → store vacío', () => {
    for (const bad of ['[]', '{"compId":"premier","matches":[]}', '{"compId":"laliga","matches":{}}', 'null', '']) {
      fs.writeFileSync(storePath('laliga', dir), bad);
      expect(loadStore('laliga', dir, quiet).matches).toHaveLength(2);
    }
    fs.writeFileSync(backupPath('laliga', dir), '{roto');
    const warns: string[] = [];
    const s = loadStore('laliga', dir, { warn: (m) => warns.push(m) });
    expect(s).toMatchObject({ compId: 'laliga', matches: [], players: [], standings: [] });
    expect(lastLoadSource('laliga', dir)).toBe('empty');
    expect(warns.join('\n')).toMatch(/almacén vacío/);
  });

  it('descarta registros mal formados al cargar y solo falta el principal → usa el .bak', () => {
    const s = storeWith(2);
    (s.matches as unknown[]).push(null, { id: 5 }, { id: 'x', date: '2026-01-01', status: 'finished', home: { id: '1' }, away: {} });
    (s.players as unknown[]).push(line(), { matchId: 1 });
    fs.writeFileSync(storePath('premier', dir), JSON.stringify({ ...s, compId: 'premier' }));
    const back = loadStore('premier', dir, quiet);
    expect(back.matches).toHaveLength(2);
    expect(back.players).toHaveLength(1);
    // proceso interrumpido: solo queda la copia
    fs.renameSync(storePath('premier', dir), backupPath('premier', dir));
    expect(loadStore('premier', dir, quiet).matches).toHaveLength(2);
    expect(loadAllStores(dir, quiet).map((x) => x.compId)).toEqual(expect.arrayContaining(['premier']));
  });

  it('storeDirBytes suma el tamaño de los archivos del almacén', () => {
    const total = fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
    expect(storeDirBytes(dir)).toBe(total);
    expect(storeDirBytes(path.join(dir, 'no-existe'))).toBe(0);
  });
});


describe('validación profunda al cargar el almacén (PIPE-04)', () => {
  const base = path.join(os.tmpdir(), `futstat-deep-${process.pid}`);
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
  const team = (id: string) => ({ id, name: `Equipo ${id}`, short: id, abbr: id });
  const ok = (id: string, extra: Record<string, unknown> = {}) => ({
    id, compId: 'premier', season: 2026, currentSeason: true, date: '2026-10-01T18:00:00Z', status: 'finished',
    home: team('1'), away: team('2'), score: { home: 1, away: 0 }, ...extra,
  });
  const line = (extra: Record<string, unknown> = {}) => ({
    matchId: 'm1', compId: 'premier', date: '2026-10-01T18:00:00Z', teamId: '1', opponentId: '2', isHome: true, playerId: 'p1',
    name: 'Jugador', short: 'J.', position: 'F', starter: true, minutes: 90, goals: 1, assists: 0, shots: 2, shotsOnTarget: 1,
    yellow: 0, red: 0, foulsCommitted: 1, foulsSuffered: 0, offsides: 0, ownGoals: 0, ...extra,
  });

  it('descarta registros con nombre numérico, fecha o estado imposibles y marcadores absurdos; corrige campos opcionales', () => {
    fs.mkdirSync(base, { recursive: true });
    const file = path.join(base, 'premier.json');
    const raw = {
      compId: 'premier', slug: 'eng.1', updatedAt: '2026-11-03T10:00:00Z',
      matches: [
        ok('good'),
        ok('num-name', { home: { id: '1', name: 12345 } }),
        ok('bad-date', { date: 'not-a-date' }),
        ok('bad-status', { status: 'exploded' }),
        ok('huge-score', { score: { home: 1e9, away: -3 } }),
        ok('stats-null', { stats: { home: null, away: 'x' }, events: 'boom', oddsHistory: { length: 3 } }),
        ok('bad-odds', { odds: { provider: 'DK', home: 1.01, draw: 2, away: 2 } }),
      ],
      players: [line(), line({ playerId: 'p2', goals: '71' }), line({ playerId: 'p3', goals: -100 }), line({ playerId: 'p4', name: { x: 1 } }), line({ playerId: 'p5', ownGoals: undefined })],
      standings: [{ name: 'Premier', rows: [{ rank: 1, team: null, played: 1 }] }],
    };
    fs.writeFileSync(file, JSON.stringify(raw));
    const r = readStoreFile(file, 'premier')!;
    expect(r.store.matches.map((m) => m.id).sort()).toEqual(['bad-odds', 'good', 'stats-null']);
    const sn = r.store.matches.find((m) => m.id === 'stats-null')!;
    expect(sn.stats).toBeUndefined();
    expect(sn.events).toBeUndefined();
    expect(sn.oddsHistory).toBeUndefined();
    // trío 1X2 con margen imposible (0,99): fuera; sin otros precios, sin cuotas
    expect(r.store.matches.find((m) => m.id === 'bad-odds')!.odds).toBeUndefined();
    expect(r.store.players.map((p) => p.playerId).sort()).toEqual(['p1', 'p5']);
    expect(r.store.players.find((p) => p.playerId === 'p5')!.ownGoals).toBe(0);
    expect(r.store.standings).toEqual([]);
    expect(r.dropped).toBeGreaterThan(0);
  });

  it('el almacén real de un esquema anterior se carga sin perder nada (campos opcionales ausentes)', () => {
    const file = path.join(base, 'laliga.json');
    fs.writeFileSync(file, JSON.stringify({ compId: 'laliga', matches: [ok('a', { compId: 'laliga' })], players: [line()], standings: [] }));
    const r = readStoreFile(file, 'laliga')!;
    expect(r.dropped).toBe(0);
    expect(r.store.matches).toHaveLength(1);
    expect(r.store.players).toHaveLength(1);
  });

  it('borra los temporales huérfanos de un guardado interrumpido, no los recientes (PIPE-11)', () => {
    fs.mkdirSync(base, { recursive: true });
    const old = path.join(base, 'premier.json.99999.tmp');
    const fresh = path.join(base, 'laliga.json.88888.tmp');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(fresh, 'y');
    const past = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(old, past, past);
    expect(cleanStaleTmp(base)).toEqual(['premier.json.99999.tmp']);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
