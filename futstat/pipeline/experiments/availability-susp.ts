/**
 * FACTOR: DISPONIBILIDAD DE JUGADORES (bajas probables y sanciones). Pre-registro escrito el 2026-11-26 ANTES de
 * evaluar ninguna configuración (lo único mirado antes: la exploración descriptiva de T1 de abajo).
 *
 * Hipótesis:
 *   (a) un equipo con habituales ausentes (>= 60 % de los minutos en sus 5 últimos partidos y no jugó el último:
 *       lesión probable) o con un expulsado en su último partido de la MISMA competición (sanción probable) pierde
 *       ataque en proporción a la participación de esos jugadores (goles + proxy de xG, tiros, tiros a puerta) ⇒ λ de
 *       goles del equipo y sus tiros / tiros a puerta más bajos (lambdaAdjust + stats.adjust; K = 0,5, suelo 0,85).
 *       Con cuotas el mercado pesa 0,8 y las de cierre YA conocen las alineaciones: se espera ~0 en 1X2/goles; los
 *       tiros no tienen mercado. Defensa (porteros/defensas ausentes ⇒ más goles encajados): NO se prueba (sin forma
 *       fija defendible y para no gastar configuraciones).
 *   (b) en las props, el sancionado no juega (minutesFactor ≈ 0) y el habitual que faltó a los 2 últimos juega menos
 *       de lo que da la EWMA de producción (ya cuenta 0 en los partidos que faltó).
 * Detalle de las clases, probabilidades y fórmulas: availability/model.ts.
 *
 * Exploración previa (descriptiva, SOLO T1 = 06-01..07-31, jugadores que producción publicaría; script fuera del
 * repo): expulsado en el último partido de la competición → jugó 0 de 35 (minutos esperados de producción 54);
 * habitual que faltó a los 2 últimos → jugó 23,5 % (n 34), minutos reales/esperados 0,55; faltó el último de la misma
 * competición → 46 % (n 207), 0,79; de otra competición → 74 % (n 50), 1,22; control (habituales que jugaron el
 * último) → 85 %, 0,86. Factores de minutos fijados con eso: sancionado 0,03 (≈ no juega; 0 lo sacaría de los pares
 * comunes que puntúa el banco, ver SUSP_MINUTES_FACTOR), faltó 2 → 0,65 (= 0,55/0,86), faltó 1 misma competición →
 * 0,9 (≈ 0,79/0,86), otra competición → 1 (sin cambio, n pequeña). Por eso T1 NO es limpia para las props de
 * availability-props / availability-full: la decisión se apoya en T2.
 *
 * MÉTRICAS OBJETIVO (Δ frente a `production`, IC 95 % bootstrap por día):
 *   - props (configuraciones 1, 2 y 4): Brier de goleador, >= 1 tiro a puerta, >= 2 tiros y tarjeta de jugador;
 *   - equipo (configuraciones 3 y 4): Brier de goles por equipo (`goalsTeam`), RPS 1X2, Brier de tiros y de tiros a
 *     puerta; y las mismas en el segmento «falta un habitual» como lectura secundaria.
 *
 * CONFIGURACIONES PLANEADAS (4, el máximo; todas se cuentan y se informan):
 *   1. availability-susp   props: solo sancionados (minutesFactor 0,03)                      ← esta
 *   2. availability-props  props: sancionados + habituales ausentes (0,65 / 0,9 / 1)
 *   3. availability-team   equipo: λ de la fuente de goles y tiros / a puerta (K 0,5, suelo 0,85), props sin cambio
 *                          salvo deshacer el multiplicador de tiros en los compañeros
 *   4. availability-full   2 + 3
 *
 * Ventanas: T1, T2, prev (y pooled). Muestra declarada ANTES de evaluar: `prev` = «sin muestra» para TODAS las
 * configuraciones (las líneas de jugador empiezan el 2026-05-07: las bajas exigen 5 partidos con líneas, así que en
 * prev casi ningún partido tiene bajas detectables; README: «los factores de jugadores se juzgan sin prev»). Se evalúa
 * y se informa igualmente (y sirve para la condición 3: nada significativamente peor). La regla se aplica entonces con
 * T2 en lugar de «T2 y prev» en la condición 1, y la condición 2 con T2 o pooled.
 * Si pasan varias: se recomienda availability-full si pasa; si no, availability-props; si no, availability-susp; si
 * no, availability-team. No se evalúa ninguna configuración más.
 * Producción: necesita solo datos que ya existen antes del partido (líneas y eventos de partidos anteriores); el
 * sancionado se dejaría sin publicar (factor 0).
 */
// Esta configuración: props, solo sancionados.
import { makeAvailabilityVariant } from './availability/make';

export default makeAvailabilityVariant(
  'availability-susp',
  'Disponibilidad: el expulsado en el último partido del equipo en la competición no juega (props, minutos ×0,03)',
  { props: 'susp' },
);
