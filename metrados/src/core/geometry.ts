/**
 * Geometría plana exacta para metrados.
 *
 * Un trazo (`Part`) es una lista de vértices. Cada vértice puede llevar la forma del tramo que SALE de él:
 *   - sin nada: tramo recto hasta el vértice siguiente;
 *   - `b` (bulge): arco circular, b = tan(θ/4) con θ el ángulo barrido (con signo), igual que LWPOLYLINE de DXF;
 *   - `c`: tramo Bézier cúbico con puntos de control (c1x, c1y, c2x, c2y), como las curvas de un PDF.
 *
 * Longitudes y áreas se calculan de forma analítica (rectas y arcos: fórmula cerrada; Bézier: área cerrada y
 * longitud por cuadratura adaptativa), nunca a partir de la versión teselada. La teselación (`flatten*`) solo se usa
 * para dibujar, enganchar y hacer pruebas de pertenencia.
 *
 * Todas las funciones trabajan en las unidades de la lámina (puntos PDF, unidades de dibujo DXF o píxeles) con
 * precisión doble; la conversión a metros reales es un único factor de escala aplicado al final (ver units.ts).
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Vtx {
  x: number;
  y: number;
  /** Bulge del tramo que sale de este vértice (arco circular). */
  b?: number;
  /** Puntos de control (c1x, c1y, c2x, c2y) del tramo Bézier cúbico que sale de este vértice. */
  c?: readonly [number, number, number, number];
}

