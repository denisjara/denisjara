/**
 * Factores de contexto como AJUSTES MULTIPLICATIVOS DE λ estimados con regresión de Poisson (walk-forward) sobre los
 * residuos de un modelo de goles:
 *
 *   goles del equipo X contra Y ~ Poisson( λ_X · exp(β · x_XY) )
 *
 * con offset log λ_X y rasgos de contexto x_XY (descanso, congestión, competición europea, ascenso, inicio de
 * temporada, ventaja local de la liga/equipo, calibración de la diferencia de fuerzas, movimiento de cuotas…, ver
 * `Term`). Cada partido da dos observaciones (goles del local y del visitante). Penalización L2 hacia 0 (β = 0 =
 * producción).
 *
 * Dos niveles:
 *  - 'goal': λ de la FUENTE DE GOLES (Dixon-Coles o Elo→goles, antes del ensamble). La fuente ajustada sustituye a la
 *    original dentro del pool lineal de producción (mismos pesos) y en el objetivo de más de 2,5.
 *  - 'final': λ FINALES del ensamble de producción (recalibrados al 1X2 y al más de 2,5 con fitLambdas, como hace el
 *    núcleo). El cambio se aplica como delta: p = p_prod + [P(λ·m) − P(λ)], lo mismo en más de 2,5. Mide si el
 *    contexto aporta algo que el mercado de cierre no tenga ya.
 *
 * Walk-forward: `prepare(rows, asOf)` se llama en cada fecha de reajuste con filas de partidos terminados anteriores a
 * asOf; aquí además se exige que el partido empezara al menos `guardHours` antes (resultado ya conocido). El ajuste se
 * rehace desde cero en cada llamada; entre reajustes solo se guardan los coeficientes (estado gestionado por prepare,
 * como pide el README). La única caché es una memo PURA de fitLambdas (clave = sus entradas exactas).
 */
import { dcOutcomes, fitLambdas } from '../../../src/lib/models';
import type { Prob1X2 } from '../../../src/types/data';
import type { BlendResult, ComponentRow, Features, WalkForwardRow } from '../types';
import { fitPoissonGlm, type GlmObs } from './glm';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Términos disponibles (cada uno aporta 1 o 2 columnas: propio / rival). */
export type Term =
  | 'level' // constante (nivel de goles de la fuente)
  | 'home' // constante solo para los goles del local (ventaja local global)
  | 'short' // déficit de descanso (< 4 días) propio / rival
  | 'restDiff' // diferencia de descanso propio − rival (días, recortada a ±5, /5)
  | 'long' // descanso >= 10 días propio / rival
  | 'n14' // partidos en los últimos 14 días propio / rival
  | 'euro' // último partido continental hace <= 4 días propio / rival
  | 'prom' // recién ascendido propio / rival
  | 'early' // inicio de temporada (1 − partidos/6) propio / rival
  | 'lgHA' // ventaja local reciente de la competición (log goles L/V − 0,25)
  | 'teamHA' // ventaja local propia del equipo local
  | 'dlog' // log(λ propio / λ rival): calibración de la diferencia de fuerzas
  | 'dlogEarly' // dlog × inicio de temporada (más incertidumbre → contraer hacia la media)
  | 'dlogEarlyL' // igual pero solo en ligas (en copas «partidos de la temporada» no mide el inicio de temporada)
  | 'earlyL' // inicio de temporada propio / rival, solo en ligas
  | 'promEarly' // recién ascendido × inicio de temporada propio / rival (el DC aún lo trata como un equipo medio)
  | 'thin' // pocos partidos del equipo en esta competición en 540 días (max(0, 1 − n/15)) propio / rival
  | 'dlogThin' // dlog × max(thin propio, thin rival): contraer la diferencia cuando el DC tiene pocos datos
  | 'mvHA' // movimiento del mercado 1X2 apertura → cierre (log pH/pA)
  | 'mvOver'; // movimiento del mercado de totales (logit P(más))

export interface ContextOptions {
  level: 'goal' | 'final';
  terms: Term[];
  /** penalización L2 (en unidades de log-verosimilitud sumada) de cada coeficiente */
  kappa: number;
  /** penalizaciones específicas por término */
  kappaByTerm?: Partial<Record<Term, number>>;
  /** modelos separados para Dixon-Coles y Elo→goles (solo nivel 'goal') */
  byKind?: boolean;
  /** términos que se ajustan SOLO en el modelo de Elo→goles (con byKind) */
  eloGoalsOnlyTerms?: Term[];
  /** horas mínimas entre el inicio de un partido de entrenamiento y la fecha de reajuste */
  guardHours: number;
  /** observaciones (partidos) mínimas para ajustar; si no, β = 0 */
  minRows: number;
  /** vida media (días) de la ponderación temporal de las filas; sin valor = todas pesan igual */
  halfLifeDays?: number;
  /** límites del multiplicador de λ */
  minMult: number;
  maxMult: number;
  /** a qué partidos se aplica: todos, solo con cuotas o solo sin cuotas */
  apply?: 'all' | 'odds' | 'noOdds';
  /** con qué partidos se ajusta (por defecto, los mismos a los que se aplica) */
  trainOn?: 'all' | 'odds' | 'noOdds';
}

