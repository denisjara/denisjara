import { describe, expect, it } from 'vitest';
import {
  compareDists,
  convolve,
  estimateDispersion,
  mean,
  mulberry32,
  nbPmf,
  nbPmfArray,
  nbVariance,
  overUnderFromDist,
  poissonPmf,
  poissonPmfArray,
  sampleNegBin,
  variance,
} from '../../src/lib/models';

describe('binomial negativa', () => {
  it('suma 1, media y varianza = μ + μ²/r', () => {
    for (const [mu, r] of [
      [10, 5],
      [4.5, 2],
      [2, 50],
      [0.7, 0.8],
    ]) {
      let s = 0;
      let m1 = 0;
      let m2 = 0;
      for (let k = 0; k < 400; k++) {
        const p = nbPmf(k, mu, r);
        s += p;
        m1 += k * p;
        m2 += k * k * p;
      }
      expect(s).toBeCloseTo(1, 10);
      expect(m1).toBeCloseTo(mu, 8);
      expect(m2 - m1 * m1).toBeCloseTo(mu + (mu * mu) / r, 6);
      expect(nbVariance(mu, r)).toBeCloseTo(mu + (mu * mu) / r, 12);
    }
  });

  it('dispersion = Infinity (o enorme) → Poisson', () => {
    expect(nbPmf(3, 2.5, Infinity)).toBeCloseTo(poissonPmf(3, 2.5), 14);
    expect(nbPmf(3, 2.5, 1e7)).toBeCloseTo(poissonPmf(3, 2.5), 6);
    expect(nbVariance(2.5, Infinity)).toBe(2.5);
  });

  it('casos límite', () => {
    expect(nbPmf(0, 0, 3)).toBe(1);
    expect(nbPmf(2, 0, 3)).toBe(0);
    expect(nbPmf(-1, 2, 3)).toBe(0);
    expect(nbPmf(1.5, 2, 3)).toBe(0);
  });

  it('nbPmfArray: longitud maxK+1 y cola plegada (suma 1)', () => {
    const a = nbPmfArray(9.8, 6, 12);
    expect(a).toHaveLength(13);
    expect(a.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
    expect(a[5]).toBeCloseTo(nbPmf(5, 9.8, 6), 14);
    let tail = 0;
    for (let k = 12; k < 500; k++) tail += nbPmf(k, 9.8, 6);
    expect(a[12]).toBeCloseTo(tail, 10);
  });

  it('estimateDispersion por momentos', () => {
    const rng = mulberry32(17);
    const xs = Array.from({ length: 40000 }, () => sampleNegBin(10, 8, rng));
    expect(mean(xs)).toBeCloseTo(10, 0);
    expect(variance(xs)).toBeCloseTo(10 + 100 / 8, -1);
    const r = estimateDispersion(xs);
    expect(r).toBeGreaterThan(6.5);
    expect(r).toBeLessThan(9.5);
    expect(estimateDispersion([2, 2, 2, 2])).toBe(Infinity); // var <= media
    expect(estimateDispersion([1, 2, 1, 2])).toBe(Infinity);
    expect(estimateDispersion([3])).toBe(Infinity);
    expect(estimateDispersion([0, 10, 0, 10])).toBeCloseTo(25 / (100 / 3 - 5), 12);
  });
});

describe('distribuciones discretas', () => {
  it('convolve conserva la masa (con y sin maxK) y suma las medias', () => {
    const a = nbPmfArray(5.2, 7, 30);
    const b = nbPmfArray(4.1, 9, 30);
    const full = convolve(a, b);
    expect(full).toHaveLength(61);
    expect(full.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
    const cut = convolve(a, b, 20);
    expect(cut).toHaveLength(21);
    expect(cut.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
    const pa = poissonPmfArray(1.3, 40);
    const pb = poissonPmfArray(0.9, 40);
    const c = convolve(pa, pb);
    expect(c[3]).toBeCloseTo(poissonPmf(3, 2.2), 12); // Poisson + Poisson = Poisson
    const meanC = c.reduce((s, p, k) => s + k * p, 0);
    expect(meanC).toBeCloseTo(2.2, 10);
    expect(convolve([], [1])).toEqual([]);
    expect(convolve([0.5, 0.5], [1], 5)).toEqual([0.5, 0.5, 0, 0, 0, 0]);
  });

  it('overUnderFromDist: push solo en líneas enteras', () => {
    const d = [0.1, 0.2, 0.3, 0.4];
    expect(overUnderFromDist(d, 1.5)).toEqual({ over: 0.7, under: 0.30000000000000004, push: 0 });
    const r = overUnderFromDist(d, 2);
    expect(r.push).toBeCloseTo(0.3, 12);
    expect(r.over).toBeCloseTo(0.4, 12);
    expect(r.under).toBeCloseTo(0.3, 12);
  });

  it('compareDists suma 1 y es simétrico', () => {
    const a = nbPmfArray(6, 5, 30);
    const b = nbPmfArray(4, 5, 30);
    const p = compareDists(a, b);
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 12);
    expect(p.home).toBeGreaterThan(p.away);
    const q = compareDists(b, a);
    expect(q.home).toBeCloseTo(p.away, 12);
    expect(q.draw).toBeCloseTo(p.draw, 12);
    // fuerza bruta
    let h = 0;
    let dr = 0;
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        if (i > j) h += a[i] * b[j];
        else if (i === j) dr += a[i] * b[j];
      }
    }
    expect(p.home).toBeCloseTo(h, 12);
    expect(p.draw).toBeCloseTo(dr, 12);
    // longitudes distintas
    const r = compareDists([0, 0, 0, 1], [1]);
    expect(r.home).toBeCloseTo(1, 12);
  });
});
