/**
 * Combinador aprendido walk-forward de las variantes «stack*».
 *
 * Modelo: pool logarítmico generalizado (regresión logística multinomial con estructura local/visitante):
 *
 *   S  = Σ_s u_s · log(p_s,H / p_s,A) + β_S + rasgos de fuerza          (contraste local − visitante)
 *   Dr = Σ_s v_s · [log p_s,D − ½(log p_s,H + log p_s,A)] + β_D + rasgos de empate
 *   p  = softmax(½S, Dr, −½S)
 *
 * Con u_s = v_s = w_s y sin intercepto ni rasgos es exactamente el pool logarítmico Σ w_s log p_s; con u ≠ v los
 * pesos del contraste de empate se aprenden aparte (corrección de empates); la escala de los pesos hace de
 * temperatura. Fuentes: mercado sin margen, Dixon-Coles, Elo→goles (cruces entre ligas; excluyente con DC) y Elo.
 *
 * Ajuste: log-verosimilitud multinomial (Newton con búsqueda lineal) con penalización L2 HACIA un prior que imita los
 * pesos de producción (con pocas filas el combinador se queda cerca de producción). Modelos separados con y sin
 * cuotas. Reajuste en cada `prepare(rows, asOf)` desde cero, solo con filas cuyo partido empezó al menos
 * `guardHours` antes de `asOf` (el resultado ya se conocía): sin estado entre reajustes.
 */
import type { Prob1X2 } from '../../../src/types/data';
import type { ComponentRow, WalkForwardRow } from '../types';

const DAY_MS = 86_400_000;
const EPS = 1e-9;

export type DrawFeature = 'tot' | 'totGoal' | 'absdiff';
export type StrengthFeature = 'kind' | 'neutral';

export interface StackOptions {
  /** L2 hacia el prior (en unidades de la suma de log-verosimilitudes): cuanto mayor, más cerca de producción */
  kappa: number;
  /** L2 de interceptos y rasgos (hacia 0); por defecto = kappa */
  kappaFeat?: number;
  /** vida media (días) de la ponderación temporal de las filas; sin valor = todas pesan igual */
  halfLifeDays?: number;
  /** pesos distintos para el contraste de empate (u ≠ v) */
  separateDraw: boolean;
  /** rasgos del contraste de empate: logit de P(más de 2,5) (mercado si hay, si no goles), log λ total, |dif. Elo| */
  drawFeatures: DrawFeature[];
  /** rasgos del contraste local/visitante: ventaja local por tipo de competición, campo neutral */
  strengthFeatures: StrengthFeature[];
  /** interacción «equipo con pocos partidos Elo» × fuentes (prior: lo que hace producción) */
  lowData: boolean;
  /** interacción «inicio de temporada» × fuentes estadísticas (prior 0) */
  early: boolean;
  /** filas mínimas de un segmento para ajustar; si no, se usa el ensamble de producción */
  minRows: number;
  /** horas mínimas entre el inicio de un partido de entrenamiento y la fecha de reajuste */
  guardHours: number;
  /** segmentos a los que se aplica el combinador ('both' | 'odds' | 'noOdds'); el resto, producción */
  apply: 'both' | 'odds' | 'noOdds';
  /** contracción final hacia producción (0 = combinador puro, 1 = producción): p = (1−α)·comb + α·prod */
  shrinkToProduction?: number;
  /** pesos de las fuentes >= 0 (conjunto activo: una fuente con peso negativo se fija a 0 y se reajusta) */
  nonNeg?: boolean;
  /**
   * competiciones top (tier >= 8): 'interact' = interacción top × fuentes (prior 0); 'production' = el combinador no
   * se entrena ni se aplica en ellas (producción)
   */
  topTier?: 'interact' | 'production';
}

/** Tier mínimo de las competiciones «top» (mismo corte que el banco de pruebas). */
export const TOP_TIER = 8;

export const DEFAULT_OPTIONS: StackOptions = {
  kappa: 50,
  separateDraw: false,
  drawFeatures: [],
  strengthFeatures: [],
  lowData: true,
  early: false,
  minRows: 60,
  guardHours: 3,
  apply: 'both',
};

type Slot = 'market' | 'dc' | 'eg' | 'elo';
const SLOTS_ODDS: Slot[] = ['market', 'dc', 'eg', 'elo'];
const SLOTS_NO: Slot[] = ['dc', 'eg', 'elo'];

