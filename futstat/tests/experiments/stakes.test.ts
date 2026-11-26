/**
 * Variantes «stakes-*» (pipeline/experiments/stakes/): prueba adversarial propia de la necesidad de marcar. La
 * comprobación de fuga del banco solo envenena con una copa ficticia; aquí se envenena LA MISMA COMPETICIÓN (idas y
 * jornadas «del futuro», un partido a la misma hora, temporadas anteriores) y se comprueba que el estado de la
 * eliminatoria y lo que se juega cada equipo solo dependen del pasado de la temporada, que los efectos van en la
 * dirección declarada y que sin contexto todo es producción.
 */
import { describe, expect, it } from 'vitest';
import { COMPETITION_BY_ID } from '../../pipeline/config';
import type { MatchRecord } from '../../pipeline/types';
import { findFirstLeg, legStatMultipliers, tieState } from '../../pipeline/experiments/stakes/legs';
import { matchStakes } from '../../pipeline/experiments/stakes/table';
import { makeStakesVariant, shiftTowards } from '../../pipeline/experiments/stakes/make';
import { loadVariant } from '../../pipeline/experiments/load';
import { preMatchView, type ComponentRow, type FeatureContext, type HistoryView } from '../../pipeline/experiments/types';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5, 18);
const team = (id: string) => ({ id, name: id, short: id, abbr: id.slice(0, 3).toUpperCase() });

