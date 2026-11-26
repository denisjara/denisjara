/**
 * Apartado «Cuota alta 6+» (pipeline/analytics/longshots.ts): candidatos por partido (sorpresas, marcadores, goleadores,
 * patas de combinada), combinadas (partidos distintos, producto, cuota >= 6), resolución a 90' (incluidos los nulos),
 * regla diaria, historial walk-forward (récord por tipo, ROI, rachas, calibración) y ausencia de fuga (un partido «del
 * futuro» no cambia los candidatos anteriores; los resultados de un mes no cambian lo que se selecciona en él).
 */
import { describe, expect, it } from 'vitest';
import { mulberry32, outcomeProbs, sampleNegBin, samplePoisson, scoreMatrix } from '../../src/lib/models';
import type { OddsSnapshot, PlayerProp, TeamRef } from '../../src/types/data';
import type { CompetitionConfig } from '../../pipeline/config';
import type { CompetitionStore, MatchRecord, PlayerLine } from '../../pipeline/types';
import {
  COMBO_MAX_ODDS,
  LEG_MAX_ODDS,
  LEG_MIN_ODDS,
  MAX_PER_DAY,
  MAX_PER_KIND,
  MIN_ODDS,
  SCORER_MIN_PROB,
  betResult,
  buildLongshotCombos,
  calibrated,
  calibrationKey,
  dayBets,
  fitLongshotCalibrator,
  historyItem,
  kindExclusion,
  longshotScore,
  longshotWalkForward,
  makeBet,
  matchSelections,
  selectLongshotDay,
  settleLongshot,
  singleBets,
  type LongshotEngineBet,
  type LongshotHistoryItem,
  type LongshotInput,
  type LongshotSelection,
} from '../../pipeline/analytics/longshots';
import { dailyHistory } from '../../pipeline/analytics/daily';
import { computeWalkForward, createContext } from '../../pipeline/publish/context';
import { longshotCollector, longshotReason, publicBet, seasonFrom } from '../../pipeline/publish/longshots';

const DAY = 86_400_000;
const team = (id: string, name: string): TeamRef => ({ id, name, short: name, abbr: name.slice(0, 3).toUpperCase() });

function prop(id: string, teamId: string, pGoal: number, expMinutes = 85): PlayerProp {
  return {
    player: { id, name: `Jugador ${id}`, short: `J. ${id}`, position: 'F', teamId },
    apps: 12,
    minutes: 950,
    goals: 3,
    assists: 1,
    expMinutes,
    formIndex: 60,
    pGoal,
    pAssist: 0.1,
    pGoalOrAssist: 0.25,
    pShots1: 0.8,
    pShots2: 0.5,
    pSot1: 0.5,
    pSot2: 0.2,
    pCard: 0.1,
  };
}

/** Partido con un claro favorito local (λ 2,0 – 0,8) y cuotas coherentes. */
function input(over: Partial<LongshotInput> = {}, id = 'm1', date = '2026-11-26T20:00:00Z'): LongshotInput {
  const matrix = scoreMatrix(over.lambdaHome ?? 2.0, over.lambdaAway ?? 0.8, -0.05);
  const odds: OddsSnapshot = { provider: 'Test', home: 1.45, draw: 4.6, away: 7.5, totalLine: 2.5, over: 1.8, under: 2.0, spreadLine: -1.5, spreadHome: 2.4, spreadAway: 1.57 };
  return {
    matchId: id,
    compId: 'liga',
    compName: 'Liga de prueba',
    date,
    home: team('H', 'Local FC'),
    away: team('A', 'Visitante CF'),
    tier: 8,
    p: outcomeProbs(matrix),
    matrix,
    odds,
    lambdaHome: 2.0,
    lambdaAway: 0.8,
    withMarket: true,
    players: { home: [prop('h9', 'H', 0.42), prop('h7', 'H', 0.15), prop('h4', 'H', 0.13, 50)], away: [prop('a9', 'A', 0.14), prop('a2', 'A', 0.05)] },
    ...over,
  };
}

