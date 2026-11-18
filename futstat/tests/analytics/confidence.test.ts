/**
 * Pronósticos de alta confianza: candidatos coherentes, resolución, elección de umbrales en datos sintéticos,
 * selección por partido y evaluación sin fuga (un partido "del futuro" no cambia nada de lo anterior; los
 * resultados del holdout no cambian las reglas de calibración).
 */
import { describe, expect, it } from 'vitest';
import {
  convolve,
  mulberry32,
  nbPmfArray,
  overUnderFromDist,
  sampleNegBin,
  samplePoisson,
  scoreMatrix,
  totalGoalsDist,
} from '../../src/lib/models';
import type { OddsSnapshot, StatProjection } from '../../src/types/data';
import type { CompetitionConfig } from '../../pipeline/config';
import type { CompetitionStore, MatchRecord } from '../../pipeline/types';
import {
  CONFIDENCE_FAMILIES,
  confidenceCandidates,
  confidenceHistory,
  confidenceRulesFrom,
  evaluateConfidence,
  fitPlatt,
  plattProb,
  selectConfidencePicks,
  settleCandidate,
  syntheticDnbOdds,
  syntheticDoubleOdds,
  upcomingCandidates,
  walkForwardCandidates,
  wilsonInterval,
  type ConfidenceCandidate,
  type ConfidenceFamily,
  type ConfidenceHistoryItem,
  type ConfidenceRules,
  type SettledCandidate,
} from '../../pipeline/analytics/confidence';
import { baseContext, computeWalkForward, createContext } from '../../pipeline/publish/context';
import { predictMatch } from '../../pipeline/analytics/predict';

const DAY = 86_400_000;

function projection(key: 'corners' | 'cards', home: number, away: number, r: number): StatProjection {
  const maxK = key === 'corners' ? 30 : 16;
  const total = convolve(nbPmfArray(home, r, maxK), nbPmfArray(away, r, maxK), maxK * 2);
  return {
    key,
    label: key === 'corners' ? 'Córners' : 'Tarjetas',
    home,
    away,
    total: home + away,
    totalDist: total,
    lines: [],
  };
}

const ODDS: OddsSnapshot = { provider: 'Test', home: 1.6, draw: 4.0, away: 5.5, totalLine: 2.5, over: 1.8, under: 2.0, spreadLine: -1.5, spreadHome: 2.4, spreadAway: 1.55 };

