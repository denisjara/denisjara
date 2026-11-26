/**
 * Factor ÁRBITRO (variantes referee-*.ts): multiplicador walk-forward de la severidad del árbitro designado.
 *
 * Integrado en PRODUCCIÓN el 26-nov-2026 con la configuración de referee-fouls-k30 (MODEL.referee: tarjetas k = 30,
 * faltas k = 30): el código vive en pipeline/analytics/referee.ts y aquí solo se reexporta para las variantes y los
 * tests (detalle del método en la cabecera de ese módulo). Las variantes referee-k15/k30/k60 siguen pasando sus
 * propias k.
 */
export {
  expectedFor,
  MIN_COMP_N,
  MIN_COMP_N_ALL,
  observed,
  refereeMultipliers,
  refereeRatio,
  type RefereeMemo,
  type RefereeOptions,
  type RefereeRatio,
  type RefStat,
} from '../../analytics/referee';
