import { describe, expect, it } from 'vitest';
import type { Market, Prob1X2 } from '../../src/types/data';
import { MODEL } from '../../pipeline/config';
import {
  buildElo,
  buildModelSuite,
  computeHomeLeague,
  eloGoalModel,
  finishedMatches,
  fitLeagueModels,
  initialElo,
  kMultiplierFor,
  leagueAverageGoals,
  DEFAULT_ELO_GOAL,
  ELO_BURN_IN_DAYS,
  PROMOTED_TIER_PENALTY,
  eloGoalTotalFactor,
} from '../../pipeline/analytics/ratings';
import {
  contextFor,
  defaultWeights,
  jsDivergence,
  over25FromLine,
  predictMatch,
  predictProbsOnly,
  type PredictContext,
} from '../../pipeline/analytics/predict';
import {
  buildStatContext,
  dispersionFromProjection,
  expectedPair,
  projectMatchStats,
  statMarkets,
} from '../../pipeline/analytics/projections';
import { findValueBets, MAX_EV, MAX_PICKS_PER_MATCH, pickConfidence } from '../../pipeline/analytics/value';
import { SYN_CONFIG_MAP, SYN_CONFIGS, TEAMS_A, TEAMS_B, TEAMS_LOW, scheduled, syntheticWorld } from './synthetic';

const world = syntheticWorld(11);
const suite = buildModelSuite(world.stores, SYN_CONFIGS, world.refDate);
const ctxA: PredictContext = contextFor(suite, SYN_CONFIG_MAP.get('liga-a')!, SYN_CONFIG_MAP);
const ctxEuro: PredictContext = contextFor(suite, SYN_CONFIG_MAP.get('euro')!, SYN_CONFIG_MAP);
const future = new Date(Date.parse(world.refDate) + 2 * 86_400_000).toISOString();

const sum3 = (p: Prob1X2) => p.home + p.draw + p.away;
const matrixSum = (m: number[][]) => m.reduce((s, r) => s + r.reduce((t, v) => t + v, 0), 0);

