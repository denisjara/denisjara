/**
 * Variante «form-goals-noodds» (configuración 2 de 4 del factor FORMA DEL EQUIPO): igual que «form-goals» pero solo
 * en partidos SIN cuotas (entrena y aplica el modelo sin cuotas); con cuotas = producción (el mercado de cierre ya
 * puede incorporar la forma).
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
 *   T1  (215, 14 sin cuotas): RPS +0,00039 [−0,00001; +0,00080] · más/menos +0,00021 · goles eq. +0,00048
 *               [−0,00001; +0,00095] · goleador (props) +0,00005 [+0,00000005; +0,00009]* (peor por un margen ínfimo)
 *   T2  (1.142, 33 sin cuotas): RPS −0,00015 [−0,00040; +0,00009] · más/menos +0,00003 [−0,00021; +0,00028] ·
 *               goles eq. −0,00007   → falla el criterio 1 (más/menos peor en T2) y el 3 (goleador peor en T1)
 *   prev (2.636, 2.344 sin cuotas): RPS −0,00050 [−0,00115; +0,00017] · más/menos −0,00012 · goles eq. −0,00053
 *               [−0,00090; −0,00015]*  · pooled: goles eq. −0,00035*, deviance −0,0026*
 *   Auxiliar `pre` (815 sin cuotas): RPS −0,00096, ambos marcan −0,00084*, deviance −0,0056*.
 *
 *   npx tsx scripts/eval-model.ts --variant=form-goals-noodds --window=T2
 */
import { makeFormGoalsVariant } from './form/make';

export default makeFormGoalsVariant(
  'form-goals-noodds',
  'Forma reciente → λ finales por regresión de Poisson walk-forward, solo en partidos sin cuotas',
  { apply: 'noOdds', kappa: 50 },
);