export interface Part {
  v: Vtx[];
  /** El trazo se cierra uniendo el último vértice con el primero (con la forma que indique el último vértice). */
  closed?: boolean;
  /** En mediciones de área: este anillo es un hueco y se resta. */
  hole?: boolean;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Matriz afín 2D [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (convención de canvas y PDF). */
export type Mat = readonly [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** m1 · m2: aplica primero m2 y después m1 (igual que ctx.transform sobre la matriz actual m1). */
export function matMul(m1: Mat, m2: Mat): Mat {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function matApply(m: Mat, x: number, y: number): Pt {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function matInvert(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || det === 0) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** Determinante de la parte lineal (negativo: la matriz refleja). */
export const matDet = (m: Mat): number => m[0] * m[3] - m[1] * m[2];

/** true si la matriz conserva las formas (escala uniforme + giro, con o sin reflexión): los arcos siguen siendo arcos. */
export function matIsSimilarity(m: Mat, eps = 1e-9): boolean {
  const sx2 = m[0] * m[0] + m[1] * m[1];
  const sy2 = m[2] * m[2] + m[3] * m[3];
  const dot = m[0] * m[2] + m[1] * m[3];
  const scale = Math.max(sx2, sy2);
  return Math.abs(sx2 - sy2) <= eps * scale && Math.abs(dot) <= eps * scale;
}

export const dist = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y);
export const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

// ---------------------------------------------------------------------------
// Arcos (bulge)
// ---------------------------------------------------------------------------

export interface ArcInfo {
  cx: number;
  cy: number;
  r: number;
  /** Ángulo inicial y final (radianes, atan2 en las coordenadas de la lámina). */
  a0: number;
  a1: number;
  /** Ángulo barrido con signo (a1 = a0 + theta). */
  theta: number;
}

/** Arco circular de `a` a `b` con el bulge dado. Devuelve null si el tramo es (numéricamente) recto. */
export function arcFromBulge(a: Pt, b: Pt, bulge: number): ArcInfo | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (!(Math.abs(bulge) > 1e-12) || chord === 0) return null;
  const theta = 4 * Math.atan(bulge);
  // Distancia (con signo) del punto medio de la cuerda al centro, a lo largo de la normal izquierda (-dy, dx).
  const h = (chord * (1 - bulge * bulge)) / (4 * bulge);
  const cx = (a.x + b.x) / 2 - (dy / chord) * h;
  const cy = (a.y + b.y) / 2 + (dx / chord) * h;
  const r = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
  const a0 = Math.atan2(a.y - cy, a.x - cx);
  return { cx, cy, r, a0, a1: a0 + theta, theta };
}

/**
 * Arco circular (centro, radio, ángulo inicial y barrido con signo) como vértices con bulge.
 * Se parte en tramos de 90° como máximo para que cada bulge sea pequeño y estable. El último vértice no lleva bulge.
 */
export function arcToVertices(cx: number, cy: number, r: number, a0: number, theta: number): Vtx[] {
  const n = Math.max(1, Math.ceil(Math.abs(theta) / (Math.PI / 2) - 1e-9));
  const step = theta / n;
  const b = Math.tan(step / 4);
  const out: Vtx[] = [];
  for (let i = 0; i <= n; i++) {
    const ang = a0 + step * i;
    const v: Vtx = { x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) };
    if (i < n) v.b = b;
    out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bézier cúbica
// ---------------------------------------------------------------------------

const GL_X = [0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363];
const GL_W = [0.362683783378362, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];

function bezierSpeed(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, t: number): number {
  const u = 1 - t;
  const dx = 3 * (u * u * (x1 - x0) + 2 * u * t * (x2 - x1) + t * t * (x3 - x2));
  const dy = 3 * (u * u * (y1 - y0) + 2 * u * t * (y2 - y1) + t * t * (y3 - y2));
  return Math.hypot(dx, dy);
}

function glLength(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, ta: number, tb: number): number {
  const half = (tb - ta) / 2;
  const mid = (ta + tb) / 2;
  let s = 0;
  for (let i = 0; i < 4; i++) {
    s += GL_W[i] * (bezierSpeed(x0, y0, x1, y1, x2, y2, x3, y3, mid - half * GL_X[i]) + bezierSpeed(x0, y0, x1, y1, x2, y2, x3, y3, mid + half * GL_X[i]));
  }
  return s * half;
}

/** Longitud de una Bézier cúbica por cuadratura de Gauss-Legendre adaptativa (error relativo < 1e-12 en curvas normales). */
export function bezierLength(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): number {
  const rec = (ta: number, tb: number, whole: number, depth: number): number => {
    const tm = (ta + tb) / 2;
    const left = glLength(x0, y0, x1, y1, x2, y2, x3, y3, ta, tm);
    const right = glLength(x0, y0, x1, y1, x2, y2, x3, y3, tm, tb);
    const sum = left + right;
    if (depth >= 24 || Math.abs(sum - whole) <= 1e-13 * Math.max(1, sum)) return sum;
    return rec(ta, tm, left, depth + 1) + rec(tm, tb, right, depth + 1);
  };
  return rec(0, 1, glLength(x0, y0, x1, y1, x2, y2, x3, y3, 0, 1), 0);
}

export function bezierPoint(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * x0 + b * x1 + c * x2 + d * x3, y: a * y0 + b * y1 + c * y2 + d * y3 };
}

// ---------------------------------------------------------------------------
// Tramos
// ---------------------------------------------------------------------------

/** Longitud exacta del tramo que sale de `a` y llega a `b`. */
export function segmentLength(a: Vtx, b: Pt): number {
  if (a.c) return bezierLength(a.x, a.y, a.c[0], a.c[1], a.c[2], a.c[3], b.x, b.y);
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  const bulge = a.b;
  if (bulge === undefined || Math.abs(bulge) < 1e-12) return chord;
  const ab = Math.abs(bulge);
  return (chord * (1 + ab * ab) * Math.atan(ab)) / ab;
}

/** Aporte del tramo a la integral ½∮(x·dy − y·dx): la suma sobre un anillo cerrado da su área con signo. */
export function segmentAreaTerm(a: Vtx, b: Pt): number {
  const chordTerm = (a.x * b.y - b.x * a.y) / 2;
  if (a.c) {
    const x1 = a.c[0] - a.x;
    const y1 = a.c[1] - a.y;
    const x2 = a.c[2] - a.x;
    const y2 = a.c[3] - a.y;
    const x3 = b.x - a.x;
    const y3 = b.y - a.y;
    return chordTerm + 0.15 * (x1 * (y2 + y3) + x2 * (2 * y3 - y1) - x3 * (y1 + 2 * y2));
  }
  const bulge = a.b;
  if (bulge === undefined || Math.abs(bulge) < 1e-12) return chordTerm;
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  const r = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
  const theta = 4 * Math.atan(bulge);
  return chordTerm + (r * r * (theta - Math.sin(theta))) / 2;
}

/** Recorre los tramos de un trazo (incluido el de cierre si está cerrado). */
export function forEachSegment(part: Part, fn: (a: Vtx, b: Vtx, index: number) => void): void {
  const v = part.v;
  const n = v.length;
  if (n < 2) return;
  for (let i = 0; i < n - 1; i++) fn(v[i], v[i + 1], i);
  if (part.closed) fn(v[n - 1], v[0], n - 1);
}

/** Longitud total de un trazo (perímetro si está cerrado). */
export function partLength(part: Part): number {
  let s = 0;
  forEachSegment(part, (a, b) => {
    s += segmentLength(a, b);
  });
  return s;
}

/** Área con signo del anillo que forma el trazo (se cierra aunque `closed` sea falso). */
export function partSignedArea(part: Part): number {
  const v = part.v;
  const n = v.length;
  if (n < 2) return 0;
  let s = 0;
  for (let i = 0; i < n - 1; i++) s += segmentAreaTerm(v[i], v[i + 1]);
  // El tramo de cierre: con su forma si el trazo está cerrado; recto si no.
  s += part.closed ? segmentAreaTerm(v[n - 1], v[0]) : (v[n - 1].x * v[0].y - v[0].x * v[n - 1].y) / 2;
  return s;
}

export const partArea = (part: Part): number => Math.abs(partSignedArea(part));

// ---------------------------------------------------------------------------
// Teselación (para dibujar, enganchar y pruebas de pertenencia; nunca para medir)
// ---------------------------------------------------------------------------

/** Añade a `out` los puntos intermedios y el final del tramo a→b (no añade `a`). */
export function flattenSegment(a: Vtx, b: Pt, tol: number, out: Pt[]): void {
  if (a.c) {
    const [c1x, c1y, c2x, c2y] = a.c;
    const m = Math.max(Math.hypot(a.x - 2 * c1x + c2x, a.y - 2 * c1y + c2y), Math.hypot(c1x - 2 * c2x + b.x, c1y - 2 * c2y + b.y));
    const n = Math.min(4096, Math.max(1, Math.ceil(Math.sqrt((0.75 * m) / tol))));
    for (let i = 1; i < n; i++) out.push(bezierPoint(a.x, a.y, c1x, c1y, c2x, c2y, b.x, b.y, i / n));
    out.push({ x: b.x, y: b.y });
    return;
  }
  const arc = a.b !== undefined ? arcFromBulge(a, b, a.b) : null;
  if (arc) {
    const maxStep = arc.r > tol ? 2 * Math.acos(1 - tol / arc.r) : Math.PI / 2;
    const n = Math.min(4096, Math.max(1, Math.ceil(Math.abs(arc.theta) / maxStep)));
    for (let i = 1; i < n; i++) {
      const ang = arc.a0 + (arc.theta * i) / n;
      out.push({ x: arc.cx + arc.r * Math.cos(ang), y: arc.cy + arc.r * Math.sin(ang) });
    }
  }
  out.push({ x: b.x, y: b.y });
}

/** Polilínea de rectas que aproxima el trazo con error de cuerda ≤ tol. Si está cerrado NO repite el primer punto. */
export function flattenPart(part: Part, tol: number): Pt[] {
  const v = part.v;
  if (v.length === 0) return [];
  const out: Pt[] = [{ x: v[0].x, y: v[0].y }];
  for (let i = 0; i < v.length - 1; i++) flattenSegment(v[i], v[i + 1], tol, out);
  if (part.closed && v.length > 1) {
    flattenSegment(v[v.length - 1], v[0], tol, out);
    out.pop();
  }
  return out;
}

export const hasCurves = (part: Part): boolean => part.v.some((p) => p.c !== undefined || (p.b !== undefined && Math.abs(p.b) >= 1e-12));

export function emptyBBox(): BBox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function extendBBox(box: BBox, x: number, y: number): void {
  if (x < box.minX) box.minX = x;
  if (x > box.maxX) box.maxX = x;
  if (y < box.minY) box.minY = y;
  if (y > box.maxY) box.maxY = y;
}

export const bboxIsEmpty = (b: BBox): boolean => !(b.minX <= b.maxX && b.minY <= b.maxY);

/** Caja envolvente del trazo (las curvas se teselan con una tolerancia proporcional a su tamaño). */
export function partBBox(part: Part, box: BBox = emptyBBox()): BBox {
  if (!hasCurves(part)) {
    for (const p of part.v) extendBBox(box, p.x, p.y);
    return box;
  }
  let span = 0;
  for (const p of part.v) span = Math.max(span, Math.abs(p.x), Math.abs(p.y));
  for (const p of flattenPart(part, Math.max(span * 1e-5, 1e-9))) extendBBox(box, p.x, p.y);
  return box;
}

// ---------------------------------------------------------------------------
// Puntos, segmentos y polígonos
// ---------------------------------------------------------------------------

/** Punto del segmento a–b más cercano a p, con su parámetro t ∈ [0, 1]. */
export function closestOnSegment(p: Pt, a: Pt, b: Pt): { x: number; y: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: a.x + dx * t, y: a.y + dy * t, t };
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const c = closestOnSegment(p, a, b);
  return Math.hypot(p.x - c.x, p.y - c.y);
}

/**
 * Intersección de los segmentos a–b y c–d. Devuelve el punto y los parámetros (t sobre a–b, u sobre c–d),
 * o null si son paralelos o no se cortan dentro de ambos (con holgura `eps` en los parámetros).
 */
export function segmentIntersection(a: Pt, b: Pt, c: Pt, d: Pt, eps = 1e-9): { x: number; y: number; t: number; u: number } | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  const scale = Math.hypot(rx, ry) * Math.hypot(sx, sy);
  if (scale === 0 || Math.abs(den) <= 1e-12 * scale) return null;
  const qx = c.x - a.x;
  const qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return { x: a.x + rx * t, y: a.y + ry * t, t, u };
}

/** Punto dentro de un polígono simple (regla par-impar). `poly` no repite el primer punto. */
export function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Área con signo de un polígono de rectas. */
export function polygonSignedArea(poly: readonly Pt[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  return s / 2;
}

export function polygonCentroid(poly: readonly Pt[]): Pt {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j].x * poly[i].y - poly[i].x * poly[j].y;
    a += f;
    cx += (poly[j].x + poly[i].x) * f;
    cy += (poly[j].y + poly[i].y) * f;
  }
  if (Math.abs(a) < 1e-12) {
    let sx = 0;
    let sy = 0;
    for (const p of poly) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / Math.max(1, poly.length), y: sy / Math.max(1, poly.length) };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

function distToPolygonEdges(p: Pt, poly: readonly Pt[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) best = Math.min(best, distToSegment(p, poly[j], poly[i]));
  return best;
}

/**
 * Punto interior cómodo para rotular un polígono: el centroide si cae dentro con holgura; si no (formas en L, en U…),
 * el punto más alejado de los bordes de una rejilla gruesa. Es solo para colocar la etiqueta.
 */
export function polygonLabelPoint(poly: readonly Pt[]): Pt {
  const c = polygonCentroid(poly);
  if (poly.length < 3) return c;
  const box = emptyBBox();
  for (const p of poly) extendBBox(box, p.x, p.y);
  const size = Math.min(box.maxX - box.minX, box.maxY - box.minY);
  if (pointInPolygon(c, poly) && distToPolygonEdges(c, poly) >= size * 0.12) return c;
  let best = c;
  let bestD = pointInPolygon(c, poly) ? distToPolygonEdges(c, poly) : -1;
  const N = 14;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const p = { x: box.minX + ((box.maxX - box.minX) * (i + 0.5)) / (N + 1), y: box.minY + ((box.maxY - box.minY) * (j + 0.5)) / (N + 1) };
      if (!pointInPolygon(p, poly)) continue;
      const d = distToPolygonEdges(p, poly);
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
  }
  return best;
}

