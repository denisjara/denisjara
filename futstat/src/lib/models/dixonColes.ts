/**
 * Modelo Dixon-Coles (1997) con ponderación temporal y regularización bayesiana.
 *
 *   λ_local = base · attack[h] · defence[a] · homeAdv
 *   λ_visit = base · attack[a] · defence[h]
 *   P(x, y) = τ(x, y; λ_local, λ_visit, ρ) · Pois(x; λ_local) · Pois(y; λ_visit)
 *
 * Ajuste por máxima verosimilitud ponderada (w = exp(−ξ·días) · weight):
 *  - ataque/defensa/base/ventaja local mediante actualizaciones de punto fijo tipo Maher / IPF
 *    (ecuaciones de score de la Poisson), incluyendo el término de τ como "goles ajustados",
 *    de modo que el punto fijo es el MLE exacto de Dixon-Coles para un ρ dado;
 *  - pseudo-observaciones (priorWeight partidos con rendimiento medio) que contraen hacia 1 a los
 *    equipos con pocos datos (equivale a un prior Gamma con moda 1);
 *  - restricción de identificabilidad: media geométrica 1 en ataque y en defensa;
 *  - ρ por búsqueda de sección áurea en [−0.2, 0.2] (la log-verosimilitud es cóncava en ρ),
 *    alternando con el ajuste de fuerzas hasta convergencia.
 */
import { logFactorial } from './stats';

export interface DCMatch {
  home: string;
  away: string;
  hg: number;
  ag: number;
  date: string;
  neutral?: boolean;
  weight?: number;
}

export interface DCModel {
  teams: string[];
  attack: Record<string, number>;
  defence: Record<string, number>;
  base: number;
  homeAdv: number;
  rho: number;
  nMatches: number;
  logLik: number;
  matchesByTeam: Record<string, number>;
}

export interface DCFitOptions {
  /** fecha de referencia (ISO); los partidos se ponderan por antigüedad respecto a ella */
  refDate: string;
  /** decaimiento temporal por día (0 = sin ponderación temporal) */
  xi: number;
  maxIter?: number;
  tol?: number;
  /** peso del prior, en partidos equivalentes de rendimiento medio (default 2) */
  priorWeight?: number;
}

const DAY_MS = 86_400_000;
const RHO_MIN = -0.2;
const RHO_MAX = 0.2;

/** log τ y sus derivadas respecto a log λ_local y log λ_visit para un marcador observado. */
function tauTerms(x: number, y: number, lh: number, la: number, rho: number): { logTau: number; dH: number; dA: number } {
  if (x === 0 && y === 0) {
    const t = 1 - lh * la * rho;
    if (t <= 0) return { logTau: -Infinity, dH: 0, dA: 0 };
    const d = (-lh * la * rho) / t;
    return { logTau: Math.log(t), dH: d, dA: d };
  }
  if (x === 0 && y === 1) {
    const t = 1 + lh * rho;
    if (t <= 0) return { logTau: -Infinity, dH: 0, dA: 0 };
    return { logTau: Math.log(t), dH: (lh * rho) / t, dA: 0 };
  }
  if (x === 1 && y === 0) {
    const t = 1 + la * rho;
    if (t <= 0) return { logTau: -Infinity, dH: 0, dA: 0 };
    return { logTau: Math.log(t), dH: 0, dA: (la * rho) / t };
  }
  if (x === 1 && y === 1) {
    const t = 1 - rho;
    return { logTau: t > 0 ? Math.log(t) : -Infinity, dH: 0, dA: 0 };
  }
  return { logTau: 0, dH: 0, dA: 0 };
}

function emptyModel(): DCModel {
  return {
    teams: [],
    attack: {},
    defence: {},
    base: 1.3,
    homeAdv: 1,
    rho: 0,
    nMatches: 0,
    logLik: 0,
    matchesByTeam: {},
  };
}

