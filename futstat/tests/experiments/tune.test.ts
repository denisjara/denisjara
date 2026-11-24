/**
 * Variantes «tune*» (agente de ajuste de hiperparámetros): la ventaja local por grupo en las probabilidades del Elo
 * reproduce eloProbs con la diferencia desplazada, no cambia nada en campo neutral ni con desplazamiento 0, el
 * combinador es el pool lineal de producción con los mismos pesos (sin tabla = producción exacta) y las variantes
 * cargan y pasan la comprobación de código fuente del banco.
 */
import { describe, expect, it } from 'vitest';
import { blend, eloProbs } from '../../src/lib/models';
import type { Prob1X2 } from '../../src/types/data';
import { loadVariant } from '../../pipeline/experiments/load';
import type { ComponentRow } from '../../pipeline/experiments/types';
import { AMERICAS, PRODUCTION_HOME_ADV, haDelta, haGroup, shiftEloProbs } from '../../pipeline/experiments/tune/homeAdv';
import { HA_REGION_KIND, blendWithTable, eloWithTable } from '../../pipeline/experiments/tune/variant';

const close = (a: Prob1X2, b: Prob1X2, tol = 1e-12) => {
  expect(Math.abs(a.home - b.home)).toBeLessThan(tol);
  expect(Math.abs(a.draw - b.draw)).toBeLessThan(tol);
  expect(Math.abs(a.away - b.away)).toBeLessThan(tol);
};

function row(over: Partial<ComponentRow> = {}): ComponentRow {
  const diff = over.eloDiff ?? 120;
  const elo = eloProbs(diff, { drawBase: 0.27, drawScale: 380 });
  const goal: Prob1X2 = { home: 0.5, draw: 0.27, away: 0.23 };
  const market: Prob1X2 = { home: 0.52, draw: 0.26, away: 0.22 };
  const weights = { goal: 0.05, elo: 0.15, market: 0.8 };
  return {
    matchId: '1',
    date: '2026-08-20T19:00:00Z',
    compId: 'laliga',
    kind: 'league',
    tier: 10,
    neutral: false,
    hasMarket: true,
    goalKind: 'dc',
    goal,
    dc: goal,
    elo,
    market,
    goalOver25: 0.5,
    lambdaHome: 1.5,
    lambdaAway: 1.1,
    rho: -0.05,
    eloDiff: diff,
    minEloGames: 50,
    features: {},
    production: blend([
      { probs: goal, weight: weights.goal },
      { probs: elo, weight: weights.elo },
      { probs: market, weight: weights.market },
    ]),
    weights,
    ...over,
  };
}

describe('ventaja local por grupo (tune/homeAdv)', () => {
  it('shiftEloProbs reproduce eloProbs con la diferencia desplazada (escala de empates 380)', () => {
    const params = { drawBase: 0.27, drawScale: 380 };
    for (const diff of [-250, -60, 0, 35, 140, 300]) {
      for (const delta of [-40, -15, 10, 15]) close(shiftEloProbs(eloProbs(diff, params), diff, delta), eloProbs(diff + delta, params));
    }
  });

  it('con otra escala de empates (360–400) el error es pequeño (< 0,003) para |delta| <= 40', () => {
    for (const scale of [360, 400]) {
      const params = { drawBase: 0.272, drawScale: scale };
      for (const diff of [-200, -50, 80, 220]) {
        for (const delta of [-40, 15]) close(shiftEloProbs(eloProbs(diff, params), diff, delta), eloProbs(diff + delta, params), 3e-3);
      }
    }
  });

  it('desplazamiento 0 o diferencia no finita: probabilidades intactas', () => {
    const p = eloProbs(90);
    expect(shiftEloProbs(p, 90, 0)).toBe(p);
    expect(shiftEloProbs(p, NaN, -15)).toBe(p);
  });

  it('grupos: región × tipo; campo neutral y grupos fuera de la tabla sin desplazamiento', () => {
    expect(haGroup('laliga', 'league')).toBe('EU-league');
    expect(haGroup('copadelrey', 'cup')).toBe('EU-cup');
    expect(haGroup('champions', 'continental')).toBe('EU-continental');
    expect(haGroup('brasileirao', 'league')).toBe('AM-league');
    expect(haGroup('libertadores', 'continental')).toBe('AM-continental');
    expect(haGroup('copachile', 'cup')).toBe('AM-cup');
    expect(AMERICAS.has('mls')).toBe(true);
    expect(haDelta(HA_REGION_KIND, 'laliga', 'league', false)).toBe(50 - PRODUCTION_HOME_ADV);
    expect(haDelta(HA_REGION_KIND, 'laliga', 'league', true)).toBe(0);
    expect(haDelta(HA_REGION_KIND, 'copachile', 'cup', false)).toBe(0); // AM-cup no está en la tabla (n < 100)
  });
});

describe('combinador de las variantes tune*', () => {
  it('sin desplazamiento (tabla vacía o campo neutral) da exactamente el ensamble de producción', () => {
    const r = row();
    close(blendWithTable(r, {}), r.production, 1e-15);
    const n = row({ neutral: true });
    close(blendWithTable(n, HA_REGION_KIND), n.production, 1e-15);
  });

  it('ligas europeas: menos ventaja local ⇒ el Elo y el ensamble bajan la probabilidad local (mismos pesos)', () => {
    const r = row();
    const e = eloWithTable(r, HA_REGION_KIND);
    expect(e.home).toBeLessThan(r.elo.home);
    expect(e.away).toBeGreaterThan(r.elo.away);
    const p = blendWithTable(r, HA_REGION_KIND);
    expect(p.home).toBeLessThan(r.production.home);
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 12);
    // el cambio del ensamble es el del Elo por su peso relativo (0,15)
    expect(r.production.home - p.home).toBeCloseTo(0.15 * (r.elo.home - e.home), 12);
  });

  it('sin cuotas usa los pesos de la fila (sin mercado) y ligas americanas suben la ventaja local', () => {
    const r = row({ compId: 'brasileirao', hasMarket: false, market: undefined, weights: { goal: 0.5, elo: 0.5, market: 0 } });
    const p = blendWithTable(r, HA_REGION_KIND);
    const e = eloWithTable(r, HA_REGION_KIND);
    expect(e.home).toBeGreaterThan(r.elo.home);
    close(p, blend([{ probs: r.goal, weight: 0.5 }, { probs: e, weight: 0.5 }]), 1e-15);
  });
});

describe('variantes tune*', () => {
  it('cargan y pasan la comprobación de código fuente del banco', async () => {
    for (const name of ['tune-ha', 'tune-ha-prior3', 'tune-prior3', 'tune-prior5', 'tune-ha-prior5']) {
      const v = await loadVariant(name);
      expect(v.name).toBe(name);
    }
    const ha = await loadVariant('tune-ha');
    expect(ha.dc).toBeUndefined();
    expect(ha.elo).toBeUndefined();
    expect(typeof ha.combine?.blend).toBe('function');
    expect(ha.combine?.prepare).toBeUndefined();
    const p3 = await loadVariant('tune-prior3');
    expect(p3.dc).toEqual({ priorWeight: 3 });
    expect(p3.combine).toBeUndefined();
    const best = await loadVariant('tune-ha-prior3');
    expect(best.dc).toEqual({ priorWeight: 3 });
    const r = row();
    close(best.combine!.blend(r) as Prob1X2, blendWithTable(r, HA_REGION_KIND), 1e-15);
  });
});