describe('candidatos', () => {
  const matrix = scoreMatrix(1.9, 0.8, -0.05);
  const p = { home: 0.6, draw: 0.25, away: 0.15 };
  const projections = [projection('corners', 5.6, 4.2, 9), projection('cards', 2.1, 2.4, 12)];
  const all = confidenceCandidates({ homeName: 'Local FC', awayName: 'Visitante CF', p, matrix, projections }, { minProb: 0, maxProb: 1 });
  const byFam = new Map(all.map((c) => [c.family, c]));

  it('probabilidades en [0,1], cuota justa = 1/p, una por familia y textos con los equipos', () => {
    expect(all.length).toBeGreaterThan(15);
    expect(new Set(all.map((c) => c.family)).size).toBe(all.length);
    for (const c of all) {
      expect(c.prob).toBeGreaterThanOrEqual(0);
      expect(c.prob).toBeLessThanOrEqual(1);
      expect(c.fairOdds).toBeCloseTo(1 / c.prob, 6);
      expect(CONFIDENCE_FAMILIES.some((f) => f.id === c.family && f.theme === c.theme)).toBe(true);
      expect(c.selection.length).toBeGreaterThan(3);
    }
    expect(byFam.get('1x2-fav')!.selection).toContain('Local FC');
    expect(byFam.get('1x2-fav')!.prob).toBeCloseTo(0.6, 10);
  });

  it('doble oportunidad = 1 − prob. del resultado excluido; DNB = favorito / (local + visitante)', () => {
    expect(byFam.get('dc')!.prob).toBeCloseTo(1 - p.away, 10); // 1X, la más probable
    expect(byFam.get('dc')!.selection).toContain('1X');
    const c12 = confidenceCandidates({ homeName: 'A', awayName: 'B', p: { home: 0.45, draw: 0.08, away: 0.47 }, matrix }, { minProb: 0, maxProb: 1 });
    expect(c12.find((c) => c.family === 'dc')!.prob).toBeCloseTo(1 - 0.08, 10);
    const cx2 = confidenceCandidates({ homeName: 'A', awayName: 'B', p: { home: 0.1, draw: 0.3, away: 0.6 }, matrix }, { minProb: 0, maxProb: 1 });
    expect(cx2.find((c) => c.family === 'dc')!.prob).toBeCloseTo(1 - 0.1, 10);
    expect(cx2.find((c) => c.family === 'dc')!.selection).toContain('X2');
    expect(byFam.get('dnb')!.prob).toBeCloseTo(0.6 / 0.75, 10);
  });

  it('goles, ambos marcan, hándicap +1.5 y estadísticas coherentes con sus distribuciones', () => {
    const total = totalGoalsDist(matrix);
    expect(byFam.get('ou-1.5-over')!.prob).toBeCloseTo(1 - total[0] - total[1], 10);
    expect(byFam.get('ou-4.5-under')!.prob).toBeCloseTo(total.slice(0, 5).reduce((s, x) => s + x, 0), 10);
    expect(byFam.get('btts-yes')!.prob + byFam.get('btts-no')!.prob).toBeCloseTo(1, 10);
    // +1.5 del no favorito = 1 − P(el local gana por 2 o más)
    let homeBy2 = 0;
    matrix.forEach((row, i) => row.forEach((v, j) => (i - j >= 2 ? (homeBy2 += v) : 0)));
    const ah = byFam.get('ah+1.5')!;
    expect(ah.selection).toBe('Local FC +1.5'); // el local +1.5 es más probable que el visitante +1.5
    const awayPlus = confidenceCandidates({ homeName: 'Local FC', awayName: 'Visitante CF', p, matrix }, { minProb: 0, maxProb: 0.95 }).find((c) => c.family === 'ah+1.5')!;
    expect(awayPlus.selection).toBe('Visitante CF +1.5');
    expect(awayPlus.prob).toBeCloseTo(1 - homeBy2, 10);
    const corners = overUnderFromDist(projections[0].totalDist, 6.5);
    expect(byFam.get('corners-over-6.5')!.prob).toBeCloseTo(corners.over, 10);
    const cards = overUnderFromDist(projections[1].totalDist, 6.5);
    expect(byFam.get('cards-under-6.5')!.prob).toBeCloseTo(cards.under, 10);
  });

  it('por defecto descarta las triviales (> 0.93) y las de menos del 50 %', () => {
    const def = confidenceCandidates({ homeName: 'A', awayName: 'B', p, matrix, projections });
    expect(def.length).toBeGreaterThan(5);
    for (const c of def) {
      expect(c.prob).toBeGreaterThanOrEqual(0.5);
      expect(c.prob).toBeLessThanOrEqual(0.93);
      expect(c.fairOdds).toBeGreaterThanOrEqual(1 / 0.93 - 1e-9);
    }
  });

  it('cuotas: directas (1X2, línea de goles, hándicap de la casa) y sintéticas realizables (DC y DNB)', () => {
    const cs = confidenceCandidates({ homeName: 'A', awayName: 'B', p, matrix, odds: ODDS }, { minProb: 0, maxProb: 1 });
    const f = (id: ConfidenceFamily) => cs.find((c) => c.family === id)!;
    expect(f('1x2-fav').marketOdds).toBe(1.6);
    expect(f('dc').marketOdds).toBeCloseTo(syntheticDoubleOdds(1.6, 4.0), 3);
    expect(f('dc').oddsKind).toBe('sintetica');
    expect(f('dnb').marketOdds).toBeCloseTo(syntheticDnbOdds(1.6, 4.0), 3);
    // reparto: 1 − 1/4 al local y 1/4 al empate ⇒ el empate devuelve 1 y la victoria paga la cuota DNB
    expect((1 / 4) * 4.0).toBeCloseTo(1, 10);
    expect((1 - 1 / 4) * 1.6).toBeCloseTo(syntheticDnbOdds(1.6, 4.0), 10);
    // la casa da local −1.5 ⇒ visitante +1.5 = spreadAway
    const ahAway = confidenceCandidates({ homeName: 'A', awayName: 'B', p, matrix, odds: ODDS }, { minProb: 0, maxProb: 0.95 }).find((c) => c.family === 'ah+1.5')!;
    expect(ahAway.selection).toBe('B +1.5');
    expect(ahAway.marketOdds).toBe(1.55);
    expect(f('ou-1.5-over').marketOdds).toBeUndefined(); // la casa solo da la línea 2.5
    expect(cs.every((c) => c.segment === 'mercado')).toBe(true);
    // trío con margen imposible: sin cuotas y segmento estadístico
    const bad = confidenceCandidates({ homeName: 'A', awayName: 'B', p, matrix, odds: { provider: 'X', home: 1.2, draw: 1.3, away: 1.4 } }, { minProb: 0, maxProb: 1 });
    expect(bad.every((c) => c.marketOdds === undefined && c.segment === 'estadistico')).toBe(true);
  });

  it('historial insuficiente: sin mercado no hay resultado/goles; córners/tarjetas exigen partidos con el dato', () => {
    const base = { homeName: 'A', awayName: 'B', p, matrix, projections };
    const fams = (cs: ConfidenceCandidate[]) => new Set(cs.map((c) => c.theme));
    const low = confidenceCandidates({ ...base, minEloGames: 3, statGames: { corners: 10, cards: 2 } }, { minProb: 0, maxProb: 1 });
    expect(fams(low)).toEqual(new Set(['corners']));
    const lowWithMarket = confidenceCandidates({ ...base, odds: ODDS, minEloGames: 3, statGames: { corners: 10, cards: 10 } }, { minProb: 0, maxProb: 1 });
    expect(fams(lowWithMarket)).toEqual(new Set(['resultado', 'goles', 'corners', 'tarjetas']));
  });
});

