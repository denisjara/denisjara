/**
 * Distribución de Poisson (en espacio logarítmico) y matriz de marcadores Dixon-Coles.
 */
import type { Prob1X2 } from '../../types/data';
import { logFactorial } from './stats';

/** Sanea λ: valores no finitos o negativos → 0. */
function saneLambda(lambda: number): number {
  return Number.isFinite(lambda) && lambda > 0 ? lambda : 0;
}

/** log P(X = k), X ~ Poisson(λ). -Infinity fuera del soporte. */
export function poissonLogPmf(k: number, lambda: number): number {
  if (!Number.isInteger(k) || k < 0) return -Infinity;
  const l = saneLambda(lambda);
  if (l === 0) return k === 0 ? 0 : -Infinity;
  return k * Math.log(l) - l - logFactorial(k);
}

/** P(X = k), X ~ Poisson(λ). Calculado en espacio logarítmico (estable para k y λ grandes). */
export function poissonPmf(k: number, lambda: number): number {
  return Math.exp(poissonLogPmf(k, lambda));
}

/** [P(X=0), …, P(X=maxK)] sin plegar la cola (longitud maxK+1). */
export function poissonPmfArray(lambda: number, maxK: number): number[] {
  const n = Math.max(0, Math.floor(Number.isFinite(maxK) ? maxK : 0));
  const out = new Array<number>(n + 1);
  for (let k = 0; k <= n; k++) out[k] = poissonPmf(k, lambda);
  return out;
}

/** P(X <= k), X ~ Poisson(λ). */
export function poissonCdf(k: number, lambda: number): number {
  if (!(k >= 0)) return 0;
  const l = saneLambda(lambda);
  const kk = Math.floor(k);
  if (kk > l + 40 * Math.sqrt(l + 1) + 50) return 1;
  let s = 0;
  for (let i = 0; i <= kk; i++) s += poissonPmf(i, l);
  return Math.min(1, s);
}

/**
 * Factor de corrección τ de Dixon-Coles (1997) para marcadores bajos.
 * Se recorta a >= 0 (valores negativos implican un rho inválido para esos λ).
 */
export function dcTau(i: number, j: number, lambdaHome: number, lambdaAway: number, rho: number): number {
  let t = 1;
  if (i === 0 && j === 0) t = 1 - lambdaHome * lambdaAway * rho;
  else if (i === 0 && j === 1) t = 1 + lambdaHome * rho;
  else if (i === 1 && j === 0) t = 1 + lambdaAway * rho;
  else if (i === 1 && j === 1) t = 1 - rho;
  return t > 0 ? t : 0;
}

/**
 * Matriz de marcadores [i][j] = P(local = i, visitante = j), i,j ∈ 0..maxGoals,
 * Poisson independiente × τ de Dixon-Coles, normalizada para sumar 1.
 */
export function scoreMatrix(lambdaHome: number, lambdaAway: number, rho = 0, maxGoals = 10): number[][] {
  const n = Math.max(1, Math.floor(Number.isFinite(maxGoals) ? maxGoals : 10));
  const lh = saneLambda(lambdaHome);
  const la = saneLambda(lambdaAway);
  const r = Number.isFinite(rho) ? rho : 0;
  const ph = poissonPmfArray(lh, n);
  const pa = poissonPmfArray(la, n);
  const m: number[][] = new Array(n + 1);
  let total = 0;
  for (let i = 0; i <= n; i++) {
    const row = new Array<number>(n + 1);
    for (let j = 0; j <= n; j++) {
      let v = ph[i] * pa[j];
      if (i < 2 && j < 2) v *= dcTau(i, j, lh, la, r);
      row[j] = v;
      total += v;
    }
    m[i] = row;
  }
  if (!(total > 0)) {
    // Degenerado: toda la masa en 0-0.
    for (let i = 0; i <= n; i++) m[i].fill(0);
    m[0][0] = 1;
    return m;
  }
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) m[i][j] /= total;
  return m;
}

/** Suma total de una matriz de marcadores. */
function matrixTotal(matrix: number[][]): number {
  let s = 0;
  for (const row of matrix) for (const v of row) s += v;
  return s;
}

/** Probabilidades 1X2 de una matriz de marcadores (renormalizadas). */
export function outcomeProbs(matrix: number[][]): Prob1X2 {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i];
    for (let j = 0; j < row.length; j++) {
      if (i > j) home += row[j];
      else if (i === j) draw += row[j];
      else away += row[j];
    }
  }
  const s = home + draw + away;
  if (!(s > 0)) return { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
  return { home: home / s, draw: draw / s, away: away / s };
}

// ---------------------------------------------------------------------------
// Utilidades sobre matrices de marcadores
// ---------------------------------------------------------------------------

