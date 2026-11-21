/**
 * Área automática: región cerrada que contiene un punto, delimitada por los segmentos del plano (como el comando
 * BOUNDARY de AutoCAD).
 *
 * Los segmentos llegan sin preparar: se cruzan, se tocan en T, se solapan y sus extremos solo coinciden de forma
 * aproximada. Para una ventana alrededor del punto se construye el grafo plano de todo lo que pasa por ella:
 *   1. cada extremo se asigna al primer nodo creado a menos de eps (nunca se promedian coordenadas);
 *   2. una rejilla uniforme da los pares de segmentos vecinos y cada par aporta sus cortes: el extremo de uno sobre el
 *      otro (unión en T o solape colineal: el segmento se parte en ESE nodo) o, si no, el cruce propio de ambos;
 *   3. cada segmento se trocea por sus cortes, se descartan las aristas nulas o repetidas y las que salen de cada nodo
 *      se ordenan por ángulo.
 * La cara del punto se localiza con un rayo horizontal: el primer corte cuyo ciclo (recorrido dejando la cara a la
 * izquierda) tiene área positiva y encierra al punto es su contorno exterior; los ciclos de islas, mobiliario o
 * antenas que el rayo encuentra antes se descartan solos. Si ese ciclo no queda dentro de la ventana con holgura, la
 * ventana se duplica y se repite: lo que queda fuera de una ventana no puede tocar a un ciclo que está bien dentro.
 */

import { distToSegment, emptyBBox, extendBBox, pointInPolygon, polygonSignedArea, type BBox, type Pt } from './geometry';

export interface RegionOptions {
  /** Tolerancia geométrica en las unidades de las coordenadas: extremos más cercanos que esto son el mismo nodo; un punto más cercano que esto a un segmento está sobre él. */
  eps: number;
  /** Límites de toda la lámina; la búsqueda nunca sale de ellos. */
  bounds: BBox;
  /** Consulta espacial: índices de los segmentos cuya caja corta la caja dada (puede devolver de más). Si falta, se recorren todos. */
  query?: (minX: number, minY: number, maxX: number, maxY: number) => ArrayLike<number>;
  /** Filtro opcional: los segmentos para los que devuelve false se ignoran (capas ocultas). */
  accept?: (segIndex: number) => boolean;
  /** Semilado inicial de la ventana de búsqueda (por defecto, 1/16 del lado mayor de la lámina). Se duplica hasta que la región cierra dentro o la ventana cubre los límites. */
  startHalfSize?: number;
  /** Tope de segmentos considerados en una ventana (por defecto 60000). */
  maxSegments?: number;
  /** Cierre de huecos: si es > 0, dos extremos sueltos (nodos de grado 1) más cercanos que esto se unen con un tramo recto (vanos de puerta, dibujo descuidado). Por defecto 0. */
  gap?: number;
}

export type RegionResult =
  | { ok: true; outer: Pt[]; holes: Pt[][]; area: number; perimeter: number }
  | { ok: false; reason: 'open' | 'too-complex' | 'on-edge' };

/** Grafo plano de una ventana. La semiarista h va de tail[h] a tail[h ^ 1]; h >> 1 es su arista. */
interface Graph {
  x: number[];
  y: number[];
  tail: number[];
  /** Segmento del que procede cada arista. */
  src: number[];
  /** Semiaristas que salen del nodo v: adj[start[v] .. start[v + 1]), en sentido antihorario. */
  start: Int32Array;
  adj: Int32Array;
  /** Semiarista que sigue a cada una al recorrer una cara dejándola a la izquierda. */
  next: Int32Array;
}

/** Lazo simple de una cara: polígono, área con signo y caja. */
interface Ring {
  pts: Pt[];
  area: number;
  box: BBox;
}

const grow = (b: BBox, d: number): BBox => ({ minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d });

const inBox = (x: number, y: number, b: BBox): boolean => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;

const inRing = (p: Pt, r: Ring): boolean => inBox(p.x, p.y, r.box) && pointInPolygon(p, r.pts);