describe('ratings: Elo global', () => {
  const eb = suite.eloBuild;

  it('ordena a los equipos según su fuerza real', () => {
    const r = (id: string) => eb.elo.get(id);
    expect(r('A0')).toBeGreaterThan(r('A5'));
    expect(r('A5')).toBeGreaterThan(r('A9'));
    expect(r('B0')).toBeGreaterThan(r('B7'));
    // la liga A (tier 8) está por encima de la B (tier 5) en media
    const avg = (ids: string[]) => ids.reduce((s, id) => s + r(id), 0) / ids.length;
    expect(avg(TEAMS_A.map((t) => t.ref.id))).toBeGreaterThan(avg(TEAMS_B.map((t) => t.ref.id)));
  });

  it('registra el rating pre-partido de cada partido terminado (sin duplicados)', () => {
    const fin = finishedMatches(world.stores);
    expect(eb.preMatch.size).toBe(fin.length);
    // un mismo partido en dos stores cuenta una sola vez
    const dup = { ...world.stores[0], compId: 'copa', matches: [world.stores[0].matches[0]] };
    const eb2 = buildElo([...world.stores, dup], SYN_CONFIGS);
    expect(eb2.preMatch.size).toBe(fin.length);
    expect(eb2.samples.length).toBe(fin.length);
  });

  it('rating inicial por tier de la liga doméstica y kMultiplier por tipo', () => {
    const first = finishedMatches(world.stores).find((m) => m.compId === 'liga-a')!;
    const pre = eb.preMatch.get(first.id)!;
    expect(pre.home).toBeCloseTo(MODEL.eloInit + (8 - 5) * MODEL.eloTierOffset, 6);
    expect(initialElo('B3', eb.homeLeague, SYN_CONFIG_MAP)).toBe(MODEL.eloInit);
    // equipo solo de copa (categoría inferior no cubierta): tier de respaldo MODEL.cupOnlyTier, o el de la copa
    expect(initialElo('L0', eb.homeLeague, SYN_CONFIG_MAP, SYN_CONFIG_MAP.get('copa'))).toBe(MODEL.eloInit + (MODEL.cupOnlyTier - 5) * MODEL.eloTierOffset);
    expect(MODEL.cupOnlyTier).toBeLessThanOrEqual(2);
    const copa = { ...SYN_CONFIG_MAP.get('copa')!, cupOnlyTier: 1 };
    expect(initialElo('L0', eb.homeLeague, SYN_CONFIG_MAP, copa)).toBe(MODEL.eloInit - 4 * MODEL.eloTierOffset);
    expect(kMultiplierFor('league')).toBe(1);
    expect(kMultiplierFor('continental')).toBe(1.2);
    expect(kMultiplierFor('cup')).toBe(0.9);
  });

  it('homeLeague = liga con más partidos; equipos de copa sin liga', () => {
    const hl = computeHomeLeague(world.stores, SYN_CONFIGS);
    expect(hl.get('A3')).toBe('liga-a');
    expect(hl.get('B2')).toBe('liga-b');
    expect(hl.has('L1')).toBe(false);
    expect(eb.homeLeague.get('A0')).toBe('liga-a');
  });

  it('equipo que aparece en una liga con historial (ascendido) arranca por debajo', () => {
    const liga = world.stores.find((s) => s.compId === 'liga-a')!;
    const start = Date.parse(liga.matches[0].date);
    const late = new Date(start + (ELO_BURN_IN_DAYS + 30) * 86_400_000).toISOString();
    const newcomer = { id: 'N1', name: 'Recién Ascendido', short: 'Ascendido', abbr: 'ASC' };
    const extra = { ...scheduled('liga-a', late, newcomer, TEAMS_A[5].ref, { id: 'P1' }), status: 'finished' as const, score: { home: 1, away: 1 } };
    const eb = buildElo([{ ...liga, matches: [...liga.matches, extra] }], SYN_CONFIGS);
    const base = MODEL.eloInit + (8 - 5) * MODEL.eloTierOffset;
    expect(eb.preMatch.get('P1')!.home).toBeCloseTo(base - PROMOTED_TIER_PENALTY * MODEL.eloTierOffset, 6);
  });

  it('calibra parámetros de empate plausibles', () => {
    expect(eb.drawParams.drawBase).toBeGreaterThan(0.05);
    expect(eb.drawParams.drawBase).toBeLessThan(0.5);
    expect(eb.drawParams.drawScale).toBeGreaterThan(99);
    expect(eb.samples.some((s) => !s.calibrated)).toBe(true);
  });

  it('respeta la fecha de corte (before)', () => {
    const cut = finishedMatches(world.stores)[100].date;
    const eb3 = buildElo(world.stores, SYN_CONFIGS, { before: cut });
    expect(eb3.preMatch.size).toBe(100);
  });
});

