/**
 * Variante «tune-prior3»: prior del Dixon-Coles de 3 partidos equivalentes (producción 2). Superficie del prior (RPS
 * de la fuente de goles sola): 0 y 1 empeoran; 3 mejora en T1, T2 y pre; 5–12 mejoran más la fuente sola en T1 y pre
 * pero empeoran el ensamble en las ligas top (tier >= 8) de T2. 3 es el valor estable. Efecto en el ensamble 1X2 ≈ 0;
 * más/menos 2,5 y ambos marcan mejoran claramente solo en `pre` (sin cuotas), con el mismo signo sin significación en
 * T1 y T2; ligas top +0,00006 de RPS (IC > 0, diminuto).
 */
import { makeTuneVariant } from './tune/variant';

export default makeTuneVariant({ name: 'tune-prior3', description: 'Dixon-Coles con prior de 3 partidos (producción 2)', dc: { priorWeight: 3 } });
