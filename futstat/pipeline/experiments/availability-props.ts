/**
 * FACTOR: DISPONIBILIDAD DE JUGADORES (bajas probables y sanciones). Pre-registro completo (hipótesis, exploración
 * previa de T1, métricas objetivo, regla y muestra declarada) en la cabecera de availability-susp.ts, escrito el
 * 2026-11-26 ANTES de evaluar ninguna configuración. Resumen:
 *   - hipótesis: (a) las bajas probables (habitual ausente, expulsado en el último partido de la competición) quitan
 *     ataque al equipo en proporción a su participación; (b) en las props, el sancionado no juega y el habitual ausente
 *     juega menos de lo que da la EWMA de producción;
 *   - métricas objetivo: props (goleador, >= 1 a puerta, >= 2 tiros, tarjeta) en 1, 2 y 4; goles por equipo, RPS,
 *     tiros y tiros a puerta (y segmento «falta un habitual») en 3 y 4;
 *   - configuraciones (4): 1 availability-susp, 2 availability-props, 3 availability-team, 4 availability-full;
 *   - prev declarada «sin muestra» (líneas desde el 2026-05-07); decisión con T2 (y pooled para el IC).
 */
// Esta configuración: props: sancionados + habituales ausentes.
import { makeAvailabilityVariant } from './availability/make';

export default makeAvailabilityVariant('availability-props', 'Disponibilidad: sancionados (×0,03) y habituales ausentes (faltó 2: ×0,65; faltó el último de la misma competición: ×0,9) en las props', { props: 'all' });
