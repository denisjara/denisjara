import { describe, expect, it } from 'vitest';
import {
  correlation,
  dcLogLik,
  fitDixonColes,
  mean,
  mulberry32,
  predictDC,
  sampleDiscrete,
  samplePoisson,
  scoreMatrix,
  type DCMatch,
} from '../../src/lib/models';

const DAY = 86_400_000;

/** Liga sintética: doble vuelta por temporada, marcadores muestreados de la matriz DC verdadera. */
function simulateLeague(seed: number, nTeams: number, seasons: number, homeAdv: number, rho: number) {
  const rng = mulberry32(seed);
  const teams = Array.from({ length: nTeams }, (_, i) => `E${i}`);
  const la = teams.map(() => (rng() - 0.5) * 0.9);
  const ld = teams.map(() => (rng() - 0.5) * 0.9);
  const ma = mean(la);
  const md = mean(ld);
  const att = la.map((x) => Math.exp(x - ma));
  const def = ld.map((x) => Math.exp(x - md));
  const base = 1.25;
  const matches: DCMatch[] = [];
  let t = Date.UTC(2023, 7, 1);
  for (let s = 0; s < seasons; s++) {
    for (let h = 0; h < nTeams; h++) {
      for (let a = 0; a < nTeams; a++) {
        if (h === a) continue;
        const m = scoreMatrix(base * att[h] * def[a] * homeAdv, base * att[a] * def[h], rho, 10);
        const idx = sampleDiscrete(m.flat(), rng);
        t += 0.8 * DAY;
        matches.push({ home: teams[h], away: teams[a], hg: Math.floor(idx / 11), ag: idx % 11, date: new Date(t).toISOString() });
      }
    }
  }
  return { teams, att, def, base, matches, refDate: new Date(t + DAY).toISOString() };
}