describe('resolución', () => {
  const d = (hg: number, ag: number, extra: { corners?: number; cards?: number } = {}) => ({ hg, ag, ...extra });
  const c = (settle: ConfidenceCandidate['settle']) => ({ settle });
  it('1X2 / doble oportunidad / DNB / hándicap / totales / equipos / ambos marcan', () => {
    expect(settleCandidate(c({ kind: 'outcome', win: ['home', 'draw'] }), d(1, 1))).toBe('hit');
    expect(settleCandidate(c({ kind: 'outcome', win: ['home', 'draw'] }), d(0, 1))).toBe('miss');
    expect(settleCandidate(c({ kind: 'dnb', side: 'home' }), d(2, 2))).toBe('void');
    expect(settleCandidate(c({ kind: 'dnb', side: 'home' }), d(2, 1))).toBe('hit');
    expect(settleCandidate(c({ kind: 'handicap', side: 'away', line: 1.5 }), d(2, 1))).toBe('hit');
    expect(settleCandidate(c({ kind: 'handicap', side: 'away', line: 1.5 }), d(3, 1))).toBe('miss');
    expect(settleCandidate(c({ kind: 'total', stat: 'goals', side: 'under', line: 4.5 }), d(3, 1))).toBe('hit');
    expect(settleCandidate(c({ kind: 'total', stat: 'goals', side: 'under', line: 4.5 }), d(3, 2))).toBe('miss');
    expect(settleCandidate(c({ kind: 'team-total', team: 'away', side: 'over', line: 0.5 }), d(3, 0))).toBe('miss');
    expect(settleCandidate(c({ kind: 'btts', yes: false }), d(3, 0))).toBe('hit');
    expect(settleCandidate(c({ kind: 'total', stat: 'corners', side: 'over', line: 6.5 }), d(1, 0))).toBeUndefined();
    expect(settleCandidate(c({ kind: 'total', stat: 'corners', side: 'over', line: 6.5 }), d(1, 0, { corners: 7 }))).toBe('hit');
    expect(settleCandidate(c({ kind: 'total', stat: 'cards', side: 'under', line: 5.5 }), d(1, 0, { cards: 6 }))).toBe('miss');
  });
});

