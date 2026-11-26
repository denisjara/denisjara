/**
 * Variantes «form-*» (pipeline/experiments/form/): prueba adversarial propia de la forma del equipo. Los rasgos de
 * forma de goles y los multiplicadores de forma estadística solo dependen del pasado del equipo (partidos «del
 * futuro» extremos, también EN LA MISMA COMPETICIÓN que el partido predicho, no cambian nada: la comprobación de fuga
 * del banco solo envenena con una copa ficticia), salen con el signo esperado en casos a mano y son neutros sin
 * historia; el regresor reproduce producción sin modelo, solo entrena con filas que empezaron >= 3 h antes del
 * reajuste y recupera un efecto de forma conocido; las variantes cargan y pasan la comprobación de código fuente.
 */
import { describe, expect, it } from 'vitest';
import { dcOutcomes, mulberry32 } from '../../src/lib/models';
import type { Prob1X2 } from '../../src/types/data';
import type { MatchRecord } from '../../pipeline/types';
import { formFeatures, goalForm, statForm } from '../../pipeline/experiments/form/features';
import { FormRegressor } from '../../pipeline/experiments/form/combiner';
import { loadVariant } from '../../pipeline/experiments/load';
import { preMatchView, type FeatureContext, type HistoryView, type WalkForwardRow } from '../../pipeline/experiments/types';
import { COMPETITION_BY_ID } from '../../pipeline/config';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5, 18);
const team = (id: string) => ({ id, name: id, short: id, abbr: id.slice(0, 3).toUpperCase() });

function rec(id: string, day: number, home: string, away: string, hg: number, ag: number, corners: [number, number] = [5, 4], compId = 'laliga'): MatchRecord {
  return {
    id,
    compId,
    season: 2025,
    currentSeason: true,
    date: new Date(T0 + day * DAY).toISOString(),
    status: 'finished',
    home: team(home),
    away: team(away),
    score: { home: hg, away: ag },
    stats: {
      home: { goals: hg, shots: 12, shotsOnTarget: 4, corners: corners[0], fouls: 11 },
      away: { goals: ag, shots: 10, shotsOnTarget: 3, corners: corners[1], fouls: 12 },
    },
  };
}

function viewOf(all: MatchRecord[], cutoff: number, elo: Record<string, number> = {}): HistoryView {
  const past = all.filter((m) => Date.parse(m.date) < cutoff).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return {
    cutoff,
    cutoffIso: new Date(cutoff).toISOString(),
    teamMatches: (id) => past.filter((m) => m.home.id === id || m.away.id === id),
    compMatches: (id) => past.filter((m) => m.compId === id),
    eloBefore: (id) => elo[id],
    playerLines: () => [],
    refereeMatches: () => [],
  };
}

/** Temporada a mano: A y B juegan contra un pool de rivales; A arrasa en los últimos partidos. */
function season(): MatchRecord[] {
  const out: MatchRecord[] = [];
  const opps = ['C', 'D', 'E', 'F'];
  for (let i = 0; i < 30; i++) {
    const o = opps[i % 4];
    const hot = i >= 24; // últimas 6 jornadas
    out.push(rec(`a${i}`, i * 7, 'A', o, hot ? 4 : 1, hot ? 0 : 1, hot ? [12, 2] : [5, 4]));
    out.push(rec(`b${i}`, i * 7 + 1, o, 'B', 1, 1));
  }
  return out;
}
const ELO = { A: 1500, B: 1500, C: 1500, D: 1500, E: 1500, F: 1500 };

describe('forma del equipo: rasgos sin fuga', () => {
  const all = season();
  const cutoff = T0 + 30 * 7 * DAY;
  const target = preMatchView(rec('t', 30 * 7, 'A', 'B', 0, 0));
  const ctx = { comp: COMPETITION_BY_ID.get('laliga')!, configs: COMPETITION_BY_ID, homeLeague: new Map() } as FeatureContext;

  it('el equipo en racha tiene residuos positivos a favor y negativos en contra; el otro ~0', () => {
    const v = viewOf(all, cutoff, ELO);
    const a = goalForm(v, 'A');
    const b = goalForm(v, 'B');
    expect(a.n).toBe(6);
    expect(a.gfRes).toBeGreaterThan(1);
    expect(a.gaRes).toBeLessThan(-0.5);
    expect(Math.abs(b.gfRes)).toBeLessThan(0.3);
    const s = statForm(v, 'A', 'corners', { K: 10, maxMult: 1.25 });
    expect(s.forM).toBeGreaterThan(1.1);
    expect(s.agM).toBeLessThan(1);
    expect(statForm(v, 'B', 'corners', { K: 10, maxMult: 1.25 }).forM).toBeCloseTo(1, 1);
  });

  it('partidos del FUTURO extremos (misma competición, copa y mismos equipos) no cambian nada', () => {
    const poison: MatchRecord[] = [];
    for (let k = 0; k < 8; k++) {
      poison.push(rec(`p${k}`, 30 * 7 + k * 0.5, 'A', 'B', 0, 9, [0, 30], 'laliga')); // misma competición
      poison.push(rec(`q${k}`, 30 * 7 + 1 + k, 'B', 'A', 9, 0, [30, 0], 'copadelrey'));
    }
    poison.push(rec('same-time', 30 * 7, 'A', 'B', 0, 9, [0, 30])); // mismo inicio (no es «anterior»)
    const clean = viewOf(all, cutoff, ELO);
    const dirty = viewOf([...all, ...poison], cutoff, ELO);
    expect(formFeatures(ctx, target, dirty)).toEqual(formFeatures(ctx, target, clean));
    for (const key of ['corners', 'shots', 'shotsOnTarget', 'fouls'] as const) {
      for (const t of ['A', 'B']) expect(statForm(dirty, t, key, { K: 10, maxMult: 1.25 })).toEqual(statForm(clean, t, key, { K: 10, maxMult: 1.25 }));
    }
  });

  it('sin historia (o con menos de 3 partidos recientes) es neutra', () => {
    const v = viewOf(all.slice(0, 2), T0 + 20 * DAY, ELO);
    const f = formFeatures(ctx, target, v);
    expect(Object.values(f).every((x) => x === 0)).toBe(true);
    expect(statForm(v, 'A', 'corners', { K: 10, maxMult: 1.25 })).toEqual({ forM: 1, agM: 1 });
    // parón largo: el último partido hace más de 75 días → sin forma
    expect(goalForm(viewOf(all, cutoff + 120 * DAY, ELO), 'A').n).toBe(0);
  });
});

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

