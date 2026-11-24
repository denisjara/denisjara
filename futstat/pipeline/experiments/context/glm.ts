/**
 * Regresión de Poisson con offset y penalización L2 (Newton-Raphson), para estimar factores multiplicativos de λ
 * sobre los residuos de un modelo de goles:  y ~ Poisson(exp(offset + x·β)),  pérdida = −logL + ½·Σ κ_j·β_j².
 * Determinista y sin estado.
 */

export interface GlmObs {
  y: number;
  offset: number;
  x: number[];
  w?: number;
}

export interface GlmFit {
  beta: number[];
  /** error estándar aproximado (inversa del hessiano penalizado) */
  se: number[];
  /** −logL medio (sin la parte constante log y!) */
  nll: number;
  n: number;
  iters: number;
}

/** Resuelve A·x = b (A simétrica definida positiva) por Cholesky; devuelve también la diagonal de A⁻¹. */
function solveSpd(A: number[][], b: number[]): { x: number[]; invDiag: number[] } {
  const n = b.length;
  const L: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) L[i][i] = Math.sqrt(Math.max(s, 1e-12));
      else L[i][j] = s / L[j][j];
    }
  }
  const fwd = (rhs: number[]) => {
    const y = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = rhs[i];
      for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
      y[i] = s / L[i][i];
    }
    return y;
  };
  const bwd = (y: number[]) => {
    const x = new Array<number>(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i];
      for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
      x[i] = s / L[i][i];
    }
    return x;
  };
  const x = bwd(fwd(b));
  const invDiag = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const e = new Array<number>(n).fill(0);
    e[i] = 1;
    invDiag[i] = bwd(fwd(e))[i];
  }
  return { x, invDiag };
}

/** Ajusta la regresión de Poisson penalizada. `kappa[j]` = penalización L2 del coeficiente j (hacia `prior[j]`, 0 por defecto). */
export function fitPoissonGlm(obs: readonly GlmObs[], kappa: readonly number[], opts: { prior?: readonly number[]; maxIter?: number } = {}): GlmFit {
  const p = kappa.length;
  const prior = opts.prior ?? new Array<number>(p).fill(0);
  let beta = prior.slice();
  const maxIter = opts.maxIter ?? 30;
  let iters = 0;
  const lossOf = (b: number[]) => {
    let l = 0;
    for (const o of obs) {
      let eta = o.offset;
      for (let j = 0; j < p; j++) eta += o.x[j] * b[j];
      const w = o.w ?? 1;
      l += w * (Math.exp(eta) - o.y * eta);
    }
    for (let j = 0; j < p; j++) l += 0.5 * kappa[j] * (b[j] - prior[j]) ** 2;
    return l;
  };
  let loss = lossOf(beta);
  let H: number[][] = [];
  for (let it = 0; it < maxIter; it++) {
    iters = it + 1;
    const g = new Array<number>(p).fill(0);
    H = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    for (const o of obs) {
      let eta = o.offset;
      for (let j = 0; j < p; j++) eta += o.x[j] * beta[j];
      const mu = Math.exp(eta);
      const w = o.w ?? 1;
      const r = w * (mu - o.y);
      for (let j = 0; j < p; j++) {
        const xj = o.x[j];
        if (xj === 0) continue;
        g[j] += r * xj;
        const hj = H[j];
        for (let k = 0; k <= j; k++) hj[k] += w * mu * xj * o.x[k];
      }
    }
    for (let j = 0; j < p; j++) {
      g[j] += kappa[j] * (beta[j] - prior[j]);
      H[j][j] += kappa[j] + 1e-9;
      for (let k = 0; k < j; k++) H[k][j] = H[j][k];
    }
    const { x: step } = solveSpd(H, g);
    // búsqueda lineal (paso de Newton amortiguado)
    let t = 1;
    let next = beta.map((b, j) => b - t * step[j]);
    let nl = lossOf(next);
    while (nl > loss && t > 1e-4) {
      t *= 0.5;
      next = beta.map((b, j) => b - t * step[j]);
      nl = lossOf(next);
    }
    const delta = Math.max(...step.map((s) => Math.abs(s * t)));
    beta = next;
    const conv = Math.abs(loss - nl) < 1e-10 * Math.max(1, Math.abs(loss)) || delta < 1e-8;
    loss = nl;
    if (conv) break;
  }
  const se = p ? solveSpd(H, new Array<number>(p).fill(0)).invDiag.map((v) => Math.sqrt(Math.max(0, v))) : [];
  let sw = 0;
  for (const o of obs) sw += o.w ?? 1;
  return { beta, se, nll: sw ? loss / sw : 0, n: obs.length, iters };
}
