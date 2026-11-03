import { describe, expect, it } from 'vitest';
import { Elo, eloExpectation, eloProbs, fitEloDrawParams, goalMultiplier, mulberry32, sampleDiscrete } from '../../src/lib/models';

describe('Elo', () => {
  it('goalMultiplier estilo World Football Elo', () => {
    expect(goalMultiplier(0)).toBe(1);
    expect(goalMultiplier(1)).toBe(1);
    expect(goalMultiplier(-1)).toBe(1);
    expect(goalMultiplier(2)).toBe(1.5);
    expect(goalMultiplier(-2)).toBe(1.5);
    expect(goalMultiplier(3)).toBe(14 / 8);
    expect(goalMultiplier(5)).toBe(2);
  });

  it('get/has/set/diff', () => {
    const elo = new Elo({ k: 20, homeAdv: 65, init: 1500 });
    expect(elo.get('A')).toBe(1500);
    expect(elo.has('A')).toBe(false);
    elo.set('A', 1600);
    expect(elo.has('A')).toBe(true);
    expect(elo.diff('A', 'B')).toBe(165);
    expect(elo.diff('A', 'B', true)).toBe(100);
  });

  it('update: suma cero, K·G·(W − We) y historial', () => {
    const elo = new Elo({ k: 20, homeAdv: 65, init: 1500 });
    const r = elo.update({ id: '1', date: '2026-10-01', home: 'A', away: 'B', hg: 3, ag: 0 });
    const we = eloExpectation(65);
    expect(r.preHome).toBe(1500);
    expect(r.postHome - r.preHome).toBeCloseTo(20 * (14 / 8) * (1 - we), 12);
    expect(r.postHome + r.postAway).toBeCloseTo(3000, 10);
    expect(elo.get('A')).toBe(r.postHome);
    expect(elo.history('A')).toEqual([{ date: '2026-10-01', elo: r.postHome }]);
    // empate en casa entre iguales: el local pierde puntos (tenía ventaja)
    const d = elo.update({ id: '2', date: '2026-10-08', home: 'C', away: 'D', hg: 1, ag: 1 });
    expect(d.postHome).toBeLessThan(d.preHome);
    // neutral entre iguales: sin cambio
    const n = elo.update({ id: '3', date: '2026-10-09', home: 'E', away: 'F', hg: 0, ag: 0, neutral: true });
    expect(n.postHome).toBeCloseTo(1500, 12);
    expect(Object.keys(elo.ratings())).toHaveLength(6);
  });

  it('initHome/initAway y kMultiplier', () => {
    const elo = new Elo({ k: 20, homeAdv: 0, init: 1500 });
    const r = elo.update({ id: '1', date: '2026-01-01', home: 'A', away: 'B', hg: 1, ag: 0, initHome: 1700, initAway: 1400, kMultiplier: 2 });
    expect(r.preHome).toBe(1700);
    expect(r.preAway).toBe(1400);
    expect(r.postHome - r.preHome).toBeCloseTo(40 * (1 - eloExpectation(300)), 12);
    // init solo se aplica a equipos nuevos
    const r2 = elo.update({ id: '2', date: '2026-01-02', home: 'A', away: 'B', hg: 0, ag: 0, initHome: 1000 });
    expect(r2.preHome).toBe(r.postHome);
  });

  it('eloProbs suma 1, es monótono y simétrico', () => {
    let prevHome = -1;
    let prevAway = 2;
    for (let d = -1000; d <= 1000; d += 10) {
      const p = eloProbs(d);
      expect(p.home + p.draw + p.away).toBeCloseTo(1, 12);
      expect(Math.min(p.home, p.draw, p.away)).toBeGreaterThan(0);
      expect(p.home).toBeGreaterThanOrEqual(prevHome - 1e-12);
      expect(p.away).toBeLessThanOrEqual(prevAway + 1e-12);
      prevHome = p.home;
      prevAway = p.away;
      const q = eloProbs(-d);
      expect(q.home).toBeCloseTo(p.away, 12);
      expect(q.draw).toBeCloseTo(p.draw, 12);
    }
    const z = eloProbs(0, { drawBase: 0.3, drawScale: 500 });
    expect(z.draw).toBeCloseTo(0.3, 12);
    expect(z.home).toBeCloseTo(0.35, 12);
    // el empate es máximo en diff = 0
    expect(eloProbs(0).draw).toBeGreaterThan(eloProbs(200).draw);
  });

  it('fitEloDrawParams recupera los parámetros por MLE en rejilla', () => {
    const rng = mulberry32(5);
    const truth = { drawBase: 0.3, drawScale: 350 };
    const samples: { diff: number; outcome: 0 | 1 | 2 }[] = [];
    for (let i = 0; i < 20000; i++) {
      const diff = (rng() - 0.5) * 900;
      const p = eloProbs(diff, truth);
      samples.push({ diff, outcome: sampleDiscrete([p.home, p.draw, p.away], rng) as 0 | 1 | 2 });
    }
    const t0 = performance.now();
    const fit = fitEloDrawParams(samples);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(Math.abs(fit.drawBase - truth.drawBase)).toBeLessThan(0.02);
    expect(Math.abs(fit.drawScale - truth.drawScale)).toBeLessThan(60);
    expect(fitEloDrawParams([])).toEqual({ drawBase: 0.27, drawScale: 400 });
  });
});