/** Filas sintéticas sin cuotas: los goles reales dependen de la forma (β = 0,15 en gfRes propio). */
function rows(n: number, beta: number, seed = 3): WalkForwardRow[] {
  const rng = mulberry32(seed);
  const out: WalkForwardRow[] = [];
  for (let i = 0; i < n; i++) {
    const lh = 1.2 + rng() * 0.8;
    const la = 0.8 + rng() * 0.7;
    const fH = (rng() - 0.5) * 2;
    const fA = (rng() - 0.5) * 2;
    const o = dcOutcomes(lh, la, -0.05);
    const p: Prob1X2 = { home: o.home, draw: o.draw, away: o.away };
    const hg = poisson(lh * Math.exp(beta * fH), rng);
    const ag = poisson(la * Math.exp(beta * fA), rng);
    out.push({
      matchId: `r${i}`,
      date: new Date(T0 + Math.floor(i / 10) * DAY).toISOString(),
      compId: 'liga',
      kind: 'league',
      tier: 6,
      neutral: false,
      hasMarket: false,
      goalKind: 'dc',
      goal: p,
      dc: p,
      elo: p,
      goalOver25: o.over25,
      lambdaHome: lh,
      lambdaAway: la,
      rho: -0.05,
      eloDiff: 0,
      minEloGames: 30,
      features: { gfResH: fH, gfResA: fA, gaResH: 0, gaResA: 0, xgfResH: 0, xgfResA: 0, xgaResH: 0, xgaResA: 0 },
      production: p,
      weights: { goal: 0.5, elo: 0.5, market: 0 },
      outcome: hg > ag ? 0 : hg === ag ? 1 : 2,
      hg,
      ag,
    });
  }
  return out;
}

describe('FormRegressor', () => {
  it('sin modelo devuelve exactamente producción y solo entrena con filas >= 3 h antes del reajuste', () => {
    const rs = rows(3000, 0.15);
    const reg = new FormRegressor({ apply: 'all', minRows: 200 });
    // reajuste justo al inicio de la primera fila: nada que entrenar
    reg.prepare(rs, rs[0].date);
    for (const r of rs.slice(0, 10)) expect(reg.blend(r)).toBe(r.production);
    // filas del futuro (fecha >= asOf − 3 h) no entran
    const asOf = new Date(Date.parse(rs[2500].date) + 2 * 3_600_000).toISOString();
    reg.prepare(rs, asOf);
    expect(reg.log[reg.log.length - 1].n).toBe(rs.filter((r) => Date.parse(r.date) < Date.parse(asOf) - 3 * 3_600_000).length);
  });

  it('recupera un efecto de forma conocido y mueve el 1X2 en la dirección correcta', () => {
    const rs = rows(6000, 0.15);
    const reg = new FormRegressor({ apply: 'all', minRows: 200, kappa: 1 });
    reg.prepare(rs, new Date(Date.parse(rs[rs.length - 1].date) + DAY).toISOString());
    const beta = reg.log[reg.log.length - 1].beta;
    expect(beta[0]).toBeGreaterThan(0.08);
    expect(beta[0]).toBeLessThan(0.22);
    const r = { ...rs[0], features: { ...rs[0].features, gfResH: 1, gfResA: -1 } };
    const out = reg.blend(r) as { p: Prob1X2 };
    expect(out.p.home).toBeGreaterThan(r.production.home);
  });

  it('apply noOdds deja los partidos con cuotas como producción', () => {
    const rs = rows(3000, 0.15);
    const reg = new FormRegressor({ apply: 'noOdds', minRows: 200, kappa: 1 });
    reg.prepare(rs, new Date(Date.parse(rs[rs.length - 1].date) + DAY).toISOString());
    const withOdds = { ...rs[0], hasMarket: true, features: { ...rs[0].features, gfResH: 1 } };
    expect(reg.blend(withOdds)).toBe(withOdds.production);
  });
});

describe('variantes form-*', () => {
  it('cargan y pasan la comprobación de código fuente', async () => {
    for (const n of ['form-goals', 'form-goals-noodds', 'form-stats', 'form-stats-k30']) {
      const v = await loadVariant(n);
      expect(v.name).toBe(n);
    }
  });
});
