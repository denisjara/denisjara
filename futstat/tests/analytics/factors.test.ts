/**
 * «Factores del partido» (pipeline/analytics/factors.ts): cada apartado con un mundo sintético pequeño y, sobre todo,
 * el CORTE WALK-FORWARD: añadir partidos, líneas de jugador, árbitros y Elo POSTERIORES al inicio (o a la misma hora)
 * no cambia el bloque, y el bloque de un partido ya terminado es el mismo que antes de jugarse.
 */
import { describe, expect, it } from 'vitest';
import { Elo } from '../../src/lib/models';
import type { PlayerProp } from '../../src/types/data';
import { COMPETITION_BY_ID } from '../../pipeline/config';
import type { MatchRecord, PlayerLine } from '../../pipeline/types';
import { historyView } from '../../pipeline/experiments/history';
import {
  ABSENCE_REASON,
  buildMatchFactors,
  inFormPlayers,
  stakesFactor,
  teamForm,
  tieFactor,
  venueFactor,
  zoneCategory,
  type MatchFactorsInput,
} from '../../pipeline/analytics/factors';
import { validateMatchFactors } from '../../scripts/validate-data';

const DAY = 86_400_000;
const T0 = Date.parse('2026-08-15T18:00:00Z');
const TEAMS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const team = (id: string) => ({ id, name: `Equipo ${id}`, short: id, abbr: id });
const LALIGA = COMPETITION_BY_ID.get('laliga')!;
const COPA = COMPETITION_BY_ID.get('copadelrey')!;

/** Generador determinista (LCG). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

interface World {
  ms: MatchRecord[];
  ls: PlayerLine[];
}

function line(m: MatchRecord, teamId: string, playerId: string, o: Partial<PlayerLine> = {}): PlayerLine {
  const isHome = m.home.id === teamId;
  return {
    matchId: m.id,
    compId: m.compId,
    date: m.date,
    teamId,
    opponentId: isHome ? m.away.id : m.home.id,
    isHome,
    playerId,
    name: `Jugador ${playerId}`,
    short: playerId,
    position: 'M',
    starter: true,
    minutes: 90,
    goals: 0,
    assists: 0,
    shots: 1,
    shotsOnTarget: 0,
    yellow: 0,
    red: 0,
    foulsCommitted: 1,
    foulsSuffered: 1,
    offsides: 0,
    ownGoals: 0,
    ...o,
  };
}

/**
 * Liga de 10 equipos a doble vuelta (18 jornadas, 15 jugadas ⇒ recta final), con estadísticas, árbitros (R1/R2) y
 * líneas de jugador del equipo A: A1 expulsado en el último partido de liga de A; A2 (habitual) no jugó los 2 últimos.
 */
function world(): World {
  const rand = rng(7);
  const ms: MatchRecord[] = [];
  const ls: PlayerLine[] = [];
  // calendario por el método del círculo
  const n = TEAMS.length;
  const arr = [...TEAMS];
  const rounds: [string, string][][] = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: [string, string][] = [];
    for (let k = 0; k < n / 2; k++) pairs.push(r % 2 ? [arr[k], arr[n - 1 - k]] : [arr[n - 1 - k], arr[k]]);
    rounds.push(pairs);
    arr.splice(1, 0, arr.pop()!);
  }
  const all = [...rounds, ...rounds.map((p) => p.map(([h, a]) => [a, h] as [string, string]))];
  all.slice(0, 15).forEach((pairs, r) => {
    pairs.forEach(([h, a], k) => {
      const strength = (id: string) => 10 - TEAMS.indexOf(id);
      const hg = Math.floor(rand() * 2.5 + (strength(h) > strength(a) ? 1 : 0));
      const ag = Math.floor(rand() * 2.2);
      const m: MatchRecord = {
        id: `L${r + 1}-${k}`,
        compId: 'laliga',
        season: 2026,
        currentSeason: true,
        date: new Date(T0 + r * 7 * DAY + k * 3_600_000).toISOString(),
        status: 'finished',
        round: `Jornada ${r + 1}`,
        home: team(h),
        away: team(a),
        score: { home: hg, away: ag },
        stats: {
          home: { goals: hg, shots: 10 + Math.floor(rand() * 8), shotsOnTarget: 4 + Math.floor(rand() * 3), fouls: 10 + Math.floor(rand() * 6), yellow: 1 + Math.floor(rand() * 3), red: 0 },
          away: { goals: ag, shots: 8 + Math.floor(rand() * 8), shotsOnTarget: 3 + Math.floor(rand() * 3), fouls: 11 + Math.floor(rand() * 6), yellow: 2 + Math.floor(rand() * 3), red: 0 },
        },
        referee: k % 2 ? { id: 'R1', name: 'Árbitro Uno' } : { id: 'R2', name: 'Árbitro Dos' },
      };
      ms.push(m);
    });
  });
  // líneas del equipo A: 11 habituales; A2 falta en los 2 últimos partidos; A1 roja en el último
  const aMatches = ms.filter((m) => m.home.id === 'A' || m.away.id === 'A');
  aMatches.forEach((m, i) => {
    const last = i === aMatches.length - 1;
    for (let p = 1; p <= 11; p++) {
      const id = `A${p}`;
      if (id === 'A2' && i >= aMatches.length - 2) continue;
      ls.push(line(m, 'A', id, { red: last && id === 'A1' ? 1 : 0, goals: id === 'A9' && i % 2 === 0 ? 1 : 0, shotsOnTarget: id === 'A9' ? 2 : 0, position: id === 'A1' ? 'D' : 'M' }));
    }
    if (last) ls.push(line(m, 'A', 'A12', { minutes: 0, starter: false })); // sin minutos: no cuenta
  });
  return { ms, ls };
}

