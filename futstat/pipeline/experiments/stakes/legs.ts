/**
 * Factor NECESIDAD DE MARCAR (a): estado de la eliminatoria a doble partido en la VUELTA.
 *
 * En un partido cuya ronda contiene «· Vuelta» se busca la ida en `history.compMatches(match.compId)` (solo partidos
 * terminados con inicio ANTERIOR al de la vuelta): misma temporada, misma ronda con «· Ida» en lugar de «· Vuelta» y
 * los mismos dos equipos (normalmente cruzados). El marcador guardado de la ida es el final (las idas no tienen
 * prórroga). Sin ida encontrada ⇒ sin efecto (producción).
 *
 * Global del equipo LOCAL de la vuelta: agg = sus goles en la ida − los del rival.
 *   agg = 0 → «level»; |agg| = 1 → «trail1»; |agg| >= 2 → «trail2» (va perdiendo el local si agg < 0).
 * No hay regla del gol de visitante en las competiciones del data-store en 2025-26 (UEFA la abolió en 2021; Libertadores
 * en 2022). En la liguilla de la Liga MX el empate global favorece al mejor clasificado: se trata igual (aproximación
 * declarada).
 *
 * Efectos FIJOS declarados antes de evaluar (razonamiento previo, no estimados con estos datos): ver LEG_EFFECTS.
 */
import type { MatchRecord } from '../../types';
import type { HistoryView, PreMatch, StatPairs } from '../types';

export type TieKind = 'level' | 'trail1' | 'trail2';

export interface TieState {
  kind: TieKind;
  /** equipo que va perdiendo la eliminatoria (ausente si va empatada) */
  trailing?: 'home' | 'away';
  /** goles del local de la vuelta menos los del visitante, en la ida */
  agg: number;
  /** id de la ida encontrada */
  firstLegId: string;
}

const VUELTA_RE = /·\s*Vuelta\b/;

/** ¿Es la vuelta de una eliminatoria a doble partido? */
export function isSecondLeg(round: string | undefined): boolean {
  return VUELTA_RE.test(round ?? '');
}

/** Ronda de la ida correspondiente a una ronda de vuelta («Semifinales · Vuelta» → «Semifinales · Ida»). */
export function firstLegRound(round: string): string {
  return round.replace(VUELTA_RE, '· Ida');
}

/** La ida de una vuelta (o undefined): último partido terminado anterior de la misma temporada, ronda y pareja. */
export function findFirstLeg(match: Pick<PreMatch, 'round' | 'compId' | 'season' | 'home' | 'away'>, history: HistoryView): MatchRecord | undefined {
  if (!isSecondLeg(match.round)) return undefined;
  const r1 = firstLegRound(match.round!);
  const h = match.home.id;
  const a = match.away.id;
  const ms = history.compMatches(match.compId);
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    if (m.season !== match.season || (m.round ?? '') !== r1 || !m.score) continue;
    const pair = (m.home.id === a && m.away.id === h) || (m.home.id === h && m.away.id === a);
    if (pair) return m;
  }
  return undefined;
}

/** Estado de la eliminatoria antes de la vuelta (undefined si no es vuelta o no se encuentra la ida). */
export function tieState(match: Pick<PreMatch, 'round' | 'compId' | 'season' | 'home' | 'away'>, history: HistoryView): TieState | undefined {
  const fl = findFirstLeg(match, history);
  if (!fl || !fl.score) return undefined;
  const swapped = fl.home.id === match.away.id;
  const agg = swapped ? fl.score.away - fl.score.home : fl.score.home - fl.score.away;
  if (!Number.isFinite(agg)) return undefined;
  if (agg === 0) return { kind: 'level', agg, firstLegId: fl.id };
  return { kind: Math.abs(agg) === 1 ? 'trail1' : 'trail2', trailing: agg < 0 ? 'home' : 'away', agg, firstLegId: fl.id };
}

/** Efecto fijo de un estado: factor del total de goles y multiplicadores por equipo (que pierde / que gana o ambos). */
export interface LegEffect {
  /** factor del total de goles (solo sin línea de goles del mercado) */
  goals: number;
  /** multiplicadores del equipo que va perdiendo (en «level», de los dos) */
  trailing: Partial<Record<'corners' | 'cards' | 'fouls' | 'shots' | 'shotsOnTarget', number>>;
  /** multiplicadores del equipo que va ganando (ignorado en «level») */
  leading: Partial<Record<'corners' | 'cards' | 'fouls' | 'shots' | 'shotsOnTarget', number>>;
}

/**
 * Efectos FIJOS (pre-registrados el 2026-11-26, antes de evaluar). Razonamiento: efectos de marcador («score effects»)
 * bien documentados en partido: quien va perdiendo acumula tiros y córners y quien gana los cede; quien defiende una
 * ventaja corta pierde tiempo y comete más faltas/tarjetas; con la eliminatoria empatada ningún equipo arriesga.
 *   - trail1: goles ×1,04; perdedor tiros/a puerta/córners ×1,08; ganador tiros/a puerta/córners ×0,95, tarjetas ×1,05,
 *     faltas ×1,03.
 *   - trail2: goles ×1,06 (el que pierde se abre y concede contras); perdedor tiros/a puerta/córners ×1,10; ganador
 *     ×0,92; tarjetas ×0,97 los dos (eliminatoria casi decidida, menos tensión).
 *   - level: goles ×0,96; tarjetas ×1,05 los dos; tiros y córners sin cambio.
 */
export const LEG_EFFECTS: Record<TieKind, LegEffect> = {
  trail1: {
    goals: 1.04,
    trailing: { shots: 1.08, shotsOnTarget: 1.08, corners: 1.08 },
    leading: { shots: 0.95, shotsOnTarget: 0.95, corners: 0.95, cards: 1.05, fouls: 1.03 },
  },
  trail2: {
    goals: 1.06,
    trailing: { shots: 1.1, shotsOnTarget: 1.1, corners: 1.1, cards: 0.97 },
    leading: { shots: 0.92, shotsOnTarget: 0.92, corners: 0.92, cards: 0.97 },
  },
  level: {
    goals: 0.96,
    trailing: { cards: 1.05 },
    leading: {},
  },
};

/** Factor del total de goles por el estado de la eliminatoria (1 sin estado). */
export function legGoalsFactor(state: TieState | undefined): number {
  return state ? LEG_EFFECTS[state.kind].goals : 1;
}

/** Multiplicadores de stats.adjust por el estado de la eliminatoria (solo de las estadísticas presentes en `base`). */
export function legStatMultipliers(state: TieState | undefined, base: StatPairs): StatPairs {
  const out: StatPairs = {};
  if (!state) return out;
  const e = LEG_EFFECTS[state.kind];
  const keys = ['corners', 'cards', 'fouls', 'shots', 'shotsOnTarget'] as const;
  for (const k of keys) {
    if (!base[k]) continue;
    let home: number;
    let away: number;
    if (state.kind === 'level') {
      home = away = e.trailing[k] ?? 1;
    } else {
      const tr = e.trailing[k] ?? 1;
      const ld = e.leading[k] ?? 1;
      home = state.trailing === 'home' ? tr : ld;
      away = state.trailing === 'home' ? ld : tr;
    }
    if (home !== 1 || away !== 1) out[k] = { home, away };
  }
  return out;
}
