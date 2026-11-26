/**
 * FACTOR: RENDIMIENTO LOCAL / VISITANTE POR EQUIPO — configuración 3 de 4 (pre-registro completo, hipótesis, regla y
 * lista de configuraciones en la cabecera de homeaway-goals.ts, escrito el 2026-11-26 ANTES de evaluar).
 * Hipótesis (b): la tasa por condición (casa/fuera) de córners, tarjetas, tiros y tiros a puerta de cada equipo se
 * contrae demasiado hacia su tasa general en producción (40 partidos ficticios); con kV = 15 la separación es más
 * fuerte. stats.adjust con multiplicador F_cond(15)/F_cond(40) (homeaway/stats.ts).
 * MÉTRICAS OBJETIVO: `corners`, `teamCorners`, `cards`, `teamCards`, `shots`, `sot` (Brier medio de sus líneas).
 *
 * RESULTADO (2026-11-26, frente a production; fuga OK): NO SE ADOPTA. T2 córners +0,00055, tarjetas +0,00067,
 * a puerta +0,00102 (solo córners eq. −0,00061, IC cruza 0); prev córners +0,00075*, tarjetas +0,00162*, tarjetas eq.
 * +0,00103*, a puerta +0,00101* (IC > 0). Props de jugador mejores en T2 (no objetivo). Detalle en homeaway-goals.ts.
 */
import { makeHomeAwayStatsVariant } from './homeaway/make';

export default makeHomeAwayStatsVariant(
  'homeaway-stats-k15',
  'Estadísticas: separación casa/fuera de cada equipo más fuerte (tasa por condición contraída hacia la general con 15 partidos ficticios en vez de 40)',
  { kVenue: 15 },
);
