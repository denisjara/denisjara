/**
 * Binomial negativa (media/dispersión) para estadísticas sobredispersas (córners, tarjetas, tiros…)
 * y utilidades sobre distribuciones discretas.
 *
 *   var = μ + μ²/r   (r = dispersion; r → ∞ ⇒ Poisson)
 *   P(k) = Γ(k+r)/(Γ(r)·k!) · (r/(r+μ))^r · (μ/(r+μ))^k
 */
import type { Prob1X2 } from '../../types/data';
import { lgamma, logFactorial, mean, variance } from './stats';
import { poissonLogPmf } from './poisson';

/** Por encima de este valor se usa directamente Poisson (diferencia numéricamente despreciable). */
const POISSON_LIMIT = 1e8;

function isPoisson(dispersion: number): boolean {
  return !Number.isFinite(dispersion) || dispersion >= POISSON_LIMIT;
}

/** log P(X = k) de la binomial negativa. */
export function nbLogPmf(k: number, mean: number, dispersion: number): number {
  if (!Number.isInteger(k) || k < 0) return -Infinity;
  const mu = Number.isFinite(mean) && mean > 0 ? mean : 0;
  if (mu === 0) return k === 0 ? 0 : -Infinity;
  if (isPoisson(dispersion)) return poissonLogPmf(k, mu);
  const r = dispersion > 0 ? dispersion : 1e-9;
  // log Γ(k+r) − log Γ(r): suma directa para k pequeño (más precisa cuando r es grande)
  let lg: number;
  if (k <= 200) {
    lg = 0;
    for (let i = 0; i < k; i++) lg += Math.log(r + i);
  } else {
    lg = lgamma(k + r) - lgamma(r);
  }
  return lg - logFactorial(k) - r * Math.log1p(mu / r) + k * (Math.log(mu) - Math.log(r + mu));
}

/** P(X = k). dispersion = Infinity → Poisson. */
export function nbPmf(k: number, mean: number, dispersion: number): number {
  return Math.exp(nbLogPmf(k, mean, dispersion));
}

/** Varianza de la binomial negativa: μ + μ²/r. */
export function nbVariance(mean: number, dispersion: number): number {
  return isPoisson(dispersion) ? mean : mean + (mean * mean) / dispersion;
}

/** [P(0), …, P(maxK−1), P(X >= maxK)] — cola plegada en el último índice; suma 1. */
export function nbPmfArray(mean: number, dispersion: number, maxK: number): number[] {
  const n = Math.max(0, Math.floor(Number.isFinite(maxK) ? maxK : 0));
  const out = new Array<number>(n + 1).fill(0);
  let s = 0;
  for (let k = 0; k < n; k++) {
    out[k] = nbPmf(k, mean, dispersion);
    s += out[k];
  }
  out[n] = Math.max(0, 1 - s);
  return out;
}

/** Convolución (distribución de la suma de dos variables independientes). Con maxK, la cola se pliega en maxK. */
export function convolve(a: number[], b: number[], maxK?: number): number[] {
  if (a.length === 0 || b.length === 0) return [];
  const full = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    if (ai === 0) continue;
    for (let j = 0; j < b.length; j++) full[i + j] += ai * b[j];
  }
  if (maxK === undefined || !Number.isFinite(maxK)) return full;
  const n = Math.max(0, Math.floor(maxK));
  if (full.length <= n + 1) {
    while (full.length < n + 1) full.push(0);
    return full;
  }
  const out = full.slice(0, n + 1);
  for (let k = n + 1; k < full.length; k++) out[n] += full[k];
  return out;
}

/** Más/Menos sobre una distribución discreta (renormalizada). Push solo en líneas enteras. */
export function overUnderFromDist(dist: number[], line: number): { over: number; under: number; push: number } {
  let over = 0;
  let under = 0;
  let push = 0;
  for (let k = 0; k < dist.length; k++) {
    const p = dist[k];
    if (k > line + 1e-9) over += p;
    else if (k < line - 1e-9) under += p;
    else push += p;
  }
  const s = over + under + push;
  if (s > 0 && Math.abs(s - 1) > 1e-15) return { over: over / s, under: under / s, push: push / s };
  return { over, under, push };
}

/** P(a > b), P(a = b), P(a < b) para variables independientes con distribuciones a y b. */
export function compareDists(a: number[], b: number[]): Prob1X2 {
  let sa = 0;
  for (const x of a) sa += x;
  let sb = 0;
  for (const x of b) sb += x;
  if (!(sa > 0) || !(sb > 0)) return { home: 0, draw: 1, away: 0 };
  // cdfB[k] = P(b <= k)
  const cdfB = new Array<number>(b.length);
  let c = 0;
  for (let k = 0; k < b.length; k++) {
    c += b[k] / sb;
    cdfB[k] = c;
  }
  let home = 0;
  let draw = 0;
  for (let k = 0; k < a.length; k++) {
    const pa = a[k] / sa;
    if (pa === 0) continue;
    const below = k === 0 ? 0 : cdfB[Math.min(k - 1, b.length - 1)];
    home += pa * below;
    if (k < b.length) draw += pa * (b[k] / sb);
  }
  const away = Math.max(0, 1 - home - draw);
  return { home, draw, away };
}

/** Dispersión r por método de momentos: μ²/(var − μ). Infinity si var <= μ (sin sobredispersión). */
export function estimateDispersion(values: number[]): number {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length < 2) return Infinity;
  const m = mean(xs);
  const v = variance(xs);
  if (!(m > 0) || v <= m) return Infinity;
  return (m * m) / (v - m);
}

/** Muestra de una binomial negativa (mezcla Gamma-Poisson) — para simulaciones/tests. */
export function sampleNegBin(meanValue: number, dispersion: number, rng: () => number = Math.random): number {
  const mu = meanValue > 0 ? meanValue : 0;
  if (mu === 0) return 0;
  const lam = isPoisson(dispersion) ? mu : sampleGamma(dispersion, mu / dispersion, rng);
  // Poisson por inversión
  let k = 0;
  let p = Math.exp(-lam);
  let s = p;
  const u = rng();
  while (u > s && k < 10_000) {
    k++;
    p *= lam / k;
    s += p;
  }
  return k;
}

/** Gamma(shape, scale) — Marsaglia & Tsang. */
function sampleGamma(shape: number, scale: number, rng: () => number): number {
  if (shape < 1) {
    const u = Math.max(rng(), 1e-300);
    return sampleGamma(shape + 1, scale, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      const u1 = Math.max(rng(), 1e-300);
      const u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}