/** Partido objetivo: jornada 16, A (local) contra B, árbitro R1 publicado. */
function target(): MatchRecord {
  return {
    id: 'TGT',
    compId: 'laliga',
    season: 2026,
    currentSeason: true,
    date: new Date(T0 + 15 * 7 * DAY + 2 * DAY).toISOString(),
    status: 'scheduled',
    round: 'Jornada 16',
    home: team('A'),
    away: team('B'),
    referee: { id: 'R1', name: 'Árbitro Uno' },
  };
}

function source(ms: MatchRecord[], ls: PlayerLine[]) {
  const sorted = [...ms].sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || (a.id < b.id ? -1 : 1));
  const byTeam = new Map<string, MatchRecord[]>();
  const byComp = new Map<string, MatchRecord[]>();
  const byRef = new Map<string, MatchRecord[]>();
  const push = (mp: Map<string, MatchRecord[]>, k: string, m: MatchRecord) => mp.set(k, [...(mp.get(k) ?? []), m]);
  const elo = new Elo({ k: 20, homeAdv: 65, init: 1500 });
  for (const m of sorted) {
    push(byTeam, m.home.id, m);
    push(byTeam, m.away.id, m);
    push(byComp, m.compId, m);
    if (m.referee) push(byRef, m.referee.id, m);
    if (m.status === 'finished' && m.score) elo.update({ id: m.id, date: m.date, home: m.home.id, away: m.away.id, hg: m.score.home, ag: m.score.away });
  }
  const linesByTeam = new Map<string, PlayerLine[]>();
  for (const l of [...ls].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))) linesByTeam.set(l.teamId, [...(linesByTeam.get(l.teamId) ?? []), l]);
  return { matchesByTeam: byTeam, matchesByComp: byComp, matchesByReferee: byRef, linesByTeam, elo };
}

function inputFor(w: World, m: MatchRecord, players?: MatchFactorsInput['players']): MatchFactorsInput {
  const src = source(w.ms, w.ls);
  const comp = COMPETITION_BY_ID.get(m.compId)!;
  return {
    match: m,
    comp,
    history: historyView(src, Date.parse(m.date)),
    lines: { home: src.linesByTeam.get(m.home.id) ?? [], away: src.linesByTeam.get(m.away.id) ?? [] },
    players,
  };
}

const prop = (id: string, formIndex: number, o: Partial<PlayerProp> = {}): PlayerProp => ({
  player: { id, name: `Jugador ${id}`, short: id, position: 'M', teamId: 'A' },
  apps: 10,
  minutes: 900,
  goals: 2,
  assists: 1,
  expMinutes: 80,
  formIndex,
  pGoal: 0.2,
  pAssist: 0.1,
  pGoalOrAssist: 0.28,
  pShots1: 0.6,
  pShots2: 0.3,
  pSot1: 0.3,
  pSot2: 0.08,
  pCard: 0.15,
  ...o,
});
const PROPS = { home: [prop('A9', 81), prop('A3', 66), prop('A4', 72, { expMinutes: 20 }), prop('A5', 59), prop('A6', 70), prop('A7', 64)], away: [] as PlayerProp[] };

