/**
 * Variante «totals-best» (propuesta del agente «totals»): las dos ideas que mejoran sin tocar el 1X2.
 *  1. Sin línea de goles del mercado y fuera de copas nacionales: total de goles esperado contraído 50 % hacia la
 *     media de goles de la competición (totals-shrink-nocup). Con línea de goles del mercado no se toca nada.
 *  2. Córners/tarjetas (y demás estadísticas contables): contracción de las tasas de equipo con 40 partidos ficticios
 *     en lugar de 6 (totals-stats).
 */
import shrink from './totals-shrink-nocup';
import stats from './totals-stats';
import type { ModelVariant } from './types';

const v: ModelVariant = {
  name: 'totals-best',
  description: 'totals-shrink-nocup (total contraído 50 % hacia la media de la competición sin línea de goles, salvo copas) + totals-stats (priorN 40)',
  features: shrink.features,
  totals: shrink.totals,
  stats: stats.stats,
};

export default v;
