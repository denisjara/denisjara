/**
 * Utilidades puras de los pronósticos de alta confianza (sin JSX ni DOM: se prueban en Node).
 */
import type { ConfidencePick, MatchSummary } from '../../types/data';

/** Mínimo de picks fuera de muestra para considerar validada una familia (igual que el pipeline). */
export const OOS_MIN_N = 20;

/** Estado de la validación fuera de muestra de la familia de un pick. */
export function outOfSample(p: Pick<ConfidencePick, 'holdoutHitRate' | 'holdoutN'>): 'ok' | 'bajo' | 'sin-validar' {
  if (p.holdoutHitRate === undefined || p.holdoutN === undefined || p.holdoutN < OOS_MIN_N) return 'sin-validar';
  return p.holdoutHitRate >= 0.8 ? 'ok' : 'bajo';
}

/** Agrupa una lista (ya ordenada) de { match, pick } por partido consecutivo. */
export function groupByMatch<T extends { match: MatchSummary; pick: ConfidencePick }>(items: T[]): { match: MatchSummary; picks: ConfidencePick[]; items: T[] }[] {
  const out: { match: MatchSummary; picks: ConfidencePick[]; items: T[] }[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.match.id === it.match.id) {
      last.picks.push(it.pick);
      last.items.push(it);
    } else out.push({ match: it.match, picks: [it.pick], items: [it] });
  }
  return out;
}
