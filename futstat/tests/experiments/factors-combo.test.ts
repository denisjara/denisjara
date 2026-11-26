/**
 * Variante «factors-combo» (pipeline/experiments/factors-combo.ts): composición de los tres factores adoptados
 * (árbitro, disponibilidad en las props, factores del rival 6/40). Comprueba que la composición es EXACTAMENTE la de
 * sus componentes (stats.adjust = la del árbitro; players.adjust = unión de las salidas, de claves disjuntas) y una
 * prueba ADVERSARIAL propia: la comprobación de fuga del banco nunca mete partidos envenenados en la competición del
 * partido predicho, y los componentes usan `compMatches` (árbitro: medias esperadas; forma de jugadores: pool de la
 * proyección; disponibilidad: último partido de la misma competición). Aquí se añaden partidos y líneas futuros (y a
 * la misma hora) EN LA MISMA competición, con el mismo árbitro, rojas, tarjetas, faltas y tiros extremos, y todas las
 * salidas de los dos ganchos deben ser idénticas.
 */
import { describe, expect, it } from 'vitest';
import { Elo } from '../../src/lib/models';
import { COMPETITION_BY_ID } from '../../pipeline/config';
import type { PlayerPropsInput } from '../../pipeline/analytics/players';
import type { MatchRecord, PlayerLine } from '../../pipeline/types';
import { historyView } from '../../pipeline/experiments/history';
import { loadVariant } from '../../pipeline/experiments/load';
import { preMatchView, type FeatureContext, type ModelVariant, type StatPairs } from '../../pipeline/experiments/types';

const DAY = 86_400_000;
const T0 = Date.parse('2026-08-20T18:00:00Z');
const COMP = 'laliga';
const PLAYERS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11'];
const team = (id: string) => ({ id, name: id, short: id, abbr: id.slice(0, 3).toUpperCase() });

interface Spec {
  id: string;
  t: number;
  home: string;
  away: string;
  ref: string;
  cards: [number, number];
  fouls: [number, number];
  shots: [number, number];
  /** jugadores de A que juegan (líneas) y rojas (eventos) de A */
  aPlayers?: string[];
  aRed?: string[];
}

function build(specs: Spec[]): { ms: MatchRecord[]; ls: PlayerLine[] } {
  const ms: MatchRecord[] = [];
  const ls: PlayerLine[] = [];
  for (const s of specs) {
    ms.push({
      id: s.id,
      compId: COMP,
      season: 2026,
      currentSeason: true,
      date: new Date(s.t).toISOString(),
      status: 'finished',
      home: team(s.home),
      away: team(s.away),
      score: { home: 1, away: 1 },
      referee: { id: s.ref, name: `Árbitro ${s.ref}` },
      stats: {
        home: { goals: 1, yellow: s.cards[0], red: 0, fouls: s.fouls[0], shots: s.shots[0], shotsOnTarget: Math.round(s.shots[0] / 3) },
        away: { goals: 1, yellow: s.cards[1], red: 0, fouls: s.fouls[1], shots: s.shots[1], shotsOnTarget: Math.round(s.shots[1] / 3) },
      },
      events: (s.aRed ?? []).map((p) => ({ minute: 50, clock: "50'", type: 'red' as const, teamId: 'A', playerId: p })),
    });
    const aHome = s.home === 'A';
    if (s.home !== 'A' && s.away !== 'A') continue;
    for (const p of s.aPlayers ?? PLAYERS) {
      ls.push({
        matchId: s.id,
        compId: COMP,
        date: new Date(s.t).toISOString(),
        teamId: 'A',
        opponentId: aHome ? s.away : s.home,
        isHome: aHome,
        playerId: p,
        name: p,
        short: p,
        position: p === 'P9' ? 'F' : 'M',
        starter: true,
        minutes: 90,
        goals: 0,
        assists: 0,
        shots: p === 'P9' ? 4 : 1,
        shotsOnTarget: p === 'P9' ? 2 : 0,
        yellow: 0,
        red: s.aRed?.includes(p) ? 1 : 0,
        foulsCommitted: 1,
        foulsSuffered: 1,
        offsides: 0,
        ownGoals: 0,
      });
    }
  }
  return { ms, ls };
}

/**
 * Liga de 6 equipos con 30 días de partidos: A tira mucho (22) y el resto 11; el árbitro R1 saca 6 tarjetas y pita 28
 * faltas (media ~4 y ~22). Últimos partidos de A: P3 falta en los 2 últimos, P4 en el último y P7 ve roja en el último.
 */
function past(): Spec[] {
  const teams = ['A', 'B', 'C', 'D', 'E', 'F'];
  const out: Spec[] = [];
  let k = 0;
  for (let d = 0; d < 30; d++) {
    const h = teams[d % 6];
    const a = teams[(d * 5 + 1) % 6] === h ? teams[(d + 2) % 6] : teams[(d * 5 + 1) % 6];
    const r1 = d % 3 === 0;
    out.push({
      id: `p${k++}`,
      t: T0 - (40 - d) * DAY,
      home: h,
      away: a,
      ref: r1 ? 'R1' : `X${d % 5}`,
      cards: r1 ? [3, 3] : [2, 2],
      fouls: r1 ? [14, 14] : [11, 11],
      shots: [h === 'A' ? 22 : 11, a === 'A' ? 22 : 11],
    });
  }
  const recent = (id: string, dd: number, aPlayers: string[], aRed?: string[]): Spec => ({
    id,
    t: T0 - dd * DAY,
    home: 'A',
    away: 'C',
    ref: 'X1',
    cards: [2, 2],
    fouls: [11, 11],
    shots: [22, 11],
    aPlayers,
    aRed,
  });
  out.push(recent('r1', 8, PLAYERS.filter((p) => p !== 'P3')));
  out.push(recent('r2', 4, PLAYERS.filter((p) => p !== 'P3' && p !== 'P4'), ['P7']));
  return out;
}

