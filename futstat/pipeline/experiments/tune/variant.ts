/**
 * Fábrica de las variantes «tune-*» (agente de ajuste de hiperparámetros): combinador = pool lineal de producción con
 * los MISMOS pesos efectivos (row.weights) y, opcionalmente, las probabilidades del Elo recalculadas con una ventaja
 * local por grupo de competiciones (ver homeAdv.ts). Sin estado: blend es una función pura de la fila.
 */
import { blend } from '../../../src/lib/models';
import type { Prob1X2 } from '../../../src/types/data';
import type { ComponentRow, DcHooks, EloHooks, ModelVariant } from '../types';
import { haDelta, shiftEloProbs, type HaGroup } from './homeAdv';

export type HaTable = Partial<Record<HaGroup, number>>;

/** Tabla elegida con el Elo solo en 2025-01 → 2026-05 (anterior a la ventana de ajuste); copas americanas: 65 (n < 100). */
export const HA_REGION_KIND: HaTable = { 'AM-league': 70, 'AM-continental': 75, 'EU-league': 50, 'EU-continental': 80, 'EU-cup': 25 };

/** Elo del partido con la ventaja local de su grupo (sin cambio en campo neutral o grupos fuera de la tabla). */
export function eloWithTable(row: ComponentRow, table: HaTable): Prob1X2 {
  return shiftEloProbs(row.elo, row.eloDiff, haDelta(table, row.compId, row.kind, row.neutral));
}

/** Pool lineal de producción (pesos efectivos de la fila) con el Elo recalculado. */
export function blendWithTable(row: ComponentRow, table: HaTable): Prob1X2 {
  return blend([
    { probs: row.goal, weight: row.weights.goal },
    { probs: eloWithTable(row, table), weight: row.weights.elo },
    ...(row.market ? [{ probs: row.market, weight: row.weights.market }] : []),
  ]);
}

export function makeTuneVariant(opts: { name: string; description: string; table?: HaTable; dc?: DcHooks; elo?: EloHooks }): ModelVariant {
  const v: ModelVariant = { name: opts.name, description: opts.description };
  if (opts.dc) v.dc = opts.dc;
  if (opts.elo) v.elo = opts.elo;
  const table = opts.table;
  if (table) v.combine = { blend: (row) => blendWithTable(row, table) };
  return v;
}
