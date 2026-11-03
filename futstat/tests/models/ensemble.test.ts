import { describe, expect, it } from 'vitest';
import { blend, blendLog, dcOutcomes, fitLambdas, outcomeProbs, scoreMatrix, summarizeMatrix } from '../../src/lib/models';

describe('blend', () => {
  it('pool lineal con pesos renormalizados', () => {
    const p = blend([
      { probs: { home: 0.5, draw: 0.3, away: 0.2 }, weight: 0.5 },
      { probs: { home: 0.3, draw: 0.3, away: 0.4 }, weight: 0.5 },
    ]);
    expect(p.home).toBeCloseTo(0.4, 12);
    expect(p.draw).toBeCloseTo(0.3, 12);
    expect(p.away).toBeCloseTo(0.3, 12);
    const q = blend([
      { probs: { home: 0.5, draw: 0.3, away: 0.2 }, weight: 2 },
      { probs: { home: 0.3, draw: 0.3, away: 0.4 }, weight: 2 },
    ]);
    expect(q).toEqual(p);
  });

  it('ignora pesos <= 0 y devuelve uniforme si no hay fuentes', () => {
    const p = blend([
      { probs: { home: 0.6, draw: 0.25, away: 0.15 }, weight: 0.3 },
      { probs: { home: 0.1, draw: 0.1, away: 0.8 }, weight: 0 },
      { probs: { home: 0.1, draw: 0.1, away: 0.8 }, weight: -1 },
    ]);
    expect(p.home).toBeCloseTo(0.6, 12);
    const u = blend([]);
    expect(u.home).toBeCloseTo(1 / 3, 12);
    const s = p.home + p.draw + p.away;
    expect(s).toBeCloseTo(1, 12);
  });

  it('pool logarítmico suma 1', () => {
    const p = blendLog([
      { probs: { home: 0.5, draw: 0.3, away: 0.2 }, weight: 1 },
      { probs: { home: 0.3, draw: 0.3, away: 0.4 }, weight: 1 },
    ]);
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 12);
  });
});

describe('fitLambdas', () => {
  const cases: [number, number, number][] = [
    [1.7, 0.9, -0.08],
    [0.6, 2.8, 0.05],
    [3.5, 0.3, -0.1],
    [1.1, 1.1, 0],
    [0.4, 0.5, -0.15],
    [2.4, 1.9, 0.1],
  ];

  it('dcOutcomes coincide con scoreMatrix(·,·,rho,10)', () => {
    const o = dcOutcomes(1.6, 1.2, -0.07);
    const m = scoreMatrix(1.6, 1.2, -0.07, 10);
    const p = outcomeProbs(m);
    expect(o.home).toBeCloseTo(p.home, 12);
    expect(o.draw).toBeCloseTo(p.draw, 12);
    expect(o.over25).toBeCloseTo(summarizeMatrix(m).over25, 12);
  });

  it('reproduce objetivos 1X2 coherentes (error < 0.01, en la práctica ~1e-8)', () => {
    for (const [lh, la, rho] of cases) {
      const target = outcomeProbs(scoreMatrix(lh, la, rho));
      const fit = fitLambdas(target, rho, { lambdaHome: 1.3, lambdaAway: 1.2 });
      const got = outcomeProbs(scoreMatrix(fit.lambdaHome, fit.lambdaAway, rho));
      expect(Math.abs(got.home - target.home)).toBeLessThan(0.01);
      expect(Math.abs(got.draw - target.draw)).toBeLessThan(0.01);
      expect(Math.abs(got.away - target.away)).toBeLessThan(0.01);
      expect(Math.abs(got.home - target.home)).toBeLessThan(1e-6);
      expect(fit.lambdaHome).toBeCloseTo(lh, 3);
      expect(fit.lambdaAway).toBeCloseTo(la, 3);
    }
  });

  it('con over25 reproduce los cuatro objetivos', () => {
    const m = scoreMatrix(1.45, 1.2, -0.05);
    const target = { ...outcomeProbs(m), over25: summarizeMatrix(m).over25 };
    const fit = fitLambdas(target, -0.05, { lambdaHome: 2.5, lambdaAway: 0.6 });
    const o = dcOutcomes(fit.lambdaHome, fit.lambdaAway, -0.05);
    expect(Math.abs(o.over25 - target.over25)).toBeLessThan(1e-6);
    expect(Math.abs(o.home - target.home)).toBeLessThan(1e-6);
  });

  it('acepta objetivos no normalizados (p. ej. con margen) y respeta los límites [0.05, 6]', () => {
    const t = outcomeProbs(scoreMatrix(1.5, 1.0, -0.05));
    const scaled = { home: t.home * 1.06, draw: t.draw * 1.06, away: t.away * 1.06 };
    const fit = fitLambdas(scaled, -0.05, { lambdaHome: 1, lambdaAway: 1 });
    expect(fit.lambdaHome).toBeCloseTo(1.5, 3);
    const extreme = fitLambdas({ home: 0.995, draw: 0.004, away: 0.001 }, 0, { lambdaHome: 1, lambdaAway: 1 });
    expect(extreme.lambdaHome).toBeLessThanOrEqual(6);
    expect(extreme.lambdaAway).toBeGreaterThanOrEqual(0.05);
    const bad = fitLambdas({ home: Number.NaN, draw: 0, away: 0 }, 0, { lambdaHome: 1.4, lambdaAway: 1.1 });
    expect(bad.lambdaHome).toBeCloseTo(1.4, 12);
  });

  it('es rápido (< 20 ms por partido de media)', () => {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) {
      const lh = 0.6 + (i % 10) * 0.25;
      const la = 0.5 + ((i * 7) % 10) * 0.2;
      fitLambdas(outcomeProbs(scoreMatrix(lh, la, -0.06)), -0.06, { lambdaHome: 1.4, lambdaAway: 1.1 });
    }
    expect((performance.now() - t0) / 50).toBeLessThan(20);
  });
});
