/**
 * Combinación de fuentes de probabilidad e inversión 1X2 → (λ local, λ visitante).
 */
import type { Prob1X2 } from '../../types/data';
import { dcTau } from './poisson';

const UNIFORM: Prob1X2 = { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };

function normalized(p: Prob1X2): Prob1X2 | null {
  const h = Number.isFinite(p.home) && p.home > 0 ? p.home : 0;
  const d = Number.isFinite(p.draw) && p.draw > 0 ? p.draw : 0;
  const a = Number.isFinite(p.away) && p.away > 0 ? p.away : 0;
  const s = h + d + a;
  return s > 0 ? { home: h / s, draw: d / s, away: a / s } : null;
}

/** Pool lineal: Σ w_i·p_i con pesos renormalizados; ignora pesos <= 0 y fuentes inválidas. */
export function blend(sources: { probs: Prob1X2; weight: number }[]): Prob1X2 {
  let sw = 0;
  let h = 0;
  let d = 0;
  let a = 0;
  for (const s of sources) {
    if (!(s.weight > 0) || !Number.isFinite(s.weight)) continue;
    const p = normalized(s.probs);
    if (!p) continue;
    sw += s.weight;
    h += s.weight * p.home;
    d += s.weight * p.draw;
    a += s.weight * p.away;
  }
  if (!(sw > 0)) return { ...UNIFORM };
  return { home: h / sw, draw: d / sw, away: a / sw };
}

/** Pool logarítmico (geométrico ponderado, renormalizado): más "decidido" que el lineal. */
export function blendLog(sources: { probs: Prob1X2; weight: number }[]): Prob1X2 {
  let sw = 0;
  let lh = 0;
  let ld = 0;
  let la = 0;
  for (const s of sources) {
    if (!(s.weight > 0) || !Number.isFinite(s.weight)) continue;
    const p = normalized(s.probs);
    if (!p) continue;
    sw += s.weight;
    lh += s.weight * Math.log(Math.max(p.home, 1e-12));
    ld += s.weight * Math.log(Math.max(p.draw, 1e-12));
    la += s.weight * Math.log(Math.max(p.away, 1e-12));
  }
  if (!(sw > 0)) return { ...UNIFORM };
  const h = Math.exp(lh / sw);
  const d = Math.exp(ld / sw);
  const a = Math.exp(la / sw);
  const s = h + d + a;
  return { home: h / s, draw: d / s, away: a / s };
}

// ---------------------------------------------------------------------------
// fitLambdas: invierte el modelo DC
// ---------------------------------------------------------------------------

const L_MIN = 0.05;
const L_MAX = 6;
const U_MIN = Math.log(L_MIN);
const U_MAX = Math.log(L_MAX);
const MAX_GOALS = 10;

/** 1X2 y Más de 2.5 de la matriz DC (mismo truncado/normalización que scoreMatrix(·,·,rho,10)). */
export function dcOutcomes(lh: number, la: number, rho: number): { home: number; draw: number; away: number; over25: number } {
  const ph = new Float64Array(MAX_GOALS + 1);
  const pa = new Float64Array(MAX_GOALS + 1);
  ph[0] = Math.exp(-lh);
  pa[0] = Math.exp(-la);
  for (let k = 1; k <= MAX_GOALS; k++) {
    ph[k] = (ph[k - 1] * lh) / k;
    pa[k] = (pa[k - 1] * la) / k;
  }
  let home = 0;
  let draw = 0;
  let away = 0;
  let over = 0;
  let total = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      let v = ph[i] * pa[j];
      if (i < 2 && j < 2) v *= dcTau(i, j, lh, la, rho);
      total += v;
      if (i > j) home += v;
      else if (i === j) draw += v;
      else away += v;
      if (i + j >= 3) over += v;
    }
  }
  if (!(total > 0)) return { home: 1 / 3, draw: 1 / 3, away: 1 / 3, over25: 0.5 };
  return { home: home / total, draw: draw / total, away: away / total, over25: over / total };
}

type Vec2 = [number, number];

function clampU(u: Vec2): Vec2 {
  return [Math.min(U_MAX, Math.max(U_MIN, u[0])), Math.min(U_MAX, Math.max(U_MIN, u[1]))];
}

/**
 * Busca (λh, λa) ∈ [0.05, 6]² cuya matriz Dixon-Coles reproduzca el objetivo 1X2 (y opcionalmente
 * P(Más de 2.5)) por mínimos cuadrados. Levenberg-Marquardt en log-λ con varios arranques y
 * Nelder-Mead de respaldo.
 */
