/**
 * Variante «playerform-fac6x40» (configuración 4 de 4 del factor FORMA DE JUGADORES): (c) factores del rival de las props con contracción débil (6) del nivel propio del equipo y la de producción (40) en lo que concede el rival; proyecciones de equipo de producción intactas.
 *
 * Pre-registro completo (factor, hipótesis, MÉTRICAS OBJETIVO, configuraciones, ventanas y muestra declarada) en la
 * cabecera de playerform-hl60.ts, escrito el 2026-11-26 ANTES de evaluar ninguna configuración.
 */
import { makePlayerFormVariant } from './playerform/make';

export default makePlayerFormVariant('playerform-fac6x40', 'Forma de jugadores (c): factores del rival de las props con contracción 6 del nivel propio y 40 del rival, proyecciones de equipo intactas', {
  factors: { forN: 6, agN: 40 },
});
