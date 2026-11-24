/**
 * Variante «stack»: COMBINADOR APRENDIDO walk-forward para los partidos CON cuotas.
 *
 * Sustituye el pool lineal de pesos fijos (mercado 0,8 / Elo 0,15 / DC 0,05) por un pool LOGARÍTMICO cuyos pesos
 * (mercado, Dixon-Coles, Elo→goles, Elo y su interacción con «equipo con < 10 partidos Elo») se reajustan el día 1 de
 * cada mes por máxima verosimilitud con L2 HACIA los pesos de producción (κ = 30), solo con partidos terminados que
 * empezaron al menos 3 h antes de la fecha de reajuste. Sin interceptos ni rasgos (los probé: empeoran T1).
 * Los partidos SIN cuotas siguen con el pool lineal de producción (DC 0,5 / Elo 0,5): ningún combinador aprendido lo
 * mejoró (ver stack-full y el informe del agente).
 *
 * Banco (21-nov-2026, resultado a 90'): RPS 1X2 tuning −0,00072 [−0,00134; −0,00008] · T1 −0,00054 [−0,00194; +0,00091]
 * · T2 −0,00075 [−0,00140; −0,00002]; fuga OK. Ojo: en ligas top (tier >= 8, todo en T2) +0,0013 (agosto, sin datos
 * top de la temporada en el entrenamiento); más/menos 2,5 +0,0001 de Brier (ver stack-ou, que lo corrige).
 *
 *   npx tsx scripts/eval-model.ts --variant=stack --window=tuning
 */
import { StackCombiner } from './stack/combiner';
import type { ModelVariant } from './types';

const comb = new StackCombiner({ kappa: 30, kappaFeat: 1e9, apply: 'odds', lowData: true });

const stack: ModelVariant = {
  name: 'stack',
  description: 'Combinador aprendido (pool logarítmico, pesos reajustados cada mes con L2 hacia producción) con cuotas; sin cuotas = producción',
  combine: {
    refitEvery: 'monthly',
    prepare: (rows, asOf) => comb.prepare(rows, asOf),
    blend: (row) => comb.blend(row),
  },
};

export default stack;
