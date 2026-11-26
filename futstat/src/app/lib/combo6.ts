/**
 * Utilidades puras de «Combinada 6» (combo6.json): categorías, origen de la cuota, recálculo de las cifras de una
 * combinada a partir de sus patas y estado de las patas. Sin JSX ni DOM: se prueban en Node.
 *
 * Regla de honestidad: nada aquí «mejora» una cifra. Las cifras de una combinada (probabilidad, cuotas, valor esperado,
 * «1 de cada N») se recalculan SIEMPRE con las patas publicadas, y una cuota estimada se marca siempre como tal.
 */
import type { Combo6Category, Combo6Combo, Combo6Leg, Combo6OddsSource } from '../../types/data';

export const COMBO6_CATEGORIES: readonly Combo6Category[] = ['ganador', 'goles', 'corners', 'tiros-puerta', 'tiros', 'tarjetas', 'faltas', 'jugadores'];

export const COMBO6_CATEGORY_LABEL: Record<Combo6Category, string> = {
  ganador: 'Ganador',
  goles: 'Goles',
  corners: 'Córners',
  'tiros-puerta': 'Tiros a puerta',
  tiros: 'Tiros',
  tarjetas: 'Tarjetas',
  faltas: 'Faltas',
  jugadores: 'Jugadores',
};

export const COMBO6_ODDS_SOURCES: readonly Combo6OddsSource[] = ['casa', 'derivada', 'estimada'];

/** Texto corto del origen de la cuota de una pata (la interfaz lo pinta junto a la cuota). */
export const COMBO6_ODDS_SOURCE_LABEL: Record<Combo6OddsSource, string> = {
  casa: 'cuota de la casa',
  derivada: 'estimada desde el 1X2 de la casa',
  estimada: 'estimada (justa menos margen típico)',
};

/** Regla por defecto (la del motor) si el archivo no la trae. */
export const COMBO6_DEFAULT_RULE = {
  targetMin: 6,
  targetMax: 8,
  legMinProb: 0.7,
  legMaxProb: 0.88,
  minLegs: 4,
  maxLegs: 9,
  minCategories: 4,
  maxPerCategory: 2,
} as const;

/** Ámbito de la combinada del día con todas las competiciones. */
export const COMBO6_SCOPE_ALL = 'todas';

export function isCombo6Category(x: unknown): x is Combo6Category {
  return typeof x === 'string' && (COMBO6_CATEGORIES as readonly string[]).includes(x);
}

export function isCombo6OddsSource(x: unknown): x is Combo6OddsSource {
  return typeof x === 'string' && (COMBO6_ODDS_SOURCES as readonly string[]).includes(x);
}

/** Resultado de una combinada a partir de sus patas: pata fallada ⇒ 'miss'; todas resueltas ⇒ 'hit' (nulas fuera) o 'void'. */
export function combo6Result(legs: readonly Pick<Combo6Leg, 'result'>[]): Combo6Combo['result'] {
  if (legs.some((l) => l.result === 'miss')) return 'miss';
  if (!legs.length || legs.some((l) => l.result === undefined)) return undefined;
  return legs.every((l) => l.result === 'void') ? 'void' : 'hit';
}

/** Cifras de una combinada recalculadas con sus patas (producto de probabilidades y de cuotas, EV, «1 de cada N»). */
export function combo6Totals(legs: readonly Pick<Combo6Leg, 'prob' | 'bookOdds' | 'bookOddsEstimated' | 'category' | 'kickoff'>[]): {
  prob: number;
  fairOdds: number;
  bookOdds: number;
  estimatedLegs: number;
  oneIn: number;
  ev: number;
  categories: number;
  firstKickoff: string;
  lastKickoff: string;
} {
  const prob = legs.reduce((p, l) => p * l.prob, 1);
  const bookOdds = legs.reduce((o, l) => o * l.bookOdds, 1);
  const kicks = legs.map((l) => l.kickoff).filter(Boolean).sort();
  return {
    prob,
    fairOdds: prob > 0 ? 1 / prob : Infinity,
    bookOdds,
    estimatedLegs: legs.filter((l) => l.bookOddsEstimated).length,
    oneIn: prob > 0 ? Math.max(1, Math.round(1 / prob)) : 0,
    ev: prob * bookOdds - 1,
    categories: new Set(legs.map((l) => l.category)).size,
    firstKickoff: kicks[0] ?? '',
    lastKickoff: kicks[kicks.length - 1] ?? '',
  };
}

