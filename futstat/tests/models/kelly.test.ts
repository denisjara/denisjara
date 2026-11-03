import { describe, expect, it } from 'vitest';
import { edge, expectedValue, kelly } from '../../src/lib/models';

describe('kelly y valor esperado', () => {
  it('expectedValue = p·cuota − 1', () => {
    expect(expectedValue(0.5, 2.2)).toBeCloseTo(0.1, 12);
    expect(expectedValue(0.4, 2.0)).toBeCloseTo(-0.2, 12);
  });

  it('edge = p − 1/cuota', () => {
    expect(edge(0.55, 2)).toBeCloseTo(0.05, 12);
  });

  it('kelly es 0 cuando EV <= 0', () => {
    expect(kelly(0.4, 2.0)).toBe(0);
    expect(kelly(0.5, 2.0)).toBe(0);
    expect(kelly(0.3, 1)).toBe(0);
    expect(kelly(Number.NaN, 2)).toBe(0);
  });

  it('fracción y tope', () => {
    // Kelly completo: (0.55·2 − 1)/(2 − 1) = 0.1
    expect(kelly(0.55, 2, 1, 1)).toBeCloseTo(0.1, 12);
    expect(kelly(0.55, 2)).toBeCloseTo(0.025, 12); // 1/4 por defecto
    expect(kelly(0.55, 2, 0.5, 1)).toBeCloseTo(0.05, 12);
    expect(kelly(0.9, 2)).toBe(0.05); // tope por defecto 5 %
    expect(kelly(0.9, 2, 1, 0.2)).toBe(0.2);
  });
});
