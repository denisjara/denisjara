/**
 * Vistas del pasado para los ganchos de las variantes (HistoryView): solo partidos terminados con inicio
 * estrictamente anterior al corte. Las listas por equipo/competición se preparan una vez (perezosamente) y cada vista
 * las corta por búsqueda binaria.
 */
import type { Elo } from '../../src/lib/models';
import type { MatchRecord } from '../types';
import type { HistoryView } from './types';

/** Fuente de datos de las vistas (listas cronológicas de cualquier estado; se filtran aquí). */
export interface HistorySource {
  matchesByTeam: ReadonlyMap<string, readonly MatchRecord[]>;
  matchesByComp: ReadonlyMap<string, readonly MatchRecord[]>;
  elo: Elo;
  /** cachés internas (perezosas) */
  _team?: Map<string, { t: Float64Array; ms: MatchRecord[] }>;
  _comp?: Map<string, { t: Float64Array; ms: MatchRecord[] }>;
  _elo?: Map<string, { t: Float64Array; r: Float64Array }>;
}

function finished(m: MatchRecord): boolean {
  return (
    m.status === 'finished' &&
    !!m.score &&
    Number.isFinite(m.score.home) &&
    Number.isFinite(m.score.away) &&
    Number.isFinite(Date.parse(m.date))
  );
}

function indexed(list: readonly MatchRecord[] | undefined): { t: Float64Array; ms: MatchRecord[] } {
  const ms = (list ?? []).filter(finished).sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { t: Float64Array.from(ms.map((m) => Date.parse(m.date))), ms };
}

/** Número de elementos de `t` (creciente) estrictamente menores que `x`. */
function lowerBound(t: Float64Array, x: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Vista del pasado con corte `cutoff` (ms). */
export function historyView(src: HistorySource, cutoff: number): HistoryView {
  const team = (src._team ??= new Map());
  const comp = (src._comp ??= new Map());
  const elo = (src._elo ??= new Map());
  const cut = (cache: Map<string, { t: Float64Array; ms: MatchRecord[] }>, key: string, list: readonly MatchRecord[] | undefined) => {
    let e = cache.get(key);
    if (!e) {
      e = indexed(list);
      cache.set(key, e);
    }
    return e.ms.slice(0, lowerBound(e.t, cutoff));
  };
  return {
    cutoff,
    cutoffIso: new Date(cutoff).toISOString(),
    teamMatches: (id) => cut(team, id, src.matchesByTeam.get(id)),
    compMatches: (id) => cut(comp, id, src.matchesByComp.get(id)),
    eloBefore: (id) => {
      let e = elo.get(id);
      if (!e) {
        const h = src.elo.history(id);
        e = { t: Float64Array.from(h.map((x) => Date.parse(x.date))), r: Float64Array.from(h.map((x) => x.elo)) };
        elo.set(id, e);
      }
      const n = lowerBound(e.t, cutoff);
      return n > 0 ? e.r[n - 1] : undefined;
    },
  };
}