export function fitDixonColes(matches: DCMatch[], opts: DCFitOptions): DCModel {
  const ref = Date.parse(opts.refDate);
  const xi = Number.isFinite(opts.xi) && opts.xi > 0 ? opts.xi : 0;
  const maxIter = Math.max(1, Math.floor(opts.maxIter ?? 300));
  const tol = opts.tol && opts.tol > 0 ? opts.tol : 1e-7;
  const priorWeight = opts.priorWeight !== undefined && opts.priorWeight >= 0 ? opts.priorWeight : 2;

  // ---- datos válidos
  const valid: { m: DCMatch; w: number }[] = [];
  for (const m of matches) {
    if (!m || !m.home || !m.away || m.home === m.away) continue;
    if (!Number.isInteger(m.hg) || !Number.isInteger(m.ag) || m.hg < 0 || m.ag < 0) continue;
    const t = Date.parse(m.date);
    const days = Number.isFinite(t) && Number.isFinite(ref) ? Math.max(0, (ref - t) / DAY_MS) : 0;
    const w = Math.exp(-xi * days) * (m.weight === undefined ? 1 : m.weight);
    if (!(w > 0) || !Number.isFinite(w)) continue;
    valid.push({ m, w });
  }
  if (valid.length === 0) return emptyModel();

  const teams = [...new Set(valid.flatMap(({ m }) => [m.home, m.away]))].sort();
  const T = teams.length;
  const index = new Map(teams.map((t, i) => [t, i]));
  const N = valid.length;
  const hi = new Int32Array(N);
  const ai = new Int32Array(N);
  const hg = new Float64Array(N);
  const ag = new Float64Array(N);
  const w = new Float64Array(N);
  const nonNeutral = new Uint8Array(N);
  const counts = new Array<number>(T).fill(0);
  let sw = 0;
  let swGoals = 0;
  let swHomeG = 0;
  let swAwayG = 0;
  let anyHome = false;
  for (let k = 0; k < N; k++) {
    const { m, w: wk } = valid[k];
    hi[k] = index.get(m.home)!;
    ai[k] = index.get(m.away)!;
    hg[k] = m.hg;
    ag[k] = m.ag;
    w[k] = wk;
    nonNeutral[k] = m.neutral ? 0 : 1;
    counts[hi[k]]++;
    counts[ai[k]]++;
    sw += wk;
    swGoals += wk * (m.hg + m.ag);
    if (!m.neutral) {
      anyHome = true;
      swHomeG += wk * m.hg;
      swAwayG += wk * m.ag;
    }
  }

  // ---- inicialización
  const gbar = Math.max(0.05, swGoals / (2 * sw)); // goles medios por equipo y partido
  let homeAdv = anyHome && swAwayG > 0 && swHomeG > 0 ? Math.min(2.5, Math.max(0.5, swHomeG / swAwayG)) : 1;
  let base = Math.max(0.05, (2 * gbar) / (1 + homeAdv));
  const att = new Float64Array(T).fill(1);
  const def = new Float64Array(T).fill(1);
  const prior = priorWeight * gbar; // pseudo-goles (= pseudo-goles esperados) por equipo

  const lamH = new Float64Array(N);
  const lamA = new Float64Array(N);
  const yH = new Float64Array(N); // goles ajustados por τ (ecuación de score)
  const yA = new Float64Array(N);
  const num = new Float64Array(T);
  const den = new Float64Array(T);

  const computeLambdas = () => {
    for (let k = 0; k < N; k++) {
      const ha = nonNeutral[k] ? homeAdv : 1;
      lamH[k] = base * att[hi[k]] * def[ai[k]] * ha;
      lamA[k] = base * att[ai[k]] * def[hi[k]];
    }
  };

  const prevAtt = new Float64Array(T);
  const prevDef = new Float64Array(T);
  const fitStrengths = (rho: number) => {
    for (let iter = 0; iter < maxIter; iter++) {
      prevAtt.set(att);
      prevDef.set(def);
      const prevBase = base;
      const prevHome = homeAdv;
      computeLambdas();
      for (let k = 0; k < N; k++) {
        if (rho !== 0 && hg[k] < 2 && ag[k] < 2) {
          const t = tauTerms(hg[k], ag[k], lamH[k], lamA[k], rho);
          // sin recortar por partido: la ecuación de score se cumple sobre la suma
          yH[k] = hg[k] + t.dH;
          yA[k] = ag[k] + t.dA;
        } else {
          yH[k] = hg[k];
          yA[k] = ag[k];
        }
      }
      // ataque
      num.fill(prior);
      den.fill(prior);
      for (let k = 0; k < N; k++) {
        const h = hi[k];
        const a = ai[k];
        const ha = nonNeutral[k] ? homeAdv : 1;
        num[h] += w[k] * yH[k];
        den[h] += w[k] * base * def[a] * ha;
        num[a] += w[k] * yA[k];
        den[a] += w[k] * base * def[h];
      }
      for (let t = 0; t < T; t++) att[t] = Math.max(1e-4, num[t] / den[t]);
      // defensa
      num.fill(prior);
      den.fill(prior);
      for (let k = 0; k < N; k++) {
        const h = hi[k];
        const a = ai[k];
        const ha = nonNeutral[k] ? homeAdv : 1;
        num[h] += w[k] * yA[k];
        den[h] += w[k] * base * att[a];
        num[a] += w[k] * yH[k];
        den[a] += w[k] * base * att[h] * ha;
      }
      for (let t = 0; t < T; t++) def[t] = Math.max(1e-4, num[t] / den[t]);
      // restricción: media geométrica 1
      let la = 0;
      let ld = 0;
      for (let t = 0; t < T; t++) {
        la += Math.log(att[t]);
        ld += Math.log(def[t]);
      }
      const ga = Math.exp(la / T);
      const gd = Math.exp(ld / T);
      for (let t = 0; t < T; t++) {
        att[t] /= ga;
        def[t] /= gd;
      }
      base *= ga * gd;
      // ventaja local
      if (anyHome) {
        let nh = 0;
        let dh = 0;
        for (let k = 0; k < N; k++) {
          if (!nonNeutral[k]) continue;
          nh += w[k] * yH[k];
          dh += w[k] * base * att[hi[k]] * def[ai[k]];
        }
        if (nh > 0 && dh > 0) homeAdv = nh / dh;
      }
      // nivel base
      let nb = 0;
      let db = 0;
      for (let k = 0; k < N; k++) {
        const ha = nonNeutral[k] ? homeAdv : 1;
        nb += w[k] * (yH[k] + yA[k]);
        db += w[k] * (att[hi[k]] * def[ai[k]] * ha + att[ai[k]] * def[hi[k]]);
      }
      if (nb > 0 && db > 0) base = nb / db;
      // convergencia sobre los parámetros ya normalizados
      let maxChange = Math.max(Math.abs(Math.log(base / prevBase)), Math.abs(Math.log(homeAdv / prevHome)));
      for (let t = 0; t < T; t++) {
        maxChange = Math.max(maxChange, Math.abs(Math.log(att[t] / prevAtt[t])), Math.abs(Math.log(def[t] / prevDef[t])));
      }
      if (maxChange < tol) break;
    }
    computeLambdas();
  };

  // log-verosimilitud (solo términos que dependen de ρ) con λ fijos
  const lowIdx: number[] = [];
  for (let k = 0; k < N; k++) if (hg[k] < 2 && ag[k] < 2) lowIdx.push(k);
  const rhoLogLik = (rho: number): number => {
    let s = 0;
    for (const k of lowIdx) {
      const t = tauTerms(hg[k], ag[k], lamH[k], lamA[k], rho).logTau;
      if (t === -Infinity) return -Infinity;
      s += w[k] * t;
    }
    return s;
  };
  const searchRho = (): number => {
    // sección áurea (función cóncava); los infactibles valen -Infinity
    const g = (Math.sqrt(5) - 1) / 2;
    let a = RHO_MIN;
    let b = RHO_MAX;
    let c = b - g * (b - a);
    let d = a + g * (b - a);
    let fc = rhoLogLik(c);
    let fd = rhoLogLik(d);
    for (let it = 0; it < 80 && b - a > 1e-7; it++) {
      if (fc >= fd) {
        b = d;
        d = c;
        fd = fc;
        c = b - g * (b - a);
        fc = rhoLogLik(c);
      } else {
        a = c;
        c = d;
        fc = fd;
        d = a + g * (b - a);
        fd = rhoLogLik(d);
      }
    }
    const r = (a + b) / 2;
    return Number.isFinite(rhoLogLik(r)) ? r : 0;
  };

  let rho = 0;
  fitStrengths(rho);
  for (let outer = 0; outer < 6; outer++) {
    const next = searchRho();
    const delta = Math.abs(next - rho);
    rho = next;
    fitStrengths(rho);
    if (delta < 1e-5) break;
  }

  // log-verosimilitud completa ponderada
  let logLik = 0;
  for (let k = 0; k < N; k++) {
    const lt = hg[k] < 2 && ag[k] < 2 ? tauTerms(hg[k], ag[k], lamH[k], lamA[k], rho).logTau : 0;
    logLik +=
      w[k] *
      (lt +
        hg[k] * Math.log(lamH[k]) -
        lamH[k] -
        logFactorial(hg[k]) +
        ag[k] * Math.log(lamA[k]) -
        lamA[k] -
        logFactorial(ag[k]));
  }

  const attack: Record<string, number> = {};
  const defence: Record<string, number> = {};
  const matchesByTeam: Record<string, number> = {};
  teams.forEach((t, i) => {
    attack[t] = att[i];
    defence[t] = def[i];
    matchesByTeam[t] = counts[i];
  });
  return { teams, attack, defence, base, homeAdv, rho, nMatches: N, logLik, matchesByTeam };
}

