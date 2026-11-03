/**
 * Backtest walk-forward: evaluación de las predicciones pre-partido frente a los resultados reales.
 *
 *  - Puntuaciones (Brier multiclase, log-loss, RPS, acierto) del modelo final y de cada fuente (Elo, Dixon-Coles,
 *    mercado sin margen — solo partidos con cuotas) y de una línea base constante (frecuencias de la liga).
 *  - Calibración con las probabilidades de las 3 clases (local, empate, visitante) en 10 tramos.
 *  - ROI: apuesta plana de 1 unidad a la selección 1X2 de mayor EV contra las cuotas de cierre cuando
 *    EV >= MODEL.minEv (y, como en las apuestas de valor publicadas, p >= MODEL.minProb y cuota <= MODEL.maxOdds).
 *  - Mercados binarios: Brier y acierto de Más de 2.5 y Ambos marcan.
 *
 * walkForwardDC: Dixon-Coles re-ajustado cada `refitEveryDays` días usando SOLO partidos anteriores (sin fuga de
 * información), para obtener predicciones DC "pre-partido" de partidos ya jugados.
 */
import type { BacktestSummary, Prob1X2, ScoreSet } from '../../src/types/data';
import { brierBinary, calibration, devig, fitDixonColes, round, scoreSet, type DCMatch, type DCModel } from '../../src/lib/models';
import { MODEL } from '../config';
import type { MatchRecord } from '../types';
import { finishedSorted, isFinished } from './teamStats';

export interface BacktestItem {
  match: MatchRecord;
  pred: {
    p: Prob1X2;
    over25?: number;
    btts?: number;
    sources?: { elo?: Prob1X2; dc?: Prob1X2; market?: Prob1X2 };
  };
  /** cuotas decimales de cierre 1X2 */
  closing?: { home: number; draw: number; away: number };
}

export interface BacktestOptions {
  minEv?: number;
  minProb?: number;
  maxOdds?: number;
  /** EV máximo creíble (por defecto sin límite) */
  maxEv?: number;
}

type Outcome3 = 0 | 1 | 2;

export function outcomeOfScore(home: number, away: number): Outcome3 {
  return home > away ? 0 : home === away ? 1 : 2;
}

function roundScore(s: ScoreSet): ScoreSet {
  return { brier: round(s.brier, 4), logLoss: round(s.logLoss, 4), rps: round(s.rps, 4), accuracy: round(s.accuracy, 4) };
}

function validProb(p: Prob1X2 | undefined): p is Prob1X2 {
  return !!p && [p.home, p.draw, p.away].every((x) => Number.isFinite(x) && x >= 0) && p.home + p.draw + p.away > 0;
}

function validOdds(c: BacktestItem['closing']): c is NonNullable<BacktestItem['closing']> {
  return !!c && [c.home, c.draw, c.away].every((x) => Number.isFinite(x) && x > 1);
}

function binaryScore(rows: { p: number; y: 0 | 1 }[]): { brier: number; accuracy: number; n: number } | undefined {
  if (rows.length === 0) return undefined;
  let b = 0;
  let hit = 0;
  for (const r of rows) {
    b += brierBinary(r.p, r.y);
    if ((r.p >= 0.5 ? 1 : 0) === r.y) hit++;
  }
  return { brier: round(b / rows.length, 4), accuracy: round(hit / rows.length, 4), n: rows.length };
}

