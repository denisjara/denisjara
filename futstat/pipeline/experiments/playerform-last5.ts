/**
 * Variante «playerform-last5» (configuración 2 de 4 del factor FORMA DE JUGADORES): (b) multiplicador de forma de las 5 últimas apariciones (xG aproximado por 90 reciente contraído hacia el de la ventana con K = 4, recortado a [0,67; 1,5]) en goles, tiros y tiros a puerta.
 *
 * Pre-registro completo (factor, hipótesis, MÉTRICAS OBJETIVO, configuraciones, ventanas y muestra declarada) en la
 * cabecera de playerform-hl60.ts, escrito el 2026-11-26 ANTES de evaluar ninguna configuración.
 */
import { makePlayerFormVariant } from './playerform/make';

export default makePlayerFormVariant('playerform-last5', 'Forma de jugadores (b): multiplicador de forma de las 5 últimas apariciones en goles, tiros y tiros a puerta de las props', {
  form: true,
});
