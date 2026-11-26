/**
 * Fábricas de las variantes «form-*» (forma reciente del equipo):
 *  - `makeFormGoalsVariant`: rasgos de forma de goles (features.ts) + regresión de Poisson walk-forward sobre los λ
 *    finales en el combinador (combiner.ts). No usa `lambdaAdjust`: ese gancho no puede usar coeficientes estimados.
 *  - `makeFormStatsVariant`: `stats.adjust` con multiplicadores de forma estadística (statForm de features.ts):
 *    media de local = base · forma a favor del local · forma en contra del visitante (y al revés).
 */
import type { StatKey } from '../../analytics/projections';
import type { ModelVariant, StatPairs } from '../types';
import { FormRegressor, type FormRegOptions } from './combiner';
import { formFeatures, statForm, type StatFormOptions } from './features';

export function makeFormGoalsVariant(
  name: string,
  description: string,
  opts: Partial<FormRegOptions>,
): ModelVariant & { regressor: FormRegressor } {
  const reg = new FormRegressor(opts);
  return {
    name,
    description,
    regressor: reg,
    features: formFeatures,
    combine: {
      refitEvery: 7,
      prepare: (rows, asOf) => reg.prepare(rows, asOf),
      blend: (row) => reg.blend(row),
    },
  };
}

/** Estadísticas a las que se aplica la forma (las tarjetas no: dependen sobre todo del árbitro). */
export const FORM_STAT_KEYS: StatKey[] = ['corners', 'shots', 'shotsOnTarget', 'fouls'];

export function makeFormStatsVariant(name: string, description: string, opts: StatFormOptions): ModelVariant {
  return {
    name,
    description,
    stats: {
      adjust({ match, history, base }) {
        const out: StatPairs = {};
        for (const key of FORM_STAT_KEYS) {
          if (!base[key]) continue;
          const h = statForm(history, match.home.id, key, opts);
          const a = statForm(history, match.away.id, key, opts);
          const lim = (x: number) => Math.min(opts.maxMult, Math.max(1 / opts.maxMult, x));
          out[key] = { home: lim(h.forM * a.agM), away: lim(a.forM * h.agM) };
        }
        return out;
      },
    },
  };
}