/** Pesos (sin normalizar) de producción por segmento: el prior del pool logarítmico. */
function productionPrior(hasMarket: boolean): Record<Slot, number> {
  // MODEL: con cuotas DC 0,05 / Elo 0,15 / mercado 0,8; sin cuotas 0,5 / 0,5; Elo→goles pesa 0,2 de DC
  return hasMarket ? { market: 0.8, dc: 0.05, eg: 0.01, elo: 0.15 } : { market: 0, dc: 0.5, eg: 0.1, elo: 0.5 };
}

interface Param {
  name: string;
  prior: number;
  kappa: number;
  /** contribución al contraste de fuerza S y al de empate Dr de una fila */
  cs: (x: RowX) => number;
  cd: (x: RowX) => number;
}

/** Valores derivados de una fila (contrastes de cada fuente y rasgos). */
interface RowX {
  a: Record<Slot, number>;
  d: Record<Slot, number>;
  ld: number;
  early: number;
  tot: number;
  totGoal: number;
  absdiff: number;
  cup: number;
  cont: number;
  neutral: number;
  top: number;
}

const clampP = (x: number) => Math.min(1 - EPS, Math.max(EPS, x));
const logit = (p: number) => Math.log(clampP(p) / (1 - clampP(p)));

function contrasts(p: Prob1X2 | undefined): { a: number; d: number } {
  if (!p) return { a: 0, d: 0 };
  const h = Math.log(clampP(p.home));
  const dr = Math.log(clampP(p.draw));
  const a = Math.log(clampP(p.away));
  return { a: h - a, d: dr - 0.5 * (h + a) };
}

export function rowX(r: ComponentRow): RowX {
  const m = contrasts(r.market);
  const dc = contrasts(r.goalKind === 'dc' ? r.goal : undefined);
  const eg = contrasts(r.goalKind === 'elo-goals' ? r.goal : undefined);
  const elo = contrasts(r.elo);
  const rounds = r.features.rounds ?? 99;
  const best25 = r.marketOver25 ?? r.goalOver25;
  return {
    a: { market: m.a, dc: dc.a, eg: eg.a, elo: elo.a },
    d: { market: m.d, dc: dc.d, eg: eg.d, elo: elo.d },
    ld: Math.max(0, 1 - r.minEloGames / 10),
    early: Math.max(0, 1 - rounds / 6),
    tot: logit(best25),
    totGoal: Math.log(Math.max(0.2, r.lambdaHome + r.lambdaAway) / 2.6),
    absdiff: Math.abs(r.eloDiff) / 100,
    cup: r.kind === 'cup' ? 1 : 0,
    cont: r.kind === 'continental' ? 1 : 0,
    neutral: r.neutral ? 1 : 0,
    top: r.tier >= TOP_TIER ? 1 : 0,
  };
}

/** Parámetros del modelo de un segmento. */
function buildParams(hasMarket: boolean, o: StackOptions): Param[] {
  const prior = productionPrior(hasMarket);
  const slots = hasMarket ? SLOTS_ODDS : SLOTS_NO;
  const kf = o.kappaFeat ?? o.kappa;
  const ps: Param[] = [];
  for (const s of slots) {
    if (o.separateDraw) {
      ps.push({ name: `u.${s}`, prior: prior[s], kappa: o.kappa, cs: (x) => x.a[s], cd: () => 0 });
      ps.push({ name: `v.${s}`, prior: prior[s], kappa: o.kappa, cs: () => 0, cd: (x) => x.d[s] });
    } else {
      ps.push({ name: `w.${s}`, prior: prior[s], kappa: o.kappa, cs: (x) => x.a[s], cd: (x) => x.d[s] });
    }
  }
  if (o.lowData && hasMarket) {
    // producción: con < 10 partidos Elo los pesos estadísticos bajan linealmente hasta 0 (mercado solo)
    for (const s of slots) {
      const pr = s === 'market' ? 1 - prior.market : -prior[s];
      ps.push({ name: `ld.${s}`, prior: pr, kappa: o.kappa, cs: (x) => x.ld * x.a[s], cd: (x) => x.ld * x.d[s] });
    }
  }
  if (o.topTier === 'interact') {
    for (const s of slots) ps.push({ name: `top.${s}`, prior: 0, kappa: o.kappa, cs: (x) => x.top * x.a[s], cd: (x) => x.top * x.d[s] });
  }
  if (o.early) {
    for (const s of slots.filter((x) => x !== 'market')) {
      ps.push({ name: `early.${s}`, prior: 0, kappa: o.kappa, cs: (x) => x.early * x.a[s], cd: (x) => x.early * x.d[s] });
    }
  }
  ps.push({ name: 'bS', prior: 0, kappa: kf, cs: () => 1, cd: () => 0 });
  ps.push({ name: 'bD', prior: 0, kappa: kf, cs: () => 0, cd: () => 1 });
  for (const f of o.strengthFeatures) {
    if (f === 'kind') {
      ps.push({ name: 'bS.cup', prior: 0, kappa: kf, cs: (x) => x.cup, cd: () => 0 });
      ps.push({ name: 'bS.cont', prior: 0, kappa: kf, cs: (x) => x.cont, cd: () => 0 });
    } else if (f === 'neutral') {
      ps.push({ name: 'bS.neutral', prior: 0, kappa: kf, cs: (x) => x.neutral, cd: () => 0 });
    }
  }
  for (const f of o.drawFeatures) ps.push({ name: `bD.${f}`, prior: 0, kappa: kf, cs: () => 0, cd: (x) => x[f] });
  return ps;
}

