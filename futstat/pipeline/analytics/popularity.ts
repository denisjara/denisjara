/**
 * Puntuación de popularidad de un partido (0..100) para la sección "Partidos populares".
 *
 *   35 % prestigio de la competición        tier/10
 *   35 % calidad media de los equipos       Elo medio entre P90−350 (0) y P90 (1)
 *   15 % equilibrio                         1 − |p(local) − p(visitante)|
 *   15 % bonus de equipo top                Elo máximo entre P90−100 (0) y P90+50 (1)
 *   − penalización por lejanía: 0.1 puntos por hora más allá de 72 h (máx. 10 puntos)
 *
 * P90 = percentil 90 del Elo global (todos los equipos con rating).
 */
import { clamp, quantile, round } from '../../src/lib/models';

export interface PopularityInput {
  compTier: number;
  eloHome: number;
  eloAway: number;
  /** percentil 90 del Elo global */
  eloP90: number;
  pHome: number;
  pAway: number;
  hoursToKickoff: number;
}

export const POPULARITY_WEIGHTS = { prestige: 0.35, quality: 0.35, balance: 0.15, topTeam: 0.15 } as const;

/** Percentil del Elo global (por defecto P90). */
export function eloPercentile(ratings: number[], q = 0.9): number {
  const xs = ratings.filter((x) => Number.isFinite(x));
  return xs.length ? quantile(xs, q) : 1500;
}

export function popularityScore(i: PopularityInput): number {
  const p90 = Number.isFinite(i.eloP90) ? i.eloP90 : 1500;
  const eh = Number.isFinite(i.eloHome) ? i.eloHome : p90 - 300;
  const ea = Number.isFinite(i.eloAway) ? i.eloAway : p90 - 300;
  const prestige = clamp((Number.isFinite(i.compTier) ? i.compTier : 5) / 10, 0, 1);
  const quality = clamp(((eh + ea) / 2 - (p90 - 350)) / 350, 0, 1);
  const ph = Number.isFinite(i.pHome) ? i.pHome : 0.4;
  const pa = Number.isFinite(i.pAway) ? i.pAway : 0.3;
  const balance = clamp(1 - Math.abs(ph - pa), 0, 1);
  const topTeam = clamp((Math.max(eh, ea) - (p90 - 100)) / 150, 0, 1);
  const w = POPULARITY_WEIGHTS;
  let score = 100 * (w.prestige * prestige + w.quality * quality + w.balance * balance + w.topTeam * topTeam);
  const h = i.hoursToKickoff;
  if (Number.isFinite(h) && h > 72) score -= Math.min(10, (h - 72) * 0.1);
  return round(clamp(score, 0, 100), 1);
}
