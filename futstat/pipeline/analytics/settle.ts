/**
 * Resolución de partidos terminados a 90 minutos (como liquidan las casas): goles, córners y tarjetas.
 * Compartido por los pronósticos de alta confianza (analytics/confidence.ts) y el banco de pruebas (experiments).
 */
import type { MatchRecord } from '../types';
import { isFinished } from './teamStats';

export interface SettleData {
  /** goles a los 90 minutos (en partidos con prórroga, reconstruidos con los eventos de gol hasta el minuto 90) */
  hg: number;
  ag: number;
  /** córners totales (si ambos equipos tienen el dato; nunca en partidos con prórroga o penaltis) */
  corners?: number;
  /** amarillas + rojas totales (si ambos equipos tienen el dato; nunca en partidos con prórroga o penaltis) */
  cards?: number;
  /** el partido tuvo prórroga o penaltis: goles a 90' desde los eventos; córners y tarjetas excluidos */
  extraTime?: boolean;
}

/** El partido se decidió en la prórroga o en los penaltis (estado normalizado de ESPN o tanda registrada). */
export function wentBeyond90(m: Pick<MatchRecord, 'statusDetail' | 'score'>): boolean {
  const sd = (m.statusDetail ?? '').toLowerCase();
  if (sd.includes('prórroga') || sd.includes('prorroga') || sd.includes('penaltis')) return true;
  return typeof m.score?.penHome === 'number' || typeof m.score?.penAway === 'number';
}

const GOAL_EVENTS = new Set(['goal', 'penalty', 'own-goal']);

/**
 * Marcador a los 90 minutos desde los eventos de gol (el minuto de un gol en el añadido, "90'+3'", es 90). Solo si los
 * eventos de TODO el partido cuadran con el marcador final por equipo (si no, undefined: el partido no se resuelve).
 */
export function score90FromEvents(m: Pick<MatchRecord, 'events' | 'score' | 'home' | 'away'>): { hg: number; ag: number } | undefined {
  if (!m.score || !Array.isArray(m.events)) return undefined;
  let h = 0;
  let a = 0;
  let h90 = 0;
  let a90 = 0;
  for (const e of m.events) {
    if (!e || !GOAL_EVENTS.has(e.type) || !Number.isFinite(e.minute)) continue;
    const home = e.teamId === m.home.id;
    if (!home && e.teamId !== m.away.id) return undefined;
    if (home) h++;
    else a++;
    if (e.minute <= 90) {
      if (home) h90++;
      else a90++;
    }
  }
  if (h !== m.score.home || a !== m.score.away) return undefined;
  return { hg: h90, ag: a90 };
}

/**
 * Datos para resolver las selecciones de un partido terminado (undefined si no tiene marcador o no se puede resolver).
 *  - Prórroga o penaltis: las casas liquidan a 90 minutos ⇒ goles y resultado con los eventos de gol hasta el minuto 90
 *    (si los eventos no cuadran con el marcador, el partido se excluye); córners y tarjetas se excluyen siempre (la
 *    fuente los da con la prórroga incluida y no se pueden separar).
 *  - Tarjetas: un total de 0 cuenta como dato ausente (no como «0 tarjetas»): sin ningún evento de tarjeta de ESPN no se
 *    distingue de un partido sin estadísticas, y con eventos de tarjeta sería una contradicción.
 */
export function settleDataOf(m: MatchRecord): SettleData | undefined {
  if (!isFinished(m)) return undefined;
  const et = wentBeyond90(m);
  let goals = { hg: m.score.home, ag: m.score.away };
  if (et) {
    const g90 = score90FromEvents(m);
    if (!g90) return undefined;
    goals = g90;
  }
  const out: SettleData = { ...goals };
  if (et) {
    out.extraTime = true;
    return out;
  }
  const h = m.stats?.home;
  const a = m.stats?.away;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined);
  if (h && a) {
    const ch = n(h.corners);
    const ca = n(a.corners);
    if (ch !== undefined && ca !== undefined) out.corners = ch + ca;
    const yh = n(h.yellow);
    const ya = n(a.yellow);
    if (yh !== undefined && ya !== undefined) {
      const cards = yh + ya + (n(h.red) ?? 0) + (n(a.red) ?? 0);
      // 0 tarjetas: sin eventos de tarjeta es un dato ausente; con eventos de tarjeta, una contradicción (también ausente)
      if (cards > 0) out.cards = cards;
    }
  }
  return out;
}

