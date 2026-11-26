/**
 * Factor LOCAL/VISITANTE, parte (b): FUERZA DE LA SEPARACIÓN POR CONDICIÓN en las proyecciones de estadísticas
 * (variantes homeaway-stats-*.ts).
 *
 * Producción (projections.ts, expectedPair): la tasa de un equipo en su condición se contrae hacia su tasa general
 * con los MISMOS partidos ficticios que la general hacia 1 (PRIOR_N = 40):
 *     A = shrink(r_todos, w_todos, 1, 40),   F_cond = shrink(r_cond, w_cond, A, 40)
 * (r = observado/esperado con la media de cada lado de la competición; w = suma de pesos con vida media 150 días).
 * Esa contracción de la condición no es un parámetro aparte (stats.priorN mueve las dos a la vez), así que aquí se
 * cambia SOLO la de la condición con `stats.adjust`: multiplicador = F_cond(kV) / F_cond(40), con
 *     F_cond(k) = shrink(r_cond, w_cond, A, k)   (k = ∞ ⇒ F = A: sin separación propia por condición).
 * r y w se recalculan aquí con la vista del pasado (aproximación declarada del contexto de producción: partidos del
 * equipo de los últimos 365 días en todas las competiciones, peso 0,5^(edad/150) con edad desde el corte; esperado =
 * media del lado en la competición de cada partido con sus partidos de los últimos 365 días, o la de la competición
 * del partido predicho si tiene < MIN_COMP partidos con dato, o los valores por defecto). Como el multiplicador es un
 * cociente de dos cálculos con los mismos r y w, la aproximación solo afecta a la intensidad del cambio.
 * Igual que producción, el campo neutral no se distingue (el local nominal usa su tasa de casa).
 *
 * Media del local = base · m_for(local, casa) · m_ag(visitante, fuera); visitante al revés. Multiplicador final
 * recortado a [1/MAX_MULT; MAX_MULT]. Estadísticas: córners, tarjetas, tiros y tiros a puerta (las métricas objetivo);
 * faltas y fueras de juego no se tocan.
 * Determinista, sin estado global: las medias de competición se memorizan solo dentro de una llamada.
 */
import { PRIOR_N, STAT_DEF_BY_KEY, type StatKey } from '../../analytics/projections';
import type { MatchRecord } from '../../types';
import type { HistoryView, PreMatch, StatPairs } from '../types';

const DAY_MS = 86_400_000;
export const TEAM_DAYS = 365;
export const COMP_DAYS = 365;
export const HALF_LIFE_DAYS = 150;
export const MIN_COMP = 30;
export const MAX_MULT = 1.25;

export const HOMEAWAY_STAT_KEYS: StatKey[] = ['corners', 'cards', 'shots', 'shotsOnTarget'];

export interface VenueOptions {
  /** partidos ficticios de la contracción de la tasa por condición hacia la general (Infinity = sin separación) */
  kVenue: number;
}

interface Acc {
  w: number;
  obs: number;
  exp: number;
}

const acc = (): Acc => ({ w: 0, obs: 0, exp: 0 });
const addTo = (a: Acc, w: number, o: number, e: number) => {
  a.w += w;
  a.obs += w * o;
  a.exp += w * e;
};

/** (x·n + p·k)/(n + k); k = ∞ ⇒ p */
function shrinkTo(x: number, n: number, p: number, k: number): number {
  if (!Number.isFinite(k)) return p;
  const d = n + k;
  return d > 0 ? (x * n + p * k) / d : p;
}

function ratioOf(a: Acc, prior: number, k: number): number {
  if (!(a.w > 0) || !(a.exp > 0)) return prior;
  return shrinkTo(a.obs / a.exp, a.w, prior, k);
}

type SideMeans = { h: number; a: number } | null;

