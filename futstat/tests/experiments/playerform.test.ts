/**
 * Variantes «playerform-*» (pipeline/experiments/playerform/): prueba adversarial propia. La comprobación de fuga del
 * banco solo envenena con una copa ficticia; aquí se envenena LA MISMA COMPETICIÓN (jornadas «del futuro», un partido
 * a la misma hora, uno del mismo día anterior al partido, temporadas anteriores) y se comprueba que los factores del
 * rival de las props solo dependen del pasado (cortado por día, como producción), que con la contracción de producción
 * no cambian nada y que el multiplicador de forma es neutro sin historial más largo que la forma.
 */
import { describe, expect, it } from 'vitest';
import { COMPETITION_BY_ID } from '../../pipeline/config';
import type { PlayerPropsInput } from '../../pipeline/analytics/players';
import type { MatchRecord, PlayerLine } from '../../pipeline/types';
import { factorRatios, formMultipliers, scaleLines, statPool } from '../../pipeline/experiments/playerform/model';
import { loadVariant } from '../../pipeline/experiments/load';
import { isEmptyVariant, preMatchView, type FeatureContext, type HistoryView } from '../../pipeline/experiments/types';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 1, 18);
const team = (id: string) => ({ id, name: id, short: id, abbr: id.slice(0, 3).toUpperCase() });

function rec(
  id: string,
  at: number,
  home: string,
  away: string,
  s: { hs: number; as: number; hc?: number; ac?: number },
  o: { compId?: string; season?: number } = {},
): MatchRecord {
  return {
    id,
    compId: o.compId ?? 'laliga',
    season: o.season ?? 2026,
    currentSeason: (o.season ?? 2026) === 2026,
    date: new Date(at).toISOString(),
    status: 'finished',
    home: team(home),
    away: team(away),
    score: { home: 1, away: 1 },
    stats: {
      home: { goals: 1, shots: s.hs, shotsOnTarget: Math.round(s.hs / 3), yellow: s.hc ?? 2, red: 0 },
      away: { goals: 1, shots: s.as, shotsOnTarget: Math.round(s.as / 3), yellow: s.ac ?? 2, red: 0 },
    },
  };
}

function viewOf(all: MatchRecord[], cutoff: number): HistoryView {
  const past = all.filter((m) => Date.parse(m.date) < cutoff).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return {
    cutoff,
    cutoffIso: new Date(cutoff).toISOString(),
    teamMatches: (id) => past.filter((m) => m.home.id === id || m.away.id === id),
    compMatches: (id) => past.filter((m) => m.compId === id),
    eloBefore: () => undefined,
    playerLines: () => [],
    refereeMatches: () => [],
  };
}

/** Liga de 6 equipos: A tira muchísimo (22 por partido), el resto 11; 3 vueltas antes del partido objetivo. */
function league(): MatchRecord[] {
  const teams = ['A', 'B', 'C', 'D', 'E', 'F'];
  const out: MatchRecord[] = [];
  let k = 0;
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < teams.length; i++) {
      for (let j = 0; j < teams.length; j++) {
        if (i === j || (i + j + round) % 5 !== 0) continue;
        const h = teams[i];
        const a = teams[j];
        out.push(rec(`m${k++}`, T0 - (40 - round * 5) * DAY + i * 3600_000, h, a, { hs: h === 'A' ? 22 : 11, as: a === 'A' ? 22 : 11 }));
      }
    }
  }
  return out;
}

const target = rec('target', T0 + 10 * DAY, 'A', 'B', { hs: 0, as: 0 });
const cutoff = Date.parse(target.date);
const pre = preMatchView(target);

function line(playerId: string, matchId: string, day: number, shots: number, sot: number, minutes = 90): PlayerLine {
  return {
    matchId,
    compId: 'laliga',
    date: new Date(T0 + day * DAY).toISOString(),
    teamId: 'A',
    opponentId: 'B',
    isHome: true,
    playerId,
    name: playerId,
    short: playerId,
    position: 'F',
    starter: true,
    minutes,
    goals: 0,
    assists: 0,
    shots,
    shotsOnTarget: sot,
    yellow: 0,
    red: 0,
    foulsCommitted: 1,
    foulsSuffered: 1,
    offsides: 0,
    ownGoals: 0,
  };
}