function softmax3(S: number, Dr: number): [number, number, number] {
  const e = [0.5 * S, Dr, -0.5 * S];
  const m = Math.max(e[0], e[1], e[2]);
  const x = e.map((v) => Math.exp(v - m));
  const s = x[0] + x[1] + x[2];
  return [x[0] / s, x[1] / s, x[2] / s];
}

/** Resuelve A·x = b (A simétrica definida positiva) por eliminación gaussiana con pivote parcial. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-14) continue;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = Math.abs(M[r][r]) < 1e-14 ? 0 : s / M[r][r];
  }
  return x;
}

interface Design {
  cs: Float64Array[]; // por fila: contribuciones a S
  cd: Float64Array[];
  y: number[];
  w: number[];
}

function objective(theta: number[], D: Design, params: Param[]): number {
  let f = 0;
  for (let i = 0; i < D.y.length; i++) {
    let S = 0;
    let Dr = 0;
    for (let j = 0; j < theta.length; j++) {
      S += theta[j] * D.cs[i][j];
      Dr += theta[j] * D.cd[i][j];
    }
    const p = softmax3(S, Dr);
    f -= D.w[i] * Math.log(Math.max(1e-15, p[D.y[i]]));
  }
  for (let j = 0; j < theta.length; j++) f += 0.5 * params[j].kappa * (theta[j] - params[j].prior) ** 2;
  return f;
}

/** MAP por Newton con búsqueda lineal (problema convexo: log-verosimilitud multinomial + L2). */
export function fitParams(params: Param[], xs: RowX[], ys: number[], ws: number[]): number[] {
  const k = params.length;
  const D: Design = {
    cs: xs.map((x) => Float64Array.from(params.map((p) => p.cs(x)))),
    cd: xs.map((x) => Float64Array.from(params.map((p) => p.cd(x)))),
    y: ys,
    w: ws,
  };
  let theta = params.map((p) => p.prior);
  let f = objective(theta, D, params);
  for (let it = 0; it < 50; it++) {
    const g = new Array<number>(k).fill(0);
    const H = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (let i = 0; i < ys.length; i++) {
      const cs = D.cs[i];
      const cd = D.cd[i];
      let S = 0;
      let Dr = 0;
      for (let j = 0; j < k; j++) {
        S += theta[j] * cs[j];
        Dr += theta[j] * cd[j];
      }
      const [pH, pD, pA] = softmax3(S, Dr);
      const y = ys[i];
      const w = ws[i];
      const gS = 0.5 * (pH - (y === 0 ? 1 : 0)) - 0.5 * (pA - (y === 2 ? 1 : 0));
      const gD = pD - (y === 1 ? 1 : 0);
      const hSS = 0.25 * (pH + pA - (pH - pA) ** 2);
      const hSD = -0.5 * pD * (pH - pA);
      const hDD = pD * (1 - pD);
      for (let j = 0; j < k; j++) {
        g[j] += w * (gS * cs[j] + gD * cd[j]);
        for (let l = j; l < k; l++) H[j][l] += w * (hSS * cs[j] * cs[l] + hSD * (cs[j] * cd[l] + cd[j] * cs[l]) + hDD * cd[j] * cd[l]);
      }
    }
    for (let j = 0; j < k; j++) {
      g[j] += params[j].kappa * (theta[j] - params[j].prior);
      H[j][j] += params[j].kappa;
      for (let l = 0; l < j; l++) H[j][l] = H[l][j];
    }
    const step = solve(H, g);
    let t = 1;
    let next = theta;
    let fn = f;
    for (let ls = 0; ls < 30; ls++) {
      next = theta.map((v, j) => v - t * step[j]);
      fn = objective(next, D, params);
      if (fn <= f + 1e-12) break;
      t *= 0.5;
    }
    if (!(fn <= f + 1e-12)) break;
    const dec = f - fn;
    theta = next;
    f = fn;
    if (dec < 1e-9 * Math.max(1, Math.abs(f))) break;
  }
  return theta;
}

