import { describe, expect, it } from 'vitest';
import {
  americanToDecimal,
  decimalToAmerican,
  devig,
  devigDetailed,
  fairOdds,
  impliedProb,
  overround,
} from '../../src/lib/models';

describe('conversión de cuotas', () => {
  it('americanToDecimal', () => {
    expect(americanToDecimal('+105')).toBe(2.05);
    expect(americanToDecimal('-140')).toBe(1.714);
    expect(americanToDecimal('EVEN')).toBe(2);
    expect(americanToDecimal('even')).toBe(2);
    expect(americanToDecimal(250)).toBe(3.5);
    expect(americanToDecimal(-200)).toBe(1.5);
    expect(americanToDecimal('+100')).toBe(2);
    expect(americanToDecimal('-110')).toBe(1.909);
    expect(americanToDecimal(' +330 ')).toBe(4.3);
    expect(americanToDecimal(undefined)).toBeUndefined();
    expect(americanToDecimal(null)).toBeUndefined();
    expect(americanToDecimal('')).toBeUndefined();
    expect(americanToDecimal('abc')).toBeUndefined();
    expect(americanToDecimal('o2.5')).toBeUndefined();
    expect(americanToDecimal(50)).toBeUndefined();
    expect(americanToDecimal(Number.NaN)).toBeUndefined();
  });

  it('decimalToAmerican', () => {
    expect(decimalToAmerican(2.5)).toBe(150);
    expect(decimalToAmerican(1.5)).toBe(-200);
    expect(decimalToAmerican(1)).toBeUndefined();
  });

  it('impliedProb, overround y fairOdds', () => {
    expect(impliedProb(2)).toBe(0.5);
    expect(impliedProb(0)).toBe(0);
    expect(overround([1.9, 1.9])).toBeCloseTo(2 / 1.9 - 1, 12);
    expect(fairOdds(0.25)).toBe(4);
    expect(fairOdds(0)).toBe(1000);
    expect(fairOdds(1e-6)).toBe(1000);
    expect(fairOdds(1)).toBe(1);
  });
});

describe('devig', () => {
  const books = [
    [2.1, 3.4, 3.6],
    [1.25, 6.0, 13.0],
    [1.91, 1.91],
    [1.05, 15, 41],
    [4.2, 3.9, 1.85],
  ];

  it('todos los métodos suman 1 y conservan el orden', () => {
    for (const o of books) {
      for (const method of ['shin', 'power', 'multiplicative'] as const) {
        const p = devig(o, method);
        expect(p.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10);
        for (let i = 0; i < o.length; i++) {
          for (let j = 0; j < o.length; j++) if (o[i] < o[j]) expect(p[i]).toBeGreaterThan(p[j]);
        }
      }
    }
  });

  it('por defecto usa Shin', () => {
    expect(devig([2.1, 3.4, 3.6])).toEqual(devig([2.1, 3.4, 3.6], 'shin'));
  });

  it('Shin y potencia corrigen el sesgo favorito-longshot respecto al multiplicativo', () => {
    const o = [1.25, 6.0, 13.0];
    const mult = devig(o, 'multiplicative');
    const shin = devig(o, 'shin');
    const pow = devig(o, 'power');
    expect(shin[0]).toBeGreaterThan(mult[0]);
    expect(shin[2]).toBeLessThan(mult[2]);
    expect(pow[0]).toBeGreaterThan(mult[0]);
    expect(pow[2]).toBeLessThan(mult[2]);
    // el margen se carga desproporcionadamente al longshot
    expect(shin[2] / (1 / o[2])).toBeLessThan(shin[0] / (1 / o[0]));
  });

  it('mercado equilibrado de dos vías: los tres métodos coinciden en 0.5', () => {
    for (const method of ['shin', 'power', 'multiplicative'] as const) {
      const p = devig([1.91, 1.91], method);
      expect(p[0]).toBeCloseTo(0.5, 12);
    }
  });

  it('sin margen: devuelve las probabilidades implícitas', () => {
    const o = [2, 4, 4];
    for (const method of ['shin', 'power', 'multiplicative'] as const) {
      const p = devig(o, method);
      expect(p[0]).toBeCloseTo(0.5, 8);
      expect(p[1]).toBeCloseTo(0.25, 8);
    }
  });

  it('Shin: z y probabilidades cumplen la ecuación de Shin', () => {
    const o = [2.1, 3.4, 3.6];
    const r = devigDetailed(o, 'shin');
    expect(r.margin).toBeCloseTo(1 / 2.1 + 1 / 3.4 + 1 / 3.6 - 1, 12);
    expect(r.param).toBeGreaterThan(0);
    expect(r.param).toBeLessThan(0.1);
    const pi = o.map((x) => 1 / x);
    const B = pi.reduce((a, b) => a + b, 0);
    const z = r.param;
    r.probs.forEach((p, i) => {
      expect(p).toBeCloseTo((Math.sqrt(z * z + (4 * (1 - z) * pi[i] * pi[i]) / B) - z) / (2 * (1 - z)), 9);
    });
    const pw = devigDetailed(o, 'power');
    expect(pw.param).toBeGreaterThan(1);
    expect(pi.reduce((s, x) => s + Math.pow(x, pw.param), 0)).toBeCloseTo(1, 10);
  });

  it('cuotas inválidas reciben probabilidad 0', () => {
    const p = devig([2.0, Number.NaN, 2.0]);
    expect(p[1]).toBe(0);
    expect(p[0]).toBeCloseTo(0.5, 12);
    expect(devig([])).toEqual([]);
  });
});
