/**
 * Tests del orquestador del build (pipeline/build.ts + pipeline/publish/*) y del validador de datos
 * (scripts/validate-data.ts) sobre un mundo sintético: dos ligas, una competición continental y una copa, con
 * partidos programados, uno en juego, cuotas y líneas de jugadores.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CompetitionFile,
  HomeFile,
  MatchFile,
  MetaFile,
  ModelFile,
  OddsSnapshot,
  PlayersFile,
  StandingGroup,
  TeamFile,
  TeamRef,
  ValueFile,
} from '../src/types/data';
import { mulberry32, samplePoisson } from '../src/lib/models';
import type { CompetitionConfig } from '../pipeline/config';
import type { CompetitionStore, MatchRecord, PlayerLine } from '../pipeline/types';
import { PublishRejectedError, runBuild, stagingDirFor, type BuildReport } from '../pipeline/build';
import { remainingFixtures } from '../pipeline/publish/simulation';
import {
  LockedError,
  UnsafeOutputError,
  acquireLock,
  assertSafeOutputDir,
  cleanJson,
  foreignContent,
  localDay,
  lockPathFor,
  newCleanStats,
  nextDay,
  previousDirFor,
  recoverInterruptedSwap,
  sanitizePublishedString,
  swapDir,
} from '../pipeline/publish/util';
import { ROOT_DIR } from '../pipeline/config';
import { DEFAULT_SANITY, validateDataDir } from '../scripts/validate-data';

/** El mundo sintético es pequeño (4 competiciones): se valida el contrato sin los umbrales de cordura de producción. */
const NO_SANITY = { sanity: false } as const;
import { SYN_CONFIGS, TEAMS_A, TEAMS_B, TEAMS_LOW, scheduled, syntheticWorld } from './analytics/synthetic';

const DAY = 86_400_000;
const NOW = new Date('2025-11-22T12:00:00Z');
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

const ODDS: OddsSnapshot = { provider: 'Test', home: 1.9, draw: 3.6, away: 4.2, totalLine: 2.5, over: 1.9, under: 1.95, margin: 0.0418 };

const CONFIGS: CompetitionConfig[] = SYN_CONFIGS.map((c) =>
  c.id === 'liga-a'
    ? {
        ...c,
        simulate: true,
        simulationZones: [
          { label: 'Campeón', from: 1, to: 1 },
          { label: 'Top 3', from: 1, to: 3 },
          { label: 'Descenso', from: -2, to: -1 },
        ],
      }
    : c,
);

/** Líneas de jugador sintéticas (13 por equipo y partido) coherentes con el marcador. */
function playerLines(m: MatchRecord, rng: () => number): PlayerLine[] {
  const out: PlayerLine[] = [];
  for (const side of ['home', 'away'] as const) {
    const team = m[side];
    const opp = side === 'home' ? m.away : m.home;
    const goals = side === 'home' ? m.score!.home : m.score!.away;
    const positions: PlayerLine['position'][] = ['G', 'D', 'D', 'D', 'D', 'M', 'M', 'M', 'M', 'F', 'F', 'M', 'F'];
    const scorers = Array.from({ length: goals }, () => 5 + Math.floor(rng() * 8));
    positions.forEach((position, i) => {
      const starter = i < 11;
      const g = scorers.filter((s) => s === i).length;
      const shots = g + samplePoisson(position === 'F' ? 2 : position === 'M' ? 1 : 0.4, rng);
      out.push({
        matchId: m.id,
        compId: m.compId,
        date: m.date,
        teamId: team.id,
        opponentId: opp.id,
        isHome: side === 'home',
        playerId: `${team.id}-p${i}`,
        name: `Jugador ${i} ${team.name}`,
        short: `J. ${i}`,
        position,
        starter,
        minutes: starter ? (i === 10 ? 70 : 90) : i === 11 ? 20 : 0,
        goals: g,
        assists: rng() < 0.08 ? 1 : 0,
        shots,
        shotsOnTarget: Math.min(shots, g + samplePoisson(0.4, rng)),
        yellow: rng() < 0.12 ? 1 : 0,
        red: 0,
        foulsCommitted: samplePoisson(1.1, rng),
        foulsSuffered: samplePoisson(1, rng),
        offsides: position === 'F' ? samplePoisson(0.4, rng) : 0,
        ownGoals: 0,
        ...(position === 'G' ? { saves: samplePoisson(2.5, rng), goalsConceded: side === 'home' ? m.score!.away : m.score!.home } : {}),
      });
    });
  }
  return out;
}