/** La pata ya ha empezado (su hora de inicio ha pasado). */
export function combo6LegStarted(leg: Pick<Combo6Leg, 'kickoff'>, now: number): boolean {
  const t = Date.parse(leg.kickoff);
  return Number.isFinite(t) && t <= now;
}

/** Alguna pata ha empezado o la combinada ya está resuelta: ya no se puede apostar entera antes de los partidos. */
export function combo6Started(c: Pick<Combo6Combo, 'legs' | 'result'>, now: number): boolean {
  return !!c.result || c.legs.some((l) => combo6LegStarted(l, now));
}

// ---------------------------------------------------------------------------
// Presentación (página /combinada-6 e Inicio)
// ---------------------------------------------------------------------------

/** Patas ordenadas por hora de inicio (estable; las de hora inválida al final). */
export function combo6LegsByKickoff<T extends Pick<Combo6Leg, 'kickoff'>>(legs: readonly T[]): T[] {
  const t = (l: T) => {
    const x = Date.parse(l.kickoff);
    return Number.isFinite(x) ? x : Infinity;
  };
  return legs
    .map((l, i) => ({ l, i }))
    .sort((a, b) => t(a.l) - t(b.l) || a.i - b.i)
    .map((x) => x.l);
}

/** Probabilidad acumulada tras cada pata (en el orden dado): [p1, p1·p2, …]. La última es la de la combinada. */
export function combo6Cumulative(legs: readonly Pick<Combo6Leg, 'prob'>[]): number[] {
  const out: number[] = [];
  let p = 1;
  for (const l of legs) {
    p *= l.prob;
    out.push(p);
  }
  return out;
}

/** Cuota de una pata como texto: «1,27» si es de la casa; «≈ 1,27» si es estimada o derivada. */
export function combo6LegOddsText(leg: Pick<Combo6Leg, 'bookOdds' | 'bookOddsEstimated' | 'oddsSource'>, fmt: (x: number) => string): string {
  const estimated = leg.bookOddsEstimated || leg.oddsSource !== 'casa';
  return `${estimated ? '≈ ' : ''}${fmt(leg.bookOdds)}`;
}

/** Decimales con coma (las selecciones del pipeline usan punto: «Más de 2.5 goles»). */
const comma = (s: string) => s.replace(/(\d)\.(\d)/g, '$1,$2');
const pctText = (p: number) => `${(Math.round(p * 1000) / 10).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
const legPctText = (p: number) => `${Math.round(p * 100)} %`;
const oddsText = (x: number) => (Number.isFinite(x) ? x.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');

export interface Combo6CopyOptions {
  /** hora local de una pata («20:45»); por defecto HH:MM en la zona del navegador */
  timeOf?: (iso: string) => string;
  /** cabecera (p. ej. «Combinada 6 del día · jueves, 27 de noviembre») */
  title?: string;
}

/**
 * Texto plano para copiar al portapapeles: una línea por pata (hora · partido · competición · categoría: selección ·
 * probabilidad · cuota, marcando las estimadas) y el total. Sin promesas: lleva la probabilidad real y el aviso +18.
 */
export function combo6CopyText(combo: Pick<Combo6Combo, 'label' | 'legs'>, opts: Combo6CopyOptions = {}): string {
  const timeOf =
    opts.timeOf ??
    ((iso: string) => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });
    });
  const legs = combo6LegsByKickoff(combo.legs);
  const t = combo6Totals(legs);
  const lines = [opts.title || combo.label || 'Combinada 6'];
  legs.forEach((l, i) => {
    const hour = timeOf(l.kickoff);
    const teams = `${l.home.name} – ${l.away.name}`;
    const comp = l.compName ? ` (${l.compName})` : '';
    const est = l.bookOddsEstimated || l.oddsSource !== 'casa';
    lines.push(
      `${i + 1}. ${hour ? `${hour} · ` : ''}${teams}${comp} · ${COMBO6_CATEGORY_LABEL[l.category]}: ${comma(l.selection)} · ${legPctText(l.prob)} · cuota ${est ? '≈ ' : ''}${oddsText(l.bookOdds)}${est ? ' (estimada)' : ''}`,
    );
  });
  lines.push(
    `Cuota total en la casa ≈ ${oddsText(t.bookOdds)}${t.estimatedLegs ? ` (${t.estimatedLegs} de ${legs.length} cuotas estimadas: compruébalas en tu casa)` : ''}`,
    `Probabilidad según el modelo: ${pctText(t.prob)} (1 de cada ${t.oneIn}) · cuota justa ${oddsText(t.fairOdds)}`,
    'La mayoría de los días se pierde. FutStat Lab · +18 · Juega con responsabilidad.',
  );
  return lines.join('\n');
}
