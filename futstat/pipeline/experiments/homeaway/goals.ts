/**
 * Factor LOCAL/VISITANTE, parte (a): VENTAJA LOCAL PROPIA DE CADA EQUIPO en goles (variantes homeaway-goals*.ts).
 *
 * Modelo: el equipo T rinde s_T + v_T en casa y s_T − v_T fuera (v_T = exceso de rendimiento en casa frente a fuera,
 * por encima de la ventaja local media de cada competición). En un partido L contra V (campo no neutral) la
 * supremacía esperada (goles de L − goles de V) cambia en Δ = v_L + v_V.
 *
 * Estimación de v_T (gancho `features`, SOLO con la vista del pasado):
 *  - partidos terminados del equipo (todas las competiciones) en los HA_DAYS días anteriores, sin campo neutral;
 *  - residuo de cada partido, desde el punto de vista de T:
 *        r = (GF − GC) − [ (Elo_T − Elo_R)/ELO_PER_GOAL + venue · h_c ]
 *    con venue = +1 en casa y −1 fuera, Elo_T y Elo_R los ratings JUSTO ANTES DEL CORTE (HistoryView no da el Elo
 *    histórico: el sesgo es el mismo en casa y fuera y se cancela en la diferencia) y h_c la ventaja local de la
 *    competición de ese partido en goles: media de (GL − GV) de sus partidos no neutrales de los últimos 365 días
 *    (`compMatches`, anteriores al corte), contraída hacia H_PRIOR con H_PRIOR_N partidos ficticios;
 *  - v̂_T = (media de r en casa − media de r fuera) / 2, con varianza s²/4 · (1/n_casa + 1/n_fuera) (s² = varianza
 *    combinada de los residuos alrededor de su media en cada condición, con un suelo). Con menos de MIN_SIDE partidos
 *    en casa o fuera, sin estimación.
 *
 * Contracción empírico-bayesiana (gancho `combine.prepare`, solo filas ANTERIORES a la fecha de reajuste): varianza
 * real entre equipos por momentos, τ² = media(v̂² − var) sobre las estimaciones de las filas, recortada a [0; TAU2_MAX].
 * Cada estimación se contrae con w = τ²/(τ² + var): v = w · v̂. Si τ² = 0 (o hay < MIN_EST estimaciones), el
 * combinador devuelve EXACTAMENTE la producción.
 *
 * Aplicación (gancho `combine.blend`): delta sobre el ensamble de producción (mercado incluido), con los λ de la fuente
 * de goles: λL' = λL·e^c, λV' = λV·e^(−c), c = Δ/(λL + λV) (mismo total, supremacía + Δ):
 *     p = p_prod + [P(λ') − P(λ)]   (normalizado)
 * El objetivo de más de 2,5 no se toca (el núcleo recalibra los λ finales con el 1X2 nuevo: llega a los goles por
 * equipo). Δ se recorta a ±DELTA_MAX goles.
 *
 * Determinista, sin estado global: las medias de competición se memorizan solo dentro de una llamada; el único estado
 * es τ², que gestiona `prepare` con filas del pasado (como pide el README).
 */
import { dcOutcomes } from '../../../src/lib/models';
import type { Prob1X2 } from '../../../src/types/data';
import type { MatchRecord } from '../../types';
import type { BlendResult, ComponentRow, FeatureContext, Features, HistoryView, PreMatch, WalkForwardRow } from '../types';

const DAY_MS = 86_400_000;

/** días de historia del equipo para estimar v_T */
export const HA_DAYS = 540;
/** días de historia de la competición para su ventaja local media */
export const COMP_DAYS = 365;
/** ventaja local típica (goles de supremacía) y partidos ficticios de su contracción */
export const H_PRIOR = 0.35;
export const H_PRIOR_N = 50;
/** puntos Elo por gol de supremacía (los mismos que los rasgos de forma) */
export const ELO_PER_GOAL = 250;
/** partidos mínimos en casa y fuera */
export const MIN_SIDE = 5;
/** suelo de la varianza por partido del residuo de diferencia de goles */
export const S2_FLOOR = 1.5;
/** estimaciones mínimas en las filas para calcular τ² */
export const MIN_EST = 300;
/** recorte de τ² (varianza real de v entre equipos, goles²) */
export const TAU2_MAX = 0.04;
/** recorte de Δ (goles de supremacía) */
export const DELTA_MAX = 0.4;

export interface TeamHA {
  /** estimación sin contraer de v_T (goles) */
  v: number;
  /** varianza de muestreo de v̂ */
  var: number;
  nHome: number;
  nAway: number;
}

/** sin estimación: varianza −1 (centinela finito) */
const NONE: TeamHA = { v: 0, var: -1, nHome: 0, nAway: 0 };

/** Ventaja local de la competición (goles de supremacía) con sus partidos no neutrales de los últimos COMP_DAYS días. */
export function compHomeAdv(before: HistoryView, compId: string, memo: Map<string, number>): number {
  const hit = memo.get(compId);
  if (hit !== undefined) return hit;
  const ms = before.compMatches(compId);
  let s = 0;
  let n = 0;
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    if (before.cutoff - Date.parse(m.date) > COMP_DAYS * DAY_MS) break;
    if (m.neutral || !m.score) continue;
    s += m.score.home - m.score.away;
    n++;
  }
  const h = (s + H_PRIOR * H_PRIOR_N) / (n + H_PRIOR_N);
  memo.set(compId, h);
  return h;
}