/** ¿Pasa el segmento por la caja? (recorte de Liang–Barsky; con coordenadas no finitas responde false). */
function touches(x1: number, y1: number, x2: number, y2: number, b: BBox): boolean {
  if (!(Math.max(x1, x2) >= b.minX && Math.min(x1, x2) <= b.maxX && Math.max(y1, y2) >= b.minY && Math.min(y1, y2) <= b.maxY)) return false;
  let t0 = 0;
  let t1 = 1;
  // Cada lado de la caja acota el parámetro del segmento: p·t ≤ q.
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    if (p < 0) t0 = Math.max(t0, q / p);
    else t1 = Math.min(t1, q / p);
    return t0 <= t1;
  };
  return clip(x1 - x2, x1 - b.minX) && clip(x2 - x1, b.maxX - x1) && clip(y1 - y2, y1 - b.minY) && clip(y2 - y1, b.maxY - y1);
}

/**
 * Nodos del grafo. Cada punto se asigna al primer nodo creado a menos de eps (hash espacial de paso eps) o crea uno
 * nuevo con sus coordenadas exactas: dos nodos distintos distan siempre eps o más y un mismo punto cae siempre en el
 * mismo nodo. No se encadenan fusiones: una fila de puntos muy juntos no se colapsa en uno solo.
 */
class Nodes {
  readonly x: number[] = [];
  readonly y: number[] = [];
  private readonly chain: number[] = [];
  private head = new Int32Array(1024).fill(-1);

  constructor(private readonly eps: number) {}

  private slot(cx: number, cy: number): number {
    return (Math.imul(cx | 0, 0x9e3779b1) ^ Math.imul(cy | 0, 0x85ebca6b)) & (this.head.length - 1);
  }

  private link(k: number): void {
    const s = this.slot(Math.floor(this.x[k] / this.eps), Math.floor(this.y[k] / this.eps));
    this.chain[k] = this.head[s];
    this.head[s] = k;
  }

  add(x: number, y: number): number {
    const cx = Math.floor(x / this.eps);
    const cy = Math.floor(y / this.eps);
    const e2 = this.eps * this.eps;
    let found = this.x.length;
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        for (let k = this.head[this.slot(i, j)]; k >= 0; k = this.chain[k]) {
          if (k < found && (this.x[k] - x) ** 2 + (this.y[k] - y) ** 2 < e2) found = k;
        }
      }
    }
    if (found < this.x.length) return found;
    this.x.push(x);
    this.y.push(y);
    if (this.x.length > this.head.length) {
      this.head = new Int32Array(this.head.length * 4).fill(-1);
      for (let k = 0; k < found; k++) this.link(k);
    }
    this.link(found);
    return found;
  }
}

