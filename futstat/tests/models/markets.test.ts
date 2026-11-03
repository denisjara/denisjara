import { describe, expect, it } from 'vitest';
import type { Market } from '../../src/types/data';
import {
  ASIAN_LINES,
  asianEV,
  asianHandicap,
  asianTotal,
  buildGoalMarkets,
  halvesModel,
  outcomeProbs,
  overUnder,
  scoreMatrix,
  splitLine,
  totalGoalsDist,
} from '../../src/lib/models';

const ctx = {
  lambdaHome: 1.65,
  lambdaAway: 1.05,
  rho: -0.07,
  homeName: 'Real Madrid',
  awayName: 'Barcelona',
};

const byId = (ms: Market[], id: string) => {
  const m = ms.find((x) => x.id === id);
  if (!m) throw new Error(`falta el mercado ${id}`);
  return m;
};
const probSum = (m: Market) => m.selections.reduce((s, x) => s + x.prob, 0);

describe('overUnder', () => {
  const m = scoreMatrix(1.5, 1.2, -0.05);
  const t = totalGoalsDist(m);

  it('media línea: sin push y over + under = 1', () => {
    const r = overUnder(m, 2.5);
    expect(r.push).toBe(0);
    expect(r.over + r.under).toBeCloseTo(1, 12);
    expect(r.under).toBeCloseTo(t[0] + t[1] + t[2], 12);
  });

  it('línea entera: push = P(T = línea)', () => {
    const r = overUnder(m, 2);
    expect(r.push).toBeCloseTo(t[2], 12);
    expect(r.under).toBeCloseTo(t[0] + t[1], 12);
    expect(r.over + r.under + r.push).toBeCloseTo(1, 12);
  });

  it('total asiático 2.25 = media apuesta a 2 + media a 2.5', () => {
    const r = asianTotal(m, 2.25, 'over');
    expect(r.win).toBeCloseTo(1 - t[0] - t[1] - t[2], 12);
    expect(r.halfLoss).toBeCloseTo(t[2], 12);
    expect(r.loss).toBeCloseTo(t[0] + t[1], 12);
    // EV a la cuota justa = 0
    expect(asianEV(r, r.fairOdds)).toBeCloseTo(0, 12);
  });
});

describe('asianHandicap', () => {
  const m = scoreMatrix(1.7, 1.1, -0.08);
  const p = outcomeProbs(m);

  it('línea 0 = empate no apuesta', () => {
    const r = asianHandicap(m, 0, 'home');
    expect(r.win).toBeCloseTo(p.home, 12);
    expect(r.push).toBeCloseTo(p.draw, 12);
    expect(r.loss).toBeCloseTo(p.away, 12);
    expect(r.halfWin).toBe(0);
    expect(r.halfLoss).toBe(0);
    expect(r.fairOdds).toBeCloseTo((p.home + p.away) / p.home, 10);
  });

  it('línea -0.5 local = victoria local; +0.5 visitante = local no gana', () => {
    const r = asianHandicap(m, -0.5, 'home');
    expect(r.win).toBeCloseTo(p.home, 12);
    expect(r.loss).toBeCloseTo(p.draw + p.away, 12);
    expect(r.push).toBe(0);
    expect(r.fairOdds).toBeCloseTo(1 / p.home, 10);
    const a = asianHandicap(m, 0.5, 'away');
    expect(a.win).toBeCloseTo(p.draw + p.away, 12);
  });

  it('línea de cuarto -0.25 = media en 0 + media en -0.5', () => {
    const r = asianHandicap(m, -0.25, 'home');
    expect(r.win).toBeCloseTo(p.home, 12);
    expect(r.halfLoss).toBeCloseTo(p.draw, 12);
    expect(r.loss).toBeCloseTo(p.away, 12);
    expect(splitLine(-0.25)).toEqual([-0.5, 0]);
    // EV de la apuesta dividida = media de los EV de las dos medias apuestas, a cualquier cuota
    const o = 2.05;
    const h0 = asianHandicap(m, 0, 'home');
    const h5 = asianHandicap(m, -0.5, 'home');
    expect(asianEV(r, o)).toBeCloseTo((asianEV(h0, o) + asianEV(h5, o)) / 2, 12);
  });

  it('línea de cuarto -0.75: gana por 2+, medio gana por 1', () => {
    const r = asianHandicap(m, -0.75, 'home');
    const d = m.flatMap((row, i) => row.map((v, j) => ({ d: i - j, v })));
    const by1 = d.filter((x) => x.d === 1).reduce((s, x) => s + x.v, 0);
    const by2p = d.filter((x) => x.d >= 2).reduce((s, x) => s + x.v, 0);
    expect(r.win).toBeCloseTo(by2p, 12);
    expect(r.halfWin).toBeCloseTo(by1, 12);
    expect(r.loss).toBeCloseTo(p.draw + p.away, 12);
  });

  it('cuota justa: EV = 0 y simetría local/visitante', () => {
    for (const line of ASIAN_LINES) {
      const h = asianHandicap(m, line, 'home');
      const a = asianHandicap(m, -line, 'away');
      expect(h.win + h.halfWin + h.push + h.halfLoss + h.loss).toBeCloseTo(1, 12);
      expect(h.win).toBeCloseTo(a.loss, 12);
      expect(h.halfWin).toBeCloseTo(a.halfLoss, 12);
      expect(h.push).toBeCloseTo(a.push, 12);
      if (h.fairOdds < 1000) expect(asianEV(h, h.fairOdds)).toBeCloseTo(0, 10);
    }
  });
});

