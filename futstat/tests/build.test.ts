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
  ConfidenceFile,
  DailyFile,
  HomeFile,
  LongshotFile,
  MatchFile,
  MetaFile,
  ModelFile,
  OddsSnapshot,
  PlayerProp,
  PlayersFile,
  StandingGroup,
  TeamFile,
  TeamRef,
  ValueFile,
  Combo6File,
} from '../src/types/data';
import { mulberry32, outcomeProbs, samplePoisson, scoreMatrix } from '../src/lib/models';
import type { CompetitionConfig } from '../pipeline/config';
import type { CompetitionStore, MatchRecord, PlayerLine } from '../pipeline/types';
import { PublishRejectedError, runBuild, stagingDirFor, type BuildReport } from '../pipeline/build';
import {
  CONFIDENCE_FAMILIES,
  FAMILY_BY_ID,
  settleCandidate,
  type ConfidenceFamily,
  type ConfidenceHistoryItem,
  type ConfidenceSegment,
  type ConfidenceSettle,
  type SettledCandidate,
} from '../pipeline/analytics/confidence';
import { familyRows, publicPick, slimSummary, validatedOutOfSample } from '../pipeline/publish/confidence';
import { historyItem, type LongshotHistoryItem } from '../pipeline/analytics/longshots';
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

  it('factores del partido en todas las fichas: corte en el inicio, árbitro y notas (validados por el contrato)', () => {
    const files = fs.readdirSync(path.join(outDir, 'matches'));
    for (const file of files) {
      const f = readJson<MatchFile>(outDir, `matches/${file}`);
      expect(f.factors, file).toBeDefined();
      expect(Date.parse(f.factors!.asOf)).toBe(Date.parse(f.match.date));
      expect(['conocido', 'no publicado']).toContain(f.factors!.referee.status);
      expect(f.factors!.notes.length).toBeGreaterThan(0);
      // un sancionado probable (minutos × 0) nunca aparece en las props publicadas
      for (const side of ['home', 'away'] as const) {
        const out = new Set((f.factors!.absences?.[side] ?? []).filter((a) => a.minutesFactor === 0).map((a) => a.playerId));
        expect(f.players[side].some((p) => out.has(p.player.id)), file).toBe(false);
      }
    }
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

  it('cuota alta 6+ sin historial: longshots.json válido, con los días pero sin apuestas ni récord, aviso +18 y sin resumen en portada', () => {
    const f = readJson<LongshotFile>(outDir, 'longshots.json');
    expect(f.minOdds).toBe(6);
    expect(f.days.length).toBeGreaterThan(0);
    expect(f.days.length).toBeLessThanOrEqual(4);
    for (const d of f.days) expect(d.bets).toEqual([]);
    expect(f.track.byKind).toEqual([]);
    expect(f.track.calibration).toEqual([]);
    expect(f.note).toMatch(/la mayoría PIERDEN/);
    expect(f.note).toMatch(/no se publica ninguna recomendación\./);
    expect(f.note).not.toMatch(/\.:/);
    expect(f.note).toMatch(/18/);
    expect(readJson<HomeFile>(outDir, 'home.json').longshot).toBeUndefined();
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

// ---------------------------------------------------------------------------
// Pronósticos de alta confianza
// ---------------------------------------------------------------------------

/** Candidato resuelto sintético (hándicap +1,5 del local o «el visitante marca menos de 3»). */
function synthCand(family: ConfidenceFamily, segment: ConfidenceSegment, prob: number, result: SettledCandidate['result']): SettledCandidate {
  const ah = family === 'ah+1.5';
  const settle: ConfidenceSettle = ah ? { kind: 'handicap', side: 'home', line: 1.5 } : { kind: 'team-total', team: 'away', side: 'under', line: 2.5 };
  return {
    family,
    theme: FAMILY_BY_ID.get(family)!.theme,
    marketId: ah ? 'ah-home-1.5' : 'team-away-ou-2.5',
    market: ah ? 'Hándicap asiático Local +1.5' : 'Goles de Visitante: más/menos 2.5',
    selection: ah ? 'Local +1.5' : 'Visitante marca menos de 3 goles',
    prob,
    fairOdds: 1 / prob,
    settle,
    segment,
    result,
  };
}

/**
 * Historial walk-forward inyectado (el mundo sintético no tiene 300 partidos previos a la temporada, así que el motor no
 * puede reconstruirlo): 2.400 partidos ficticios calibrados (acierto = probabilidad) para dos familias y ambas fuentes
 * (más de los 1.000 que necesita el walk-forward mensual para validar las reglas) y, al final, los partidos terminados
 * reales de las últimas 2 semanas, resueltos con su marcador.
 */
function confidenceTestHistory(stores: CompetitionStore[]): ConfidenceHistoryItem[] {
  const rng = mulberry32(2026);
  const fams: [ConfidenceFamily, ConfidenceSegment][] = [
    ['ah+1.5', 'mercado'],
    ['ah+1.5', 'estadistico'],
    ['team-under-2.5', 'mercado'],
    ['team-under-2.5', 'estadistico'],
  ];
  const items: ConfidenceHistoryItem[] = [];
  for (let i = 0; i < 2400; i++) {
    items.push({
      matchId: `hist-${i}`,
      compId: 'liga-a',
      date: new Date(NOW.getTime() - (400 - i * 0.1575) * DAY).toISOString(),
      home: 'Local',
      away: 'Visitante',
      score: { home: 1, away: 0 },
      candidates: fams.map(([f, seg]) => {
        const p = 0.6 + rng() * 0.33;
        return synthCand(f, seg, p, rng() < p ? 'hit' : 'miss');
      }),
      // selección natural de cada familia sin umbral (tasa base)
      base: { 'ah+1.5': rng() < 0.88 ? 'hit' : 'miss', 'team-under-2.5': rng() < 0.87 ? 'hit' : 'miss' },
    });
  }
  for (const s of stores) {
    for (const m of s.matches) {
      if (m.status !== 'finished' || !m.score || !m.currentSeason || !(Date.parse(m.date) > NOW.getTime() - 13 * DAY)) continue;
      const d = { hg: m.score.home, ag: m.score.away };
      const c = synthCand('ah+1.5', 'mercado', 0.91, 'hit');
      items.push({ matchId: m.id, compId: m.compId, date: m.date, home: m.home.name, away: m.away.name, score: m.score, candidates: [{ ...c, result: settleCandidate(c, d)! }] });
    }
  }
  return items.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.matchId.localeCompare(b.matchId));
}

/** Familias adicionales del apartado diario usadas en el historial sintético (resolución: la real de cada una). */
const EXTRA_TEST_FAMILIES: [ConfidenceFamily, ConfidenceSettle, string][] = [
  ['shots-over-19.5', { kind: 'stat', stat: 'shots', side: 'over', line: 19.5 }, 'Más de 19.5 tiros'],
  ['sot-under-12.5', { kind: 'stat', stat: 'shotsOnTarget', side: 'under', line: 12.5 }, 'Menos de 12.5 tiros a puerta'],
  ['sot-team-over-2.5', { kind: 'stat', stat: 'shotsOnTarget', team: 'home', side: 'over', line: 2.5 }, 'Local: más de 2.5 tiros a puerta'],
  ['fouls-under-29.5', { kind: 'stat', stat: 'fouls', side: 'under', line: 29.5 }, 'Menos de 29.5 faltas'],
  ['fouls-under-31.5', { kind: 'stat', stat: 'fouls', side: 'under', line: 31.5 }, 'Menos de 31.5 faltas'],
  ['player-shot-1', { kind: 'player', playerId: 'x', stat: 'shots', min: 1 }, 'Jugador: al menos 1 tiro'],
];

/**
 * Historial de las familias adicionales para los MISMOS partidos (y orden) que confidenceTestHistory: en los ficticios,
 * candidatos de las dos fuentes de un modelo algo prudente (acierto = probabilidad + 0,07, así el umbral queda bajo y
 * los partidos próximos del mundo sintético lo superan); los props tienen un 6 % de nulos (el jugador no juega).
 */
function dailyExtraTestHistory(base: ConfidenceHistoryItem[]): ConfidenceHistoryItem[] {
  const rng = mulberry32(777);
  return base.map((it) => {
    if (!it.matchId.startsWith('hist-')) return { ...it, candidates: [], base: {} };
    const candidates: SettledCandidate[] = [];
    const natural: Partial<Record<ConfidenceFamily, SettledCandidate['result']>> = {};
    for (const [family, settle, selection] of EXTRA_TEST_FAMILIES) {
      for (const segment of ['mercado', 'estadistico'] as const) {
        const prob = 0.6 + rng() * 0.33;
        const isPlayer = settle.kind === 'player';
        const result: SettledCandidate['result'] = isPlayer && rng() < 0.06 ? 'void' : rng() < prob + 0.07 ? 'hit' : 'miss';
        candidates.push({ family, theme: FAMILY_BY_ID.get(family)!.theme, marketId: `${family}-${segment}`, market: selection, selection, prob, fairOdds: 1 / prob, settle, segment, result });
      }
      natural[family] = rng() < 0.84 ? 'hit' : 'miss';
    }
    return { ...it, candidates, base: natural };
  });
}

/**
 * Historial sintético de «Cuota alta 6+» (1-jun → 19-nov de 2025, 6 partidos al día): cuotas con un 6 % de margen sobre
 * las probabilidades verdaderas (las del modelo), marcador simulado y un goleador por equipo; así el ROI esperado es
 * negativo y cada tipo tiene muestra suficiente.
 */
function longshotTestHistory(): LongshotHistoryItem[] {
  const rng = mulberry32(4242);
  const out: LongshotHistoryItem[] = [];
  const price = (p: number) => Math.round((0.94 / p) * 100) / 100;
  const scorer = (id: string, teamId: string, pGoal: number): PlayerProp => ({
    player: { id, name: `Delantero ${id}`, short: `D. ${id}`, position: 'F', teamId },
    apps: 14,
    minutes: 1100,
    goals: 4,
    assists: 1,
    expMinutes: 80,
    formIndex: 55,
    pGoal,
    pAssist: 0.1,
    pGoalOrAssist: 0.2,
    pShots1: 0.8,
    pShots2: 0.5,
    pSot1: 0.5,
    pSot2: 0.2,
    pCard: 0.1,
  });
  const start = Date.UTC(2025, 5, 2, 18);
  for (let d = 0; d < 170; d++) {
    for (let k = 0; k < 6; k++) {
      const lh = 0.9 + rng() * 1.5;
      const la = 0.5 + rng() * 1.2;
      const matrix = scoreMatrix(lh, la, -0.05);
      const p = outcomeProbs(matrix);
      let under = 0;
      for (let i = 0; i < matrix.length; i++) for (let j = 0; j < matrix[i].length; j++) if (i + j <= 2) under += matrix[i][j];
      const odds: OddsSnapshot = { provider: 'Test', home: price(p.home), draw: price(p.draw), away: price(p.away), totalLine: 2.5, over: price(1 - under), under: price(under) };
      const hg = samplePoisson(lh, rng);
      const ag = samplePoisson(la, rng);
      const home = TEAMS_A[(d + k) % TEAMS_A.length].ref;
      const away = TEAMS_B[(d * 3 + k) % TEAMS_B.length].ref;
      const ps = [scorer(`h${k}`, home.id, 0.1 + rng() * 0.06), scorer(`a${k}`, away.id, 0.1 + rng() * 0.06)];
      const lines = new Map(ps.map((x) => [x.player.id, { minutes: rng() < 0.05 ? 0 : 85, shots: 2, shotsOnTarget: 1, goals: rng() < x.pGoal ? 1 : 0 }]));
      out.push(
        historyItem(
          { matchId: `ls-${d}-${k}`, compId: 'liga-a', compName: 'Liga A', date: new Date(start + d * DAY + k * 3_600_000).toISOString(), home, away, tier: 8, p, matrix, odds, lambdaHome: lh, lambdaAway: la, withMarket: true, players: { home: [ps[0]], away: [ps[1]] } },
          { hg, ag, players: lines },
        ),
      );
    }
  }
  return out;
}

describe('alta confianza (build)', () => {
  it('sin historial suficiente: confidence.json vacío pero válido, sin cifras en portada y la sección de metodología lo dice', () => {
    const c = readJson<ConfidenceFile>(outDir, 'confidence.json');
    expect(c.picks).toEqual([]);
    expect(c.recent).toEqual([]);
    expect(c.track.holdout.n).toBe(0);
    expect(c.track.byFamily.length).toBe(23);
    expect(c.rules.maxPerMatch).toBe(2);
    expect(c.note).toMatch(/Todavía no hay partidos suficientes/);
    const home = readJson<HomeFile>(outDir, 'home.json');
    expect(home.topConfidence).toEqual([]);
    expect(home.confidenceHeadline).toBeUndefined();
    const model = readJson<ModelFile>(outDir, 'model.json');
    const sec = model.sections.find((x) => x.title === 'Pronósticos de alta confianza');
    expect(sec?.body.join(' ')).toMatch(/Todavía no hay suficientes partidos/);
  });

  it('sin historial suficiente: daily.json válido, con los días pero sin picks ni cifras, y sin resumen en portada', () => {
    const d = readJson<DailyFile>(outDir, 'daily.json');
    expect(d.categories.map((c) => c.id)).toEqual(['resultado', 'goles', 'tiros', 'corners', 'tarjetas', 'faltas', 'jugadores']);
    expect(d.days.length).toBeGreaterThan(0);
    expect(d.days.length).toBeLessThanOrEqual(4);
    for (const day of d.days) {
      expect(day.matches).toEqual([]);
      expect(day.top).toEqual([]);
      expect(day.combos).toEqual([]);
      expect(day.counts.matchesAnalyzed).toBeGreaterThan(0);
    }
    expect(d.track.overall.n).toBe(0);
    expect(d.track.byCategory).toEqual([]);
    expect(d.note).toMatch(/Juego responsable, solo mayores de 18 años/);
    expect(readJson<HomeFile>(outDir, 'home.json').daily).toBeUndefined();
  });

  describe('con historial', () => {
    let dir: string;
    let stores: CompetitionStore[];
    beforeAll(() => {
      dir = path.join(tmp, 'conf');
      stores = testStores();
      const history = confidenceTestHistory(stores);
      runBuild({
        stores,
        configs: CONFIGS,
        now: NOW,
        outDir: dir,
        fast: true,
        log: () => {},
        validate: NO_SANITY,
        confidenceHistory: history,
        dailyExtraHistory: dailyExtraTestHistory(history),
        longshotHistory: longshotTestHistory(),
      });
    });

    it('pasa la validación del contrato', () => {
      const v = validateDataDir(dir, NO_SANITY);
      expect(v.errors).toEqual([]);
    });

    it('picks próximos: ordenados por fecha, como mucho 2 por partido de temas distintos y por encima de su umbral', () => {
      const c = readJson<ConfidenceFile>(dir, 'confidence.json');
      expect(c.picks.length).toBeGreaterThan(0);
      expect(c.rules.active).toBeGreaterThan(0);
      const byMatch = new Map<string, string[]>();
      for (let i = 0; i < c.picks.length; i++) {
        const { match, pick } = c.picks[i];
        if (i) expect(Date.parse(match.date)).toBeGreaterThanOrEqual(Date.parse(c.picks[i - 1].match.date));
        expect(match.status).toBe('scheduled');
        expect(match.prediction).toBeUndefined(); // ficha compacta (sin predicción ni cuotas)
        expect(pick.prob).toBeGreaterThanOrEqual(pick.threshold! - 1e-9);
        expect(pick.fairOdds).toBeCloseTo(1 / pick.prob, 2);
        // solo nivel oro y solo reglas validadas fuera de muestra (walk-forward: >= 30 picks y >= 80 %)
        expect(pick.tier).toBe('oro');
        expect(pick.historicalHitRate).toBeGreaterThanOrEqual(0.85);
        expect(['ah+1.5', 'team-under-2.5']).toContain(pick.family);
        expect(pick.validationN).toBeGreaterThanOrEqual(30);
        expect(pick.validationHitRate).toBeGreaterThanOrEqual(0.8);
        expect(pick.validationWilsonLow!).toBeLessThanOrEqual(pick.validationHitRate!);
        byMatch.set(match.id, [...(byMatch.get(match.id) ?? []), FAMILY_BY_ID.get(pick.family as ConfidenceFamily)!.theme]);
      }
      for (const themes of byMatch.values()) {
        expect(themes.length).toBeLessThanOrEqual(2);
        expect(new Set(themes).size).toBe(themes.length);
      }
    });

    it('fichas de partido y tarjetas: MatchFile.confidence y prediction.safe = el primer pick', () => {
      const c = readJson<ConfidenceFile>(dir, 'confidence.json');
      const ids = [...new Set(c.picks.map((p) => p.match.id))];
      for (const id of ids) {
        const f = readJson<MatchFile>(dir, `matches/${id}.json`);
        const mine = c.picks.filter((p) => p.match.id === id).map((p) => p.pick.selection);
        expect(f.confidence?.map((p) => p.selection).sort()).toEqual(mine.sort());
        expect(f.match.prediction?.safe?.selection).toBe(f.confidence![0].selection);
        expect(f.confidence!.every((p) => p.result === undefined)).toBe(true);
      }
      const comp = readJson<CompetitionFile>(dir, 'competitions/liga-a.json');
      const withSafe = comp.upcoming.filter((m) => m.prediction?.safe);
      expect(withSafe.length).toBeGreaterThan(0);
      for (const m of withSafe) expect(ids).toContain(m.id);
    });

    it('resueltos recientes (walk-forward): partidos terminados de 14 días con ✓/✗ coherente con el marcador', () => {
      const c = readJson<ConfidenceFile>(dir, 'confidence.json');
      expect(c.recent.length).toBeGreaterThan(0);
      for (let i = 0; i < c.recent.length; i++) {
        const r = c.recent[i];
        if (i) expect(Date.parse(r.match.date)).toBeLessThanOrEqual(Date.parse(c.recent[i - 1].match.date));
        expect(r.match.status).toBe('finished');
        expect(Date.parse(r.match.date)).toBeGreaterThan(NOW.getTime() - 14 * DAY);
        const s = r.match.score!;
        const expected = s.home - s.away + 1.5 > 0 ? 'hit' : 'miss';
        expect(r.pick.result).toBe(expected);
        expect(r.hit).toBe(expected === 'hit');
      }
      // la ficha de un terminado reciente lleva su reconstrucción ya resuelta
      const detail = c.recent.find((r) => r.match.hasDetail);
      if (detail) {
        const f = readJson<MatchFile>(dir, `matches/${detail.match.id}.json`);
        expect(f.confidence?.[0].result).toBe(detail.pick.result);
      }
    });

    it('cifras honestas: holdout coherente, por nivel y familia, portada y metodología con las mismas cifras', () => {
      const c = readJson<ConfidenceFile>(dir, 'confidence.json');
      const h = c.track.holdout;
      expect(h.n).toBeGreaterThan(100);
      expect(h.hitRate).toBeCloseTo(h.hits / h.n, 3);
      expect(h.wilsonLow!).toBeLessThanOrEqual(h.hitRate);
      expect(h.wilsonHigh!).toBeGreaterThanOrEqual(h.hitRate);
      expect(Date.parse(c.track.calibration!.to)).toBeLessThan(Date.parse(h.from));
      expect(c.track.byTier.map((x) => x.tier)).toEqual(['oro']);
      expect(c.track.byTier.reduce((t, x) => t + x.n, 0)).toBe(h.n);
      expect(c.rules.minHitRate).toBe(0.85);
      expect(c.rules.validation).toEqual({ minN: 30, minRate: 0.8 });
      // contexto honesto: línea base sin modelo en los mismos partidos, tasa base esperada, lift y walk-forward
      const b = c.track.baseline!;
      expect(b.label).toMatch(/visitante marca menos de 3/);
      expect(b.n).toBeGreaterThan(0);
      expect(b.hitRate).toBeCloseTo(b.hits / b.n, 3);
      expect(c.track.lift).toBeCloseTo(h.hitRate - c.track.expectedBaseRate!, 3);
      const wf = c.track.walkForward!;
      expect(wf.n).toBeGreaterThan(0);
      expect(wf.folds.reduce((t, f) => t + f.n, 0)).toBe(wf.n);
      expect(c.track.excluded!.map((x) => x.family)).toEqual(['cards-over-2.5']);
      const ah = c.track.byFamily.find((f) => f.family === 'ah+1.5')!;
      expect(ah.active).toBe(true);
      expect(ah.thresholds.length).toBeGreaterThan(0);
      expect(new Set(ah.thresholds.map((t) => t.source)).size).toBe(ah.thresholds.length);
      expect(ah.threshold).toBe(Math.min(...ah.thresholds.map((t) => t.threshold)));
      const btts = c.track.byFamily.find((f) => f.family === 'btts-yes')!;
      expect(btts.active).toBe(false);
      expect(btts.hitRate).toBeUndefined();
      expect(btts.note).toMatch(/No se publica/);
      const home = readJson<HomeFile>(dir, 'home.json');
      expect(home.confidenceHeadline).toMatchObject({ hitRate: h.hitRate, picks: h.n, hits: h.hits, upcoming: c.picks.length, baselineRate: b.hitRate });
      expect(home.confidenceHeadline!.wilsonLow).toBeCloseTo(h.wilsonLow!, 4);
      expect(home.topConfidence!.length).toBeLessThanOrEqual(8);
      expect(new Set(home.topConfidence!.map((x) => x.match.id)).size).toBe(home.topConfidence!.length);
      for (const x of home.topConfidence!) {
        expect(Date.parse(x.match.date)).toBeLessThanOrEqual(NOW.getTime() + 72 * 3_600_000);
        expect(validatedOutOfSample(x.pick)).toBe(true);
      }
      const model = readJson<ModelFile>(dir, 'model.json');
      const body = model.sections.find((x) => x.title === 'Pronósticos de alta confianza')!.body.join(' ');
      expect(body).toContain(`(${h.hits.toLocaleString('es-ES')}/${h.n.toLocaleString('es-ES')}; Wilson 90 %`);
      expect(body).toContain(`(${b.hits.toLocaleString('es-ES')}/${b.n.toLocaleString('es-ES')}; Wilson 90 %`);
      expect(body).toMatch(/alto acierto NO es beneficio/);
      expect(body).toMatch(/estrategia fija SIN modelo/);
      expect(body).toMatch(/marca de tiempo, así que esa marca no demuestra/);
      expect(body).toMatch(/Fugas residuales mínimas/);
    });

    // ---- pronósticos del día (daily.json): las familias adicionales NO cambian confidence.json (los tests de arriba
    // siguen exigiendo solo sus dos familias) y alimentan únicamente el apartado diario
    it('daily.json: días ordenados, picks validados (máx. 2 por categoría y 8 por partido), análisis y cifras esperadas', () => {
      const d = readJson<DailyFile>(dir, 'daily.json');
      const today = localDay(NOW.getTime(), 'Europe/Madrid');
      expect(d.days.length).toBeGreaterThan(0);
      expect(d.days.length).toBeLessThanOrEqual(4);
      const categories = new Set<string>();
      let players = 0;
      d.days.forEach((day, i) => {
        if (i) expect(day.date > d.days[i - 1].date).toBe(true);
        expect(day.date >= today).toBe(true);
        expect(day.counts.matches).toBe(day.matches.length);
        expect(day.counts.picks).toBe(day.matches.reduce((n, m) => n + m.picks.length, 0));
        expect(day.counts.matchesAnalyzed).toBeGreaterThanOrEqual(day.matches.length);
        for (const m of day.matches) {
          expect(['scheduled', 'live', 'finished']).toContain(m.match.status);
          if (m.match.status === 'scheduled') expect(localDay(Date.parse(m.match.date), 'Europe/Madrid')).toBe(day.date);
          expect(m.picks.length).toBeGreaterThan(0);
          expect(m.picks.length).toBeLessThanOrEqual(8);
          expect(m.analysis.length).toBeGreaterThanOrEqual(2);
          expect(m.analysis.length).toBeLessThanOrEqual(5);
          expect(m.analysis[0]).toMatch(/Goles esperados/);
          expect(m.expected.goals.total).toBeCloseTo(m.expected.goals.home + m.expected.goals.away, 1);
          expect(m.expected.shotsOnTarget!.total).toBeGreaterThan(3);
          const perCat = new Map<string, number>();
          m.picks.forEach((p, k) => {
            if (k) expect(p.score!).toBeLessThanOrEqual(m.picks[k - 1].score!);
            perCat.set(p.category, (perCat.get(p.category) ?? 0) + 1);
            categories.add(p.category);
            expect(p.category).toBe(FAMILY_BY_ID.get(p.family as ConfidenceFamily)!.theme);
            expect(p.tier).toBe('oro');
            expect(p.historicalHitRate).toBeGreaterThanOrEqual(0.85);
            expect(p.prob).toBeGreaterThanOrEqual(p.threshold! - 1e-9);
            expect(p.score).toBeGreaterThanOrEqual(0);
            expect(p.score).toBeLessThanOrEqual(100);
            if (m.match.status !== 'finished') {
              expect(p.result).toBeUndefined();
              expect(p.validationN).toBeGreaterThanOrEqual(30);
              expect(p.validationHitRate).toBeGreaterThanOrEqual(0.8);
              expect(p.reason!.length).toBeGreaterThan(20);
              if (p.lift !== undefined) expect(p.lift).toBeCloseTo(p.validationHitRate! - p.baseRate!, 4);
            } else expect(['hit', 'miss', 'void']).toContain(p.result);
            if (p.category === 'jugadores') {
              players++;
              expect(p.player!.name.length).toBeGreaterThan(0);
              expect(p.marketId).toBe(`player-${p.player!.id}-shots-1`);
              expect(p.selection).toContain(p.player!.name);
              expect(p.reason).toMatch(/tiros/);
            } else expect(p.player).toBeUndefined();
          });
          for (const n of perCat.values()) expect(n).toBeLessThanOrEqual(2);
          expect(new Set(m.picks.map((p) => `${p.family}|${p.marketId}|${p.selection}`)).size).toBe(m.picks.length);
        }
      });
      // familias existentes y adicionales conviven en el apartado diario
      expect(categories.has('resultado') || categories.has('goles')).toBe(true);
      expect(['tiros', 'faltas', 'jugadores'].some((c) => categories.has(c))).toBe(true);
      for (const cat of ['tiros', 'faltas', 'jugadores']) expect(categories.has(cat)).toBe(true);
      expect(players).toBeGreaterThan(0);
      // hoy: el partido EN JUEGO conserva sus picks (calculados como antes del saque, sin resultado) fuera de top y combinadas
      const live = d.days[0].matches.find((m) => m.match.id === 'live-a67')!;
      expect(live.match.status).toBe('live');
      expect(live.match.score).toEqual({ home: 1, away: 0 });
      expect(live.picks.length).toBeGreaterThan(0);
      expect(live.picks.every((p) => p.result === undefined && p.source === 'estadistico')).toBe(true); // sin cuota previa al saque
      expect(d.days[0].top.some((t) => t.matchId === 'live-a67')).toBe(false);
      expect(d.days[0].combos.some((c) => c.legs.some((l) => l.matchId === 'live-a67'))).toBe(false);
      // hoy: un partido ya terminado aparece con sus picks reconstruidos walk-forward y resueltos
      const settled = d.days[0].matches.filter((m) => m.match.status === 'finished');
      expect(d.days[0].date).toBe(today);
      expect(settled.length).toBeGreaterThan(0);
      for (const m of settled) {
        expect(localDay(Date.parse(m.match.date), 'Europe/Madrid')).toBe(today);
        const sc = m.match.score!;
        for (const p of m.picks) if (p.family === 'ah+1.5') expect(p.result).toBe(sc.home - sc.away + 1.5 > 0 ? 'hit' : 'miss');
      }
      // ...pero confidence.json no cambia de alcance
      const c = readJson<ConfidenceFile>(dir, 'confidence.json');
      const baseIds = new Set<string>(CONFIDENCE_FAMILIES.map((f) => f.id));
      expect(c.picks.every((x) => baseIds.has(x.pick.family))).toBe(true);
      expect(c.track.byFamily.map((f) => f.family)).toEqual(CONFIDENCE_FAMILIES.map((f) => f.id));
    });

    it('daily.json: top (uno por partido, por puntuación), combinadas de partidos distintos con prob = producto, y portada', () => {
      const d = readJson<DailyFile>(dir, 'daily.json');
      const withTop = d.days.filter((x) => x.top.length > 0);
      expect(withTop.length).toBeGreaterThan(0);
      for (const day of d.days) {
        const open = new Map(day.matches.filter((m) => m.match.status === 'scheduled' && Date.parse(m.match.date) > NOW.getTime()).map((m) => [m.match.id, m]));
        expect(day.top.length).toBe(Math.min(10, open.size));
        expect(new Set(day.top.map((t) => t.matchId)).size).toBe(day.top.length);
        day.top.forEach((t, i) => {
          if (i) expect(t.pick.score!).toBeLessThanOrEqual(day.top[i - 1].pick.score!);
          expect(open.get(t.matchId)!.picks.some((p) => p.family === t.pick.family && p.selection === t.pick.selection)).toBe(true);
        });
        const ids = day.combos.map((x) => x.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const combo of day.combos) {
          const [min, max] = combo.id === 'segura' ? [2, 2] : combo.id === 'equilibrada' ? [3, 3] : [4, 5];
          expect(combo.legs.length).toBeGreaterThanOrEqual(min);
          expect(combo.legs.length).toBeLessThanOrEqual(max);
          expect(new Set(combo.legs.map((l) => l.matchId)).size).toBe(combo.legs.length);
          expect(combo.prob).toBeCloseTo(combo.legs.reduce((p, l) => p * (l.pick.calibratedProb ?? l.pick.prob), 1), 3);
          expect(combo.fairOdds).toBeCloseTo(1 / combo.prob, 2);
          for (const l of combo.legs) {
            const m = open.get(l.matchId)!;
            expect(m.match.home.name).toBe(l.home);
            expect(m.picks.some((p) => p.family === l.pick.family && p.selection === l.pick.selection)).toBe(true);
          }
        }
        if (open.size >= 2) expect(ids).toContain('segura');
        if (open.size < 2) expect(day.combos).toEqual([]);
      }
      const home = readJson<HomeFile>(dir, 'home.json');
      const first = withTop[0];
      expect(home.daily).toMatchObject({ date: first.date, matches: first.counts.matches, picks: first.counts.picks });
      expect(home.daily!.top.length).toBe(Math.min(4, first.top.length));
      home.daily!.top.forEach((t, i) => {
        expect(t.match.id).toBe(first.top[i].matchId);
        expect(t.pick.selection).toBe(first.top[i].pick.selection);
        expect(t.match.prediction).toBeUndefined(); // ficha compacta
      });
    });

    it('daily.json: récord fuera de muestra de la regla diaria (global, por categoría, combinadas y línea base) y aviso', () => {
      const d = readJson<DailyFile>(dir, 'daily.json');
      const o = d.track.overall;
      expect(o.n).toBeGreaterThan(200);
      expect(o.hitRate).toBeCloseTo(o.hits / o.n, 4);
      expect(o.wilsonLow!).toBeLessThanOrEqual(o.hitRate);
      expect(o.wilsonHigh!).toBeGreaterThanOrEqual(o.hitRate);
      expect(d.track.byCategory.reduce((n, x) => n + x.picks, 0)).toBe(o.picks);
      expect(d.track.byCategory.reduce((n, x) => n + x.hits, 0)).toBe(o.hits);
      const cats = d.track.byCategory.map((x) => x.category);
      expect(cats).toContain('resultado');
      expect(cats).toContain('goles');
      expect(cats.some((x) => x === 'tiros' || x === 'faltas' || x === 'jugadores')).toBe(true);
      for (const x of d.track.byCategory) {
        expect(x.label.length).toBeGreaterThan(0);
        expect(x.baseRate).toBeGreaterThan(0.5);
        if (x.n > 0) expect(x.hitRate).toBeCloseTo(x.hits / x.n, 4);
      }
      const jug = d.track.byCategory.find((x) => x.category === 'jugadores');
      if (jug) expect(jug.voids).toBeGreaterThan(0);
      expect(d.track.baseline!.label).toMatch(/visitante marca menos de 3/);
      for (const x of d.track.combos ?? []) expect(x.hitRate).toBeCloseTo(x.hits / x.days, 4);
      expect(d.note).toMatch(/fuera de muestra/);
      expect(d.note).toMatch(/no es ventaja frente a la casa/);
      expect(d.note).toMatch(/alineación/);
      expect(d.note).toMatch(/mayores de 18 años/);
    });

    it('la validación rechaza un daily.json incoherente', () => {
      const broken = path.join(tmp, 'daily-broken');
      fs.cpSync(dir, broken, { recursive: true });
      const d = readJson<DailyFile>(broken, 'daily.json') as unknown as Record<string, any>;
      const day = d.days.find((x: any) => x.combos.length > 0 && x.matches.length > 1);
      expect(day).toBeDefined();
      const combo = day.combos[0];
      combo.legs[1] = { ...combo.legs[1], matchId: combo.legs[0].matchId }; // dos patas del mismo partido
      combo.prob = 0.99; // ≠ producto de las patas
      const m = day.matches[0];
      m.picks[0] = { ...m.picks[0], tier: 'plata' }; // solo se publica oro
      const p = m.picks[m.picks.length - 1];
      m.picks.push({ ...p, selection: `${p.selection} bis` }, { ...p, selection: `${p.selection} ter` }, { ...p, category: 'apuestas', selection: 'x' }); // > 2 por categoría, categoría desconocida
      const other = day.matches[1];
      other.picks[0] = { ...other.picks[0], prob: other.picks[0].threshold - 0.05, validationN: 12 }; // bajo el umbral y sin validar
      day.top[0] = { ...day.top[0], matchId: 'no-existe' };
      day.counts.picks += 5;
      d.track.overall.hitRate = 0.999;
      fs.writeFileSync(path.join(broken, 'daily.json'), JSON.stringify(d));
      const all = validateDataDir(broken, NO_SANITY).errors.join('\n');
      expect(all).toMatch(/daily\.json: .*dos patas del mismo partido/);
      expect(all).toMatch(/daily\.json: .*≠ producto de las patas/);
      expect(all).toMatch(/daily\.json: .*"plata" no permitido/);
      expect(all).toMatch(/daily\.json: .*picks de la categoría .* \(máximo 2\)/);
      expect(all).toMatch(/daily\.json: .*"apuestas" no permitido/);
      expect(all).toMatch(/daily\.json: .*< umbral/);
      expect(all).toMatch(/daily\.json: .*regla sin validar fuera de muestra/);
      expect(all).toMatch(/daily\.json: .*partido no-existe ausente de matches/);
      expect(all).toMatch(/daily\.json: .*counts: picks/);
      expect(all).toMatch(/daily\.json: .*hitRate 0\.999 ≠/);
      fs.rmSync(path.join(broken, 'daily.json'));
      expect(validateDataDir(broken, NO_SANITY).errors).toContain('daily.json: archivo ausente');
    });

    // ---- cuota alta 6+ (longshots.json): no cambia confidence.json ni daily.json (sus tests de arriba siguen iguales)
    it('longshots.json: apuestas con cuota >= 6 de partidos por jugar, regla diaria y cifras coherentes', () => {
      const f = readJson<LongshotFile>(dir, 'longshots.json');
      expect(f.minOdds).toBe(6);
      expect(f.days.length).toBeGreaterThan(0);
      expect(f.days.length).toBeLessThanOrEqual(4);
      // partidos por jugar y, hoy, el que está en juego (con la información anterior al saque)
      const upcoming = new Set(['up-a01', 'up-a23', 'up-b01', 'up-e0', 'up-c0', 'live-a67']);
      const all = f.days.flatMap((d) => d.bets);
      expect(all.length).toBeGreaterThan(0);
      expect(new Set(all.map((b) => b.kind)).size).toBeGreaterThanOrEqual(2);
      for (const d of f.days) {
        expect(d.bets.length).toBeLessThanOrEqual(12);
        const perKind = new Map<string, Set<string>>();
        d.bets.forEach((b, i) => {
          if (i) expect(b.score).toBeLessThanOrEqual(d.bets[i - 1].score);
          expect(b.displayOdds).toBeGreaterThanOrEqual(6);
          expect(b.prob).toBeGreaterThan(0);
          expect(b.prob).toBeLessThan(1);
          expect(b.fairOdds).toBeCloseTo(1 / b.prob, 1);
          expect(b.oneIn).toBe(Math.round(1 / b.prob));
          expect(b.result).toBeUndefined();
          expect(b.reason.length).toBeGreaterThan(30);
          const set = perKind.get(b.kind) ?? new Set<string>();
          for (const l of b.legs) {
            expect(upcoming.has(l.matchId)).toBe(true);
            expect(set.has(l.matchId)).toBe(false);
            set.add(l.matchId);
          }
          perKind.set(b.kind, set);
          if (b.kind === 'combinada') {
            expect(new Set(b.legs.map((l) => l.matchId)).size).toBe(b.legs.length);
            expect(b.prob).toBeCloseTo(b.legs.reduce((t, l) => t * l.prob, 1), 3);
            expect(b.marketOdds).toBeCloseTo(b.legs.reduce((t, l) => t * l.marketOdds!, 1), 1);
            expect(b.ev).toBeCloseTo(b.prob * b.marketOdds! - 1, 2);
          } else expect(b.legs).toHaveLength(1);
          if (b.marketOdds !== undefined) expect(b.displayOdds).toBe(b.marketOdds);
          else expect(b.ev).toBeUndefined();
        });
        for (const set of perKind.values()) expect(set.size).toBeGreaterThan(0);
        for (const k of ['combinada', 'sorpresa', 'marcador', 'goleador']) expect(d.bets.filter((b) => b.kind === k).length).toBeLessThanOrEqual(4);
      }
    });

    it('longshots.json: historial fuera de muestra por tipo (aciertos, %, Wilson, esperado, cuota media, ROI con cierre, racha) y calibración', () => {
      const f = readJson<LongshotFile>(dir, 'longshots.json');
      expect(f.track.from >= '2025-06-01').toBe(true);
      expect(f.track.to < '2025-11-22').toBe(true);
      expect(f.track.byKind.map((r) => r.kind)).toEqual(['combinada', 'sorpresa', 'marcador', 'goleador']);
      for (const r of f.track.byKind) {
        const settled = r.bets - (r.voids ?? 0);
        expect(r.bets).toBeGreaterThan(30);
        expect(r.hits).toBeLessThanOrEqual(settled);
        expect(r.hitRate).toBeCloseTo(r.hits / settled, 3);
        expect(r.wilsonLow!).toBeLessThanOrEqual(r.hitRate);
        expect(r.wilsonHigh!).toBeGreaterThanOrEqual(r.hitRate);
        expect(r.avgOdds).toBeGreaterThanOrEqual(6);
        expect(r.expectedHitRate).toBeGreaterThan(0.05);
        expect(r.expectedHitRate).toBeLessThanOrEqual(1 / 6 + 1e-3);
        expect(r.longestLosingStreak).toBeGreaterThan(3);
        expect(r.excluded).toBeUndefined();
      }
      expect(f.track.byKind.find((r) => r.kind === 'goleador')!.voids).toBeGreaterThan(0);
      for (const k of ['combinada', 'sorpresa']) expect(f.track.byKind.find((r) => r.kind === k)!.roi!.bets).toBeGreaterThan(30);
      for (const k of ['marcador', 'goleador']) expect(f.track.byKind.find((r) => r.kind === k)!.roi).toBeUndefined();
      expect(f.track.calibration.length).toBeGreaterThan(2);
      for (const b of f.track.calibration) {
        expect(b.from).toBeGreaterThanOrEqual(0.05);
        expect(b.to).toBeLessThanOrEqual(0.25);
      }
      expect(f.note).toMatch(/la mayoría PIERDEN/);
      expect(f.note).toMatch(/acertó \d+ de \d+ apuestas \(\d+(,\d)? %, 1 de cada \d+; el modelo esperaba/);
      expect(f.note).toMatch(/ROI [+−]\d/);
      expect(f.note).toMatch(/margen de la casa se multiplica/);
      expect(f.note).toMatch(/mayores de 18 años/);
    });

    it('portada y metodología: la mejor apuesta abierta del primer día con apuestas y la sección «Cuota alta 6+»', () => {
      const f = readJson<LongshotFile>(dir, 'longshots.json');
      const home = readJson<HomeFile>(dir, 'home.json');
      // la del partido en juego (hoy) no cuenta: solo apuestas cuyos partidos aún no han empezado
      const open = (b: LongshotFile['days'][number]['bets'][number]) => b.legs.every((l) => Date.parse(l.date) > NOW.getTime());
      expect(f.days[0].bets.some((b) => b.legs.some((l) => l.matchId === 'live-a67'))).toBe(true);
      const day = f.days.find((d) => d.bets.some(open))!;
      expect(home.longshot).toEqual({ date: day.date, bets: day.bets.length, best: day.bets.find(open) });
      const model = readJson<ModelFile>(dir, 'model.json');
      const sec = model.sections.find((x) => x.title === 'Cuota alta 6+');
      expect(sec?.body.join(' ')).toMatch(/FUERA DE MUESTRA/);
      expect(sec?.body.join(' ')).toMatch(/combinadas: \d+ de \d+/);
      // total del apartado coherente con la suma de los tipos y advertencia de que el historial usa cuotas de cierre
      const rows = f.track.byKind.filter((r) => r.bets > 0);
      const hits = rows.reduce((s, r) => s + r.hits, 0);
      const settled = rows.reduce((s, r) => s + r.bets - (r.voids ?? 0), 0);
      expect(sec?.body.join(' ')).toContain(`En total: ${hits.toLocaleString('es-ES')} aciertos en ${settled.toLocaleString('es-ES')} apuestas resueltas`);
      expect(sec?.body.join(' ')).toMatch(/cuota de CIERRE/);
    });

    it('la validación rechaza un longshots.json incoherente', () => {
      const broken = path.join(tmp, 'longshots-broken');
      fs.cpSync(dir, broken, { recursive: true });
      const f = readJson<LongshotFile>(broken, 'longshots.json') as unknown as Record<string, any>;
      const day = f.days.find((d: any) => d.bets.length > 0);
      const bet = day.bets[0];
      const single = { ...bet, id: 'x-single', kind: 'marcador', legs: [{ ...bet.legs[0] }], prob: 0.3, fairOdds: 1 / 0.3, displayOdds: 3.33, oneIn: 3 };
      delete single.marketOdds;
      delete single.ev;
      const combo = {
        ...bet,
        id: 'x-combo',
        kind: 'combinada',
        legs: [{ ...bet.legs[0], marketOdds: 2 }, { ...bet.legs[0], marketOdds: 2.5 }],
        prob: 0.5,
        fairOdds: 2,
        displayOdds: 7,
        oneIn: 2,
        marketOdds: 7,
        ev: 0.9,
      };
      day.bets.push(single, combo, { ...combo, id: 'x-res', result: 'hit' });
      f.track.byKind[0].hitRate = 0.999;
      f.note = 'Apuestas de cuota alta.';
      fs.writeFileSync(path.join(broken, 'longshots.json'), JSON.stringify(f));
      const all = validateDataDir(broken, NO_SANITY).errors.join('\n');
      expect(all).toMatch(/longshots\.json: .*cuota 3\.33 < mínimo 6/);
      expect(all).toMatch(/longshots\.json: .*combinada con dos patas del mismo partido/);
      expect(all).toMatch(/longshots\.json: .*prob 0\.5 ≠ producto de las patas/);
      expect(all).toMatch(/longshots\.json: .*EV 0\.9 incoherente/);
      expect(all).toMatch(/longshots\.json: .*marketOdds 7 ≠ producto de las cuotas/);
      expect(all).toMatch(/longshots\.json: .*resultado hit incoherente con el de las patas/);
      expect(all).toMatch(/longshots\.json: .*repetido dentro del tipo/);
      expect(all).toMatch(/longshots\.json: .*no está ordenado por puntuación/);
      expect(all).toMatch(/longshots\.json: .*hitRate 0\.999 ≠/);
      expect(all).toMatch(/longshots\.json: .*mayores de 18 años/);
      // portada que anuncia una apuesta que no está en longshots.json
      const h = readJson<HomeFile>(broken, 'home.json') as unknown as Record<string, any>;
      h.longshot = { ...h.longshot, best: { ...h.longshot.best, id: 'otra' } };
      fs.writeFileSync(path.join(broken, 'home.json'), JSON.stringify(h));
      expect(validateDataDir(broken, NO_SANITY).errors.join('\n')).toMatch(/home\.json: longshot\.best \(otra\) no está entre las apuestas del día/);
      fs.rmSync(path.join(broken, 'longshots.json'));
      expect(validateDataDir(broken, NO_SANITY).errors).toContain('longshots.json: archivo ausente');
    });

    // ---- combinada 6 (combo6.json): no cambia ningún otro archivo
    it('combo6.json: regla publicada, días con combinada o motivo, patas de partidos por jugar y portada coherente', () => {
      const f = readJson<Combo6File>(dir, 'combo6.json');
      expect(f.rule).toMatchObject({ targetMin: 6, targetMax: 8, legMinProb: 0.7, legMaxProb: 0.88, minLegs: 4, maxLegs: 9, minCategories: 4, maxPerCategory: 2 });
      expect(f.rule.margins.jugadores).toBeUndefined();
      expect(f.days.length).toBeGreaterThan(0);
      expect(f.days.length).toBeLessThanOrEqual(4);
      for (const d of f.days) {
        expect(!!d.main !== !!d.reason).toBe(true);
        for (const c of [...(d.main ? [d.main] : []), ...d.byCompetition]) {
          // solo partidos que aún no han empezado
          for (const l of c.legs) expect(Date.parse(l.kickoff)).toBeGreaterThan(NOW.getTime());
          expect(c.bookOdds).toBeGreaterThanOrEqual(6 * 0.997);
          expect(c.bookOdds).toBeLessThanOrEqual(8 * 1.003);
          expect(c.estimatedLegs).toBe(c.legs.filter((l) => l.oddsSource !== 'casa').length);
        }
      }
      expect(f.note).toMatch(/ESTIMADA/);
      expect(f.note).toMatch(/\(ROI\)/);
      expect(f.note).toMatch(/\+18/);
      const home = readJson<HomeFile>(dir, 'home.json');
      const first = f.days.find((d) => d.main && Date.parse(d.main.firstKickoff) > NOW.getTime());
      expect(home.combo6).toEqual(first ? { date: first.date, combo: first.main } : undefined);
    });

    it('la validación rechaza un combo6.json incoherente', () => {
      const broken = path.join(tmp, 'combo6-broken');
      fs.cpSync(dir, broken, { recursive: true });
      const f = readJson<Combo6File>(broken, 'combo6.json') as unknown as Record<string, any>;
      const l = (id: string, category: string, prob: number, bookOdds: number, oddsSource = 'estimada') => ({
        matchId: id,
        compId: 'liga-a',
        compName: 'Liga A',
        kickoff: f.days[0].date + 'T18:00:00Z',
        home: { id: 'A1', name: 'Alfa 1', short: 'Alfa 1', abbr: 'ALF' },
        away: { id: 'A2', name: 'Alfa 2', short: 'Alfa 2', abbr: 'ALF' },
        category,
        marketId: 'ou-4.5',
        market: 'Más/Menos 4.5 goles',
        selection: 'Menos de 4.5 goles',
        prob,
        fairOdds: 1 / prob,
        bookOdds,
        bookOddsEstimated: true,
        oddsSource,
      });
      const legs = [l('1', 'goles', 0.75, 1.27), l('1', 'goles', 0.75, 1.27), l('2', 'goles', 0.75, 1.27), l('3', 'corners', 0.95, 1.5, 'casa')];
      f.days[0].main = { id: 'x', date: f.days[0].date, scope: 'todas', label: 'X', legs, prob: 0.5, fairOdds: 2, bookOdds: 3, estimatedLegs: 1, oneIn: 2, ev: 0.9, categories: 2, firstKickoff: legs[0].kickoff, lastKickoff: legs[0].kickoff };
      delete f.days[0].reason;
      f.history.hitRate = 0.999;
      f.note = 'Combinada.';
      fs.writeFileSync(path.join(broken, 'combo6.json'), JSON.stringify(f));
      const all = validateDataDir(broken, NO_SANITY).errors.join('\n');
      expect(all).toMatch(/combo6\.json: .*dos patas del mismo partido/);
      expect(all).toMatch(/combo6\.json: .*prob 0\.5 ≠ producto de las patas/);
      expect(all).toMatch(/combo6\.json: .*bookOdds 3 ≠ producto/);
      expect(all).toMatch(/combo6\.json: .*estimatedLegs 1 ≠ patas estimadas \(4\)/);
      expect(all).toMatch(/combo6\.json: .*bookOddsEstimated true incoherente con oddsSource casa/);
      expect(all).toMatch(/combo6\.json: .*prob 0\.95 fuera de la banda/);
      expect(all).toMatch(/combo6\.json: .*3 patas de goles/);
      expect(all).toMatch(/combo6\.json: .*cuota 3 fuera de la ventana 6–8/);
      expect(all).toMatch(/combo6\.json: .*hitRate 0\.999 ≠/);
      expect(all).toMatch(/combo6\.json: .*mayores de 18 años/);
      expect(all).toMatch(/combo6\.json: .*cuotas son estimadas/);
      fs.rmSync(path.join(broken, 'combo6.json'));
      expect(validateDataDir(broken, NO_SANITY).errors).toContain('combo6.json: archivo ausente');
    });

    it('la validación rechaza picks incoherentes en confidence.json', () => {
      const broken = path.join(tmp, 'conf-broken');
      fs.cpSync(dir, broken, { recursive: true });
      const c = readJson<ConfidenceFile>(broken, 'confidence.json') as unknown as Record<string, any>;
      c.picks[0].pick.prob = c.picks[0].pick.threshold - 0.05; // por debajo de su umbral (y cuota justa incoherente)
      c.picks[1].pick.tier = 'oro';
      c.picks[1].pick.historicalHitRate = 0.81; // oro exige >= 0,85
      c.picks.push({ ...c.picks[0], pick: { ...c.picks[0].pick, tier: 'plata' } }); // ya no se publica
      c.picks.push({ ...c.picks[0], pick: { ...c.picks[0].pick, validationN: 12 } }); // regla sin validar fuera de muestra
      c.recent[0].hit = !c.recent[0].hit;
      c.track.holdout.hitRate = 0.99;
      c.picks.push({ ...c.picks[0] }, { ...c.picks[0] }); // tres del mismo partido y fuera de orden
      fs.writeFileSync(path.join(broken, 'confidence.json'), JSON.stringify(c));
      const all = validateDataDir(broken, NO_SANITY).errors.join('\n');
      expect(all).toMatch(/confidence\.json: .*< umbral/);
      expect(all).toMatch(/cuota justa .* incoherente/);
      expect(all).toMatch(/nivel oro con acierto histórico 0\.81/);
      expect(all).toMatch(/"plata" no permitido/);
      expect(all).toMatch(/regla sin validar fuera de muestra/);
      expect(all).toMatch(/hit no coincide con pick\.result/);
      expect(all).toMatch(/hitRate 0\.99 ≠/);
      expect(all).toMatch(/no está ordenado por fecha/);
      expect(all).toMatch(/máximo 2/);
      fs.rmSync(path.join(broken, 'confidence.json'));
      expect(validateDataDir(broken, NO_SANITY).errors).toContain('confidence.json: archivo ausente');
    });
  });

  it('publicPick, fichas compactas y filas por familia (unidades)', () => {
    const engine = {
      ...synthCand('team-under-2.5', 'estadistico', 0.8765, 'hit'),
      marketOdds: 1.1,
      oddsKind: 'directa' as const,
      tier: 'oro' as const,
      historicalHitRate: 0.9012,
      historicalN: 321,
      threshold: 0.8,
      calibratedProb: 0.889,
    };
    const p = publicPick(
      engine,
      'void',
      { 'team-under-2.5': { hitRate: 0.8911, n: 641, wilsonLow: 0.869, wilsonHigh: 0.91, baseRate: 0.893 } },
      { 'team-under-2.5|estadistico': { hitRate: 0.8889, n: 36, wilsonLow: 0.77, wilsonHigh: 0.95 } },
    );
    expect(p).toMatchObject({
      family: 'team-under-2.5',
      prob: 0.8765,
      tier: 'oro',
      source: 'estadistico',
      validationHitRate: 0.8889,
      validationN: 36,
      holdoutHitRate: 0.8911,
      holdoutN: 641,
      holdoutWilsonLow: 0.869,
      baseRate: 0.893,
      result: 'void',
      marketOdds: 1.1,
    });
    expect(p.fairOdds).toBeCloseTo(1 / 0.8765, 3);
    // validación con menos de 50 casos: publicada, pero sin acierto propio (no se destaca en portada)
    expect(validatedOutOfSample(p)).toBe(false);
    expect(validatedOutOfSample({ validationHitRate: 0.9, validationN: 1521 })).toBe(true);
    expect(validatedOutOfSample({ validationHitRate: 0.744, validationN: 125 })).toBe(false);
    expect(publicPick(engine).holdoutN).toBeUndefined();
    expect(publicPick(engine).validationN).toBeUndefined();

    const s = slimSummary({ id: '1', compId: 'x', compName: 'X', date: '2026-11-20T18:00:00Z', status: 'scheduled', home: T('a'), away: T('b'), hasDetail: true, odds: { provider: 'p', home: 2 }, popularity: 50, prediction: { p: { home: 0.5, draw: 0.3, away: 0.2 }, xgHome: 1, xgAway: 1, over25: 0.5, btts: 0.5, likelyScore: '1-1', likelyScoreProb: 0.1, confidence: 0.5 } });
    expect(Object.keys(s).sort()).toEqual(['away', 'compId', 'compName', 'date', 'hasDetail', 'home', 'id', 'status']);

    const g = (n: number, hits: number) => ({ n, hits, picks: n, hitRate: hits / n, wilsonLow: 0.5, wilsonHigh: 0.95, avgFairOdds: 1.12 });
    const v = (key: string, n: number, hits: number) => ({ key, n, hits, hitRate: n ? hits / n : 0, validated: n >= 30 && hits / n >= 0.8 });
    const ev = {
      rules: { rules: [{ family: 'ah+1.5', segment: 'mercado', threshold: 0.8, goldThreshold: 0.86 }] },
      unvalidated: [{ key: 'ou-3.5-under|mercado', family: 'ou-3.5-under', segment: 'mercado', n: 9, hits: 9, hitRate: 1 }],
      validation: [v('ah+1.5|mercado', 1521, 1349), v('ou-3.5-under|mercado', 9, 9)],
      excluded: [{ key: 'cards-over-2.5', reason: 'falla fuera de muestra' }],
      holdout: { byFamily: { 'ah+1.5': g(845, 749), dnb: g(13, 12) } },
      byFamily: [
        { family: 'ah+1.5', holdoutBase: { n: 1444, hits: 1316, hitRate: 0.9114 }, walkForward: g(1521, 1349) },
        { family: 'dnb', holdoutBase: { n: 1120, hits: 817, hitRate: 0.7295 } },
      ],
      productionChoice: { exclude: ['btts-no|mercado'] },
    } as unknown as Parameters<typeof familyRows>[0];
    const rows = new Map(familyRows(ev).map((r) => [r.family, r]));
    const ah = rows.get('ah+1.5')!;
    expect(ah).toMatchObject({ active: true, threshold: 0.8, n: 845, hits: 749, baseRate: 0.9114, baseN: 1444 });
    expect(ah.hitRate).toBeCloseTo(749 / 845, 9); // sin redondear
    expect(ah.lift).toBeCloseTo(749 / 845 - 0.9114, 9);
    expect(ah.thresholds).toEqual([{ source: 'mercado', threshold: 0.8, goldThreshold: 0.86, validationN: 1521, validationHits: 1349, validationHitRate: 1349 / 1521 }]);
    expect(ah.walkForward).toMatchObject({ n: 1521, hits: 1349 });
    expect(rows.get('ou-3.5-under')).toMatchObject({ active: false, unpublished: [{ source: 'mercado', n: 9, hits: 9, hitRate: 1 }] });
    expect(rows.get('ou-3.5-under')!.note).toMatch(/sin validación fuera de muestra suficiente \(9\/9; se exigen 30 picks y 80 %\)/);
    expect(rows.get('cards-over-2.5')).toMatchObject({ active: false, excluded: 'falla fuera de muestra' });
    expect(rows.get('cards-over-2.5')!.note).toMatch(/Excluida de antemano/);
    expect(rows.get('dnb')!.note).toMatch(/No se publica.*Holdout con muestra pequeña \(13\)/);
    expect(rows.get('btts-no')!.note).toMatch(/validación interna/);
    expect(rows.get('btts-yes')!.hitRate).toBeUndefined();
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
