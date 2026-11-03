/**
 * Pesos del ensamble: par con cuotas / par sin cuotas, Elo→goles con peso reducido y más peso al mercado cuando un
 * equipo tiene pocos partidos Elo. Selecciones fuera del ranking Elo de clubes.
 */
import { describe, expect, it } from 'vitest';
import { COMPETITION_BY_ID, MODEL } from '../../pipeline/config';
import { buildModelSuite, isNationalTeamComp } from '../../pipeline/analytics/ratings';
import { contextFor, defaultWeights, ensembleWeights, predictMatch, predictProbsOnly } from '../../pipeline/analytics/predict';
import { createContext } from '../../pipeline/publish/context';
import type { CompetitionConfig } from '../../pipeline/config';
import type { CompetitionStore, MatchRecord } from '../../pipeline/types';
import { SYN_CONFIG_MAP, SYN_CONFIGS, TEAMS_A, TEAMS_LOW, scheduled, syntheticWorld } from './synthetic';

const world = syntheticWorld(11);
const suite = buildModelSuite(world.stores, SYN_CONFIGS, world.refDate);
const ctxA = contextFor(suite, SYN_CONFIG_MAP.get('liga-a')!, SYN_CONFIG_MAP);
const ctxCopa = contextFor(suite, SYN_CONFIG_MAP.get('copa')!, SYN_CONFIG_MAP);
const future = new Date(Date.parse(world.refDate) + 2 * 86_400_000).toISOString();
const ODDS = { provider: 'Test', home: 2.1, draw: 3.4, away: 3.6 };

describe('ensembleWeights', () => {
  const w = defaultWeights();

  it('con cuotas usa wDixonColes/wElo/wMarket; sin cuotas el par sin mercado', () => {
    expect(ensembleWeights(w, { hasMarket: true, goalKind: 'dc', minGames: 50 })).toEqual({ goal: MODEL.wDixonColes, elo: MODEL.wElo, market: MODEL.wMarket });
    expect(ensembleWeights(w, { hasMarket: false, goalKind: 'dc', minGames: 50 })).toEqual({ goal: MODEL.wDixonColesNoMarket, elo: MODEL.wEloNoMarket, market: 0 });
  });

  it('Elo→goles pesa eloGoalWeightFactor de la parte de goles', () => {
    const r = ensembleWeights(w, { hasMarket: false, goalKind: 'elo-goals', minGames: 50 });
    expect(r.goal).toBeCloseTo(MODEL.wDixonColesNoMarket * MODEL.eloGoalWeightFactor, 10);
    expect(r.elo).toBe(MODEL.wEloNoMarket);
  });

  it(`con menos de ${MODEL.lowDataGames} partidos Elo y cuotas, el mercado gana peso (lineal hasta lowDataGames)`, () => {
    const share = (n: number) => {
      const r = ensembleWeights(w, { hasMarket: true, goalKind: 'dc', minGames: n });
      return r.market / (r.goal + r.elo + r.market);
    };
    const full = MODEL.wMarket / (MODEL.wDixonColes + MODEL.wElo + MODEL.wMarket);
    expect(share(0)).toBeGreaterThan(full);
    expect(share(0)).toBeGreaterThan(share(5));
    expect(share(5)).toBeGreaterThan(share(MODEL.lowDataGames));
    expect(share(MODEL.lowDataGames)).toBeCloseTo(full, 10);
    // sin cuotas no cambia nada
    expect(ensembleWeights(w, { hasMarket: false, goalKind: 'dc', minGames: 0 })).toEqual(ensembleWeights(w, { hasMarket: false, goalKind: 'dc', minGames: 50 }));
  });
});

