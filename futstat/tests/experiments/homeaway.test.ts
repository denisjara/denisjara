/**
 * Variantes «homeaway-*» (pipeline/experiments/homeaway/): ventaja local propia por equipo en goles (rasgos + τ²
 * empírico-bayesiano en el combinador) y fuerza de la separación casa/fuera de las estadísticas (stats.adjust).
 * Comprueba la estimación en un mundo sintético, que kV = 40 reproduce producción (multiplicador 1), el combinador
 * (sin τ² = producción; «noOdds» no toca partidos con cuotas) y, sobre todo, una prueba ADVERSARIAL propia: la
 * comprobación de fuga del banco nunca mete partidos envenenados en la competición del partido predicho, y las dos
 * partes usan `compMatches` (ventaja local de la competición; medias de cada lado); aquí se añaden partidos futuros
 * extremos EN LA MISMA competición (y en otra, y con los mismos equipos) y todo debe ser idéntico.
 */
import { describe, expect, it } from 'vitest';
import { Elo } from '../../src/lib/models';
import type { MatchRecord } from '../../pipeline/types';
import { historyView } from '../../pipeline/experiments/history';
import { listVariants, loadVariant } from '../../pipeline/experiments/load';
import { preMatchView, type ComponentRow, type WalkForwardRow } from '../../pipeline/experiments/types';
import { HomeAwayCombiner, homeAwayFeatures, teamHomeAdv, MIN_EST } from '../../pipeline/experiments/homeaway/goals';
import { venueMultipliers } from '../../pipeline/experiments/homeaway/stats';
import { COMPETITIONS } from '../../pipeline/config';

const DAY = 86_400_000;
const T0 = Date.parse('2025-08-01T15:00:00Z');
const TEAMS = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5'];
let seq = 1;

function team(id: string) {
  return { id, name: id, short: id, abbr: id };
}

function match(compId: string, t: number, home: string, away: string, hg: number, ag: number, corners: [number, number] = [5, 4]): MatchRecord {
  return {
    id: `m${seq++}`,
    compId,
    season: 2025,
    currentSeason: true,
    date: new Date(t).toISOString(),
    status: 'finished',
    home: team(home),
    away: team(away),
    score: { home: hg, away: ag },
    stats: {
      home: { goals: hg, corners: corners[0], shots: 12, shotsOnTarget: 4, yellow: 2, red: 0 },
      away: { goals: ag, corners: corners[1], shots: 10, shotsOnTarget: 3, yellow: 2, red: 0 },
    },
  };
}

/** Liga a doble vuelta repetida: T0 gana 3-0 en casa y pierde 0-1 fuera (ventaja propia), el resto empata 1-1 / 2-1. */
function past(): MatchRecord[] {
  const out: MatchRecord[] = [];
  let d = 0;
  for (let rep = 0; rep < 3; rep++) {
    for (const h of TEAMS) {
      for (const a of TEAMS) {
        if (h === a) continue;
        d += 1;
        const t = T0 + d * DAY;
        if (h === 'T0') out.push(match('liga', t, h, a, 3, 0, [9, 3]));
        else if (a === 'T0') out.push(match('liga', t, h, a, 1, 0, [5, 4]));
        else out.push(match('liga', t, h, a, (d % 3) + 0, 1, [5 + (d % 2), 4]));
      }
    }
  }
  return out;
}

function source(ms: MatchRecord[]) {
  const byComp = new Map<string, MatchRecord[]>();
  const byTeam = new Map<string, MatchRecord[]>();
  const elo = new Elo({ k: 20, homeAdv: 65, init: 1500 });
  for (const m of [...ms].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))) {
    byComp.set(m.compId, [...(byComp.get(m.compId) ?? []), m]);
    for (const t of [m.home.id, m.away.id]) byTeam.set(t, [...(byTeam.get(t) ?? []), m]);
    elo.update({ id: m.id, date: m.date, home: m.home.id, away: m.away.id, hg: m.score!.home, ag: m.score!.away });
  }
  return { matchesByTeam: byTeam, matchesByComp: byComp, elo };
}