export interface SegmentFit {
  params: Param[];
  theta: number[];
  n: number;
}

/** Combinador con estado (parámetros del último reajuste). Crear uno por variante. */
export class StackCombiner {
  readonly o: StackOptions;
  private fits: { odds?: SegmentFit; noOdds?: SegmentFit } = {};
  lastAsOf?: string;

  constructor(o: Partial<StackOptions> = {}) {
    this.o = { ...DEFAULT_OPTIONS, ...o };
  }

  /** Reajuste desde cero con filas cuyo partido empezó al menos guardHours antes de asOf. */
  prepare(rows: readonly WalkForwardRow[], asOf: string): void {
    this.fits = {};
    this.lastAsOf = asOf;
    const t0 = Date.parse(asOf);
    const limit = t0 - this.o.guardHours * 3_600_000;
    const usable = rows.filter((r) => !r.extraTimeUnresolved && Date.parse(r.date) < limit && !this.skip(r));
    for (const seg of ['odds', 'noOdds'] as const) {
      if (this.o.apply !== 'both' && this.o.apply !== seg) continue;
      const hasMarket = seg === 'odds';
      const sel = usable.filter((r) => r.hasMarket === hasMarket);
      if (sel.length < this.o.minRows) continue;
      const params = buildParams(hasMarket, this.o);
      const hl = this.o.halfLifeDays;
      const ws = sel.map((r) => (hl ? Math.pow(0.5, (t0 - Date.parse(r.date)) / DAY_MS / hl) : 1));
      const xs = sel.map(rowX);
      const ys = sel.map((r) => r.outcome);
      let ps = params;
      let theta = fitParams(ps, xs, ys, ws);
      if (this.o.nonNeg) {
        // conjunto activo: los pesos de fuente negativos se fijan a 0 (se quitan del modelo) y se reajusta
        for (let round = 0; round < 4; round++) {
          const neg = new Set(ps.filter((p, j) => /^[wuv]\./.test(p.name) && theta[j] < 0).map((p) => p.name.slice(2)));
          if (!neg.size) break;
          ps = ps.filter((p) => !(/^[wuv]\./.test(p.name) || /^ld\./.test(p.name) || /^early\./.test(p.name)) || !neg.has(p.name.slice(p.name.indexOf('.') + 1)));
          theta = fitParams(ps, xs, ys, ws);
        }
      }
      this.fits[seg] = { params: ps, theta, n: sel.length };
    }
  }

  /** Parámetros ajustados (para informes). */
  describe(): Record<string, Record<string, number> & { n: number }> {
    const out: Record<string, Record<string, number> & { n: number }> = {};
    for (const [seg, f] of Object.entries(this.fits)) {
      if (!f) continue;
      const o: Record<string, number> = { n: f.n };
      f.params.forEach((p, j) => (o[p.name] = Math.round(f.theta[j] * 1e4) / 1e4));
      out[seg] = o as Record<string, number> & { n: number };
    }
    return out;
  }

  /** filas que el combinador no toca (producción) */
  private skip(r: ComponentRow): boolean {
    return this.o.topTier === 'production' && r.tier >= TOP_TIER;
  }

  blend(row: ComponentRow): Prob1X2 {
    if (this.skip(row)) return row.production;
    const fit = row.hasMarket ? this.fits.odds : this.fits.noOdds;
    if (!fit) return row.production;
    const x = rowX(row);
    let S = 0;
    let Dr = 0;
    fit.params.forEach((p, j) => {
      S += fit.theta[j] * p.cs(x);
      Dr += fit.theta[j] * p.cd(x);
    });
    const [h, d, a] = softmax3(S, Dr);
    if (![h, d, a].every((v) => Number.isFinite(v) && v > 0)) return row.production;
    const al = this.o.shrinkToProduction ?? 0;
    if (al > 0) {
      const q = row.production;
      return { home: (1 - al) * h + al * q.home, draw: (1 - al) * d + al * q.draw, away: (1 - al) * a + al * q.away };
    }
    return { home: h, draw: d, away: a };
  }
}

