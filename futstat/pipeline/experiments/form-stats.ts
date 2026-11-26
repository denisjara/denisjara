/**
 * Variante «form-stats» (configuración 3 de 4 del factor FORMA DEL EQUIPO): `stats.adjust` con la forma estadística
 * reciente (form/features.ts statForm): para córners, tiros, tiros a puerta y faltas, media de cada equipo × forma a
 * favor propia × forma en contra del rival; forma = 1 + n/(n + K)·(cociente reciente/largo plazo − 1), K = 10.
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
 *   T1: córners +0,00554 · córners eq. +0,00643* · faltas −0,00667 · tiros −0,00271 · a puerta −0,00292
 *   T2: córners +0,00122 · córners eq. −0,00001 · faltas −0,00100 · tiros −0,00468* · a puerta +0,00134
 *   prev: córners +0,00457* · córners eq. +0,00621* · faltas +0,00129 · tiros +0,00202 · a puerta +0,00435*
 *   → falla 1 y 3 (córners y a puerta significativamente peores). Props ≥ 1 a puerta / ≥ 2 tiros mejoran (T2*).
 *
 *   npx tsx scripts/eval-model.ts --variant=form-stats --window=T2
 */
import { makeFormStatsVariant } from './form/make';

export default makeFormStatsVariant(
  'form-stats',
  'Forma estadística reciente (5 partidos / 365 días, por localía) en córners, tiros, a puerta y faltas; contracción K = 10',
  { K: 10, maxMult: 1.25 },
);
