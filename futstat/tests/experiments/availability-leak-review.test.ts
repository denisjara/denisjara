/**
 * Revisión adversarial (fugas) del factor DISPONIBILIDAD (variante availability-props; también availability-susp).
 *
 * Complementa tests/experiments/availability.test.ts (que prueba el modelo con vistas sintéticas) recorriendo el
 * CAMINO REAL del banco y de la ficha: createContext → propsFor → withPlayerHooks (players.adjust con `base.lines` y la
 * HistoryView del núcleo). Se envenena, en la MISMA competición del partido predicho:
 *   1. el propio partido (terminado): rojas en sus eventos y en sus líneas, habituales sin línea, marcador cambiado;
 *   2. partidos nuevos del mismo equipo en el MISMO instante del inicio, un minuto después, horas después (mismo día)
 *      y días después, con rojas (eventos y líneas) y habituales ausentes; y otro en la copa al día siguiente;
 *   3. los partidos futuros que ya existían del equipo (rojas y líneas cambiadas).
 * Las props publicadas del partido deben ser idénticas. Control de sensibilidad: el mismo veneno una hora ANTES del
 * inicio sí cambia las props (y la variante actúa en el partido elegido: la prueba no es vacía).
 */
import { describe, expect, it } from 'vitest';
import { mulberry32, samplePoisson } from '../../src/lib/models';
import type { CompetitionConfig } from '../../pipeline/config';
import type { CompetitionStore, MatchRecord, PlayerLine } from '../../pipeline/types';
import { createContext } from '../../pipeline/publish/context';
import { propsFor } from '../../pipeline/publish/matches';
import { historyView } from '../../pipeline/experiments/history';
import { teamAbsences } from '../../pipeline/experiments/availability/model';
import { loadVariant } from '../../pipeline/experiments/load';
import type { ModelVariant } from '../../pipeline/experiments/types';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const LIGA: CompetitionConfig = { id: 'liga-av', slug: 'syna.1', name: 'Liga A', shortName: 'Liga A', country: 'Sintetia', flag: '🏳️', kind: 'league', tier: 8 };
const COPA: CompetitionConfig = { id: 'copa-av', slug: 'syna.copa', name: 'Copa A', shortName: 'Copa A', country: 'Sintetia', flag: '🏳️', kind: 'cup', tier: 5 };
const CONFIGS = [LIGA, COPA];
const NOW = new Date('2026-11-01T00:00:00Z');

const ref = (id: string) => ({ id, name: `Equipo ${id}`, short: id, abbr: id });

function mkLine(m: MatchRecord, teamId: string, k: number, rng: () => number, over: Partial<PlayerLine> = {}): PlayerLine {
  const pos = k === 0 ? 'G' : k < 5 ? 'D' : k < 9 ? 'M' : 'F';
  const shots = pos === 'G' ? 0 : samplePoisson(pos === 'F' ? 2.2 : 0.8, rng);
  const isHome = m.home.id === teamId;
  return {
    matchId: m.id,
    compId: m.compId,
    date: m.date,
    teamId,
    opponentId: isHome ? m.away.id : m.home.id,
    isHome,
    playerId: `${teamId}p${k}`,
    name: `Jugador ${k} ${teamId}`,
    short: `J${k}`,
    position: pos,
    starter: k < 11,
    minutes: k < 11 ? 90 : 30,
    goals: pos === 'F' && rng() < 0.3 ? 1 : 0,
    assists: 0,
    shots,
    shotsOnTarget: Math.min(shots, samplePoisson(0.4, rng)),
    yellow: rng() < 0.12 ? 1 : 0,
    red: 0,
    foulsCommitted: samplePoisson(1, rng),
    foulsSuffered: samplePoisson(1, rng),
    offsides: 0,
    ownGoals: 0,
    ...over,
  };
}

/**
 * Liga de 8 equipos (jornada semanal 2026-03..2026-10) y copa los miércoles. Todas con líneas (13 por equipo). El
 * equipo A0: su jugador 9 falta cada 4.º partido (habitual ausente) y el jugador 6 ve una roja en la jornada previa al
 * partido objetivo (sanción). Devuelve los stores y el id del partido objetivo (liga, A0 local, en septiembre).
 */