export function runBacktest(items: BacktestItem[], baseline: Prob1X2, opts: BacktestOptions = {}): BacktestSummary {
  const minEv = opts.minEv ?? MODEL.minEv;
  const minProb = opts.minProb ?? MODEL.minProb;
  const maxOdds = opts.maxOdds ?? MODEL.maxOdds;
  const maxEv = opts.maxEv ?? Infinity;

  const valid = items
    .filter((it) => isFinished(it.match) && validProb(it.pred.p))
    .sort((a, b) => Date.parse(a.match.date) - Date.parse(b.match.date));

  const model: { p: Prob1X2; outcome: Outcome3 }[] = [];
  const elo: { p: Prob1X2; outcome: Outcome3 }[] = [];
  const dc: { p: Prob1X2; outcome: Outcome3 }[] = [];
  const market: { p: Prob1X2; outcome: Outcome3 }[] = [];
  const base: { p: Prob1X2; outcome: Outcome3 }[] = [];
  const calib: { p: number; y: 0 | 1 }[] = [];
  const over: { p: number; y: 0 | 1 }[] = [];
  const btts: { p: number; y: 0 | 1 }[] = [];
  let bets = 0;
  let profit = 0;
  let wins = 0;
  let oddsSum = 0;
  let withOdds = 0;

  for (const it of valid) {
    const s = it.match.score!;
    const outcome = outcomeOfScore(s.home, s.away);
    const p = it.pred.p;
    model.push({ p, outcome });
    base.push({ p: baseline, outcome });
    calib.push({ p: p.home, y: outcome === 0 ? 1 : 0 }, { p: p.draw, y: outcome === 1 ? 1 : 0 }, { p: p.away, y: outcome === 2 ? 1 : 0 });
    const src = it.pred.sources;
    if (validProb(src?.elo)) elo.push({ p: src!.elo!, outcome });
    if (validProb(src?.dc)) dc.push({ p: src!.dc!, outcome });
    let mk = src?.market;
    if (!validProb(mk) && validOdds(it.closing)) {
      const [h, d, a] = devig([it.closing.home, it.closing.draw, it.closing.away]);
      mk = { home: h, draw: d, away: a };
    }
    if (validProb(mk)) market.push({ p: mk, outcome });
    const total = s.home + s.away;
    if (it.pred.over25 !== undefined && Number.isFinite(it.pred.over25)) over.push({ p: it.pred.over25, y: total > 2.5 ? 1 : 0 });
    if (it.pred.btts !== undefined && Number.isFinite(it.pred.btts)) btts.push({ p: it.pred.btts, y: s.home > 0 && s.away > 0 ? 1 : 0 });

    if (validOdds(it.closing)) {
      withOdds++;
      const sel: { k: Outcome3; p: number; o: number }[] = [
        { k: 0, p: p.home, o: it.closing.home },
        { k: 1, p: p.draw, o: it.closing.draw },
        { k: 2, p: p.away, o: it.closing.away },
      ];
      let best: { k: Outcome3; ev: number; o: number } | undefined;
      for (const c of sel) {
        const ev = c.p * c.o - 1;
        if (c.p < minProb || c.o > maxOdds || ev > maxEv) continue;
        if (!best || ev > best.ev) best = { k: c.k, ev, o: c.o };
      }
      if (best && best.ev >= minEv) {
        bets++;
        oddsSum += best.o;
        if (best.k === outcome) {
          wins++;
          profit += best.o - 1;
        } else profit -= 1;
      }
    }
  }

  const summary: BacktestSummary = {
    matches: model.length,
    from: model.length ? valid[0].match.date : '',
    to: model.length ? valid[valid.length - 1].match.date : '',
    model: roundScore(scoreSet(model)),
    baseline: roundScore(scoreSet(base)),
    calibration: calibration(calib, 10).map((b) => ({
      from: round(b.from, 2),
      to: round(b.to, 2),
      predicted: round(b.predicted, 4),
      observed: round(b.observed, 4),
      n: b.n,
    })),
  };
  if (elo.length) summary.elo = roundScore(scoreSet(elo));
  if (dc.length) summary.dixonColes = roundScore(scoreSet(dc));
  if (market.length) {
    summary.market = roundScore(scoreSet(market));
    summary.marketMatches = market.length;
  }
  if (withOdds > 0) {
    summary.roi = {
      bets,
      staked: bets,
      profit: round(profit, 3),
      roi: bets ? round(profit / bets, 4) : 0,
      hitRate: bets ? round(wins / bets, 4) : 0,
      avgOdds: bets ? round(oddsSum / bets, 3) : 0,
    };
  }
  const o = binaryScore(over);
  if (o) summary.over25 = o;
  const b = binaryScore(btts);
  if (b) summary.btts = b;
  return summary;
}

