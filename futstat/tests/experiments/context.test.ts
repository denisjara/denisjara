/**
 * Variantes «context*» (pipeline/experiments/context/): la regresión de Poisson penalizada recupera coeficientes
 * conocidos; los rasgos de contexto solo usan el pasado (y salen bien en casos a mano); el regresor reproduce
 * EXACTAMENTE producción sin modelo, solo se entrena con filas que empezaron al menos `guardHours` antes del
 * reajuste (sin prórrogas sin resolver), corrige una diferencia de fuerzas inflada y no arrastra estado entre
 * reajustes; las variantes cargan y pasan la comprobación de código fuente del banco.
 */
import { describe, expect, it } from 'vitest';
import { dcOutcomes, mulberry32 } from '../../src/lib/models';
import type { Prob1X2 } from '../../src/types/data';
import { COMPETITION_BY_ID } from '../../pipeline/config';
import type { MatchRecord } from '../../pipeline/types';
import { contextFeatures } from '../../pipeline/experiments/context/features';
import { fitPoissonGlm, type GlmObs } from '../../pipeline/experiments/context/glm';
import { ContextRegressor, poolWithGoal, productionOver25 } from '../../pipeline/experiments/context/regressor';
import { loadVariant } from '../../pipeline/experiments/load';
import { preMatchView, type HistoryView, type WalkForwardRow } from '../../pipeline/experiments/types';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5, 18);

function poisson(lambda: number, u: () => number): number {
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= u();
  } while (p > l);
  return k - 1;
}

const team = (id: string) => ({ id, name: id, short: id, abbr: id.slice(0, 3).toUpperCase() });

function rec(id: string, compId: string, season: number, day: number, home: string, away: string, hg = 1, ag = 1): MatchRecord {
  return {
    id,
    compId,
    season,
    currentSeason: true,
    date: new Date(T0 + day * DAY).toISOString(),
    status: 'finished',
    home: team(home),
    away: team(away),
    score: { home: hg, away: ag },
  };
}

/** Vista del pasado mínima sobre una lista de partidos (solo terminados con inicio < corte). */
function viewOf(all: MatchRecord[], cutoff: number): HistoryView {
  const past = all.filter((m) => Date.parse(m.date) < cutoff).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return {
    cutoff,
    cutoffIso: new Date(cutoff).toISOString(),
    teamMatches: (id) => past.filter((m) => m.home.id === id || m.away.id === id),
    compMatches: (id) => past.filter((m) => m.compId === id),
    eloBefore: () => undefined,
    playerLines: () => [],
    refereeMatches: (id) => past.filter((m) => m.referee?.id === id),
  };
}

describe('fitPoissonGlm', () => {
  it('recupera coeficientes conocidos de una regresión de Poisson con offset', () => {
    const rng = mulberry32(7);
    const obs: GlmObs[] = [];
    for (let i = 0; i < 6000; i++) {
      const x = [rng() < 0.3 ? 1 : 0, rng() * 2 - 1];
      const off = Math.log(0.8 + rng());
      const mu = Math.exp(off + 0.2 * x[0] - 0.4 * x[1]);
      obs.push({ y: poisson(mu, rng), offset: off, x });
    }
    const fit = fitPoissonGlm(obs, [1e-6, 1e-6]);
    expect(fit.beta[0]).toBeCloseTo(0.2, 1);
    expect(fit.beta[1]).toBeCloseTo(-0.4, 1);
    expect(fit.se[0]).toBeGreaterThan(0);
    // L2 enorme: los coeficientes se quedan en el prior (0)
    const flat = fitPoissonGlm(obs, [1e9, 1e9]);
    expect(Math.abs(flat.beta[0])).toBeLessThan(1e-4);
    expect(Math.abs(flat.beta[1])).toBeLessThan(1e-4);
  });
});

