/**
 * Variantes «shots»: fuerza de los equipos a partir de un xG aproximado por tiros (más estable que los goles).
 *
 *   goles ajustados (ajuste Dixon-Coles) = w·goles + (1 − w)·xG_proxy
 *   xG_proxy = k·(tiros a puerta + r·tiros fuera)          (tiros fuera = totales − a puerta, incluye bloqueados)
 *
 * Sin fuga:
 *  - `dc.fitGoals(m)` solo usa las estadísticas del propio partido histórico `m` (el núcleo solo se lo pasa para
 *    partidos anteriores a la fecha de reajuste del Dixon-Coles). Partidos sin tiros válidos: goles reales.
 *  - Las constantes k y r se fijaron UNA vez con partidos de liga de 2025 (fecha < 2026-01-01, 5.667 partidos con
 *    tiros), ANTERIORES a la primera predicción walk-forward (enero de 2026) y a todas las ventanas de evaluación:
 *      · r = 0,2: fiabilidad predictiva en 2025 (correlación entre la media de la 1.ª mitad de los partidos de liga de
 *        cada equipo y sus goles de la 2.ª mitad; 354 equipo-liga): con w = 0,5 ataque 0,652 (r = 0) → 0,656 (r = 0,2)
 *        ≈ 0,657 (r = 0,35); defensa 0,539 → 0,549 ≈ 0,553; solo goles (w = 1): 0,636 / 0,504. Valorar los penaltis
 *        marcados a 0,76 no mejoraba (0,651 / 0,547).
 *      · k = Σ goles / Σ (a puerta + r·fuera) en esas ligas (la media del xG_proxy = la de los goles en 2025).
 *  - La escala del xG_proxy varía por liga (2025: Argentina convierte un 18 % menos que la media; Bundesliga un 10 %
 *    más). El `base` del Dixon-Coles se iguala a la media de los goles AJUSTADOS, así que `lambdaAdjust` reescala los
 *    λ por R = Σ ω·goles / Σ ω·ajustados (ω = exp(−ξ·días), ventana del Dixon-Coles) con los partidos de
 *    `ctx.history.compMatches(liga del modelo)`: solo partidos terminados con inicio ANTERIOR al del partido
 *    predicho. Sin estado entre llamadas: todo se recalcula en cada predicción.
 */
import { MODEL } from '../../config';
import type { MatchRecord, TeamMatchStats } from '../../types';
import type { CombineHooks, HistoryView, ModelVariant, TotalsHooks } from '../types';

const DAY_MS = 86_400_000;

/** Peso relativo de un tiro fuera frente a uno a puerta (elegido con datos de 2025). */
export const DEFAULT_R = 0.2;
/** k global para cada r (Σ goles / Σ (SOT + r·fuera) en las ligas de 2025, 5.667 partidos con tiros). */
export const K_BY_R: Record<string, number> = { '0': 0.3139, '0.1': 0.2636, '0.2': 0.2272, '0.35': 0.1882 };
/** xG de un penalti marcado (modo `pen`). k con r = 0,2 descontando penaltis: 0,2159. */
export const PEN_XG = 0.76;
export const K_PEN_R02 = 0.2159;
/**
 * Escala k por liga (r = 0,2) en 2025 (variante estática por competición, sin reescalado dinámico).
 * Global: 0,2272.
 */
export const K_BY_COMP_2025: Record<string, number> = {
  laliga: 0.2207,
  premier: 0.2433,
  seriea: 0.2102,
  bundesliga: 0.2489,
  ligue1: 0.2416,
  eredivisie: 0.2334,
  primeira: 0.2305,
  superlig: 0.2302,
  laliga2: 0.2243,
  championship: 0.2322,
  saudi: 0.2468,
  brasileirao: 0.207,
  argentina: 0.1818,
  ligamx: 0.24,
  mls: 0.239,
  chile: 0.2153,
};

