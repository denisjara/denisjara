/**
 * FACTOR: RENDIMIENTO LOCAL / VISITANTE POR EQUIPO — configuración 4 de 4 (pre-registro completo, hipótesis, regla y
 * lista de configuraciones en la cabecera de homeaway-goals.ts, escrito el 2026-11-26 ANTES de evaluar).
 * Hipótesis (b), lado contrario: la separación por condición propia de cada equipo es sobre todo ruido; sin ella
 * (kV = ∞: tasa general del equipo en las dos condiciones; la diferencia media casa/fuera de la competición se
 * mantiene) las proyecciones mejoran. stats.adjust con multiplicador A/F_cond(40) (homeaway/stats.ts).
 * MÉTRICAS OBJETIVO: `corners`, `teamCorners`, `cards`, `teamCards`, `shots`, `sot` (Brier medio de sus líneas).
 *
 * RESULTADO (2026-11-26, frente a production; fuga OK): NO SE ADOPTA. T2 córners eq. +0,00158*, tiros +0,00096;
 * prev córners eq. +0,00170*, tiros +0,00135* (IC > 0); props de jugador peores. Detalle en homeaway-goals.ts.
 */
import { makeHomeAwayStatsVariant } from './homeaway/make';

export default makeHomeAwayStatsVariant(
  'homeaway-stats-nosplit',
  'Estadísticas: sin separación casa/fuera propia de cada equipo (solo su tasa general; se mantiene la media de cada lado de la competición)',
  { kVenue: Infinity },
);