export const DEFAULT_CONTEXT: ContextOptions = {
  level: 'goal',
  terms: ['short', 'long', 'n14', 'euro', 'prom', 'early'],
  kappa: 30,
  guardHours: 3,
  minRows: 150,
  minMult: 0.6,
  maxMult: 1.6,
};

const early = (games: number) => Math.max(0, 1 - games / 6);
const thin = (n: number) => Math.max(0, 1 - n / 15);

/** Columnas de una observación de goles del equipo `own` ('H' | 'A'). */
function design(terms: readonly Term[], f: Features, own: 'H' | 'A', lOwn: number, lOpp: number): number[] {
  const opp = own === 'H' ? 'A' : 'H';
  const sgn = own === 'H' ? 1 : -1;
  const neutral = f.neutral === 1;
  const g = (k: string) => (Number.isFinite(f[k]) ? f[k] : 0);
  const x: number[] = [];
  for (const t of terms) {
    switch (t) {
      case 'level':
        x.push(1);
        break;
      case 'home':
        x.push(own === 'H' && !neutral ? 1 : 0);
        break;
      case 'short':
        x.push(g(`short${own}`), g(`short${opp}`));
        break;
      case 'restDiff':
        x.push(Math.max(-5, Math.min(5, g(`rest${own}`) - g(`rest${opp}`))) / 5);
        break;
      case 'long':
        x.push(g(`long${own}`), g(`long${opp}`));
        break;
      case 'n14':
        x.push(g(`n14${own}`) - 2, g(`n14${opp}`) - 2);
        break;
      case 'euro':
        x.push(g(`euro${own}`), g(`euro${opp}`));
        break;
      case 'prom':
        x.push(g(`prom${own}`), g(`prom${opp}`));
        break;
      case 'early':
        x.push(early(g(`games${own}`)), early(g(`games${opp}`)));
        break;
      case 'lgHA':
        x.push(neutral ? 0 : (sgn * (g('lgHA') - 0.25)) / 2);
        break;
      case 'teamHA':
        x.push(neutral ? 0 : sgn * g('teamHAH'));
        break;
      case 'dlog':
        x.push(Math.log(lOwn / lOpp));
        break;
      case 'dlogEarly':
        x.push(Math.log(lOwn / lOpp) * Math.max(early(g(`games${own}`)), early(g(`games${opp}`))));
        break;
      case 'dlogEarlyL':
        x.push(g('isLeague') === 1 ? Math.log(lOwn / lOpp) * Math.max(early(g(`games${own}`)), early(g(`games${opp}`))) : 0);
        break;
      case 'promEarly':
        x.push(g(`prom${own}`) * early(g(`games${own}`)), g(`prom${opp}`) * early(g(`games${opp}`)));
        break;
      case 'thin':
        x.push(thin(g(`nComp${own}`)), thin(g(`nComp${opp}`)));
        break;
      case 'dlogThin':
        x.push(Math.log(lOwn / lOpp) * Math.max(thin(g(`nComp${own}`)), thin(g(`nComp${opp}`))));
        break;
      case 'earlyL':
        x.push(g('isLeague') === 1 ? early(g(`games${own}`)) : 0, g('isLeague') === 1 ? early(g(`games${opp}`)) : 0);
        break;
      case 'mvHA':
        x.push(sgn * g('mvHA'));
        break;
      case 'mvOver':
        x.push(g('mvOver'));
        break;
    }
  }
  return x;
}

function termWidth(t: Term): number {
  return t === 'restDiff' || t === 'level' || t === 'home' || t === 'lgHA' || t === 'teamHA' || t === 'dlog' || t === 'dlogEarly' || t === 'dlogEarlyL' || t === 'dlogThin' || t === 'mvHA' || t === 'mvOver' ? 1 : 2;
}

interface Fitted {
  beta: number[];
  se: number[];
  n: number;
}

/** Regresor de contexto walk-forward (una instancia por variante). */
export class ContextRegressor {
  readonly opts: ContextOptions;
  private models = new Map<string, Fitted>();
  /** memo pura de fitLambdas (clave = entradas exactas) */
  private memo = new Map<string, { lambdaHome: number; lambdaAway: number }>();
  /** historial de ajustes (diagnóstico) */
  readonly log: { asOf: string; key: string; n: number; beta: number[]; se: number[] }[] = [];
  /** diagnóstico opcional: λ ajustados de cada partido combinado (no cambia ninguna salida) */
  debug?: (row: ComponentRow, d: { lh: number; la: number; mh: number; ma: number }) => void;