describe('ratings: Dixon-Coles por liga y Elo→goles', () => {
  it('ajusta solo ligas con >= 50 partidos en la ventana', () => {
    expect(suite.dcModels.has('liga-a')).toBe(true);
    expect(suite.dcModels.has('liga-b')).toBe(true);
    expect(suite.dcModels.has('euro')).toBe(false);
    expect(suite.dcModels.has('copa')).toBe(false);
    const dcA = suite.dcModels.get('liga-a')!;
    expect(dcA.attack.A0).toBeGreaterThan(dcA.attack.A9);
    expect(dcA.defence.A0).toBeLessThan(dcA.defence.A9);
    // con una fecha de referencia muy temprana no hay datos suficientes
    const early = finishedMatches(world.stores)[20].date;
    expect(fitLeagueModels(world.stores, SYN_CONFIGS, early).size).toBe(0);
  });

  it('medias de goles por competición', () => {
    const avg = leagueAverageGoals(world.stores, world.refDate);
    const a = avg.get('liga-a')!;
    expect(a).toBeGreaterThan(1.8);
    expect(a).toBeLessThan(4);
    expect(suite.leagueAvgGoals.get('liga-a')).toBeCloseTo(a, 9);
  });

  it('modelo Elo→goles: coeficientes y λ coherentes', () => {
    expect(suite.eloGoal.a).toBeGreaterThan(0.1);
    expect(suite.eloGoal.a).toBeLessThan(1);
    expect(suite.eloGoal.c).toBeGreaterThanOrEqual(0);
    expect(suite.eloGoal.n).toBeGreaterThan(100);
    const even = eloGoalModel(0, 2.6, DEFAULT_ELO_GOAL);
    expect(even.lambdaHome).toBeCloseTo(1.3, 9);
    expect(even.lambdaAway).toBeCloseTo(1.3, 9);
    const fav = eloGoalModel(200, 2.6, suite.eloGoal);
    expect(fav.lambdaHome).toBeGreaterThan(fav.lambdaAway);
    expect(fav.lambdaHome - fav.lambdaAway).toBeCloseTo(suite.eloGoal.a * 2, 6);
    const huge = eloGoalModel(2000, 2.6, { ...DEFAULT_ELO_GOAL, c: 0 });
    expect(huge.lambdaAway).toBe(0.15);
    // factor de goles por competición (solo cruces entre ligas), acotado
    const f = eloGoalTotalFactor(suite.eloGoal, 'euro');
    expect(f).toBeGreaterThanOrEqual(0.77);
    expect(f).toBeLessThanOrEqual(1.3);
    expect(eloGoalTotalFactor(suite.eloGoal, 'liga-a')).toBe(1);
  });

  it('traduce la línea de goles de la casa a P(más de 2.5)', () => {
    expect(over25FromLine(2.5, 0.55)).toBeCloseTo(0.55, 4);
    const fromHigh = over25FromLine(3.5, 0.35);
    expect(fromHigh).toBeGreaterThan(0.35);
    expect(fromHigh).toBeLessThan(0.75);
    expect(over25FromLine(1.5, 0.75)).toBeLessThan(0.75);
  });
});

