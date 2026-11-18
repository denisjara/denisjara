/**
 * Utilidades puras de los pronósticos de alta confianza (sin JSX ni DOM: se prueban en Node).
 */
import type { ConfidencePick, MatchSummary } from '../../types/data';

/** Muestra mínima para publicar un acierto propio (por debajo: «muestra pequeña»). Igual que el pipeline. */
export const OOS_MIN_N = 50;
/** Acierto mínimo fuera de muestra de una regla publicada (validación walk-forward). */
export const OOS_MIN_RATE = 0.8;

/** z del intervalo de Wilson al 90 % (bilateral), el mismo que el pipeline. */
const Z90 = 1.6449;

/** Intervalo de Wilson al 90 % de hits/n. n = 0 ⇒ [0, 1]. */
export function wilson90(hits: number, n: number): [number, number] {
  if (!(n > 0)) return [0, 1];
  const p = hits / n;
  const z2 = Z90 * Z90;
  const den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den;
  const half = (Z90 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** ¿Se puede publicar un acierto propio con esta muestra? */
export const ownRate = (n: number | undefined): boolean => (n ?? 0) >= OOS_MIN_N;

/**
 * Estado de la validación fuera de muestra de la regla de un pick (walk-forward mensual):
 *  - 'ok': >= 50 picks y >= 80 % (se muestra su acierto con n e intervalo);
 *  - 'pequena': menos de 50 picks («muestra pequeña», sin acierto propio);
 *  - 'bajo': >= 50 picks y < 80 % (no debería publicarse; se avisa);
 *  - 'sin-validar': sin datos de validación (ficheros antiguos).
 */
export type OutOfSampleState = 'ok' | 'pequena' | 'bajo' | 'sin-validar';

export function outOfSample(p: Pick<ConfidencePick, 'validationHitRate' | 'validationN'>): OutOfSampleState {
  if (p.validationHitRate === undefined || p.validationN === undefined || !(p.validationN > 0)) return 'sin-validar';
  if (!ownRate(p.validationN)) return 'pequena';
  return p.validationHitRate >= OOS_MIN_RATE ? 'ok' : 'bajo';
}

/**
 * El partido se decidió en la prórroga o en los penaltis (estado normalizado del pipeline o tanda registrada). Sus
 * pronósticos se resuelven con el marcador a los 90 minutos, no con el final que muestra `score`.
 */
export function beyond90(m: Pick<MatchSummary, 'statusDetail' | 'score'>): 'prórroga' | 'penaltis' | undefined {
  const sd = (m.statusDetail ?? '').toLowerCase();
  if (sd.includes('penaltis') || typeof m.score?.penHome === 'number' || typeof m.score?.penAway === 'number') return 'penaltis';
  if (sd.includes('prórroga') || sd.includes('prorroga')) return 'prórroga';
  return undefined;
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
