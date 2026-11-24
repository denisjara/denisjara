/**
 * Fábrica de las variantes «context*»: rasgos de contexto (features.ts) + regresión de Poisson walk-forward sobre los
 * residuos (regressor.ts) aplicada en el combinador (`combine.prepare` reajusta con el pasado, `combine.blend` aplica
 * los multiplicadores de λ y reconstruye el ensamble de producción). No usa `lambdaAdjust`: ese gancho se evalúa
 * antes de cualquier reajuste del combinador y no podría usar coeficientes estimados walk-forward.
 */
import type { ModelVariant } from '../types';
import { contextFeatures } from './features';
import { ContextRegressor, type ContextOptions } from './regressor';

export interface ContextVariantSpec {
  name: string;
  description: string;
  options: Partial<ContextOptions>;
  /** cada cuánto se reajusta la regresión (días o 'monthly') */
  refitEvery?: 'monthly' | number;
}

export function makeContextVariant(spec: ContextVariantSpec): ModelVariant & { regressor: ContextRegressor } {
  const reg = new ContextRegressor(spec.options);
  return {
    name: spec.name,
    description: spec.description,
    regressor: reg,
    features: contextFeatures,
    combine: {
      refitEvery: spec.refitEvery ?? 7,
      prepare: (rows, asOf) => reg.prepare(rows, asOf),
      blend: (row) => reg.blend(row),
    },
  };
}