export interface ShotsOptions {
  name: string;
  description: string;
  /** peso de los goles reales en la mezcla (1 = producción); puede depender de la liga */
  w: number | ((compId: string) => number);
  /** peso relativo de los tiros fuera (por defecto DEFAULT_R) */
  r?: number;
  /** escala del xG_proxy (por defecto K_BY_R[r]) */
  k?: number;
  /** escala por liga (si se da, sustituye a k en esa liga) */
  kByComp?: Record<string, number>;
  /** penaltis marcados (eventos) valen PEN_XG en lugar de un tiro a puerta */
  pen?: boolean;
  /**
   * reescalado dinámico de los λ por liga en lambdaAdjust: 'single' (por defecto: un único R = Σ ω·goles / Σ ω·ajustados
   * para local y visitante: conserva la ventaja local del ajuste con goles ajustados), 'split' (R_local y R_visitante
   * por separado: devuelve la ventaja local de los goles reales; peor en el ajuste) o false (sin reescalado)
   */
  normalize?: 'split' | 'single' | false;
  /** recorte del factor de reescalado */
  maxScale?: number;
  /**
   * corrección de «calidad de remate» por equipo (en lambdaAdjust): Q = (goles + c·m̄·R̄) / ((ajustados + c·m̄)·R̄)
   * con los partidos de liga del equipo anteriores al corte (ω = exp(−ξ·días)); c = partidos ficticios del prior
   * (undefined = sin corrección). Devuelve a los equipos que convierten sistemáticamente más (o menos) que sus tiros
   * parte de la diferencia que el xG por tiros (sin localización) les quita.
   */
  finishing?: number;
  combine?: CombineHooks;
  totals?: TotalsHooks;
}

function validShots(s: TeamMatchStats | undefined): s is TeamMatchStats & { shots: number; shotsOnTarget: number } {
  return (
    !!s &&
    typeof s.shots === 'number' &&
    typeof s.shotsOnTarget === 'number' &&
    Number.isFinite(s.shots) &&
    Number.isFinite(s.shotsOnTarget) &&
    s.shotsOnTarget >= 0 &&
    s.shots >= s.shotsOnTarget &&
    s.shots <= 60
  );
}

export interface XgParams {
  w: number;
  r: number;
  k: number;
  pen: boolean;
}

export function paramsFor(o: ShotsOptions, compId: string): XgParams {
  const r = o.r ?? DEFAULT_R;
  const w = typeof o.w === 'function' ? o.w(compId) : o.w;
  const k = o.kByComp?.[compId] ?? o.k ?? (o.pen && r === 0.2 ? K_PEN_R02 : K_BY_R[String(r)]);
  if (!(k > 0)) throw new Error(`shots: falta la escala k para r = ${r}`);
  return { w: Math.min(1, Math.max(0, w)), r, k, pen: !!o.pen };
}

/** xG_proxy de un equipo en un partido (undefined sin tiros). */
export function xgProxy(s: TeamMatchStats | undefined, p: XgParams, penGoals = 0): number | undefined {
  if (!validShots(s)) return undefined;
  const off = s.shots - s.shotsOnTarget;
  if (p.pen) {
    const pens = Math.min(penGoals, s.shotsOnTarget);
    return p.k * (s.shotsOnTarget - pens + p.r * off) + PEN_XG * pens;
  }
  return p.k * (s.shotsOnTarget + p.r * off);
}

function penaltyGoals(m: MatchRecord, teamId: string): number {
  let n = 0;
  for (const e of m.events ?? []) if (e.type === 'penalty' && e.teamId === teamId) n++;
  return n;
}

/** Goles ajustados de un partido terminado (solo datos del propio partido). Sin tiros de ambos equipos: goles. */
export function adjustedGoals(m: MatchRecord, p: XgParams): { hg: number; ag: number } {
  const hg = m.score!.home;
  const ag = m.score!.away;
  if (p.w >= 1 || !m.stats) return { hg, ag };
  const xh = xgProxy(m.stats.home, p, p.pen ? penaltyGoals(m, m.home.id) : 0);
  const xa = xgProxy(m.stats.away, p, p.pen ? penaltyGoals(m, m.away.id) : 0);
  if (xh === undefined || xa === undefined) return { hg, ag };
  return { hg: p.w * hg + (1 - p.w) * xh, ag: p.w * ag + (1 - p.w) * xa };
}

/**
 * Factores de reescalado de la liga a un corte: R_local = Σ ω·goles_local / Σ ω·ajustados_local (ídem visitante),
 * ω = exp(−ξ·días) en la ventana del Dixon-Coles. Solo partidos de `history` (anteriores al corte).
 */