/** Mundo sintético "visto" en NOW: temporada actual = segunda vuelta de cada liga; partidos futuros, en juego y cuotas. */
function testStores(): CompetitionStore[] {
  const world = syntheticWorld(11);
  const rng = mulberry32(99);
  const stores = world.stores.map((s) => ({ ...s, matches: s.matches.filter((m) => Date.parse(m.date) <= NOW.getTime() - 3_600_000) }));
  for (const s of stores) {
    const sorted = [...s.matches].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    // temporada actual: tras el mayor hueco del calendario en ligas; todo en copa y continental
    let split = 0;
    if (s.compId.startsWith('liga')) {
      let gap = 0;
      for (let i = 1; i < sorted.length; i++) {
        const g = Date.parse(sorted[i].date) - Date.parse(sorted[i - 1].date);
        if (g > gap) [gap, split] = [g, i];
      }
    }
    const splitDate = sorted[split] ? Date.parse(sorted[split].date) : 0;
    for (const m of s.matches) {
      m.currentSeason = Date.parse(m.date) >= splitDate;
      m.season = 2025;
    }
  }
  const byId = new Map(stores.map((s) => [s.compId, s]));
  const A = TEAMS_A.map((t) => t.ref);
  const B = TEAMS_B.map((t) => t.ref);
  const add = (compId: string, m: MatchRecord) => byId.get(compId)!.matches.push({ ...m, season: 2025, currentSeason: true });
  add('liga-a', scheduled('liga-a', iso(DAY), A[0], A[1], { odds: ODDS, id: 'up-a01', homeForm: 'WWDLW', awayForm: 'LDWWW' }));
  add('liga-a', scheduled('liga-a', iso(2 * DAY), A[2], A[3], { id: 'up-a23' }));
  add('liga-a', scheduled('liga-a', iso(40 * DAY), A[4], A[5], { id: 'far-a45' }));
  add('liga-a', {
    ...scheduled('liga-a', iso(-30 * 60_000), A[6], A[7], { id: 'live-a67' }),
    status: 'live',
    statusDetail: "34'",
    score: { home: 1, away: 0 },
    stats: { home: { goals: 1, shots: 6, corners: 3 }, away: { goals: 0, shots: 2, corners: 1 } },
    events: [{ minute: 20, clock: "20'", type: 'goal', teamId: A[6].id, player: 'Jugador 9' }],
  });
  add('liga-b', scheduled('liga-b', iso(DAY + 3_600_000), B[0], B[1], { odds: { ...ODDS, home: 2.3, draw: 3.3, away: 3.2 }, id: 'up-b01' }));
  add('euro', scheduled('euro', iso(2 * DAY), A[0], B[0], { odds: { ...ODDS, home: 1.6, draw: 4, away: 5.5 }, id: 'up-e0' }));
  add('copa', scheduled('copa', iso(3 * DAY), TEAMS_LOW[0].ref, A[5], { id: 'up-c0' }));
  add('copa', { ...scheduled('copa', iso(5 * DAY), TEAMS_LOW[1].ref, A[6], { id: 'cancel-c1' }), status: 'cancelled' });
  for (const s of stores) s.matches.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  // color de equipo (lo publica el índice de meta.json)
  for (const s of stores) for (const m of s.matches) for (const side of ['home', 'away'] as const) if (m[side].id === A[0].id) m[side] = { ...m[side], color: 'c8102e' };
  // líneas de jugador en los partidos terminados de la temporada actual de la liga A y la continental
  for (const id of ['liga-a', 'euro']) {
    const s = byId.get(id)!;
    s.players = s.matches.filter((m) => m.status === 'finished' && m.currentSeason).flatMap((m) => playerLines(m, rng));
  }
  return stores;
}

const readJson = <T>(dir: string, rel: string): T => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')) as T;