/** Distribución discreta sobre enteros consecutivos: P(X = min + idx) = p[idx]. */
export interface IntDist {
  min: number;
  p: number[];
}

/** Distribución de goles totales: [P(T=0), P(T=1), ...]. */
export function totalGoalsDist(matrix: number[][]): number[] {
  let maxT = 0;
  for (let i = 0; i < matrix.length; i++) maxT = Math.max(maxT, i + matrix[i].length - 1);
  const out = new Array<number>(maxT + 1).fill(0);
  const total = matrixTotal(matrix) || 1;
  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i];
    for (let j = 0; j < row.length; j++) out[i + j] += row[j] / total;
  }
  return out;
}

/** Distribución de la diferencia de goles (local − visitante). */
export function goalDiffDist(matrix: number[][]): IntDist {
  let maxJ = 0;
  for (const row of matrix) maxJ = Math.max(maxJ, row.length - 1);
  const maxI = matrix.length - 1;
  const p = new Array<number>(maxI + maxJ + 1).fill(0);
  const total = matrixTotal(matrix) || 1;
  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i];
    for (let j = 0; j < row.length; j++) p[i - j + maxJ] += row[j] / total;
  }
  return { min: -maxJ, p };
}

/** Marginales de goles de cada equipo. */
export function marginals(matrix: number[][]): { home: number[]; away: number[] } {
  let maxJ = 0;
  for (const row of matrix) maxJ = Math.max(maxJ, row.length - 1);
  const home = new Array<number>(matrix.length).fill(0);
  const away = new Array<number>(maxJ + 1).fill(0);
  const total = matrixTotal(matrix) || 1;
  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i];
    for (let j = 0; j < row.length; j++) {
      home[i] += row[j] / total;
      away[j] += row[j] / total;
    }
  }
  return { home, away };
}

/** P(ambos marcan). */
export function bttsProb(matrix: number[][]): number {
  let s = 0;
  for (let i = 1; i < matrix.length; i++) for (let j = 1; j < matrix[i].length; j++) s += matrix[i][j];
  return s / (matrixTotal(matrix) || 1);
}

/** Goles esperados de cada equipo según la matriz. */
export function expectedGoals(matrix: number[][]): { home: number; away: number } {
  const m = marginals(matrix);
  let h = 0;
  let a = 0;
  m.home.forEach((p, i) => (h += i * p));
  m.away.forEach((p, j) => (a += j * p));
  return { home: h, away: a };
}

/** Los n marcadores más probables, ordenados de mayor a menor probabilidad. */
export function topScores(matrix: number[][], n = 15): { home: number; away: number; prob: number }[] {
  const total = matrixTotal(matrix) || 1;
  const cells: { home: number; away: number; prob: number }[] = [];
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) cells.push({ home: i, away: j, prob: matrix[i][j] / total });
  }
  cells.sort((a, b) => b.prob - a.prob || a.home + a.away - (b.home + b.away) || a.home - b.home);
  return cells.slice(0, Math.max(0, n));
}

/** Marcador más probable. */
export function mostLikelyScore(matrix: number[][]): { home: number; away: number; prob: number } {
  return topScores(matrix, 1)[0] ?? { home: 0, away: 0, prob: 1 };
}

/** Resumen rápido de una matriz (para tarjetas de partido). */
export function summarizeMatrix(matrix: number[][]): {
  probs: Prob1X2;
  over25: number;
  btts: number;
  expHome: number;
  expAway: number;
  likelyScore: string;
  likelyScoreProb: number;
} {
  const t = totalGoalsDist(matrix);
  let over25 = 0;
  for (let k = 3; k < t.length; k++) over25 += t[k];
  const xg = expectedGoals(matrix);
  const ml = mostLikelyScore(matrix);
  return {
    probs: outcomeProbs(matrix),
    over25,
    btts: bttsProb(matrix),
    expHome: xg.home,
    expAway: xg.away,
    likelyScore: `${ml.home}-${ml.away}`,
    likelyScoreProb: ml.prob,
  };
}

/** Muestra de una Poisson(λ) por inversión secuencial de la CDF (aprox. normal si e^-λ subdesborda). */
export function samplePoisson(lambda: number, rng: () => number = Math.random): number {
  const l = saneLambda(lambda);
  if (l === 0) return 0;
  // Inversión secuencial de la CDF (exacta, O(λ)).
  let k = 0;
  let p = Math.exp(-l);
  if (p > 0) {
    let s = p;
    const u = rng();
    while (u > s && k < 1000) {
      k++;
      p *= l / k;
      s += p;
    }
    return k;
  }
  // λ enorme: aproximación normal.
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0, Math.round(l + Math.sqrt(l) * z));
}
