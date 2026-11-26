/**
 * Utilidades puras de «Cuota alta 6+» (longshots.json): tipos de apuesta, filtros, resumen del historial fuera de
 * muestra, valor esperado y calculadora. Sin JSX ni DOM: se prueban en Node (tests/app/longshots.test.ts).
 *
 * Regla de honestidad: nada aquí «mejora» una cifra. El resumen del historial se calcula con las cuentas publicadas
 * (aciertos / apuestas resueltas; ROI = beneficio / apostado) y, si falta un dato, devuelve undefined (la UI pinta «—»).
 */
import type { CalibrationBin, LongshotBet, LongshotDay, LongshotKind, LongshotLeg, LongshotRecord } from '../../types/data';

/** Cuota mínima del apartado si el archivo no la trae. */
export const LONGSHOT_DEFAULT_MIN_ODDS = 6;

/** Tipos en el orden en que se muestran (el mismo del contrato). */
export const LONGSHOT_KINDS: readonly LongshotKind[] = ['combinada', 'sorpresa', 'marcador', 'goleador', 'otro'];

export const LONGSHOT_KIND_LABEL: Record<LongshotKind, string> = {
  combinada: 'Combinada',
  sorpresa: 'Sorpresa',
  marcador: 'Marcador exacto',
  goleador: 'Goleador',
  otro: 'Otra',
};

/** Etiqueta en plural (tabla de historial y filtros). */
export const LONGSHOT_KIND_PLURAL: Record<LongshotKind, string> = {
  combinada: 'Combinadas',
  sorpresa: 'Sorpresas',
  marcador: 'Marcador exacto',
  goleador: 'Goleador',
  otro: 'Otras',
};

export function isLongshotKind(x: unknown): x is LongshotKind {
  return typeof x === 'string' && (LONGSHOT_KINDS as readonly string[]).includes(x);
}

/** Valores del parámetro ?tipo= de la URL (en español, legibles) → tipo del contrato. */
export const LONGSHOT_FILTERS: readonly { id: string; kind: LongshotKind; label: string }[] = [
  { id: 'combinadas', kind: 'combinada', label: 'Combinadas' },
  { id: 'sorpresas', kind: 'sorpresa', label: 'Sorpresas' },
  { id: 'marcador', kind: 'marcador', label: 'Marcador exacto' },
  { id: 'goleador', kind: 'goleador', label: 'Goleador' },
  { id: 'otras', kind: 'otro', label: 'Otras' },
];

/** Tipo pedido en la URL (?tipo=combinadas…) o undefined si falta o no es válido («Todas»). */
export function kindFromParam(x: string | null | undefined): LongshotKind | undefined {
  return LONGSHOT_FILTERS.find((f) => f.id === x)?.kind;
}
/** Parámetro de URL de un tipo. */
export function paramFromKind(kind: LongshotKind | undefined): string | undefined {
  return kind ? LONGSHOT_FILTERS.find((f) => f.kind === kind)?.id : undefined;
}

/** Apuestas del tipo elegido (todas si no hay tipo), en el orden del archivo. */
export function filterLongshots(bets: readonly LongshotBet[], kind?: LongshotKind): LongshotBet[] {
  return kind ? bets.filter((b) => b.kind === kind) : [...bets];
}

/** Número de apuestas de cada tipo. */
export function kindCounts(bets: readonly LongshotBet[]): Map<LongshotKind, number> {
  const out = new Map<LongshotKind, number>();
  for (const b of bets) out.set(b.kind, (out.get(b.kind) ?? 0) + 1);
  return out;
}

const ms = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
};

/** La pata ya ha empezado (su hora de inicio ha pasado): la apuesta ya no se puede hacer antes del partido. */
export function legStarted(leg: Pick<LongshotLeg, 'date'>, now: number): boolean {
  const t = ms(leg.date);
  return Number.isFinite(t) && t <= now;
}

