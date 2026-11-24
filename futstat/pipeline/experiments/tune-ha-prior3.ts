/**
 * Variante «tune-ha-prior3» (mejor configuración del agente «tune»): tune-ha (ventaja local del Elo por grupo de
 * competiciones en las probabilidades) + Dixon-Coles con prior de 3 partidos (producción 2). Resto de hiperparámetros:
 * producción (todos los demás se probaron y no mejoran de forma estable en T1 y T2: ver el informe del agente).
 *
 * Banco (21-nov-2026, resultado a 90'): RPS 1X2 tuning 0,19861 → 0,19835 (−0,00026 [−0,00045; −0,00009]) · T1
 * −0,00006 [−0,00018; +0,00007] · T2 −0,00030 [−0,00056; −0,00010]; ambos marcan tuning −0,00018 [−0,00037; −0,00002];
 * más/menos 2,5 −0,00005 (IC cruza 0 en T1 y T2; −0,00067 [−0,00099; −0,00035] en `pre`, casi todo sin cuotas);
 * fuga OK. Casi toda la mejora 1X2 es de la ventaja por grupo; el prior 3 solo aporta en totales sin cuotas.
 *
 *   npx tsx scripts/eval-model.ts --variant=tune-ha-prior3 --window=tuning
 */
import { HA_REGION_KIND, makeTuneVariant } from './tune/variant';

export default makeTuneVariant({
  name: 'tune-ha-prior3',
  description: 'Ventaja local del Elo por grupo (tune-ha) + Dixon-Coles con prior de 3 partidos',
  table: HA_REGION_KIND,
  dc: { priorWeight: 3 },
});