// ---------------------------------------------------------------------------
// Umbrales en datos sintéticos
// ---------------------------------------------------------------------------

function synthHistory(n: number, seed: number, opts: { shift?: number; family?: ConfidenceFamily; segment?: 'mercado' | 'estadistico'; from?: number } = {}): ConfidenceHistoryItem[] {
  const rng = mulberry32(seed);
  const family = opts.family ?? 'ou-4.5-under';
  const t0 = opts.from ?? Date.UTC(2026, 0, 1);
  const out: ConfidenceHistoryItem[] = [];
  for (let i = 0; i < n; i++) {
    const prob = 0.5 + 0.43 * rng();
    const hit = rng() < Math.max(0, prob - (opts.shift ?? 0));
    const c: SettledCandidate = {
      family,
      theme: CONFIDENCE_FAMILIES.find((f) => f.id === family)!.theme,
      marketId: 'x',
      market: 'x',
      selection: 'x',
      prob,
      fairOdds: 1 / prob,
      settle: { kind: 'btts', yes: true },
      segment: opts.segment ?? 'mercado',
      result: hit ? 'hit' : 'miss',
    };
    out.push({
      matchId: `m${seed}-${i}`,
      compId: 'liga',
      date: new Date(t0 + i * 3_600_000 * 6).toISOString(),
      home: 'A',
      away: 'B',
      score: { home: 1, away: 0 },
      candidates: [c],
    });
  }
  return out;
}