describe('candidatos por partido', () => {
  const sels = matchSelections(input());

  it('selecciones coherentes: 1X2 suma 1, marcadores ordenados, más/menos y hándicap complementarios', () => {
    const x12 = sels.filter((s) => s.group === '1x2');
    expect(x12).toHaveLength(3);
    expect(x12.reduce((t, s) => t + s.rawProb, 0)).toBeCloseTo(1, 6);
    expect(x12.find((s) => s.key === '1x2-away')!.marketOdds).toBe(7.5);
    const scores = sels.filter((s) => s.group === 'marcador');
    expect(scores.length).toBeGreaterThan(8);
    scores.forEach((s, i) => {
      expect(s.rank).toBe(i + 1);
      if (i) expect(s.rawProb).toBeLessThanOrEqual(scores[i - 1].rawProb);
    });
    expect(scores.reduce((t, s) => t + s.rawProb, 0)).toBeLessThanOrEqual(1 + 1e-9);
    const ou = sels.filter((s) => s.group === 'total');
    expect(ou.map((s) => s.selection)).toEqual(['Más de 2.5 goles', 'Menos de 2.5 goles']);
    expect(ou[0].rawProb + ou[1].rawProb).toBeCloseTo(1, 9);
    const ah = sels.filter((s) => s.group === 'handicap');
    expect(ah.map((s) => s.selection)).toEqual(['Local FC -1.5', 'Visitante CF +1.5']);
    expect(ah[0].rawProb + ah[1].rawProb).toBeCloseTo(1, 9);
    expect(ah[0].marketOdds).toBe(2.4);
    // goleadores: solo jugadores con >= 60' esperados
    expect(sels.filter((s) => s.group === 'goleador').map((s) => s.player!.id)).toEqual(['h9', 'h7', 'a9', 'a2']);
  });

  it('sorpresas: 1X2 con cuota de la casa >= 6 (la del visitante a 7,5), con EV = p·cuota − 1', () => {
    const bets = singleBets(sels);
    const sur = bets.filter((b) => b.kind === 'sorpresa');
    expect(sur).toHaveLength(1);
    const b = sur[0];
    expect(b.label).toBe('Sorpresa: gana Visitante CF');
    expect(b.marketOdds).toBe(7.5);
    expect(b.displayOdds).toBe(7.5);
    expect(b.ev).toBeCloseTo(b.prob * 7.5 - 1, 12);
    expect(b.fairOdds).toBeCloseTo(1 / b.prob, 12);
    expect(b.oneIn).toBe(Math.round(1 / b.prob));
  });

  it('sin cuota de la casa: la sorpresa usa la cuota justa (>= 6) y no tiene EV', () => {
    const bets = singleBets(matchSelections(input({ odds: undefined, minEloGames: 30 })));
    for (const b of bets) {
      expect(b.marketOdds).toBeUndefined();
      expect(b.ev).toBeUndefined();
      expect(b.displayOdds).toBeCloseTo(b.fairOdds, 12);
      expect(b.displayOdds).toBeGreaterThanOrEqual(MIN_ODDS);
    }
    expect(bets.some((b) => b.kind === 'sorpresa')).toBe(true);
  });

  it('marcadores: los 2 más probables con cuota justa >= 6; goleadores: P(marcar) entre 0,10 y 1/6', () => {
    const bets = singleBets(sels);
    const sc = bets.filter((b) => b.kind === 'marcador');
    expect(sc).toHaveLength(2);
    const eligible = sels.filter((s) => s.group === 'marcador' && 1 / s.rawProb >= MIN_ODDS).sort((a, b) => b.rawProb - a.rawProb);
    expect(sc.map((b) => b.legs[0].key)).toEqual(eligible.slice(0, 2).map((s) => s.key));
    for (const b of sc) expect(b.fairOdds).toBeGreaterThanOrEqual(MIN_ODDS);
    const gs = bets.filter((b) => b.kind === 'goleador');
    expect(gs.map((b) => b.legs[0].player!.id)).toEqual(['h7', 'a9']);
    for (const b of gs) {
      expect(b.prob).toBeGreaterThanOrEqual(SCORER_MIN_PROB);
      expect(b.fairOdds).toBeGreaterThanOrEqual(MIN_ODDS - 1e-9);
      expect(b.legs[0].category).toBe('jugadores');
    }
  });

  it('sin cuotas y con poco historial (< 10 partidos Elo) no hay candidatos de resultado ni de goles', () => {
    expect(matchSelections(input({ odds: undefined, withMarket: false, minEloGames: 4 }))).toEqual([]);
    expect(matchSelections(input({ odds: undefined, withMarket: false, minEloGames: 12 })).length).toBeGreaterThan(5);
  });

  it('textos: frases en español con las cifras de la apuesta', () => {
    const bets = singleBets(sels);
    const sur = bets.find((b) => b.kind === 'sorpresa')!;
    expect(longshotReason(sur)).toMatch(/^El modelo da a Visitante CF un \d+ % de ganar \(1 de cada \d+\); la casa paga 7,50 → valor esperado [+−]\d/);
    const sc = bets.find((b) => b.kind === 'marcador')!;
    expect(longshotReason(sc)).toMatch(/marcador más probable.*Sin cuota de la casa: necesitas al menos \d+,\d\d/);
    const g = bets.find((b) => b.kind === 'goleador')!;
    expect(longshotReason(g)).toMatch(/Jugador h7 suma 3 goles en 950' .* si no juega, la casa suele anular la apuesta\.$/);
  });
});

// ---------------------------------------------------------------------------
// Combinadas
// ---------------------------------------------------------------------------

/** Patas de 1X2 / más-menos de `n` partidos con cuotas variadas. */
function legsOfDay(n: number, seed = 5): LongshotSelection[] {
  const rng = mulberry32(seed);
  const out: LongshotSelection[] = [];
  for (let k = 0; k < n; k++) {
    const lh = 0.8 + rng() * 1.6;
    const la = 0.6 + rng() * 1.4;
    const matrix = scoreMatrix(lh, la, -0.05);
    const p = outcomeProbs(matrix);
    const m = (x: number) => Math.round((1 / x) * 0.94 * 100) / 100;
    const odds: OddsSnapshot = { provider: 'Test', home: m(p.home), draw: m(p.draw), away: m(p.away), totalLine: 2.5, over: 1.9, under: 1.9 };
    out.push(...matchSelections(input({ p, matrix, odds, lambdaHome: lh, lambdaAway: la, players: undefined }, `c${k}`, new Date(Date.UTC(2026, 10, 28, 12 + (k % 8))).toISOString())));
  }
  return out;
}

describe('combinadas', () => {
  const sels = legsOfDay(14);
  const combos = buildLongshotCombos(sels);

  it('2–4 patas de partidos DISTINTOS con cuota de la casa; cuota = producto entre 6 y 12; prob = producto', () => {
    expect(combos.length).toBe(MAX_PER_KIND);
    const used = new Set<string>();
    for (const c of combos) {
      expect(c.kind).toBe('combinada');
      expect(c.legs.length).toBeGreaterThanOrEqual(2);
      expect(c.legs.length).toBeLessThanOrEqual(4);
      const ids = c.legs.map((l) => l.match.matchId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(used.has(id)).toBe(false); // ningún partido en dos combinadas
        used.add(id);
      }
      for (const l of c.legs) {
        expect(l.marketOdds).toBeDefined();
        expect(l.marketOdds!).toBeGreaterThanOrEqual(LEG_MIN_ODDS);
        expect(l.marketOdds!).toBeLessThanOrEqual(LEG_MAX_ODDS);
      }
      const prob = c.legs.reduce((t, l) => t * l.prob, 1);
      const odds = c.legs.reduce((t, l) => t * l.marketOdds!, 1);
      expect(c.prob).toBeCloseTo(prob, 12);
      expect(c.marketOdds).toBeCloseTo(odds, 12);
      expect(c.displayOdds).toBeGreaterThanOrEqual(MIN_ODDS);
      expect(c.displayOdds).toBeLessThanOrEqual(COMBO_MAX_ODDS);
      expect(c.ev).toBeCloseTo(prob * odds - 1, 12);
      expect(c.label).toBe(`Combinada de ${c.legs.length} partidos`);
      expect(longshotReason(c)).toMatch(new RegExp(`^${c.legs.length} patas de partidos distintos: .* = \\d+ % \\(1 de cada \\d+\\); la casa paga`));
    }
  });

  it('una pata sin cuota de la casa ⇒ la combinada no tiene cuota de la casa ni EV', () => {
    const legs = sels.filter((s) => s.group === '1x2' && s.key === '1x2-home').slice(0, 3);
    const b = makeBet('combinada', [legs[0], legs[1], { ...legs[2], marketOdds: undefined }]);
    expect(b.marketOdds).toBeUndefined();
    expect(b.ev).toBeUndefined();
    expect(b.displayOdds).toBeCloseTo(1 / b.prob, 12);
  });

  it('con menos de 2 partidos con cuota no hay combinadas', () => {
    expect(buildLongshotCombos(legsOfDay(1))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Resolución
// ---------------------------------------------------------------------------

describe('resolución a 90 minutos', () => {
  const d = { hg: 2, ag: 1 };
  const players = new Map([
    ['p1', { minutes: 90, shots: 3, shotsOnTarget: 2, goals: 1 }],
    ['p2', { minutes: 75, shots: 1, shotsOnTarget: 0, goals: 0 }],
  ]);

  it('marcador exacto, 1X2, hándicap y más/menos', () => {
    expect(settleLongshot({ kind: 'score', home: 2, away: 1 }, d)).toBe('hit');
    expect(settleLongshot({ kind: 'score', home: 1, away: 1 }, d)).toBe('miss');
    expect(settleLongshot({ kind: 'outcome', win: ['away'] }, d)).toBe('miss');
    expect(settleLongshot({ kind: 'outcome', win: ['home'] }, d)).toBe('hit');
    expect(settleLongshot({ kind: 'handicap', side: 'home', line: -1.5 }, d)).toBe('miss');
    expect(settleLongshot({ kind: 'handicap', side: 'away', line: 1.5 }, d)).toBe('hit');
    expect(settleLongshot({ kind: 'total', stat: 'goals', side: 'over', line: 2.5 }, d)).toBe('hit');
  });

  it('goleador: marca / no marca / no juega (nulo) / partido sin líneas de jugador (sin resolver)', () => {
    const g = (playerId: string) => ({ kind: 'player' as const, playerId, stat: 'goals' as const, min: 1 });
    expect(settleLongshot(g('p1'), { ...d, players })).toBe('hit');
    expect(settleLongshot(g('p2'), { ...d, players })).toBe('miss');
    expect(settleLongshot(g('p3'), { ...d, players })).toBe('void');
    expect(settleLongshot(g('p1'), d)).toBeUndefined();
  });

  it('apuesta: una pata fallada ⇒ fallada aunque falten partidos; nula si alguna es nula y ninguna falla', () => {
    expect(betResult(['hit', 'hit'])).toBe('hit');
    expect(betResult(['hit', undefined])).toBeUndefined();
    expect(betResult(['miss', undefined])).toBe('miss');
    expect(betResult(['void', 'hit'])).toBe('void');
    expect(betResult(['void', 'miss'])).toBe('miss');
  });

  it('historyItem: solo selecciones resolubles, cada una con su resultado', () => {
    const it0 = historyItem(input(), { hg: 3, ag: 0, players });
    const r = new Map(it0.selections.map((s) => [s.key, s.result]));
    expect(r.get('1x2-home')).toBe('hit');
    expect(r.get('score-3-0')).toBe('hit');
    expect(r.get('score-1-0')).toBe('miss');
    expect(r.get('scorer-h9')).toBe('void'); // no está en las líneas: no jugó
    expect(it0.selections.every((s) => s.result !== undefined)).toBe(true);
    const noLines = historyItem(input(), { hg: 3, ag: 0 });
    expect(noLines.selections.some((s) => s.group === 'goleador')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regla diaria
// ---------------------------------------------------------------------------

describe('regla diaria', () => {
  it('máx. 4 por tipo, sin repetir partido dentro de un tipo, 12 en total y por puntuación', () => {
    const groups: LongshotSelection[][] = [];
    for (let k = 0; k < 20; k++) {
      const lh = 1.6 + (k % 5) * 0.2;
      const la = 0.7 + (k % 3) * 0.15;
      const matrix = scoreMatrix(lh, la, -0.05);
      const p = outcomeProbs(matrix);
      const odds: OddsSnapshot = { provider: 'T', home: Math.round((0.95 / p.home) * 100) / 100, draw: Math.round((0.95 / p.draw) * 100) / 100, away: Math.round((0.95 / p.away) * 100) / 100 };
      groups.push(matchSelections(input({ p, matrix, odds, lambdaHome: lh, lambdaAway: la }, `d${k}`)));
    }
    const bets = dayBets(groups);
    expect(bets.length).toBe(MAX_PER_DAY);
    const perKind = new Map<string, number>();
    const used = new Map<string, Set<string>>();
    bets.forEach((b, i) => {
      perKind.set(b.kind, (perKind.get(b.kind) ?? 0) + 1);
      const u = used.get(b.kind) ?? new Set<string>();
      for (const l of b.legs) {
        expect(u.has(l.match.matchId)).toBe(false);
        u.add(l.match.matchId);
      }
      used.set(b.kind, u);
      if (i) expect(b.score).toBeLessThanOrEqual(bets[i - 1].score);
      expect(b.displayOdds).toBeGreaterThanOrEqual(MIN_ODDS - 1e-9);
    });
    for (const n of perKind.values()) expect(n).toBeLessThanOrEqual(MAX_PER_KIND);
    // tipos no publicables: fuera
    const only = dayBets(groups, { kinds: new Set(['marcador']) });
    expect(only.every((b) => b.kind === 'marcador')).toBe(true);
    expect(only.length).toBe(MAX_PER_KIND);
  });

  it('puntuación: más probabilidad (para cuota >= 6), más EV y más prestigio suben; sin cuota se asume EV −20 %', () => {
    expect(longshotScore(0.16, 0, 8)).toBeGreaterThan(longshotScore(0.1, 0, 8));
    expect(longshotScore(0.12, 0.1, 8)).toBeGreaterThan(longshotScore(0.12, -0.1, 8));
    expect(longshotScore(0.12, 0, 10)).toBeGreaterThan(longshotScore(0.12, 0, 4));
    expect(longshotScore(0.12, undefined, 8)).toBe(longshotScore(0.12, -0.2, 8));
    const b = makeBet('sorpresa', [matchSelections(input()).find((s) => s.key === '1x2-away')!]);
    const list = selectLongshotDay([b, { ...b, id: 'x', score: b.score + 1 }]);
    expect(list.map((x) => x.id)).toEqual(['x']); // mismo partido dentro del tipo: solo uno
  });

  it('publicBet: probabilidad y cuotas coherentes con las patas redondeadas', () => {
    const c = buildLongshotCombos(legsOfDay(10))[0];
    const pub = publicBet(c);
    const prod = pub.legs.reduce((t, l) => t * l.prob, 1);
    expect(Math.abs(pub.prob - prod)).toBeLessThan(1e-4);
    expect(pub.fairOdds).toBeCloseTo(1 / prod, 1);
    expect(pub.marketOdds).toBeCloseTo(pub.legs.reduce((t, l) => t * l.marketOdds!, 1), 1);
    expect(pub.ev).toBeCloseTo(prod * pub.legs.reduce((t, l) => t * l.marketOdds!, 1) - 1, 3);
    expect(pub.displayOdds).toBe(pub.marketOdds);
    expect(pub.reason.length).toBeGreaterThan(20);
    // la frase cita el MISMO valor esperado que muestra la tarjeta (mismo redondeo: Intl es-ES, 1 decimal si < 10 %)
    const v = Math.abs(pub.ev!) * 100;
    const shown = v < 10 ? new Intl.NumberFormat('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v) : String(Math.round(v));
    expect(pub.reason).toContain(`valor esperado ${pub.ev! >= 0 ? '+' : '−'}${shown} %`);
    // simple: la cuota justa de la pata y la de la apuesta salen de la misma probabilidad publicada
    for (const s of matchSelections(input()).filter((x) => x.group === 'goleador' || x.group === 'marcador').slice(0, 6)) {
      const single = publicBet(makeBet(s.group === 'goleador' ? 'goleador' : 'marcador', [s]));
      expect(single.legs[0].fairOdds).toBe(single.fairOdds);
    }
  });
});

// ---------------------------------------------------------------------------
// Historial walk-forward (ítems sintéticos)
// ---------------------------------------------------------------------------

/** Historial sintético: 3 partidos al día durante ~5 meses, resultados simulados con las probabilidades verdaderas. */
function syntheticHistory(seed = 11, days = 150, optimism = 1, perDay = 3): LongshotHistoryItem[] {
  const rng = mulberry32(seed);
  const out: LongshotHistoryItem[] = [];
  const start = Date.UTC(2026, 5, 1, 18);
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < perDay; k++) {
      const lh = 1.1 + rng() * 1.2;
      const la = 0.6 + rng() * 1.0;
      const matrix = scoreMatrix(lh, la, -0.05);
      const pTrue = outcomeProbs(matrix);
      // el modelo «optimista» infla las probabilidades bajas (más sorpresas de las reales)
      const p = { home: pTrue.home, draw: pTrue.draw * optimism, away: pTrue.away * optimism };
      const odds: OddsSnapshot = { provider: 'T', home: Math.round((0.95 / pTrue.home) * 100) / 100, draw: Math.round((0.95 / pTrue.draw) * 100) / 100, away: Math.round((0.95 / pTrue.away) * 100) / 100 };
      const hg = samplePoisson(lh, rng);
      const ag = samplePoisson(la, rng);
      out.push(historyItem(input({ p, matrix, odds, lambdaHome: lh, lambdaAway: la, players: undefined }, `w${d}-${k}`, new Date(start + d * DAY + k * 3_600_000).toISOString()), { hg, ag }));
    }
  }
  return out;
}

describe('historial walk-forward', () => {
  const items = syntheticHistory();
  const wf = longshotWalkForward(items, { timeZone: 'Europe/Madrid', from: '2026-06-01', to: '2026-11-01' });

  it('récord por tipo coherente: aciertos <= resueltas, %, Wilson, cuota media >= 6, ROI y racha', () => {
    expect(wf.days).toBeGreaterThan(100);
    expect(wf.from >= '2026-06-01').toBe(true);
    expect(wf.to < '2026-11-01').toBe(true);
    const kinds = wf.byKind.map((r) => r.kind);
    expect(kinds).toEqual(['combinada', 'sorpresa', 'marcador', 'goleador']);
    for (const r of wf.byKind) {
      const own = wf.bets.filter((b) => b.kind === r.kind);
      expect(r.bets).toBe(own.length);
      expect(r.hits).toBe(own.filter((b) => b.result === 'hit').length);
      expect(r.n).toBe(own.filter((b) => b.result === 'hit' || b.result === 'miss').length);
      if (r.n) {
        expect(r.hitRate).toBeCloseTo(r.hits / r.n, 12);
        expect(r.wilsonLow).toBeLessThanOrEqual(r.hitRate);
        expect(r.wilsonHigh).toBeGreaterThanOrEqual(r.hitRate);
        expect(r.avgOdds).toBeGreaterThanOrEqual(MIN_ODDS - 1e-9);
      }
      if (r.roi) {
        const priced = own.filter((b) => b.marketOdds !== undefined && (b.result === 'hit' || b.result === 'miss'));
        const profit = priced.reduce((t, b) => t + (b.result === 'hit' ? b.marketOdds! - 1 : -1), 0);
        expect(r.roi.bets).toBe(priced.length);
        expect(r.roi.profit).toBeCloseTo(profit, 9);
        expect(r.roi.roi).toBeCloseTo(profit / priced.length, 12);
      }
      // racha: máximo de fallos seguidos en orden cronológico
      let run = 0;
      let best = 0;
      for (const b of own) {
        if (b.result === 'miss') best = Math.max(best, ++run);
        else if (b.result === 'hit') run = 0;
      }
      expect(r.longestLosingStreak).toBe(best);
    }
    // sin cuotas de marcador: ROI no medible
    expect(wf.byKind.find((r) => r.kind === 'marcador')!.roi).toBeUndefined();
    expect(wf.byKind.find((r) => r.kind === 'combinada')!.roi!.bets).toBeGreaterThan(50);
  });

  it('cada día respeta la regla diaria', () => {
    const byDay = new Map<string, LongshotEngineBet[]>();
    for (const b of wf.bets) {
      const k = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(b.date));
      byDay.set(k, [...(byDay.get(k) ?? []), b]);
    }
    for (const list of byDay.values()) {
      expect(list.length).toBeLessThanOrEqual(MAX_PER_DAY);
      for (const k of ['combinada', 'sorpresa', 'marcador']) expect(list.filter((b) => b.kind === k).length).toBeLessThanOrEqual(MAX_PER_KIND);
    }
  });

  it('con probabilidades verdaderas el acierto se parece al esperado; la tabla de calibración está en la banda 0,05–0,25', () => {
    const o = wf.overall;
    expect(o.n).toBeGreaterThan(300);
    expect(Math.abs(o.hitRate - o.expectedHitRate)).toBeLessThan(0.04);
    expect(wf.calibration.length).toBeGreaterThan(2);
    for (const b of wf.calibration) {
      expect(b.from).toBeGreaterThanOrEqual(0.05 - 1e-9);
      expect(b.to).toBeLessThanOrEqual(0.25 + 1e-9);
      expect(b.predicted).toBeGreaterThanOrEqual(b.from - 1e-9);
      expect(b.predicted).toBeLessThanOrEqual(b.to + 1e-9);
    }
    // con el margen del 5 % y cuotas justas para el modelo, el ROI es negativo
    expect(wf.overall.roi!.roi).toBeLessThan(0);
  });

  it('exigencia de publicación: muestra mínima y calibración (Wilson alto >= 70 % de lo prometido)', () => {
    // modelo optimista: promete un 15 % y acierta un 7,5 % con n = 400 ⇒ no se publica
    expect(kindExclusion({ n: 400, hits: 30, hitRate: 0.075, wilsonHigh: 0.095, expectedHitRate: 0.15 })).toMatch(/mal calibrado: el modelo prometía acertar un 15 % y acertó un 8 % \(30 de 400\)/);
    // poco optimista o sin evidencia suficiente: se publica (el récord lo muestra igualmente)
    expect(kindExclusion({ n: 400, hits: 50, hitRate: 0.125, wilsonHigh: 0.15, expectedHitRate: 0.15 })).toBeUndefined();
    expect(kindExclusion({ n: 10, hits: 1, hitRate: 0.1, wilsonHigh: 0.3, expectedHitRate: 0.12 })).toMatch(/sin historial suficiente \(10 apuestas resueltas fuera de muestra; se exigen 30\)/);
    expect(kindExclusion(wf.byKind.find((r) => r.kind === 'marcador')!)).toBeUndefined();
    // en el walk-forward, un modelo que infla las sorpresas promete más de lo que acierta
    const bad = longshotWalkForward(syntheticHistory(3, 150, 2.5, 10), { timeZone: 'Europe/Madrid', from: '2026-06-01' });
    const sur = bad.byKind.find((r) => r.kind === 'sorpresa')!;
    expect(sur.n).toBeGreaterThan(200);
    expect(sur.expectedHitRate).toBeGreaterThan(sur.hitRate);
  });

  it('recalibración: Platt por clave (1X2 bajo aparte) con filas suficientes; corrige un modelo optimista', () => {
    expect(calibrationKey({ group: '1x2', rawProb: 0.12 })).toBe('1x2-bajo');
    expect(calibrationKey({ group: '1x2', rawProb: 0.6 })).toBe('1x2');
    expect(calibrationKey({ group: 'goleador', rawProb: 0.12 })).toBe('goleador');
    const opt = syntheticHistory(3, 150, 1.8);
    const cal = fitLongshotCalibrator(opt.flatMap((it) => it.selections));
    expect(cal['1x2-bajo']).toBeDefined();
    const s = opt[0].selections.find((x) => x.key === '1x2-away')!;
    if (s.rawProb < 0.35) expect(calibrated(s, cal).prob).toBeLessThan(s.rawProb);
    const raw = longshotWalkForward(opt, { timeZone: 'Europe/Madrid', from: '2026-08-01' });
    const pl = longshotWalkForward(opt, { timeZone: 'Europe/Madrid', from: '2026-08-01', calibrate: true });
    const gap = (w: typeof raw) => w.byKind.find((r) => r.kind === 'sorpresa')!;
    expect(gap(pl).expectedHitRate - gap(pl).hitRate).toBeLessThan(gap(raw).expectedHitRate - gap(raw).hitRate);
    expect(pl.calibrator).toBeDefined();
  });

  it('sin fuga: los resultados de un mes no cambian lo que se selecciona en él ni antes (con recalibración)', () => {
    const cut = Date.UTC(2026, 9, 1);
    const flip = (h: LongshotHistoryItem[]) =>
      h.map((it) =>
        Date.parse(it.match.date) >= cut
          ? { ...it, selections: it.selections.map((s) => ({ ...s, result: s.result === 'hit' ? ('miss' as const) : s.result === 'miss' ? ('hit' as const) : s.result })) }
          : it,
      );
    const a = longshotWalkForward(items, { timeZone: 'Europe/Madrid', from: '2026-06-01', calibrate: true });
    const b = longshotWalkForward(flip(items), { timeZone: 'Europe/Madrid', from: '2026-06-01', calibrate: true });
    const sel = (w: typeof a) => w.bets.filter((x) => Date.parse(x.date) < cut + 31 * DAY).map((x) => `${x.id}|${x.prob.toFixed(10)}`);
    expect(sel(b)).toEqual(sel(a));
    const before = (w: typeof a) => w.bets.filter((x) => Date.parse(x.date) < cut).map((x) => `${x.id}|${x.result}`);
    expect(before(b)).toEqual(before(a));
  });
});

// ---------------------------------------------------------------------------
// Sin fuga con el walk-forward real del build (mundo sintético con líneas de jugador)
// ---------------------------------------------------------------------------

const LIGA: CompetitionConfig = { id: 'liga-a', slug: 'syn.1', name: 'Liga A', shortName: 'Liga A', country: 'Sintetia', flag: '🏳️', kind: 'league', tier: 8 };
const POSITIONS: PlayerLine['position'][] = ['G', 'D', 'D', 'D', 'D', 'M', 'M', 'M', 'F', 'F', 'F', 'M', 'F'];

function linesOf(m: MatchRecord, rng: () => number): PlayerLine[] {
  const out: PlayerLine[] = [];
  for (const side of ['home', 'away'] as const) {
    const t = m[side];
    const opp = side === 'home' ? m.away : m.home;
    const goals = side === 'home' ? m.score!.home : m.score!.away;
    const scorers = Array.from({ length: goals }, () => 5 + Math.floor(rng() * 8));
    POSITIONS.forEach((position, i) => {
      const minutes = i < 11 ? (i === 10 ? 70 : 90) : i === 11 ? 20 : 0;
      if (!minutes) return;
      const g = scorers.filter((s) => s === i).length;
      const shots = g + samplePoisson((position === 'F' ? 2.4 : position === 'M' ? 1.1 : 0.4) * (minutes / 90), rng);
      out.push({
        matchId: m.id,
        compId: m.compId,
        date: m.date,
        teamId: t.id,
        opponentId: opp.id,
        isHome: side === 'home',
        playerId: `${t.id}-p${i}`,
        name: `Jugador ${i} ${t.name}`,
        short: `J. ${i}`,
        position,
        starter: i < 11,
        minutes,
        goals: g,
        assists: 0,
        shots,
        shotsOnTarget: Math.min(shots, g + samplePoisson(0.4, rng)),
        yellow: 0,
        red: 0,
        foulsCommitted: 1,
        foulsSuffered: 1,
        offsides: 0,
        ownGoals: 0,
      });
    });
  }
  return out;
}

function leagueWorld(seed = 3): CompetitionStore {
  const rng = mulberry32(seed);
  const teams = Array.from({ length: 12 }, (_, i) => ({ id: `T${i}`, name: `Equipo ${i}`, short: `Eq${i}`, abbr: `E${i}`, att: 1.45 - 0.07 * i, def: 0.7 + 0.06 * i }));
  const matches: MatchRecord[] = [];
  const players: PlayerLine[] = [];
  let id = 5000;
  for (let t = Date.UTC(2025, 0, 4, 15); t < Date.UTC(2026, 9, 25); t += 7 * DAY) {
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
      const stats = (goals: number, att: number) => ({ goals, shots: Math.max(goals, sampleNegBin(12 * att, 25, rng)), shotsOnTarget: goals + 2, corners: 5, fouls: 12, yellow: 2, red: 0 });
      const m: MatchRecord = {
        id: String(id++),
        compId: LIGA.id,
        season: new Date(date).getUTCFullYear(),
        currentSeason: date >= Date.UTC(2026, 7, 1),
        date: new Date(date).toISOString(),
        status: 'finished',
        home: { id: h.id, name: h.name, short: h.short, abbr: h.abbr },
        away: { id: a.id, name: a.name, short: a.short, abbr: a.abbr },
        score: { home: hg, away: ag },
        stats: { home: stats(hg, h.att), away: stats(ag, a.att) },
        summaryFetched: true,
      };
      matches.push(m);
      players.push(...linesOf(m, rng));
    }
  }
  return { compId: LIGA.id, slug: LIGA.slug, updatedAt: '2026-11-01T00:00:00Z', matches, players, standings: [] };
}

describe('sin fuga: historial del build', () => {
  const store = leagueWorld();
  const now = new Date('2026-11-01T00:00:00Z');
  const current = store.matches.filter((m) => m.currentSeason);
  const target = current[Math.floor(current.length / 2)];
  const t = Date.parse(target.date);
  // partido «del futuro» entre los mismos equipos con un marcador y unas líneas de jugador absurdos
  const future: MatchRecord = { ...target, id: '999999', date: new Date(t + 10 * DAY).toISOString(), score: { home: 0, away: 9 } };
  const futureLines = linesOf({ ...future, score: { home: 0, away: 0 } }, mulberry32(1)).map((l) => ({ ...l, shots: 15, shotsOnTarget: 12, goals: 3 }));
  const run = (s: CompetitionStore) => {
    const ctx = createContext({ stores: [s], configs: [LIGA], now });
    computeWalkForward(ctx);
    const col = longshotCollector(ctx);
    dailyHistory(ctx, { visitExtra: col.visit });
    return col.items;
  };
  const a = run(store);
  const b = run({ ...store, matches: [...store.matches, future], players: [...store.players, ...futureLines] });
  const key = (items: LongshotHistoryItem[]) =>
    items.filter((it) => Date.parse(it.match.date) < t + 10 * DAY).map((it) => `${it.match.matchId}:${it.selections.map((s) => `${s.key}=${s.rawProb.toFixed(12)}/${s.result}`).join(',')}`);

  it('las selecciones (y sus resultados) de los partidos anteriores no cambian si se añade un partido posterior', () => {
    expect(a.length).toBeGreaterThan(50);
    const target0 = a.find((it) => it.match.matchId === target.id)!;
    expect(target0.selections.some((s) => s.group === 'goleador')).toBe(true);
    expect(target0.selections.some((s) => s.group === 'marcador')).toBe(true);
    expect(key(b)).toEqual(key(a));
    expect(b.some((it) => it.match.matchId === '999999')).toBe(true);
  });

  it('el historial se puede evaluar con la regla diaria y la temporada empieza el 1 de junio', () => {
    expect(seasonFrom('2026-11-26')).toBe('2026-06-01');
    expect(seasonFrom('2027-03-02')).toBe('2026-06-01');
    const wf = longshotWalkForward(a, { timeZone: 'Europe/Madrid', from: '2026-06-01', to: '2026-11-01', calibrate: true });
    expect(wf.bets.length).toBeGreaterThan(20);
    expect(wf.bets.every((x) => x.result !== undefined)).toBe(true);
    expect(wf.byKind.find((r) => r.kind === 'goleador')!.bets).toBeGreaterThan(0);
  });
});