describe('contextFeatures', () => {
  const lg = COMPETITION_BY_ID.get('laliga')!;
  const cl = COMPETITION_BY_ID.get('champions')!;
  const ctx = { comp: lg, configs: COMPETITION_BY_ID, homeLeague: new Map<string, string>() };
  // temporada anterior (2025) de la liga: 60 partidos entre A, B, C, D (sin E); temporada 2026: E ascendido
  const hist: MatchRecord[] = [];
  const old = ['A', 'B', 'C', 'D'];
  for (let i = 0; i < 60; i++) hist.push(rec(`o${i}`, 'laliga', 2025, -300 + i * 3, old[i % 4], old[(i + 1) % 4], 2, 1));
  hist.push(rec('j1', 'laliga', 2026, 0, 'A', 'E', 1, 0));
  hist.push(rec('cl1', 'champions', 2026, 4, 'B', 'X', 2, 2));
  hist.push(rec('j2', 'laliga', 2026, 7, 'E', 'C', 0, 0));
  const target = rec('t', 'laliga', 2026, 9, 'B', 'E');
  const cutoff = Date.parse(target.date);
  // partido «del futuro» (después del corte): no debe cambiar nada
  const future = rec('fut', 'champions', 2026, 9.5, 'E', 'B', 9, 0);

  it('calcula descanso, congestión, Europa, ascenso e inicio de temporada con el pasado', () => {
    const f = contextFeatures(ctx, preMatchView(target), viewOf(hist, cutoff));
    expect(f.restH).toBeCloseTo(5, 6); // B jugó la Champions el día 4
    expect(f.restA).toBeCloseTo(2, 6); // E jugó el día 7
    expect(f.shortA).toBeCloseTo(2, 6);
    expect(f.shortH).toBe(0);
    expect(f.euroH).toBe(0); // hace 5 días (> 4)
    expect(f.promA).toBe(1); // E no jugó la liga en 2025
    expect(f.promH).toBe(0);
    expect(f.gamesA).toBe(2);
    expect(f.gamesH).toBe(0);
    expect(f.n14A).toBe(2);
    expect(f.isLeague).toBe(1);
    expect(f.hasOpen).toBe(0);
    const g = contextFeatures(ctx, preMatchView(target), viewOf([...hist, future], cutoff));
    expect(g).toEqual(f);
  });

  it('marca «tras competición europea» solo si el último partido continental fue hace <= 4 días', () => {
    const t2 = rec('t2', 'laliga', 2026, 7, 'B', 'D');
    const f = contextFeatures(ctx, preMatchView(t2), viewOf(hist, Date.parse(t2.date)));
    expect(f.euroH).toBe(1);
    const fc = contextFeatures({ ...ctx, comp: cl }, preMatchView({ ...t2, compId: 'champions' }), viewOf(hist, Date.parse(t2.date)));
    expect(fc.euroH).toBe(0); // un partido continental no cuenta «tras Europa»
  });

  it('mide el movimiento de cuotas apertura → cierre', () => {
    const m = preMatchView({ ...target, odds: { provider: 'x', home: 1.8, draw: 3.6, away: 4.8, homeOpen: 2.1, drawOpen: 3.4, awayOpen: 3.6 } });
    const f = contextFeatures(ctx, m, viewOf(hist, cutoff));
    expect(f.hasOpen).toBe(1);
    expect(f.mvHA).toBeGreaterThan(0); // el local se acortó
  });
});