describe('buildMatchFactors: apartados', () => {
  const w = world();
  const m = target();
  const f = buildMatchFactors(inputFor(w, m, PROPS));

  it('el bloque completo pasa el validador estricto', () => {
    expect(validateMatchFactors(f, { match: { date: m.date, round: m.round }, players: { home: PROPS.home, away: PROPS.away } })).toEqual([]);
    expect(f.asOf).toBe(new Date(m.date).toISOString());
  });

  it('árbitro conocido: partidos previos, tarjetas por partido y ratios contraídos; usado por el modelo', () => {
    expect(f.referee.status).toBe('conocido');
    if (f.referee.status !== 'conocido') return;
    expect(f.referee.matches).toBe(w.ms.filter((x) => x.referee?.id === 'R1').length);
    expect(f.referee.cardsPerMatch).toBeGreaterThan(0);
    expect(f.referee.cardsRatio).toBeGreaterThan(0.8);
    expect(f.referee.cardsRatio).toBeLessThan(1.2);
    expect(f.referee.foulsRatio).toBeDefined();
    expect(f.referee.usedInModel).toBe(true);
    // con una variante que sustituye el ajuste de producción, no se usa
    const g = buildMatchFactors({ ...inputFor(w, m), modelUses: { referee: false, availability: true } });
    expect(g.referee.usedInModel).toBe(false);
  });

  it('sin árbitro publicado: «no publicado» y nota explicativa', () => {
    const g = buildMatchFactors(inputFor(w, { ...m, referee: undefined }));
    expect(g.referee).toEqual({ status: 'no publicado', usedInModel: false });
    expect(g.notes.join(' ')).toMatch(/aún no ha publicado el árbitro/);
  });

  it('lo que se juega: tabla a la fecha, jornadas restantes y estado; fuera de la recta final o de las ligas válidas, ausente', () => {
    expect(f.stakes).toBeDefined();
    const s = f.stakes!;
    expect(s.teams).toBe(10);
    for (const side of [s.home, s.away]) {
      expect(side.played + side.remaining).toBe(18);
      expect(side.best).toBeLessThanOrEqual(side.worst);
      expect(side.inPlay.length === 0).toBe(side.status === 'sin nada en juego');
    }
    // temprano (jornada 5): sin bloque
    const early = w.ms.filter((x) => Number(x.round!.split(' ')[1]) <= 5);
    expect(stakesFactor({ ...inputFor({ ms: early, ls: [] }, { ...m, date: new Date(T0 + 5 * 7 * DAY).toISOString() }), comp: LALIGA })).toBeUndefined();
    // liga fuera de STAKES_LEAGUES (MLS): sin bloque
    expect(buildMatchFactors({ ...inputFor(w, m), comp: COMPETITION_BY_ID.get('mls')! }).stakes).toBeUndefined();
    expect(zoneCategory('Campeón')).toBe('título');
    expect(zoneCategory('Descenso')).toBe('descenso');
    expect(zoneCategory('Ascenso directo')).toBe('ascenso');
    expect(zoneCategory('Libertadores')).toBe('plazas continentales');
  });

  it('forma: últimos partidos, xG por tiros y etiqueta coherente con el residuo', () => {
    expect(f.form?.home).toBeDefined();
    const h = f.form!.home!;
    expect(h.last).toBe(6);
    expect(h.xgFor).toBeGreaterThan(0);
    const want = h.netRes > 0.25 ? 'rinde por encima de lo esperado' : h.netRes < -0.25 ? 'rinde por debajo de lo esperado' : 'en línea con lo esperado';
    expect(h.label).toBe(want);
    // con menos de 3 partidos recientes: sin forma
    const src = source(w.ms.slice(0, 10), []);
    expect(teamForm(historyView(src, Date.parse(m.date)), 'A')).toBeUndefined();
  });

  it('casa/fuera: el local en casa y el visitante fuera; w + d + l = jugados; ámbito competición', () => {
    const v = f.venue!;
    expect(v.usedInModel).toBe(true);
    for (const [side, id, home] of [[v.home!, 'A', true], [v.away!, 'B', false]] as const) {
      const ms = w.ms.filter((x) => (home ? x.home.id === id : x.away.id === id));
      expect(side.played).toBe(ms.length);
      expect(side.w + side.d + side.l).toBe(side.played);
      expect(side.scope).toBe('competición');
    }
    expect(venueFactor(inputFor(w, m).history, { ...m, neutral: true })).toBeUndefined();
  });

  it('bajas: expulsado en el último partido de liga (sanción, factor 0) y habitual ausente 2 partidos (0,65)', () => {
    const a = f.absences!.home;
    const susp = a.find((x) => x.playerId === 'A1')!;
    expect(susp).toMatchObject({ kind: 'susp', reason: ABSENCE_REASON.susp, minutesFactor: 0, usedInModel: true, name: 'Jugador A1' });
    expect(susp.minutesShare).toBe(1);
    const miss = a.find((x) => x.playerId === 'A2')!;
    expect(miss).toMatchObject({ kind: 'miss2', minutesFactor: 0.65, usedInModel: true });
    expect(miss.minutesShare).toBeCloseTo(0.6, 3);
    expect(a[0].kind).toBe('susp'); // ordenadas: sancionados primero
    expect(f.absences!.away).toEqual([]);
    // una variante que sustituye las bajas: se listan, pero sin efecto en el modelo
    const g = buildMatchFactors({ ...inputFor(w, m), modelUses: { referee: true, availability: false } });
    expect(g.absences!.home.every((x) => x.minutesFactor === 1 && !x.usedInModel)).toBe(true);
  });

  it('jugadores en forma: de las props, índice >= 60, >= 30 min esperados, máx. 3, ordenados; nota con sus líneas previas', () => {
    const ids = f.inForm!.home.map((p) => p.playerId);
    expect(ids).toEqual(['A9', 'A6', 'A3']);
    expect(f.inForm!.home[0].note).toMatch(/goles? en los últimos 5 partidos del equipo/);
    expect(f.inForm!.away).toEqual([]);
    expect(inFormPlayers([], [], 'A', Date.parse(m.date))).toEqual([]);
  });

  it('notas: qué usa el modelo y qué es solo informativo', () => {
    const t = f.notes.join(' ');
    expect(t).toMatch(/El modelo usa/);
    expect(t).toMatch(/Solo informativo/);
    expect(f.notes.length).toBeLessThanOrEqual(8);
  });
});

