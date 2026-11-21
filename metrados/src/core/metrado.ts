/**
 * Cálculo de metrados.
 *
 * Cada fila de la hoja es:   Parcial = N.º de veces × (magnitud leída del plano) × (multiplicadores de la partida)
 *
 * La magnitud del plano depende de la base de la partida: L longitud, A área, P perímetro, N cantidad de puntos.
 * Los multiplicadores (largo, ancho, alto, factor) son los que la partida declara en `use`; cada medición puede
 * cambiar su valor.
 *
 * Redondeo, igual que en una hoja de metrados hecha a mano: la magnitud leída se redondea a los decimales del
 * proyecto ANTES de multiplicar, el parcial se redondea a esos mismos decimales y el total de la partida es la suma
 * de los parciales. Así la hoja se puede comprobar con calculadora y el Excel exportado da exactamente lo mismo.
 */
import { partArea, partLength, type Part } from './geometry';
import type { Base, Measurement, ParamKey, Partida, Project, ScaleDef, Sheet } from './model';
import { roundTo } from './units';

export interface Quantities {
  /** Longitud total de los trazos (m). */
  L: number;
  /** Área neta: anillos menos huecos (m²). */
  A: number;
  /** Perímetro de los anillos exteriores (m). */
  P: number;
  /** Cantidad de puntos. */
  N: number;
}

/** Magnitudes geométricas de unos trazos en unidades de lámina (sin escala). */
export function rawQuantities(kind: Measurement['kind'], parts: readonly Part[]): Quantities {
  const q: Quantities = { L: 0, A: 0, P: 0, N: 0 };
  if (kind === 'count') {
    for (const p of parts) q.N += p.v.length;
  } else if (kind === 'line') {
    for (const p of parts) q.L += partLength(p);
  } else if (kind === 'area') {
    for (const p of parts) {
      const ring: Part = p.closed ? p : { ...p, closed: true };
      const a = partArea(ring);
      if (p.hole) q.A -= a;
      else {
        q.A += a;
        q.P += partLength(ring);
      }
    }
    q.L = q.P;
    if (q.A < 0) q.A = 0;
  }
  return q;
}

/** Magnitudes reales (metros, m²) de una medición con su escala. */
export function quantities(m: Measurement, mPerUnit: number): Quantities {
  const q = rawQuantities(m.kind, m.parts);
  return { L: q.L * mPerUnit, A: q.A * mPerUnit * mPerUnit, P: q.P * mPerUnit, N: q.N };
}

export function scaleOf(sheet: Sheet | undefined, scaleId: string | null): ScaleDef | null {
  if (!sheet || !scaleId) return null;
  return sheet.scales.find((s) => s.id === scaleId) ?? null;
}

export const PARAM_KEYS: readonly ParamKey[] = ['largo', 'ancho', 'alto', 'factor'];

/** Multiplicadores que una partida puede usar según su base (el largo no tiene sentido si ya se mide una longitud). */
export function allowedParams(base: Base): ParamKey[] {
  if (base === 'L' || base === 'P') return ['ancho', 'alto', 'factor'];
  if (base === 'A') return ['alto', 'factor'];
  return ['largo', 'ancho', 'alto', 'factor'];
}

export const usedParams = (p: Partida): ParamKey[] => allowedParams(p.base).filter((k) => p.use[k]);

/** Valor de un multiplicador para una medición: el suyo si lo tiene; si no, el de la partida. */
export function paramValue(m: Measurement, p: Partida, key: ParamKey): number | undefined {
  return m[key] ?? p[key];
}

/** Una fila de la hoja de metrados, con cada magnitud en su columna. */
export interface MetradoRow {
  id: string;
  label: string;
  sheetName: string;
  kind: Measurement['kind'];
  /** N.º de veces con signo (negativo en descuentos). */
  times: number;
  /** Cantidad contada (base N). */
  cant?: number;
  /** Longitud o perímetro medidos (bases L y P), o el largo de la partida (base N). */
  largo?: number;
  ancho?: number;
  alto?: number;
  /** Área medida (base A). */
  area?: number;
  factor?: number;
  /** null si a la medición le falta la escala o un multiplicador. */
  parcial: number | null;
  /** Motivo por el que no se puede calcular. */
  issue?: 'sin-escala' | 'falta-dato';
}