/** Filas sintéticas: goles ~ Poisson(λ_verdad) con λ de la fuente = λ_verdad con la diferencia inflada (factor s). */
function rows(n: number, inflate: number, seed = 5, start = T0): WalkForwardRow[] {
  const rng = mulberry32(seed);
  const out: WalkForwardRow[] = [];
  for (let i = 0; i < n; i++) {
    const d = (rng() - 0.5) * 1.6; // log(λh/λa) verdadero
    const tot = 2.6 + (rng() - 0.5) * 0.6;
    const th = (tot * Math.exp(d / 2)) / (Math.exp(d / 2) + Math.exp(-d / 2));
    const ta = tot - th;
    // la fuente exagera la diferencia: log(λh/λa) = d·(1+inflate), mismo total geométrico
    const g = Math.sqrt(th * ta);
    const lh = g * Math.exp((d * (1 + inflate)) / 2);
    const la = g * Math.exp((-d * (1 + inflate)) / 2);
    const o = dcOutcomes(lh, la, -0.05);
    const goal: Prob1X2 = { home: o.home, draw: o.draw, away: o.away };
    const hg = poisson(th, rng);
    const ag = poisson(ta, rng);
    const hasMarket = i % 2 === 0;
    const market: Prob1X2 = { home: 0.45, draw: 0.27, away: 0.28 };
    const elo: Prob1X2 = { home: 0.44, draw: 0.28, away: 0.28 };
    const weights = hasMarket ? { goal: 0.05, elo: 0.15, market: 0.8 } : { goal: 0.5, elo: 0.5, market: 0 };
    const sw = weights.goal + weights.elo + weights.market;
    const mix = (k: keyof Prob1X2) => (weights.goal * goal[k] + weights.elo * elo[k] + (hasMarket ? weights.market * market[k] : 0)) / sw;
    out.push({
      matchId: `r${seed}-${i}`,
      date: new Date(start + Math.floor(i / 10) * DAY).toISOString(),
      compId: 'liga',
      kind: 'league',
      tier: 6,
      neutral: false,
      hasMarket,
      goalKind: 'dc',
      goal,
      dc: goal,
      elo,
      ...(hasMarket ? { market, marketOver25: 0.52 } : {}),
      goalOver25: o.over25,
      lambdaHome: lh,
      lambdaAway: la,
      rho: -0.05,
      eloDiff: 0,
      minEloGames: 30,
      features: { gamesH: 10, gamesA: 10, isLeague: 1 },
      production: { home: mix('home'), draw: mix('draw'), away: mix('away') },
      weights,
      outcome: hg > ag ? 0 : hg === ag ? 1 : 2,
      hg,
      ag,
    });
  }
  return out;
}