  constructor(opts: Partial<ContextOptions> = {}) {
    this.opts = { ...DEFAULT_CONTEXT, ...opts };
  }

  /** nombres de las columnas (diagnóstico) */
  columns(key = 'all'): string[] {
    const out: string[] = [];
    for (const t of this.termsFor(key)) {
      if (termWidth(t) === 1) out.push(t);
      else out.push(`${t}Own`, `${t}Opp`);
    }
    return out;
  }

  private termsFor(key: string): Term[] {
    const only = new Set(this.opts.eloGoalsOnlyTerms ?? []);
    return key === 'dc' ? this.opts.terms.filter((t) => !only.has(t)) : this.opts.terms;
  }

  private kappas(key: string): number[] {
    const k: number[] = [];
    for (const t of this.termsFor(key)) {
      const v = this.opts.kappaByTerm?.[t] ?? this.opts.kappa;
      for (let i = 0; i < termWidth(t); i++) k.push(v);
    }
    return k;
  }

  private keyOf(row: ComponentRow): string {
    return this.opts.level === 'goal' && this.opts.byKind ? row.goalKind : 'all';
  }

  private applies(row: ComponentRow, which: 'apply' | 'trainOn' = 'apply'): boolean {
    const a = (which === 'trainOn' ? (this.opts.trainOn ?? this.opts.apply) : this.opts.apply) ?? 'all';
    return a === 'all' || (a === 'odds' ? row.hasMarket : !row.hasMarket);
  }

  /** λ finales de producción (como el núcleo: fitLambdas del 1X2 y del más de 2,5 objetivo). */
  private finalLambdas(row: ComponentRow): { lambdaHome: number; lambdaAway: number; over25: number } {
    const over25 = productionOver25(row, row.goalOver25);
    const p = row.production;
    const k = `${p.home}|${p.draw}|${p.away}|${over25}|${row.rho}|${row.lambdaHome}|${row.lambdaAway}`;
    let l = this.memo.get(k);
    if (!l) {
      l = fitLambdas({ ...p, over25 }, row.rho, { lambdaHome: row.lambdaHome, lambdaAway: row.lambdaAway });
      this.memo.set(k, l);
    }
    return { ...l, over25 };
  }

  private lambdasOf(row: ComponentRow): { lh: number; la: number } {
    if (this.opts.level === 'goal') return { lh: row.lambdaHome, la: row.lambdaAway };
    const f = this.finalLambdas(row);
    return { lh: f.lambdaHome, la: f.lambdaAway };
  }

  prepare(rows: readonly WalkForwardRow[], asOf: string): void {
    const t = Date.parse(asOf);
    const limit = t - this.opts.guardHours * HOUR_MS;
    this.models.clear();
    const groups = new Map<string, GlmObs[]>();
    for (const r of rows) {
      const tr = Date.parse(r.date);
      if (!(tr < limit) || r.extraTimeUnresolved || !this.applies(r, 'trainOn')) continue;
      const { lh, la } = this.lambdasOf(r);
      if (!(lh > 0 && la > 0)) continue;
      const key = this.keyOf(r);
      const w = this.opts.halfLifeDays ? Math.pow(0.5, (t - tr) / DAY_MS / this.opts.halfLifeDays) : 1;
      const terms = this.termsFor(key);
      let list = groups.get(key);
      if (!list) groups.set(key, (list = []));
      list.push({ y: r.hg, offset: Math.log(lh), x: design(terms, r.features, 'H', lh, la), w });
      list.push({ y: r.ag, offset: Math.log(la), x: design(terms, r.features, 'A', la, lh), w });
    }
    for (const [key, obs] of groups) {
      if (obs.length / 2 < this.opts.minRows) continue;
      const fit = fitPoissonGlm(obs, this.kappas(key));
      if (!fit.beta.every(Number.isFinite)) continue;
      this.models.set(key, { beta: fit.beta, se: fit.se, n: obs.length / 2 });
      this.log.push({ asOf, key, n: obs.length / 2, beta: fit.beta, se: fit.se });
    }
  }