const comp = COMPETITIONS[0];
const fctx = { comp, configs: new Map(COMPETITIONS.map((c) => [c.id, c])), homeLeague: new Map<string, string>() };
const base = { corners: { home: 5, away: 4 }, cards: { home: 2, away: 2 }, shots: { home: 12, away: 10 }, shotsOnTarget: { home: 4, away: 3 } };

function row(features: Record<string, number>, hasMarket: boolean, neutral = false): ComponentRow {
  const p = { home: 0.45, draw: 0.27, away: 0.28 };
  return {
    matchId: 'x',
    date: '2026-03-01T15:00:00Z',
    compId: 'liga',
    kind: 'league',
    tier: 5,
    neutral,
    hasMarket,
    goalKind: 'dc',
    goal: p,
    elo: p,
    goalOver25: 0.5,
    lambdaHome: 1.5,
    lambdaAway: 1.1,
    rho: -0.05,
    eloDiff: 50,
    minEloGames: 30,
    features,
    production: p,
    weights: { goal: 0.5, elo: 0.5, market: 0 },
  };
}

describe('local/visitante: ventaja local propia por equipo (goles)', () => {
  it('detecta el exceso de rendimiento en casa del equipo que gana en casa y pierde fuera', () => {
    const ms = past();
    const cutoff = Date.parse(ms[ms.length - 1].date) + DAY;
    const h = historyView(source(ms), cutoff);
    const t0 = teamHomeAdv(h, 'T0');
    expect(t0.nHome).toBeGreaterThanOrEqual(5);
    expect(t0.v).toBeGreaterThan(0.5);
    expect(t0.var).toBeGreaterThan(0);
    // un equipo con el mismo rendimiento en casa y fuera queda cerca de 0 y por debajo de T0
    expect(teamHomeAdv(h, 'T3').v).toBeLessThan(t0.v);
    // sin Elo previo (equipo nuevo): sin estimación
    expect(teamHomeAdv(h, 'NUEVO').var).toBe(-1);
  });

  it('ADVERSARIAL: partidos futuros extremos en la MISMA competición, en otra y con los mismos equipos no cambian nada', () => {
    const ms = past();
    const cutoff = Date.parse(ms[ms.length - 1].date) + DAY;
    const target = preMatchView(match('liga', cutoff, 'T0', 'T1', 0, 0));
    const future: MatchRecord[] = [match('liga', cutoff, 'T0', 'T1', 9, 0, [30, 0])]; // en el mismo instante del corte
    for (let i = 1; i <= 40; i++) {
      future.push(match('liga', cutoff + i * 3_600_000, 'T1', 'T0', 9, 0, [30, 0]));
      future.push(match('liga', cutoff + i * DAY, TEAMS[i % 6], TEAMS[(i + 1) % 6], 0, 9, [0, 30]));
      future.push(match('liga', cutoff + i * DAY + 1, 'T4', 'T5', 9, 0, [30, 30]));
      future.push(match('copa', cutoff + i * DAY + 2, 'T0', TEAMS[(i % 5) + 1], 0, 9, [0, 30]));
    }
    const a = historyView(source(ms), cutoff);
    const b = historyView(source([...ms, ...future]), cutoff);
    const fa = homeAwayFeatures(fctx, target, a);
    const fb = homeAwayFeatures(fctx, target, b);
    expect(fa.haVarH).toBeGreaterThan(0);
    expect(fb).toEqual(fa);
    for (const kVenue of [15, Infinity]) {
      const sa = venueMultipliers(target, a, base, { kVenue });
      expect(Object.keys(sa).length).toBeGreaterThan(0);
      expect(venueMultipliers(target, b, base, { kVenue })).toEqual(sa);
    }
    // control: los mismos partidos ANTES del corte sí lo cambian (la prueba es sensible)
    const shifted = future.map((m) => ({ ...m, date: new Date(Date.parse(m.date) - 60 * DAY).toISOString() }));
    const c = historyView(source([...ms, ...shifted]), cutoff);
    expect(homeAwayFeatures(fctx, target, c)).not.toEqual(fa);
    expect(venueMultipliers(target, c, base, { kVenue: 15 })).not.toEqual(venueMultipliers(target, a, base, { kVenue: 15 }));
  });

  it('combinador: sin τ² = producción; τ² por momentos; «noOdds» no toca partidos con cuotas; campo neutral = producción', () => {
    const f = { haVH: 0.3, haVarH: 0.02, haVA: -0.1, haVarA: 0.02 };
    const comb = new HomeAwayCombiner({ apply: 'all' });
    expect(comb.blend(row(f, true))).toEqual(row(f, true).production);
    // filas con v̂² medio 0,05 y varianza media 0,02 ⇒ τ² = 0,03
    const rows = Array.from({ length: MIN_EST }, (_, i) => ({
      ...row({ haVH: i % 2 ? Math.sqrt(0.05) : -Math.sqrt(0.05), haVarH: 0.02, haVA: Math.sqrt(0.05), haVarA: 0.02 }, true),
      date: '2026-02-01T15:00:00Z',
      outcome: 0 as const,
      hg: 1,
      ag: 0,
    })) as WalkForwardRow[];
    comb.prepare(rows, '2026-03-01T00:00:00Z');
    expect(comb.tau2).toBeCloseTo(0.03, 12);
    // Δ = 0,3·0,03/0,05 − 0,1·0,03/0,05 = 0,12 > 0 ⇒ más local
    expect(comb.delta(row(f, true))).toBeCloseTo(0.12, 12);
    const p = comb.blend(row(f, true)) as { home: number; draw: number; away: number };
    expect(p.home).toBeGreaterThan(0.45);
    expect(p.away).toBeLessThan(0.28);
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 12);
    expect(comb.blend(row(f, true, true))).toEqual(row(f, true).production);
    // filas posteriores a asOf no cuentan
    const late = new HomeAwayCombiner({ apply: 'all' });
    late.prepare(rows, '2026-02-01T15:00:00Z');
    expect(late.tau2).toBeNull();
    const nodds = new HomeAwayCombiner({ apply: 'noOdds' });
    nodds.prepare(rows, '2026-03-01T00:00:00Z');
    expect(nodds.blend(row(f, true))).toEqual(row(f, true).production);
    expect(nodds.delta(row(f, false))).toBeCloseTo(0.12, 12);
  });
});