describe('predict', () => {
  const strong = TEAMS_A[0].ref;
  const weak = TEAMS_A[9].ref;

  it('favorito claro en casa ⇒ pHome alta; probabilidades coherentes', () => {
    const res = predictMatch(scheduled('liga-a', future, strong, weak, { homeForm: 'WWWDW', awayForm: 'LLDLL' }), ctxA);
    const q = res.quick;
    expect(q.p.home).toBeGreaterThan(0.6);
    expect(q.p.home).toBeGreaterThan(q.p.away * 3);
    expect(sum3(q.p)).toBeCloseTo(1, 3);
    expect(sum3(res.model.ensemble)).toBeCloseTo(1, 3);
    expect(sum3(res.model.elo.probs)).toBeCloseTo(1, 3);
    expect(res.model.dixonColes).toBeDefined();
    expect(sum3(res.model.dixonColes!.probs)).toBeCloseTo(1, 3);
    expect(res.model.weights.dixonColes + res.model.weights.elo + res.model.weights.market).toBeCloseTo(1, 2);
    expect(res.model.weights.market).toBe(0);
    expect(res.lambdaHome).toBeGreaterThan(res.lambdaAway);
    expect(q.xgHome).toBeGreaterThan(q.xgAway);
    expect(matrixSum(res.matrix)).toBeCloseTo(1, 9);
    expect(res.matrix.length).toBe(11);
    expect(res.model.scoreMatrix.length).toBe(MODEL.maxGoals + 1);
    expect(res.model.scoreMatrix[0].length).toBe(MODEL.maxGoals + 1);
    // matriz publicada = recorte 0..maxGoals de la completa (sin renormalizar)
    expect(matrixSum(res.model.scoreMatrix)).toBeGreaterThan(0.9);
    expect(matrixSum(res.model.scoreMatrix)).toBeLessThanOrEqual(1.0001);
    expect(res.model.scoreMatrix[1][0]).toBeCloseTo(res.matrix[1][0], 4);
    expect(q.over25).toBeGreaterThan(0);
    expect(q.over25).toBeLessThan(1);
    expect(q.btts).toBeGreaterThan(0);
    expect(q.btts).toBeLessThan(1);
    expect(q.likelyScore).toMatch(/^\d+-\d+$/);
    expect(q.confidence).toBeGreaterThanOrEqual(0);
    expect(q.confidence).toBeLessThanOrEqual(1);
    // el 1X2 de los mercados coincide con el ensamble
    const m1x2 = res.markets.find((m) => m.id === '1x2')!;
    expect(m1x2.selections[0].prob).toBeCloseTo(q.p.home, 3);
    expect(m1x2.selections.reduce((s, x) => s + x.prob, 0)).toBeCloseTo(1, 3);
    // λ finales reproducen razonablemente el ensamble
    const fromMatrix = res.matrix.reduce((s, row, i) => s + row.reduce((t, v, j) => t + (i > j ? v : 0), 0), 0);
    expect(Math.abs(fromMatrix - q.p.home)).toBeLessThan(0.03);
  });

  it('el favorito a domicilio también se detecta', () => {
    const res = predictMatch(scheduled('liga-a', future, weak, strong), ctxA);
    expect(res.quick.p.away).toBeGreaterThan(res.quick.p.home);
    expect(res.lambdaAway).toBeGreaterThan(res.lambdaHome);
  });

  it('sin cuotas ⇒ sin mercado, sin apuestas de valor ni pick', () => {
    const res = predictMatch(scheduled('liga-a', future, TEAMS_A[3].ref, TEAMS_A[4].ref), ctxA);
    expect(matrixSum(res.model.scoreMatrix)).toBeGreaterThan(0.99);
    expect(res.valueBets).toEqual([]);
    expect(res.quick.pick).toBeUndefined();
    expect(res.quick.market).toBeUndefined();
    expect(res.model.market).toBeUndefined();
    expect(res.markets.every((m) => m.selections.every((s) => s.marketOdds === undefined))).toBe(true);
  });

  it('con cuotas: mercado sin margen en el ensamble y apuestas de valor cuando la cuota está mal puesta', () => {
    // la casa infravalora al local unos 10 pp respecto al modelo (margen ~5%). Pesos fijos del test (no los de
    // MODEL, que se recalibran con el backtest): con el mercado al 30 % el modelo conserva ventaja sobre la cuota
    const fav = TEAMS_A[2].ref;
    const dog = TEAMS_A[7].ref;
    const ctxW: PredictContext = { ...ctxA, weights: { ...defaultWeights(), dixonColes: 0.5, elo: 0.2, market: 0.3, lowDataGames: 0 } };
    const p0 = predictMatch(scheduled('liga-a', future, fav, dog), ctxW).quick.p;
    const odds = {
      provider: 'TestBook',
      home: 0.95 / (p0.home - 0.1),
      draw: 0.95 / (p0.draw + 0.05),
      away: 0.95 / (p0.away + 0.05),
      totalLine: 2.5,
      over: 1.9,
      under: 1.95,
    };
    const res = predictMatch(scheduled('liga-a', future, fav, dog, { odds }), ctxW);
    expect(res.model.market).toBeDefined();
    expect(res.model.market!.method).toBe('shin');
    expect(sum3(res.model.market!.probs)).toBeCloseTo(1, 3);
    expect(res.model.weights.market).toBeGreaterThan(0);
    expect(res.quick.market).toBeDefined();
    // el ensamble queda entre el modelo y el mercado
    expect(res.quick.p.home).toBeLessThan(p0.home);
    expect(res.quick.p.home).toBeGreaterThan(res.model.market!.probs.home);
    expect(res.valueBets.length).toBeGreaterThan(0);
    expect(res.valueBets.length).toBeLessThanOrEqual(MAX_PICKS_PER_MATCH);
    for (const v of res.valueBets) {
      expect(v.ev).toBeGreaterThanOrEqual(MODEL.minEv);
      expect(v.ev).toBeLessThanOrEqual(MAX_EV);
      expect(v.prob).toBeGreaterThanOrEqual(MODEL.minProb);
      expect(v.odds).toBeLessThanOrEqual(MODEL.maxOdds);
      expect(v.kelly).toBeLessThanOrEqual(MODEL.kellyCap);
    }
    expect(res.valueBets.some((v) => v.marketId === '1x2')).toBe(true);
    expect(res.quick.pick).toEqual(res.valueBets[0]);
    expect(res.model.explanation.some((e) => e.includes('Mercado sin margen'))).toBe(true);
  });

  it('explicación en español con 4-7 viñetas concretas', () => {
    const res = predictMatch(scheduled('liga-a', future, strong, weak, { homeForm: 'WWDWW', awayForm: 'LDLLL' }), ctxA);
    const ex = res.model.explanation;
    expect(ex.length).toBeGreaterThanOrEqual(4);
    expect(ex.length).toBeLessThanOrEqual(7);
    expect(ex[0]).toContain('Elo');
    expect(ex.some((e) => e.includes('Forma reciente'))).toBe(true);
    expect(ex.some((e) => e.includes('Factor campo'))).toBe(true);
    expect(ex.some((e) => e.includes('Goles esperados'))).toBe(true);
    expect(ex.some((e) => /\d/.test(e))).toBe(true);
  });

  it('partido entre ligas distintas usa el modelo Elo→goles', () => {
    const res = predictMatch(scheduled('euro', future, TEAMS_A[0].ref, TEAMS_B[7].ref), ctxEuro);
    expect(res.model.dixonColes).toBeUndefined();
    expect(res.model.weights.dixonColes).toBe(0);
    expect(res.model.weights.elo + res.model.weights.market).toBeCloseTo(1, 2);
    expect(res.quick.p.home).toBeGreaterThan(0.55);
    expect(res.model.explanation.some((e) => e.includes('Elo→goles'))).toBe(true);
    expect(res.lambdaAway).toBeGreaterThanOrEqual(0.05);
    // sin Dixon-Coles no se publican apuestas de valor aunque haya cuotas "generosas"
    const odds = { provider: 'TestBook', home: 3, draw: 3.4, away: 2.5 };
    const withOdds = predictMatch(scheduled('euro', future, TEAMS_A[0].ref, TEAMS_B[7].ref, { odds }), ctxEuro);
    expect(withOdds.model.market).toBeDefined();
    expect(withOdds.valueBets).toEqual([]);
  });

  it('copa entre equipos de la misma liga usa su Dixon-Coles; campo neutral sin ventaja local', () => {
    const ctxCopa = contextFor(suite, SYN_CONFIG_MAP.get('copa')!, SYN_CONFIG_MAP);
    const res = predictMatch(scheduled('copa', future, TEAMS_A[4].ref, TEAMS_A[5].ref, { neutral: true }), ctxCopa);
    expect(res.model.dixonColes).toBeDefined();
    expect(res.model.explanation.some((e) => e.includes('Campo neutral'))).toBe(true);
    const home = predictMatch(scheduled('copa', future, TEAMS_A[4].ref, TEAMS_A[5].ref), ctxCopa);
    expect(home.quick.p.home).toBeGreaterThan(res.quick.p.home);
  });

  it('equipo desconocido: rating inicial y predicción válida', () => {
    const ghost = { id: 'X1', name: 'Fantasma', short: 'Fantasma', abbr: 'FAN' };
    const res = predictMatch(scheduled('copa', future, ghost, TEAMS_LOW[0].ref), contextFor(suite, SYN_CONFIG_MAP.get('copa')!, SYN_CONFIG_MAP));
    expect(sum3(res.quick.p)).toBeCloseTo(1, 3);
    expect(Number.isFinite(res.lambdaHome)).toBe(true);
  });

  it('predictProbsOnly coincide con predictMatch', () => {
    const odds = { provider: 'TestBook', home: 1.6, draw: 4, away: 5.5 };
    const m = scheduled('liga-a', future, TEAMS_A[1].ref, TEAMS_A[6].ref, { odds });
    const full = predictMatch(m, ctxA);
    const fast = predictProbsOnly(m, ctxA);
    expect(fast.p.home).toBeCloseTo(full.quick.p.home, 3);
    expect(fast.p.draw).toBeCloseTo(full.quick.p.draw, 3);
    expect(fast.over25).toBeCloseTo(full.quick.over25, 3);
    expect(fast.btts).toBeCloseTo(full.quick.btts, 3);
    expect(fast.sources.dc).toBeDefined();
    expect(fast.sources.market).toBeDefined();
    expect(sum3(fast.sources.elo)).toBeCloseTo(1, 6);
  });

  it('partidos ya jugados usan el Elo pre-partido', () => {
    const fin = finishedMatches(world.stores).filter((m) => m.compId === 'liga-a');
    const m = fin[fin.length - 1];
    const res = predictMatch(m, ctxA);
    const pre = suite.eloBuild.preMatch.get(m.id)!;
    expect(res.model.elo.home).toBe(Math.round(pre.home));
    expect(res.model.elo.away).toBe(Math.round(pre.away));
  });

  it('divergencia JS: 0 con fuentes iguales, positiva con fuentes distintas', () => {
    const p = { home: 0.5, draw: 0.3, away: 0.2 };
    expect(jsDivergence([{ probs: p, weight: 1 }, { probs: p, weight: 1 }])).toBeCloseTo(0, 12);
    expect(jsDivergence([{ probs: p, weight: 1 }, { probs: { home: 0.2, draw: 0.3, away: 0.5 }, weight: 1 }])).toBeGreaterThan(0.01);
  });
});

