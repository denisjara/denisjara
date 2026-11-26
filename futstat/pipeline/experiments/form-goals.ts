/**
 * Variante «form-goals» (configuración 1 de 4 del factor FORMA DEL EQUIPO): rasgos de forma de goles
 * (form/features.ts: residuos de goles y de xG por tiros frente a lo esperado, a favor del equipo y en contra del
 * rival) → multiplicadores de los λ FINALES por regresión de Poisson walk-forward (form/combiner.ts; reajuste cada
 * 7 días, κ = 50, multiplicador en [0,8; 1,25]), con un modelo para partidos con cuotas y otro sin cuotas.
 *
 * PRE-REGISTRO (escrito el 2026-11-26 ANTES de evaluar ninguna configuración; regla de decisión del README):
 *  - Factor: FORMA DEL EQUIPO (momento reciente). Nunca probado antes como entrada.
 *  - Hipótesis (a): el sobre/infra-rendimiento reciente frente a lo esperado antes de cada partido (residuo de goles
 *    y residuo de xG aproximado por tiros, últimos 6 partidos en 75 días) tiene señal a corto plazo que no recogen
 *    el Elo, el Dixon-Coles ni el mercado. Se aplica sobre los λ FINALES con coeficientes estimados walk-forward
 *    (regresión de Poisson penalizada en el combinador, modelos separados con/sin cuotas).
 *    MÉTRICAS OBJETIVO (a): 1X2 RPS, más/menos 2,5 Brier, goles por equipo Brier (0,5/1,5); también en el segmento
 *    sin cuotas.
 *  - Hipótesis (b): la forma estadística reciente (últimos 5 partidos en 60 días: córners, tiros, tiros a puerta,
 *    faltas frente a la tasa de largo plazo del propio equipo, normalizada por localía) mejora las proyecciones,
 *    con cocientes muy contraídos (peso n/(n + K)), vía `stats.adjust`. Las tarjetas NO se tocan (dependen sobre
 *    todo del árbitro, otro factor).
 *    MÉTRICAS OBJETIVO (b): Brier de córners, tiros, tiros a puerta y faltas (total) y córners por equipo.
 *  - Configuraciones planificadas (máx. 4 en total para el factor; TODAS se evalúan y se informan):
 *      1. form-goals         (a), aplicada a todos los partidos (modelo con cuotas y modelo sin cuotas), κ = 50
 *      2. form-goals-noodds  (a), solo partidos sin cuotas (con cuotas = producción), κ = 50
 *      3. form-stats         (b), K = 10 (con 5 partidos, peso 1/3), multiplicador recortado a [0,8; 1,25]
 *      4. form-stats-k30     (b), K = 30 (con 5 partidos, peso 1/7), mismo recorte
 *  - Ventanas: T1, T2 y prev (y pooled para el criterio 2). Comparación frente a `production` (variante vacía),
 *    además del informe del CLI frente a `baseline`. Sin muestra mínima declarada: T1 tiene 14 partidos sin cuotas
 *    (n < 30 → «sin muestra» para el segmento sin cuotas en T1, declarado aquí antes de evaluar); T2 33 (bajo).
 *
 * RESULTADO (2026-11-26, frente a `production`, IC 95 % bootstrap por día; fuga OK en T1/T2/prev): NO SE ADOPTA.
 *   T1  (215):  RPS +0,00091 [−0,00034; +0,00233] · más/menos −0,00121 [−0,00365; +0,00080] · goles eq. −0,00021
 *   T2  (1.142): RPS +0,00011 [−0,00060; +0,00078] · más/menos −0,00076 [−0,00211; +0,00045] · goles eq. −0,00057
 *               [−0,00123; +0,00005]   → falla el criterio 1 (RPS peor en T2, estimación puntual)
 *   prev (2.636): RPS −0,00041 [−0,00108; +0,00027] · más/menos −0,00012 · goles eq. −0,00051 [−0,00088; −0,00013]*
 *   pooled: goles eq. −0,00051*, ambos marcan −0,00045*, deviance −0,0036*. Ninguna otra métrica principal es
 *   significativamente peor en T1/T2/prev. Coeficientes (sin cuotas, ~3.400 partidos): gfRes −0,06 · gaRes rival
 *   −0,06 · xgfRes +0,23 · xgaRes rival +0,30 (t ≈ 5–6: la forma por TIROS predice y la de goles revierte); con cuotas
 *   ≈ 0 (el mercado ya la incorpora). La señal está en los partidos sin cuotas (casi todo `prev`).
 *
 *   npx tsx scripts/eval-model.ts --variant=form-goals --window=T2
 */
import { makeFormGoalsVariant } from './form/make';

export default makeFormGoalsVariant(
  'form-goals',
  'Forma reciente (residuos de goles y xG por tiros, últimos 6 partidos) → λ finales por regresión de Poisson walk-forward (con y sin cuotas)',
  { apply: 'all', kappa: 50 },
);