/** Alguna pata de la apuesta ha empezado (o la apuesta ya está resuelta). */
export function betStarted(bet: Pick<LongshotBet, 'legs' | 'result'>, now: number): boolean {
  return !!bet.result || bet.legs.some((l) => legStarted(l, now));
}

/** Las que aún se pueden jugar primero (conservando el orden del archivo); las empezadas o resueltas, al final. */
export function playableFirst(bets: readonly LongshotBet[], now: number): LongshotBet[] {
  return [...bets.filter((b) => !betStarted(b, now)), ...bets.filter((b) => betStarted(b, now))];
}

/** Primera hora de inicio de la apuesta (ms) o NaN. */
export function firstKickoff(bet: Pick<LongshotBet, 'legs'>): number {
  const ts = bet.legs.map((l) => ms(l.date)).filter(Number.isFinite);
  return ts.length ? Math.min(...ts) : NaN;
}

/** Siguiente día (posterior a `date`) con al menos una apuesta. */
export function nextDayWithBets<T extends Pick<LongshotDay, 'date' | 'bets'>>(days: readonly T[], date: string): T | undefined {
  return days.find((d) => d.date > date && d.bets.length > 0);
}

// ---------------------------------------------------------------------------
// Valor esperado y calculadora
// ---------------------------------------------------------------------------
/**
 * Estado del valor esperado de una apuesta:
 *  - 'pos'        hay cuota de la casa y prob·cuota − 1 > 0 (la probabilidad del modelo supera la que paga la casa)
 *  - 'neg'        hay cuota de la casa y el valor esperado es ≤ 0 (a la larga no gana)
 *  - 'sin-cuota'  la fuente no publica cuota de la casa para algún mercado: hay que compararla con la cuota justa
 */
export type EvState = 'pos' | 'neg' | 'sin-cuota';
export function evState(bet: Pick<LongshotBet, 'marketOdds' | 'ev'>): EvState {
  if (bet.marketOdds === undefined || bet.ev === undefined || !Number.isFinite(bet.ev)) return 'sin-cuota';
  return bet.ev > 0 ? 'pos' : 'neg';
}

/** Probabilidad implícita en una cuota decimal (1 / cuota), o undefined si la cuota no es válida. */
export function impliedProb(odds: number | undefined): number | undefined {
  return odds !== undefined && Number.isFinite(odds) && odds > 1 ? 1 / odds : undefined;
}

/** Beneficio NETO si la apuesta acierta: importe · (cuota − 1). undefined si los datos no son válidos. */
export function netWin(stake: number, odds: number | undefined): number | undefined {
  if (!Number.isFinite(stake) || stake <= 0 || odds === undefined || !Number.isFinite(odds) || odds <= 1) return undefined;
  return stake * (odds - 1);
}

/** Importe de la calculadora: número finito entre 1 y 10.000 (si no, 10). */
export const STAKE_DEFAULT = 10;
export function clampStake(x: unknown): number {
  const v = typeof x === 'number' ? x : typeof x === 'string' ? Number(x.replace(',', '.')) : NaN;
  if (!Number.isFinite(v) || v <= 0) return STAKE_DEFAULT;
  return Math.min(10_000, Math.max(1, Math.round(v * 100) / 100));
}

/** «1 de cada N»: N = round(1 / prob), nunca menor que 1. */
export function oneIn(prob: number): number {
  return prob > 0 && Number.isFinite(prob) ? Math.max(1, Math.round(1 / prob)) : 1;
}

// ---------------------------------------------------------------------------
// Historial fuera de muestra
// ---------------------------------------------------------------------------
/**
 * Apuestas RESUELTAS de un tipo (sin las nulas). El contrato da `bets` (todas) y `hitRate` = aciertos / resueltas:
 * resueltas = aciertos / acierto. Sin aciertos no se puede despejar y se usan todas (cota superior).
 */
