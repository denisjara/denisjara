/**
 * Combinador aprendido de las variantes «stack*» (pipeline/experiments/stack/combiner.ts): recupera pesos conocidos,
 * con L2 infinita se queda en el prior (pesos de producción), solo usa filas que empezaron al menos `guardHours` antes
 * del reajuste, no arrastra estado entre reajustes, cae a producción sin datos y las variantes cargan y pasan la
 * comprobación de código fuente del banco.
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/lib/models';
import type { Prob1X2 } from '../../src/types/data';
import { OverStacker, StackCombiner } from '../../pipeline/experiments/stack/combiner';
import { loadVariant } from '../../pipeline/experiments/load';
import type { ComponentRow, WalkForwardRow } from '../../pipeline/experiments/types';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5, 18);

function norm(h: number, d: number, a: number): Prob1X2 {
  const s = h + d + a;
  return { home: h / s, draw: d / s, away: a / s };
}

/** Pool logarítmico con pesos w (orden: mercado, dc, elo). */
function logPool(ps: Prob1X2[], w: number[]): Prob1X2 {
  const l = (k: keyof Prob1X2) => Math.exp(ps.reduce((s, p, i) => s + w[i] * Math.log(p[k]), 0));
  return norm(l('home'), l('draw'), l('away'));
}

function sample(p: Prob1X2, u: number): 0 | 1 | 2 {
  return u < p.home ? 0 : u < p.home + p.draw ? 1 : 2;
}

/** Filas sintéticas con cuotas: el resultado sale del pool logarítmico de las fuentes con pesos `truth`. */
function rows(n: number, truth: number[], seed = 3, opts: { hasMarket?: boolean; start?: number } = {}): WalkForwardRow[] {
  const rng = mulberry32(seed);
  const out: WalkForwardRow[] = [];
  const hasMarket = opts.hasMarket ?? true;
  for (let i = 0; i < n; i++) {
    const s = (rng() - 0.5) * 2.4;
    const noise = () => (rng() - 0.5) * 0.8;
    const src = (e: number) => norm(Math.exp(0.5 * (s + e)), 0.9 + 0.2 * rng(), Math.exp(-0.5 * (s + e)));
    const market = src(noise() * 0.3);
    const dc = src(noise());
    const elo = src(noise());
    const p = hasMarket ? logPool([market, dc, elo], truth) : logPool([dc, elo], truth.slice(1));
    const outcome = sample(p, rng());
    const row: WalkForwardRow = {
      matchId: `m${seed}-${i}`,
      date: new Date((opts.start ?? T0) + Math.floor(i / 8) * DAY).toISOString(),
      compId: 'liga',
      kind: 'league',
      tier: 6,
      neutral: false,
      hasMarket,
      goalKind: 'dc',
      goal: dc,
      dc,
      elo,
      ...(hasMarket ? { market } : {}),
      goalOver25: 0.5,
      lambdaHome: 1.4,
      lambdaAway: 1.1,
      rho: -0.05,
      eloDiff: s * 100,
      minEloGames: 30,
      features: {},
      production: hasMarket ? norm(0.8 * market.home + 0.05 * dc.home + 0.15 * elo.home, 0.8 * market.draw + 0.05 * dc.draw + 0.15 * elo.draw, 0.8 * market.away + 0.05 * dc.away + 0.15 * elo.away) : norm(dc.home + elo.home, dc.draw + elo.draw, dc.away + elo.away),
      weights: hasMarket ? { goal: 0.05, elo: 0.15, market: 0.8 } : { goal: 0.5, elo: 0.5, market: 0 },
      outcome,
      hg: outcome === 0 ? 1 : outcome === 1 ? 1 : 0,
      ag: outcome === 0 ? 0 : outcome === 1 ? 1 : 1,
    };
    out.push(row);
  }
  return out;
}

const asOfAfter = (rs: WalkForwardRow[]) => new Date(Date.parse(rs[rs.length - 1].date) + DAY).toISOString();

