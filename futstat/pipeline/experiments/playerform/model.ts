/**
 * Factor FORMA DE JUGADORES (props): piezas de las variantes playerform-*.ts. Pre-registro en la cabecera de
 * playerform-hl60.ts.
 *
 *  - `formMultipliers`: multiplicador de «forma» por jugador con sus 5 últimas apariciones (hipótesis b). La tasa
 *    reciente de xG aproximado por 90 (0,09·tiros + 0,22·a puerta) se contrae hacia la de toda la ventana con K
 *    partidos (de 90') ficticios; multiplicador = reciente contraída / larga, recortado. Con todas las líneas dentro de
 *    las 5 últimas el multiplicador es exactamente 1.
 *  - `scaleLines`: aplica los multiplicadores a goles, tiros y tiros a puerta de las líneas (copias nuevas; minutos,
 *    tarjetas y faltas intactos). Como buildPlayerProps suma las líneas, equivale a multiplicar las tasas por 90 del
 *    jugador antes de su contracción hacia el prior de su posición. Los minutos esperados no cambian.
 *  - `factorRatios`: cociente entre la proyección del equipo con otra contracción de las tasas de equipo (priorN para
 *    el «a favor» del propio equipo y para el «en contra» del rival) y la de producción (40/40), por estadística. Se
 *    multiplica por el factor del rival de producción de las props (proyección / media del equipo), así que solo
 *    cambia la contracción: las proyecciones de equipo publicadas (córners, tarjetas, tiros…) NO se tocan.
 *
 * Todo con el pasado del partido: `base.lines` (ya cortadas por propsFor) y la HistoryView. Sin estado global.
 *
 * `factorRatios` (y `statPool`, `sideMean`) están en PRODUCCIÓN desde el 26-nov-2026 (pipeline/analytics/
 * playerFactors.ts, MODEL.propsOppShrink); aquí se reexportan. La forma (b) y la vida media (a) no pasaron.
 */
import { clamp } from '../../../src/lib/models';
import type { PlayerLine } from '../../types';

// ---------------------------------------------------------------------------
// (b) forma de las 5 últimas apariciones
// ---------------------------------------------------------------------------

export interface FormOptions {
  /** apariciones recientes */
  last: number;
  /** partidos (de 90') ficticios de la contracción de la tasa reciente hacia la larga */
  k: number;
  /** recorte del multiplicador */
  lo: number;
  hi: number;
}

export const FORM_DEFAULTS: FormOptions = { last: 5, k: 4, lo: 0.67, hi: 1.5 };

const xgOf = (l: PlayerLine) => 0.09 * l.shots + 0.22 * l.shotsOnTarget;

/** Multiplicador de forma por jugador (solo líneas del equipo `teamId` con minutos; 1 si no hay base). */
export function formMultipliers(lines: readonly PlayerLine[], teamId: string, o: FormOptions = FORM_DEFAULTS): Map<string, number> {
  const byPlayer = new Map<string, PlayerLine[]>();
  const seen = new Set<string>();
  for (const l of lines) {
    if (l.teamId !== teamId || !(l.minutes > 0)) continue;
    const key = `${l.playerId}|${l.matchId}`;
    if (seen.has(key)) continue; // línea duplicada (buildPlayerProps se queda con la primera)
    seen.add(key);
    let xs = byPlayer.get(l.playerId);
    if (!xs) byPlayer.set(l.playerId, (xs = []));
    xs.push(l);
  }
  const out = new Map<string, number>();
  for (const [id, xs] of byPlayer) {
    xs.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.matchId.localeCompare(b.matchId));
    let xgAll = 0;
    let minAll = 0;
    for (const l of xs) {
      xgAll += xgOf(l);
      minAll += l.minutes;
    }
    const rLong = minAll > 0 ? (xgAll * 90) / minAll : 0;
    if (!(rLong > 0)) {
      out.set(id, 1);
      continue;
    }
    let xg5 = 0;
    let min5 = 0;
    for (const l of xs.slice(-o.last)) {
      xg5 += xgOf(l);
      min5 += l.minutes;
    }
    // tasa reciente por 90 contraída hacia la larga: (xG5 + K·rLong) / (min5/90 + K)
    const recent = (xg5 + o.k * rLong) / (min5 / 90 + o.k);
    const m = clamp(recent / rLong, o.lo, o.hi);
    out.set(id, Number.isFinite(m) ? m : 1);
  }
  return out;
}

/** Copias de las líneas con goles, tiros y tiros a puerta multiplicados por el multiplicador de su jugador. */
export function scaleLines(lines: readonly PlayerLine[], teamId: string, mult: ReadonlyMap<string, number>): PlayerLine[] {
  return lines.map((l) => {
    const m = l.teamId === teamId ? mult.get(l.playerId) : undefined;
    if (m === undefined || m === 1) return l;
    return { ...l, goals: l.goals * m, shots: l.shots * m, shotsOnTarget: l.shotsOnTarget * m };
  });
}

// ---------------------------------------------------------------------------
// factores del rival con otra contracción de las tasas de equipo
// ---------------------------------------------------------------------------

// Integrados en producción el 26-nov-2026 con la configuración de playerform-fac6x40 (MODEL.propsOppShrink 6/40): el
// código vive en pipeline/analytics/playerFactors.ts y aquí solo se reexporta para las variantes y los tests.
export { FACTOR_KEYS, factorRatios, scaledFactor, sideMean, statPool } from '../../analytics/playerFactors';
