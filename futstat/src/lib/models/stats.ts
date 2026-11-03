/**
 * Utilidades estadísticas básicas (puras, sin dependencias, Node + navegador).
 */

/** Suma simple (Kahan) — estable para vectores largos de probabilidades. */
export function sum(xs: readonly number[]): number {
  let s = 0;
  let c = 0;
  for (let i = 0; i < xs.length; i++) {
    const y = xs[i] - c;
    const t = s + y;
    c = t - s - y;
    s = t;
  }
  return s;
}

/** Media aritmética. 0 para vectores vacíos. */
export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : sum(xs) / xs.length;
}

/** Varianza muestral (denominador n-1). 0 si n < 2. */
export function variance(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m;
    ss += d * d;
  }
  return ss / (n - 1);
}

/** Desviación típica muestral. */
export function stdDev(xs: readonly number[]): number {
  return Math.sqrt(variance(xs));
}

/** Media ponderada. 0 si la suma de pesos es <= 0. */
export function weightedMean(xs: readonly number[], ws: readonly number[]): number {
  let sw = 0;
  let s = 0;
  const n = Math.min(xs.length, ws.length);
  for (let i = 0; i < n; i++) {
    sw += ws[i];
    s += xs[i] * ws[i];
  }
  return sw > 0 ? s / sw : 0;
}

/** Cuantil (interpolación lineal, tipo 7 de R). q en [0,1]. NaN si vacío. */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Mediana. NaN si vacío. */
export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5);
}

/** Correlación de Pearson. 0 si alguna serie es constante o hay < 2 pares. */
export function correlation(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Redondeo a `digits` decimales (por defecto 3), simétrico respecto a 0. */
export function round(x: number, digits = 3): number {
  if (!Number.isFinite(x)) return x;
  const f = Math.pow(10, digits);
  const r = Math.round(Math.abs(x) * f * (1 + Number.EPSILON)) / f;
  return x < 0 ? (r === 0 ? 0 : -r) : r;
}

/**
 * Media móvil exponencial de una serie cronológica (más reciente al final).
 * Peso de la observación con antigüedad a (0 = la última): (1-alpha)^a, normalizado
 * (equivale a la EWMA recursiva con corrección de sesgo inicial).
 * alpha = 1 → último valor; alpha = 0 → media simple. 0 si la serie está vacía.
 */
export function ewma(xs: readonly number[], alpha: number): number {
  const n = xs.length;
  if (n === 0) return 0;
  const a = clamp(alpha, 0, 1);
  if (a >= 1) return xs[n - 1];
  const decay = 1 - a;
  let w = 1;
  let sw = 0;
  let s = 0;
  for (let i = n - 1; i >= 0; i--) {
    s += w * xs[i];
    sw += w;
    w *= decay;
    if (w < 1e-12) break;
  }
  return s / sw;
}

/** Contracción bayesiana hacia una media previa: (sampleMean·n + priorMean·priorN)/(n+priorN). */
export function shrink(sampleMean: number, n: number, priorMean: number, priorN: number): number {
  const d = n + priorN;
  if (!(d > 0)) return priorMean;
  return (sampleMean * n + priorMean * priorN) / d;
}

/** log(Σ exp(x_i)) estable. -Infinity si vacío. */
export function logSumExp(xs: readonly number[]): number {
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  if (!Number.isFinite(m)) return m;
  let s = 0;
  for (const x of xs) s += Math.exp(x - m);
  return m + Math.log(s);
}

/** Normaliza un vector no negativo para que sume 1 (uniforme si la suma es 0). */
export function normalize(xs: readonly number[]): number[] {
  const s = sum(xs);
  if (!(s > 0)) return xs.map(() => (xs.length ? 1 / xs.length : 0));
  return xs.map((x) => x / s);
}

// ---------------------------------------------------------------------------
// Funciones especiales
// ---------------------------------------------------------------------------

const LANCZOS_G = 7;
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
const HALF_LOG_2PI = 0.5 * Math.log(2 * Math.PI);

/**
 * log|Γ(x)| (aproximación de Lanczos g=7, n=9; error relativo ~1e-15).
 * Usa la fórmula de reflexión para x < 0.5. +Infinity en los polos (0, -1, -2...).
 */
export function lgamma(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (x < 0.5) {
    if (Number.isInteger(x)) return Infinity;
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  }
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS.length; i++) a += LANCZOS[i] / (z + i);
  return HALF_LOG_2PI + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

const LOG_FACT_TABLE_SIZE = 1024;
let logFactTable: Float64Array | null = null;

function getLogFactTable(): Float64Array {
  if (logFactTable) return logFactTable;
  const t = new Float64Array(LOG_FACT_TABLE_SIZE + 1);
  t[0] = 0;
  for (let i = 1; i <= LOG_FACT_TABLE_SIZE; i++) t[i] = t[i - 1] + Math.log(i);
  logFactTable = t;
  return t;
}

/** log(k!) (exacto por tabla hasta 1024, lgamma(k+1) después o para k no entero). */
export function logFactorial(k: number): number {
  if (k < 0) return NaN;
  if (Number.isInteger(k) && k <= LOG_FACT_TABLE_SIZE) return getLogFactTable()[k];
  return lgamma(k + 1);
}

// ---------------------------------------------------------------------------
// Aleatoriedad reproducible (simulaciones Monte Carlo, tests)
// ---------------------------------------------------------------------------

/** Generador pseudoaleatorio con semilla (mulberry32). Devuelve uniformes en [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Muestra un índice de una distribución discreta (probs no necesitan sumar 1). */
export function sampleDiscrete(probs: readonly number[], rng: () => number = Math.random): number {
  let total = 0;
  for (const p of probs) total += p > 0 ? p : 0;
  if (!(total > 0)) return 0;
  let u = rng() * total;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i] > 0 ? probs[i] : 0;
    if (u < p) return i;
    u -= p;
  }
  return probs.length - 1;
}