/** Media de cada lado de la competición (últimos COMP_DAYS días, anteriores al corte); null con < MIN_COMP partidos. */
function compSideMeans(before: HistoryView, compId: string, key: StatKey, memo: Map<string, SideMeans>): SideMeans {
  const mk = `${key}|${compId}`;
  if (memo.has(mk)) return memo.get(mk)!;
  const def = STAT_DEF_BY_KEY.get(key)!;
  const ms = before.compMatches(compId);
  let h = 0;
  let a = 0;
  let n = 0;
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    if (before.cutoff - Date.parse(m.date) > COMP_DAYS * DAY_MS) break;
    if (!m.stats?.home || !m.stats?.away) continue;
    const x = def.read(m.stats.home);
    const y = def.read(m.stats.away);
    if (x === undefined || y === undefined) continue;
    h += x;
    a += y;
    n++;
  }
  const r = n >= MIN_COMP ? { h: h / n, a: a / n } : null;
  memo.set(mk, r);
  return r;
}

export interface VenueRatios {
  /** multiplicador de la tasa a favor en la condición pedida */
  forM: number;
  /** multiplicador de la tasa en contra en la condición pedida */
  agM: number;
}

/**
 * Multiplicadores F_cond(kV)/F_cond(PRIOR_N) de un equipo en una condición (`home` = jugando en casa) para una
 * estadística. 1 si no hay datos.
 */
export function venueRatios(
  before: HistoryView,
  teamId: string,
  home: boolean,
  key: StatKey,
  fallback: { h: number; a: number },
  opts: VenueOptions,
  memo: Map<string, SideMeans>,
): VenueRatios {
  const def = STAT_DEF_BY_KEY.get(key);
  if (!def) return { forM: 1, agM: 1 };
  const all = before.teamMatches(teamId);
  const fAll = acc();
  const fVen = acc();
  const aAll = acc();
  const aVen = acc();
  for (let i = all.length - 1; i >= 0; i--) {
    const m: MatchRecord = all[i];
    const age = (before.cutoff - Date.parse(m.date)) / DAY_MS;
    if (age > TEAM_DAYS) break;
    if (!m.stats?.home || !m.stats?.away) continue;
    const x = def.read(m.stats.home);
    const y = def.read(m.stats.away);
    if (x === undefined || y === undefined) continue;
    const L = compSideMeans(before, m.compId, key, memo) ?? fallback;
    const w = Math.pow(0.5, Math.max(0, age) / HALF_LIFE_DAYS);
    const isHome = m.home.id === teamId;
    // a favor / en contra con el esperado del lado correspondiente
    const fo = isHome ? x : y;
    const fe = isHome ? L.h : L.a;
    const ao = isHome ? y : x;
    const ae = isHome ? L.a : L.h;
    addTo(fAll, w, fo, fe);
    addTo(aAll, w, ao, ae);
    if (isHome === home) {
      addTo(fVen, w, fo, fe);
      addTo(aVen, w, ao, ae);
    }
  }
  const one = (all: Acc, ven: Acc) => {
    const A = ratioOf(all, 1, PRIOR_N);
    const prod = ratioOf(ven, A, PRIOR_N);
    const alt = ratioOf(ven, A, opts.kVenue);
    return prod > 0 && alt > 0 ? alt / prod : 1;
  };
  return { forM: one(fAll, fVen), agM: one(aAll, aVen) };
}

/** Multiplicadores de stats.adjust de la variante (solo las estadísticas de HOMEAWAY_STAT_KEYS presentes en `base`). */
export function venueMultipliers(match: PreMatch, history: HistoryView, base: StatPairs, opts: VenueOptions): StatPairs {
  const out: StatPairs = {};
  const memo = new Map<string, SideMeans>();
  for (const key of HOMEAWAY_STAT_KEYS) {
    if (!base[key]) continue;
    const def = STAT_DEF_BY_KEY.get(key)!;
    const fallback = compSideMeans(history, match.compId, key, memo) ?? { h: def.defaultHome, a: def.defaultAway };
    const h = venueRatios(history, match.home.id, true, key, fallback, opts, memo);
    const a = venueRatios(history, match.away.id, false, key, fallback, opts, memo);
    const lim = (x: number) => (Number.isFinite(x) && x > 0 ? Math.min(MAX_MULT, Math.max(1 / MAX_MULT, x)) : 1);
    const mh = lim(h.forM * a.agM);
    const ma = lim(a.forM * h.agM);
    if (mh !== 1 || ma !== 1) out[key] = { home: mh, away: ma };
  }
  return out;
}
