/**
 * Modelo de datos de un proyecto de metrados.
 *
 * Todo lo que se guarda es JSON plano. Los archivos de los planos (PDF, DXF, imágenes) van aparte, como binarios,
 * referenciados por `PlanFile.id`.
 *
 * Coordenadas: cada lámina tiene su propio espacio ("unidades de lámina"), con el origen arriba a la izquierda,
 * x hacia la derecha e y hacia abajo:
 *   - PDF: puntos tipográficos (1/72 de pulgada) de la página ya girada como se ve;
 *   - DXF: unidades de dibujo del espacio modelo (con la y invertida y el origen en la esquina de la extensión);
 *   - imagen: píxeles.
 * Una medición guarda sus vértices en esas unidades; la escala (`ScaleDef.mPerUnit`) las convierte a metros.
 */
import type { Part, Pt } from './geometry';

export type SheetKind = 'pdf' | 'dxf' | 'image';

export interface PlanFile {
  id: string;
  name: string;
  kind: SheetKind;
  /** Tamaño en bytes del archivo original. */
  size: number;
}

export type ScaleSource =
  /** Escala gráfica 1:N de un PDF a tamaño real de papel. */
  | 'ratio'
  /** Dos puntos del plano y la distancia real entre ellos. */
  | 'calibration'
  /** Unidad de dibujo de un DXF (1 unidad = X metros). */
  | 'units';

export interface ScaleDef {
  id: string;
  name: string;
  /** Metros reales por unidad de lámina. */
  mPerUnit: number;
  source: ScaleSource;
  /** Para 'ratio': el N de 1:N. */
  ratio?: number;
  /** Para 'calibration': los dos puntos (unidades de lámina) y la distancia real en metros. */
  calib?: { a: Pt; b: Pt; real: number };
  /** Para 'units': la unidad de dibujo elegida. */
  unit?: DrawingUnit;
}

export type DrawingUnit = 'm' | 'cm' | 'mm' | 'in' | 'ft';

export interface Sheet {
  id: string;
  fileId: string;
  kind: SheetKind;
  name: string;
  /** Página del PDF (empieza en 1). */
  page?: number;
  /** Tamaño en unidades de lámina. */
  w: number;
  h: number;
  /** Una lámina puede tener varias escalas (planta 1:50, detalle 1:25…). Cada medición recuerda la suya. */
  scales: ScaleDef[];
  activeScaleId: string | null;
  /** Capas ocultas (nombres de capa DXF o identificadores de capa PDF). */
  hiddenLayers?: string[];
}

/** Magnitud que se lee del plano. L: longitud · A: área · P: perímetro del área · N: cantidad de puntos. */
export type Base = 'L' | 'A' | 'P' | 'N';

export type ParamKey = 'largo' | 'ancho' | 'alto' | 'factor';

export interface Partida {
  id: string;
  /** Ítem del presupuesto, p. ej. "02.01.03". */
  code: string;
  name: string;
  unit: string;
  base: Base;
  /** Multiplicadores que intervienen en la fórmula además de la magnitud del plano. */
  use: Partial<Record<ParamKey, boolean>>;
  /** Valores por defecto de los multiplicadores (cada medición puede cambiarlos). */
  largo?: number;
  ancho?: number;
  alto?: number;
  factor?: number;
  /** Qué representa el factor, p. ej. "kg/m". */
  factorLabel?: string;
  color: string;
  /** Especialidad / título para agrupar en la hoja (Estructuras, Arquitectura…). */
  group?: string;
}

export type MeasurementKind = 'line' | 'area' | 'count' | 'manual';

export interface Measurement {
  id: string;
  partidaId: string;
  /** Lámina donde está dibujada (null en filas manuales). */
  sheetId: string | null;
  /** Escala de la lámina con la que se mide (null en filas manuales). */
  scaleId: string | null;
  kind: MeasurementKind;
  /**
   * Geometría en unidades de lámina.
   *   line: uno o más trazos (abiertos o cerrados);
   *   area: uno o más anillos (los marcados `hole` se restan);
   *   count: un solo trazo cuyos vértices son los puntos contados.
   */
  parts: Part[];
  /** Descripción de la fila (eje, ambiente, elemento…). */
  label: string;
  /** N.º de veces. */
  times: number;
  /** Descuento: la fila resta (vanos, ductos…). */
  deduct: boolean;
  /** Valores propios de los multiplicadores (si faltan se usan los de la partida). */
  largo?: number;
  ancho?: number;
  alto?: number;
  factor?: number;
  /** En filas manuales: la magnitud base tecleada (m, m² o unidades). */
  manual?: number;
  createdAt: number;
}

export interface ProjectSettings {
  /** Decimales con los que se muestran y exportan las cantidades. */
  decimals: 2 | 3 | 4;
  /** Rótulos de medida sobre el plano. */
  showLabels: boolean;
}