describe('buildMatchFactors: eliminatoria a doble partido', () => {
  const ida: MatchRecord = {
    id: 'IDA',
    compId: 'copadelrey',
    season: 2026,
    currentSeason: true,
    date: new Date(T0).toISOString(),
    status: 'finished',
    round: 'Octavos de final · Ida',
    home: team('B'),
    away: team('A'),
    score: { home: 2, away: 0 },
  };
  const vuelta: MatchRecord = { ...ida, id: 'VTA', date: new Date(T0 + 7 * DAY).toISOString(), status: 'scheduled', round: 'Octavos de final · Vuelta', home: team('A'), away: team('B'), score: undefined };

  it('global desde la vuelta, líder y frase', () => {
    const t = tieFactor(inputFor({ ms: [ida], ls: [] }, vuelta))!;
    expect(t).toMatchObject({ leg: 2, firstLegId: 'IDA', firstLeg: { home: 2, away: 0 }, aggregate: { home: 0, away: 2 }, leader: 'away', usedInModel: false });
    expect(t.summary).toBe('Equipo A pierde 0-2 en el global: necesita ganar por 2 goles para forzar la prórroga o los penaltis (por 3, pasa directamente).');
    const f = buildMatchFactors({ ...inputFor({ ms: [ida], ls: [] }, vuelta), comp: COPA });
    expect(validateMatchFactors(f, { match: { date: vuelta.date, round: vuelta.round }, players: { home: [], away: [] } })).toEqual([]);
  });

  it('empatada; y una ida no es vuelta', () => {
    const t = tieFactor(inputFor({ ms: [{ ...ida, score: { home: 1, away: 1 } }], ls: [] }, vuelta))!;
    expect(t.leader).toBe('none');
    expect(t.summary).toMatch(/^Global igualado 1-1/);
    expect(tieFactor(inputFor({ ms: [], ls: [] }, ida))).toBeUndefined();
  });

  it('una ida «del futuro» o a la misma hora no cuenta', () => {
    const fut = { ...ida, id: 'FUT', date: new Date(T0 + 8 * DAY).toISOString(), score: { home: 0, away: 5 } };
    const same = { ...ida, id: 'SAME', date: vuelta.date, score: { home: 0, away: 7 } };
    expect(tieFactor(inputFor({ ms: [fut, same], ls: [] }, vuelta))).toBeUndefined();
    expect(tieFactor(inputFor({ ms: [ida, fut, same], ls: [] }, vuelta))).toEqual(tieFactor(inputFor({ ms: [ida], ls: [] }, vuelta)));
  });
});

