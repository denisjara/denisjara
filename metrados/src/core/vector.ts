/**
 * Geometría vectorial de una lámina en forma compacta (arrays tipados), con un índice espacial para:
 *   - enganchar el cursor a puntos exactos del plano (extremos, puntos medios, intersecciones, perpendiculares);
 *   - tomar un trazo completo del plano y medirlo;
 *   - buscar los segmentos de una zona (detección de recintos).
 *
 * Cada "trazo" (path) guarda dos cosas: su forma EXACTA (rectas, arcos y Bézier, para medir) y su versión en
 * segmentos rectos (para buscar y enganchar). Un PDF de CAD puede tener más de un millón de segmentos: por eso no
 * hay un objeto por segmento.
 */
import { closestOnSegment, flattenSegment, segmentIntersection, type BBox, type Part, type Pt, type Vtx } from './geometry';

/** Bits de `flags` de cada segmento. */
const START_REAL = 1;
const END_REAL = 2;
const CURVE = 4;

/** Bits de `pathFlags`. */
export const PATH_CLOSED = 1;
export const PATH_FILL = 2;

class Grow<T extends Float64Array | Uint32Array | Uint16Array | Uint8Array> {
  a: T;
  n = 0;
  constructor(
    private readonly make: (n: number) => T,
    cap = 1024,
  ) {
    this.a = make(cap);
  }
  need(extra: number): void {
    if (this.n + extra <= this.a.length) return;
    let cap = this.a.length * 2;
    while (cap < this.n + extra) cap *= 2;
    const next = this.make(cap);
    next.set(this.a.subarray(0, this.n) as never);
    this.a = next;
  }
  push(v: number): void {
    if (this.n === this.a.length) this.need(1);
    this.a[this.n++] = v;
  }
  done(): T {
    return this.a.slice(0, this.n) as T;
  }
}

export interface Grid {
  minX: number;
  minY: number;
  cell: number;
  cols: number;
  rows: number;
  /** Inicio de la lista de segmentos de cada celda (cols·rows + 1 entradas). */
  start: Uint32Array;
  items: Uint32Array;
  /** Marca de la última consulta que vio cada segmento (para no repetirlo). */
  stamp: Uint32Array;
  tick: number;
}

export interface VectorData {
  /** Número de segmentos. */
  count: number;
  /** x1, y1, x2, y2 de cada segmento, en unidades de lámina. */
  xy: Float64Array;
  flags: Uint8Array;
  /** Trazo al que pertenece cada segmento. */
  pathOf: Uint32Array;
  pathCount: number;
  /** Primer segmento de cada trazo (pathCount + 1 entradas). */
  pathSeg: Uint32Array;
  /** Capa de cada trazo (0 = sin capa; n = capas[n − 1]). */
  pathLayer: Uint16Array;
  /** Estilo de cada trazo (índice en la tabla de estilos de la lámina). */
  pathStyle: Uint16Array;
  pathFlags: Uint8Array;
  /** Forma exacta de cada trazo: posición en `pd` (pathCount + 1 entradas). */
  pathOff: Uint32Array;
  pd: Float64Array;
  bounds: BBox;
  grid: Grid;
}

export class VectorBuilder {
  private xy = new Grow((n) => new Float64Array(n), 4096);
  private flags = new Grow((n) => new Uint8Array(n), 1024);
  private pathOf = new Grow((n) => new Uint32Array(n), 1024);
  private pathSeg = new Grow((n) => new Uint32Array(n), 256);
  private pathLayer = new Grow((n) => new Uint16Array(n), 256);
  private pathStyle = new Grow((n) => new Uint16Array(n), 256);
  private pathFlags = new Grow((n) => new Uint8Array(n), 256);
  private pathOff = new Grow((n) => new Uint32Array(n), 256);
  private pd = new Grow((n) => new Float64Array(n), 4096);
  private tmp: Pt[] = [];

