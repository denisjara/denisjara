/**
 * Variante «tune-ha» (agente de ajuste de hiperparámetros): ventaja local del Elo POR GRUPO de competiciones, solo en
 * la conversión diferencia Elo → probabilidades 1X2: ligas europeas 50, copas europeas 25, continentales europeas 80,
 * ligas americanas 70, continentales americanas 75 (copa de Chile y resto: 65 = producción). Ratings (se actualizan
 * con 65), Dixon-Coles, pesos del ensamble y mercado: producción.
 *
 * Por qué: la ventaja local global (65) es inestable entre sub-ventanas (el Elo solo prefiere ~75 en T1 —ligas
 * americanas— y ~30 en T2 —sobre todo Europa—). La tabla se eligió SOLO con el Elo solo en 9.659 partidos de
 * 2025-01 → 2026-05 (anterior a la ventana de ajuste) y mejora el Elo solo en cada semestre de esa historia, en T1 y
 * en T2. Elegir la tabla en T1 (o en T2) y confirmarla en la otra sub-ventana NO funciona (sobreajuste): la tabla
 * histórica es la única estable. Superficie plana: ±5–10 puntos por grupo dan casi lo mismo.
 *
 * Banco (21-nov-2026, resultado a 90'): RPS 1X2 tuning −0,00025 [−0,00044; −0,00008] · T1 −0,00006 [−0,00017;
 * +0,00005] (T1 apenas tiene partidos europeos) · T2 −0,00029 [−0,00055; −0,00008]; log-loss y Brier también; ambos
 * marcan −0,00015 de Brier (tuning, IC < 0); fuga OK. Ojo: en T2 los locales ganaron el 40,4 % frente al 44,2 % que
 * daba el mercado de cierre, así que parte de la mejora de T2 es suerte de la ventana.
 *
 *   npx tsx scripts/eval-model.ts --variant=tune-ha --window=tuning
 */
import { HA_REGION_KIND, makeTuneVariant } from './tune/variant';

export default makeTuneVariant({
  name: 'tune-ha',
  description: 'Ventaja local del Elo por grupo (EU ligas 50 · EU copas 25 · EU continental 80 · AM ligas 70 · AM continental 75) en las probabilidades',
  table: HA_REGION_KIND,
});