let tmp: string;
let outDir: string;
let report: BuildReport;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'futstat-build-'));
  outDir = path.join(tmp, 'data');
  fs.mkdirSync(outDir, { recursive: true });
  // salida anterior de FutStat con un archivo que ya no se genera: se sustituye entera
  fs.writeFileSync(path.join(outDir, 'meta.json'), '{}');
  fs.writeFileSync(path.join(outDir, 'stale.json'), '{}');
  report = runBuild({ stores: testStores(), configs: CONFIGS, now: NOW, outDir, fast: true, log: () => {}, validate: NO_SANITY });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('runBuild (mundo sintético)', () => {
  it('produce un conjunto de datos que pasa la validación del contrato', () => {
    const v = validateDataDir(outDir, NO_SANITY);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.files).toBe(report.files);
    expect(report.cleaned.droppedKeys + report.cleaned.zeroedItems).toBe(0);
  });

  it('sustituye el directorio de salida (borra archivos antiguos) y no deja el temporal', () => {
    expect(fs.existsSync(path.join(outDir, 'stale.json'))).toBe(false);
    expect(fs.existsSync(stagingDirFor(outDir))).toBe(false);
    expect(fs.existsSync(previousDirFor(outDir))).toBe(false);
    for (const f of ['meta.json', 'home.json', 'players.json', 'value.json', 'model.json']) expect(fs.existsSync(path.join(outDir, f))).toBe(true);
  });

  it('meta: todas las competiciones con store, contadores e índice de equipos', () => {
    const meta = readJson<MetaFile>(outDir, 'meta.json');
    expect(meta.competitions.map((c) => c.id)).toEqual(['liga-a', 'liga-b', 'euro', 'copa']);
    expect(meta.counts.upcomingMatches).toBe(5);
    expect(meta.counts.teams).toBe(meta.teams.length);
    // equipos de ligas y continental (18), no los modestos que solo juegan la copa
    expect(meta.teams.length).toBe(18);
    expect(meta.teams.some((t) => t.id.startsWith('L'))).toBe(false);
    for (const t of meta.teams) expect(fs.existsSync(path.join(outDir, 'teams', `${t.id}.json`))).toBe(true);
    const a = meta.competitions.find((c) => c.id === 'liga-a')!;
    expect(a.hasTable).toBe(true);
    expect(a.hasSimulation).toBe(true);
    expect(a.simulationColumns).toEqual(['Campeón', 'Top 3', 'Descenso']);
    expect(a.upcomingCount).toBe(2);
    expect(meta.competitions.find((c) => c.id === 'copa')!.hasTable).toBe(false);
  });

  it('fichas de partido: próximos (14 días), en juego y terminados recientes; ninguna fuera de ventana', () => {
    const files = fs.readdirSync(path.join(outDir, 'matches')).map((f) => f.replace('.json', ''));
    for (const id of ['up-a01', 'up-a23', 'up-b01', 'up-e0', 'up-c0', 'live-a67']) expect(files).toContain(id);
    expect(files).not.toContain('far-a45');
    expect(files).not.toContain('cancel-c1');
    const recentFinished = files.filter((id) => !/^(up|live)-/.test(id));
    expect(recentFinished.length).toBeGreaterThan(0);
    expect(report.matchFiles).toBe(files.length);
  });

  it('ficha de un partido próximo con cuotas: predicción, mercados, proyecciones, forma, props y tabla', () => {
    const f = readJson<MatchFile>(outDir, 'matches/up-a01.json');
    const p = f.match.prediction!;
    expect(f.match.hasDetail).toBe(true);
    expect(p.p.home + p.p.draw + p.p.away).toBeCloseTo(1, 3);
    expect(p.market).toBeDefined();
    expect(f.model.weights.market).toBeGreaterThan(0);
    expect(f.model.lambdaHome).toBeGreaterThan(0.3);
    expect(f.model.lambdaHome).toBeLessThan(3.5);
    expect(f.markets.find((m) => m.id === '1x2')!.selections[0].prob).toBeCloseTo(p.p.home, 3);
    expect(f.projections.map((x) => x.key)).toEqual(expect.arrayContaining(['corners', 'cards', 'shots', 'shotsOnTarget', 'fouls']));
    const corners = f.projections.find((x) => x.key === 'corners')!;
    expect(corners.total).toBeGreaterThan(6);
    expect(corners.total).toBeLessThan(14);
    expect(f.form.home.last.length).toBeGreaterThan(0);
    expect(f.form.home.last.length).toBeLessThanOrEqual(10);
    expect(f.players.home.length).toBeGreaterThan(0);
    expect(f.players.home[0].pGoal).toBeGreaterThan(0);
    expect(f.table?.homeRank).toBeDefined();
    expect(f.table?.awayRank).toBeDefined();
    expect(f.h2h.matches.length).toBeGreaterThan(0);
    expect(f.comparison.length).toBeGreaterThan(5);
    expect(f.match.popularity).toBeGreaterThan(0);
    expect(f.actual).toBeUndefined();
  });

  it('ficha de un partido en juego y de uno terminado: estadísticas reales, eventos y acierto', () => {
    const live = readJson<MatchFile>(outDir, 'matches/live-a67.json');
    expect(live.match.status).toBe('live');
    expect(live.actual?.home.goals).toBe(1);
    expect(live.events?.[0].type).toBe('goal');
    const files = fs.readdirSync(path.join(outDir, 'matches')).filter((f) => !/^(up|live)-/.test(f));
    const fin = readJson<MatchFile>(outDir, `matches/${files[0]}`);
    expect(fin.match.status).toBe('finished');
    expect(typeof fin.match.predictionHit).toBe('boolean');
    expect(fin.actual).toBeDefined();
    // la forma del bloque es la previa al partido
    for (const fm of fin.form.home.last) expect(Date.parse(fm.date)).toBeLessThan(Date.parse(fin.match.date));
  });

  it('competición de liga: clasificación desde partidos con forma/xPts/Elo, simulación, backtest y jugadores', () => {
    const c = readJson<CompetitionFile>(outDir, 'competitions/liga-a.json');
    expect(c.standings).toHaveLength(1);
    const rows = c.standings[0].rows;
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.played === 18)).toBe(true);
    expect(rows.every((r) => r.form && r.form.length === 5 && r.xPts !== undefined && r.elo !== undefined)).toBe(true);
    expect(c.upcoming.map((m) => m.id)).toEqual(['up-a01', 'up-a23']);
    expect(c.live.map((m) => m.id)).toEqual(['live-a67']);
    for (let i = 1; i < c.results.length; i++) expect(Date.parse(c.results[i - 1].date)).toBeGreaterThanOrEqual(Date.parse(c.results[i].date));
    expect(c.results.every((m) => m.prediction && typeof m.predictionHit === 'boolean')).toBe(true);
    expect(c.simulations).toHaveLength(1);
    const sim = c.simulations[0];
    // pendientes: los 3 programados de la liga (incluido el de dentro de 40 días) + el que está en juego
    expect(sim.remainingMatches).toBe(4);
    expect(sim.columns).toEqual(['Campeón', 'Top 3', 'Descenso']);
    const champ = sim.rows.reduce((s, r) => s + r.probs['Campeón'], 0);
    expect(champ).toBeCloseTo(1, 2);
    expect(c.ratings).toHaveLength(10);
    expect(c.ratings[0].eloRank).toBe(1);
    expect(c.ratings[0].attack).toBeDefined();
    expect(c.backtest?.matches).toBe(90);
    expect(c.players.length).toBeGreaterThan(0);
    expect(c.players.every((p) => p.minutes >= 90)).toBe(true);
    expect(c.teams.every((t) => t.xgFor.all > 0)).toBe(true);
    expect(c.insights.length).toBeGreaterThan(3);
  });

  it('copa sin tabla: sin clasificación ni simulación, con próximos y ratings', () => {
    const c = readJson<CompetitionFile>(outDir, 'competitions/copa.json');
    expect(c.standings).toEqual([]);
    expect(c.simulations).toEqual([]);
    expect(c.upcoming.map((m) => m.id)).toEqual(['up-c0']);
    expect(c.upcoming[0].prediction).toBeDefined();
  });

  it('equipo: competiciones, liga principal, partidos de la temporada, próximos y jugadores', () => {
    const t = readJson<TeamFile>(outDir, `teams/${TEAMS_A[0].ref.id}.json`);
    expect(t.competitions).toEqual(['liga-a', 'euro', 'copa']); // A0 juega la final neutral de la copa
    expect(t.primaryCompId).toBe('liga-a');
    expect(t.upcoming.map((m) => m.id)).toEqual(['up-a01', 'up-e0']);
    expect(t.matches.length).toBeGreaterThan(9);
    for (let i = 1; i < t.matches.length; i++) expect(Date.parse(t.matches[i - 1].date)).toBeGreaterThanOrEqual(Date.parse(t.matches[i].date));
    expect(t.standing?.team.id).toBe(TEAMS_A[0].ref.id);
    expect(t.players.length).toBeGreaterThan(0);
    expect(t.players.every((p) => p.team.id === TEAMS_A[0].ref.id)).toBe(true);
    expect(t.globalEloRank).toBeGreaterThanOrEqual(1);
  });

  it('portada, jugadores, valor y modelo', () => {
    const home = readJson<HomeFile>(outDir, 'home.json');
    expect(home.popular.length).toBe(6); // 5 próximos en 72 h + el que está en juego
    for (let i = 1; i < home.popular.length; i++) expect(home.popular[i - 1].popularity!).toBeGreaterThanOrEqual(home.popular[i].popularity!);
    expect(home.today.map((m) => m.id)).toContain('live-a67');
    expect(home.tomorrow.map((m) => m.id)).toEqual(expect.arrayContaining(['up-a01', 'up-b01']));
    expect(home.highlights.length).toBeGreaterThan(2);
    expect(home.modelHeadline?.matches).toBeGreaterThan(0);
    const players = readJson<PlayersFile>(outDir, 'players.json');
    expect(players.players.length).toBeGreaterThan(0);
    expect(players.players.every((p) => p.minutes >= 270)).toBe(true);
    const value = readJson<ValueFile>(outDir, 'value.json');
    expect(value.minEv).toBe(0.05);
    expect(value.kellyFraction).toBe(0.25);
    for (const b of value.bets) expect(['up-a01', 'up-b01', 'up-e0']).toContain(b.match.id);
    const model = readJson<ModelFile>(outDir, 'model.json');
    expect(model.sections.length).toBeGreaterThanOrEqual(10);
    expect(model.sections.map((s) => s.title).join(' ')).toMatch(/Kelly/);
    expect(model.sections.map((s) => s.title).join(' ')).toMatch(/Juego responsable/);
    expect(model.backtest.matches).toBeGreaterThan(90);
    expect(model.perCompetition.map((p) => p.compId)).toContain('liga-a');
    expect(model.parameters.simIterations).toBe(10000);
  });

  it('--only publica solo las competiciones pedidas', () => {
    const dir = path.join(tmp, 'only');
    const r = runBuild({ stores: testStores(), configs: CONFIGS, now: NOW, outDir: dir, fast: true, only: ['liga-b'], log: () => {}, validate: NO_SANITY });
    expect(r.competitions).toBe(1);
    expect(fs.readdirSync(path.join(dir, 'competitions'))).toEqual(['liga-b.json']);
    const meta = readJson<MetaFile>(dir, 'meta.json');
    expect(meta.competitions.map((c) => c.id)).toEqual(['liga-b']);
    expect(fs.readdirSync(path.join(dir, 'matches'))).toEqual(['up-b01.json']);
  });
});