export interface PartidaBlock {
  partida: Partida;
  rows: MetradoRow[];
  total: number;
  /** Alguna fila no se pudo calcular. */
  incomplete: boolean;
}

const COLUMN_FOR_BASE: Record<Base, 'largo' | 'area' | 'cant'> = { L: 'largo', P: 'largo', A: 'area', N: 'cant' };

/** Magnitud base de la medición en unidades reales, o null si no tiene escala. */
export function baseQuantity(m: Measurement, partida: Partida, sheet: Sheet | undefined): number | null {
  if (m.kind === 'manual') return m.manual ?? null;
  const scale = scaleOf(sheet, m.scaleId);
  if (partida.base === 'N') return rawQuantities(m.kind, m.parts).N;
  if (!scale) return null;
  return quantities(m, scale.mPerUnit)[partida.base];
}

export function buildRow(m: Measurement, partida: Partida, sheet: Sheet | undefined, decimals: number): MetradoRow {
  const row: MetradoRow = {
    id: m.id,
    label: m.label,
    sheetName: sheet?.name ?? '',
    kind: m.kind,
    times: (m.deduct ? -1 : 1) * (Number.isFinite(m.times) ? m.times : 1),
    parcial: null,
  };
  const base = baseQuantity(m, partida, sheet);
  if (base === null) {
    row.issue = m.kind === 'manual' ? 'falta-dato' : 'sin-escala';
  } else {
    row[COLUMN_FOR_BASE[partida.base]] = partida.base === 'N' ? base : roundTo(base, decimals);
  }
  let product = base === null ? null : (row[COLUMN_FOR_BASE[partida.base]] as number);
  for (const key of usedParams(partida)) {
    const value = paramValue(m, partida, key);
    if (value === undefined || !Number.isFinite(value)) {
      product = null;
      row.issue ??= 'falta-dato';
      continue;
    }
    row[key] = value;
    if (product !== null) product *= value;
  }
  row.parcial = product === null ? null : roundTo(row.times * product, decimals);
  return row;
}

/** La hoja completa: una sección por partida, en el orden de la lista de partidas. */
export function buildSheet(project: Project): PartidaBlock[] {
  const sheets = new Map(project.sheets.map((s) => [s.id, s]));
  const byPartida = new Map<string, Measurement[]>();
  for (const m of project.measurements) {
    const list = byPartida.get(m.partidaId);
    if (list) list.push(m);
    else byPartida.set(m.partidaId, [m]);
  }
  const d = project.settings.decimals;
  return project.partidas.map((partida) => {
    const rows = (byPartida.get(partida.id) ?? []).map((m) => buildRow(m, partida, m.sheetId ? sheets.get(m.sheetId) : undefined, d));
    let total = 0;
    let incomplete = false;
    for (const r of rows) {
      if (r.parcial === null) incomplete = true;
      else total += r.parcial;
    }
    return { partida, rows, total: roundTo(total, d), incomplete };
  });
}

/** Total de una sola partida (para la lista lateral). */
export function partidaTotal(project: Project, partidaId: string): { total: number; count: number; incomplete: boolean } {
  const partida = project.partidas.find((p) => p.id === partidaId);
  if (!partida) return { total: 0, count: 0, incomplete: false };
  const sheets = new Map(project.sheets.map((s) => [s.id, s]));
  let total = 0;
  let count = 0;
  let incomplete = false;
  for (const m of project.measurements) {
    if (m.partidaId !== partidaId) continue;
    count++;
    const row = buildRow(m, partida, m.sheetId ? sheets.get(m.sheetId) : undefined, project.settings.decimals);
    if (row.parcial === null) incomplete = true;
    else total += row.parcial;
  }
  return { total: roundTo(total, project.settings.decimals), count, incomplete };
}

/** Texto de la fórmula de una partida, p. ej. "Longitud × Ancho × Alto". */
export function formulaText(p: Pick<Partida, 'base' | 'use' | 'factorLabel'>): string {
  const baseName: Record<Base, string> = { L: 'Longitud', A: 'Área', P: 'Perímetro', N: 'Cantidad' };
  const names: Record<ParamKey, string> = { largo: 'Largo', ancho: 'Ancho', alto: p.base === 'A' ? 'Espesor/alto' : 'Alto', factor: p.factorLabel || 'Factor' };
  return [baseName[p.base], ...allowedParams(p.base).filter((k) => p.use[k]).map((k) => names[k])].join(' × ');
}