describe('projections', () => {
  const ligaA = world.stores.find((s) => s.compId === 'liga-a')!.matches;
  const statCtx = buildStatContext(ligaA, 'liga-a');

  it('medias de liga razonables y dispersión NB estimada', () => {
    const L = statCtx.league.corners;
    const fin = ligaA.filter((m) => m.stats);
    const sampleHome = fin.reduce((s, m) => s + (m.stats!.home.corners ?? 0), 0) / fin.length;
    // media contraída levemente hacia el valor por defecto
    expect(Math.abs(L.home - sampleHome)).toBeLessThan(0.3);
    expect(L.home).toBeGreaterThan(L.away);
    expect(statCtx.league.cards.home + statCtx.league.cards.away).toBeGreaterThan(3);
    expect(statCtx.league.cards.home + statCtx.league.cards.away).toBeLessThan(6);
    expect(statCtx.league.shots.home).toBeGreaterThan(10);
    expect(statCtx.dispersion.corners).toBeGreaterThan(1);
    expect(Number.isFinite(statCtx.dispersion.corners)).toBe(true);
  });

  it('equipos con perfil extremo se reflejan; equipos sin datos usan la media de liga', () => {
    const p = projectMatchStats('A1', 'A5', statCtx);
    const corners = p.find((x) => x.key === 'corners')!;
    expect(corners.home).toBeGreaterThan(statCtx.league.corners.home * 1.2);
    const cards = projectMatchStats('A5', 'A2', statCtx).find((x) => x.key === 'cards')!;
    expect(cards.away).toBeGreaterThan(statCtx.league.cards.away * 1.2);
    const none = projectMatchStats('Z1', 'Z2', statCtx);
    for (const pr of none) {
      const L = statCtx.league[pr.key];
      expect(pr.home).toBeCloseTo(L.home, 1);
      expect(pr.away).toBeCloseTo(L.away, 1);
      expect(pr.total).toBeCloseTo(pr.leagueAvg!, 1);
    }
    const e = expectedPair(statCtx, 'corners', 'Z1', 'Z2');
    expect(e.home).toBeCloseTo(statCtx.league.corners.home, 9);
  });

  it('distribuciones, líneas y quién tiene más son coherentes', () => {
    const proj = projectMatchStats('A0', 'A9', statCtx);
    expect(proj.map((p) => p.key).sort()).toEqual(['cards', 'corners', 'fouls', 'offsides', 'shots', 'shotsOnTarget']);
    for (const p of proj) {
      expect(p.totalDist.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 3);
      const mean = p.totalDist.reduce((s, x, k) => s + k * x, 0);
      expect(Math.abs(mean - p.total)).toBeLessThan(0.15);
      for (const l of p.lines) expect(l.over + l.under).toBeCloseTo(1, 3);
      // más líneas altas ⇒ menos probabilidad de "más de"
      for (let i = 1; i < p.lines.length; i++) expect(p.lines[i].over).toBeLessThanOrEqual(p.lines[i - 1].over);
      expect(sum3(p.most!)).toBeCloseTo(1, 3);
    }
    const corners = proj.find((p) => p.key === 'corners')!;
    expect(corners.lines.map((l) => l.line)).toEqual([7.5, 8.5, 9.5, 10.5, 11.5, 12.5]);
    expect(proj.find((p) => p.key === 'cards')!.lines.map((l) => l.line)).toEqual([2.5, 3.5, 4.5, 5.5, 6.5]);
    expect(proj.find((p) => p.key === 'shotsOnTarget')!.lines.map((l) => l.line)).toEqual([6.5, 7.5, 8.5, 9.5, 10.5]);
    expect(proj.find((p) => p.key === 'offsides')!.lines.map((l) => l.line)).toEqual([2.5, 3.5, 4.5, 5.5]);
    // la dispersión se recupera de la proyección publicada
    const r = dispersionFromProjection(corners);
    expect(r).toBeGreaterThan(statCtx.dispersion.corners * 0.7);
    expect(r).toBeLessThan(statCtx.dispersion.corners * 1.4);
  });

  it('mercados de estadísticas por grupos, con probabilidades que suman 1', () => {
    const proj = projectMatchStats('A1', 'A2', statCtx);
    const mk: Market[] = statMarkets(proj, 'Alfa 1', 'Alfa 2');
    const groups = new Set(mk.map((m) => m.group));
    for (const g of ['Córners', 'Tarjetas', 'Tiros', 'Faltas']) expect(groups.has(g as Market['group'])).toBe(true);
    expect(new Set(mk.map((m) => m.id)).size).toBe(mk.length);
    for (const m of mk) expect(m.selections.reduce((s, x) => s + x.prob, 0)).toBeCloseTo(1, 3);
    expect(mk.find((m) => m.id === 'corners-ou-9.5')).toBeDefined();
    expect(mk.find((m) => m.id === 'corners-most')!.selections).toHaveLength(3);
    const ahMinus = mk.find((m) => m.id === 'corners-ah-home--1.5')!;
    const ahPlus = mk.find((m) => m.id === 'corners-ah-home-1.5')!;
    expect(ahPlus.selections[0].prob).toBeGreaterThan(ahMinus.selections[0].prob);
    expect(mk.some((m) => m.id.startsWith('corners-home-ou-'))).toBe(true);
    expect(mk.some((m) => m.id.startsWith('cards-away-ou-'))).toBe(true);
  });

  it('predictMatch integra las proyecciones (mercados y expCorners/expCards)', () => {
    const proj = projectMatchStats('A1', 'A2', statCtx);
    const res = predictMatch(scheduled('liga-a', future, TEAMS_A[1].ref, TEAMS_A[2].ref), ctxA, { projections: proj });
    expect(res.quick.expCorners).toBeCloseTo(proj.find((p) => p.key === 'corners')!.total, 6);
    expect(res.quick.expCards).toBeDefined();
    expect(res.markets.some((m) => m.group === 'Córners')).toBe(true);
    expect(res.markets.some((m) => m.group === 'Goles')).toBe(true);
    expect(res.model.explanation.length).toBeLessThanOrEqual(7);
  });
});

