/**
 * Forma de goles → AJUSTE MULTIPLICATIVO DE LOS λ FINALES (ensamble de producción, mercado incluido) estimado con
 * regresión de Poisson walk-forward sobre los residuos:
 *
 *   goles de X contra Y ~ Poisson( λ_X · exp(β1·gfRes_X + β2·gaRes_Y + β3·xgfRes_X + β4·xgaRes_Y) )
 *
 * con offset log λ_X (λ finales de producción: fitLambdas del 1X2 y del objetivo de más de 2,5, como el núcleo) y los
 * rasgos de forma de features.ts. Dos observaciones por partido. L2 κ hacia 0 (β = 0 = producción). Modelos separados
 * para partidos CON y SIN cuotas (el mercado ya puede incorporar la forma; sin cuotas el ensamble es Elo + goles).
 * El cambio se aplica como delta sobre producción (igual que el nivel 'final' de context/regressor.ts):
 *   p = p_prod + [P(λ·m) − P(λ)],  más de 2,5 igual.
 *
 * Walk-forward: `prepare(rows, asOf)` (llamado por el núcleo en cada fecha de reajuste con filas de partidos
 * terminados anteriores a asOf) exige además que el partido empezara al menos 3 h antes; reajuste desde cero en cada
 * llamada; entre reajustes solo se guardan los coeficientes (estado gestionado por prepare, como pide el README). La
 * única caché es una memo PURA de fitLambdas (clave = sus entradas exactas).
 */
import { dcOutcomes, fitLambdas } from '../../../src/lib/models';
import type { Prob1X2 } from '../../../src/types/data';
import type { BlendResult, ComponentRow, Features, WalkForwardRow } from '../types';
import { fitPoissonGlm, type GlmObs } from '../context/glm';
import { productionOver25 } from '../context/regressor';

const HOUR_MS = 3_600_000;

export interface FormRegOptions {
  /** a qué partidos se aplica (y con cuáles se entrena cada modelo): todos o solo sin cuotas */
  apply: 'all' | 'noOdds';
  kappa: number;
  guardHours: number;
  minRows: number;
  minMult: number;
  maxMult: number;
}

export const DEFAULT_FORM_REG: FormRegOptions = { apply: 'all', kappa: 50, guardHours: 3, minRows: 200, minMult: 0.8, maxMult: 1.25 };

export const FORM_COLUMNS = ['gfResOwn', 'gaResOpp', 'xgfResOwn', 'xgaResOpp'];

function design(f: Features, own: 'H' | 'A'): number[] {
  const opp = own === 'H' ? 'A' : 'H';
  const g = (k: string) => (Number.isFinite(f[k]) ? f[k] : 0);
  return [g(`gfRes${own}`), g(`gaRes${opp}`), g(`xgfRes${own}`), g(`xgaRes${opp}`)];
}

function normalize3(p: Prob1X2): Prob1X2 {
  const h = Math.max(1e-6, p.home);
  const d = Math.max(1e-6, p.draw);
  const a = Math.max(1e-6, p.away);
  const s = h + d + a;
  return { home: h / s, draw: d / s, away: a / s };
}

export class FormRegressor {
  readonly opts: FormRegOptions;
  private models = new Map<string, number[]>();
  private memo = new Map<string, { lambdaHome: number; lambdaAway: number }>();
  /** historial de ajustes (diagnóstico) */
  readonly log: { asOf: string; key: string; n: number; beta: number[]; se: number[] }[] = [];

  constructor(opts: Partial<FormRegOptions> = {}) {
    this.opts = { ...DEFAULT_FORM_REG, ...opts };
  }

  private keyOf(row: ComponentRow): string | undefined {
    if (row.hasMarket) return this.opts.apply === 'all' ? 'odds' : undefined;
    return 'noOdds';
  }

  /** λ finales de producción (como el núcleo: fitLambdas del 1X2 y del más de 2,5 objetivo). */
  finalLambdas(row: ComponentRow): { lambdaHome: number; lambdaAway: number; over25: number } {
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

  prepare(rows: readonly WalkForwardRow[], asOf: string): void {
    const limit = Date.parse(asOf) - this.opts.guardHours * HOUR_MS;
    this.models.clear();
    const groups = new Map<string, GlmObs[]>();
    for (const r of rows) {
      if (!(Date.parse(r.date) < limit) || r.extraTimeUnresolved) continue;
      const key = this.keyOf(r);
      if (!key) continue;
      const f = this.finalLambdas(r);
      if (!(f.lambdaHome > 0 && f.lambdaAway > 0)) continue;
      let list = groups.get(key);
      if (!list) groups.set(key, (list = []));
      list.push({ y: r.hg, offset: Math.log(f.lambdaHome), x: design(r.features, 'H') });
      list.push({ y: r.ag, offset: Math.log(f.lambdaAway), x: design(r.features, 'A') });
    }
    for (const [key, obs] of groups) {
      if (obs.length / 2 < this.opts.minRows) continue;
      const fit = fitPoissonGlm(obs, FORM_COLUMNS.map(() => this.opts.kappa));
      if (!fit.beta.every(Number.isFinite)) continue;
      this.models.set(key, fit.beta);
      this.log.push({ asOf, key, n: obs.length / 2, beta: fit.beta, se: fit.se });
    }
  }

  multipliers(row: ComponentRow): [number, number] {
    const key = this.keyOf(row);
    const beta = key ? this.models.get(key) : undefined;
    if (!beta) return [1, 1];
    const xh = design(row.features, 'H');
    const xa = design(row.features, 'A');
    let eh = 0;
    let ea = 0;
    for (let j = 0; j < beta.length; j++) {
      eh += beta[j] * xh[j];
      ea += beta[j] * xa[j];
    }
    const c = (e: number) => Math.min(this.opts.maxMult, Math.max(this.opts.minMult, Math.exp(e)));
    return [c(eh), c(ea)];
  }

  blend(row: ComponentRow): BlendResult {
    const [mh, ma] = this.multipliers(row);
    if (mh === 1 && ma === 1) return row.production;
    const f = this.finalLambdas(row);
    const o0 = dcOutcomes(f.lambdaHome, f.lambdaAway, row.rho);
    const o1 = dcOutcomes(f.lambdaHome * mh, f.lambdaAway * ma, row.rho);
    const p = row.production;
    const q = normalize3({ home: p.home + o1.home - o0.home, draw: p.draw + o1.draw - o0.draw, away: p.away + o1.away - o0.away });
    const over25 = Math.min(0.995, Math.max(0.005, f.over25 + o1.over25 - o0.over25));
    return { p: q, over25 };
  }
}
