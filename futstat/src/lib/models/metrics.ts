/**
 * Métricas de evaluación probabilística (backtest): Brier, log-loss, RPS, calibración.
 * Convención de resultado: 0 = local, 1 = empate, 2 = visitante.
 */
import type { CalibrationBin, Prob1X2, ScoreSet } from '../../types/data';

function vec(p: Prob1X2): [number, number, number] {
  return [p.home, p.draw, p.away];
}

/** Brier multiclase: Σ_k (p_k − y_k)² sobre las 3 clases (0 perfecto, 2 peor). */
export function brier3(p: Prob1X2, outcome: 0 | 1 | 2): number {
  const v = vec(p);
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const d = v[k] - (k === outcome ? 1 : 0);
    s += d * d;
  }
  return s;
}

/** Log-loss: −log(p_resultado), con epsilon 1e-12. */
export function logLoss3(p: Prob1X2, outcome: 0 | 1 | 2): number {
  const v = vec(p)[outcome];
  return -Math.log(Math.max(1e-12, Number.isFinite(v) ? v : 0));
}

/**
 * Ranked Probability Score ordenado (local, empate, visitante), normalizado por r−1 = 2:
 * RPS = ½·Σ_{i=1}^{2} (P_i − O_i)², con P_i y O_i acumuladas.
 */
export function rps3(p: Prob1X2, outcome: 0 | 1 | 2): number {
  const c1 = p.home;
  const c2 = p.home + p.draw;
  const o1 = outcome === 0 ? 1 : 0;
  const o2 = outcome <= 1 ? 1 : 0;
  return ((c1 - o1) ** 2 + (c2 - o2) ** 2) / 2;
}

/** Brier binario (p − y)². */
export function brierBinary(p: number, y: 0 | 1): number {
  return (p - y) ** 2;
}

/** Índice del resultado más probable (empates resueltos local > empate > visitante). */
export function argmax3(p: Prob1X2): 0 | 1 | 2 {
  if (p.home >= p.draw && p.home >= p.away) return 0;
  if (p.draw >= p.away) return 1;
  return 2;
}

/** Curva de calibración con `bins` intervalos de igual anchura en [0,1]. Bins vacíos se omiten. */
export function calibration(preds: { p: number; y: 0 | 1 }[], bins = 10): CalibrationBin[] {
  const B = Math.max(1, Math.floor(bins));
  const sp = new Array<number>(B).fill(0);
  const sy = new Array<number>(B).fill(0);
  const n = new Array<number>(B).fill(0);
  for (const { p, y } of preds) {
    if (!Number.isFinite(p)) continue;
    const q = Math.min(1, Math.max(0, p));
    const b = Math.min(B - 1, Math.floor(q * B));
    sp[b] += q;
    sy[b] += y;
    n[b]++;
  }
  const out: CalibrationBin[] = [];
  for (let b = 0; b < B; b++) {
    if (n[b] === 0) continue;
    out.push({ from: b / B, to: (b + 1) / B, predicted: sp[b] / n[b], observed: sy[b] / n[b], n: n[b] });
  }
  return out;
}

/** Media de Brier, log-loss, RPS y acierto (argmax) sobre un conjunto de predicciones. */
export function scoreSet(items: { p: Prob1X2; outcome: 0 | 1 | 2 }[]): ScoreSet {
  if (items.length === 0) return { brier: 0, logLoss: 0, rps: 0, accuracy: 0 };
  let brier = 0;
  let ll = 0;
  let rps = 0;
  let hits = 0;
  for (const { p, outcome } of items) {
    brier += brier3(p, outcome);
    ll += logLoss3(p, outcome);
    rps += rps3(p, outcome);
    if (argmax3(p) === outcome) hits++;
  }
  const n = items.length;
  return { brier: brier / n, logLoss: ll / n, rps: rps / n, accuracy: hits / n };
}