/** Envenenado: la MISMA competición, a la misma hora y en el futuro, con R1, rojas y cifras extremas. */
function poison(): Spec[] {
  const ext = (id: string, t: number, home: string, away: string): Spec => ({
    id,
    t,
    home,
    away,
    ref: 'R1',
    cards: [9, 9],
    fouls: [40, 40],
    shots: [60, 0],
    aPlayers: ['P3', 'P4', 'P7'],
    aRed: ['P1', 'P2'],
  });
  return [ext('same', T0, 'A', 'D'), ext('fut1', T0 + 1, 'B', 'A'), ext('fut2', T0 + 2 * DAY, 'A', 'B'), ext('fut3', T0 + 30 * DAY, 'E', 'F')];
}

function view(specs: Spec[], cutoff: number) {
  const { ms, ls } = build(specs);
  const byTeam = new Map<string, MatchRecord[]>();
  const byComp = new Map<string, MatchRecord[]>();
  const byRef = new Map<string, MatchRecord[]>();
  for (const m of ms) {
    for (const t of [m.home.id, m.away.id]) byTeam.set(t, [...(byTeam.get(t) ?? []), m]);
    byComp.set(m.compId, [...(byComp.get(m.compId) ?? []), m]);
    if (m.referee) byRef.set(m.referee.id, [...(byRef.get(m.referee.id) ?? []), m]);
  }
  const linesByTeam = new Map<string, PlayerLine[]>([['A', ls]]);
  return historyView({ matchesByTeam: byTeam, matchesByComp: byComp, matchesByReferee: byRef, linesByTeam, elo: new Elo({ k: 20, homeAdv: 65, init: 1500 }) }, cutoff);
}

const targetRec: MatchRecord = {
  id: 'target',
  compId: COMP,
  season: 2026,
  currentSeason: true,
  date: new Date(T0).toISOString(),
  status: 'scheduled',
  home: team('A'),
  away: team('B'),
  referee: { id: 'R1', name: 'Árbitro R1' },
};
const match = preMatchView(targetRec);
const ctx: FeatureContext = { comp: COMPETITION_BY_ID.get(COMP)!, configs: COMPETITION_BY_ID, homeLeague: new Map() };
const baseStats: StatPairs = { cards: { home: 2.1, away: 2.0 }, fouls: { home: 11, away: 11.5 }, shots: { home: 14, away: 10 } };

function baseProps(lines: readonly PlayerLine[]): PlayerPropsInput {
  return { teamId: 'A', opponentId: 'B', lines: [...lines], teamLambda: 1.6, teamAvgGoals: 1.4, oppShotsFactor: 1.05, oppSotFactor: 0.97, cardsFactor: 1.08, foulsFactor: 1 };
}

function outputs(v: ModelVariant, specs: Spec[]) {
  const h = view(specs, T0);
  const stats = v.stats?.adjust?.({ ctx, match, history: h, base: baseStats }) ?? {};
  const players = v.players?.adjust?.({ ctx, match, teamId: 'A', side: 'home', history: h, base: baseProps(h.playerLines('A')) }) ?? {};
  return { stats, players };
}

describe('factors-combo: composición de los factores adoptados', () => {
  it('carga con el cargador oficial y solo usa stats.adjust y players.adjust', async () => {
    const v = await loadVariant('factors-combo');
    expect(v.name).toBe('factors-combo');
    expect(v.stats?.adjust).toBeTypeOf('function');
    expect(v.players?.adjust).toBeTypeOf('function');
    expect(v.combine ?? v.totals ?? v.lambdaAdjust ?? v.features ?? v.dc ?? v.elo ?? v.eloProbs).toBeUndefined();
    expect(v.stats?.priorN ?? v.players?.rateHalfLifeDays).toBeUndefined();
  });

  it('es exactamente la composición de sus componentes (claves de las props disjuntas)', async () => {
    const [combo, ref, av, pf] = await Promise.all(['factors-combo', 'referee-fouls-k30', 'availability-props', 'playerform-fac6x40'].map(loadVariant));
    const c = outputs(combo, past());
    const r = outputs(ref, past());
    const a = outputs(av, past());
    const p = outputs(pf, past());
    // el escenario activa los tres componentes
    expect(r.stats.cards!.home).toBeGreaterThan(1);
    expect(r.stats.fouls!.home).toBeGreaterThan(1);
    expect(Object.keys(a.players.minutesFactor ?? {}).sort()).toEqual(['P3', 'P4', 'P7']);
    expect(p.players.oppShotsFactor).not.toBe(1.05);
    // composición
    expect(c.stats).toEqual(r.stats);
    const ka = Object.keys(a.players);
    const kp = Object.keys(p.players);
    expect(ka.filter((k) => kp.includes(k))).toEqual([]);
    expect(c.players).toEqual({ ...a.players, ...p.players });
  });

  it('envenenar la MISMA competición (misma hora y futuro, mismo árbitro, rojas, líneas extremas) no cambia nada', async () => {
    const combo = await loadVariant('factors-combo');
    const clean = outputs(combo, past());
    const dirty = outputs(combo, [...past(), ...poison()]);
    expect(dirty).toEqual(clean);
  });

  it('determinista: dos llamadas con la misma vista dan lo mismo', async () => {
    const combo = await loadVariant('factors-combo');
    expect(outputs(combo, past())).toEqual(outputs(combo, past()));
  });
});
