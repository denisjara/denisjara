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
  /**
   * Cierre de vanos: si es > 0, dos tramos alineados cuyos extremos enfrentados distan menos que esto se unen con un
   * tramo recto (la cara de un muro interrumpida por una puerta). Por defecto 0: se mide solo lo que está dibujado.
   */
  bridge?: number;
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

// ---------------------------------------------------------------------------
// Cierre de vanos
// ---------------------------------------------------------------------------

/**
 * Tramos que cierran los huecos entre segmentos alineados: para cada extremo E de un segmento se busca, siguiendo su
 * misma recta hacia fuera y a menos de `maxGap`, el extremo más cercano de otro segmento que continúe esa recta.
 * Devuelve los tramos nuevos (x1, y1, x2, y2 seguidos), con las coordenadas exactas de los extremos que unen.
 */
function bridgeGaps(seg: number[], maxGap: number, eps: number): number[] {
  const n = seg.length >> 2;
  // Rejilla de extremos con celdas del tamaño del hueco máximo: los candidatos están en las 9 celdas vecinas.
  const cells = new Map<number, number[]>();
  const key = (cx: number, cy: number): number => cx * 73856093 + cy * 19349663;
  for (let e = 0; e < 2 * n; e++) {
    const k = key(Math.floor(seg[2 * e] / maxGap), Math.floor(seg[2 * e + 1] / maxGap));
    const list = cells.get(k);
    if (list) list.push(e);
    else cells.set(k, [e]);
  }
  const out: number[] = [];
  const done = new Set<number>();
  for (let e = 0; e < 2 * n; e++) {
    const o = e ^ 1; // el otro extremo del mismo segmento
    const ex = seg[2 * e];
    const ey = seg[2 * e + 1];
    let dx = ex - seg[2 * o];
    let dy = ey - seg[2 * o + 1];
    const len = Math.hypot(dx, dy);
    if (!(len > eps)) continue;
    dx /= len;
    dy /= len;
    let best = -1;
    let bestAlong = maxGap;
    const cx = Math.floor(ex / maxGap);
    const cy = Math.floor(ey / maxGap);
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        const list = cells.get(key(i, j));
        if (!list) continue;
        for (const f of list) {
          if (f >> 1 === e >> 1) continue;
          const wx = seg[2 * f] - ex;
          const wy = seg[2 * f + 1] - ey;
          const along = wx * dx + wy * dy;
          if (along <= eps || along >= bestAlong || Math.abs(dx * wy - dy * wx) > eps) continue;
          // El otro segmento tiene que seguir la misma recta y alejarse: su extremo lejano queda más allá.
          const h = f ^ 1;
          const hx = seg[2 * h] - ex;
          const hy = seg[2 * h + 1] - ey;
          if (hx * dx + hy * dy <= along + eps || Math.abs(dx * hy - dy * hx) > 2 * eps) continue;
          best = f;
          bestAlong = along;
        }
      }
    }
    if (best < 0) continue;
    const id = e < best ? e * 2 * n + best : best * 2 * n + e;
    if (done.has(id)) continue;
    done.add(id);
    out.push(ex, ey, seg[2 * best], seg[2 * best + 1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ciclos
// ---------------------------------------------------------------------------

/** Nodos del ciclo de la semiarista h0 (la cola de cada semiarista, en orden). Marca las semiaristas recorridas. */
function cycleOf(g: Graph, h0: number, seen?: Uint8Array): number[] {
  const out: number[] = [];
  let h = h0;
  do {
    out.push(g.tail[h]);
    if (seen) seen[h] = 1;
    h = g.next[h];
  } while (h !== h0 && out.length <= g.tail.length);
  return out;
}

function signedArea(g: Graph, nodes: number[]): number {
  let a = 0;
  for (let i = 0, j = nodes.length - 1; i < nodes.length; j = i++) a += g.x[nodes[j]] * g.y[nodes[i]] - g.x[nodes[i]] * g.y[nodes[j]];
  return a / 2;
}

function ringOf(g: Graph, nodes: number[]): Ring {
  const box = emptyBBox();
  const pts = nodes.map((n) => {
    extendBBox(box, g.x[n], g.y[n]);
    return { x: g.x[n], y: g.y[n] };
  });
  return { pts, area: polygonSignedArea(pts), box };
}

/**
 * Deja el ciclo como polígono simple: quita las antenas (tramos recorridos de ida y vuelta: una línea que entra en el
 * recinto sin cerrarlo) y los vértices intermedios de tramos exactamente alineados. Los vértices que quedan son los
 * nodos originales, sin tocar sus coordenadas.
 */
function simplify(g: Graph, cycle: number[]): Pt[] {
  const st: number[] = [];
  for (const n of cycle) {
    if (st.length >= 2 && st[st.length - 2] === n) st.pop();
    else st.push(n);
  }
  // El ciclo es circular: una antena puede quedar partida entre el final y el principio de la lista.
  for (let changed = true; changed && st.length >= 3; ) {
    changed = false;
    if (st[st.length - 1] === st[1]) {
      st.shift();
      st.pop();
      changed = true;
    } else if (st[st.length - 2] === st[0]) {
      st.pop();
      st.pop();
      changed = true;
    }
  }
  if (st.length < 3) return [];
  // Vértices alineados (con la tolerancia del redondeo en coma flotante, no con eps: una curva teselada no se aplana).
  const keep: number[] = [];
  const n = st.length;
  for (let i = 0; i < n; i++) {
    const a = st[(i + n - 1) % n];
    const b = st[i];
    const c = st[(i + 1) % n];
    const ux = g.x[b] - g.x[a];
    const uy = g.y[b] - g.y[a];
    const vx = g.x[c] - g.x[b];
    const vy = g.y[c] - g.y[b];
    const straight = Math.abs(ux * vy - uy * vx) <= 1e-12 * Math.hypot(ux, uy) * Math.hypot(vx, vy) && ux * vx + uy * vy > 0;
    if (!straight) keep.push(b);
  }
  return keep.map((k) => ({ x: g.x[k], y: g.y[k] }));
}

const perimeterOf = (pts: Pt[]): number => {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
  return s;
};

// ---------------------------------------------------------------------------
// Localización de la cara
// ---------------------------------------------------------------------------

/** Direcciones del rayo: si una pasa demasiado cerca de un nodo (cruce ambiguo) se prueba la siguiente. */
const RAY_ANGLES = [0.0137, 0.7411, 1.9173, 2.6331, 3.7019, 4.4213, 5.3407, 1.2289];

/**
 * Contorno exterior de la cara que contiene a p: semiarista de partida de su ciclo, o −1 si la cara no está cerrada
 * en este grafo. `strict`: si un cruce cae junto a un nodo antes de encontrar el contorno devuelve null (reintentar).
 */
function locate(g: Graph, p: Pt, eps: number, angle: number, strict: boolean): { h: number; cycle: number[] } | -1 | null {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const hits: { t: number; h: number; near: boolean }[] = [];
  for (let h = 0; h < g.tail.length; h += 2) {
    const u = g.tail[h];
    const v = g.tail[h + 1];
    const ex = g.x[v] - g.x[u];
    const ey = g.y[v] - g.y[u];
    const den = dx * ey - dy * ex;
    const len = Math.hypot(ex, ey);
    if (Math.abs(den) <= 1e-14 * len) continue;
    const qx = g.x[u] - p.x;
    const qy = g.y[u] - p.y;
    const t = (qx * ey - qy * ex) / den;
    if (!(t > 0)) continue;
    const s = (qx * dy - qy * dx) / den;
    const d = Math.min(s, 1 - s) * len;
    if (d < -eps) continue;
    // La semiarista que deja a p a su izquierda: su cara es la que el rayo recorre justo antes del cruce.
    const left = ex * (p.y - g.y[u]) - ey * (p.x - g.x[u]) > 0;
    hits.push({ t, h: left ? h : h + 1, near: d < eps });
  }
  hits.sort((a, b) => a.t - b.t);
  for (const hit of hits) {
    if (hit.near) {
      if (strict) return null;
      continue;
    }
    const cycle = cycleOf(g, hit.h);
    // El primer ciclo de área positiva que encierra a p es el contorno exterior de su cara; los anteriores son islas
    // (área negativa), el interior de esas islas (no encierran a p) o antenas (área nula).
    if (signedArea(g, cycle) > 0 && inRing(p, ringOf(g, cycle))) return { h: hit.h, cycle };
  }
  return -1;
}

/** Islas de la cara: contorno exterior de cada componente del grafo que queda dentro y no toca el contorno. */
function islands(g: Graph, outer: number[], outerRing: Ring, eps: number): Pt[][] {
  const parent = new Int32Array(g.x.length).map((_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  for (let h = 0; h < g.tail.length; h += 2) {
    const a = find(g.tail[h]);
    const b = find(g.tail[h + 1]);
    if (a !== b) parent[a] = b;
  }
  const main = find(outer[0]);
  const seen = new Uint8Array(g.tail.length);
  // Por componente: su ciclo de área más negativa, que es su contorno visto desde fuera.
  const best = new Map<number, { area: number; cycle: number[] }>();
  for (let h = 0; h < g.tail.length; h++) {
    if (seen[h]) continue;
    const comp = find(g.tail[h]);
    if (comp === main) {
      seen[h] = 1;
      continue;
    }
    if (!inRing({ x: g.x[g.tail[h]], y: g.y[g.tail[h]] }, outerRing)) {
      seen[h] = 1;
      continue;
    }
    const cycle = cycleOf(g, h, seen);
    const area = signedArea(g, cycle);
    const cur = best.get(comp);
    if (!cur || area < cur.area) best.set(comp, { area, cycle });
  }
  const rings: Ring[] = [];
  for (const { area, cycle } of best.values()) {
    if (!(area < -eps * eps)) continue;
    const pts = simplify(g, cycle);
    if (pts.length >= 3) rings.push({ pts, area: polygonSignedArea(pts), box: ringOf(g, cycle).box });
  }
  // Una isla dentro de otra isla no pertenece a esta cara.
  return rings.filter((r) => !rings.some((o) => o !== r && Math.abs(o.area) > Math.abs(r.area) && inRing(r.pts[0], o))).map((r) => r.pts);
}

/**
 * Cara del plano que contiene a p. segs: x1, y1, x2, y2 por segmento.
 *  - outer: contorno exterior como polígono simple (sin repetir el primer punto), con área con signo positiva,
 *    sin antenas y con los vértices alineados fundidos; sus vértices son extremos originales o cruces calculados.
 *  - holes: contorno de cada isla que queda dentro (área con signo negativa). No se restan de `area`.
 *  - 'open': la cara no cierra dentro de los límites; 'on-edge': p está sobre un segmento; 'too-complex': demasiados
 *    segmentos en la ventana de búsqueda.
 */
export function findRegion(segs: Float64Array, p: Pt, opts: RegionOptions): RegionResult {
  const { eps, bounds } = opts;
  const total = segs.length >> 2;
  const maxSegments = opts.maxSegments ?? 60000;
  const full = grow(bounds, 4 * eps);
  if (!inBox(p.x, p.y, full) || !Number.isFinite(p.x + p.y)) return { ok: false, reason: 'open' };
  let half = opts.startHalfSize ?? Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 16;
  if (!(half > 0)) half = 1;
  for (;;) {
    const win: BBox = { minX: Math.max(full.minX, p.x - half), minY: Math.max(full.minY, p.y - half), maxX: Math.min(full.maxX, p.x + half), maxY: Math.min(full.maxY, p.y + half) };
    const covers = win.minX <= full.minX && win.minY <= full.minY && win.maxX >= full.maxX && win.maxY >= full.maxY;
    const cand = opts.query ? opts.query(win.minX, win.minY, win.maxX, win.maxY) : null;
    const count = cand ? cand.length : total;
    const picked: number[] = [];
    for (let k = 0; k < count; k++) {
      const i = cand ? cand[k] : k;
      if (opts.accept && !opts.accept(i)) continue;
      const x1 = segs[4 * i];
      const y1 = segs[4 * i + 1];
      const x2 = segs[4 * i + 2];
      const y2 = segs[4 * i + 3];
      if (!touches(x1, y1, x2, y2, win)) continue;
      if (distToSegment(p, { x: x1, y: y1 }, { x: x2, y: y2 }) < eps) return { ok: false, reason: 'on-edge' };
      picked.push(x1, y1, x2, y2);
      if (picked.length > 4 * maxSegments) return { ok: false, reason: 'too-complex' };
    }
    if (picked.length >= 12) {
      if (opts.bridge && opts.bridge > eps) for (const v of bridgeGaps(picked, opts.bridge, eps)) picked.push(v);
      const g = build(picked, win, eps);
      let found: ReturnType<typeof locate> = null;
      for (let k = 0; k < RAY_ANGLES.length && found === null; k++) found = locate(g, p, eps, RAY_ANGLES[k], true);
      if (found === null) found = locate(g, p, eps, RAY_ANGLES[0], false);
      if (found !== null && found !== -1) {
        const ring = ringOf(g, found.cycle);
        // Un ciclo bien dentro de la ventana es definitivo: nada de lo que queda fuera puede tocarlo.
        const m = Math.max(4 * eps, half * 1e-6);
        const inside = ring.box.minX > win.minX + m && ring.box.minY > win.minY + m && ring.box.maxX < win.maxX - m && ring.box.maxY < win.maxY - m;
        if (inside || covers) {
          const outer = simplify(g, found.cycle);
          if (outer.length < 3) return { ok: false, reason: 'open' };
          return { ok: true, outer, holes: islands(g, found.cycle, ring, eps), area: Math.abs(polygonSignedArea(outer)), perimeter: perimeterOf(outer) };
        }
      }
    }
    if (covers) return { ok: false, reason: 'open' };
    half *= 2;
  }
}