describe('elección de umbrales', () => {
  it('Wilson: intervalo correcto en casos conocidos', () => {
    const [lo, hi] = wilsonInterval(82, 100);
    expect(lo).toBeGreaterThan(0.74);
    expect(lo).toBeLessThan(0.82);
    expect(hi).toBeGreaterThan(0.82);
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
  });

  it('Platt sobre datos bien calibrados ≈ identidad', () => {
    const h = synthHistory(6000, 3);
    const f = fitPlatt(h.map((x) => ({ prob: x.candidates[0].prob, hit: x.candidates[0].result === 'hit' })))!;
    expect(Math.abs(f.a)).toBeLessThan(0.4);
    expect(f.b).toBeGreaterThan(0.7);
    expect(f.b).toBeLessThan(1.3);
    expect(plattProb(f, 0.8)).toBeCloseTo(0.8, 1);
  });

  it("método 'cola': umbral mínimo cuya cola acierta >= 0.82 (≈ 0.71 con p ~ U(0.5, 0.93) calibrada)", () => {
    const rules = confidenceRulesFrom(synthHistory(4000, 5), { method: 'cola', segmented: false });
    const r = rules.rules.find((x) => x.family === 'ou-4.5-under')!;
    expect(r).toBeDefined();
    expect(r.threshold).toBeGreaterThanOrEqual(0.64);
    expect(r.threshold).toBeLessThanOrEqual(0.77);
    expect(r.tail.hitRate).toBeGreaterThanOrEqual(0.82);
    expect(r.tail.n).toBeGreaterThanOrEqual(80);
    expect(r.tail.wilsonLow).toBeGreaterThanOrEqual(0.78);
  });

  it("método 'platt' (por defecto): el umbral es local (el pick marginal ya ronda 0.82) y las franjas son honestas", () => {
    const rules = confidenceRulesFrom(synthHistory(6000, 7), { segmented: false });
    const r = rules.rules.find((x) => x.family === 'ou-4.5-under')!;
    expect(r.threshold).toBeGreaterThanOrEqual(0.78);
    expect(r.threshold).toBeLessThanOrEqual(0.86);
    expect(r.tail.hitRate).toBeGreaterThanOrEqual(0.82);
    if (r.goldThreshold !== undefined) {
      expect(r.goldThreshold).toBeGreaterThanOrEqual(r.threshold);
      expect(r.oro!.hitRate).toBeGreaterThanOrEqual(0.85);
    }
    if (r.plata) expect(r.plata.hitRate).toBeGreaterThanOrEqual(0.8);
  });

  it('familia sobreconfiada o con poca muestra: se descarta con el motivo', () => {
    const over = confidenceRulesFrom(synthHistory(4000, 9, { shift: 0.15 }), { segmented: false });
    expect(over.rules).toHaveLength(0);
    expect(over.rejected.find((x) => x.family === 'ou-4.5-under')!.reason).toMatch(/ningún|ninguna/);
    const small = confidenceRulesFrom(synthHistory(60, 9), { segmented: false });
    expect(small.rules).toHaveLength(0);
    expect(small.rejected[0].reason).toMatch(/muestra insuficiente/);
  });

  it('reglas segmentadas: cada fuente se calibra con sus propios partidos', () => {
    const good = synthHistory(4000, 11, { segment: 'mercado' });
    const bad = synthHistory(4000, 12, { segment: 'estadistico', shift: 0.15 });
    const rules = confidenceRulesFrom([...good, ...bad]);
    expect(rules.rules.map((r) => `${r.family}|${r.segment}`)).toEqual(['ou-4.5-under|mercado']);
    expect(rules.rejected.some((r) => r.segment === 'estadistico')).toBe(true);
  });
});