/** Punto a mitad de recorrido de una polilínea de rectas y la dirección del tramo donde cae (para rotular longitudes). */
export function polylineMidpoint(pts: readonly Pt[]): { p: Pt; angle: number } {
  if (pts.length === 0) return { p: { x: 0, y: 0 }, angle: 0 };
  if (pts.length === 1) return { p: pts[0], angle: 0 };
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (acc + d >= total / 2 && d > 0) {
      const t = (total / 2 - acc) / d;
      return { p: lerp(pts[i - 1], pts[i], t), angle: Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x) };
    }
    acc += d;
  }
  return { p: pts[pts.length - 1], angle: 0 };
}

/** Aplica una matriz afín a un trazo conservando arcos cuando la matriz es una semejanza (si no, los convierte en Bézier). */
export function transformPart(part: Part, m: Mat): Part {
  const similarity = matIsSimilarity(m);
  const flip = matDet(m) < 0;
  const src = similarity ? part.v : arcsToBeziers(part).v;
  const v: Vtx[] = src.map((p) => {
    const q = matApply(m, p.x, p.y);
    const out: Vtx = { x: q.x, y: q.y };
    if (p.c) {
      const c1 = matApply(m, p.c[0], p.c[1]);
      const c2 = matApply(m, p.c[2], p.c[3]);
      out.c = [c1.x, c1.y, c2.x, c2.y];
    } else if (p.b !== undefined && Math.abs(p.b) >= 1e-12) {
      out.b = flip ? -p.b : p.b;
    }
    return out;
  });
  const out: Part = { v };
  if (part.closed) out.closed = true;
  if (part.hole) out.hole = true;
  return out;
}

