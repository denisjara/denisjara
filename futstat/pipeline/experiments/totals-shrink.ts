/**
 * Variante «totals-shrink»: en partidos SIN línea de goles del mercado, contrae el total de goles esperado hacia la
 * media de la competición (últimos 365 días, vida media 180 días, 30 partidos ficticios hacia 2,6):
 * T' = L + 0,5·(T − L). El 1X2 no cambia (el núcleo recalibra los λ manteniéndolo). Con línea de goles del mercado no
 * se toca nada. Con `skipCups` (variante «totals-shrink-nocup») tampoco en copas nacionales: sus cruces entre
 * divisiones tienen totales extremos de verdad (no por ruido del ajuste) y contraerlos empeoró en T1, T2 y pre.
 */
import { hasMarketTotal, leagueTotal, shrinkFactor } from './totals/model';
import type { ModelVariant } from './types';

export const SHRINK = 0.5;

/** Variante de contracción del total con fuerza `s` (1 = sin cambio); `skipCups`: no tocar las copas nacionales. */
export function shrinkVariant(name: string, description: string, s: number, skipCups = false): ModelVariant {
  return {
    name,
    description,
    features(_ctx, match, before) {
      return { lgTotal: leagueTotal(before, match.compId).mean };
    },
    totals: {
      adjustTotal(input) {
        if (hasMarketTotal(input)) return 1;
        if (skipCups && input.ctx.comp.kind === 'cup') return 1;
        return shrinkFactor(input.lambdaHome + input.lambdaAway, input.features.lgTotal, s);
      },
    },
  };
}

export default shrinkVariant(
  'totals-shrink',
  'Sin línea de goles del mercado: total esperado contraído 50 % hacia la media de goles de la competición',
  SHRINK,
);
