/**
 * Variante «playerform-hl60» (configuración 1 de 4 del factor FORMA DE JUGADORES): tasas por 90 de cada jugador
 * ponderadas por recencia con vida media de 60 días (gancho del núcleo players.rateHalfLifeDays).
 *
 * PRE-REGISTRO (escrito el 2026-11-26 ANTES de evaluar ninguna configuración; regla de decisión del README):
 *  - Factor: FORMA DE JUGADORES en las props (goleador, >= 1 tiro a puerta, >= 2 tiros, tarjeta). Producción: tasas
 *    por 90 sin ponderar en la ventana de 365 días (en la práctica desde el 2026-05-07, primeras líneas de jugador),
 *    contraídas hacia el prior de la posición; minutos esperados = EWMA de los 5 últimos partidos del equipo; factores
 *    del rival = proyección del equipo (córners/tarjetas/tiros, priorN 40) / media del equipo en el periodo de las
 *    líneas.
 *  - Hallazgo de partida: con priorN 6 → 40 (22-nov-2026) las proyecciones de equipo mejoraron pero las props de
 *    tiros y tarjetas empeoraron (tuning: >= 1 a puerta +0,0006, >= 2 tiros +0,0005, tarjeta +0,0003 de Brier, IC > 0).
 *    Las props de tiros/a puerta/tarjeta solo dependen de tasas, minutos y factores del rival, así que la diferencia
 *    entera viene de los factores. Explicación propuesta: las tasas por 90 del jugador ya llevan el nivel PROPIO de su
 *    equipo (son sus tiros con ese equipo) y solo se contraen débilmente hacia la posición; el factor
 *    proyección/media con priorN 40 contrae además el nivel propio del equipo hacia la media de la liga (doble
 *    contracción: a los jugadores de equipos que tiran mucho se les quitan tiros).
 *  - Hipótesis:
 *      (a) tasas por 90 ponderadas por recencia (vida media 60 días) mejoran las props (roles y posiciones cambian);
 *      (b) un multiplicador de forma de las 5 últimas apariciones (xG aproximado por 90 reciente contraído hacia el de
 *          la ventana con K = 4 partidos de 90', recortado a [0,67; 1,5]) aplicado a goles, tiros y tiros a puerta
 *          mejora las props de goleador, a puerta y tiros;
 *      (c) factores del rival de las props con contracción débil del nivel propio arreglan la regresión sin tocar las
 *          proyecciones de equipo publicadas (gancho players.adjust: factor de producción × proyección alternativa /
 *          proyección de producción del MISMO contexto reconstruido con la HistoryView).
 *  - MÉTRICAS OBJETIVO (Brier; log-loss como secundaria): (a) goleador, >= 1 a puerta, >= 2 tiros y tarjeta;
 *    (b) goleador, >= 1 a puerta y >= 2 tiros; (c) >= 1 a puerta, >= 2 tiros y tarjeta.
 *  - Configuraciones planificadas (máx. 4 en total para el factor; TODAS se evalúan y se informan):
 *      1. playerform-hl60     (a) rateHalfLifeDays = 60
 *      2. playerform-last5    (b) forma de 5 apariciones, K = 4, recorte [0,67; 1,5]
 *      3. playerform-fac6     (c) factores con priorN 6 en el «a favor» propio y 6 en el «en contra» del rival
 *                                 (= contracción anterior a 40, solo para las props)
 *      4. playerform-fac6x40  (c) 6 en el «a favor» propio y 40 (producción) en el «en contra» del rival
 *  - Ventanas: T1, T2, prev (y pooled para el criterio 2), frente a `production` (variante vacía; pares por día
 *    emparejados) y, además, el informe del CLI frente a `baseline`. `prev` se declara AQUÍ «sin muestra» para este
 *    factor (como dice el pre-registro del README: las líneas de jugador empiezan el 2026-05-07 y `prev` acaba el
 *    05-31, así que sus props tienen como mucho 3 semanas de historial y (a)/(b) apenas pueden cambiar nada): se
 *    informa, pero la decisión es con T2 (criterio 1), T2 o pooled (criterio 2) y T1 (criterio 3).
 *  - Mejora = Δ Brier < 0 (estimación puntual) en TODAS las métricas objetivo de la configuración en T2.
 *
 * RESULTADO (2026-11-26, añadido DESPUÉS de evaluar; 4 configuraciones evaluadas, ninguna descartada sin informar;
 * Δ Brier frente a `production`, IC 95 % bootstrap por día, * = el IC excluye el 0; fuga OK en todas, días 07-26,
 * 09-12 y 01-17; ninguna otra métrica principal cambia: solo las props):
 *   1. hl60: NO SE ADOPTA. T2 >= 2 tiros +0,00073* (log-loss +0,00237*): peor. T1 goleador −0,00034, a puerta
 *      −0,00066*, tarjeta −0,00059*; T2 goleador −0,00004, a puerta −0,00015, tarjeta −0,00005.
 *   2. last5: NO SE ADOPTA. T1 >= 2 tiros +0,00051* (peor); T2 goleador +0,00004, a puerta +0,00002, tiros +0,00019
 *      (todo peor en estimación puntual); prev sin cambios (sin historial de 5 apariciones).
 *   3. fac6: PASA. T2 a puerta −0,00055*, tiros −0,00063*, tarjeta −0,00017*; prev −0,00008, −0,00013, −0,00006*;
 *      T1 +0,00005, +0,00015, −0,00031 (sin IC por encima de 0); pooled todo *.
 *   4. fac6x40: PASA y es la RECOMENDADA. T2 a puerta −0,00061*, tiros −0,00059*, tarjeta −0,00019*; prev −0,00011,
 *      −0,00024, −0,00012*; T1 +0,00007, −0,00030, −0,00017 (ninguna peor de forma significativa); pooled −0,00048*,
 *      −0,00052*, −0,00018*. Frente a `baseline` deja a puerta y tiros como antes del cambio a 40 (T2 +0,00002,
 *      +0,00001) y la tarjeta casi (+0,00010): la regresión de las props venía entera de la doble contracción del
 *      nivel propio del equipo en el factor del rival.
 */
import { makePlayerFormVariant } from './playerform/make';

export default makePlayerFormVariant('playerform-hl60', 'Forma de jugadores (a): tasas por 90 de las props ponderadas por recencia, vida media 60 días', {
  rateHalfLifeDays: 60,
});
