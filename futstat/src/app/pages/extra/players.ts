/**
 * Lógica pura de la página Jugadores: métricas, ordenación y percentiles por posición.
 */
import type { PlayerSeasonRow } from '../../../types/data';
import { int, num } from '../../lib/format';
import type { Position } from './ui';

export type Mode = 'total' | 'p90';
export type MetricKey = 'form' | 'goals' | 'assists' | 'shots' | 'sot' | 'cards' | 'fouls';
export type SortKey = MetricKey | 'name' | 'apps' | 'minutes';

export interface MetricDef {
  key: MetricKey;
  /** nombre completo ("Tiros a puerta") */
  label: string;
  /** cabecera corta en totales / por 90 */
  short: string;
  shortP90: string;
  total: (r: PlayerSeasonRow) => number;
  p90: (r: PlayerSeasonRow) => number;
}

const safe = (x: number | undefined) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const per90 = (r: PlayerSeasonRow) => r.per90 ?? { goals: 0, assists: 0, shots: 0, shotsOnTarget: 0, cards: 0, foulsCommitted: 0 };

export const METRICS: MetricDef[] = [
  { key: 'form', label: 'Forma', short: 'Forma', shortP90: 'Forma', total: (r) => safe(r.formIndex), p90: (r) => safe(r.formIndex) },
  { key: 'goals', label: 'Goles', short: 'G', shortP90: 'G/90', total: (r) => safe(r.goals), p90: (r) => safe(per90(r).goals) },
  { key: 'assists', label: 'Asistencias', short: 'A', shortP90: 'A/90', total: (r) => safe(r.assists), p90: (r) => safe(per90(r).assists) },
  { key: 'shots', label: 'Tiros', short: 'Tiros', shortP90: 'Tiros/90', total: (r) => safe(r.shots), p90: (r) => safe(per90(r).shots) },
  { key: 'sot', label: 'Tiros a puerta', short: 'TaP', shortP90: 'TaP/90', total: (r) => safe(r.shotsOnTarget), p90: (r) => safe(per90(r).shotsOnTarget) },
  { key: 'cards', label: 'Tarjetas', short: 'Tarj.', shortP90: 'Tarj/90', total: (r) => safe(r.yellow) + safe(r.red), p90: (r) => safe(per90(r).cards) },
  { key: 'fouls', label: 'Faltas', short: 'Faltas', shortP90: 'Faltas/90', total: (r) => safe(r.foulsCommitted), p90: (r) => safe(per90(r).foulsCommitted) },
];

export const METRIC_BY_KEY = Object.fromEntries(METRICS.map((m) => [m.key, m])) as Record<MetricKey, MetricDef>;

export function metricValue(r: PlayerSeasonRow, key: MetricKey, mode: Mode): number {
  const m = METRIC_BY_KEY[key];
  return mode === 'p90' ? m.p90(r) : m.total(r);
}

export function fmtMetric(v: number, key: MetricKey, mode: Mode): string {
  if (key === 'form') return int(v);
  return mode === 'p90' ? num(v, 2) : int(v);
}

export function sortValue(r: PlayerSeasonRow, key: SortKey, mode: Mode): number | string {
  if (key === 'name') return r.player.name;
  if (key === 'apps') return safe(r.apps);
  if (key === 'minutes') return safe(r.minutes);
  return metricValue(r, key, mode);
}

/** Ordena (estable) con desempate por índice de forma y minutos. */
export function sortPlayers(rows: PlayerSeasonRow[], key: SortKey, dir: 'asc' | 'desc', mode: Mode): PlayerSeasonRow[] {
  const s = dir === 'asc' ? 1 : -1;
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const va = sortValue(a.r, key, mode);
      const vb = sortValue(b.r, key, mode);
      const c = typeof va === 'number' && typeof vb === 'number' ? (va - vb) * s : String(va).localeCompare(String(vb), 'es') * s;
      if (c !== 0) return c;
      return safe(b.r.formIndex) - safe(a.r.formIndex) || safe(b.r.minutes) - safe(a.r.minutes) || a.i - b.i;
    })
    .map((x) => x.r);
}

export const rowKey = (r: PlayerSeasonRow) => `${r.player.id}-${r.compId}`;

// ---------------------------------------------------------------------------
// Percentiles por posición (sobre jugadores con minutos suficientes)
// ---------------------------------------------------------------------------
export const PEER_MIN_MINUTES = 270;
export const PERCENTILE_METRICS: MetricKey[] = ['goals', 'assists', 'shots', 'sot', 'cards', 'fouls'];

export type PeerTable = Partial<Record<Position, Record<MetricKey, number[]>>>;

export function buildPeerTable(players: PlayerSeasonRow[]): PeerTable {
  const out: PeerTable = {};
  for (const p of players) {
    if (safe(p.minutes) < PEER_MIN_MINUTES) continue;
    const pos = p.player.position;
    const t = (out[pos] ??= Object.fromEntries(PERCENTILE_METRICS.map((k) => [k, [] as number[]])) as Record<MetricKey, number[]>);
    for (const k of PERCENTILE_METRICS) t[k].push(metricValue(p, k, 'p90'));
  }
  for (const t of Object.values(out)) for (const k of PERCENTILE_METRICS) t![k].sort((a, b) => a - b);
  return out;
}

/** Percentil 0..100 de x dentro de una lista ordenada (empates a mitad). undefined si hay < 8 pares. */
export function percentile(sorted: number[] | undefined, x: number): number | undefined {
  if (!sorted || sorted.length < 8) return undefined;
  let below = 0;
  let equal = 0;
  for (const v of sorted) {
    if (v < x - 1e-9) below++;
    else if (Math.abs(v - x) <= 1e-9) equal++;
  }
  return Math.round(((below + equal / 2) / sorted.length) * 100);
}