/** Grafo plano de los segmentos dados (x1, y1, x2, y2 seguidos), completo dentro de la ventana `win`. */
function build(seg: ArrayLike<number>, win: BBox, eps: number): Graph {
  const n = seg.length >> 2;
  const nodes = new Nodes(eps);
  const { x, y } = nodes;
  const su = new Int32Array(n);
  const sv = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    su[i] = nodes.add(seg[4 * i], seg[4 * i + 1]);
    sv[i] = nodes.add(seg[4 * i + 2], seg[4 * i + 3]);
  }

  // Cortes: (segmento, nodo, parámetro a lo largo del segmento).
  const cutSeg: number[] = [];
  const cutNode: number[] = [];
  const cutT: number[] = [];
  const cut = (s: number, node: number, t: number): void => {
    cutSeg.push(s);
    cutNode.push(node);
    cutT.push(t);
  };
  const e2 = eps * eps;
  /** Extremo `node` de un segmento sobre el interior del segmento s (off: distancia a su recta × longitud). */
  const tee = (s: number, node: number, off: number, len2: number, dot: number): boolean => {
    if (off * off >= e2 * len2 || dot <= 0 || dot >= len2) return false;
    cut(s, node, dot / len2);
    return true;
  };
  const pair = (i: number, j: number): void => {
    const a = su[i];
    const b = sv[i];
    const c = su[j];
    const d = sv[j];
    const ax = x[a];
    const ay = y[a];
    const cx = x[c];
    const cy = y[c];
    const rx = x[b] - ax;
    const ry = y[b] - ay;
    const sx = x[d] - cx;
    const sy = y[d] - cy;
    if (Math.max(ax, ax + rx) + eps < Math.min(cx, cx + sx) || Math.max(cx, cx + sx) + eps < Math.min(ax, ax + rx)) return;
    if (Math.max(ay, ay + ry) + eps < Math.min(cy, cy + sy) || Math.max(cy, cy + sy) + eps < Math.min(ay, ay + ry)) return;
    const r2 = rx * rx + ry * ry;
    const s2 = sx * sx + sy * sy;
    // Distancia con signo (× longitud) de cada extremo a la recta del otro segmento.
    const d1 = rx * (cy - ay) - ry * (cx - ax);
    const d2 = rx * (cy + sy - ay) - ry * (cx + sx - ax);
    const d3 = sx * (ay - cy) - sy * (ax - cx);
    const d4 = sx * (ay + ry - cy) - sy * (ax + rx - cx);
    // Unión en T o tramo colineal: el segmento se parte en el nodo del extremo que tiene encima.
    let joined = a === c || a === d || b === c || b === d;
    if (c !== a && c !== b && tee(i, c, d1, r2, (cx - ax) * rx + (cy - ay) * ry)) joined = true;
    if (d !== a && d !== b && tee(i, d, d2, r2, (cx + sx - ax) * rx + (cy + sy - ay) * ry)) joined = true;
    if (a !== c && a !== d && tee(j, a, d3, s2, (ax - cx) * sx + (ay - cy) * sy)) joined = true;
    if (b !== c && b !== d && tee(j, b, d4, s2, (ax + rx - cx) * sx + (ay + ry - cy) * sy)) joined = true;
    if (joined || d1 > 0 === d2 > 0 || d3 > 0 === d4 > 0) return;
    // Cruce propio. Cada coordenada se toma del segmento que menos varía en ella: si es horizontal o vertical, sale exacta.
    const t = d3 / (d3 - d4);
    const u = d1 / (d1 - d2);
    const node = nodes.add(Math.abs(rx) <= Math.abs(sx) ? ax + t * rx : cx + u * sx, Math.abs(ry) <= Math.abs(sy) ? ay + t * ry : cy + u * sy);
    cut(i, node, t);
    cut(j, node, u);
  };

  // Rejilla uniforme sobre la ventana. Cada segmento, ensanchado eps, se recorre por su eje mayor y se compara una
  // sola vez con los segmentos anteriores que pisan alguna de sus celdas.
  const w = win.maxX - win.minX;
  const h = win.maxY - win.minY;
  const cell = Math.max(Math.sqrt((w * h) / (2 * n + 1)), Math.max(w, h) / 2048, 4 * eps);
  const cols = Math.max(1, Math.ceil(w / cell));
  const rows = Math.max(1, Math.ceil(h / cell));
  const cells: number[] = [];
  const first = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    if (su[i] !== sv[i]) {
      const steep = Math.abs(y[sv[i]] - y[su[i]]) > Math.abs(x[sv[i]] - x[su[i]]);
      // (a, b): coordenadas sobre el eje mayor y el menor del segmento.
      const a0 = steep ? y[su[i]] : x[su[i]];
      const b0 = steep ? x[su[i]] : y[su[i]];
      const da = (steep ? y[sv[i]] : x[sv[i]]) - a0;
      const db = (steep ? x[sv[i]] : y[sv[i]]) - b0;
      const oa = steep ? win.minY : win.minX;
      const ob = steep ? win.minX : win.minY;
      const ia1 = Math.min((steep ? rows : cols) - 1, Math.floor((Math.max(a0, a0 + da) + eps - oa) / cell));
      for (let ia = Math.max(0, Math.floor((Math.min(a0, a0 + da) - eps - oa) / cell)); ia <= ia1; ia++) {
        const ta = Math.min(1, Math.max(0, (oa + ia * cell - eps - a0) / da));
        const tb = Math.min(1, Math.max(0, (oa + (ia + 1) * cell + eps - a0) / da));
        const ib1 = Math.min((steep ? cols : rows) - 1, Math.floor((b0 + Math.max(ta * db, tb * db) + eps - ob) / cell));
        for (let ib = Math.max(0, Math.floor((b0 + Math.min(ta * db, tb * db) - eps - ob) / cell)); ib <= ib1; ib++) {
          cells.push(steep ? ia * cols + ib : ib * cols + ia);
        }
      }
    }
    first[i + 1] = cells.length;
  }
  const from = new Int32Array(cols * rows + 1);
  for (let k = 0; k < cells.length; k++) from[cells[k] + 1]++;
  for (let c = 0; c < cols * rows; c++) from[c + 1] += from[c];
  const fill = from.slice();
  const inCell = new Int32Array(cells.length);
  const paired = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let k = first[i]; k < first[i + 1]; k++) {
      const c = cells[k];
      for (let q = from[c]; q < fill[c]; q++) {
        const j = inCell[q];
        if (paired[j] !== i) {
          paired[j] = i;
          pair(j, i);
        }
      }
      inCell[fill[c]++] = i;
    }
  }

  // Aristas: cada segmento, de corte en corte; sin aristas nulas ni repetidas (los tramos solapados colapsan en uno).
  const cutFrom = new Int32Array(n + 1);
  for (let k = 0; k < cutSeg.length; k++) cutFrom[cutSeg[k] + 1]++;
  for (let i = 0; i < n; i++) cutFrom[i + 1] += cutFrom[i];
  const cutFill = cutFrom.slice();
  const order = new Int32Array(cutSeg.length);
  for (let k = 0; k < cutSeg.length; k++) order[cutFill[cutSeg[k]]++] = k;
  const tail: number[] = [];
  const src: number[] = [];
  const seen = new Set<number>();
  const edge = (u: number, v: number, s: number): void => {
    const key = u < v ? u * x.length + v : v * x.length + u;
    if (u === v || seen.has(key)) return;
    seen.add(key);
    tail.push(u, v);
    src.push(s);
  };
  for (let i = 0; i < n; i++) {
    const cuts = order.subarray(cutFrom[i], cutFrom[i + 1]);
    if (cuts.length > 1) cuts.sort((p, q) => cutT[p] - cutT[q]);
    let u = su[i];
    for (let k = 0; k < cuts.length; k++) {
      edge(u, cutNode[cuts[k]], i);
      u = cutNode[cuts[k]];
    }
    edge(u, sv[i], i);
  }

  // Semiaristas de cada nodo en orden angular y sucesor de cada una en el recorrido de caras: al llegar a un nodo
  // se sale por la semiarista anterior (en sentido horario) a la de vuelta.
  const start = new Int32Array(x.length + 1);
  for (let k = 0; k < tail.length; k++) start[tail[k] + 1]++;
  for (let v = 0; v < x.length; v++) start[v + 1] += start[v];
  const put = start.slice();
  const adj = new Int32Array(tail.length);
  const angle = new Float64Array(tail.length);
  for (let k = 0; k < tail.length; k++) {
    angle[k] = Math.atan2(y[tail[k ^ 1]] - y[tail[k]], x[tail[k ^ 1]] - x[tail[k]]);
    adj[put[tail[k]]++] = k;
  }
  const next = new Int32Array(tail.length);
  for (let v = 0; v < x.length; v++) {
    for (let k = start[v] + 1; k < start[v + 1]; k++) {
      const e = adj[k];
      let q = k;
      for (; q > start[v] && angle[adj[q - 1]] > angle[e]; q--) adj[q] = adj[q - 1];
      adj[q] = e;
    }
    for (let k = start[v]; k < start[v + 1]; k++) next[adj[k] ^ 1] = adj[k > start[v] ? k - 1 : start[v + 1] - 1];
  }
  return { x, y, tail, src, start, adj, next };
}