/**
 * Sustituye cada arco por tramos Bézier de 22,5° como máximo (error radial relativo < 1e-7), para poder aplicar
 * transformaciones que no conservan círculos (escala no uniforme de un bloque DXF).
 */
export function arcsToBeziers(part: Part): Part {
  if (!part.v.some((p) => p.b !== undefined && Math.abs(p.b) >= 1e-12)) return part;
  const v: Vtx[] = [];
  const n = part.v.length;
  const last = part.closed ? n : n - 1;
  for (let i = 0; i < n; i++) {
    const a = part.v[i];
    const arc = i < last && a.b !== undefined ? arcFromBulge(a, part.v[(i + 1) % n], a.b) : null;
    if (!arc) {
      const copy: Vtx = { x: a.x, y: a.y };
      if (a.c) copy.c = a.c;
      v.push(copy);
      continue;
    }
    const pieces = Math.max(1, Math.ceil(Math.abs(arc.theta) / (Math.PI / 8) - 1e-9));
    const step = arc.theta / pieces;
    const k = (4 / 3) * Math.tan(step / 4);
    for (let j = 0; j < pieces; j++) {
      const t0 = arc.a0 + step * j;
      const t1 = t0 + step;
      const x0 = j === 0 ? a.x : arc.cx + arc.r * Math.cos(t0);
      const y0 = j === 0 ? a.y : arc.cy + arc.r * Math.sin(t0);
      const x3 = arc.cx + arc.r * Math.cos(t1);
      const y3 = arc.cy + arc.r * Math.sin(t1);
      v.push({
        x: x0,
        y: y0,
        c: [x0 - k * arc.r * Math.sin(t0), y0 + k * arc.r * Math.cos(t0), x3 + k * arc.r * Math.sin(t1), y3 - k * arc.r * Math.cos(t1)],
      });
    }
  }
  const out: Part = { v };
  if (part.closed) out.closed = true;
  if (part.hole) out.hole = true;
  return out;
}

