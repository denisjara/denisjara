/**
 * Rasgos pre-partido de las variantes «stack*» (combinador aprendido). Solo usan el propio partido SIN resultado
 * (`PreMatch`: las cuotas de cierre sí son pre-partido) y la vista del pasado `before` (partidos terminados con inicio
 * anterior). Sin estado entre llamadas.
 */
import type { FeatureContext, Features, HistoryView, PreMatch } from '../types';

const okOdds = (x: number | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 1;

/** Margen de la casa (sobre-redondeo − 1) de las cuotas 1X2 del partido; 0 si no hay un trío válido. */
export function marginOf(m: PreMatch): number {
  const o = m.odds;
  if (!o || !okOdds(o.home) || !okOdds(o.draw) || !okOdds(o.away)) return 0;
  const r = 1 / o.home + 1 / o.draw + 1 / o.away - 1;
  return Number.isFinite(r) && r > -0.05 && r < 0.4 ? r : 0;
}

/**
 * Rasgos:
 *  - mg: margen de la casa (0 sin cuotas);
 *  - rounds: jornadas medias jugadas en la competición esta temporada (2·partidos / equipos) antes del partido;
 *  - seasonMin: partidos de la temporada actual (todas las competiciones) del equipo con menos partidos.
 */
export function stackFeatures(_ctx: FeatureContext, match: PreMatch, before: HistoryView): Features {
  const comp = before.compMatches(match.compId).filter((m) => m.currentSeason);
  const teams = new Set<string>();
  for (const m of comp) {
    teams.add(m.home.id);
    teams.add(m.away.id);
  }
  const rounds = teams.size ? (2 * comp.length) / teams.size : 0;
  const seasonGames = (id: string) => before.teamMatches(id).filter((m) => m.currentSeason).length;
  return {
    mg: marginOf(match),
    rounds,
    seasonMin: Math.min(seasonGames(match.home.id), seasonGames(match.away.id)),
  };
}
