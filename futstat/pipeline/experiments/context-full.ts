/**
 * Variante «context-full»: todos los términos de contexto sobre la fuente de goles: descanso, congestión, Europa,
 * ascenso, inicio de temporada, ventaja local reciente de la competición y del equipo, constante local, calibración de
 * la diferencia de fuerzas (dlog, dlog × inicio) y movimiento de cuotas apertura → cierre. Regresión de Poisson
 * walk-forward, κ = 30. Resultado: NO mejora (empeora más/menos 2,5 en tuning). Ver context/README.md.
 *
 *   npx tsx scripts/eval-model.ts --variant=context-full --window=tuning
 */
import { makeContextVariant } from './context/make';

export default makeContextVariant({
  name: 'context-full',
  description: 'Todos los términos de contexto (incl. ventaja local liga/equipo, dlog y movimiento de cuotas) sobre la fuente de goles',
  options: {
    level: 'goal',
    terms: ['short', 'long', 'n14', 'euro', 'prom', 'early', 'home', 'lgHA', 'teamHA', 'dlog', 'dlogEarly', 'mvHA', 'mvOver'],
    kappa: 30,
  },
});