export function leagueScale(
  history: HistoryView,
  compId: string,
  o: ShotsOptions,
  xi: number = MODEL.dcXi,
  windowDays: number = MODEL.dcWindowDays,
): { home: number; away: number; pooled: number; meanAdj: number } {
  const p = paramsFor(o, compId);
  if (p.w >= 1) return { home: 1, away: 1, pooled: 1, meanAdj: 1.35 };
  const ms = history.compMatches(compId);
  const cutoff = history.cutoff;
  const from = cutoff - windowDays * DAY_MS;
  let gh = 0;
  let ga = 0;
  let xh = 0;
  let xa = 0;
  let sw = 0;
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    const t = Date.parse(m.date);
    if (!(t >= from)) break;
    if (!m.score || !Number.isInteger(m.score.home) || !Number.isInteger(m.score.away) || m.home.id === m.away.id) continue;
    const wt = Math.exp((-xi * (cutoff - t)) / DAY_MS);
    const adj = adjustedGoals(m, p);
    gh += wt * m.score.home;
    ga += wt * m.score.away;
    xh += wt * adj.hg;
    xa += wt * adj.ag;
    sw += wt;
  }
  const lim = o.maxScale ?? 1.3;
  const f = (g: number, x: number) => (x > 0 && g > 0 ? Math.min(lim, Math.max(1 / lim, g / x)) : 1);
  return { home: f(gh, xh), away: f(ga, xa), pooled: f(gh + ga, xh + xa), meanAdj: sw > 0 ? (xh + xa) / (2 * sw) : 1.35 };
}

/**
 * Factores de calidad de remate de un equipo en su liga (ver ShotsOptions.finishing): ataque (goles marcados frente a
 * ajustados) y defensa (encajados frente a ajustados encajados), contraídos hacia la media de la liga y relativos a
 * ella. Solo partidos de `history` (anteriores al corte).
 */
export function teamFinishing(
  history: HistoryView,
  teamId: string,
  compId: string,
  o: ShotsOptions,
  c: number,
  league: { home: number; away: number; pooled: number; meanAdj: number },
  xi: number = MODEL.dcXi,
  windowDays: number = MODEL.dcWindowDays,
): { att: number; def: number } {
  const p = paramsFor(o, compId);
  if (p.w >= 1) return { att: 1, def: 1 };
  const ms = history.teamMatches(teamId);
  const cutoff = history.cutoff;
  const from = cutoff - windowDays * DAY_MS;
  let gf = 0;
  let af = 0;
  let ga = 0;
  let aa = 0;
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    const t = Date.parse(m.date);
    if (!(t >= from)) break;
    if (m.compId !== compId || !m.score) continue;
    const wt = Math.exp((-xi * (cutoff - t)) / DAY_MS);
    const adj = adjustedGoals(m, p);
    const home = m.home.id === teamId;
    gf += wt * (home ? m.score.home : m.score.away);
    af += wt * (home ? adj.hg : adj.ag);
    ga += wt * (home ? m.score.away : m.score.home);
    aa += wt * (home ? adj.ag : adj.hg);
  }
  const rbar = league.pooled;
  const prior = c * league.meanAdj;
  const q = (g: number, a: number) => Math.min(1.3, Math.max(1 / 1.3, (g + prior * rbar) / ((a + prior) * rbar)));
  return { att: q(gf, af), def: q(ga, aa) };
}

/** Variante «shots» con las opciones dadas. */
export function makeShotsVariant(o: ShotsOptions): ModelVariant {
  const v: ModelVariant = {
    name: o.name,
    description: o.description,
    dc: {
      fitGoals(m) {
        return adjustedGoals(m, paramsFor(o, m.compId));
      },
    },
  };
  if (o.normalize !== false) {
    v.lambdaAdjust = ({ ctx, match, lambdaHome, lambdaAway }) => {
      if (ctx.goalKind !== 'dc' || !ctx.dcCompId) return { lambdaHome, lambdaAway };
      const s = leagueScale(ctx.history, ctx.dcCompId, o);
      const single = (o.normalize ?? 'single') === 'single' ? s.pooled : undefined;
      let fh = single ?? s.home;
      let fa = single ?? s.away;
      if (o.finishing !== undefined) {
        const h = teamFinishing(ctx.history, match.home.id, ctx.dcCompId, o, o.finishing, s);
        const a = teamFinishing(ctx.history, match.away.id, ctx.dcCompId, o, o.finishing, s);
        fh *= h.att * a.def;
        fa *= a.att * h.def;
      }
      return { lambdaHome: lambdaHome * fh, lambdaAway: lambdaAway * fa };
    };
  }
  if (o.combine) v.combine = o.combine;
  if (o.totals) v.totals = o.totals;
  return v;
}
