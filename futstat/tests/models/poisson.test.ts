import { describe, expect, it } from 'vitest';
import {
  bttsProb,
  dcTau,
  expectedGoals,
  goalDiffDist,
  marginals,
  mean,
  mostLikelyScore,
  mulberry32,
  outcomeProbs,
  poissonCdf,
  poissonLogPmf,
  poissonPmf,
  poissonPmfArray,
  samplePoisson,
  scoreMatrix,
  summarizeMatrix,
  topScores,
  totalGoalsDist,
  variance,
} from '../../src/lib/models';

const matrixSum = (m: number[][]) => m.reduce((s, r) => s + r.reduce((a, b) => a + b, 0), 0);

describe('Poisson', () => {
  it('pmf con valores conocidos', () => {
    expect(poissonPmf(0, 1.5)).toBeCloseTo(Math.exp(-1.5), 14);
    expect(poissonPmf(2, 1.5)).toBeCloseTo((Math.exp(-1.5) * 1.5 ** 2) / 2, 14);
    expect(poissonPmf(-1, 1.5)).toBe(0);
    expect(poissonPmf(1.5, 1.5)).toBe(0);
    expect(poissonPmf(0, 0)).toBe(1);
    expect(poissonPmf(3, 0)).toBe(0);
  });

  it('estable en espacio logarítmico para k y λ grandes', () => {
    const p = poissonPmf(200, 150);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThan(0);
    // comparación con log directo
    expect(poissonLogPmf(200, 150)).toBeCloseTo(200 * Math.log(150) - 150 - 863.2319871924054, 6);
    expect(poissonPmf(1000, 1000)).toBeCloseTo(1 / Math.sqrt(2 * Math.PI * 1000), 5);
  });

  it('poissonPmfArray: longitud maxK+1, sin plegar la cola, suma ≈ 1 para maxK grande', () => {
    const a = poissonPmfArray(2.3, 5);
    expect(a).toHaveLength(6);
    expect(a.reduce((s, x) => s + x, 0)).toBeLessThan(1);
    const b = poissonPmfArray(2.3, 40);
    expect(b.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
  });

  it('cdf', () => {
    expect(poissonCdf(0, 1)).toBeCloseTo(Math.exp(-1), 14);
    expect(poissonCdf(2, 1)).toBeCloseTo(Math.exp(-1) * 2.5, 14);
    expect(poissonCdf(-1, 1)).toBe(0);
    expect(poissonCdf(1e6, 2)).toBe(1);
  });

  it('samplePoisson: media y varianza ≈ λ', () => {
    const rng = mulberry32(3);
    const xs = Array.from({ length: 20000 }, () => samplePoisson(2.7, rng));
    expect(mean(xs)).toBeCloseTo(2.7, 1);
    expect(variance(xs)).toBeCloseTo(2.7, 0);
  });
});

describe('Dixon-Coles τ y matriz de marcadores', () => {
  it('dcTau', () => {
    expect(dcTau(0, 0, 1.5, 1.2, 0.1)).toBeCloseTo(1 - 1.5 * 1.2 * 0.1, 14);
    expect(dcTau(0, 1, 1.5, 1.2, -0.1)).toBeCloseTo(1 - 0.15, 14);
    expect(dcTau(1, 0, 1.5, 1.2, -0.1)).toBeCloseTo(1 - 0.12, 14);
    expect(dcTau(1, 1, 1.5, 1.2, -0.1)).toBeCloseTo(1.1, 14);
    expect(dcTau(2, 1, 1.5, 1.2, -0.1)).toBe(1);
    expect(dcTau(0, 0, 3, 3, 0.2)).toBe(0); // recortado a >= 0
  });

  it('τ conserva la masa total sin truncado', () => {
    const lh = 1.4;
    const la = 1.1;
    const rho = -0.13;
    let corr = 0;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) corr += poissonPmf(i, lh) * poissonPmf(j, la) * (dcTau(i, j, lh, la, rho) - 1);
    expect(corr).toBeCloseTo(0, 15);
  });

  it('scoreMatrix normalizada a 1 y de tamaño correcto', () => {
    for (const [lh, la, rho, mg] of [
      [1.5, 1.1, -0.1, 10],
      [3.5, 0.4, 0.05, 7],
      [0.2, 0.2, 0, 3],
    ]) {
      const m = scoreMatrix(lh, la, rho, mg);
      expect(m).toHaveLength(mg + 1);
      expect(m[0]).toHaveLength(mg + 1);
      expect(matrixSum(m)).toBeCloseTo(1, 12);
      m.flat().forEach((v) => expect(v).toBeGreaterThanOrEqual(0));
    }
    expect(scoreMatrix(1, 1)).toHaveLength(11); // defaults rho = 0, maxGoals = 10
  });

  it('rho = 0 equivale al producto de Poisson independientes', () => {
    const m = scoreMatrix(1.3, 0.9, 0, 12);
    expect(m[2][1]).toBeCloseTo(poissonPmf(2, 1.3) * poissonPmf(1, 0.9), 8);
  });

  it('rho < 0 aumenta 0-0 y 1-1 y reduce 1-0 y 0-1', () => {
    const a = scoreMatrix(1.4, 1.2, 0);
    const b = scoreMatrix(1.4, 1.2, -0.15);
    expect(b[0][0]).toBeGreaterThan(a[0][0]);
    expect(b[1][1]).toBeGreaterThan(a[1][1]);
    expect(b[1][0]).toBeLessThan(a[1][0]);
    expect(b[0][1]).toBeLessThan(a[0][1]);
    expect(outcomeProbs(b).draw).toBeGreaterThan(outcomeProbs(a).draw);
  });

  it('outcomeProbs suma 1 y es simétrico al intercambiar λ', () => {
    const p = outcomeProbs(scoreMatrix(1.8, 0.9, -0.05));
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 14);
    expect(p.home).toBeGreaterThan(p.away);
    const q = outcomeProbs(scoreMatrix(0.9, 1.8, -0.05));
    expect(q.home).toBeCloseTo(p.away, 12);
    expect(q.away).toBeCloseTo(p.home, 12);
    expect(q.draw).toBeCloseTo(p.draw, 12);
    const s = outcomeProbs(scoreMatrix(1.2, 1.2, -0.1));
    expect(s.home).toBeCloseTo(s.away, 12);
  });

  it('utilidades de matriz: totales, diferencias, marginales, ambos marcan, top', () => {
    const m = scoreMatrix(1.6, 1.0, -0.08);
    const t = totalGoalsDist(m);
    expect(t.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
    expect(t[0]).toBeCloseTo(m[0][0], 14);
    const d = goalDiffDist(m);
    expect(d.p.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
    const p = outcomeProbs(m);
    expect(d.p[-d.min]).toBeCloseTo(p.draw, 12);
    const mg = marginals(m);
    expect(mg.home.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
    const xg = expectedGoals(m);
    expect(xg.home).toBeCloseTo(1.6, 2);
    expect(xg.away).toBeCloseTo(1.0, 2);
    expect(bttsProb(m)).toBeCloseTo(1 - mg.home[0] - mg.away[0] + m[0][0], 12);
    const top = topScores(m, 5);
    expect(top).toHaveLength(5);
    for (let i = 1; i < top.length; i++) expect(top[i].prob).toBeLessThanOrEqual(top[i - 1].prob);
    expect(mostLikelyScore(m)).toEqual(top[0]);
    const s = summarizeMatrix(m);
    expect(s.likelyScore).toBe(`${top[0].home}-${top[0].away}`);
    expect(s.over25).toBeCloseTo(1 - t[0] - t[1] - t[2], 12);
  });
});