describe('local/visitante: fuerza de la separación casa/fuera de las estadísticas', () => {
  it('kV = 40 (producción) da multiplicador 1; kV = 15 refuerza y kV = ∞ quita la separación propia', () => {
    const ms = past();
    const cutoff = Date.parse(ms[ms.length - 1].date) + DAY;
    const h = historyView(source(ms), cutoff);
    const target = preMatchView(match('liga', cutoff, 'T0', 'T1', 0, 0));
    expect(venueMultipliers(target, h, base, { kVenue: 40 })).toEqual({});
    // T0 saca muchos más córners en casa que fuera: más separación ⇒ más córners del local; sin ella ⇒ menos
    const strong = venueMultipliers(target, h, base, { kVenue: 15 });
    const none = venueMultipliers(target, h, base, { kVenue: Infinity });
    expect(strong.corners!.home).toBeGreaterThan(1);
    expect(none.corners!.home).toBeLessThan(1);
    // tiros constantes (sin diferencia por condición respecto a la liga): sin cambio apreciable
    expect(Math.abs((none.shots?.home ?? 1) - 1)).toBeLessThan(0.05);
    // solo las estadísticas pedidas en `base`
    expect(Object.keys(venueMultipliers(target, h, { corners: base.corners }, { kVenue: 15 }))).toEqual(['corners']);
  });

  it('las cuatro variantes se cargan con el cargador oficial', async () => {
    const names = listVariants().filter((n) => n.startsWith('homeaway-'));
    expect(names.sort()).toEqual(['homeaway-goals', 'homeaway-goals-noodds', 'homeaway-stats-k15', 'homeaway-stats-nosplit']);
    for (const n of names) {
      const v = await loadVariant(n);
      expect(v.name).toBe(n);
      if (n.includes('stats')) expect(typeof v.stats?.adjust).toBe('function');
      else expect(typeof v.combine?.blend).toBe('function');
    }
  });
});