export function fitLambdas(
  target: { home: number; draw: number; away: number; over25?: number },
  rho: number,
  init: { lambdaHome: number; lambdaAway: number },
): { lambdaHome: number; lambdaAway: number } {
  const safe = (x: number, d: number) => (Number.isFinite(x) && x > 0 ? x : d);
  const initU = clampU([Math.log(safe(init?.lambdaHome, 1.4)), Math.log(safe(init?.lambdaAway, 1.1))]);
  const t = normalized(target);
  const r = Number.isFinite(rho) ? rho : 0;
  if (!t) return { lambdaHome: Math.exp(initU[0]), lambdaAway: Math.exp(initU[1]) };
  const hasOver = typeof target.over25 === 'number' && Number.isFinite(target.over25) && target.over25 >= 0 && target.over25 <= 1;
  const tOver = hasOver ? (target.over25 as number) : 0;

  const residuals = (u: Vec2): number[] => {
    const o = dcOutcomes(Math.exp(u[0]), Math.exp(u[1]), r);
    const res = [o.home - t.home, o.draw - t.draw, o.away - t.away];
    if (hasOver) res.push(o.over25 - tOver);
    return res;
  };
  const objective = (u: Vec2): number => residuals(clampU(u)).reduce((s, x) => s + x * x, 0);

  const levenbergMarquardt = (start: Vec2): { u: Vec2; f: number } => {
    let u = clampU(start);
    let res = residuals(u);
    let f = res.reduce((s, x) => s + x * x, 0);
    let mu = 1e-3;
    const h = 1e-6;
    for (let iter = 0; iter < 60 && f > 1e-20; iter++) {
      // Jacobiano por diferencias centrales
      const J: number[][] = res.map(() => [0, 0]);
      for (let p = 0; p < 2; p++) {
        const up: Vec2 = [...u] as Vec2;
        const dn: Vec2 = [...u] as Vec2;
        up[p] += h;
        dn[p] -= h;
        const rp = residuals(up);
        const rn = residuals(dn);
        for (let i = 0; i < res.length; i++) J[i][p] = (rp[i] - rn[i]) / (2 * h);
      }
      let a00 = 0;
      let a01 = 0;
      let a11 = 0;
      let g0 = 0;
      let g1 = 0;
      for (let i = 0; i < res.length; i++) {
        a00 += J[i][0] * J[i][0];
        a01 += J[i][0] * J[i][1];
        a11 += J[i][1] * J[i][1];
        g0 += J[i][0] * res[i];
        g1 += J[i][1] * res[i];
      }
      let improved = false;
      for (let tries = 0; tries < 12; tries++) {
        const b00 = a00 * (1 + mu) + 1e-12;
        const b11 = a11 * (1 + mu) + 1e-12;
        const det = b00 * b11 - a01 * a01;
        if (!(Math.abs(det) > 0)) {
          mu *= 10;
          continue;
        }
        const d0 = -(b11 * g0 - a01 * g1) / det;
        const d1 = -(-a01 * g0 + b00 * g1) / det;
        const cand = clampU([u[0] + d0, u[1] + d1]);
        const rc = residuals(cand);
        const fc = rc.reduce((s, x) => s + x * x, 0);
        if (fc < f) {
          const step = Math.abs(cand[0] - u[0]) + Math.abs(cand[1] - u[1]);
          u = cand;
          res = rc;
          f = fc;
          mu = Math.max(1e-9, mu / 4);
          improved = true;
          if (step < 1e-12) iter = Infinity;
          break;
        }
        mu *= 6;
      }
      if (!improved) break;
    }
    return { u, f };
  };

  const nelderMead = (start: Vec2): { u: Vec2; f: number } => {
    let simplex: { u: Vec2; f: number }[] = [
      start,
      [start[0] + 0.2, start[1]] as Vec2,
      [start[0], start[1] + 0.2] as Vec2,
    ].map((u) => ({ u: clampU(u), f: objective(u) }));
    for (let it = 0; it < 400; it++) {
      simplex.sort((a, b) => a.f - b.f);
      const [best, mid, worst] = simplex;
      if (worst.f - best.f < 1e-18 && Math.abs(worst.u[0] - best.u[0]) + Math.abs(worst.u[1] - best.u[1]) < 1e-10) break;
      const c: Vec2 = [(best.u[0] + mid.u[0]) / 2, (best.u[1] + mid.u[1]) / 2];
      const at = (k: number): { u: Vec2; f: number } => {
        const u = clampU([c[0] + k * (worst.u[0] - c[0]), c[1] + k * (worst.u[1] - c[1])]);
        return { u, f: objective(u) };
      };
      const refl = at(-1);
      if (refl.f < best.f) {
        const exp = at(-2);
        simplex[2] = exp.f < refl.f ? exp : refl;
      } else if (refl.f < mid.f) {
        simplex[2] = refl;
      } else {
        const con = refl.f < worst.f ? at(-0.5) : at(0.5);
        if (con.f < Math.min(refl.f, worst.f)) simplex[2] = con;
        else {
          simplex = simplex.map((s, i) =>
            i === 0
              ? s
              : (() => {
                  const u = clampU([(s.u[0] + best.u[0]) / 2, (s.u[1] + best.u[1]) / 2]);
                  return { u, f: objective(u) };
                })(),
          );
        }
      }
    }
    simplex.sort((a, b) => a.f - b.f);
    return simplex[0];
  };

  let best = levenbergMarquardt(initU);
  if (best.f > 1e-14) {
    const starts: Vec2[] = [
      [Math.log(1.4), Math.log(1.1)],
      [Math.log(1.1), Math.log(1.4)],
      [Math.log(2.4), Math.log(0.7)],
      [Math.log(0.7), Math.log(2.4)],
      [Math.log(0.6), Math.log(0.6)],
      [Math.log(3), Math.log(3)],
    ];
    for (const s of starts) {
      const r2 = levenbergMarquardt(s);
      if (r2.f < best.f) best = r2;
      if (best.f <= 1e-14) break;
    }
    if (best.f > 1e-10) {
      const nm = nelderMead(best.u);
      if (nm.f < best.f) {
        const polished = levenbergMarquardt(nm.u);
        best = polished.f < nm.f ? polished : nm;
      }
    }
  }
  return { lambdaHome: Math.exp(best.u[0]), lambdaAway: Math.exp(best.u[1]) };
}
