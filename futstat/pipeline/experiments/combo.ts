/**
 * Variante «combo» (agente de combinación): las ideas que pasan el protocolo, JUNTAS.
 *  1. tune-ha: ventaja local del Elo por grupo de competiciones en la conversión diferencia Elo → 1X2.
 *  2. totals-best: total de goles contraído 50 % hacia la media de la competición sin línea de goles del mercado
 *     (salvo copas nacionales) + córners/tarjetas con 40 partidos ficticios en la contracción de las tasas de equipo.
 */
import totals from './totals-best';
import tune from './tune-ha';
import type { ModelVariant } from './types';

const v: ModelVariant = {
  name: 'combo',
  description: 'tune-ha (ventaja local del Elo por grupo) + totals-best (total contraído sin línea de goles salvo copas; priorN 40 en córners/tarjetas)',
  combine: tune.combine,
  features: totals.features,
  totals: totals.totals,
  stats: totals.stats,
};

export default v;