/** Estimación sin contraer de la ventaja local propia v_T de un equipo (solo pasado). */
export function teamHomeAdv(before: HistoryView, teamId: string, memo = new Map<string, number>()): TeamHA {
  const eloT = before.eloBefore(teamId);
  if (eloT === undefined) return NONE;
  const all = before.teamMatches(teamId);
  const res: [number[], number[]] = [[], []]; // [casa, fuera]
  for (let i = all.length - 1; i >= 0; i--) {
    const m: MatchRecord = all[i];
    if (before.cutoff - Date.parse(m.date) > HA_DAYS * DAY_MS) break;
    if (m.neutral || !m.score) continue;
    const home = m.home.id === teamId;
    const oppId = home ? m.away.id : m.home.id;
    const eloO = before.eloBefore(oppId);
    if (eloO === undefined) continue;
    const venue = home ? 1 : -1;
    const gd = home ? m.score.home - m.score.away : m.score.away - m.score.home;
    const exp = (eloT - eloO) / ELO_PER_GOAL + venue * compHomeAdv(before, m.compId, memo);
    res[home ? 0 : 1].push(gd - exp);
  }
  const [h, a] = res;
  if (h.length < MIN_SIDE || a.length < MIN_SIDE) return { ...NONE, nHome: h.length, nAway: a.length };
  const mean = (x: number[]) => x.reduce((s, y) => s + y, 0) / x.length;
  const mh = mean(h);
  const ma = mean(a);
  let ss = 0;
  for (const x of h) ss += (x - mh) ** 2;
  for (const x of a) ss += (x - ma) ** 2;
  const s2 = Math.max(S2_FLOOR, ss / (h.length + a.length - 2));
  return { v: (mh - ma) / 2, var: (s2 / 4) * (1 / h.length + 1 / a.length), nHome: h.length, nAway: a.length };
}

/** Rasgos del partido (gancho `features`): v̂ y su varianza para local (H) y visitante (A); 0 / −1 sin estimación. */
export function homeAwayFeatures(_ctx: FeatureContext, match: PreMatch, before: HistoryView): Features {
  if (match.neutral) return { haVH: 0, haVarH: -1, haVA: 0, haVarA: -1 };
  const memo = new Map<string, number>();
  const h = teamHomeAdv(before, match.home.id, memo);
  const a = teamHomeAdv(before, match.away.id, memo);
  return { haVH: h.v, haVarH: h.var, haVA: a.v, haVarA: a.var };
}

function normalize3(p: Prob1X2): Prob1X2 {
  const h = Math.max(1e-6, p.home);
  const d = Math.max(1e-6, p.draw);
  const a = Math.max(1e-6, p.away);
  const s = h + d + a;
  return { home: h / s, draw: d / s, away: a / s };
}

export interface HomeAwayGoalOptions {
  /** a qué partidos se aplica: todos o solo los que no tienen cuotas */
  apply: 'all' | 'noOdds';
}

/** Combinador: τ² empírico-bayesiano en `prepare` y delta de la supremacía sobre el ensamble de producción en `blend`. */
export class HomeAwayCombiner {
  readonly opts: HomeAwayGoalOptions;
  /** τ² vigente (null = sin estimación: producción) */
  tau2: number | null = null;
  /** historial de reajustes (diagnóstico) */
  readonly log: { asOf: string; n: number; tau2: number; meanV2: number; meanVar: number }[] = [];

  constructor(opts: HomeAwayGoalOptions) {
    this.opts = opts;
  }

  prepare(rows: readonly WalkForwardRow[], asOf: string): void {
    const limit = Date.parse(asOf);
    let sv2 = 0;
    let svar = 0;
    let n = 0;
    for (const r of rows) {
      if (!(Date.parse(r.date) < limit) || r.neutral) continue;
      for (const [v, va] of [
        [r.features.haVH, r.features.haVarH],
        [r.features.haVA, r.features.haVarA],
      ]) {
        if (!Number.isFinite(v) || !(va > 0) || !Number.isFinite(va)) continue;
        sv2 += v * v;
        svar += va;
        n++;
      }
    }
    if (n < MIN_EST) {
      this.tau2 = null;
      return;
    }
    const t = Math.min(TAU2_MAX, Math.max(0, (sv2 - svar) / n));
    this.tau2 = t;
    this.log.push({ asOf, n, tau2: t, meanV2: sv2 / n, meanVar: svar / n });
  }

  /** Δ de supremacía (goles) del partido; 0 = producción. */
  delta(row: ComponentRow): number {
    const t = this.tau2;
    if (t === null || !(t > 0) || row.neutral) return 0;
    if (this.opts.apply === 'noOdds' && row.hasMarket) return 0;
    const f = row.features;
    const shr = (v: number, va: number) => (Number.isFinite(v) && va > 0 && Number.isFinite(va) ? (v * t) / (t + va) : 0);
    const d = shr(f.haVH, f.haVarH) + shr(f.haVA, f.haVarA);
    return Math.min(DELTA_MAX, Math.max(-DELTA_MAX, d));
  }

  blend(row: ComponentRow): BlendResult {
    const d = this.delta(row);
    if (d === 0) return row.production;
    const lh = row.lambdaHome;
    const la = row.lambdaAway;
    if (!(lh > 0 && la > 0)) return row.production;
    const c = d / (lh + la);
    const o0 = dcOutcomes(lh, la, row.rho);
    const o1 = dcOutcomes(lh * Math.exp(c), la * Math.exp(-c), row.rho);
    const p = row.production;
    return normalize3({ home: p.home + o1.home - o0.home, draw: p.draw + o1.draw - o0.draw, away: p.away + o1.away - o0.away });
  }
}