describe('puerta de calidad del build', () => {
  it('si la validación falla: error, salida anterior intacta y sin directorios temporales', () => {
    const dir = path.join(tmp, 'gate');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), '{"version":"anterior"}');
    // umbral imposible ⇒ los datos (válidos según el contrato) se consideran degenerados
    let err: unknown;
    try {
      runBuild({ stores: testStores(), configs: CONFIGS, now: NOW, outDir: dir, fast: true, log: () => {}, validate: { sanity: { minMatchesAnalyzed: 1e9 } } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PublishRejectedError);
    expect((err as PublishRejectedError).validation.errors.join('\n')).toMatch(/cordura: meta\.counts\.matchesAnalyzed/);
    expect(fs.readdirSync(dir)).toEqual(['meta.json']);
    expect(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).toBe('{"version":"anterior"}');
    expect(fs.existsSync(stagingDirFor(dir))).toBe(false);
    expect(fs.existsSync(previousDirFor(dir))).toBe(false);
  });

  it('un error durante el build tampoco toca la salida anterior', () => {
    const dir = path.join(tmp, 'gate-crash');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), '{}');
    fs.writeFileSync(path.join(dir, 'home.json'), 'x');
    const stores = testStores();
    // partido con un id que no puede ser nombre de archivo: se descarta, el resto se publica
    const bad = stores.find((s) => s.compId === 'liga-a')!;
    bad.matches.push({ ...bad.matches[bad.matches.length - 1], id: '../../etc/passwd' });
    const r = runBuild({ stores, configs: CONFIGS, now: NOW, outDir: dir, fast: true, log: () => {}, validate: NO_SANITY });
    expect(r.matchFiles).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, 'home.json'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'home.json'), 'utf8')).not.toBe('x');
    expect(fs.readdirSync(path.join(dir, 'matches')).every((f) => /^[A-Za-z0-9_-]+\.json$/.test(f))).toBe(true);
  });

  it('nunca borra contenido ajeno: --out a una carpeta con documentos, al proyecto o con un .tmp ajeno (PIPE-05)', () => {
    const victim = path.join(tmp, 'precious');
    fs.mkdirSync(path.join(victim, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(victim, 'tesis.docx'), 'mi tesis');
    fs.writeFileSync(path.join(victim, 'sub', 'foto.jpg'), 'foto');
    const run = (outDir: string) => runBuild({ stores: testStores(), configs: CONFIGS, now: NOW, outDir, fast: true, log: () => {}, validate: NO_SANITY });
    expect(() => run(victim)).toThrow(UnsafeOutputError);
    expect(fs.readFileSync(path.join(victim, 'tesis.docx'), 'utf8')).toBe('mi tesis');
    expect(fs.existsSync(path.join(victim, 'sub', 'foto.jpg'))).toBe(true);
    // solo .json pero sin meta.json: tampoco (no parece una salida de FutStat)
    const jsons = path.join(tmp, 'configs');
    fs.mkdirSync(jsons, { recursive: true });
    fs.writeFileSync(path.join(jsons, 'settings.json'), '{}');
    expect(() => run(jsons)).toThrow(UnsafeOutputError);
    expect(fs.existsSync(path.join(jsons, 'settings.json'))).toBe(true);
    // el proyecto, una carpeta que lo contiene, la carpeta personal o la raíz
    for (const d of [ROOT_DIR, path.dirname(ROOT_DIR), os.homedir(), path.parse(ROOT_DIR).root]) expect(() => assertSafeOutputDir(d, ROOT_DIR)).toThrow(UnsafeOutputError);
    // salida válida pero con un <salida>.tmp ajeno al lado
    const out = path.join(tmp, 'withtmp');
    fs.mkdirSync(stagingDirFor(out), { recursive: true });
    fs.writeFileSync(path.join(stagingDirFor(out), 'otro.txt'), 'no tocar');
    expect(() => run(out)).toThrow(UnsafeOutputError);
    expect(fs.readFileSync(path.join(stagingDirFor(out), 'otro.txt'), 'utf8')).toBe('no tocar');
    expect(foreignContent(path.join(tmp, 'no-existe'))).toBeUndefined();
  });

  it('cerrojo: un segundo proceso no puede publicar en la misma salida a la vez; un cerrojo huérfano se sustituye (PIPE-12)', () => {
    const res = path.join(tmp, 'locked');
    const release = acquireLock('test', res, 'La salida de prueba');
    try {
      expect(() => acquireLock('test', res, 'La salida de prueba')).toThrow(LockedError);
    } finally {
      release();
    }
    const again = acquireLock('test', res, 'La salida de prueba');
    again();
    // cerrojo de un proceso que ya no existe
    fs.writeFileSync(lockPathFor('test', res), JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), startedAt: new Date().toISOString() }));
    const third = acquireLock('test', res, 'La salida de prueba');
    third();
    expect(fs.existsSync(lockPathFor('test', res))).toBe(false);
  });

  it('swapDir sustituye con renombrados y recoverInterruptedSwap repara un cambio a medias', () => {
    const base = path.join(tmp, 'swap');
    const target = path.join(base, 'data');
    const staging = stagingDirFor(target);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'a.json'), 'viejo');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'a.json'), 'nuevo');
    swapDir(staging, target);
    expect(fs.readFileSync(path.join(target, 'a.json'), 'utf8')).toBe('nuevo');
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.existsSync(previousDirFor(target))).toBe(false);
    // proceso matado entre los dos renombrados: solo queda data.prev
    fs.renameSync(target, previousDirFor(target));
    recoverInterruptedSwap(target);
    expect(fs.readFileSync(path.join(target, 'a.json'), 'utf8')).toBe('nuevo');
    expect(fs.existsSync(previousDirFor(target))).toBe(false);
  });
});

