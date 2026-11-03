import { describe, expect, it } from 'vitest';
import { argmax3, brier3, brierBinary, calibration, logLoss3, rps3, scoreSet } from '../../src/lib/models';

const p = { home: 0.5, draw: 0.3, away: 0.2 };

describe('métricas probabilísticas', () => {
  it('brier3 = suma de cuadrados sobre las 3 clases', () => {
    expect(brier3(p, 0)).toBeCloseTo(0.25 + 0.09 + 0.04, 12);
    expect(brier3(p, 2)).toBeCloseTo(0.25 + 0.09 + 0.64, 12);
    expect(brier3({ home: 1, draw: 0, away: 0 }, 0)).toBe(0);
    expect(brier3({ home: 1, draw: 0, away: 0 }, 2)).toBe(2);
  });

  it('logLoss3 con epsilon', () => {
    expect(logLoss3(p, 0)).toBeCloseTo(-Math.log(0.5), 12);
    expect(logLoss3({ home: 1, draw: 0, away: 0 }, 1)).toBeCloseTo(-Math.log(1e-12), 9);
  });

  it('rps3 ordenado y normalizado por 2', () => {
    // resultado local: ((0.5−1)² + (0.8−1)²)/2
    expect(rps3(p, 0)).toBeCloseTo((0.25 + 0.04) / 2, 12);
    // empate: ((0.5)² + (0.8−1)²)/2
    expect(rps3(p, 1)).toBeCloseTo((0.25 + 0.04) / 2, 12);
    // visitante: (0.5² + 0.8²)/2
    expect(rps3(p, 2)).toBeCloseTo((0.25 + 0.64) / 2, 12);
    expect(rps3({ home: 1, draw: 0, away: 0 }, 0)).toBe(0);
    expect(rps3({ home: 1, draw: 0, away: 0 }, 2)).toBe(1);
    // RPS premia la cercanía ordinal: fallar por un empate cuesta menos que fallar por el extremo
    const homeFav = { home: 0.7, draw: 0.2, away: 0.1 };
    expect(rps3(homeFav, 1)).toBeLessThan(rps3(homeFav, 2));
  });

  it('brierBinary y argmax3', () => {
    expect(brierBinary(0.7, 1)).toBeCloseTo(0.09, 12);
    expect(brierBinary(0.7, 0)).toBeCloseTo(0.49, 12);
    expect(argmax3(p)).toBe(0);
    expect(argmax3({ home: 0.2, draw: 0.5, away: 0.3 })).toBe(1);
    expect(argmax3({ home: 0.2, draw: 0.3, away: 0.5 })).toBe(2);
  });

  it('calibration: bins de igual anchura, vacíos omitidos', () => {
    const preds: { p: number; y: 0 | 1 }[] = [
      { p: 0.05, y: 0 },
      { p: 0.15, y: 0 },
      { p: 0.12, y: 1 },
      { p: 0.95, y: 1 },
      { p: 1, y: 1 },
      { p: 0.3, y: 0 },
    ];
    const c = calibration(preds, 10);
    expect(c.map((b) => b.from)).toEqual([0, 0.1, 0.3, 0.9]);
    const b1 = c[1];
    expect(b1.to).toBeCloseTo(0.2, 12);
    expect(b1.n).toBe(2);
    expect(b1.predicted).toBeCloseTo(0.135, 12);
    expect(b1.observed).toBe(0.5);
    const last = c[3];
    expect(last.n).toBe(2); // p = 1 cae en el último bin
    expect(last.observed).toBe(1);
    expect(c.reduce((s, b) => s + b.n, 0)).toBe(preds.length);
    expect(calibration([], 5)).toEqual([]);
    expect(calibration(preds, 5)[0]).toMatchObject({ from: 0, to: 0.2, n: 3 });
  });

  it('scoreSet promedia y calcula el acierto', () => {
    const items = [
      { p, outcome: 0 as const },
      { p, outcome: 2 as const },
    ];
    const s = scoreSet(items);
    expect(s.brier).toBeCloseTo((brier3(p, 0) + brier3(p, 2)) / 2, 12);
    expect(s.logLoss).toBeCloseTo((logLoss3(p, 0) + logLoss3(p, 2)) / 2, 12);
    expect(s.rps).toBeCloseTo((rps3(p, 0) + rps3(p, 2)) / 2, 12);
    expect(s.accuracy).toBe(0.5);
    expect(scoreSet([])).toEqual({ brier: 0, logLoss: 0, rps: 0, accuracy: 0 });
  });
});
