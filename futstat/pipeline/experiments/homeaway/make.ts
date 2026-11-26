/**
 * Fábricas de las variantes «homeaway-*» (factor LOCAL/VISITANTE; pre-registro en la cabecera de homeaway-goals.ts):
 *  - `makeHomeAwayGoalsVariant`: ventaja local propia de cada equipo en goles (goals.ts): rasgos con `features`,
 *    τ² empírico-bayesiano en `combine.prepare` (reajuste cada 7 días) y delta de la supremacía en `combine.blend`.
 *  - `makeHomeAwayStatsVariant`: fuerza de la separación por condición de las estadísticas (stats.ts) con `stats.adjust`.
 */
import type { ModelVariant } from '../types';
import { HomeAwayCombiner, homeAwayFeatures, type HomeAwayGoalOptions } from './goals';
import { venueMultipliers, type VenueOptions } from './stats';

export function makeHomeAwayGoalsVariant(name: string, description: string, opts: HomeAwayGoalOptions): ModelVariant & { combiner: HomeAwayCombiner } {
  const comb = new HomeAwayCombiner(opts);
  return {
    name,
    description,
    combiner: comb,
    features: homeAwayFeatures,
    combine: {
      refitEvery: 7,
      prepare: (rows, asOf) => comb.prepare(rows, asOf),
      blend: (row) => comb.blend(row),
    },
  };
}

export function makeHomeAwayStatsVariant(name: string, description: string, opts: VenueOptions): ModelVariant {
  return {
    name,
    description,
    stats: {
      adjust({ match, history, base }) {
        return venueMultipliers(match, history, base, opts);
      },
    },
  };
}