describe('validateDataDir: cordura y seguridad', () => {
  it('los umbrales de producción rechazan un conjunto de datos demasiado pequeño', () => {
    const v = validateDataDir(outDir);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(/cordura: solo 4 competiciones con datos \(mínimo 15\)/);
    expect(v.errors.join('\n')).toMatch(/cordura: meta\.counts\.matchesAnalyzed/);
    expect(v.sanity.competitionsWithData).toBe(4);
    // con umbrales a medida pasa
    expect(validateDataDir(outDir, { sanity: { minCompetitionsWithData: 4, minMatchesAnalyzed: 100 } }).errors).toEqual([]);
    expect(DEFAULT_SANITY.minCompetitionsWithData).toBe(15);
  });

  it('rechaza portada sin partidos, textos con <script>/javascript:, logos no permitidos y archivos inesperados', () => {
    const dir = path.join(tmp, 'unsafe');
    fs.cpSync(outDir, dir, { recursive: true });
    const home = readJson<HomeFile>(dir, 'home.json');
    home.popular = [];
    home.today = [];
    home.tomorrow = [];
    home.recent = [];
    fs.writeFileSync(path.join(dir, 'home.json'), JSON.stringify(home));
    const meta = readJson<MetaFile>(dir, 'meta.json');
    meta.counts.upcomingMatches = 0;
    meta.teams[0].name = 'Equipo <script>alert(1)</script>';
    meta.teams[1].logo = 'http://a.espncdn.com/i/teamlogos/soccer/500/1.png';
    meta.teams[2].logo = 'https://evil.example.com/x.png';
    meta.competitions[0].name = 'javascript:alert(1)';
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
    const v = validateDataDir(dir, { sanity: { minCompetitionsWithData: 1, minMatchesAnalyzed: 1 } });
    const all = v.errors.join('\n');
    expect(all).toMatch(/home\.json no tiene ningún partido/);
    expect(all).toMatch(/teams\[0\]\.name: texto potencialmente peligroso/);
    expect(all).toMatch(/teams\[1\]\.logo: "http:\/\/a\.espncdn/);
    expect(all).toMatch(/teams\[2\]\.logo: "https:\/\/evil/);
    expect(all).toMatch(/competitions\[0\]\.name: texto potencialmente peligroso/);
    expect(all).toMatch(/archivo inesperado en la salida: index\.html/);
  });

  it('frescura (R4-01/PIPE-10): rechaza publicar si la última descarga correcta de ESPN tiene más de 72 h', () => {
    const dir = path.join(tmp, 'stale');
    fs.cpSync(outDir, dir, { recursive: true });
    const meta = readJson<MetaFile>(dir, 'meta.json');
    const lax = { minCompetitionsWithData: 1, minMatchesAnalyzed: 1 };
    meta.dataUpdatedAt = new Date(Date.parse(meta.generatedAt) - 10 * DAY).toISOString();
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
    expect(validateDataDir(dir, { sanity: lax }).errors.join('\n')).toMatch(/última descarga correcta de ESPN es de hace 240 h/);
    // --allow-stale
    expect(validateDataDir(dir, { sanity: { ...lax, maxDataAgeHours: Infinity } }).errors.join('\n')).not.toMatch(/descarga correcta/);
    meta.dataUpdatedAt = new Date(Date.parse(meta.generatedAt) - 3_600_000).toISOString();
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
    expect(validateDataDir(dir, { sanity: lax }).errors.join('\n')).not.toMatch(/descarga correcta/);
  });

  it('estados incoherentes con la fecha (PIPE-09): "en juego" de hace días o "terminado" en el futuro', () => {
    const dir = path.join(tmp, 'incoherent');
    fs.cpSync(outDir, dir, { recursive: true });
    const home = readJson<HomeFile>(dir, 'home.json');
    const gen = Date.parse(home.generatedAt);
    const m = home.popular[0] ?? home.today[0] ?? home.recent[0];
    home.recent = [
      { ...m, id: m.id, status: 'live', statusDetail: "67'", date: new Date(gen - 5 * DAY).toISOString(), score: { home: 1, away: 0 } },
      { ...m, id: m.id, status: 'finished', date: new Date(gen + 3 * DAY).toISOString(), score: { home: 3, away: 0 } },
    ];
    fs.writeFileSync(path.join(dir, 'home.json'), JSON.stringify(home));
    const all = validateDataDir(dir, { sanity: { minCompetitionsWithData: 1, minMatchesAnalyzed: 1 } }).errors.join('\n');
    expect(all).toMatch(/partido "en juego" con fecha .* incoherente/);
    expect(all).toMatch(/partido "terminado" con fecha .* incoherente/);
  });

  it('medias de liga coherentes (PIPE-14): local+empate+visitante suma 1 cuando hay partidos', () => {
    const dir = path.join(tmp, 'league-avg');
    fs.cpSync(outDir, dir, { recursive: true });
    const rel = 'competitions/liga-a.json';
    const c = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
    c.leagueAverages = { ...c.leagueAverages, homeWinPct: 0, drawPct: 0, awayWinPct: 0 };
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(c));
    expect(validateDataDir(dir, NO_SANITY).errors.join('\n')).toMatch(/goles por partido > 0 con local\/empate\/visitante a 0/);
  });

  it('campos nuevos del contrato: nextMatchDate, color en el índice, hasDetail en la forma y ajustes de valor', () => {
    const meta = readJson<MetaFile>(outDir, 'meta.json');
    const a = meta.competitions.find((c) => c.id === 'liga-a')!;
    // el próximo programado (up-a01, mañana); el que está en juego no cuenta
    expect(Date.parse(a.nextMatchDate!)).toBe(NOW.getTime() + DAY);
    expect(meta.competitions.find((c) => c.id === 'copa')!.nextMatchDate).toBeDefined();
    const withColor = meta.teams.filter((t) => t.color);
    expect(withColor.length).toBeGreaterThan(0);
    for (const t of withColor) expect(t.color).toMatch(/^[0-9a-f]{6}$/i);
    const value = readJson<ValueFile>(outDir, 'value.json');
    expect(value.kellyCap).toBe(0.05);
    expect(value.minProb).toBe(0.12);
    expect(value.maxOdds).toBe(8);
    const detailIds = new Set(fs.readdirSync(path.join(outDir, 'matches')).map((f) => f.replace('.json', '')));
    let flagged = 0;
    for (const f of fs.readdirSync(path.join(outDir, 'teams'))) {
      const team = readJson<TeamFile>(outDir, `teams/${f}`);
      for (const m of [...team.matches, ...team.form.last]) {
        expect(!!m.hasDetail).toBe(detailIds.has(m.matchId));
        if (m.hasDetail) flagged++;
      }
    }
    expect(flagged).toBeGreaterThan(0);
  });
});

describe('validateDataDir', () => {
  it('detecta probabilidades fuera de rango, sumas 1X2 incorrectas, null y referencias rotas', () => {
    const dir = path.join(tmp, 'broken');
    fs.cpSync(outDir, dir, { recursive: true });
    const rel = 'matches/up-a01.json';
    const f = readJson<MatchFile>(dir, rel) as unknown as Record<string, any>;
    f.match.prediction.p.home = 1.4;
    f.markets[0].selections[0].fairOdds = null;
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(f));
    fs.rmSync(path.join(dir, 'matches/up-b01.json'));
    const v = validateDataDir(dir, NO_SANITY);
    expect(v.ok).toBe(false);
    const all = v.errors.join('\n');
    expect(all).toMatch(/up-a01\.json: \$\.match\.prediction\.p\.home: 1\.4 > 1/);
    expect(all).toMatch(/1X2 suma/);
    expect(all).toMatch(/null\/NaN\/Infinity/);
    expect(all).toMatch(/hasDetail=true sin matches\/up-b01\.json/);
  });

  it('detecta archivos raíz ausentes y compId desconocidos', () => {
    const dir = path.join(tmp, 'broken2');
    fs.cpSync(outDir, dir, { recursive: true });
    fs.rmSync(path.join(dir, 'value.json'));
    const c = readJson<CompetitionFile>(dir, 'competitions/copa.json');
    c.upcoming[0].compId = 'inexistente';
    fs.writeFileSync(path.join(dir, 'competitions/copa.json'), JSON.stringify(c));
    const v = validateDataDir(dir, NO_SANITY);
    expect(v.errors).toContain('value.json: archivo ausente');
    expect(v.errors.join('\n')).toMatch(/compId desconocido "inexistente"/);
  });
});

