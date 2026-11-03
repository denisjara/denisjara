/**
 * Conversión de cuotas y eliminación del margen (vig) de la casa.
 */
import { round } from './stats';

/**
 * Cuota americana → decimal (redondeada a 3 decimales).
 * "+105" → 2.05, "-140" → 1.714, "EVEN" → 2. undefined si no es válida (|ml| < 100, vacía, texto).
 */
export function americanToDecimal(ml: number | string | undefined | null): number | undefined {
  if (ml === undefined || ml === null) return undefined;
  let n: number;
  if (typeof ml === 'number') {
    n = ml;
  } else {
    const s = ml.trim().toUpperCase();
    if (s === '') return undefined;
    if (s === 'EVEN' || s === 'EV' || s === 'EVS') return 2;
    if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return undefined;
    n = Number(s);
  }
  if (!Number.isFinite(n)) return undefined;
  if (n >= 100) return round(1 + n / 100, 3);
  if (n <= -100) return round(1 + 100 / -n, 3);
  return undefined;
}

/** Cuota decimal → americana (número). */
export function decimalToAmerican(decimalOdds: number): number | undefined {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) return undefined;
  return decimalOdds >= 2 ? Math.round((decimalOdds - 1) * 100) : Math.round(-100 / (decimalOdds - 1));
}

/** Probabilidad implícita bruta 1/cuota (0 si la cuota no es válida). */
export function impliedProb(decimalOdds: number): number {
  return Number.isFinite(decimalOdds) && decimalOdds > 0 ? 1 / decimalOdds : 0;
}

/** Margen de la casa: Σ(1/cuota) − 1. */
export function overround(decimalOdds: number[]): number {
  let s = 0;
  for (const o of decimalOdds) s += impliedProb(o);
  return s - 1;
}

/** Cuota justa 1/p, con máximo 1000. */
export function fairOdds(p: number): number {
  if (!(p > 0)) return 1000;
  return Math.min(1000, 1 / Math.min(1, p));
}

export type DevigMethod = 'multiplicative' | 'power' | 'shin';

export interface DevigResult {
  probs: number[];
  /** margen original (overround) */
  margin: number;
  method: DevigMethod;
  /** z de Shin (proporción de insider trading) o exponente k del método potencia; 1/0 en multiplicativo */
  param: number;
}

function multiplicative(pi: number[]): number[] {
  const s = pi.reduce((a, b) => a + b, 0);
  return s > 0 ? pi.map((p) => p / s) : pi.map(() => 1 / pi.length);
}

/** Shin (1993): p_i = [√(z² + 4(1−z)π_i²/Π) − z] / [2(1−z)], z resuelto por bisección para Σp = 1. */
function shinProbs(pi: number[], z: number, booksum: number): number[] {
  return pi.map((p) => (Math.sqrt(z * z + (4 * (1 - z) * p * p) / booksum) - z) / (2 * (1 - z)));
}

function solveShin(pi: number[]): { probs: number[]; z: number } {
  const booksum = pi.reduce((a, b) => a + b, 0);
  const f = (z: number) => shinProbs(pi, z, booksum).reduce((a, b) => a + b, 0) - 1;
  let lo = 0;
  let hi = 0.999;
  if (f(lo) <= 0) return { probs: multiplicative(pi), z: 0 };
  for (let it = 0; it < 200 && hi - lo > 1e-14; it++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  const z = 0.5 * (lo + hi);
  return { probs: multiplicative(shinProbs(pi, z, booksum)), z };
}

/** Método potencia: p_i = π_i^k con k tal que Σ π_i^k = 1 (bisección en log k). */
function solvePower(pi: number[]): { probs: number[]; k: number } {
  if (pi.some((p) => p >= 1)) return { probs: multiplicative(pi), k: 1 };
  const f = (k: number) => pi.reduce((a, p) => a + Math.pow(p, k), 0) - 1;
  let lo = Math.log(1e-3);
  let hi = Math.log(1e3);
  if (f(Math.exp(lo)) < 0 || f(Math.exp(hi)) > 0) return { probs: multiplicative(pi), k: 1 };
  for (let it = 0; it < 200 && hi - lo > 1e-14; it++) {
    const mid = 0.5 * (lo + hi);
    if (f(Math.exp(mid)) > 0) lo = mid;
    else hi = mid;
  }
  const k = Math.exp(0.5 * (lo + hi));
  return { probs: multiplicative(pi.map((p) => Math.pow(p, k))), k };
}

/**
 * Elimina el margen y devuelve probabilidades que suman 1, con detalle del método.
 * Las cuotas no válidas (no finitas o <= 1) reciben probabilidad 0 y el resto se reparte entre las válidas.
 */
export function devigDetailed(decimalOdds: number[], method: DevigMethod = 'shin'): DevigResult {
  const n = decimalOdds.length;
  const valid = decimalOdds.map((o) => Number.isFinite(o) && o > 1);
  const idx: number[] = [];
  valid.forEach((v, i) => v && idx.push(i));
  const out = new Array<number>(n).fill(0);
  if (idx.length === 0) return { probs: out, margin: 0, method, param: 0 };
  const pi = idx.map((i) => 1 / decimalOdds[i]);
  const margin = pi.reduce((a, b) => a + b, 0) - 1;
  let probs: number[];
  let param = 1;
  if (idx.length === 1) {
    probs = [1];
  } else if (method === 'multiplicative') {
    probs = multiplicative(pi);
  } else if (method === 'power') {
    const r = solvePower(pi);
    probs = r.probs;
    param = r.k;
  } else {
    if (margin <= 0) {
      probs = multiplicative(pi);
      param = 0;
    } else {
      const r = solveShin(pi);
      probs = r.probs;
      param = r.z;
    }
  }
  idx.forEach((i, k) => (out[i] = probs[k]));
  return { probs: out, margin, method, param };
}

/** Probabilidades sin margen (default: Shin). Suman 1. */
export function devig(decimalOdds: number[], method: DevigMethod = 'shin'): number[] {
  return devigDetailed(decimalOdds, method).probs;
}