  /** @param tol error de cuerda máximo al convertir curvas en segmentos (unidades de lámina). */
  constructor(private readonly tol: number) {}

  get segmentCount(): number {
    return this.flags.n;
  }

  get pathCount(): number {
    return this.pathSeg.n;
  }

  private seg(x1: number, y1: number, x2: number, y2: number, flags: number, path: number): void {
    if (x1 === x2 && y1 === y2) return;
    if (!Number.isFinite(x1 + y1 + x2 + y2)) return;
    this.xy.need(4);
    const a = this.xy.a;
    const n = this.xy.n;
    a[n] = x1;
    a[n + 1] = y1;
    a[n + 2] = x2;
    a[n + 3] = y2;
    this.xy.n = n + 4;
    this.flags.push(flags);
    this.pathOf.push(path);
  }

  private segment(a: Vtx, b: Vtx, path: number): void {
    const curved = a.c !== undefined || (a.b !== undefined && Math.abs(a.b) >= 1e-12);
    if (!curved) {
      this.seg(a.x, a.y, b.x, b.y, START_REAL | END_REAL, path);
      return;
    }
    const pts = this.tmp;
    pts.length = 0;
    flattenSegment(a, b, this.tol, pts);
    let px = a.x;
    let py = a.y;
    for (let i = 0; i < pts.length; i++) {
      const f = CURVE | (i === 0 ? START_REAL : 0) | (i === pts.length - 1 ? END_REAL : 0);
      this.seg(px, py, pts[i].x, pts[i].y, f, path);
      px = pts[i].x;
      py = pts[i].y;
    }
  }

  /** Añade un trazo. Devuelve su identificador, o −1 si no tiene geometría. */
  addPart(part: Part, layer = 0, style = 0, fill = false): number {
    const v = part.v;
    if (v.length < 2) return -1;
    const id = this.pathSeg.n;
    const firstSeg = this.flags.n;
    for (let i = 0; i < v.length - 1; i++) this.segment(v[i], v[i + 1], id);
    if (part.closed) this.segment(v[v.length - 1], v[0], id);
    if (this.flags.n === firstSeg) return -1;
    this.pathSeg.push(firstSeg);
    this.pathLayer.push(layer);
    this.pathStyle.push(style);
    this.pathFlags.push((part.closed ? PATH_CLOSED : 0) | (fill ? PATH_FILL : 0));
    this.pathOff.push(this.pd.n);
    const last = part.closed ? v.length : v.length - 1;
    for (let i = 0; i < v.length; i++) {
      const p = v[i];
      if (p.c && i < last) {
        this.pd.need(7);
        this.pd.push(2);
        this.pd.push(p.x);
        this.pd.push(p.y);
        this.pd.push(p.c[0]);
        this.pd.push(p.c[1]);
        this.pd.push(p.c[2]);
        this.pd.push(p.c[3]);
      } else if (p.b !== undefined && Math.abs(p.b) >= 1e-12 && i < last) {
        this.pd.need(4);
        this.pd.push(1);
        this.pd.push(p.x);
        this.pd.push(p.y);
        this.pd.push(p.b);
      } else {
        this.pd.need(3);
        this.pd.push(0);
        this.pd.push(p.x);
        this.pd.push(p.y);
      }
    }
    return id;
  }

  finish(bounds: BBox): VectorData {
    const count = this.flags.n;
    const pathCount = this.pathSeg.n;
    this.pathSeg.push(count);
    this.pathOff.push(this.pd.n);
    const xy = this.xy.done();
    return {
      count,
      xy,
      flags: this.flags.done(),
      pathOf: this.pathOf.done(),
      pathCount,
      pathSeg: this.pathSeg.done(),
      pathLayer: this.pathLayer.done(),
      pathStyle: this.pathStyle.done(),
      pathFlags: this.pathFlags.done(),
      pathOff: this.pathOff.done(),
      pd: this.pd.done(),
      bounds,
      grid: buildGrid(xy, count, bounds),
    };
  }
}

