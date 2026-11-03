import { describe, expect, it } from 'vitest';
import {
  clamp,
  correlation,
  ewma,
  lgamma,
  logFactorial,
  logSumExp,
  mean,
  median,
  mulberry32,
  normalize,
  quantile,
  round,
  sampleDiscrete,
  shrink,
  stdDev,
  sum,
  variance,
  weightedMean,
} from '../../src/lib/models';

describe('stats básicas', () => {
  it('mean / variance (muestral n-1) / stdDev', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBe(0);
    expect(variance([1, 2, 3, 4])).toBeCloseTo(1.6666667, 6);
    expect(variance([5])).toBe(0);
    expect(variance([])).toBe(0);
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });

  it('sum estable (Kahan)', () => {
    const xs = new Array(100000).fill(0.1);
    expect(sum(xs)).toBeCloseTo(10000, 9);
  });

  it('clamp y round', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.3, 0, 1)).toBe(0.3);
    expect(round(1.23456)).toBe(1.235);
    expect(round(1.0005, 3)).toBe(1.001);
    expect(round(-1.23456, 2)).toBe(-1.23);
    expect(round(2.5, 0)).toBe(3);
    expect(round(-2.5, 0)).toBe(-3);
    expect(Object.is(round(-0.0001, 2), 0)).toBe(true);
  });

  it('ewma: cronológica, más reciente al final', () => {
    expect(ewma([1, 2, 3], 1)).toBe(3);
    expect(ewma([1, 2, 3], 0)).toBeCloseTo(2, 12);
    // pesos 0.25, 0.5, 1 normalizados
    expect(ewma([1, 2, 3], 0.5)).toBeCloseTo((1 * 0.25 + 2 * 0.5 + 3 * 1) / 1.75, 12);
    expect(ewma([], 0.3)).toBe(0);
    // la observación reciente pesa más
    expect(ewma([0, 0, 0, 10], 0.3)).toBeGreaterThan(ewma([10, 0, 0, 0], 0.3));
  });

  it('shrink', () => {
    expect(shrink(2, 10, 1, 10)).toBe(1.5);
    expect(shrink(2, 0, 1, 5)).toBe(1);
    expect(shrink(2, 100, 1, 0)).toBe(2);
    expect(shrink(2, 0, 1, 0)).toBe(1);
  });

  it('weightedMean, quantile, median, correlation, normalize, logSumExp', () => {
    expect(weightedMean([1, 3], [1, 3])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 12);
    expect(correlation([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(correlation([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 12);
    expect(normalize([1, 1, 2])).toEqual([0.25, 0.25, 0.5]);
    expect(logSumExp([1000, 1000])).toBeCloseTo(1000 + Math.log(2), 10);
  });
});

describe('funciones especiales', () => {
  it('lgamma coincide con valores conocidos', () => {
    expect(lgamma(1)).toBeCloseTo(0, 13);
    expect(lgamma(2)).toBeCloseTo(0, 13);
    expect(lgamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 13);
    expect(lgamma(10)).toBeCloseTo(Math.log(362880), 11);
    expect(lgamma(100)).toBeCloseTo(359.13420536957540, 9);
    expect(lgamma(1e6)).toBeCloseTo(12815504.569147612, 3);
    // reflexión: Γ(-0.5) = -2√π
    expect(lgamma(-0.5)).toBeCloseTo(Math.log(2 * Math.sqrt(Math.PI)), 12);
    expect(lgamma(0)).toBe(Infinity);
  });

  it('logFactorial exacto por tabla y continuo con lgamma', () => {
    expect(logFactorial(0)).toBe(0);
    expect(logFactorial(5)).toBeCloseTo(Math.log(120), 13);
    expect(logFactorial(1024)).toBeCloseTo(lgamma(1025), 8);
    expect(logFactorial(2000)).toBeCloseTo(lgamma(2001), 8);
  });
});

describe('aleatoriedad reproducible', () => {
  it('mulberry32 es determinista y uniforme', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 1000 }, () => a());
    const ys = Array.from({ length: 1000 }, () => b());
    expect(xs).toEqual(ys);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(mean(xs)).toBeCloseTo(0.5, 1);
  });

  it('sampleDiscrete respeta las frecuencias', () => {
    const rng = mulberry32(7);
    const counts = [0, 0, 0];
    for (let i = 0; i < 30000; i++) counts[sampleDiscrete([0.2, 0.5, 0.3], rng)]++;
    expect(counts[0] / 30000).toBeCloseTo(0.2, 1);
    expect(counts[1] / 30000).toBeCloseTo(0.5, 1);
    expect(counts[2] / 30000).toBeCloseTo(0.3, 1);
  });
});
