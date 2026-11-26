/**
 * FACTOR: RENDIMIENTO LOCAL / VISITANTE POR EQUIPO (pre-registro escrito el 2026-11-26 ANTES de evaluar ninguna
 * configuración; regla de decisión del README, pre-registro 2026-11-26).
 *
 * Antecedentes: el rasgo `teamHAH` dentro de context-full (diferencia de goles en casa − fuera, sin ajustar por rival,
 * aplicado a los λ de la fuente de goles, que pesa 0,05 con cuotas) no ganó nada. Las estadísticas ya separan por
 * condición (forHome/forAway contraídas hacia la tasa general del equipo con los mismos 40 partidos ficticios).
 * Aquí se prueba lo que NO se probó:
 *
 * (a) Hipótesis: hay equipos con ventaja local propia (rinden en casa más de lo que su fuerza y la ventaja local de la
 *     competición explican, o viajan peor), y ni el Elo (ventaja 65 global), ni el Dixon-Coles (una por liga), ni el
 *     ensamble la recogen. Estimación: residuo casa − fuera de la diferencia de goles frente a lo esperado por Elo y
 *     por la ventaja local de cada competición, con contracción empírico-bayesiana FUERTE (τ² por momentos,
 *     walk-forward en combine.prepare); se aplica como delta de la supremacía sobre el ensamble de producción
 *     (combine.blend), manteniendo el total. Detalle: homeaway/goals.ts.
 *     MÉTRICAS OBJETIVO (a): 1X2 RPS (`rps`) y goles por equipo Brier 0,5/1,5 (`teamGoals`).
 * (b) Hipótesis: la separación por condición de las estadísticas de producción tiene una fuerza mal calibrada; se
 *     cambia SOLO la contracción de la tasa por condición hacia la general (kV partidos ficticios; producción 40) con
 *     stats.adjust (multiplicador F_cond(kV)/F_cond(40) recalculado con la vista del pasado). Detalle: homeaway/stats.ts.
 *     MÉTRICAS OBJETIVO (b): córners (`corners`, `teamCorners`), tarjetas (`cards`, `teamCards`), tiros (`shots`) y
 *     tiros a puerta (`sot`), Brier medio de sus líneas.
 *
 * CONFIGURACIONES PLANEADAS (4, el máximo del factor; TODAS se evalúan y se informan):
 *   1. homeaway-goals         (a) a todos los partidos (con y sin cuotas)
 *   2. homeaway-goals-noodds  (a) solo partidos sin cuotas (con cuotas = producción: el mercado ya puede incorporarla)
 *   3. homeaway-stats-k15     (b) kV = 15 (separación por condición MÁS fuerte que producción)
 *   4. homeaway-stats-nosplit (b) kV = ∞  (SIN separación propia por condición: solo la tasa general del equipo)
 * Las configuraciones 3 y 4 acotan a producción (40) por los dos lados; no se evalúa ninguna configuración más.
 *
 * Comparación frente a `production` (variante vacía, producción actual), IC 95 % bootstrap por día (1.000 réplicas,
 * funciones del banco); también el informe del CLI frente a `baseline`. Ventanas: T1, T2, prev y pooled.
 * Regla aplicada (literal):
 *   1. Δ < 0 en TODAS las métricas objetivo de su parte, en T2 y en prev;
 *   2. el IC de alguna métrica objetivo excluye el 0 (por debajo) en T2, prev o pooled;
 *   3. nada significativamente peor (IC entero > 0) en T1 en sus objetivos, ni en ninguna otra métrica principal
 *      (MAIN_METRICS/PLAYER_METRICS) en T1, T2 o prev;
 *   4. fuga OK (CLI/banco) y prueba adversarial propia (tests/experiments/homeaway.test.ts: compMatches) OK.
 *   Si pasan las dos de una parte: (a) la de mejor Δ RPS en pooled; (b) la de mejor Δ `corners` en pooled.
 * Muestra declarada antes de evaluar: para la configuración 2, T1 cuenta como «sin muestra» (14 partidos sin cuotas,
 * n < 30) y se juzga en T2 (33) y prev (~2.300 sin cuotas). Para 1, 3 y 4 ninguna ventana se declara sin muestra.
 * τ² no existe hasta que hay MIN_EST estimaciones en las filas del pasado (primeros días de enero de 2026 = producción).
 *
 * RESULTADO (2026-11-26, datos 4649537288eee65d, frente a `production`, IC 95 % bootstrap por día; fuga OK en T1, T2
 * y prev con máx. dif. 0; prueba adversarial propia OK). 4 configuraciones evaluadas, NINGUNA SE ADOPTA:
 *  (a) τ² empírico-bayesiano = 0 en TODOS los reajustes desde febrero de 2026 (media de v̂² 0,053–0,073 frente a una
 *      varianza de muestreo media 0,055–0,074: la dispersión de la ventaja local propia entre equipos no se distingue
 *      del ruido); solo dos reajustes de finales de enero dan τ² ≈ 0,001. Por eso homeaway-goals y homeaway-goals-noodds
 *      son IDÉNTICAS a producción en T1 y T2 (Δ = 0 exacto) y casi en prev: RPS +0,0000000 [−0,0000141; +0,0000164],
 *      goles eq. −0,0000002 [−0,0000079; +0,0000083]; más/menos +0,0000004 [+0,0000001; +0,0000008] (IC > 0,
 *      irrelevante). Falla los criterios 1 y 2 (sin mejora en T2). Resultado nulo: no hay señal explotable.
 *  (b) producción (kV = 40) queda ENTRE las dos alternativas y las dos empeoran:
 *      homeaway-stats-k15: T2 córners +0,00055, córners eq. −0,00061 [−0,00163; +0,00037], tarjetas +0,00067,
 *        tarjetas eq. +0,00033, tiros +0,00007, a puerta +0,00102; prev córners +0,00075*, tarjetas +0,00162*,
 *        tarjetas eq. +0,00103*, a puerta +0,00101* (IC > 0). Secundario (no objetivo): props de jugador mejores en T2
 *        (≥ 1 a puerta −0,00024*, ≥ 2 tiros −0,00026*, tarjeta −0,00009*).
 *      homeaway-stats-nosplit: T2 córners eq. +0,00158*, tiros +0,00096; prev córners eq. +0,00170*, tiros +0,00135*;
 *        props de jugador peores en T1/T2.
 *   npx tsx scripts/eval-model.ts --variant=homeaway-goals,homeaway-goals-noodds,homeaway-stats-k15,homeaway-stats-nosplit --window=T2
 */
// Esta configuración (1 de 4): ventaja local propia por equipo (EB), delta de la supremacía en todos los partidos.
import { makeHomeAwayGoalsVariant } from './homeaway/make';

export default makeHomeAwayGoalsVariant(
  'homeaway-goals',
  'Ventaja local propia por equipo (residuo casa − fuera frente a Elo y ventaja de la competición, contracción EB) → delta de la supremacía sobre el ensamble, todos los partidos',
  { apply: 'all' },
);