describe('StackCombiner', () => {
  it('recupera los pesos de un pool logarítmico conocido con muchos datos', () => {
    const truth = [0.6, 0.1, 0.4];
    const rs = rows(20000, truth);
    const c = new StackCombiner({ kappa: 1, kappaFeat: 1e9, apply: 'odds', lowData: false });
    c.prepare(rs, asOfAfter(rs));
    const d = c.describe().odds;
    expect(d.n).toBe(20000);
    // fuentes muy correlacionadas (comparten la fuerza s): tolerancia de 0,1
    expect(Math.abs(d['w.market'] - 0.6)).toBeLessThan(0.1);
    expect(Math.abs(d['w.dc'] - 0.1)).toBeLessThan(0.1);
    expect(Math.abs(d['w.elo'] - 0.4)).toBeLessThan(0.1);
  });

  it('con L2 infinita se queda en el prior (pesos de producción)', () => {
    const rs = rows(500, [1.5, 0.5, 0]);
    const c = new StackCombiner({ kappa: 1e12, apply: 'odds' });
    c.prepare(rs, asOfAfter(rs));
    const d = c.describe().odds;
    expect(d['w.market']).toBeCloseTo(0.8, 6);
    expect(d['w.dc']).toBeCloseTo(0.05, 6);
    expect(d['w.elo']).toBeCloseTo(0.15, 6);
  });

  it('cae a producción antes del primer reajuste, con pocas filas y en segmentos que no aplica', () => {
    const rs = rows(300, [0.8, 0.05, 0.15]);
    const c = new StackCombiner({ kappa: 30, apply: 'odds', minRows: 60 });
    expect(c.blend(rs[0])).toEqual(rs[0].production);
    c.prepare(rs.slice(0, 40), asOfAfter(rs.slice(0, 40)));
    expect(c.blend(rs[0])).toEqual(rs[0].production);
    c.prepare(rs, asOfAfter(rs));
    expect(c.blend(rs[0])).not.toEqual(rs[0].production);
    const sin = rows(300, [0, 0.5, 0.5], 9, { hasMarket: false });
    c.prepare([...rs, ...sin], asOfAfter(rs));
    expect(c.blend(sin[0])).toEqual(sin[0].production);
  });

  it('solo usa filas que empezaron al menos guardHours antes del reajuste (nada del futuro)', () => {
    const rs = rows(400, [0.8, 0.05, 0.15]);
    const asOf = asOfAfter(rs);
    const a = new StackCombiner({ kappa: 10, apply: 'odds', guardHours: 3 });
    a.prepare(rs, asOf);
    // filas añadidas con inicio a menos de 3 h del reajuste o posteriores, con resultados extremos: deben ignorarse
    const t = Date.parse(asOf);
    const late = rows(200, [3, 0, 0], 11, { start: t - 2 * 3_600_000 }).map((r, i) => ({ ...r, date: new Date(t - 2 * 3_600_000 + i * 60_000).toISOString(), outcome: 2 as const }));
    const b = new StackCombiner({ kappa: 10, apply: 'odds', guardHours: 3 });
    b.prepare([...rs, ...late], asOf);
    expect(b.describe()).toEqual(a.describe());
    expect(b.blend(rs[5])).toEqual(a.blend(rs[5]));
  });

  it('cada reajuste empieza de cero (sin estado arrastrado) y es determinista', () => {
    const r1 = rows(400, [0.5, 0.3, 0.2], 21);
    const r2 = rows(400, [0.9, 0, 0.1], 22);
    const a = new StackCombiner({ kappa: 30, apply: 'odds' });
    a.prepare(r1, asOfAfter(r1));
    a.prepare(r2, asOfAfter(r2));
    const b = new StackCombiner({ kappa: 30, apply: 'odds' });
    b.prepare(r2, asOfAfter(r2));
    expect(a.describe()).toEqual(b.describe());
    const p = a.blend(r2[3]);
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 12);
  });

  it('nonNeg fija a 0 las fuentes con peso negativo', () => {
    const rs = rows(20000, [1, -0.3, 0.2], 31);
    const c = new StackCombiner({ kappa: 1, kappaFeat: 1e9, apply: 'odds', lowData: false, nonNeg: true });
    c.prepare(rs, asOfAfter(rs));
    const d = c.describe().odds;
    expect(d['w.dc']).toBeUndefined();
    expect(d['w.market']).toBeGreaterThan(0);
  });
});

describe('OverStacker', () => {
  it('sin datos devuelve undefined (fórmula de producción) y con L2 infinita el prior', () => {
    const rs = rows(300, [0.8, 0.05, 0.15]).map((r) => ({ ...r, marketOver25: 0.55, goalOver25: 0.45 }));
    const o = new OverStacker({ kappa: 1e12 });
    expect(o.predict(rs[0] as ComponentRow)).toBeUndefined();
    o.prepare(rs, asOfAfter(rs));
    const lg = (p: number) => Math.log(p / (1 - p));
    const z = 0.06 * lg(0.45) + 0.94 * lg(0.55);
    expect(o.predict(rs[0])).toBeCloseTo(1 / (1 + Math.exp(-z)), 6);
  });
});

describe('variantes stack*', () => {
  it('cargan, pasan la comprobación de código fuente y caen a producción sin filas', async () => {
    for (const name of ['stack', 'stack-nonneg', 'stack-ou', 'stack-full']) {
      const v = await loadVariant(name);
      expect(v.name).toBe(name);
      expect(v.combine?.blend).toBeTypeOf('function');
    }
    const v = await loadVariant('stack');
    v.combine!.prepare!([], '2026-01-01T00:00:00.000Z');
    const r = rows(1, [0.8, 0.05, 0.15])[0];
    expect(v.combine!.blend(r)).toEqual(r.production);
  });
});