/** Forma exacta de un trazo. */
export function partOfPath(data: VectorData, path: number): Part {
  const v: Vtx[] = [];
  const pd = data.pd;
  const end = data.pathOff[path + 1];
  for (let i = data.pathOff[path]; i < end; ) {
    const kind = pd[i];
    if (kind === 2) {
      v.push({ x: pd[i + 1], y: pd[i + 2], c: [pd[i + 3], pd[i + 4], pd[i + 5], pd[i + 6]] });
      i += 7;
    } else if (kind === 1) {
      v.push({ x: pd[i + 1], y: pd[i + 2], b: pd[i + 3] });
      i += 4;
    } else {
      v.push({ x: pd[i + 1], y: pd[i + 2] });
      i += 3;
    }
  }
  const part: Part = { v };
  if (data.pathFlags[path] & PATH_CLOSED) part.closed = true;
  return part;
}

// ---------------------------------------------------------------------------
// Rejilla
// ---------------------------------------------------------------------------

const clampInt = (v: number, max: number): number => (v < 0 ? 0 : v > max ? max : v | 0);

/** Recorre las celdas que toca un segmento, fila a fila (cobertura exacta, sin registrar toda su caja envolvente). */
function cellsOfSegment(g: Pick<Grid, 'minX' | 'minY' | 'cell' | 'cols' | 'rows'>, x1: number, y1: number, x2: number, y2: number, visit: (cell: number) => void): void {
  const inv = 1 / g.cell;
  const r0 = clampInt(Math.floor((Math.min(y1, y2) - g.minY) * inv), g.rows - 1);
  const r1 = clampInt(Math.floor((Math.max(y1, y2) - g.minY) * inv), g.rows - 1);
  if (r0 === r1) {
    const c0 = clampInt(Math.floor((Math.min(x1, x2) - g.minX) * inv), g.cols - 1);
    const c1 = clampInt(Math.floor((Math.max(x1, x2) - g.minX) * inv), g.cols - 1);
    for (let c = c0; c <= c1; c++) visit(r0 * g.cols + c);
    return;
  }
  const slope = (x2 - x1) / (y2 - y1);
  const yMin = Math.min(y1, y2);
  const yMax = Math.max(y1, y2);
  for (let r = r0; r <= r1; r++) {
    const ya = Math.max(yMin, g.minY + r * g.cell);
    const yb = Math.min(yMax, g.minY + (r + 1) * g.cell);
    const xa = x1 + (ya - y1) * slope;
    const xb = x1 + (yb - y1) * slope;
    const c0 = clampInt(Math.floor((Math.min(xa, xb) - g.minX) * inv), g.cols - 1);
    const c1 = clampInt(Math.floor((Math.max(xa, xb) - g.minX) * inv), g.cols - 1);
    for (let c = c0; c <= c1; c++) visit(r * g.cols + c);
  }
}

export function buildGrid(xy: Float64Array, count: number, bounds: BBox): Grid {
  const w = Math.max(bounds.maxX - bounds.minX, 1e-9);
  const h = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const target = Math.min(600_000, Math.max(1024, count / 2));
  let cell = Math.sqrt((w * h) / target);
  cell = Math.max(cell, Math.max(w, h) / 1024);
  const cols = Math.max(1, Math.ceil(w / cell));
  const rows = Math.max(1, Math.ceil(h / cell));
  const dims = { minX: bounds.minX, minY: bounds.minY, cell, cols, rows };
  const start = new Uint32Array(cols * rows + 1);
  for (let i = 0; i < count; i++) {
    cellsOfSegment(dims, xy[i * 4], xy[i * 4 + 1], xy[i * 4 + 2], xy[i * 4 + 3], (c) => {
      start[c + 1]++;
    });
  }
  for (let c = 0; c < cols * rows; c++) start[c + 1] += start[c];
  const items = new Uint32Array(start[cols * rows]);
  const fill = start.slice(0, cols * rows);
  for (let i = 0; i < count; i++) {
    cellsOfSegment(dims, xy[i * 4], xy[i * 4 + 1], xy[i * 4 + 2], xy[i * 4 + 3], (c) => {
      items[fill[c]++] = i;
    });
  }
  return { ...dims, start, items, stamp: new Uint32Array(count), tick: 0 };
}

