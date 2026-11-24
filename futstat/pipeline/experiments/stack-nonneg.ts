/**
 * Variante «stack-nonneg»: como «stack» pero con pesos de fuente >= 0 (una fuente con peso negativo se fija a 0 y se
 * reajusta). Más fácil de explicar al usuario («el modelo nunca resta a una fuente»), algo menos de mejora.
 */
import { StackCombiner } from './stack/combiner';
import type { ModelVariant } from './types';

const comb = new StackCombiner({ kappa: 30, kappaFeat: 1e9, apply: 'odds', lowData: true, nonNeg: true });

const v: ModelVariant = {
  name: 'stack-nonneg',
  description: 'Combinador aprendido con cuotas (pool logarítmico, pesos >= 0, L2 hacia producción); sin cuotas = producción',
  combine: {
    refitEvery: 'monthly',
    prepare: (rows, asOf) => comb.prepare(rows, asOf),
    blend: (row) => comb.blend(row),
  },
};

export default v;
