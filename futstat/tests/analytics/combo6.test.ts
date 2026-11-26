/**
 * «Combinada 6» (pipeline/analytics/combo6.ts): patas (regla validada, Platt, banda, cuota real / derivada / estimada),
 * regla del día (partidos distintos, categorías, tope por categoría, ventana de cuota), optimalidad frente a fuerza
 * bruta, combinadas por competición, récord y ausencia de fuga en el historial walk-forward (los resultados de los días
 * posteriores no cambian la combinada de un día).
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/lib/models';
import {
  DEFAULT_RULE_OPTIONS,
  FAMILY_BY_ID,
  walkForwardConfidence,
  type CandidateResult,
  type ConfidenceCandidate,
  type ConfidenceFamily,
  type ConfidenceHistoryItem,
  type ConfidenceRule,
  type ConfidenceRules,
  type ConfidenceSettle,
  type HitStats,
  type SettledCandidate,
} from '../../pipeline/analytics/confidence';
import { evaluateExtras } from '../../pipeline/analytics/daily';
import {
  DEFAULT_RULE,
  LEG_MAX_PROB,
  LEG_MIN_PROB,
  MARGIN_EST,
  MARGIN_TEAM_GOALS,
  categoryOf,
  combo6Record,
  combo6WalkForward,
  combo6Warning,
  comboResult,
  dayCombos,
  makeCombo,
  matchLegs,
  satisfiesRule,
  searchCombo6,
  toLeg,
  type Combo6EngineLeg,
  type Combo6Match,
  type Combo6Rule,
} from '../../pipeline/analytics/combo6';
import type { Combo6Category } from '../../src/types/data';

const STATS = (n: number, rate: number): HitStats => ({ n, hits: Math.round(n * rate), voids: 0, hitRate: rate, wilsonLow: rate - 0.04, wilsonHigh: rate + 0.03, avgProb: rate });

function rule(family: ConfidenceFamily, platt?: { a: number; b: number }): ConfidenceRule {
  const r: ConfidenceRule = { family, theme: FAMILY_BY_ID.get(family)!.theme, segment: 'mercado', threshold: 0.8, goldThreshold: 0.85, tail: STATS(300, 0.9), oro: STATS(300, 0.9), candidates: 1000 };
  if (platt) r.platt = { ...platt, n: 500 };
  return r;
}
const rulesOf = (rs: ConfidenceRule[]): ConfidenceRules => ({ from: '', to: '', matches: 0, options: { ...DEFAULT_RULE_OPTIONS }, rules: rs, rejected: [] });

function mk(family: ConfidenceFamily, prob: number, extra: Partial<ConfidenceCandidate> = {}): ConfidenceCandidate {
  const settle: ConfidenceSettle = extra.settle ?? { kind: 'total', stat: 'goals', side: 'under', line: 4.5 };
  return { family, theme: FAMILY_BY_ID.get(family)!.theme, marketId: family, market: family, selection: family, prob, fairOdds: 1 / prob, settle, segment: 'mercado', ...extra };
}

const M = (id: string, compId = 'liga', tier = 5, hour = 12): Combo6Match => ({ matchId: id, compId, date: new Date(Date.UTC(2026, 10, 27, hour)).toISOString(), tier });

/** Pata sintética con cuota dada (o estimada con el margen de su categoría). */
function leg(matchId: string, category: Combo6Category, prob: number, odds?: number, match: Partial<Combo6Match> & { hour?: number } = {}): Combo6EngineLeg {
  const book = odds ?? 1 / prob / (1 + MARGIN_EST[category]);
  const { hour, ...rest } = match;
  return {
    match: { ...M(matchId, 'liga', 5, hour ?? 12), ...rest },
    category,
    family: 'dc',
    marketId: `${category}-${matchId}`,
    market: category,
    selection: `${category} ${matchId}`,
    settle: { kind: 'outcome', win: ['home'] },
    segment: 'mercado',
    rawProb: prob,
    prob,
    fairOdds: 1 / prob,
    bookOdds: book,
    oddsSource: odds ? 'casa' : 'estimada',
    estimated: !odds,
  };
}

const EXACT: Combo6Rule = { ...DEFAULT_RULE, tolerance: 0, nodeLimit: Infinity, poolPerCategory: Infinity };

