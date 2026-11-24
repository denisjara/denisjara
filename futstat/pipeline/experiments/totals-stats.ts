/**
 * Variante «totals-stats»: córners y tarjetas (y el resto de estadísticas contables) con más contracción de las tasas
 * de cada equipo hacia la media de la competición: 40 partidos ficticios en lugar de 6. El resto, como producción.
 */
import type { ModelVariant } from './types';

const v: ModelVariant = {
  name: 'totals-stats',
  description: 'Córners/tarjetas: contracción de las tasas de equipo con 40 partidos ficticios (producción 6)',
  stats: { priorN: 40 },
};

export default v;
