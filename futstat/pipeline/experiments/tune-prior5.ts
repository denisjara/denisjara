/**
 * Variante «tune-prior5» (DESCARTADA, se deja como registro): prior del Dixon-Coles de 5 partidos (producción 2). La
 * fuente de goles sola mejora en T1, T2 y pre, pero el ensamble empeora en las ligas top (tier >= 8) de T2
 * (+0,00015 [+0,00005; +0,00025]) y el 1X2 global no cambia. Ver tune-prior3.
 */
import { makeTuneVariant } from './tune/variant';

export default makeTuneVariant({ name: 'tune-prior5', description: 'Dixon-Coles con prior de 5 partidos (producción 2)', dc: { priorWeight: 5 } });