/** Fuerza bruta: todas las combinaciones de como mucho una pata por partido. */
function bruteForce(legs: Combo6EngineLeg[], rule: Combo6Rule = EXACT): Combo6EngineLeg[] | undefined {
  const byMatch = new Map<string, Combo6EngineLeg[]>();
  for (const l of legs) byMatch.set(l.match.matchId, [...(byMatch.get(l.match.matchId) ?? []), l]);
  const groups = [...byMatch.values()];
  let best: Combo6EngineLeg[] | undefined;
  let bestLn = -Infinity;
  const pick: Combo6EngineLeg[] = [];
  const rec = (i: number) => {
    if (i === groups.length) {
      if (!satisfiesRule(pick, rule)) return;
      const ln = pick.reduce((s, l) => s + Math.log(l.prob), 0);
      if (ln > bestLn + 1e-12) {
        bestLn = ln;
        best = pick.slice();
      }
      return;
    }
    rec(i + 1);
    if (pick.length >= rule.maxLegs) return;
    for (const l of groups[i]) {
      pick.push(l);
      rec(i + 1);
      pick.pop();
    }
  };
  rec(0);
  return best;
}

const CATS: Combo6Category[] = ['ganador', 'goles', 'corners', 'tiros-puerta', 'tiros', 'tarjetas', 'faltas'];