describe('ContextRegressor', () => {
  it('sin modelo (pocas filas) devuelve exactamente el ensamble de producción', () => {
    const reg = new ContextRegressor({ terms: ['dlog'], minRows: 150 });
    const rs = rows(100, 0.3);
    reg.prepare(rs, new Date(Date.parse(rs[rs.length - 1].date) + DAY).toISOString());
    for (const r of rs.slice(0, 20)) expect(reg.blend(r)).toBe(r.production);
  });

  it('el pool con la fuente de goles sin cambios reproduce producción', () => {
    for (const r of rows(30, 0.2)) {
      const p = poolWithGoal(r, r.goal, r.goalOver25);
      expect(p.p.home).toBeCloseTo(r.production.home, 12);
      expect(p.p.draw).toBeCloseTo(r.production.draw, 12);
      expect(p.over25).toBeCloseTo(productionOver25(r, r.goalOver25), 12);
      if (r.hasMarket) expect(p.over25).toBeCloseTo((0.05 * r.goalOver25 + 0.8 * 0.52) / 0.85, 12);
      else expect(p.over25).toBe(r.goalOver25);
    }
  });

  it('detecta y corrige una diferencia de fuerzas inflada (dlog < 0) y mejora la fuente de goles', () => {
    const train = rows(4000, 0.4, 11);
    const reg = new ContextRegressor({ terms: ['dlog'], kappa: 1 });
    const asOf = new Date(Date.parse(train[train.length - 1].date) + DAY).toISOString();
    reg.prepare(train, asOf);
    const beta = reg.log[reg.log.length - 1].beta[0];
    // verdadero: log λ_verdad = log λ − 0,4/1,4 · (½ dlog) ⇒ β ≈ −0,143
    expect(beta).toBeLessThan(-0.08);
    expect(beta).toBeGreaterThan(-0.22);
    // verosimilitud de Poisson de los goles en partidos nuevos (fuera de la muestra de ajuste)
    const test = rows(4000, 0.4, 12, Date.parse(asOf) + DAY);
    const nll = (y: number, mu: number) => mu - y * Math.log(mu);
    let llBase = 0;
    let llVar = 0;
    for (const r of test) {
      const [mh, ma] = reg.multipliers(r, r.lambdaHome, r.lambdaAway);
      llBase += nll(r.hg, r.lambdaHome) + nll(r.ag, r.lambdaAway);
      llVar += nll(r.hg, r.lambdaHome * mh) + nll(r.ag, r.lambdaAway * ma);
    }
    expect(llVar).toBeLessThan(llBase);
  });

  it('solo se entrena con partidos que empezaron >= guardHours antes del reajuste y sin prórroga sin resolver', () => {
    const base = rows(400, 0.4, 21);
    const asOf = new Date(Date.parse(base[base.length - 1].date) + DAY).toISOString();
    const a = new ContextRegressor({ terms: ['dlog'], kappa: 1, guardHours: 3 });
    a.prepare(base, asOf);
    // filas «recientes» (1 h antes del reajuste) con goles absurdos y filas con prórroga sin resolver: se ignoran
    const late = rows(200, 0.4, 22).map((r, i) => ({ ...r, matchId: `late${i}`, date: new Date(Date.parse(asOf) - 3_600_000).toISOString(), hg: 9, ag: 0 }));
    const et = rows(200, 0.4, 23).map((r, i) => ({ ...r, matchId: `et${i}`, extraTimeUnresolved: true, hg: 0, ag: 9 }));
    const b = new ContextRegressor({ terms: ['dlog'], kappa: 1, guardHours: 3 });
    b.prepare([...base, ...late, ...et], asOf);
    expect(b.log[b.log.length - 1].beta).toEqual(a.log[a.log.length - 1].beta);
    expect(b.log[b.log.length - 1].n).toBe(400);
  });

  it('no arrastra estado: un reajuste con menos filas olvida el modelo anterior', () => {
    const rs = rows(1000, 0.4, 31);
    const reg = new ContextRegressor({ terms: ['dlog'], kappa: 1, minRows: 150 });
    reg.prepare(rs, new Date(Date.parse(rs[rs.length - 1].date) + DAY).toISOString());
    expect(reg.multipliers(rs[0], rs[0].lambdaHome, rs[0].lambdaAway)).not.toEqual([1, 1]);
    reg.prepare(rs.slice(0, 50), rs[50].date);
    expect(reg.multipliers(rs[0], rs[0].lambdaHome, rs[0].lambdaAway)).toEqual([1, 1]);
  });

  it('adjustRow devuelve la fila con la fuente de goles ajustada y su ensamble coincide con blend', () => {
    const rs = rows(1000, 0.4, 51);
    const reg = new ContextRegressor({ terms: ['dlog'], kappa: 1, minRows: 150 });
    reg.prepare(rs, new Date(Date.parse(rs[rs.length - 1].date) + DAY).toISOString());
    const r = rs[3];
    const a = reg.adjustRow(r);
    const [mh, ma] = reg.multipliers(r, r.lambdaHome, r.lambdaAway);
    expect(a.lambdaHome).toBeCloseTo(r.lambdaHome * mh, 12);
    expect(a.lambdaAway).toBeCloseTo(r.lambdaAway * ma, 12);
    expect(a.dc).toEqual(a.goal);
    const b = reg.blend(r);
    const p = 'p' in b ? b.p : b;
    expect(a.production.home).toBeCloseTo(p.home, 12);
    expect(a.production.away).toBeCloseTo(p.away, 12);
    expect(a.outcome).toBe(r.outcome);
  });

  it('modo final: sin modelo devuelve producción; con modelo, delta coherente y probabilidades válidas', () => {
    const rs = rows(800, 0.4, 41);
    const reg = new ContextRegressor({ level: 'final', terms: ['dlog'], kappa: 1, minRows: 150 });
    reg.prepare(rs.slice(0, 10), rs[10].date);
    expect(reg.blend(rs[0])).toBe(rs[0].production);
    reg.prepare(rs, new Date(Date.parse(rs[rs.length - 1].date) + DAY).toISOString());
    const out = reg.blend(rs[1]);
    const p = 'p' in out ? out.p : out;
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 9);
    expect(Math.min(p.home, p.draw, p.away)).toBeGreaterThan(0);
  });
});

describe('variantes context*', () => {
  it('cargan, pasan la comprobación de código fuente y tienen combinador', async () => {
    for (const name of ['context', 'context-dlog', 'context-full', 'context-final']) {
      const v = await loadVariant(name);
      expect(v.name).toBe(name);
      expect(typeof v.combine?.blend).toBe('function');
      expect(typeof v.combine?.prepare).toBe('function');
      expect(typeof v.features).toBe('function');
    }
  });
});