describe('fitDixonColes', () => {
  it('recupera los parámetros de una liga simulada (corr > 0.9, homeAdv ±0.08)', () => {
    const trueHome = 1.3;
    const L = simulateLeague(2026, 20, 4, trueHome, -0.1);
    const model = fitDixonColes(L.matches, { refDate: L.refDate, xi: 0 });
    const estA = L.teams.map((t) => Math.log(model.attack[t]));
    const estD = L.teams.map((t) => Math.log(model.defence[t]));
    expect(correlation(estA, L.att.map(Math.log))).toBeGreaterThan(0.9);
    expect(correlation(estD, L.def.map(Math.log))).toBeGreaterThan(0.9);
    expect(Math.abs(model.homeAdv - trueHome)).toBeLessThan(0.08);
    expect(model.rho).toBeGreaterThanOrEqual(-0.2);
    expect(model.rho).toBeLessThanOrEqual(0.2);
    expect(model.rho).toBeLessThan(0); // el verdadero es -0.1
    expect(Math.abs(model.base - L.base)).toBeLessThan(0.15);
    expect(model.nMatches).toBe(L.matches.length);
  });

  it('cumple la restricción de media geométrica 1 y cuenta partidos por equipo', () => {
    const L = simulateLeague(7, 10, 2, 1.25, -0.05);
    const model = fitDixonColes(L.matches, { refDate: L.refDate, xi: 0.0019 });
    const ga = mean(model.teams.map((t) => Math.log(model.attack[t])));
    const gd = mean(model.teams.map((t) => Math.log(model.defence[t])));
    expect(ga).toBeCloseTo(0, 10);
    expect(gd).toBeCloseTo(0, 10);
    expect(model.teams).toHaveLength(10);
    for (const t of model.teams) expect(model.matchesByTeam[t]).toBe(36); // 2 temporadas × 18
  });

  it('es el MLE: perturbar cualquier parámetro reduce la log-verosimilitud (sin prior)', () => {
    const L = simulateLeague(11, 12, 2, 1.3, -0.1);
    const model = fitDixonColes(L.matches, { refDate: L.refDate, xi: 0, priorWeight: 0, tol: 1e-10 });
    const ll0 = dcLogLik(model, L.matches);
    expect(model.logLik).toBeCloseTo(ll0, 6);
    for (const eps of [1e-3, -1e-3]) {
      for (const t of model.teams.slice(0, 4)) {
        const a = structuredClone(model);
        a.attack[t] *= Math.exp(eps);
        expect(dcLogLik(a, L.matches)).toBeLessThan(ll0);
        const d = structuredClone(model);
        d.defence[t] *= Math.exp(eps);
        expect(dcLogLik(d, L.matches)).toBeLessThan(ll0);
      }
      const h = structuredClone(model);
      h.homeAdv *= Math.exp(eps);
      expect(dcLogLik(h, L.matches)).toBeLessThan(ll0);
      const r = structuredClone(model);
      r.rho += eps;
      expect(dcLogLik(r, L.matches)).toBeLessThan(ll0);
    }
  });

  it('ajusta 760 partidos / 40 equipos en < 1.5 s', () => {
    const rng = mulberry32(99);
    const matches: DCMatch[] = [];
    for (let i = 0; i < 760; i++) {
      const h = Math.floor(rng() * 40);
      let a = Math.floor(rng() * 39);
      if (a >= h) a++;
      matches.push({
        home: `X${h}`,
        away: `X${a}`,
        hg: samplePoisson(1.5, rng),
        ag: samplePoisson(1.15, rng),
        date: new Date(Date.UTC(2025, 0, 1) + i * 0.7 * DAY).toISOString(),
      });
    }
    const t0 = performance.now();
    const model = fitDixonColes(matches, { refDate: '2026-11-03T00:00:00Z', xi: 0.0019 });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1500);
    expect(model.teams).toHaveLength(40);
    expect(Number.isFinite(model.logLik)).toBe(true);
  });

  it('regulariza hacia la media a los equipos con pocos partidos', () => {
    const L = simulateLeague(5, 10, 2, 1.3, 0);
    // equipo nuevo con un único partido muy goleador
    const extra: DCMatch = { home: 'Nuevo', away: 'E0', hg: 6, ag: 0, date: L.refDate };
    const strong = fitDixonColes([...L.matches, extra], { refDate: L.refDate, xi: 0, priorWeight: 2 });
    const weak = fitDixonColes([...L.matches, extra], { refDate: L.refDate, xi: 0, priorWeight: 0.01 });
    expect(strong.attack['Nuevo']).toBeLessThan(weak.attack['Nuevo']);
    expect(strong.attack['Nuevo']).toBeGreaterThan(1);
    expect(strong.attack['Nuevo']).toBeLessThan(3);
    expect(strong.matchesByTeam['Nuevo']).toBe(1);
  });

  it('la ponderación temporal da más peso a los partidos recientes', () => {
    const base: DCMatch[] = [];
    // A domina en el pasado lejano, B en el reciente
    for (let i = 0; i < 30; i++) {
      base.push({ home: 'A', away: 'B', hg: 3, ag: 0, date: new Date(Date.UTC(2024, 0, 1) + i * DAY).toISOString() });
      base.push({ home: 'B', away: 'A', hg: 0, ag: 3, date: new Date(Date.UTC(2024, 0, 2) + i * DAY).toISOString() });
      base.push({ home: 'A', away: 'B', hg: 0, ag: 3, date: new Date(Date.UTC(2026, 9, 1) + i * DAY).toISOString() });
      base.push({ home: 'B', away: 'A', hg: 3, ag: 0, date: new Date(Date.UTC(2026, 9, 2) + i * DAY).toISOString() });
    }
    const flat = fitDixonColes(base, { refDate: '2026-11-03', xi: 0 });
    const decay = fitDixonColes(base, { refDate: '2026-11-03', xi: 0.005 });
    expect(Math.abs(flat.attack['A'] - flat.attack['B'])).toBeLessThan(0.05);
    expect(decay.attack['B']).toBeGreaterThan(decay.attack['A']);
  });

  it('partidos neutrales no usan ventaja local; casos vacíos e inválidos', () => {
    const empty = fitDixonColes([], { refDate: '2026-11-03', xi: 0.002 });
    expect(empty.teams).toEqual([]);
    expect(empty.nMatches).toBe(0);
    expect(predictDC(empty, 'A', 'B')).toBeNull();
    const invalid = fitDixonColes(
      [
        { home: 'A', away: 'A', hg: 1, ag: 1, date: '2026-01-01' },
        { home: 'A', away: 'B', hg: -1, ag: 1, date: '2026-01-01' },
        { home: 'A', away: 'B', hg: 1.5, ag: 1, date: '2026-01-01' },
        { home: 'A', away: 'B', hg: 2, ag: 1, date: '2026-01-01', weight: 0 },
      ],
      { refDate: '2026-11-03', xi: 0 },
    );
    expect(invalid.nMatches).toBe(0);

    const L = simulateLeague(3, 8, 2, 1.3, -0.05);
    const model = fitDixonColes(L.matches, { refDate: L.refDate, xi: 0.0019 });
    const p = predictDC(model, 'E1', 'E2')!;
    const n = predictDC(model, 'E1', 'E2', true)!;
    expect(p.lambdaHome / n.lambdaHome).toBeCloseTo(model.homeAdv, 12);
    expect(p.lambdaAway).toBeCloseTo(n.lambdaAway, 12);
    expect(p.lambdaHome).toBeCloseTo(model.base * model.attack.E1 * model.defence.E2 * model.homeAdv, 12);
    expect(predictDC(model, 'E1', 'Desconocido')).toBeNull();
  });
});