// ---------------------------------------------------------------------------
// Unidades
// ---------------------------------------------------------------------------

const T = (id: string): TeamRef => ({ id, name: id, short: id, abbr: id });
const row = (id: string, rank: number, played: number) => ({ rank, team: T(id), played, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0 });
const rec = (id: string, h: string, a: string, status: MatchRecord['status']): MatchRecord => ({
  id,
  compId: 'x',
  season: 2026,
  currentSeason: true,
  date: '2026-11-01T18:00:00Z',
  status,
  home: T(h),
  away: T(a),
  ...(status === 'finished' ? { score: { home: 1, away: 0 } } : {}),
});

describe('remainingFixtures', () => {
  it('doble vuelta: completa los pares ordenados sin partido y descarta duplicados de pares ya jugados', () => {
    const teams = ['a', 'b', 'c', 'd'];
    const group: StandingGroup = { name: 'G', rows: teams.map((t, i) => row(t, i + 1, 0)) };
    const ms = [rec('1', 'a', 'b', 'finished'), rec('2', 'c', 'd', 'scheduled'), rec('3', 'a', 'b', 'postponed'), rec('4', 'b', 'a', 'cancelled')];
    group.rows[0].played = 1;
    group.rows[1].played = 1;
    const r = remainingFixtures(group, ms, { kind: 'double-rr' });
    // 12 pares ordenados − 1 jugado = 11 pendientes; 1 real (c-d) + 10 sintéticos
    expect(r.fixtures).toHaveLength(11);
    expect(r.synthetic).toBe(10);
    expect(r.fixtures.some((f) => f.home === 'a' && f.away === 'b')).toBe(false);
    expect(r.fixtures.find((f) => f.home === 'c' && f.away === 'd')?.match?.id).toBe('2');
    expect(r.fixtures.some((f) => f.home === 'b' && f.away === 'a')).toBe(true);
  });

  it('sin formato: solo partidos reales pendientes entre equipos del grupo', () => {
    const group: StandingGroup = { name: 'G', rows: ['a', 'b', 'c'].map((t, i) => row(t, i + 1, 1)) };
    const r = remainingFixtures(group, [rec('1', 'a', 'b', 'scheduled'), rec('2', 'a', 'z', 'scheduled'), rec('3', 'b', 'c', 'live')], undefined);
    expect(r.fixtures.map((f) => f.match?.id).sort()).toEqual(['1', '3']);
    expect(r.synthetic).toBe(0);
  });

  it('fase de liga: completa hasta N partidos por equipo sin repetir rival', () => {
    const teams = ['a', 'b', 'c', 'd', 'e', 'f'];
    const group: StandingGroup = { name: 'Fase de liga', rows: teams.map((t, i) => row(t, i + 1, 1)) };
    const ms = [rec('1', 'a', 'b', 'finished'), rec('2', 'c', 'd', 'finished'), rec('3', 'e', 'f', 'finished')];
    const r = remainingFixtures(group, ms, { kind: 'league-phase', matchesPerTeam: 4 }, { seed: 5 });
    expect(r.synthetic).toBe(9);
    const count = new Map<string, number>();
    const pairs = new Set(['a|b', 'c|d', 'e|f']);
    for (const f of r.fixtures) {
      count.set(f.home, (count.get(f.home) ?? 0) + 1);
      count.set(f.away, (count.get(f.away) ?? 0) + 1);
      const k = [f.home, f.away].sort().join('|');
      expect(pairs.has(k)).toBe(false);
      pairs.add(k);
    }
    for (const t of teams) expect(count.get(t)).toBe(3);
  });
});

