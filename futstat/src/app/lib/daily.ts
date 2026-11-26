/**
 * Utilidades puras de «Pronósticos del día» (daily.json): categorías, orden de prestigio de las competiciones,
 * filtros y selección del top. Sin JSX ni DOM: se prueban en Node (tests/app/daily.test.ts).
 */
import type { CompetitionMeta, DailyCategory, DailyDay, DailyFile, DailyMatch, DailyPick, MatchSummary } from '../../types/data';
import { OOS_MIN_N, OOS_MIN_RATE } from './confidence';

/** Categorías en el orden en que se muestran (el mismo del contrato). */
export const DAILY_CATEGORIES: readonly DailyCategory[] = ['resultado', 'goles', 'tiros', 'corners', 'tarjetas', 'faltas', 'jugadores'];

export const DAILY_CATEGORY_LABEL: Record<DailyCategory, string> = {
  resultado: 'Resultado',
  goles: 'Goles',
  tiros: 'Tiros',
  corners: 'Córners',
  tarjetas: 'Tarjetas',
  faltas: 'Faltas',
  jugadores: 'Jugadores',
};

export function isDailyCategory(x: unknown): x is DailyCategory {
  return typeof x === 'string' && (DAILY_CATEGORIES as readonly string[]).includes(x);
}

/**
 * Categoría de un pick sin `category` válida, deducida de su familia / mercado. Devuelve undefined si no se
 * reconoce (el pick se descarta: nunca se etiqueta a ciegas).
 */
export function inferDailyCategory(family: string, marketId = '', hasPlayer = false): DailyCategory | undefined {
  const f = `${family} ${marketId}`.toLowerCase();
  if (hasPlayer || /(^|[\s-])(player|jugador|prop)/.test(f)) return 'jugadores';
  if (/corner/.test(f)) return 'corners';
  if (/card|tarjeta/.test(f)) return 'tarjetas';
  if (/foul|falta/.test(f)) return 'faltas';
  if (/shot|sot|tiro/.test(f)) return 'tiros';
  if (/(^|\s)(dc|dnb|1x2|ah)([+\s-]|$)/.test(f)) return 'resultado';
  if (/(^|\s)(ou|btts|team)([\s-]|$)/.test(f)) return 'goles';
  return undefined;
}

/** Competiciones «de cartel»: si juegan ese día, la página las destaca arriba (Champions siempre la primera). */
const MARQUEE = ['champions', 'libertadores', 'europa', 'nations', 'sudamericana', 'conference'] as const;

/**
 * Puntuación de prestigio de una competición (mayor = antes): Champions primero, luego el resto de continentales de
 * cartel y después el `tier` de meta.json. Sin metadatos, 0 (se conserva el orden del archivo).
 */
export function competitionPrestige(compId: string, meta?: Pick<CompetitionMeta, 'tier' | 'kind'>): number {
  const i = (MARQUEE as readonly string[]).indexOf(compId);
  const tier = meta && Number.isFinite(meta.tier) ? meta.tier : 0;
  if (compId === 'champions') return 1000;
  if (i > 0) return 100 + tier * 10 - i;
  if (meta?.kind === 'continental') return 50 + tier * 10;
  return tier * 10 + (meta?.kind === 'league' ? 1 : 0);
}

export interface DailyCompGroup {
  compId: string;
  compName: string;
  meta?: CompetitionMeta;
  matches: DailyMatch[];
  /** picks de sus partidos */
  picks: number;
}

/** Partidos del día agrupados por competición, ordenadas por prestigio (Champions primero) y luego por hora. */
export function groupDailyByCompetition(matches: DailyMatch[], comps: CompetitionMeta[] | undefined): DailyCompGroup[] {
  const metaById = new Map((comps ?? []).map((c) => [c.id, c]));
  const groups = new Map<string, DailyMatch[]>();
  for (const m of matches) {
    const arr = groups.get(m.match.compId) ?? [];
    arr.push(m);
    groups.set(m.match.compId, arr);
  }
  const order = [...groups.keys()];
  return order
    .map((compId) => {
      const ms = [...groups.get(compId)!].sort((a, b) => a.match.date.localeCompare(b.match.date) || a.match.id.localeCompare(b.match.id));
      const meta = metaById.get(compId);
      return { compId, compName: meta?.name ?? ms[0]?.match.compName ?? compId, meta, matches: ms, picks: ms.reduce((s, x) => s + x.picks.length, 0) };
    })
    .sort((a, b) => competitionPrestige(b.compId, b.meta) - competitionPrestige(a.compId, a.meta) || order.indexOf(a.compId) - order.indexOf(b.compId));
}

/** ¿La competición merece el bloque destacado de la cabecera? (continental o liga/copa de primer nivel) */
export function isMarqueeCompetition(compId: string, meta?: Pick<CompetitionMeta, 'tier' | 'kind'>): boolean {
  return compId === 'champions' || (MARQUEE as readonly string[]).includes(compId) || meta?.kind === 'continental';
}

/** El partido ya ha empezado (o no está programado): sus pronósticos ya no se pueden jugar antes del inicio. */
export function hasStarted(m: Pick<MatchSummary, 'status' | 'date'>, now: number): boolean {
  if (m.status !== 'scheduled') return true;
  const t = Date.parse(m.date);
  return Number.isFinite(t) && t <= now;
}

/** Valor de orden de un pick: su `score` (0..100) y, si falta, la probabilidad recalibrada o la del modelo. */
export function pickRank(p: Pick<DailyPick, 'score' | 'calibratedProb' | 'prob'>): number {
  return typeof p.score === 'number' && Number.isFinite(p.score) ? p.score : (p.calibratedProb ?? p.prob) * 100;
}