function randomDay(seed: number, matches: number, perMatch: number, realShare = 0.3): Combo6EngineLeg[] {
  const rng = mulberry32(seed);
  const out: Combo6EngineLeg[] = [];
  for (let i = 0; i < matches; i++) {
    const cats = CATS.slice().sort(() => rng() - 0.5).slice(0, perMatch);
    for (const c of cats) {
      const p = LEG_MIN_PROB + (LEG_MAX_PROB - LEG_MIN_PROB) * rng();
      // cuota «de la casa» con margen entre −3 % (el modelo ve valor) y +8 %
      const odds = rng() < realShare ? 1 / p / (1 + (-0.03 + 0.11 * rng())) : undefined;
      out.push(leg(`m${seed}-${i}`, c, Math.round(p * 1e4) / 1e4, odds, { hour: 10 + i, tier: 1 + Math.floor(rng() * 10) }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Patas
// ---------------------------------------------------------------------------

describe('patas: regla validada, Platt, banda y cuota', () => {
  const rules = rulesOf([rule('ou-4.5-under'), rule('dc'), rule('team-score'), rule('corners-over-7.5'), rule('sot-under-11.5', { a: -0.4, b: 1 }), rule('player-shot-1')]);
  const m = M('1');

  it('categorías: resultado → ganador; tiros a puerta y tiros por separado; sin categoría si la familia no encaja', () => {
    expect(categoryOf(mk('dc', 0.8))).toBe('ganador');
    expect(categoryOf(mk('ah+1.5', 0.8))).toBe('ganador');
    expect(categoryOf(mk('btts-no', 0.8))).toBe('goles');
    expect(categoryOf(mk('sot-team-over-2.5', 0.8))).toBe('tiros-puerta');
    expect(categoryOf(mk('shots-over-21.5', 0.8))).toBe('tiros');
    expect(categoryOf(mk('fouls-under-27.5', 0.8))).toBe('faltas');
    expect(categoryOf(mk('cards-under-5.5', 0.8))).toBe('tarjetas');
    expect(categoryOf(mk('player-goal', 0.8))).toBe('jugadores');
  });

  it('cuota de la casa (directa) ⇒ «casa», no estimada; sintética del 1X2 ⇒ «derivada», estimada', () => {
    const a = toLeg(mk('ou-4.5-under', 0.75, { marketOdds: 1.3, oddsKind: 'directa' }), rules, m)!;
    expect(a.oddsSource).toBe('casa');
    expect(a.estimated).toBe(false);
    expect(a.bookOdds).toBe(1.3);
    const b = toLeg(mk('dc', 0.8, { marketOdds: 1.2, oddsKind: 'sintetica', settle: { kind: 'outcome', win: ['home', 'draw'] } }), rules, m)!;
    expect(b.oddsSource).toBe('derivada');
    expect(b.estimated).toBe(true);
    expect(b.category).toBe('ganador');
  });

  it('sin precio ⇒ cuota estimada = justa / (1 + margen de su categoría), siempre marcada como estimada', () => {
    const g = toLeg(mk('ou-4.5-under', 0.75), rules, m)!;
    expect(g.oddsSource).toBe('estimada');
    expect(g.estimated).toBe(true);
    expect(g.bookOdds).toBeCloseTo(1 / 0.75 / (1 + MARGIN_EST.goles), 12);
    const c = toLeg(mk('corners-over-7.5', 0.8, { settle: { kind: 'total', stat: 'corners', side: 'over', line: 7.5 } }), rules, m)!;
    expect(c.bookOdds).toBeCloseTo(1 / 0.8 / (1 + MARGIN_EST.corners), 12);
    // goles de un equipo: margen propio
    const t = toLeg(mk('team-score', 0.78, { settle: { kind: 'team-total', team: 'home', side: 'over', line: 0.5 } }), rules, m)!;
    expect(t.bookOdds).toBeCloseTo(1 / 0.78 / (1 + MARGIN_TEAM_GOALS), 12);
    expect(t.bookOdds).toBeLessThan(t.fairOdds);
  });

  it('solo familias con regla validada; probabilidad recalibrada (Platt) dentro de la banda 0,70–0,88; jugadores fuera', () => {
    expect(toLeg(mk('btts-no', 0.8), rules, m)).toBeUndefined(); // sin regla
    expect(toLeg(mk('ou-4.5-under', 0.69), rules, m)).toBeUndefined();
    expect(toLeg(mk('ou-4.5-under', 0.89), rules, m)).toBeUndefined();
    expect(toLeg(mk('ou-4.5-under', 0.7), rules, m)).toBeDefined();
    expect(toLeg(mk('ou-4.5-under', 0.88), rules, m)).toBeDefined();
    // Platt q = σ(−0,4 + logit p): 0,85 → 0,79 (dentro) y 0,72 → 0,63 (fuera)
    const s = toLeg(mk('sot-under-11.5', 0.85), rules, m)!;
    expect(s.rawProb).toBe(0.85);
    expect(s.prob).toBeCloseTo(1 / (1 + Math.exp(0.4 - Math.log(0.85 / 0.15))), 10);
    expect(toLeg(mk('sot-under-11.5', 0.72), rules, m)).toBeUndefined();
    expect(toLeg(mk('player-shot-1', 0.8, { settle: { kind: 'player', playerId: 'p', stat: 'shots', min: 1 } }), rules, m)).toBeUndefined();
    expect(toLeg(mk('player-shot-1', 0.8, { settle: { kind: 'player', playerId: 'p', stat: 'shots', min: 1 } }), rules, m, { players: true })?.category).toBe('jugadores');
    // otra fuente (sin cuotas) sin regla propia: fuera
    expect(toLeg(mk('ou-4.5-under', 0.75, { segment: 'estadistico' }), rules, m)).toBeUndefined();
  });

  it('una pata por categoría y partido: la más eficiente (menor −ln p / ln cuota)', () => {
    const legs = matchLegs(
      [
        mk('ou-4.5-under', 0.86),
        mk('team-score', 0.72, { settle: { kind: 'team-total', team: 'away', side: 'over', line: 0.5 } }),
        mk('dc', 0.8, { marketOdds: 1.3, oddsKind: 'sintetica', settle: { kind: 'outcome', win: ['home', 'draw'] } }),
      ],
      rules,
      m,
    );
    expect(legs.map((l) => l.category)).toEqual(['ganador', 'goles']);
    // en goles, la de 0,72 (más cuota por la misma pérdida de probabilidad) gana a la de 0,86
    expect(legs[1].family).toBe('team-score');
  });
});

// ---------------------------------------------------------------------------
// Regla del día y optimalidad
// ---------------------------------------------------------------------------

describe('regla del día', () => {
  it('cumple la regla: partidos distintos, 4–9 patas, >= 4 categorías, <= 2 por categoría y cuota entre 6 y 8', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const legs = randomDay(seed, 30, 4);
      const s = searchCombo6(legs);
      expect(s.combo).toBeDefined();
      const c = s.combo!;
      expect(satisfiesRule(c.legs, DEFAULT_RULE)).toBe(true);
      expect(new Set(c.legs.map((l) => l.match.matchId)).size).toBe(c.legs.length);
      expect(c.legs.length).toBeGreaterThanOrEqual(4);
      expect(c.legs.length).toBeLessThanOrEqual(9);
      expect(c.categories).toBeGreaterThanOrEqual(4);
      const per = new Map<string, number>();
      for (const l of c.legs) per.set(l.category, (per.get(l.category) ?? 0) + 1);
      for (const n of per.values()) expect(n).toBeLessThanOrEqual(2);
      expect(c.bookOdds).toBeGreaterThanOrEqual(6 - 1e-9);
      expect(c.bookOdds).toBeLessThanOrEqual(8 + 1e-9);
      expect(c.prob).toBeCloseTo(c.legs.reduce((p, l) => p * l.prob, 1), 12);
      expect(c.fairOdds).toBeCloseTo(1 / c.prob, 9);
      expect(c.ev).toBeCloseTo(c.prob * c.bookOdds - 1, 12);
      expect(c.estimatedLegs).toBe(c.legs.filter((l) => l.estimated).length);
      // cronológica
      for (let i = 1; i < c.legs.length; i++) expect(Date.parse(c.legs[i].match.date)).toBeGreaterThanOrEqual(Date.parse(c.legs[i - 1].match.date));
    }
  });

  it('óptima: la búsqueda exacta coincide con la fuerza bruta (mismas patas) y la de producción queda a <= 0,1 %', () => {
    let compared = 0;
    for (let seed = 101; seed <= 160; seed++) {
      const legs = randomDay(seed, 9, 3, 0.4);
      const bf = bruteForce(legs);
      const ex = searchCombo6(legs, EXACT);
      expect(!!ex.combo).toBe(!!bf);
      if (!bf) continue;
      compared++;
      const key = (ls: Combo6EngineLeg[]) => ls.map((l) => l.marketId).sort().join('|');
      expect(ex.exact).toBe(true);
      expect(Math.log(ex.combo!.prob)).toBeCloseTo(bf.reduce((s, l) => s + Math.log(l.prob), 0), 10);
      expect(key(ex.combo!.legs)).toBe(key(bf));
      const prod = searchCombo6(legs);
      expect(Math.log(prod.combo!.prob)).toBeGreaterThanOrEqual(Math.log(ex.combo!.prob) - DEFAULT_RULE.tolerance - 1e-9);
    }
    expect(compared).toBeGreaterThan(30);
  });

  it('a igualdad de probabilidad, la de mayor prestigio y después la que empieza antes', () => {
    // 8 partidos idénticos salvo prestigio: la combinada usa los de mayor tier
    const mkDay = (tiers: number[]) =>
      tiers.map((tier, i) => leg(`t${i}`, CATS[i % 4], 0.72, 1.3, { tier, hour: 20 - i }));
    const legs = mkDay([3, 9, 4, 8, 5, 7, 6, 2]);
    const s = searchCombo6(legs, EXACT);
    expect(s.combo).toBeDefined();
    // 1,3^7 = 6,27 ∈ [6, 8]: 7 patas, sin la de tier 2
    expect(s.combo!.legs.length).toBe(7);
    expect(s.combo!.legs.map((l) => l.match.tier).sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });

  it('sin combinada posible: motivo en español (pocos partidos, pocas categorías o ninguna cuota en la ventana)', () => {
    expect(searchCombo6([]).reason).toMatch(/Ningún partido/);
    expect(searchCombo6(randomDay(5, 3, 4)).reason).toMatch(/Solo 3 partidos tienen alguna selección validada con probabilidad entre el 70 % y el 88 %; hacen falta al menos 4/);
    const oneCat = Array.from({ length: 10 }, (_, i) => leg(`c${i}`, 'goles', 0.72));
    expect(searchCombo6(oneCat).reason).toMatch(/de 1 categoría y hacen falta 4/);
    // cuotas muy bajas: ni con 9 patas se llega a 6
    const low = Array.from({ length: 12 }, (_, i) => leg(`l${i}`, CATS[i % 6], 0.88, 1.08));
    expect(searchCombo6(low).reason).toMatch(/Ninguna combinación de 4 a 9 patas/);
  });

  it('combinadas por competición continental con >= 5 partidos con patas', () => {
    const legs = [
      ...randomDay(7, 12, 4).map((l) => ({ ...l, match: { ...l.match, compId: 'europa' } })),
      ...randomDay(8, 4, 4).map((l) => ({ ...l, match: { ...l.match, compId: 'champions' } })),
      ...randomDay(9, 20, 4),
    ];
    const dc = dayCombos(legs);
    expect(dc.main.combo).toBeDefined();
    expect(dc.byCompetition.map((x) => x.compId)).toEqual(['europa']); // champions solo tiene 4
    const eu = dc.byCompetition[0].search.combo!;
    expect(eu.legs.every((l) => l.match.compId === 'europa')).toBe(true);
    expect(satisfiesRule(eu.legs)).toBe(true);
    // la principal es al menos tan probable como cualquiera restringida
    expect(dc.main.combo!.prob).toBeGreaterThanOrEqual(eu.prob * Math.exp(-DEFAULT_RULE.tolerance) - 1e-12);
  });

  it('resultado: pata fallada ⇒ fallada; nulas fuera (como las casas); todas nulas ⇒ nula; sin resolver ⇒ undefined', () => {
    expect(comboResult(['hit', 'miss', undefined])).toBe('miss');
    expect(comboResult(['hit', 'void', 'hit'])).toBe('hit');
    expect(comboResult(['void', 'void'])).toBe('void');
    expect(comboResult(['hit', undefined])).toBeUndefined();
    const c = makeCombo([{ ...leg('a', 'goles', 0.8), result: 'hit' }, { ...leg('b', 'corners', 0.8), result: 'void' }]);
    expect(c.result).toBe('hit');
  });

  it('récord: aciertos, Wilson, previsto, racha y acierto por categoría', () => {
    const mkC = (r: CandidateResult[], p = 0.8) => makeCombo(r.map((x, i) => ({ ...leg(`r${i}`, CATS[i % 4], p), result: x })));
    const combos = [mkC(['hit', 'miss']), mkC(['miss', 'hit']), mkC(['hit', 'hit']), mkC(['miss', 'miss']), mkC(['hit', 'miss']), mkC(['void', 'void'])];
    const r = combo6Record(combos, 10);
    expect(r).toMatchObject({ days: 10, combos: 6, settled: 5, hits: 1, voids: 1, longestLosingStreak: 2 });
    expect(r.hitRate).toBeCloseTo(0.2, 12);
    expect(r.expectedHitRate).toBeCloseTo(0.64, 12);
    expect(r.wilsonLow).toBeLessThanOrEqual(0.2);
    expect(r.wilsonHigh).toBeGreaterThanOrEqual(0.2);
    const g = r.byCategory.find((x) => x.category === 'ganador')!;
    expect(g).toMatchObject({ legs: 5, hits: 3, voids: 1 });
    expect(g.expectedHitRate).toBeCloseTo(0.8, 12);
    // aviso automático: muy por debajo de lo previsto con muestra suficiente
    expect(combo6Warning({ settled: 100, hits: 2, hitRate: 0.02, wilsonHigh: 0.05, expectedHitRate: 0.11 })).toMatch(/acertó 2 de 100/);
    expect(combo6Warning({ settled: 100, hits: 9, hitRate: 0.09, wilsonHigh: 0.14, expectedHitRate: 0.11 })).toBeUndefined();
    expect(combo6Warning({ settled: 10, hits: 0, hitRate: 0, wilsonHigh: 0.2, expectedHitRate: 0.11 })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Historial walk-forward sin fuga
// ---------------------------------------------------------------------------

const TOTAL: ConfidenceSettle = { kind: 'total', stat: 'goals', side: 'under', line: 4.5 };

/** Historial sintético calibrado (acierto = probabilidad): un candidato por familia y partido, uno cada 2 horas. */
function synthHistory(families: ConfidenceFamily[], n: number, seed: number): ConfidenceHistoryItem[] {
  const rng = mulberry32(seed);
  const t0 = Date.UTC(2026, 0, 1);
  const out: ConfidenceHistoryItem[] = [];
  for (let i = 0; i < n; i++) {
    const candidates: SettledCandidate[] = families.map((family) => {
      const prob = 0.55 + 0.38 * rng();
      return { ...mk(family, prob, { settle: TOTAL, marketId: `${family}-m`, selection: family }), result: rng() < prob ? 'hit' : 'miss' };
    });
    out.push({
      matchId: `m${String(i).padStart(5, '0')}`,
      compId: i % 3 === 0 ? 'europa' : 'liga',
      date: new Date(t0 + i * 2 * 3_600_000).toISOString(),
      home: 'A',
      away: 'B',
      score: { home: 1, away: 0 },
      candidates,
      base: Object.fromEntries(families.map((f) => [f, rng() < 0.8 ? 'hit' : 'miss'])),
    });
  }
  return out;
}

describe('historial walk-forward de la combinada', () => {
  const N = 3000;
  const baseFams: ConfidenceFamily[] = ['dc', 'ou-4.5-under', 'corners-over-7.5', 'cards-under-5.5'];
  const extraFams: ConfidenceFamily[] = ['sot-under-11.5', 'shots-over-21.5', 'fouls-under-27.5'];
  const baseHist = synthHistory(baseFams, N, 31);
  const extraHist = synthHistory(extraFams, N, 32);
  const run = (b: ConfidenceHistoryItem[], e: ConfidenceHistoryItem[]) => {
    const base = walkForwardConfidence(b, { select: { maxPerMatch: 2 } });
    const extra = evaluateExtras(e);
    return combo6WalkForward(base, extra.wf, { timeZone: 'Europe/Madrid', from: '2026-03-01', to: '2026-08-01', tierOf: (id) => (id === 'europa' ? 8 : 5) });
  };
  const wf = run(baseHist, extraHist);

  it('días en [from, to), combinadas que cumplen la regla y récord coherente', () => {
    expect(wf.days.length).toBeGreaterThan(50);
    for (const d of wf.days) {
      expect(d.date >= '2026-03-01' && d.date < '2026-08-01').toBe(true);
      if (d.search.combo) expect(satisfiesRule(d.search.combo.legs)).toBe(true);
    }
    const r = wf.record;
    expect(r.combos).toBeGreaterThan(30);
    expect(r.settled + r.voids).toBe(r.combos);
    expect(r.hits).toBeLessThanOrEqual(r.settled);
    // un modelo calibrado: acierto cerca de lo previsto (muestra pequeña: margen amplio)
    expect(r.wilsonHigh).toBeGreaterThan(r.expectedHitRate * 0.5);
    expect(r.byCategory.length).toBeGreaterThanOrEqual(4);
    // patas de todos los partidos de los tramos (también fuera de [from, to))
    expect(wf.legsByMatch.size).toBeGreaterThan(wf.days.reduce((s, d) => s + d.matches, 0) - 1);
  });

  it('sin fuga: cambiar los resultados de los días POSTERIORES no cambia la combinada (ni su resultado) de un día', () => {
    const cutDay = '2026-05-15';
    const cut = Date.parse(`${cutDay}T22:00:00Z`); // fin del día local (Europe/Madrid, verano: UTC+2)
    const flip = (h: ConfidenceHistoryItem[]) =>
      h.map((it) =>
        Date.parse(it.date) >= cut
          ? { ...it, candidates: it.candidates.map((c) => ({ ...c, result: c.result === 'hit' ? ('miss' as const) : c.result === 'miss' ? ('hit' as const) : c.result })) }
          : it,
      );
    const wf2 = run(flip(baseHist), flip(extraHist));
    const view = (w: typeof wf, before: boolean) =>
      w.days
        .filter((d) => (before ? d.date <= cutDay : d.date > cutDay))
        .map((d) => `${d.date}|${d.search.combo ? d.search.combo.legs.map((l) => `${l.match.matchId}.${l.marketId}.${l.prob.toFixed(10)}`).join(',') : d.search.reason}|${d.search.combo?.result}`);
    const a = view(wf, true);
    expect(a.length).toBeGreaterThan(40);
    expect(view(wf2, true)).toEqual(a);
    // control: después del corte sí cambia algo (resultados y, en los meses siguientes, las calibraciones)
    expect(view(wf2, false)).not.toEqual(view(wf, false));
  });

  it('sin fuga del PROPIO día: los resultados de un día local no cambian su combinada, aunque el día cruce el inicio de un tramo (UTC)', () => {
    // el 1 de mayo local (Europe/Madrid, UTC+2) empieza el 30 de abril a las 22:00 UTC: ese partido es del tramo de
    // abril y entra en el ajuste de las reglas del tramo de mayo, que se usarían para el resto de partidos del MISMO día
    let checked = 0;
    for (const day of ['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01']) {
      const from = Date.parse(`${day}T00:00:00Z`) - 2 * 3_600_000;
      const to = from + 24 * 3_600_000;
      const flip = (h: ConfidenceHistoryItem[]) =>
        h.map((it) => {
          const t = Date.parse(it.date);
          return t >= from && t < to
            ? { ...it, candidates: it.candidates.map((c) => ({ ...c, result: c.result === 'hit' ? ('miss' as const) : c.result === 'miss' ? ('hit' as const) : c.result })) }
            : it;
        });
      const wf2 = run(flip(baseHist), flip(extraHist));
      const pick = (w: typeof wf) => {
        const d = w.days.find((x) => x.date === day)!;
        return { legs: d.legs.map((l) => `${l.match.matchId}.${l.marketId}.${l.prob.toFixed(12)}`), combo: d.search.combo?.legs.map((l) => `${l.match.matchId}.${l.marketId}.${l.prob.toFixed(12)}`) };
      };
      checked += pick(wf).legs.length;
      expect(pick(wf2)).toEqual(pick(wf));
    }
    expect(checked).toBeGreaterThan(20);
  });
});