describe('predicción con los pesos de MODEL', () => {
  it('sin cuotas publica los pesos del par sin mercado', () => {
    const res = predictMatch(scheduled('liga-a', future, TEAMS_A[3].ref, TEAMS_A[4].ref), ctxA);
    const s = MODEL.wDixonColesNoMarket + MODEL.wEloNoMarket;
    expect(res.model.weights.market).toBe(0);
    expect(res.model.weights.dixonColes).toBeCloseTo(MODEL.wDixonColesNoMarket / s, 3);
    expect(res.model.weights.elo).toBeCloseTo(MODEL.wEloNoMarket / s, 3);
  });

  it('con cuotas publica wDixonColes/wElo/wMarket', () => {
    const res = predictMatch(scheduled('liga-a', future, TEAMS_A[3].ref, TEAMS_A[4].ref, { odds: ODDS }), ctxA);
    const s = MODEL.wDixonColes + MODEL.wElo + MODEL.wMarket;
    expect(res.model.weights.market).toBeCloseTo(MODEL.wMarket / s, 3);
    expect(res.model.weights.dixonColes).toBeCloseTo(MODEL.wDixonColes / s, 3);
  });

  it('equipo sin partidos Elo (copa) con cuotas: el ensamble queda más cerca del mercado', () => {
    const newcomer = { id: 'nuevo-1', name: 'Recién llegado', short: 'Nuevo', abbr: 'NUE' };
    const m = scheduled('copa', future, newcomer, TEAMS_LOW[0].ref, { odds: ODDS });
    const r = predictProbsOnly(m, ctxCopa);
    expect(r.minEloGames).toBe(0);
    const noBoost = predictProbsOnly(m, { ...ctxCopa, weights: { ...defaultWeights(), lowDataGames: 0 } });
    const dist = (p: { home: number }) => Math.abs(p.home - r.sources.market!.home);
    expect(dist(r.p)).toBeLessThan(dist(noBoost.p));
  });
});

describe('selecciones nacionales fuera del ranking de clubes', () => {
  it('detecta la Nations League por su slug', () => {
    expect(isNationalTeamComp(COMPETITION_BY_ID.get('nations'))).toBe(true);
    expect(isNationalTeamComp(COMPETITION_BY_ID.get('champions'))).toBe(false);
    expect(isNationalTeamComp({ ...COMPETITION_BY_ID.get('champions')!, nationalTeams: true })).toBe(true);
  });

  it('globalEloRank: clubes 1..N entre clubes y selecciones con su propio ranking', () => {
    const nationsCfg: CompetitionConfig = { id: 'selecciones', slug: 'uefa.nations', name: 'Selecciones', shortName: 'Sel.', country: 'Europa', flag: '🇪🇺', kind: 'continental', tier: 7 };
    const configs = [...SYN_CONFIGS, nationsCfg];
    const t0 = Date.parse(world.refDate) - 200 * 86_400_000;
    const nat = (i: number) => ({ id: `N${i}`, name: `Selección ${i}`, short: `S${i}`, abbr: `S${i}` });
    // selecciones muy fuertes (golean siempre) para que, de no separarlas, encabezaran el ranking
    const matches: MatchRecord[] = [];
    for (let k = 0; k < 12; k++) {
      const h = k % 4;
      const a = (k + 1) % 4;
      matches.push({
        id: `nat-${k}`,
        compId: 'selecciones',
        season: 2025,
        currentSeason: true,
        date: new Date(t0 + k * 7 * 86_400_000).toISOString(),
        status: 'finished',
        home: nat(h),
        away: nat(a),
        score: { home: 5, away: 0 },
      });
    }
    const stores: CompetitionStore[] = [...world.stores, { compId: 'selecciones', slug: 'uefa.nations', updatedAt: world.refDate, matches, players: [], standings: [] }];
    const ctx = createContext({ stores, configs, now: new Date(world.refDate) });
    expect([...ctx.nationalTeams].sort()).toEqual(['N0', 'N1', 'N2', 'N3']);
    const clubRanks = [...ctx.globalEloRank].filter(([t]) => !ctx.nationalTeams.has(t)).map(([, r]) => r).sort((a, b) => a - b);
    expect(clubRanks[0]).toBe(1);
    expect(clubRanks).toEqual(clubRanks.map((_, i) => i + 1));
    const natRanks = ['N0', 'N1', 'N2', 'N3'].map((t) => ctx.globalEloRank.get(t)!).sort();
    expect(natRanks).toEqual([1, 2, 3, 4]);
    expect(ctx.rankPool).toEqual({ clubs: clubRanks.length, national: 4 });
  });
});