/** Elipse (o arco de elipse) como tramos Bézier de 22,5° como máximo. Parámetros en el sentido de `t` creciente. */
export function ellipseToVertices(cx: number, cy: number, ax: number, ay: number, bx: number, by: number, t0: number, t1: number): Vtx[] {
  const sweep = t1 - t0;
  const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 8) - 1e-9));
  const step = sweep / pieces;
  const k = (4 / 3) * Math.tan(step / 4);
  const pos = (t: number): Pt => ({ x: cx + ax * Math.cos(t) + bx * Math.sin(t), y: cy + ay * Math.cos(t) + by * Math.sin(t) });
  const der = (t: number): Pt => ({ x: -ax * Math.sin(t) + bx * Math.cos(t), y: -ay * Math.sin(t) + by * Math.cos(t) });
  const out: Vtx[] = [];
  for (let j = 0; j < pieces; j++) {
    const ta = t0 + step * j;
    const tb = ta + step;
    const p0 = pos(ta);
    const p3 = pos(tb);
    const d0 = der(ta);
    const d3 = der(tb);
    out.push({ x: p0.x, y: p0.y, c: [p0.x + k * d0.x, p0.y + k * d0.y, p3.x - k * d3.x, p3.y - k * d3.y] });
  }
  const end = pos(t1);
  out.push({ x: end.x, y: end.y });
  return out;
}