describe('utilidades', () => {
  it('sanitizePublishedString: URLs solo https en espncdn y textos sin <script>/javascript:', () => {
    expect(sanitizePublishedString('http://a.espncdn.com/i/x.png')).toBe('https://a.espncdn.com/i/x.png');
    expect(sanitizePublishedString('https://a.espncdn.com/i/x.png')).toBe('https://a.espncdn.com/i/x.png');
    expect(sanitizePublishedString('https://evil.example.com/x.png')).toBeUndefined();
    expect(sanitizePublishedString('javascript://alert(1)')).toBeUndefined();
    expect(sanitizePublishedString('Equipo <script>x</script>')).not.toMatch(/<\s*script/i);
    expect(sanitizePublishedString('javascript:alert(1)')).not.toMatch(/javascript\s*:/i);
    expect(sanitizePublishedString('defensa > 1 = encaja más')).toBe('defensa > 1 = encaja más');
    expect(sanitizePublishedString('a\u0000b\u202Ec')).toBe('abc');
    // anidamientos que una sola pasada dejaba pasar (PIPE-08)
    for (const t of ['<<script>alert(1)</script>', '<< script>', 'javajavascript:script:alert(1)', 'vbvbscript:script:x', '<<<script<script>>']) {
      expect(sanitizePublishedString(t)).not.toMatch(/<\s*script|(?:java|vb)script\s*:/i);
    }
    // un string no permitido dentro de un array se sustituye por '' (no por 0: rompería string[])
    expect(cleanJson({ a: ['ok', 'https://evil.example/x', 3] })).toEqual({ a: ['ok', '', 3] });
    const stats = newCleanStats();
    const out = cleanJson({ logo: 'https://evil.example.com/x.png', name: 'ok' }, 4, stats);
    expect(out).toEqual({ name: 'ok' });
    expect(stats.droppedKeys).toBe(1);
  });

  it('cleanJson redondea, elimina claves no finitas y pone 0 en arrays', () => {
    const stats = newCleanStats();
    const out = cleanJson({ a: 1.23456789, b: NaN, c: [1, Infinity, 0.5], d: { e: undefined, f: null, g: 2 } }, 4, stats);
    expect(out).toEqual({ a: 1.2346, c: [1, 0, 0.5], d: { g: 2 } });
    expect(stats.droppedKeys).toBe(2);
    expect(stats.zeroedItems).toBe(1);
  });

  it('localDay y nextDay usan el día local de Madrid', () => {
    expect(localDay(Date.parse('2026-11-02T23:30:00Z'), 'Europe/Madrid')).toBe('2026-11-03');
    expect(localDay(Date.parse('2026-07-01T21:59:00Z'), 'Europe/Madrid')).toBe('2026-07-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
  });
});