function rec(id: string, day: number, home: string, away: string, hg: number, ag: number, o: { compId?: string; season?: number; round?: string } = {}): MatchRecord {
  return {
    id,
    compId: o.compId ?? 'laliga',
    season: o.season ?? 2025,
    currentSeason: false,
    date: new Date(T0 + day * DAY).toISOString(),
    status: 'finished',
    home: team(home),
    away: team(away),
    round: o.round,
    score: { home: hg, away: ag },
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

describe('stakes (a): vuelta de eliminatoria', () => {
  const ida = rec('ida', 0, 'B', 'A', 2, 0, { compId: 'champions', round: 'Octavos de final · Ida' });
  const vuelta = rec('vuelta', 7, 'A', 'B', 0, 0, { compId: 'champions', round: 'Octavos de final · Vuelta' });
  const cutoff = Date.parse(vuelta.date);

  it('encuentra la ida y calcula el global del local de la vuelta (A pierde por 2)', () => {
    const st = tieState(preMatchView(vuelta), viewOf([ida], cutoff));
    expect(st).toMatchObject({ kind: 'trail2', trailing: 'home', agg: -2, firstLegId: 'ida' });
    const mult = legStatMultipliers(st, { shots: { home: 12, away: 10 }, corners: { home: 5, away: 4 }, cards: { home: 2, away: 2 } });
    expect(mult.shots!.home).toBeGreaterThan(1);
    expect(mult.shots!.away).toBeLessThan(1);
    expect(mult.corners!.home).toBeGreaterThan(1);
  });

  it('idas «del futuro», a la misma hora, de otra temporada u otra ronda/competición no cuentan', () => {
    const poison = [
      rec('fut', 8, 'B', 'A', 0, 5, { compId: 'champions', round: 'Octavos de final · Ida' }), // después de la vuelta
      rec('same', 7, 'B', 'A', 0, 7, { compId: 'champions', round: 'Octavos de final · Ida' }), // misma hora
      rec('old', -300, 'B', 'A', 0, 3, { compId: 'champions', round: 'Octavos de final · Ida', season: 2024 }),
      rec('otherRound', 1, 'B', 'A', 0, 4, { compId: 'champions', round: 'Cuartos de final · Ida' }),
      rec('otherComp', 1, 'B', 'A', 0, 4, { compId: 'europa', round: 'Octavos de final · Ida' }),
    ];
    const clean = viewOf([ida], cutoff);
    const dirty = viewOf([ida, ...poison], cutoff);
    expect(tieState(preMatchView(vuelta), dirty)).toEqual(tieState(preMatchView(vuelta), clean));
    // sin la ida verdadera, ninguna de las envenenadas sirve
    expect(findFirstLeg(preMatchView(vuelta), viewOf(poison, cutoff))).toBeUndefined();
  });

  it('una ida no es vuelta; empatada y pierde por 1 se clasifican bien', () => {
    expect(tieState(preMatchView(ida), viewOf([], Date.parse(ida.date)))).toBeUndefined();
    const ida11 = { ...ida, score: { home: 1, away: 1 } };
    expect(tieState(preMatchView(vuelta), viewOf([ida11], cutoff))?.kind).toBe('level');
    const ida01 = { ...ida, score: { home: 0, away: 1 } };
    expect(tieState(preMatchView(vuelta), viewOf([ida01], cutoff))).toMatchObject({ kind: 'trail1', trailing: 'away' });
  });
});

/** Liga de 10 equipos a doble vuelta (18 jornadas): T0..T9; el rango de fuerza da una tabla escalonada. */
function league(rounds: number, season = 2025, compId = 'laliga', offset = 0): MatchRecord[] {
  const teams = Array.from({ length: 10 }, (_, i) => `T${i}`);
  const out: MatchRecord[] = [];
  // calendario circular (método del círculo) para 2·9 jornadas
  const arr = teams.slice();
  const sched: [string, string][][] = [];
  for (let r = 0; r < 9; r++) {
    const pairs: [string, string][] = [];
    for (let i = 0; i < 5; i++) pairs.push([arr[i], arr[9 - i]]);
    sched.push(pairs);
    arr.splice(1, 0, arr.pop()!);
  }
  for (let r = 0; r < 9; r++) sched.push(sched[r].map(([h, a]) => [a, h] as [string, string]));
  for (let r = 0; r < rounds; r++) {
    for (const [h, a] of sched[r]) {
      const ih = Number(h.slice(1));
      const ia = Number(a.slice(1));
      // el de menor índice gana siempre (T0 campeón, T9 colista)
      out.push(rec(`${compId}-${season}-${r}-${h}${a}`, offset + r * 7, h, a, ih < ia ? 2 : 0, ih < ia ? 0 : 2, { compId, season }));
    }
  }
  return out;
}

describe('stakes (b): qué se juega en la recta final', () => {
  const comp = COMPETITION_BY_ID.get('laliga')!; // zonas: campeón 1, Champions 1-4, Europa 5-6, descenso últimos 3
  const past = league(17); // 17 de 18 jornadas jugadas
  const target = preMatchView(rec('t', 17 * 7, 'T0', 'T5', 0, 0));
  const cutoff = Date.parse(target.date);

  it('rangos de posición: el líder empatable se juega el título; el colista ya descendido no se juega nada', () => {
    const s = matchStakes(comp, target, viewOf(past, cutoff), 'strict');
    expect(s).toBeDefined();
    expect(s!.n).toBe(10);
    expect(s!.home.remaining).toBe(1);
    // T0 gana todo; con una jornada su perseguidor aún puede igualarle a puntos (el empate cuenta como «puede acabar
    // por encima») ⇒ se juega el título
    expect(s!.home.best).toBe(1);
    expect(s!.home.worst).toBe(2);
    expect(s!.home.nothing).toBe(false);
    const last = matchStakes(comp, { ...target, home: team('T0'), away: team('T9') }, viewOf(past, cutoff), 'strict')!;
    expect(last.away.points).toBe(0);
    expect(last.away.worst).toBe(10);
    expect(last.away.best).toBeGreaterThanOrEqual(8); // descenso = puestos 8-10
    expect(last.away.nothing).toBe(true);
    // 'soft' (ritmos realistas 0,75/2,25) nunca marca menos equipos «sin nada en juego» que 'strict'
    for (const id of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']) {
      const m = { ...target, home: team('T0'), away: team(id) };
      const st = matchStakes(comp, m, viewOf(league(15), cutoff), 'strict')!;
      const so = matchStakes(comp, m, viewOf(league(15), cutoff), 'soft')!;
      expect(so.away.best).toBeGreaterThanOrEqual(st.away.best);
      expect(so.away.worst).toBeLessThanOrEqual(st.away.worst);
      if (st.away.nothing) expect(so.away.nothing).toBe(true);
    }
  });

  it('antes del 75 % de la fase regular o en ligas de fases partidas no se calcula', () => {
    const early = league(10);
    expect(matchStakes(comp, target, viewOf(early, cutoff), 'strict')).toBeUndefined();
    const mx = COMPETITION_BY_ID.get('ligamx')!;
    expect(matchStakes(mx, { ...target, compId: 'ligamx' }, viewOf(league(17, 2025, 'ligamx'), cutoff), 'strict')).toBeUndefined();
  });

  it('partidos «del futuro» de la MISMA liga, a la misma hora y de otras temporadas no cambian nada', () => {
    const poison = [
      ...league(18, 2025, 'laliga', 17 * 7 + 1).map((m) => ({ ...m, id: `fut-${m.id}`, score: { home: m.score!.away, away: m.score!.home } })), // temporada repetida después del corte
      { ...rec('same', 17 * 7, 'T9', 'T0', 9, 0), id: 'same-time' },
      ...league(18, 2024, 'laliga', -400).map((m) => ({ ...m, id: `old-${m.id}`, score: { home: m.score!.away, away: m.score!.home } })),
    ];
    for (const mode of ['strict', 'soft'] as const) {
      expect(matchStakes(comp, target, viewOf([...past, ...poison], cutoff), mode)).toEqual(matchStakes(comp, target, viewOf(past, cutoff), mode));
    }
  });
});

describe('variantes stakes-*', () => {
  it('desplazamiento del 1X2 hacia el motivado y producción con cuotas o sin contexto', () => {
    const p = { home: 0.4, draw: 0.3, away: 0.3 };
    const q = shiftTowards(p, 'home', 0.12);
    expect(q.home).toBeGreaterThan(p.home);
    expect(q.away).toBeLessThan(p.away);
    expect(q.home + q.draw + q.away).toBeCloseTo(1, 12);
    const v = makeStakesVariant('stakes-all', 'x', { legs: true, table: 'strict' });
    const row = { production: p, hasMarket: false, features: { stkTable: 1, stkHomeNothing: 1, stkAwayNothing: 0 } } as unknown as ComponentRow;
    const out = v.combine!.blend(row) as typeof p;
    expect(out.away).toBeGreaterThan(p.away); // el visitante se juega algo
    expect(v.combine!.blend({ ...row, hasMarket: true })).toBe(p);
    expect(v.combine!.blend({ ...row, features: {} })).toBe(p);
    expect(v.combine!.blend({ ...row, features: { stkTable: 1, stkHomeNothing: 1, stkAwayNothing: 1 } })).toBe(p);
  });

  it('stats.adjust neutro sin vuelta ni recta final', () => {
    const v = makeStakesVariant('stakes-all', 'x', { legs: true, table: 'strict' });
    const ctx = { comp: COMPETITION_BY_ID.get('laliga')!, configs: COMPETITION_BY_ID, homeLeague: new Map() } as FeatureContext;
    const m = preMatchView(rec('x', 3, 'T0', 'T1', 0, 0));
    expect(v.stats!.adjust!({ ctx, match: m, history: viewOf(league(3), Date.parse(m.date)), base: { cards: { home: 2, away: 2 } } })).toEqual({});
    expect(v.features!(ctx, m, viewOf(league(3), Date.parse(m.date)))).toEqual({});
  });

  it('las cuatro configuraciones cargan y pasan la comprobación de código fuente', async () => {
    for (const n of ['stakes-legs', 'stakes-table', 'stakes-table-soft', 'stakes-all']) expect((await loadVariant(n)).name).toBe(n);
  });
});