/** Combina varios resúmenes (p. ej. por competición) ponderando por número de partidos. */
export function mergeBacktests(list: BacktestSummary[]): BacktestSummary | undefined {
  const xs = list.filter((b) => b.matches > 0);
  if (xs.length === 0) return undefined;
  const wavg = (get: (b: BacktestSummary) => ScoreSet | undefined, weight: (b: BacktestSummary) => number) => {
    let w = 0;
    const acc = { brier: 0, logLoss: 0, rps: 0, accuracy: 0 };
    for (const b of xs) {
      const s = get(b);
      const ww = weight(b);
      if (!s || !(ww > 0)) continue;
      w += ww;
      acc.brier += s.brier * ww;
      acc.logLoss += s.logLoss * ww;
      acc.rps += s.rps * ww;
      acc.accuracy += s.accuracy * ww;
    }
    if (w === 0) return undefined;
    return roundScore({ brier: acc.brier / w, logLoss: acc.logLoss / w, rps: acc.rps / w, accuracy: acc.accuracy / w });
  };
  const n = (b: BacktestSummary) => b.matches;
  const out: BacktestSummary = {
    matches: xs.reduce((s, b) => s + b.matches, 0),
    from: xs.map((b) => b.from).sort()[0],
    to: xs.map((b) => b.to).sort().slice(-1)[0],
    model: wavg((b) => b.model, n)!,
    baseline: wavg((b) => b.baseline, n)!,
    calibration: [],
  };
  // calibración: suma de bins con la misma frontera
  const bins = new Map<number, { from: number; to: number; sp: number; so: number; n: number }>();
  for (const b of xs) {
    for (const c of b.calibration) {
      const k = Math.round(c.from * 100);
      const e = bins.get(k) ?? { from: c.from, to: c.to, sp: 0, so: 0, n: 0 };
      e.sp += c.predicted * c.n;
      e.so += c.observed * c.n;
      e.n += c.n;
      bins.set(k, e);
    }
  }
  out.calibration = [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, e]) => ({ from: e.from, to: e.to, predicted: round(e.sp / e.n, 4), observed: round(e.so / e.n, 4), n: e.n }));
  const elo = wavg((b) => b.elo, n);
  if (elo) out.elo = elo;
  const dc = wavg((b) => b.dixonColes, n);
  if (dc) out.dixonColes = dc;
  const mk = wavg((b) => b.market, (b) => b.marketMatches ?? 0);
  if (mk) {
    out.market = mk;
    out.marketMatches = xs.reduce((s, b) => s + (b.marketMatches ?? 0), 0);
  }
  const rois = xs.map((b) => b.roi).filter((r): r is NonNullable<BacktestSummary['roi']> => !!r);
  if (rois.length) {
    const bets = rois.reduce((s, r) => s + r.bets, 0);
    const profit = rois.reduce((s, r) => s + r.profit, 0);
    out.roi = {
      bets,
      staked: rois.reduce((s, r) => s + r.staked, 0),
      profit: round(profit, 3),
      roi: bets ? round(profit / bets, 4) : 0,
      hitRate: bets ? round(rois.reduce((s, r) => s + r.hitRate * r.bets, 0) / bets, 4) : 0,
      avgOdds: bets ? round(rois.reduce((s, r) => s + r.avgOdds * r.bets, 0) / bets, 3) : 0,
    };
  }
  const bin = (get: (b: BacktestSummary) => { brier: number; accuracy: number; n: number } | undefined) => {
    const ys = xs.map(get).filter((y): y is { brier: number; accuracy: number; n: number } => !!y && y.n > 0);
    if (!ys.length) return undefined;
    const tot = ys.reduce((s, y) => s + y.n, 0);
    return {
      brier: round(ys.reduce((s, y) => s + y.brier * y.n, 0) / tot, 4),
      accuracy: round(ys.reduce((s, y) => s + y.accuracy * y.n, 0) / tot, 4),
      n: tot,
    };
  };
  const o25 = bin((b) => b.over25);
  if (o25) out.over25 = o25;
  const bt = bin((b) => b.btts);
  if (bt) out.btts = bt;
  return out;
}

// ---------------------------------------------------------------------------
// Dixon-Coles walk-forward
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export interface WalkForwardOptions {
  /** ventana de entrenamiento en días (por defecto MODEL.dcWindowDays) */
  windowDays?: number;
  /** partidos mínimos de entrenamiento para ajustar (por defecto 50) */
  minMatches?: number;
  /** solo se generan modelos para partidos desde esta fecha ISO (los anteriores siguen sirviendo de entrenamiento) */
  from?: string;
  priorWeight?: number;
  /** iteraciones/tolerancia del ajuste (más laxas que el ajuste de producción para ir rápido) */
  maxIter?: number;
  tol?: number;
}

/**
 * Modelos Dixon-Coles "pre-partido" para cada partido terminado de una liga.
 * Se re-ajusta cuando han pasado >= refitEveryDays desde el último ajuste, con los partidos anteriores al día del
 * partido (dentro de la ventana). Los partidos de un mismo bloque comparten el objeto DCModel.
 * Devuelve matchId → modelo (omite los partidos sin historial suficiente).
 */
export function walkForwardDC(
  matches: MatchRecord[],
  xi: number,
  refitEveryDays = 7,
  opts: WalkForwardOptions = {},
): Map<string, DCModel> {
  const out = new Map<string, DCModel>();
  const fin = finishedSorted(matches);
  const n = fin.length;
  if (n === 0) return out;
  const windowMs = (opts.windowDays ?? MODEL.dcWindowDays) * DAY_MS;
  const minMatches = opts.minMatches ?? 50;
  const refitMs = Math.max(1, refitEveryDays) * DAY_MS;
  const fromT = opts.from ? Date.parse(opts.from) : -Infinity;
  const times = fin.map((m) => Date.parse(m.date));
  const dcm: DCMatch[] = fin.map((m) => ({
    home: m.home.id,
    away: m.away.id,
    hg: m.score.home,
    ag: m.score.away,
    date: m.date,
    neutral: m.neutral || undefined,
  }));
  let lo = 0;
  let hi = 0;
  let lastFit = -Infinity;
  let current: DCModel | null = null;
  for (let i = 0; i < n; i++) {
    const t = times[i];
    if (t < fromT) continue;
    const dayStart = Math.floor(t / DAY_MS) * DAY_MS;
    if (current === null ? dayStart > lastFit : dayStart - lastFit >= refitMs) {
      while (hi < n && times[hi] < dayStart) hi++;
      while (lo < hi && times[lo] < dayStart - windowMs) lo++;
      lastFit = dayStart;
      current =
        hi - lo >= minMatches
          ? fitDixonColes(dcm.slice(lo, hi), {
              refDate: new Date(dayStart).toISOString(),
              xi,
              maxIter: opts.maxIter ?? 120,
              tol: opts.tol ?? 1e-6,
              priorWeight: opts.priorWeight,
            })
          : null;
    }
    if (current) out.set(fin[i].id, current);
  }
  return out;
}
