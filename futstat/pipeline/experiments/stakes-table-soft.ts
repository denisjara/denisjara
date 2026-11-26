/**
 * FACTOR: NECESIDAD DE MARCAR / QUÉ SE JUEGA (pre-registro escrito el 2026-11-26 ANTES de evaluar ninguna
 * configuración; piezas en stakes/legs.ts, stakes/table.ts y stakes/make.ts).
 *
 * Sub-factores e hipótesis (direcciones declaradas; efectos FIJOS por razonamiento previo, no estimados con datos):
 *  (a) VUELTA DE ELIMINATORIA («· Vuelta»; ida buscada en history.compMatches, misma temporada, ronda «· Ida», mismos
 *      equipos). Global del local de la vuelta: empate / pierde por 1 / pierde por 2+.
 *      - pierde por 1: más goles (×1,04); el que pierde más tiros, a puerta y córners (×1,08); el que gana menos (×0,95)
 *        y más tarjetas (×1,05) y faltas (×1,03).
 *      - pierde por 2+: más goles (×1,06); el que pierde tiros/córners ×1,10; el que gana ×0,92; tarjetas ×0,97.
 *      - empatada: menos goles (×0,96); tarjetas ×1,05 los dos.
 *      El 1X2 no se toca (totals.adjustTotal lo mantiene). Goles solo SIN línea de goles del mercado.
 *  (b) RECTA FINAL DE LIGA (>= 75 % de la fase regular jugada; ligas de doble vuelta sin fases partidas). Tabla a la
 *      fecha con computeStandingsFromMatches; un equipo «no se juega nada» si ninguna zona de
 *      comp.simulationZones puede cambiar para él (rango de posición final con ritmos lo/hi de puntos por partido:
 *      'strict' 0/3 = matemático; 'soft' 0,75/2,25 = realista).
 *      - nada en juego contra quien se juega algo: 1X2 desplazado hacia el motivado (δ = 0,12 en log-probabilidad de
 *        las victorias), SOLO sin cuotas 1X2 (con cuotas el mercado, 80 % del ensamble, ya lo descuenta);
 *      - los dos sin nada en juego: total de goles ×1,06 (más abierto), SOLO sin línea de goles del mercado;
 *      - el equipo sin nada en juego: tarjetas ×0,92 y faltas ×0,95 (menos intensidad).
 *
 * MÉTRICAS OBJETIVO (Δ frente a `production`, IC 95 % bootstrap por día), medidas EN EL SEGMENTO del sub-factor:
 *  (a) segmento «vuelta de eliminatoria»: `ouBrier` (más/menos 2,5), `teamGoals` (goles por equipo 0,5/1,5) y `cards`
 *      (tarjetas total). Secundarias (se informan, no deciden): shots, sot, corners, teamCorners, teamCards, fouls.
 *  (b) segmento «liga: último 25 %»: `rps` (1X2), `ouBrier`, `teamGoals` y `cards`. Secundarias: teamCards, fouls,
 *      logLoss y el subconjunto sin cuotas.
 *  Condición 1 de la regla = Δ < 0 en TODAS las métricas objetivo del sub-factor en las ventanas con muestra.
 *
 * CONFIGURACIONES PLANEADAS (4, el máximo del factor; todas se cuentan y se informan, también las descartadas):
 *   1. stakes-legs        solo (a)
 *   2. stakes-table       solo (b), definición 'strict'
 *   3. stakes-table-soft  solo (b), definición 'soft'
 *   4. stakes-all         (a) + (b) 'strict' (la variante del factor completo)
 *
 * VENTANAS: T1, T2, prev y pooled. Declarado ANTES de evaluar (regla 5 del pre-registro): el segmento «vuelta» tiene
 * n < 30 en T1 (~8) y en T2 (~18) y el segmento «liga: último 25 %» tiene n ≈ 2 en tuning ⇒ T1 y T2 cuentan como
 * «SIN MUESTRA» para las métricas objetivo de los dos sub-factores; se juzgan en `prev` (vueltas ~83; recta final
 * ~1.026) y `pooled`. En T1 y T2 solo se comprueba la condición 3 (nada significativamente peor en ninguna métrica
 * principal de la ventana completa) y la fuga. Las vueltas (n ~83-109) son muestra pequeña: el IC lo dirá.
 *
 * REGLA DE RECOMENDACIÓN (declarada antes): una configuración pasa si cumple, para cada sub-factor que contiene,
 *   1) Δ < 0 en todas sus métricas objetivo en prev (T2 sin muestra),
 *   2) el IC de alguna métrica objetivo excluye el 0 en prev o pooled,
 *   3) ninguna métrica principal (MAIN_METRICS/PLAYER_METRICS, ventana completa) con IC entero > 0 en T1, T2 o prev,
 *   4) fuga OK.
 *   Se recomienda stakes-all si pasa; si no, la de un solo sub-factor que pase (si pasan stakes-table y
 *   stakes-table-soft, la de mejor Δ `rps` del segmento en pooled); si ninguna pasa, ninguna.
 */
// Esta configuración: Necesidad de marcar (b): recta final de liga, nada en juego realista 0,75/2,25 pts por partido (1X2 sin cuotas, goles sin línea, tarjetas y faltas)
import { makeStakesVariant } from './stakes/make';

export default makeStakesVariant('stakes-table-soft', 'Necesidad de marcar (b): recta final de liga, nada en juego realista 0,75/2,25 pts por partido (1X2 sin cuotas, goles sin línea, tarjetas y faltas)', { legs: false, table: 'soft' });