/** Segmentos (sin repetir) de las celdas que toca la caja. Puede incluir alguno que no la toque. */
export function queryBox(data: VectorData, minX: number, minY: number, maxX: number, maxY: number, out: number[] = []): number[] {
  const g = data.grid;
  out.length = 0;
  if (data.count === 0) return out;
  const inv = 1 / g.cell;
  const c0 = clampInt(Math.floor((minX - g.minX) * inv), g.cols - 1);
  const c1 = clampInt(Math.floor((maxX - g.minX) * inv), g.cols - 1);
  const r0 = clampInt(Math.floor((minY - g.minY) * inv), g.rows - 1);
  const r1 = clampInt(Math.floor((maxY - g.minY) * inv), g.rows - 1);
  if (++g.tick >= 0xffffffff) {
    g.stamp.fill(0);
    g.tick = 1;
  }
  const tick = g.tick;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cellIdx = r * g.cols + c;
      for (let k = g.start[cellIdx], e = g.start[cellIdx + 1]; k < e; k++) {
        const s = g.items[k];
        if (g.stamp[s] !== tick) {
          g.stamp[s] = tick;
          out.push(s);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Enganche
// ---------------------------------------------------------------------------

export type SnapKind = 'endpoint' | 'midpoint' | 'intersection' | 'perpendicular' | 'nearest' | 'vertex';

export interface SnapModes {
  endpoint: boolean;
  midpoint: boolean;
  intersection: boolean;
  perpendicular: boolean;
  nearest: boolean;
}

export const ALL_SNAPS: SnapModes = { endpoint: true, midpoint: true, intersection: true, perpendicular: true, nearest: true };

export interface SnapHit {
  x: number;
  y: number;
  kind: SnapKind;
  /** Distancia al cursor (unidades de lámina). */
  d: number;
  /** Segmento del plano al que pertenece (−1 si es un vértice de una medición). */
  seg: number;
}

export interface SnapQuery {
  modes: SnapModes;
  /** Radio de captura en unidades de lámina. */
  radius: number;
  /** Punto anterior del trazo en curso (para el enganche perpendicular). */
  from?: Pt | null;
  /** Capas ocultas: layerHidden[capa] = 1. */
  layerHidden?: Uint8Array | null;
  /** Vértices de las mediciones ya dibujadas: también son puntos de enganche. */
  extra?: readonly Pt[];
}

const MAX_CELL_SPAN = 24;
const MAX_INTERSECT = 40;

const scratch: number[] = [];

/**
 * Punto exacto del plano al que debe engancharse el cursor, o null si no hay ninguno dentro del radio.
 * Prioridad: puntos característicos (extremo, vértice propio, intersección, punto medio; gana el más cercano, con una
 * pequeña ventaja para los extremos), después el pie de la perpendicular y por último el punto más cercano de una línea.
 */
export function snapPoint(data: VectorData | null, p: Pt, q: SnapQuery): SnapHit | null {
  let radius = q.radius;
  const top: { hit: SnapHit | null; score: number } = { hit: null, score: Infinity };
  const consider = (x: number, y: number, kind: SnapKind, seg: number, bias: number) => {
    const d = Math.hypot(x - p.x, y - p.y);
    if (d > radius) return;
    const score = d - bias * radius;
    if (score < top.score) {
      top.score = score;
      top.hit = { x, y, kind, d, seg };
    }
  };

  if (q.extra) for (const e of q.extra) consider(e.x, e.y, 'vertex', -1, 0.2);

  let perp: SnapHit | null = null;
  let near: SnapHit | null = null;

  if (data && data.count > 0) {
    const g = data.grid;
    radius = Math.min(radius, (MAX_CELL_SPAN / 2) * g.cell);
    const cand = queryBox(data, p.x - radius, p.y - radius, p.x + radius, p.y + radius, scratch);
    const xy = data.xy;
    const hidden = q.layerHidden;
    const close: { s: number; d: number }[] = [];
    for (let k = 0; k < cand.length; k++) {
      const s = cand[k];
      if (hidden && hidden[data.pathLayer[data.pathOf[s]]]) continue;
      const a = { x: xy[s * 4], y: xy[s * 4 + 1] };
      const b = { x: xy[s * 4 + 2], y: xy[s * 4 + 3] };
      const c = closestOnSegment(p, a, b);
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d > radius) continue;
      close.push({ s, d });
      const f = data.flags[s];
      if (q.modes.endpoint) {
        if (f & START_REAL) consider(a.x, a.y, 'endpoint', s, 0.2);
        if (f & END_REAL) consider(b.x, b.y, 'endpoint', s, 0.2);
      }
      if (q.modes.midpoint && !(f & CURVE)) consider((a.x + b.x) / 2, (a.y + b.y) / 2, 'midpoint', s, 0);
      if (q.modes.nearest && (!near || d < near.d)) near = { x: c.x, y: c.y, kind: 'nearest', d, seg: s };
      if (q.modes.perpendicular && q.from) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = ((q.from.x - a.x) * dx + (q.from.y - a.y) * dy) / (dx * dx + dy * dy);
        if (t > 1e-9 && t < 1 - 1e-9) {
          const fx = a.x + dx * t;
          const fy = a.y + dy * t;
          const fd = Math.hypot(fx - p.x, fy - p.y);
          // No tiene sentido una "perpendicular" que cae sobre el propio punto de partida.
          if (fd <= radius && Math.hypot(fx - q.from.x, fy - q.from.y) > 1e-9 && (!perp || fd < perp.d)) perp = { x: fx, y: fy, kind: 'perpendicular', d: fd, seg: s };
        }
      }
    }
    if (q.modes.intersection && close.length > 1) {
      close.sort((u, v) => u.d - v.d);
      const n = Math.min(close.length, MAX_INTERSECT);
      for (let i = 0; i < n; i++) {
        const s1 = close[i].s;
        const a1 = { x: xy[s1 * 4], y: xy[s1 * 4 + 1] };
        const b1 = { x: xy[s1 * 4 + 2], y: xy[s1 * 4 + 3] };
        for (let j = i + 1; j < n; j++) {
          const s2 = close[j].s;
          const hit = segmentIntersection(a1, b1, { x: xy[s2 * 4], y: xy[s2 * 4 + 1] }, { x: xy[s2 * 4 + 2], y: xy[s2 * 4 + 3] });
          if (hit) consider(hit.x, hit.y, 'intersection', s1, 0.1);
        }
      }
    }
  }
  return top.hit ?? perp ?? near;
}

/** Trazo del plano más cercano al punto (para la herramienta de tomar trazos), dentro del radio. */
export function nearestPath(data: VectorData | null, p: Pt, radius: number, layerHidden?: Uint8Array | null): { path: number; seg: number; d: number } | null {
  if (!data || data.count === 0) return null;
  const r = Math.min(radius, (MAX_CELL_SPAN / 2) * data.grid.cell);
  const cand = queryBox(data, p.x - r, p.y - r, p.x + r, p.y + r, scratch);
  const xy = data.xy;
  let best: { path: number; seg: number; d: number } | null = null;
  for (let k = 0; k < cand.length; k++) {
    const s = cand[k];
    const path = data.pathOf[s];
    if (layerHidden && layerHidden[data.pathLayer[path]]) continue;
    const c = closestOnSegment(p, { x: xy[s * 4], y: xy[s * 4 + 1] }, { x: xy[s * 4 + 2], y: xy[s * 4 + 3] });
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d <= r && (!best || d < best.d)) best = { path, seg: s, d };
  }
  return best;
}
