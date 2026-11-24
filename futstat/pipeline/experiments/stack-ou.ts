/**
 * Variante «stack-ou»: «stack» (1X2) + apilado logístico walk-forward del objetivo de MÁS DE 2,5 en partidos con
 * línea de goles del mercado: logit p = a·logit(goles) + b·logit(mercado) + c, L2 hacia producción (κ = 100).
 */
import { OverStacker, StackCombiner } from './stack/combiner';
import type { ModelVariant } from './types';

const comb = new StackCombiner({ kappa: 30, kappaFeat: 1e9, apply: 'odds', lowData: true });
const ou = new OverStacker({ kappa: 100, noMarket: false });

const v: ModelVariant = {
  name: 'stack-ou',
  description: 'stack + objetivo de más de 2,5 apilado (logístico, L2 hacia producción) cuando hay línea de goles del mercado',
  combine: {
    refitEvery: 'monthly',
    prepare: (rows, asOf) => {
      comb.prepare(rows, asOf);
      ou.prepare(rows, asOf);
    },
    blend: (row) => {
      const over25 = ou.predict(row);
      const p = comb.blend(row);
      return over25 === undefined ? p : { p, over25 };
    },
  },
};

export default v;