describe('selección por partido', () => {
  const rules: ConfidenceRules = confidenceRulesFrom(
    (['dc', 'dnb', 'ou-4.5-under', 'team-under-2.5', 'cards-over-1.5'] as ConfidenceFamily[]).flatMap((f, k) => synthHistory(3000, 20 + k, { family: f })),
  );
  it('como mucho 2 picks, de temas distintos (nunca 1X y DNB del mismo partido) y con nivel/acierto histórico', () => {
    const mk = (family: ConfidenceFamily, prob: number): ConfidenceCandidate => ({
      family,
      theme: CONFIDENCE_FAMILIES.find((f) => f.id === family)!.theme,
      marketId: family,
      market: family,
      selection: family,
      prob,
      fairOdds: 1 / prob,
      settle: { kind: 'btts', yes: true },
      segment: 'mercado',
    });
    const picks = selectConfidencePicks([mk('dc', 0.92), mk('dnb', 0.92), mk('ou-4.5-under', 0.9), mk('team-under-2.5', 0.91), mk('cards-over-1.5', 0.9)], rules);
    expect(picks.length).toBe(2);
    expect(new Set(picks.map((p) => p.theme)).size).toBe(2);
    expect(picks.filter((p) => p.family === 'dc' || p.family === 'dnb').length).toBeLessThanOrEqual(1);
    for (const p of picks) {
      expect(['oro', 'plata']).toContain(p.tier);
      expect(p.historicalHitRate).toBeGreaterThanOrEqual(0.8);
      expect(p.historicalN).toBeGreaterThan(0);
      if (p.tier === 'oro') expect(p.historicalHitRate).toBeGreaterThanOrEqual(0.85);
    }
    // por debajo del umbral no sale nada
    expect(selectConfidencePicks([mk('dc', 0.55)], rules)).toHaveLength(0);
    expect(selectConfidencePicks([mk('dc', 0.92)], rules, { maxPerMatch: 1 })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sin fuga: walk-forward y separación calibración/holdout
// ---------------------------------------------------------------------------

const LIGA: CompetitionConfig = { id: 'liga-a', slug: 'syn.1', name: 'Liga A', shortName: 'Liga A', country: 'Sintetia', flag: '🏳️', kind: 'league', tier: 8 };

/** Liga de 12 equipos, una jornada por semana desde 2025-01 hasta 2026-10 (temporada actual desde 2026-08-01). */
function leagueWorld(seed = 3): CompetitionStore {
  const rng = mulberry32(seed);
  const teams = Array.from({ length: 12 }, (_, i) => ({ id: `T${i}`, name: `Equipo ${i}`, short: `Eq${i}`, abbr: `E${i}`, att: 1.45 - 0.07 * i, def: 0.7 + 0.06 * i }));
  const matches: MatchRecord[] = [];
  let id = 5000;
  const start = Date.UTC(2025, 0, 4, 15);
  const end = Date.UTC(2026, 9, 25);
  for (let w = 0, t = start; t < end; w++, t += 7 * DAY) {
    const order = teams.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let k = 0; k < 6; k++) {
      const h = order[2 * k];
      const a = order[2 * k + 1];
      const hg = samplePoisson(1.2 * h.att * a.def * 1.2, rng);
      const ag = samplePoisson(1.2 * a.att * h.def, rng);
      const date = t + k * 3_600_000;
      matches.push({
        id: String(id++),
        compId: LIGA.id,
        season: new Date(date).getUTCFullYear(),
        currentSeason: date >= Date.UTC(2026, 7, 1),
        date: new Date(date).toISOString(),
        status: 'finished',
        home: { id: h.id, name: h.name, short: h.short, abbr: h.abbr },
        away: { id: a.id, name: a.name, short: a.short, abbr: a.abbr },
        score: { home: hg, away: ag },
        stats: {
          home: { goals: hg, corners: sampleNegBin(5.4, 12, rng), yellow: samplePoisson(1.9, rng), red: 0 },
          away: { goals: ag, corners: sampleNegBin(4.4, 12, rng), yellow: samplePoisson(2.2, rng), red: 0 },
        },
      });
    }
  }
  return { compId: LIGA.id, slug: LIGA.slug, updatedAt: '2026-11-01T00:00:00Z', matches, players: [], standings: [] };
}

describe('walk-forward sin fuga', () => {
  const store = leagueWorld();
  const now = new Date('2026-11-01T00:00:00Z');
  const current = store.matches.filter((m) => m.currentSeason);
  const target = current[Math.floor(current.length / 2)];
  // partido "del futuro" (después del objetivo) entre los mismos equipos con un resultado y estadísticas extremos
  const future: MatchRecord = {
    ...target,
    id: '999999',
    date: new Date(Date.parse(target.date) + 10 * DAY).toISOString(),
    score: { home: 0, away: 9 },
    stats: { home: { goals: 0, corners: 30, yellow: 9, red: 2 }, away: { goals: 9, corners: 25, yellow: 8, red: 1 } },
  };
  const ctxA = createContext({ stores: [store], configs: [LIGA], now });
  computeWalkForward(ctxA);
  const ctxB = createContext({ stores: [{ ...store, matches: [...store.matches, future] }], configs: [LIGA], now });
  computeWalkForward(ctxB);

  it('los candidatos de un partido jugado no cambian si se añade un partido posterior', () => {
    const a = walkForwardCandidates(ctxA, target);
    const b = walkForwardCandidates(ctxB, target);
    expect(a).toBeDefined();
    expect(a!.length).toBeGreaterThan(5);
    expect(b).toEqual(a);
  });

  it('control: con los modelos ACTUALES (con fuga) el partido futuro sí cambiaría la predicción', () => {
    const pa = predictMatch(target, baseContext(ctxA, LIGA));
    const pb = predictMatch(target, baseContext(ctxB, LIGA));
    expect(Math.abs(pa.lambdaAway - pb.lambdaAway)).toBeGreaterThan(1e-4);
  });

  it('el historial resuelve con el resultado real y no incluye partidos sin predicción sin fuga', () => {
    const h = confidenceHistory(ctxA);
    expect(h.length).toBe(current.length);
    const item = h.find((x) => x.matchId === target.id)!;
    expect(item.score).toEqual(target.score);
    for (const c of item.candidates) expect(settleCandidate(c, { hg: target.score!.home, ag: target.score!.away, corners: item.corners, cards: item.cards })).toBe(c.result);
  });

  it('partidos próximos: upcomingCandidates usa la predicción publicada y marca la fuente', () => {
    const date = '2026-11-03T18:00:00Z';
    const h = target.home;
    const a = target.away;
    const sched = (id: string, odds?: OddsSnapshot): MatchRecord => ({ id, compId: LIGA.id, season: 2026, currentSeason: true, date, status: 'scheduled', home: h, away: a, odds });
    const ctx = createContext({
      stores: [{ ...store, matches: [...store.matches, sched('700001'), sched('700002', { provider: 'Test', home: 2.0, draw: 3.5, away: 3.9 })] }],
      configs: [LIGA],
      now,
    });
    computeWalkForward(ctx);
    const noOdds = upcomingCandidates(ctx, ctx.matchById.get('700001')!);
    const withOdds = upcomingCandidates(ctx, ctx.matchById.get('700002')!);
    expect(noOdds.length).toBeGreaterThan(3);
    expect(noOdds.every((c) => c.segment === 'estadistico' && c.marketOdds === undefined)).toBe(true);
    expect(withOdds.every((c) => c.segment === 'mercado')).toBe(true);
    expect(withOdds.some((c) => c.marketOdds !== undefined)).toBe(true);
    for (const c of [...noOdds, ...withOdds]) {
      expect(c.prob).toBeGreaterThanOrEqual(0.5);
      expect(c.prob).toBeLessThanOrEqual(0.93);
    }
  });

  it('las reglas de calibración no dependen de los resultados del holdout', () => {
    // historia sintética amplia (la liga sintética es pequeña para las muestras mínimas)
    const hist = (['ou-4.5-under', 'team-under-2.5', 'cards-over-1.5'] as ConfidenceFamily[])
      .flatMap((f, k) => synthHistory(2500, 40 + k, { family: f }))
      .map((x, i) => ({ ...x, matchId: `h${i}` }))
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.matchId.localeCompare(b.matchId));
    const e1 = evaluateConfidence(ctxA, { history: hist });
    const cut = Date.parse(e1.split.cutoff);
    const flipped = hist.map((x) =>
      Date.parse(x.date) >= cut ? { ...x, candidates: x.candidates.map((c) => ({ ...c, result: c.result === 'hit' ? ('miss' as const) : ('hit' as const) })) } : x,
    );
    const e2 = evaluateConfidence(ctxA, { history: flipped });
    expect(e2.calibrationRules).toEqual(e1.calibrationRules);
    expect(e2.calibrationChoice).toEqual(e1.calibrationChoice);
    expect(e1.holdout.picks).toBeGreaterThan(50);
    expect(e2.holdout.picks).toBe(e1.holdout.picks);
    expect(e2.holdout.hitRate).toBeCloseTo(1 - e1.holdout.hitRate, 10);
    // las reglas de producción sí usan todo el historial
    expect(e2.rules).not.toEqual(e1.rules);
    expect(e1.split.holdout.matches + e1.split.calibration.matches).toBe(hist.length);
    expect(e1.split.calibration.to < e1.split.cutoff).toBe(true);
  });
});
