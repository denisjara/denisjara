/**
 * Ventaja local del Elo POR GRUPO de competiciones (región × tipo), aplicada solo en la conversión diferencia Elo →
 * probabilidades 1X2 (los ratings se siguen actualizando con la ventaja global de producción, MODEL.eloHomeAdv).
 *
 * Motivo (agente «tune», 22-nov-2026): la ventaja local global de 65 puntos es un compromiso. Con el Elo solo en los
 * partidos anteriores al ajuste (2025-01 → 2026-05, 9.659 partidos) el óptimo es ~50 en las ligas europeas, ~25 en las
 * copas europeas (equipos de categorías inferiores en casa), ~70-80 en ligas y competiciones continentales americanas
 * y ~80 en las continentales europeas. Los valores se eligieron SOLO con esos datos (anteriores a la ventana de ajuste)
 * y son constantes: no hay ajuste walk-forward ni fuga posible.
 *
 * Funciones puras: sin estado, sin lectura de datos.
 */
import type { CompetitionKind, Prob1X2 } from '../../../src/types/data';

/** Competiciones americanas (ligas, continentales y copa de la configuración). */
export const AMERICAS = new Set(['brasileirao', 'argentina', 'ligamx', 'mls', 'chile', 'libertadores', 'sudamericana', 'copachile']);

export type HaGroup = 'AM-league' | 'AM-continental' | 'AM-cup' | 'EU-league' | 'EU-continental' | 'EU-cup';

export function haGroup(compId: string, kind: CompetitionKind): HaGroup {
  return `${AMERICAS.has(compId) ? 'AM' : 'EU'}-${kind}` as HaGroup;
}

/** Ventaja local de producción con la que se calcularon la diferencia y las probabilidades del Elo. */
export const PRODUCTION_HOME_ADV = 65;

/** Escala de la campana de empates del Elo (fitEloDrawParams da 360-400 en estos datos). */
const DRAW_SCALE = 380;

/**
 * Probabilidades del Elo con la diferencia desplazada `delta` puntos, a partir de las de producción (`p`, calculadas
 * con la diferencia `diff`): We se recalcula exactamente; P(empate) = drawBase·exp(−(d/s)²) se reescala con
 * exp(−(d'² − d²)/s²) con s = 380 (exacto si la escala ajustada es 380; con escalas de 360–400 y |delta| <= 40 el
 * error máximo medido es 0,003 con |diff| <= 400). Mismo recorte que eloProbs (>= 0,01).
 */
export function shiftEloProbs(p: Prob1X2, diff: number, delta: number): Prob1X2 {
  if (!delta || !Number.isFinite(diff)) return p;
  const d2 = diff + delta;
  const we = 1 / (1 + Math.pow(10, -d2 / 400));
  const pDraw = p.draw * Math.exp(-(d2 * d2 - diff * diff) / (DRAW_SCALE * DRAW_SCALE));
  let h = we - pDraw / 2;
  let a = 1 - h - pDraw;
  let d = pDraw;
  if (h < 0.01) h = 0.01;
  if (a < 0.01) a = 0.01;
  if (d < 0.01) d = 0.01;
  const s = h + d + a;
  return { home: h / s, draw: d / s, away: a / s };
}

/** Desplazamiento (puntos Elo) de un partido según la tabla de ventajas por grupo (0 en campo neutral). */
export function haDelta(table: Partial<Record<HaGroup, number>>, compId: string, kind: CompetitionKind, neutral: boolean): number {
  if (neutral) return 0;
  const ha = table[haGroup(compId, kind)];
  return ha === undefined ? 0 : ha - PRODUCTION_HOME_ADV;
}