describe('playerform (c): factores del rival con otra contracción', () => {
  const past = league();

  it('con la contracción de producción (40/40) los cocientes son exactamente 1', () => {
    const r = factorRatios(pre, viewOf(past, cutoff), 'home', 40, 40);
    expect(r).toEqual({ shots: 1, shotsOnTarget: 1, cards: 1 });
  });

  it('un equipo que tira mucho recupera tiros con contracción débil de su nivel propio (doble contracción)', () => {
    const r = factorRatios(pre, viewOf(past, cutoff), 'home', 6, 40);
    expect(r.shots).toBeGreaterThan(1.1);
    expect(r.shotsOnTarget).toBeGreaterThan(1.1);
    // y el rival (B, algo por debajo de una media que A infla) cambia mucho menos
    const rb = factorRatios(pre, viewOf(past, cutoff), 'away', 6, 40);
    expect(Math.abs(rb.shots - 1)).toBeLessThan(0.1);
  });

  it('envenenar la MISMA competición (futuro, misma hora, mismo día anterior, otra temporada) no cambia nada', () => {
    const clean = [6, 40].flatMap((ag) => (['home', 'away'] as const).map((s) => factorRatios(pre, viewOf(past, cutoff), s, 6, ag)));
    const poison = [
      ...past,
      // jornadas del futuro con tiros extremos
      rec('fut1', cutoff + 1, 'A', 'B', { hs: 0, as: 60, hc: 9, ac: 9 }),
      rec('fut2', cutoff + 3 * DAY, 'B', 'A', { hs: 60, as: 0, hc: 9, ac: 9 }),
      // a la misma hora (no es anterior)
      rec('same', cutoff, 'C', 'A', { hs: 60, as: 0, hc: 9, ac: 9 }),
      // el mismo día, ANTES del partido: producción corta por día y no lo usa
      rec('sameday', cutoff - 3 * 3600_000, 'B', 'C', { hs: 60, as: 60, hc: 9, ac: 9 }),
      // temporada anterior de la competición entre otros equipos (no es la temporada del partido)
      rec('old', cutoff - 300 * DAY, 'E', 'F', { hs: 60, as: 60, hc: 9, ac: 9 }, { season: 2025 }),
    ];
    const dirty = [6, 40].flatMap((ag) => (['home', 'away'] as const).map((s) => factorRatios(pre, viewOf(poison, cutoff), s, 6, ag)));
    expect(dirty).toEqual(clean);
    // el pool tampoco los contiene
    const ids = new Set(statPool(pre, viewOf(poison, cutoff)).map((m) => m.id));
    for (const id of ['fut1', 'fut2', 'same', 'sameday', 'old']) expect(ids.has(id)).toBe(false);
  });

  it('el gancho escala los factores de producción y deja los de respaldo (1) intactos', async () => {
    const v = await loadVariant('playerform-fac6x40');
    const ctx: FeatureContext = { comp: COMPETITION_BY_ID.get('laliga')!, configs: COMPETITION_BY_ID, homeLeague: new Map() };
    const base: PlayerPropsInput = {
      teamId: 'A',
      opponentId: 'B',
      lines: [],
      teamLambda: 1.5,
      teamAvgGoals: 1.4,
      oppShotsFactor: 0.8,
      oppSotFactor: 1,
      cardsFactor: 1.1,
      foulsFactor: 1,
    };
    const out = v.players!.adjust!({ ctx, match: pre, teamId: 'A', side: 'home', history: viewOf(past, cutoff), base });
    expect(out.oppShotsFactor!).toBeGreaterThan(0.8 * 1.1);
    expect(out.oppSotFactor).toBe(1);
    expect(out.cardsFactor!).toBeGreaterThan(0);
    expect(out.lines).toBeUndefined();
  });
});

describe('playerform (b): multiplicador de forma', () => {
  it('neutro (1) si todas las apariciones están dentro de las 5 últimas', () => {
    const ls = [1, 2, 3, 4].map((d) => line('p', `g${d}`, d, 3, 1));
    expect(formMultipliers(ls, 'A').get('p')).toBe(1);
  });

  it('> 1 si las 5 últimas son mejores que la ventana, < 1 si peores, recortado', () => {
    const cold = Array.from({ length: 10 }, (_, d) => line('hot', `g${d}`, d, d < 5 ? 1 : 5, d < 5 ? 0 : 2));
    const hot = Array.from({ length: 10 }, (_, d) => line('cold', `g${d}`, d, d < 5 ? 5 : 1, d < 5 ? 2 : 0));
    const m = formMultipliers([...cold, ...hot], 'A');
    expect(m.get('hot')!).toBeGreaterThan(1);
    expect(m.get('hot')!).toBeLessThanOrEqual(1.5);
    expect(m.get('cold')!).toBeLessThan(1);
    expect(m.get('cold')!).toBeGreaterThanOrEqual(0.67);
  });

  it('el orden de las líneas no importa y scaleLines no muta la entrada', () => {
    const ls = Array.from({ length: 8 }, (_, d) => line('p', `g${d}`, d, d < 3 ? 1 : 4, d < 3 ? 0 : 2));
    const a = formMultipliers(ls, 'A');
    const b = formMultipliers([...ls].reverse(), 'A');
    expect(a).toEqual(b);
    const copy = JSON.parse(JSON.stringify(ls));
    const scaled = scaleLines(ls, 'A', a);
    expect(ls).toEqual(copy);
    expect(scaled[7].shots).toBeCloseTo(4 * a.get('p')!, 10);
    expect(scaled[7].minutes).toBe(90);
  });
});

describe('playerform: variantes', () => {
  it('las 4 configuraciones cargan, tienen gancho players y se llaman como su archivo', async () => {
    for (const n of ['playerform-hl60', 'playerform-last5', 'playerform-fac6', 'playerform-fac6x40']) {
      const v = await loadVariant(n);
      expect(v.name).toBe(n);
      expect(isEmptyVariant(v)).toBe(false);
      expect(v.players).toBeDefined();
    }
  });
});