export interface Project {
  version: 1;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  files: PlanFile[];
  sheets: Sheet[];
  partidas: Partida[];
  measurements: Measurement[];
  settings: ProjectSettings;
  /** true mientras sea el proyecto de demostración sin cambios del usuario. */
  sample?: boolean;
}

let counter = 0;

/** Identificador corto y único dentro del proyecto. */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1679616;
  const rnd = Math.floor(Math.random() * 2176782336)
    .toString(36)
    .padStart(6, '0');
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(4, '0')}${rnd}`;
}

export function emptyProject(name = 'Proyecto sin título'): Project {
  const now = Date.now();
  return {
    version: 1,
    id: newId('proj'),
    name,
    createdAt: now,
    updatedAt: now,
    files: [],
    sheets: [],
    partidas: [],
    measurements: [],
    settings: { decimals: 2, showLabels: true },
  };
}

/** Colores de resaltador para las partidas (se asignan en orden; legibles sobre papel blanco y sobre fondo oscuro). */
export const PARTIDA_COLORS = ['#e5484d', '#2f7de1', '#12a150', '#f08c00', '#8e4ec6', '#0e9aa7', '#d6409f', '#946800', '#5b5bd6', '#c2410c', '#3e9b4f', '#b8336a'] as const;

export function nextPartidaColor(partidas: readonly Partida[]): string {
  const used = new Map<string, number>();
  for (const p of partidas) used.set(p.color, (used.get(p.color) ?? 0) + 1);
  let best: string = PARTIDA_COLORS[0];
  let bestCount = Infinity;
  for (const c of PARTIDA_COLORS) {
    const n = used.get(c) ?? 0;
    if (n < bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

/** Herramienta de dibujo que corresponde a la magnitud base de una partida. */
export const kindForBase = (base: Base): Exclude<MeasurementKind, 'manual'> => (base === 'L' ? 'line' : base === 'N' ? 'count' : 'area');

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optNum = (v: unknown): number | undefined => (isNum(v) ? v : undefined);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.slice(0, 500) : fallback);

function sanitizeParts(v: unknown): Part[] {
  if (!Array.isArray(v)) return [];
  const out: Part[] = [];
  for (const raw of v) {
    if (!isObject(raw) || !Array.isArray(raw.v)) continue;
    const verts = [];
    for (const p of raw.v) {
      if (!isObject(p) || !isNum(p.x) || !isNum(p.y)) continue;
      const vtx: Part['v'][number] = { x: p.x, y: p.y };
      if (isNum(p.b) && p.b !== 0) vtx.b = p.b;
      if (Array.isArray(p.c) && p.c.length === 4 && p.c.every(isNum)) vtx.c = [p.c[0], p.c[1], p.c[2], p.c[3]];
      verts.push(vtx);
    }
    if (verts.length === 0) continue;
    const part: Part = { v: verts };
    if (raw.closed === true) part.closed = true;
    if (raw.hole === true) part.hole = true;
    out.push(part);
  }
  return out;
}

/**
 * Valida y normaliza un proyecto leído de disco o del navegador (datos no confiables): descarta lo que no encaja
 * en el modelo en lugar de fallar más tarde. Devuelve null si no parece un proyecto.
 */
export function sanitizeProject(raw: unknown): Project | null {
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.sheets) || !Array.isArray(raw.partidas) || !Array.isArray(raw.measurements)) return null;
  const files: PlanFile[] = [];
  for (const f of Array.isArray(raw.files) ? raw.files : []) {
    if (!isObject(f) || typeof f.id !== 'string') continue;
    const kind = f.kind === 'pdf' || f.kind === 'dxf' || f.kind === 'image' ? f.kind : null;
    if (!kind) continue;
    files.push({ id: f.id, name: str(f.name, 'plano'), kind, size: isNum(f.size) ? f.size : 0 });
  }
  const fileIds = new Set(files.map((f) => f.id));
  const sheets: Sheet[] = [];
  for (const s of raw.sheets) {
    if (!isObject(s) || typeof s.id !== 'string' || typeof s.fileId !== 'string' || !fileIds.has(s.fileId)) continue;
    const kind = s.kind === 'pdf' || s.kind === 'dxf' || s.kind === 'image' ? s.kind : null;
    if (!kind || !isNum(s.w) || !isNum(s.h) || !(s.w > 0) || !(s.h > 0)) continue;
    const scales: ScaleDef[] = [];
    for (const sc of Array.isArray(s.scales) ? s.scales : []) {
      if (!isObject(sc) || typeof sc.id !== 'string' || !isNum(sc.mPerUnit) || !(sc.mPerUnit > 0)) continue;
      const source: ScaleSource = sc.source === 'ratio' || sc.source === 'units' ? sc.source : 'calibration';
      const def: ScaleDef = { id: sc.id, name: str(sc.name, 'Escala'), mPerUnit: sc.mPerUnit, source };
      if (isNum(sc.ratio)) def.ratio = sc.ratio;
      if (sc.unit === 'm' || sc.unit === 'cm' || sc.unit === 'mm' || sc.unit === 'in' || sc.unit === 'ft') def.unit = sc.unit;
      if (isObject(sc.calib) && isObject(sc.calib.a) && isObject(sc.calib.b) && isNum(sc.calib.a.x) && isNum(sc.calib.a.y) && isNum(sc.calib.b.x) && isNum(sc.calib.b.y) && isNum(sc.calib.real)) {
        def.calib = { a: { x: sc.calib.a.x, y: sc.calib.a.y }, b: { x: sc.calib.b.x, y: sc.calib.b.y }, real: sc.calib.real };
      }
      scales.push(def);
    }
    const sheet: Sheet = {
      id: s.id,
      fileId: s.fileId,
      kind,
      name: str(s.name, 'Lámina'),
      w: s.w,
      h: s.h,
      scales,
      activeScaleId: typeof s.activeScaleId === 'string' && scales.some((x) => x.id === s.activeScaleId) ? s.activeScaleId : (scales[0]?.id ?? null),
    };
    if (isNum(s.page) && s.page >= 1) sheet.page = Math.floor(s.page);
    if (Array.isArray(s.hiddenLayers)) sheet.hiddenLayers = s.hiddenLayers.filter((x): x is string => typeof x === 'string').slice(0, 5000);
    sheets.push(sheet);
  }
  const partidas: Partida[] = [];
  for (const p of raw.partidas) {
    if (!isObject(p) || typeof p.id !== 'string') continue;
    const base: Base = p.base === 'A' || p.base === 'P' || p.base === 'N' ? p.base : 'L';
    const use: Partida['use'] = {};
    if (isObject(p.use)) for (const k of ['largo', 'ancho', 'alto', 'factor'] as const) if (p.use[k] === true) use[k] = true;
    const partida: Partida = { id: p.id, code: str(p.code), name: str(p.name, 'Partida'), unit: str(p.unit, 'm'), base, use, color: /^#[0-9a-f]{6}$/i.test(str(p.color)) ? str(p.color) : PARTIDA_COLORS[0] };
    for (const k of ['largo', 'ancho', 'alto', 'factor'] as const) {
      const n = optNum(p[k]);
      if (n !== undefined) partida[k] = n;
    }
    if (typeof p.factorLabel === 'string') partida.factorLabel = p.factorLabel.slice(0, 40);
    if (typeof p.group === 'string') partida.group = p.group.slice(0, 80);
    partidas.push(partida);
  }
  const partidaIds = new Set(partidas.map((p) => p.id));
  const sheetById = new Map(sheets.map((s) => [s.id, s]));
  const measurements: Measurement[] = [];
  for (const m of raw.measurements) {
    if (!isObject(m) || typeof m.id !== 'string' || typeof m.partidaId !== 'string' || !partidaIds.has(m.partidaId)) continue;
    const kind: MeasurementKind | null = m.kind === 'line' || m.kind === 'area' || m.kind === 'count' || m.kind === 'manual' ? m.kind : null;
    if (!kind) continue;
    const sheet = typeof m.sheetId === 'string' ? sheetById.get(m.sheetId) : undefined;
    if (kind !== 'manual' && !sheet) continue;
    const parts = kind === 'manual' ? [] : sanitizeParts(m.parts);
    if (kind !== 'manual' && parts.length === 0) continue;
    const mm: Measurement = {
      id: m.id,
      partidaId: m.partidaId,
      sheetId: kind === 'manual' ? null : sheet!.id,
      scaleId: kind === 'manual' ? null : typeof m.scaleId === 'string' && sheet!.scales.some((x) => x.id === m.scaleId) ? m.scaleId : null,
      kind,
      parts,
      label: str(m.label),
      times: isNum(m.times) ? m.times : 1,
      deduct: m.deduct === true,
      createdAt: isNum(m.createdAt) ? m.createdAt : Date.now(),
    };
    for (const k of ['largo', 'ancho', 'alto', 'factor', 'manual'] as const) {
      const n = optNum(m[k]);
      if (n !== undefined) mm[k] = n;
    }
    measurements.push(mm);
  }
  const settings = isObject(raw.settings) ? raw.settings : {};
  const decimals = settings.decimals === 3 || settings.decimals === 4 ? settings.decimals : 2;
  const now = Date.now();
  const project: Project = {
    version: 1,
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 80) : newId('proj'),
    name: str(raw.name, 'Proyecto sin título') || 'Proyecto sin título',
    createdAt: isNum(raw.createdAt) ? raw.createdAt : now,
    updatedAt: isNum(raw.updatedAt) ? raw.updatedAt : now,
    files,
    sheets,
    partidas,
    measurements,
    settings: { decimals, showLabels: settings.showLabels !== false },
  };
  if (raw.sample === true) project.sample = true;
  return project;
}