  /** Multiplicadores (local, visitante) del partido; [1, 1] sin modelo. */
  multipliers(row: ComponentRow, lh: number, la: number): [number, number] {
    if (!this.applies(row)) return [1, 1];
    const key = this.keyOf(row);
    const m = this.models.get(key);
    if (!m) return [1, 1];
    const terms = this.termsFor(key);
    const xh = design(terms, row.features, 'H', lh, la);
    const xa = design(terms, row.features, 'A', la, lh);
    let eh = 0;
    let ea = 0;
    for (let j = 0; j < m.beta.length; j++) {
      eh += m.beta[j] * xh[j];
      ea += m.beta[j] * xa[j];
    }
    const c = (e: number) => Math.min(this.opts.maxMult, Math.max(this.opts.minMult, Math.exp(e)));
    return [c(eh), c(ea)];
  }

  /**
   * Fila con la FUENTE DE GOLES ajustada (solo nivel 'goal'): λ, 1X2 de goles, más de 2,5 de goles y ensamble de
   * producción recalculados con los coeficientes vigentes. Sirve para encadenar este ajuste con otro combinador
   * (p. ej. `otro.blend(reg.adjustRow(row))`). Sin modelo devuelve la misma fila.
   */
  adjustRow<R extends ComponentRow>(row: R): R {
    if (this.opts.level !== 'goal') throw new Error('adjustRow solo existe en el nivel «goal»');
    const [mh, ma] = this.multipliers(row, row.lambdaHome, row.lambdaAway);
    if (mh === 1 && ma === 1) return row;
    const lh = row.lambdaHome * mh;
    const la = row.lambdaAway * ma;
    const o = dcOutcomes(lh, la, row.rho);
    const goal: Prob1X2 = { home: o.home, draw: o.draw, away: o.away };
    const pooled = poolWithGoal(row, goal, o.over25);
    const out: R = { ...row, goal, goalOver25: o.over25, lambdaHome: lh, lambdaAway: la, production: pooled.p };
    if (row.goalKind === 'dc') out.dc = goal;
    else out.eloGoals = goal;
    return out;
  }

  blend(row: ComponentRow): BlendResult {
    if (this.opts.level === 'goal') {
      const [mh, ma] = this.multipliers(row, row.lambdaHome, row.lambdaAway);
      this.debug?.(row, { lh: row.lambdaHome, la: row.lambdaAway, mh, ma });
      if (mh === 1 && ma === 1) return row.production;
      const o = dcOutcomes(row.lambdaHome * mh, row.lambdaAway * ma, row.rho);
      return poolWithGoal(row, { home: o.home, draw: o.draw, away: o.away }, o.over25);
    }
    const f = this.finalLambdas(row);
    const [mh, ma] = this.multipliers(row, f.lambdaHome, f.lambdaAway);
    this.debug?.(row, { lh: f.lambdaHome, la: f.lambdaAway, mh, ma });
    if (mh === 1 && ma === 1) return row.production;
    const o0 = dcOutcomes(f.lambdaHome, f.lambdaAway, row.rho);
    const o1 = dcOutcomes(f.lambdaHome * mh, f.lambdaAway * ma, row.rho);
    const p = row.production;
    const q = normalize3({ home: p.home + o1.home - o0.home, draw: p.draw + o1.draw - o0.draw, away: p.away + o1.away - o0.away });
    const over25 = Math.min(0.995, Math.max(0.005, f.over25 + o1.over25 - o0.over25));
    return { p: q, over25 };
  }
}

function normalize3(p: Prob1X2): Prob1X2 {
  const h = Math.max(1e-6, p.home);
  const d = Math.max(1e-6, p.draw);
  const a = Math.max(1e-6, p.away);
  const s = h + d + a;
  return { home: h / s, draw: d / s, away: a / s };
}

/** Objetivo de más de 2,5 de producción (núcleo: mezcla goles/mercado con los pesos efectivos). */
export function productionOver25(row: ComponentRow, goalOver25: number): number {
  const wG = row.weights.goal;
  const wM = row.weights.market;
  return row.marketOver25 !== undefined && wG + wM > 0 ? (wG * goalOver25 + wM * row.marketOver25) / (wG + wM) : goalOver25;
}

/** Pool lineal de producción con la fuente de goles sustituida (mismos pesos efectivos). */
export function poolWithGoal(row: ComponentRow, goal: Prob1X2, goalOver25: number): { p: Prob1X2; over25: number } {
  const w = row.weights;
  const pos = (x: number) => (x > 0 && Number.isFinite(x) ? x : 0);
  const sw = pos(w.goal) + pos(w.elo) + (row.market ? pos(w.market) : 0);
  const p = row.production;
  if (!(sw > 0) || !(pos(w.goal) > 0)) return { p, over25: productionOver25(row, goalOver25) };
  const k = pos(w.goal) / sw;
  const q = normalize3({
    home: p.home + k * (goal.home - row.goal.home),
    draw: p.draw + k * (goal.draw - row.goal.draw),
    away: p.away + k * (goal.away - row.goal.away),
  });
  return { p: q, over25: productionOver25(row, goalOver25) };
}
