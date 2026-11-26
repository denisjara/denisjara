/**
 * Variante «factors-combo» (agente de combinación de FACTORES, 2026-11-26): los tres factores que pasaron la regla
 * pre-registrada (README, pre-registro 2026-11-26) y dos revisiones adversariales, JUNTOS. Cabecera escrita ANTES de
 * evaluar ninguna combinación.
 *
 * COMPONENTES (cada uno exactamente como su variante recomendada, sin reajustar nada):
 *   1. ÁRBITRO (referee-fouls-k30): `stats.adjust` = multiplicador walk-forward del árbitro designado en tarjetas
 *      (k = 30) y faltas (k = 30), igual para los dos equipos (referee/model.ts).
 *   2. DISPONIBILIDAD (availability-props): `players.adjust` → `minutesFactor` (sancionados ×0,03; habitual que faltó
 *      los 2 últimos ×0,65; que faltó el último de la misma competición ×0,9) (availability/model.ts). Sin la parte de
 *      equipo (λ / tiros), que no pasó.
 *   3. FORMA DE JUGADORES (playerform-fac6x40): `players.adjust` → `oppShotsFactor`, `oppSotFactor`, `cardsFactor`
 *      escalados por proyección(6/40) / proyección(40/40) (playerform/model.ts).
 *
 * CÓMO SE COMPONEN (ninguna variante usa combine, totals, lambdaAdjust ni features: no hay conflicto ahí):
 *   - `stats.adjust`: solo lo usa el árbitro. Se compone multiplicativamente por estadística (función `mulPairs`) por
 *     si en el futuro se añade otro factor de estadísticas; hoy equivale a la del árbitro.
 *   - `players.adjust`: disponibilidad toca solo `minutesFactor`; forma de jugadores toca solo los factores del rival.
 *     Las claves son disjuntas, así que se mezclan las dos salidas, cada una calculada sobre el mismo `base`.
 *   - Interacción buscada: `base.cardsFactor` ya incluye el multiplicador del árbitro (propsFor divide la proyección
 *     CON stats.adjust por la media del equipo) y forma de jugadores lo multiplica por su cociente 6/40 ÷ 40/40, que se
 *     calcula sin árbitro: árbitro × contracción, multiplicativo.
 *
 * HIPÓTESIS: los tres factores actúan en canales casi independientes (medias de tarjetas/faltas del partido; minutos
 * esperados; factores del rival de las props), así que la combinación conserva la ganancia de cada uno y no empeora
 * ninguna métrica principal.
 *
 * MÉTRICAS OBJETIVO (Δ frente a `production`, IC 95 % bootstrap por día), la unión de las de cada componente:
 *   - árbitro: `cards`, `teamCards`, `fouls` (y segmento «árbitro conocido»);
 *   - disponibilidad y forma de jugadores: props `pScorer`, `pSot1`, `pShots2`, `pCard`.
 *   Verificación: en T1, T2, prev y pooled la combinación debe (a) dar Δ de cada componente del mismo signo y tamaño
 *   parecido al de su variante sola (en las métricas que solo toca un componente debe ser casi idéntico); (b) no ser
 *   significativamente peor (IC entero > 0) en ninguna métrica principal (MAIN_METRICS/PLAYER_METRICS). Muestra: los
 *   factores de jugadores no tienen muestra en `prev` (líneas desde el 2026-05-07, declarado en su pre-registro); el
 *   árbitro casi no tiene muestra en el holdout (ESPN no da árbitro desde ~2026-09-20).
 *
 * CONFIGURACIONES PLANEADAS (máx. 4; se cuentan todas):
 *   1. factors-combo (los tres componentes). Es la única que se evalúa si pasa la verificación.
 *   2-4. Solo si un componente empeora en combinación: la combinación SIN ese componente (una por componente que
 *        falle), y se informa. No se reajusta ningún parámetro de los componentes.
 *
 * HOLDOUT: tras la verificación, UNA sola mirada (la SEGUNDA en total) con `--final` sobre esta variante. Condición
 * pre-registrada: se adopta en producción solo si sus métricas objetivo NO empeoran en el holdout (estimación puntual),
 * por componente. Sin ajustes posteriores con el holdout.
 */
import type { PlayerPropsInput } from '../analytics/players';
import availability from './availability-props';
import playerform from './playerform-fac6x40';
import referee from './referee-fouls-k30';
import type { ModelVariant, PlayerAdjustInput, StatAdjustInput, StatPairs } from './types';

/** Producto por estadística y equipo de varios juegos de multiplicadores (ausente = 1). */
function mulPairs(parts: readonly StatPairs[]): StatPairs {
  const out: StatPairs = {};
  for (const p of parts) {
    for (const [k, v] of Object.entries(p) as [keyof StatPairs, { home: number; away: number } | undefined][]) {
      if (!v) continue;
      const cur = out[k];
      out[k] = cur ? { home: cur.home * v.home, away: cur.away * v.away } : { home: v.home, away: v.away };
    }
  }
  return out;
}

const statAdjusters = [referee.stats?.adjust].filter((f): f is NonNullable<typeof f> => !!f);
const playerAdjusters = [availability.players?.adjust, playerform.players?.adjust].filter((f): f is NonNullable<typeof f> => !!f);

const v: ModelVariant = {
  name: 'factors-combo',
  description:
    'Factores adoptados juntos: árbitro (tarjetas y faltas, k = 30) + disponibilidad en las props (sancionados y habituales ausentes) + factores del rival de las props con contracción 6/40',
  stats: {
    adjust(input: StatAdjustInput): StatPairs {
      return mulPairs(statAdjusters.map((f) => f(input)));
    },
  },
  players: {
    adjust(input: PlayerAdjustInput): Partial<PlayerPropsInput> {
      // claves disjuntas (minutesFactor | factores del rival); cada componente ve el mismo base de producción
      const out: Partial<PlayerPropsInput> = {};
      for (const f of playerAdjusters) Object.assign(out, f(input));
      return out;
    },
  },
};

export default v;