function world(seed = 11): { stores: CompetitionStore[]; targetId: string } {
  const rng = mulberry32(seed);
  const teams = Array.from({ length: 8 }, (_, i) => `A${i}`);
  const league: MatchRecord[] = [];
  const cup: MatchRecord[] = [];
  const lines: Record<string, PlayerLine[]> = { [LIGA.id]: [], [COPA.id]: [] };
  const games = new Map<string, number>();
  let id = 9000;
  let targetId = '';
  const targetT = Date.UTC(2026, 8, 5, 15);
  const play = (compId: string, t: number, h: string, a: string) => {
    const m: MatchRecord = {
      id: String(id++),
      compId,
      season: 2026,
      currentSeason: true,
      date: new Date(t).toISOString(),
      status: 'finished',
      home: ref(h),
      away: ref(a),
      score: { home: samplePoisson(1.4, rng), away: samplePoisson(1.1, rng) },
      stats: {
        home: { goals: 0, corners: 5, yellow: 2, red: 0, shots: 12, shotsOnTarget: 4, fouls: 12 },
        away: { goals: 0, corners: 4, yellow: 2, red: 0, shots: 10, shotsOnTarget: 3, fouls: 12 },
      },
      events: [],
    };
    // la jornada anterior al objetivo: roja (evento con playerId) de A0p6
    const preTarget = compId === LIGA.id && Math.abs(t - (targetT - 7 * DAY)) < 6 * HOUR && (h === 'A0' || a === 'A0');
    if (preTarget) m.events!.push({ minute: 60, clock: "60'", type: 'red', teamId: 'A0', playerId: 'A0p6' });
    for (const team of [h, a]) {
      const n = (games.get(team) ?? 0) + 1;
      games.set(team, n);
      for (let k = 0; k < 13; k++) {
        if (team === 'A0' && k === 9 && n % 4 === 0) continue;
        lines[compId].push(mkLine(m, team, k, rng, preTarget && team === 'A0' && k === 6 ? { red: 1, minutes: 60 } : {}));
      }
    }
    (compId === LIGA.id ? league : cup).push(m);
    return m;
  };
  let w = 0;
  for (let t = Date.UTC(2026, 2, 7, 15); t < Date.UTC(2026, 9, 25); t += 7 * DAY, w++) {
    const order = teams.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    // A0 siempre local frente a order[...] en el objetivo
    const a0 = order.indexOf('A0');
    [order[0], order[a0]] = [order[a0], order[0]];
    for (let k = 0; k < 4; k++) {
      const m = play(LIGA.id, t + k * HOUR, order[2 * k], order[2 * k + 1]);
      if (t + k * HOUR === targetT) targetId = m.id;
    }
    if (w % 3 === 1) play(COPA.id, t + 4 * DAY, order[2], order[3]);
  }
  return {
    stores: [
      { compId: COPA.id, slug: COPA.slug, updatedAt: NOW.toISOString(), matches: cup, players: lines[COPA.id], standings: [] },
      { compId: LIGA.id, slug: LIGA.slug, updatedAt: NOW.toISOString(), matches: league, players: lines[LIGA.id], standings: [] },
    ],
    targetId,
  };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Veneno (todo en el instante del inicio o después, salvo `shift` < 0 para el control). */
function poison(stores: CompetitionStore[], targetId: string, shift = 0): CompetitionStore[] {
  const out = clone(stores);
  const liga = out.find((s) => s.compId === LIGA.id)!;
  const copa = out.find((s) => s.compId === COPA.id)!;
  const rng = mulberry32(99);
  const target = liga.matches.find((m) => m.id === targetId)!;
  const T = Date.parse(target.date);
  if (shift === 0) {
    // 1) el propio partido: rojas en eventos y líneas, habituales sin línea, marcador distinto
    target.score = { home: 7, away: 0 };
    target.events = [
      { minute: 10, clock: "10'", type: 'red', teamId: 'A0', playerId: 'A0p1' },
      { minute: 20, clock: "20'", type: 'red', teamId: 'A0', playerId: 'A0p2' },
    ];
    liga.players = liga.players!.filter((l) => !(l.matchId === targetId && ['A0p3', 'A0p4', 'A0p10'].includes(l.playerId)));
    for (const l of liga.players) if (l.matchId === targetId && l.playerId === 'A0p5') Object.assign(l, { red: 1, goals: 3, shots: 9 });
    // 3) partidos futuros existentes de A0: rojas y líneas cambiadas
    for (const s of [liga, copa]) {
      for (const m of s.matches) {
        if (Date.parse(m.date) <= T || (m.home.id !== 'A0' && m.away.id !== 'A0')) continue;
        m.events = [{ minute: 5, clock: "5'", type: 'red', teamId: 'A0', playerId: 'A0p7' }];
        s.players = s.players!.filter((l) => !(l.matchId === m.id && l.teamId === 'A0' && ['A0p1', 'A0p2'].includes(l.playerId)));
      }
    }
  }
  // 2) partidos nuevos de A0 en el mismo instante, +1 min, +2 h, +3 días (liga) y +1 día (copa)
  let id = 50_000;
  const offsets: [CompetitionStore, number][] =
    shift === 0
      ? [
          [liga, 0],
          [liga, 60_000],
          [liga, 2 * HOUR],
          [liga, 3 * DAY],
          [copa, DAY],
        ]
      : [[liga, shift]];
  for (const [s, dt] of offsets) {
    const m: MatchRecord = {
      id: String(id++),
      compId: s.compId,
      season: 2026,
      currentSeason: true,
      date: new Date(T + dt).toISOString(),
      status: 'finished',
      home: ref('A0'),
      away: ref('A7'),
      score: { home: 0, away: 5 },
      stats: { home: { goals: 0, yellow: 9, red: 3, shots: 1 }, away: { goals: 5, yellow: 0, red: 0, shots: 30 } },
      events: [
        { minute: 30, clock: "30'", type: 'red', teamId: 'A0', playerId: 'A0p9' },
        { minute: 31, clock: "31'", type: 'red', teamId: 'A0', playerId: 'A0p10' },
      ],
    };
    s.matches.push(m);
    // A0 solo con 0, 6, 11, 12 (faltan los habituales) y rojas también en las líneas
    for (const k of [0, 6, 8, 11, 12]) s.players!.push(mkLine(m, 'A0', k, rng, k === 8 ? { red: 1 } : {}));
    for (let k = 0; k < 13; k++) s.players!.push(mkLine(m, 'A7', k, rng));
  }
  return out;
}

function propsOf(stores: CompetitionStore[], targetId: string, variant: ModelVariant) {
  const ctx = createContext({ stores, configs: CONFIGS, now: NOW, variant });
  const m = ctx.matchById.get(targetId)!;
  const t = Date.parse(m.date);
  return {
    home: propsFor(ctx, m.home.id, m.away.id, 'home', 1.4, [], t, m),
    away: propsFor(ctx, m.away.id, m.home.id, 'away', 1.1, [], t, m),
    absences: teamAbsences(m, 'A0', ctx.linesByTeam.get('A0') ?? [], historyView(ctx.history, t)),
  };
}

describe('availability: revisión adversarial de fugas por el camino real (propsFor)', () => {
  const { stores, targetId } = world();

  it('el partido objetivo existe y la variante actúa en él (prueba no vacía)', async () => {
    expect(targetId).not.toBe('');
    const v = await loadVariant('availability-props');
    const clean = propsOf(stores, targetId, v);
    expect(clean.absences.some((a) => a.kind === 'susp' && a.playerId === 'A0p6')).toBe(true);
    const prod = propsOf(stores, targetId, { name: 'p', description: 'p' });
    expect(clean.home).not.toEqual(prod.home);
  });

  for (const name of ['availability-props', 'availability-susp']) {
    it(`${name}: veneno en la MISMA competición (el propio partido, mismo instante, mismo día, después) no cambia las props`, async () => {
      const v = await loadVariant(name);
      const clean = propsOf(stores, targetId, v);
      const bad = propsOf(poison(stores, targetId), targetId, v);
      expect(bad.home).toEqual(clean.home);
      expect(bad.away).toEqual(clean.away);
      expect(bad.absences).toEqual(clean.absences);
    });
  }

  it('control: el mismo veneno una hora ANTES del inicio sí cambia las props (la prueba es sensible)', async () => {
    const v = await loadVariant('availability-props');
    const clean = propsOf(stores, targetId, v);
    const before = propsOf(poison(stores, targetId, -HOUR), targetId, v);
    expect(before.absences).not.toEqual(clean.absences);
    expect(before.home).not.toEqual(clean.home);
  });
});