describe('buildGoalMarkets', () => {
  const markets = buildGoalMarkets(ctx);

  it('contiene el catálogo completo con ids estables', () => {
    const ids = markets.map((m) => m.id);
    const expected = [
      '1x2',
      'dc',
      'dnb',
      'btts',
      'btts-result',
      'ou-0.5',
      'ou-1.5',
      'ou-2.5',
      'ou-3.5',
      'ou-4.5',
      'ou-5.5',
      'team-home-ou-0.5',
      'team-home-ou-1.5',
      'team-home-ou-2.5',
      'team-away-ou-0.5',
      'team-away-ou-1.5',
      'team-away-ou-2.5',
      'ah-home--2.5',
      'ah-home--0.75',
      'ah-home-0',
      'ah-home-0.25',
      'ah-home-2.5',
      'eh-home--1',
      'eh-home-1',
      'cs',
      'total-exact',
      'odd-even',
      'margin',
      'clean-sheet-home',
      'clean-sheet-away',
      'win-to-nil-home',
      'win-to-nil-away',
      'first-goal',
      'ht-1x2',
      'ht-ou-0.5',
      'ht-ou-1.5',
      'htft',
      '2h-ou-1.5',
    ];
    for (const id of expected) expect(ids).toContain(id);
    expect(ids.filter((id) => id.startsWith('ah-home-'))).toHaveLength(21);
    expect(new Set(ids).size).toBe(ids.length);
    const groups = new Set(markets.map((m) => m.group));
    for (const g of ['Principales', 'Goles', 'Hándicap', 'Marcador', 'Mitades', 'Equipos']) expect(groups.has(g as Market['group'])).toBe(true);
  });

  it('selecciones excluyentes suman 1 (±1e-6); doble oportunidad suma 2', () => {
    for (const m of markets) {
      const s = probSum(m);
      if (m.id === 'dc') expect(s).toBeCloseTo(2, 6);
      else expect(Math.abs(s - 1)).toBeLessThan(1e-6);
      for (const sel of m.selections) {
        expect(sel.prob).toBeGreaterThanOrEqual(0);
        expect(sel.prob).toBeLessThanOrEqual(1);
        expect(sel.fairOdds).toBeGreaterThanOrEqual(1);
        expect(sel.fairOdds).toBeLessThanOrEqual(1000);
      }
    }
  });

  it('etiquetas en español con nombres de equipo', () => {
    const dc = byId(markets, 'dc');
    expect(dc.selections.map((s) => s.label)).toEqual(['Real Madrid o empate', 'Real Madrid o Barcelona', 'Empate o Barcelona']);
    expect(byId(markets, '1x2').selections.map((s) => s.label)).toEqual(['Real Madrid', 'Empate', 'Barcelona']);
    expect(byId(markets, 'ou-2.5').selections.map((s) => s.label)).toEqual(['Más de 2.5', 'Menos de 2.5']);
    expect(byId(markets, 'btts').selections.map((s) => s.label)).toEqual(['Sí', 'No']);
    expect(byId(markets, 'ah-home--0.75').selections.map((s) => s.label)).toEqual(['Real Madrid -0.75', 'Barcelona +0.75']);
    expect(byId(markets, 'htft').selections).toHaveLength(9);
    expect(byId(markets, 'cs').selections).toHaveLength(16);
    expect(byId(markets, 'cs').selections[15].label).toBe('Otro');
    expect(byId(markets, 'total-exact').selections.map((s) => s.label)).toEqual([
      '0 goles',
      '1 gol',
      '2 goles',
      '3 goles',
      '4 goles',
      '5 goles',
      '6 o más',
    ]);
  });

  it('coherencia entre mercados', () => {
    const m = scoreMatrix(ctx.lambdaHome, ctx.lambdaAway, ctx.rho, 10);
    const p = outcomeProbs(m);
    const x = byId(markets, '1x2').selections;
    expect(x[0].prob).toBeCloseTo(p.home, 12);
    expect(x[0].fairOdds).toBeCloseTo(1 / p.home, 10);
    expect(byId(markets, 'dnb').selections[0].prob).toBeCloseTo(p.home / (p.home + p.away), 12);
    // AH 0 = DNB
    expect(byId(markets, 'ah-home-0').selections[0].prob).toBeCloseTo(byId(markets, 'dnb').selections[0].prob, 12);
    expect(byId(markets, 'ah-home-0').selections[0].fairOdds).toBeCloseTo(byId(markets, 'dnb').selections[0].fairOdds, 10);
    // AH -0.5 = victoria local
    expect(byId(markets, 'ah-home--0.5').selections[0].prob).toBeCloseTo(p.home, 12);
    // HE -1: local gana por 2+, empate = gana por 1
    const margin = byId(markets, 'margin').selections;
    const eh = byId(markets, 'eh-home--1').selections;
    expect(eh[1].prob).toBeCloseTo(margin[0].prob, 12);
    expect(eh[0].prob).toBeCloseTo(margin[1].prob + margin[2].prob, 12);
    // btts-result coherente con 1X2 y btts
    const br = byId(markets, 'btts-result').selections;
    expect(br[0].prob + br[3].prob).toBeCloseTo(p.home, 12);
    expect(br[0].prob + br[1].prob + br[2].prob).toBeCloseTo(byId(markets, 'btts').selections[0].prob, 12);
    // gana sin encajar <= portería a cero
    expect(byId(markets, 'win-to-nil-home').selections[0].prob).toBeLessThan(byId(markets, 'clean-sheet-home').selections[0].prob);
    // primer gol: "Sin goles" = 0-0
    expect(byId(markets, 'first-goal').selections[1].prob).toBeCloseTo(m[0][0], 12);
    expect(byId(markets, 'ou-0.5').selections[1].prob).toBeCloseTo(m[0][0], 12);
    // descanso/final: marginal del final = 1X2 (τ aplicado al marcador final)
    const htft = byId(markets, 'htft').selections;
    expect(htft[0].prob + htft[3].prob + htft[6].prob).toBeCloseTo(p.home, 5);
    expect(htft[1].prob + htft[4].prob + htft[7].prob).toBeCloseTo(p.draw, 5);
    // marginal del descanso = ht-1x2
    const ht = byId(markets, 'ht-1x2').selections;
    expect(htft[0].prob + htft[1].prob + htft[2].prob).toBeCloseTo(ht[0].prob, 10);
    // la primera parte tiene menos goles que el partido
    expect(byId(markets, 'ht-ou-0.5').selections[1].prob).toBeGreaterThan(m[0][0]);
  });

  it('simetría: intercambiar equipos refleja los mercados', () => {
    const rev = buildGoalMarkets({ ...ctx, lambdaHome: ctx.lambdaAway, lambdaAway: ctx.lambdaHome, homeName: 'Barcelona', awayName: 'Real Madrid' });
    const a = byId(markets, '1x2').selections;
    const b = byId(rev, '1x2').selections;
    expect(b[0].prob).toBeCloseTo(a[2].prob, 12);
    expect(byId(rev, 'ah-home-0.75').selections[1].prob).toBeCloseTo(byId(markets, 'ah-home--0.75').selections[0].prob, 12);
    expect(byId(rev, 'ou-2.5').selections[0].prob).toBeCloseTo(byId(markets, 'ou-2.5').selections[0].prob, 12);
  });

  it('cuotas del mercado: marketOdds y ev en 1X2, O/U de la línea y hándicap de la línea', () => {
    const ms = buildGoalMarkets({
      ...ctx,
      odds: { provider: 'DraftKings', home: 1.95, draw: 3.7, away: 4.1, totalLine: 2.5, over: 1.9, under: 1.95, spreadLine: -0.5, spreadHome: 1.95, spreadAway: 1.9 },
    });
    const x = byId(ms, '1x2').selections;
    expect(x[0].marketOdds).toBe(1.95);
    expect(x[0].ev).toBeCloseTo(x[0].prob * 1.95 - 1, 12);
    expect(x[2].marketOdds).toBe(4.1);
    const ou = byId(ms, 'ou-2.5').selections;
    expect(ou[0].marketOdds).toBe(1.9);
    expect(ou[1].ev).toBeCloseTo(ou[1].prob * 1.95 - 1, 12);
    expect(byId(ms, 'ou-3.5').selections[0].marketOdds).toBeUndefined();
    const ah = byId(ms, 'ah-home--0.5').selections;
    expect(ah[0].marketOdds).toBe(1.95);
    expect(ah[0].ev).toBeCloseTo(ah[0].prob * 1.95 - 1, 10);
    expect(byId(ms, 'ah-home--1').selections[0].marketOdds).toBeUndefined();
    // sin cuotas no hay marketOdds
    expect(byId(markets, '1x2').selections[0].marketOdds).toBeUndefined();
  });

  it('líneas no estándar del bookmaker se añaden con liquidación asiática', () => {
    const ms = buildGoalMarkets({
      ...ctx,
      odds: { provider: 'DraftKings', totalLine: 3, over: 2.2, under: 1.7, spreadLine: -2.75, spreadHome: 4.5, spreadAway: 1.2 },
    });
    const ou3 = byId(ms, 'ou-3');
    expect(ou3.line).toBe(3);
    expect(Math.abs(probSum(ou3) - 1)).toBeLessThan(1e-9);
    const m = scoreMatrix(ctx.lambdaHome, ctx.lambdaAway, ctx.rho, 10);
    const r = asianTotal(m, 3, 'over');
    expect(ou3.selections[0].prob).toBeCloseTo(r.win / (r.win + r.loss), 12);
    expect(ou3.selections[0].ev).toBeCloseTo(asianEV(r, 2.2), 12);
    expect(ou3.selections[0].note).toContain('nulo');
    const ah = byId(ms, 'ah-home--2.75');
    expect(ah.selections[0].marketOdds).toBe(4.5);
    expect(ah.selections[1].marketOdds).toBe(1.2);
    // orden por línea preservado
    const ouIds = ms.filter((x) => x.id.startsWith('ou-')).map((x) => x.line as number);
    expect([...ouIds].sort((a, b) => a - b)).toEqual(ouIds);
  });

  it('hándicap asiático: probabilidad efectiva = 1/cuota justa y suma 1 por línea; note con detalle', () => {
    for (const mk of markets.filter((x) => x.id.startsWith('ah-home-'))) {
      expect(Math.abs(probSum(mk) - 1)).toBeLessThan(1e-9);
      for (const s of mk.selections) {
        if (s.fairOdds < 1000) expect(s.fairOdds).toBeCloseTo(1 / s.prob, 9);
        expect(s.note).toMatch(/Gana/);
      }
    }
    expect(byId(markets, 'ah-home--0.75').selections[0].note).toMatch(/medio gana/);
    expect(byId(markets, 'ah-home--0.75').selections[0].note).toMatch(/dividida/);
  });

  it('nombres por defecto y λ degenerados', () => {
    const ms = buildGoalMarkets({ lambdaHome: 0, lambdaAway: Number.NaN, rho: 0, homeName: '', awayName: '' });
    expect(byId(ms, '1x2').selections[0].label).toBe('Local');
    expect(byId(ms, '1x2').selections[1].prob).toBeCloseTo(1, 12);
    for (const m of ms) if (m.id !== 'dc') expect(Math.abs(probSum(m) - 1)).toBeLessThan(1e-6);
  });
});

describe('halvesModel', () => {
  it('suma 1 y la primera parte tiene 45 % de los goles', () => {
    const h = halvesModel(1.5, 1.2, 0);
    const htSum = h.ht.flat().reduce((s, x) => s + x, 0);
    expect(htSum).toBeCloseTo(1, 12);
    expect(h.htft.flat().reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
    expect(h.secondHalfTotal.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
    const t = totalGoalsDist(h.ht);
    const meanHt = t.reduce((s, p, k) => s + k * p, 0);
    expect(meanHt).toBeCloseTo(0.45 * 2.7, 6);
    const mean2h = h.secondHalfTotal.reduce((s, p, k) => s + k * p, 0);
    expect(mean2h).toBeCloseTo(0.55 * 2.7, 6);
  });
});