export interface DailyFilters {
  /** id de competición o undefined (todas) */
  comp?: string;
  /** categoría o undefined (todas) */
  cat?: DailyCategory;
}

/** Partidos del día que pasan los filtros, cada uno solo con los picks de la categoría elegida. */
export function filterDailyMatches(matches: DailyMatch[], f: DailyFilters): DailyMatch[] {
  const out: DailyMatch[] = [];
  for (const m of matches) {
    if (f.comp && m.match.compId !== f.comp) continue;
    const picks = f.cat ? m.picks.filter((p) => p.category === f.cat) : m.picks;
    if (!picks.length) continue;
    out.push(picks.length === m.picks.length ? m : { ...m, picks });
  }
  return out;
}

export interface DailyTopItem {
  match: MatchSummary;
  pick: DailyPick;
}

/**
 * Top del día (máx. `max`, uno por partido). Sin filtros es el del pipeline (`day.top`, ya ordenado). Con filtros se
 * recalcula con el mismo criterio: el mejor pick de cada partido que pasa los filtros, ordenados por `score`.
 */
export function dailyTop(day: DailyDay, f: DailyFilters = {}, max = 10): DailyTopItem[] {
  const byId = new Map(day.matches.map((m) => [m.match.id, m.match]));
  if (!f.comp && !f.cat) {
    const out: DailyTopItem[] = [];
    for (const t of day.top) {
      const match = byId.get(t.matchId);
      if (match) out.push({ match, pick: t.pick });
    }
    if (out.length) return out.slice(0, max);
  }
  return filterDailyMatches(day.matches, f)
    .map((m) => ({ match: m.match, pick: [...m.picks].sort((a, b) => pickRank(b) - pickRank(a))[0] }))
    .sort((a, b) => pickRank(b.pick) - pickRank(a.pick) || a.match.date.localeCompare(b.match.date))
    .slice(0, max);
}

/** Los que aún no han empezado primero (conservando el orden); los ya empezados, al final. */
export function upcomingFirst<T extends { match: Pick<MatchSummary, 'status' | 'date'> }>(items: T[], now: number): T[] {
  return [...items.filter((x) => !hasStarted(x.match, now)), ...items.filter((x) => hasStarted(x.match, now))];
}

/** Picks de un partido agrupados por categoría, en el orden de `order` (categorías sin picks se omiten). */
export function picksByCategory(picks: DailyPick[], order: readonly DailyCategory[] = DAILY_CATEGORIES): { category: DailyCategory; picks: DailyPick[] }[] {
  const out: { category: DailyCategory; picks: DailyPick[] }[] = [];
  for (const category of order) {
    const ps = picks.filter((p) => p.category === category);
    if (ps.length) out.push({ category, picks: ps });
  }
  return out;
}

/** Categorías del archivo en su orden (lista blanca, sin repetir); si falta la lista, el orden por defecto. */
export function categoryOrder(file: Pick<DailyFile, 'categories'> | undefined): { id: DailyCategory; label: string }[] {
  const seen = new Set<DailyCategory>();
  const out: { id: DailyCategory; label: string }[] = [];
  for (const c of file?.categories ?? []) {
    if (!isDailyCategory(c.id) || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ id: c.id, label: c.label || DAILY_CATEGORY_LABEL[c.id] });
  }
  return out.length ? out : DAILY_CATEGORIES.map((id) => ({ id, label: DAILY_CATEGORY_LABEL[id] }));
}

/**
 * Récord FUERA DE MUESTRA que se enseña junto a un pick: la validación walk-forward de su regla y, si falta, el
 * holdout de su familia. `state` sigue la misma regla que alta confianza (n < 50 ⇒ «muestra pequeña», sin acierto).
 */
export interface PickRecord {
  rate: number;
  n: number;
  lo?: number;
  hi?: number;
  /** de dónde sale la cifra */
  kind: 'walk-forward' | 'holdout';
  state: 'ok' | 'pequena' | 'bajo';
}

export function pickRecord(p: Pick<DailyPick, 'validationHitRate' | 'validationN' | 'validationWilsonLow' | 'validationWilsonHigh' | 'holdoutHitRate' | 'holdoutN' | 'holdoutWilsonLow' | 'holdoutWilsonHigh'>): PickRecord | undefined {
  const make = (rate: number | undefined, n: number | undefined, lo: number | undefined, hi: number | undefined, kind: PickRecord['kind']): PickRecord | undefined =>
    rate !== undefined && n !== undefined && n > 0 ? { rate, n, lo, hi, kind, state: n < OOS_MIN_N ? 'pequena' : rate >= OOS_MIN_RATE ? 'ok' : 'bajo' } : undefined;
  return (
    make(p.validationHitRate, p.validationN, p.validationWilsonLow, p.validationWilsonHigh, 'walk-forward') ??
    make(p.holdoutHitRate, p.holdoutN, p.holdoutWilsonLow, p.holdoutWilsonHigh, 'holdout')
  );
}

/** Día que se abre por defecto: el pedido en la URL si existe; si no, el primero de hoy en adelante; si no, el primero. */
export function defaultDay(days: Pick<DailyDay, 'date'>[], requested: string | null | undefined, todayKey: string): string | undefined {
  if (requested && days.some((d) => d.date === requested)) return requested;
  return (days.find((d) => d.date >= todayKey) ?? days[days.length - 1])?.date;
}

/** Siguiente día (posterior a `date`) con al menos un pick. */
export function nextDayWithPicks<T extends Pick<DailyDay, 'date' | 'counts'>>(days: T[], date: string): T | undefined {
  return days.find((d) => d.date > date && d.counts.picks > 0);
}
