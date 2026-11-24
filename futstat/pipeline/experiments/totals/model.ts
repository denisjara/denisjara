/**
 * Piezas del agente «totals» (totales de goles, ambos marcan, goles por equipo, córners y tarjetas).
 *
 * Diagnóstico que las motiva (ventanas pre/T1/T2, nunca holdout):
 *  - Sin línea de goles del mercado, el total esperado del Dixon-Coles está demasiado disperso ENTRE partidos: donde
 *    predice 1,78 goles hubo 2,12 y donde predice 3,25 hubo 2,85 (pre, 815 partidos sin cuotas; pendiente logística de
 *    la recalibración de más de 2,5 ≈ 0,63). Se contrae el total hacia la media de la competición.
 *  - Con línea de goles del mercado, el mercado es mucho más fino que cualquier pieza propia: no se toca.
 *
 * Todo se calcula con la vista del pasado (HistoryView) del propio partido: sin estado global entre llamadas.
 *
 * La contracción sin línea de goles (salvo copas) está en PRODUCCIÓN desde el 22-nov-2026: el código vive en
 * pipeline/analytics/totals.ts y aquí solo se reexporta.
 */
import type { TotalsInput } from '../types';

// Integradas en producción el 22-nov-2026 (pipeline/analytics/totals.ts): se reexportan para las variantes y tests.
export { GLOBAL_TOTAL, LEAGUE_TOTAL_DEFAULTS, leagueTotal, shrinkFactor, type LeagueTotalOptions } from '../../analytics/totals';

/** ¿El partido tiene línea de goles del mercado? (si la tiene, el total ya viene del mercado y no se toca) */
export function hasMarketTotal(input: Pick<TotalsInput, 'ctx'>): boolean {
  return input.ctx.market?.over25 !== undefined;
}
