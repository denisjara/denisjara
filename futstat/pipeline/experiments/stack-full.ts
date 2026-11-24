/**
 * Variante «stack-full»: el combinador COMPLETO de la idea original, para documentar que NO funciona.
 * Regresión logística multinomial estructurada sobre log-probabilidades de mercado, DC, Elo→goles y Elo, con pesos
 * distintos para el contraste de empate (corrección de empates), interceptos de calibración (ventaja local y empate),
 * rasgos (logit de más de 2,5 y |dif. Elo| en el empate; copa/continental/neutral en la ventaja local; partidos Elo
 * escasos e inicio de temporada × fuentes), L2 hacia producción (κ = 50) y modelos separados con y sin cuotas.
 */
import { StackCombiner } from './stack/combiner';
import { stackFeatures } from './stack/features';
import type { ModelVariant } from './types';

const comb = new StackCombiner({
  kappa: 50,
  separateDraw: true,
  drawFeatures: ['tot', 'absdiff'],
  strengthFeatures: ['kind', 'neutral'],
  lowData: true,
  early: true,
  apply: 'both',
});

const v: ModelVariant = {
  name: 'stack-full',
  description: 'Combinador completo (multinomial con rasgos, corrección de empates e interceptos, con y sin cuotas): referencia negativa',
  features: stackFeatures,
  combine: {
    refitEvery: 'monthly',
    prepare: (rows, asOf) => comb.prepare(rows, asOf),
    blend: (row) => comb.blend(row),
  },
};

export default v;