/** Goles esperados de un partido según el modelo. null si falta algún equipo. */
export function predictDC(
  model: DCModel,
  home: string,
  away: string,
  neutral = false,
): { lambdaHome: number; lambdaAway: number } | null {
  const ah = model.attack[home];
  const aa = model.attack[away];
  const dh = model.defence[home];
  const da = model.defence[away];
  if (ah === undefined || aa === undefined || dh === undefined || da === undefined) return null;
  return {
    lambdaHome: model.base * ah * da * (neutral ? 1 : model.homeAdv),
    lambdaAway: model.base * aa * dh,
  };
}

/** Log-verosimilitud DC (no ponderada) de un conjunto de partidos con el modelo dado (validación). */
export function dcLogLik(model: DCModel, matches: DCMatch[]): number {
  let s = 0;
  for (const m of matches) {
    const p = predictDC(model, m.home, m.away, m.neutral);
    if (!p) continue;
    const lt = m.hg < 2 && m.ag < 2 ? tauTerms(m.hg, m.ag, p.lambdaHome, p.lambdaAway, model.rho).logTau : 0;
    s +=
      lt +
      m.hg * Math.log(p.lambdaHome) -
      p.lambdaHome -
      logFactorial(m.hg) +
      m.ag * Math.log(p.lambdaAway) -
      p.lambdaAway -
      logFactorial(m.ag);
  }
  return s;
}