describe('value', () => {
  const mk = (id: string, sels: { label: string; prob: number; odds?: number }[]): Market => ({
    id,
    group: 'Principales',
    name: id,
    selections: sels.map((s) => ({
      label: s.label,
      prob: s.prob,
      fairOdds: 1 / s.prob,
      ...(s.odds ? { marketOdds: s.odds, ev: s.prob * s.odds - 1 } : {}),
    })),
  });

  it('filtra por EV, probabilidad y cuota máxima', () => {
    const markets = [
      mk('a', [{ label: 'ok', prob: 0.5, odds: 2.3 }]), // EV 0.15
      mk('b', [{ label: 'ev bajo', prob: 0.5, odds: 2.05 }]), // EV 0.025
      mk('c', [{ label: 'prob baja', prob: 0.1, odds: 12 }]), // p < minProb
      mk('d', [{ label: 'cuota alta', prob: 0.13, odds: 9 }]), // cuota > maxOdds
      mk('e', [{ label: 'sin cuota', prob: 0.6 }]),
      mk('f', [{ label: 'ev increíble', prob: 0.5, odds: 3 }]), // EV 0.5 > MAX_EV
    ];
    const picks = findValueBets(markets, 0.7);
    expect(picks.map((p) => p.selection)).toEqual(['ok']);
    const p = picks[0];
    expect(p.ev).toBeCloseTo(0.15, 6);
    expect(p.edge).toBeCloseTo(0.5 - 1 / 2.3, 4);
    expect(p.fairOdds).toBeCloseTo(2, 6);
    expect(p.kelly).toBeGreaterThan(0);
    expect(p.kelly).toBeLessThanOrEqual(MODEL.kellyCap);
    expect(p.confidence).toBe('alta');
  });

  it('etiquetas de confianza', () => {
    expect(pickConfidence(0.12, 0.7)).toBe('alta');
    expect(pickConfidence(0.12, 0.5)).toBe('media');
    expect(pickConfidence(0.07, 0.9)).toBe('media');
    expect(pickConfidence(0.055, 0.9)).toBe('baja');
  });

  it('máximo 3 por partido, uno por mercado, ordenados por EV·confianza', () => {
    const markets = [
      mk('m1', [{ label: 'x', prob: 0.4, odds: 2.8 }, { label: 'y', prob: 0.6, odds: 1.9 }]),
      mk('m2', [{ label: 'z', prob: 0.5, odds: 2.2 }]),
      mk('m3', [{ label: 'w', prob: 0.3, odds: 3.6 }]),
      mk('m4', [{ label: 'v', prob: 0.55, odds: 2.0 }]),
    ];
    const picks = findValueBets(markets, 0.8);
    expect(picks.length).toBe(3);
    expect(new Set(picks.map((p) => p.marketId)).size).toBe(3);
    for (let i = 1; i < picks.length; i++) expect(picks[i - 1].ev).toBeGreaterThanOrEqual(picks[i].ev - 1e-9);
    expect(findValueBets([], 0.9)).toEqual([]);
    expect(findValueBets([mk('n', [{ label: 'n', prob: 0.5 }])], 0.9)).toEqual([]);
  });
});