describe('buildMatchFactors: corte walk-forward', () => {
  const w = world();
  const m = target();
  const kickoff = Date.parse(m.date);
  const clean = buildMatchFactors(inputFor(w, m, PROPS));

  /** Futuro envenenado: partidos posteriores y a la misma hora (misma competición, mismos equipos y árbitro), con
   * marcadores y tarjetas extremos, rojas y líneas con goles; también una «ida» falsa. */
  function poisoned(): World {
    const ms: MatchRecord[] = [...w.ms];
    const ls: PlayerLine[] = [...w.ls];
    const mk = (id: string, t: number, h: string, a: string, round: string, compId = 'laliga'): MatchRecord => ({
      id,
      compId,
      season: 2026,
      currentSeason: true,
      date: new Date(t).toISOString(),
      status: 'finished',
      round,
      home: team(h),
      away: team(a),
      score: { home: 9, away: 0 },
      stats: { home: { goals: 9, shots: 40, shotsOnTarget: 20, fouls: 40, yellow: 9, red: 2 }, away: { goals: 0, shots: 1, shotsOnTarget: 0, fouls: 40, yellow: 9, red: 2 } },
      events: [{ minute: 10, clock: "10'", type: 'red', teamId: h, playerId: `${h}3` }],
      referee: { id: 'R1', name: 'Árbitro Uno' },
    });
    const extra = [
      mk('SAME', kickoff, 'A', 'C', 'Jornada 16'), // a la misma hora
      mk('FUT1', kickoff + DAY, 'A', 'B', 'Jornada 17'),
      mk('FUT2', kickoff + 3 * DAY, 'B', 'A', 'Jornada 18'),
      mk('FUT3', kickoff + 2 * DAY, 'D', 'E', 'Jornada 16'),
      mk('FUTCUP', kickoff + DAY, 'B', 'A', 'Octavos de final · Ida', 'copadelrey'),
    ];
    ms.push(...extra);
    for (const x of extra.filter((e) => e.home.id === 'A' || e.away.id === 'A')) {
      for (let p = 1; p <= 12; p++) ls.push(line(x, 'A', `A${p}`, { red: p === 3 ? 1 : 0, goals: 3, shotsOnTarget: 5 }));
    }
    return { ms, ls };
  }

  it('el bloque limpio no es trivial (árbitro, tabla, forma, casa/fuera, bajas y jugadores en forma)', () => {
    expect(clean.referee.status).toBe('conocido');
    for (const k of ['stakes', 'form', 'venue', 'absences', 'inForm'] as const) expect(clean[k]).toBeDefined();
  });

  it('partidos, líneas, árbitros y Elo posteriores o a la misma hora no cambian nada', () => {
    expect(buildMatchFactors(inputFor(poisoned(), m, PROPS))).toEqual(clean);
  });

  it('el partido ya jugado (con marcador, estadísticas, eventos y sus propias líneas) da el mismo bloque que antes de jugarse', () => {
    const p = poisoned();
    const played: MatchRecord = {
      ...m,
      status: 'finished',
      score: { home: 0, away: 6 },
      stats: { home: { goals: 0, shots: 2, shotsOnTarget: 0, fouls: 30, yellow: 8, red: 1 }, away: { goals: 6, shots: 30, shotsOnTarget: 15, fouls: 5, yellow: 0, red: 0 } },
      events: [{ minute: 5, clock: "5'", type: 'red', teamId: 'A', playerId: 'A4' }],
    };
    const ms = [...p.ms, played];
    const ls = [...p.ls, ...Array.from({ length: 11 }, (_, i) => line(played, 'A', `A${i + 1}`, { red: i === 3 ? 1 : 0, goals: 2 }))];
    expect(buildMatchFactors(inputFor({ ms, ls }, played, PROPS))).toEqual(clean);
  });

  it('rechaza una vista del pasado que no está cortada en el inicio del partido', () => {
    const i = inputFor(w, m);
    expect(() => buildMatchFactors({ ...i, history: historyView(source(w.ms, w.ls), kickoff + DAY) })).toThrow(/corte/);
  });
});
