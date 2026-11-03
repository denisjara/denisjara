/**
 * Apuestas de valor: selecciones con cuota de la casa cuyo valor esperado según el modelo supera el umbral.
 *   EV = p·cuota − 1 (o el EV asiático ya calculado en la selección, con devoluciones/medias apuestas)
 *   Filtros: EV >= MODEL.minEv, p >= MODEL.minProb, cuota <= MODEL.maxOdds (y EV <= MAX_EV para descartar cuotas erróneas)
 *   Stake: Kelly fraccional (MODEL.kellyFraction, tope MODEL.kellyCap)
 */
import type { Market, ValuePick } from '../../src/types/data';
import { fairOdds, kelly, round } from '../../src/lib/models';
import { MODEL } from '../config';

/**
 * EV máximo creíble: por encima casi siempre es información que el modelo no tiene (lesiones, alineaciones) o una
 * cuota mal capturada. En el backtest real los picks con EV > 20% perdían ~28% frente a cuotas de cierre.
 */
export const MAX_EV = 0.2;
/** Máximo de picks por partido. */
export const MAX_PICKS_PER_MATCH = 3;

const LABEL_WEIGHT: Record<ValuePick['confidence'], number> = { alta: 1, media: 0.8, baja: 0.6 };

/** Etiqueta de confianza de un pick: 'alta' si EV >= 0.10 y confianza >= 0.6; 'media' si EV >= 0.06; si no 'baja'. */
export function pickConfidence(ev: number, confidence: number): ValuePick['confidence'] {
  if (ev >= 0.1 && confidence >= 0.6) return 'alta';
  if (ev >= 0.06) return 'media';
  return 'baja';
}

/** Puntuación de ordenación de un pick (EV ponderado por la confianza); útil también para rankings globales. */
export function pickScore(pick: Pick<ValuePick, 'ev' | 'confidence'>, confidence = 1): number {
  return pick.ev * LABEL_WEIGHT[pick.confidence] * (0.5 + 0.5 * Math.min(1, Math.max(0, confidence)));
}

/**
 * Busca apuestas de valor entre las selecciones con `marketOdds`.
 * Devuelve como mucho MAX_PICKS_PER_MATCH picks (uno por mercado), ordenados por EV·confianza.
 */
export function findValueBets(markets: Market[], confidence: number): ValuePick[] {
  const conf = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
  const bestByMarket = new Map<string, ValuePick>();
  for (const mk of markets) {
    for (const s of mk.selections) {
      const odds = s.marketOdds;
      if (typeof odds !== 'number' || !Number.isFinite(odds) || odds <= 1) continue;
      const p = s.prob;
      if (!Number.isFinite(p) || p <= 0 || p >= 1) continue;
      const ev = typeof s.ev === 'number' && Number.isFinite(s.ev) ? s.ev : p * odds - 1;
      if (ev < MODEL.minEv || ev > MAX_EV) continue;
      if (p < MODEL.minProb || odds > MODEL.maxOdds) continue;
      const label = pickConfidence(ev, conf);
      const pick: ValuePick = {
        marketId: mk.id,
        market: mk.name,
        selection: s.note && mk.id === '1x2' ? `${s.label} (${s.note})` : s.label,
        prob: round(p, 4),
        odds: round(odds, 3),
        fairOdds: round(fairOdds(p), 3),
        ev: round(ev, 4),
        kelly: round(kelly(p, odds, MODEL.kellyFraction, MODEL.kellyCap), 4),
        edge: round(p - 1 / odds, 4),
        confidence: label,
      };
      const prev = bestByMarket.get(mk.id);
      if (!prev || pickScore(pick) > pickScore(prev)) bestByMarket.set(mk.id, pick);
    }
  }
  return [...bestByMarket.values()]
    .sort((x, y) => pickScore(y, conf) - pickScore(x, conf) || y.ev - x.ev)
    .slice(0, MAX_PICKS_PER_MATCH);
}
