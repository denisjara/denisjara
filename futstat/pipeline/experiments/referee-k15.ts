/**
 * FACTOR: SEVERIDAD DEL ÁRBITRO (pre-registro escrito el 2026-11-26 ANTES de evaluar ninguna configuración).
 *
 * Hipótesis: los árbitros difieren en cuántas tarjetas (y faltas) señalan; un multiplicador walk-forward del árbitro
 * designado (observado / esperado en sus partidos anteriores, contraído hacia 1 con k partidos ficticios; detalle en
 * referee/model.ts) mejora las tarjetas (total y por equipo) y quizá las faltas. Se aplica con stats.adjust igual a
 * los dos equipos; sin árbitro (o sin partidos previos suyos) el multiplicador es 1 = producción.
 *
 * MÉTRICAS OBJETIVO (Δ frente a `production`, IC 95 % bootstrap por día):
 *   - tarjetas: `cards` (Brier medio 3,5/4,5 del total) y `teamCards` (Brier medio 1,5/2,5 por equipo);
 *   - faltas: `fouls` (Brier medio 20,5/22,5/24,5), SOLO en la configuración que toca faltas (referee-fouls-k30);
 *   - segmento «árbitro conocido» (>= 5 partidos previos) de esas mismas métricas, como lectura secundaria;
 *   - comprobación secundaria (no objetivo): la prop de tarjeta de jugador (`pCard`) debe moverse en la misma dirección.
 *
 * CONFIGURACIONES PLANEADAS (4, el máximo; todas se cuentan y se informan):
 *   1. referee-k15        tarjetas, k = 15
 *   2. referee-k30        tarjetas, k = 30
 *   3. referee-k60        tarjetas, k = 60
 *   4. referee-fouls-k30  tarjetas k = 30 (idénticas a referee-k30) + faltas con su propio ratio, k = 30
 * Esperado = media de la competición/temporada de cada partido del árbitro (aproximación declarada a la proyección de
 * producción), sin decaimiento temporal.
 *
 * Ventanas: T1, T2, prev y pooled. Regla (README, pre-registro 2026-11-26), aplicada así:
 *   - las configuraciones 1-3 se juzgan en `cards` y `teamCards` (las dos con Δ < 0 en T2 y en prev; IC de alguna que
 *     excluya el 0 en T2, prev o pooled; nada significativamente peor en T1 ni en otra métrica principal en T1/T2/prev);
 *   - la 4 se juzga además en `fouls` (mismas condiciones);
 *   - si pasan varias: se recomienda referee-fouls-k30 si pasa ella (y por tanto referee-k30); si no, la de 1-3 con
 *     mejor Δ `cards` en pooled. No se evalúa ninguna configuración más.
 * Muestra: ninguna ventana se declara «sin muestra» (tarjetas: T1 n ≈ 140+, T2 ≈ 1.100, prev ≈ 2.600; árbitro en
 * ~98-100 % de los partidos).
 * Producción: hoy ESPN NO da el árbitro de los partidos programados ⇒ en producción el multiplicador sería 1 (sin
 * efecto) hasta que exista esa información antes del inicio.
 */
// Esta configuración: Árbitro: multiplicador walk-forward de tarjetas (k = 15), observado/esperado contraído hacia 1.
import { makeRefereeVariant } from './referee/make';

export default makeRefereeVariant('referee-k15', 'Árbitro: multiplicador walk-forward de tarjetas (k = 15), observado/esperado contraído hacia 1', { kCards: 15 });