export function settledOf(r: Pick<LongshotRecord, 'bets' | 'hits' | 'hitRate' | 'voids'>): number {
  if (r.voids !== undefined && Number.isFinite(r.voids)) return Math.max(r.hits, r.bets - r.voids);
  if (r.hits > 0 && r.hitRate > 0) return Math.max(r.hits, Math.min(r.bets, Math.round(r.hits / r.hitRate)));
  return r.bets;
}

/** Tipos que ahora NO se publican como recomendación (sin muestra o mal calibrados), con el motivo. */
export function excludedKinds(byKind: readonly LongshotRecord[]): { kind: LongshotKind; label: string; reason: string }[] {
  return byKind.filter((r) => !!r.excluded).map((r) => ({ kind: r.kind, label: LONGSHOT_KIND_PLURAL[r.kind], reason: r.excluded! }));
}

export interface LongshotSummary {
  /** apuestas publicadas (todas) */
  bets: number;
  /** resueltas (sin nulas) */
  settled: number;
  hits: number;
  /** aciertos / resueltas */
  hitRate?: number;
  /** probabilidad media del modelo en esas apuestas (ponderada por resueltas) */
  expectedHitRate?: number;
  /** cuota media (ponderada por apuestas) */
  avgOdds?: number;
  /** con cuotas de CIERRE, solo en las apuestas con cuota de la casa en todas sus patas */
  roi?: { bets: number; staked: number; profit: number; roi: number };
  /** «1 de cada N» observado */
  oneIn?: number;
}

/** Resumen de todos los tipos juntos (sumas de las cuentas publicadas, nunca promedios de porcentajes). */
export function longshotSummary(byKind: readonly LongshotRecord[]): LongshotSummary {
  let bets = 0;
  let settled = 0;
  let hits = 0;
  let expW = 0;
  let expS = 0;
  let oddsW = 0;
  let oddsS = 0;
  let rBets = 0;
  let staked = 0;
  let profit = 0;
  for (const r of byKind) {
    const s = settledOf(r);
    bets += r.bets;
    settled += s;
    hits += r.hits;
    if (Number.isFinite(r.expectedHitRate)) {
      expW += s;
      expS += s * r.expectedHitRate;
    }
    if (Number.isFinite(r.avgOdds) && r.avgOdds > 1) {
      oddsW += r.bets;
      oddsS += r.bets * r.avgOdds;
    }
    if (r.roi && r.roi.staked > 0) {
      rBets += r.roi.bets;
      staked += r.roi.staked;
      profit += r.roi.profit;
    }
  }
  const hitRate = settled > 0 ? hits / settled : undefined;
  return {
    bets,
    settled,
    hits,
    hitRate,
    expectedHitRate: expW > 0 ? expS / expW : undefined,
    avgOdds: oddsW > 0 ? oddsS / oddsW : undefined,
    roi: staked > 0 ? { bets: rBets, staked, profit, roi: profit / staked } : undefined,
    oneIn: hitRate !== undefined && hitRate > 0 ? Math.round(1 / hitRate) : undefined,
  };
}

/**
 * Extremo superior del eje de la curva de calibración en la banda baja: el múltiplo de 5 pp por encima del mayor
 * tramo / frecuencia observada (mín. 10 %, máx. 100 %). Así los puntos no quedan apelotonados en una esquina.
 */
export function calibrationDomain(bins: readonly Pick<CalibrationBin, 'to' | 'observed' | 'predicted' | 'n'>[]): number {
  const vals = bins.filter((b) => b.n > 0).flatMap((b) => [b.to, b.observed, b.predicted]).filter((v) => Number.isFinite(v));
  if (!vals.length) return 1;
  const max = Math.max(...vals);
  const step = max <= 0.5 ? 0.05 : 0.1;
  return Math.min(1, Math.max(0.1, Math.round(Math.ceil((max - 1e-9) / step) * step * 100) / 100));
}

/** Cuota mínima como texto: «6» si es entera, «6,50» si no. */
export function minOddsLabel(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(2).replace('.', ',');
}