// ---------------------------------------------------------------------------
// Más de 2,5: apilado logístico walk-forward (opcional)
// ---------------------------------------------------------------------------

export interface OverStackOptions {
  /** L2 hacia el prior (producción) */
  kappa: number;
  /** también sin P(más de 2,5) del mercado (logit de la fuente de goles con pendiente/intercepto aprendidos) */
  noMarket: boolean;
  minRows: number;
  guardHours: number;
}

/**
 * logit P(más de 2,5) = a·logit(goles) + b·logit(mercado) + c (con mercado; prior producción ≈ 0,06 / 0,94 / 0) o
 * a·logit(goles) + c (sin mercado; prior 1 / 0). Ajuste por máxima verosimilitud con L2 hacia el prior.
 */
export class OverStacker {
  readonly o: OverStackOptions;
  private mk?: number[];
  private gl?: number[];

  constructor(o: Partial<OverStackOptions> = {}) {
    this.o = { kappa: 100, noMarket: false, minRows: 60, guardHours: 3, ...o };
  }

  private static fit(X: number[][], y: number[], prior: number[], kappa: number): number[] {
    let th = prior.slice();
    const k = th.length;
    for (let it = 0; it < 40; it++) {
      const g = new Array<number>(k).fill(0);
      const H = Array.from({ length: k }, () => new Array<number>(k).fill(0));
      for (let i = 0; i < y.length; i++) {
        let z = 0;
        for (let j = 0; j < k; j++) z += X[i][j] * th[j];
        const p = 1 / (1 + Math.exp(-z));
        for (let j = 0; j < k; j++) {
          g[j] += (p - y[i]) * X[i][j];
          for (let l = 0; l < k; l++) H[j][l] += p * (1 - p) * X[i][j] * X[i][l];
        }
      }
      for (let j = 0; j < k; j++) {
        g[j] += kappa * (th[j] - prior[j]);
        H[j][j] += kappa;
      }
      const st = solve(H, g);
      th = th.map((v, j) => v - st[j]);
      if (Math.max(...st.map(Math.abs)) < 1e-9) break;
    }
    return th;
  }

  prepare(rows: readonly WalkForwardRow[], asOf: string): void {
    this.mk = undefined;
    this.gl = undefined;
    const limit = Date.parse(asOf) - this.o.guardHours * 3_600_000;
    const usable = rows.filter((r) => !r.extraTimeUnresolved && Date.parse(r.date) < limit);
    const y = (r: WalkForwardRow) => (r.hg + r.ag > 2.5 ? 1 : 0);
    const withMk = usable.filter((r) => r.marketOver25 !== undefined);
    if (withMk.length >= this.o.minRows) {
      this.mk = OverStacker.fit(withMk.map((r) => [logit(r.goalOver25), logit(r.marketOver25!), 1]), withMk.map(y), [0.06, 0.94, 0], this.o.kappa);
    }
    const noMk = usable.filter((r) => r.marketOver25 === undefined);
    if (this.o.noMarket && noMk.length >= this.o.minRows) {
      this.gl = OverStacker.fit(noMk.map((r) => [logit(r.goalOver25), 1]), noMk.map(y), [1, 0], this.o.kappa);
    }
  }

  /** P(más de 2,5) objetivo, o undefined (= fórmula de producción) */
  predict(row: ComponentRow): number | undefined {
    let z: number | undefined;
    if (row.marketOver25 !== undefined) {
      if (this.mk) z = this.mk[0] * logit(row.goalOver25) + this.mk[1] * logit(row.marketOver25) + this.mk[2];
    } else if (this.gl) z = this.gl[0] * logit(row.goalOver25) + this.gl[1];
    if (z === undefined || !Number.isFinite(z)) return undefined;
    return 1 / (1 + Math.exp(-z));
  }

  describe(): { market?: number[]; noMarket?: number[] } {
    return { market: this.mk?.map((v) => Math.round(v * 1e4) / 1e4), noMarket: this.gl?.map((v) => Math.round(v * 1e4) / 1e4) };
  }
}
