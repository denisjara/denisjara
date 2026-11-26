/**
 * Variante «playerform-fac6» (configuración 3 de 4 del factor FORMA DE JUGADORES): (c) factores del rival de las props (tiros, a puerta, tarjetas) con la contracción anterior de las tasas de equipo (priorN 6 en el «a favor» propio y en el «en contra» del rival); proyecciones de equipo de producción intactas.
 *
 * Pre-registro completo (factor, hipótesis, MÉTRICAS OBJETIVO, configuraciones, ventanas y muestra declarada) en la
 * cabecera de playerform-hl60.ts, escrito el 2026-11-26 ANTES de evaluar ninguna configuración.
 */
import { makePlayerFormVariant } from './playerform/make';

export default makePlayerFormVariant('playerform-fac6', 'Forma de jugadores (c): factores del rival de las props con contracción 6/6 (la anterior a 40), proyecciones de equipo intactas', {
  factors: { forN: 6, agN: 6 },
});
