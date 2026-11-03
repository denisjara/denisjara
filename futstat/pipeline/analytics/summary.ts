/**
 * Conversión de un MatchRecord interno a la ficha compacta publicada (MatchSummary).
 * Los campos opcionales desconocidos se omiten (nunca null), según el contrato de src/types/data.ts.
 */
import type { MatchStatus, MatchSummary, Score } from '../../src/types/data';
import type { MatchRecord } from '../types';

/** Texto de estado por defecto (español) cuando la fuente no da uno. */
export const STATUS_LABEL: Record<MatchStatus, string> = {
  scheduled: 'Programado',
  live: 'En juego',
  finished: 'Final',
  postponed: 'Aplazado',
  cancelled: 'Cancelado',
};

/** Copia del marcador sin campos undefined (para JSON limpio). */
export function toScore(s: MatchRecord['score']): Score | undefined {
  if (!s || !Number.isFinite(s.home) || !Number.isFinite(s.away)) return undefined;
  const out: Score = { home: s.home, away: s.away };
  if (s.htHome !== undefined && s.htAway !== undefined) {
    out.htHome = s.htHome;
    out.htAway = s.htAway;
  }
  if (s.penHome !== undefined && s.penAway !== undefined) {
    out.penHome = s.penHome;
    out.penAway = s.penAway;
  }
  return out;
}

/**
 * MatchRecord → MatchSummary. `hasDetail` es false por defecto (el build lo pone a true cuando escribe
 * public/data/matches/<id>.json). `extra` se aplica al final (prediction, popularity, predictionHit, hasDetail...).
 */
export function toMatchSummary(m: MatchRecord, compName: string, extra?: Partial<MatchSummary>): MatchSummary {
  const out: MatchSummary = {
    id: m.id,
    compId: m.compId,
    compName,
    date: m.date,
    status: m.status,
    home: m.home,
    away: m.away,
    hasDetail: false,
  };
  const detail = m.statusDetail ?? (m.status !== 'scheduled' ? STATUS_LABEL[m.status] : undefined);
  if (detail) out.statusDetail = detail;
  if (m.round) out.round = m.round;
  const score = m.status === 'scheduled' ? undefined : toScore(m.score);
  if (score) out.score = score;
  if (m.venue) out.venue = m.venue;
  if (m.homeForm) out.homeForm = m.homeForm;
  if (m.awayForm) out.awayForm = m.awayForm;
  if (m.odds) out.odds = m.odds;
  if (extra) {
    for (const [k, v] of Object.entries(extra) as [keyof MatchSummary, unknown][]) {
      if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}
