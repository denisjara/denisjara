/**
 * Lector de DXF (ASCII) sin dependencias.
 *
 * Entrega la geometría del espacio modelo en coordenadas del mundo, con los bloques expandidos y los colores y
 * capas resueltos (ver types.ts). La geometría se conserva exacta: rectas y arcos tal cual (arcos como "bulge"),
 * elipses y splines como curvas Bézier (las splines no racionales de grado ≤ 3 se convierten sin error; el resto
 * se muestrea muy fino). Nada se tesela aquí.
 *
 * Un DXF es una lista de pares (código de grupo, valor). Cada entidad se lee primero en bruto (sus pares, en orden)
 * y después se interpreta; los bloques se guardan interpretados y se expanden en cada inserción con su matriz.
 */
import { arcToVertices, ellipseToVertices, emptyBBox, extendBBox, IDENTITY, matApply, matMul, partBBox, transformPart, type BBox, type Mat, type Part, type Vtx } from '../../core/geometry';
import { ACI, rgbToHex } from './aci';
import type { DxfDrawing, DxfInsert, DxfLayer, DxfPath, DxfText, ParseDxfOptions } from './types';

const DEG = Math.PI / 180;
const MAX_DEPTH = 16;
const MAX_PATHS = 4_000_000;

// ---------------------------------------------------------------------------
// Texto de entrada y pares (código, valor)
// ---------------------------------------------------------------------------

function decode(input: string | Uint8Array | ArrayBuffer): string {
  if (typeof input === 'string') return input;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const magic = 'AutoCAD Binary DXF';
  let binary = bytes.length >= magic.length;
  for (let i = 0; binary && i < magic.length; i++) binary = bytes[i] === magic.charCodeAt(i);
  if (binary) throw new Error('DXF binario: guarda el plano como DXF ASCII desde AutoCAD (Guardar como → DXF).');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Los DXF anteriores a AutoCAD 2007 usan la página de códigos de Windows (en español, la 1252).
    try {
      return new TextDecoder('windows-1252').decode(bytes);
    } catch {
      return new TextDecoder('iso-8859-1').decode(bytes);
    }
  }
}

/** Recorre el archivo par a par sin partirlo en líneas (un DXF grande tiene decenas de millones). */
class Reader {
  pos = 0;
  code = -1;
  value = '';
  constructor(readonly text: string) {}

  private line(): string | null {
    const t = this.text;
    if (this.pos >= t.length) return null;
    let end = t.indexOf('\n', this.pos);
    if (end < 0) end = t.length;
    const stop = end > this.pos && t.charCodeAt(end - 1) === 13 ? end - 1 : end;
    const s = t.slice(this.pos, stop);
    this.pos = end + 1;
    return s;
  }

  next(): boolean {
    const c = this.line();
    if (c === null) return false;
    const v = this.line();
    if (v === null) return false;
    const code = parseInt(c, 10);
    this.code = Number.isNaN(code) ? -1 : code;
    this.value = v;
    return true;
  }
}

/** Una entidad en bruto: su tipo y sus pares en el orden del archivo. */
interface Raw {
  type: string;
  c: number[];
  v: string[];
}

/** Lee los pares de la entidad actual; deja el lector en el siguiente código 0 (o al final). */
function readRaw(r: Reader, type: string): Raw {
  const raw: Raw = { type, c: [], v: [] };
  while (r.next() && r.code !== 0) {
    raw.c.push(r.code);
    raw.v.push(r.value);
  }
  return raw;
}

const num = (raw: Raw, code: number, fallback = 0): number => {
  const i = raw.c.indexOf(code);
  if (i < 0) return fallback;
  const n = parseFloat(raw.v[i]);
  return Number.isFinite(n) ? n : fallback;
};
const has = (raw: Raw, code: number): boolean => raw.c.indexOf(code) >= 0;
const str = (raw: Raw, code: number, fallback = ''): string => {
  const i = raw.c.indexOf(code);
  return i < 0 ? fallback : raw.v[i].trim();
};

/** \U+00D1 → Ñ (los DXF antiguos escriben así lo que no cabe en su página de códigos). */
const unescapeUnicode = (s: string): string => (s.indexOf('\\') < 0 ? s : s.replace(/\\[Uu]\+([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/\\M\+\d[0-9a-fA-F]{4}/g, ''));

/** Códigos de control de TEXT: %%c diámetro, %%d grado, %%p más/menos, %%nnn carácter, %%u / %%o subrayados. */
function plainText(s: string): string {
  let out = unescapeUnicode(s);
  if (out.indexOf('%%') >= 0) {
    out = out
      .replace(/%%[cC]/g, 'Ø')
      .replace(/%%[dD]/g, '°')
      .replace(/%%[pP]/g, '±')
      .replace(/%%[uUoOkK]/g, '')
      .replace(/%%(\d{3})/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
      .replace(/%%%/g, '%');
  }
  return out;
}

/** Texto de MTEXT sin sus códigos de formato. */
export function cleanMText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      const n = s[i + 1];
      if (n === undefined) break;
      if (n === 'P' || n === 'X') {
        out += '\n';
        i++;
      } else if (n === '~') {
        out += ' ';
        i++;
      } else if (n === '\\' || n === '{' || n === '}') {
        out += n;
        i++;
      } else if (n === 'S') {
        // Apilado: \Sa^b; o \Sa/b; o \Sa#b;
        const end = s.indexOf(';', i);
        const body = end < 0 ? s.slice(i + 2) : s.slice(i + 2, end);
        out += body.replace(/\^ ?|#/g, '/');
        i = end < 0 ? s.length : end;
      } else if ('fFHCcTQWAp'.includes(n)) {
        // Códigos con argumento hasta el punto y coma: tipografía, altura, color, interletra, inclinación, ancho, alineación…
        const end = s.indexOf(';', i);
        i = end < 0 ? s.length : end;
      } else if ('LlOoKk'.includes(n)) {
        i++;
      } else if (n === 'U' && s[i + 2] === '+') {
        out += String.fromCharCode(parseInt(s.slice(i + 3, i + 7), 16) || 63);
        i += 6;
      } else {
        out += n;
        i++;
      }
    } else if (ch === '{' || ch === '}') {
      continue;
    } else out += ch;
  }
  return plainText(out)
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Sistema de coordenadas del objeto (OCS) y matrices
// ---------------------------------------------------------------------------

/** Matriz que lleva las coordenadas (x, y) del OCS de una entidad —con elevación z— al plano XY del mundo. */
function ocsMatrix(raw: Raw, z = 0): Mat {
  if (!has(raw, 230) && !has(raw, 210) && !has(raw, 220)) return IDENTITY;
  let nx = num(raw, 210, 0);
  let ny = num(raw, 220, 0);
  let nz = num(raw, 230, 1);
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 0)) return IDENTITY;
  nx /= len;
  ny /= len;
  nz /= len;
  if (nx === 0 && ny === 0 && nz > 0) return IDENTITY;
  // Algoritmo del eje arbitrario de AutoCAD.
  let ax: [number, number, number] = Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64 ? [nz, 0, -nx] : [-ny, nx, 0];
  const al = Math.hypot(ax[0], ax[1], ax[2]);
  ax = [ax[0] / al, ax[1] / al, ax[2] / al];
  const ay: [number, number, number] = [ny * ax[2] - nz * ax[1], nz * ax[0] - nx * ax[2], nx * ax[1] - ny * ax[0]];
  return [ax[0], ax[1], ay[0], ay[1], z * nx, z * ny];
}

const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
const rotate = (a: number): Mat => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
const scaleMat = (sx: number, sy: number): Mat => [sx, 0, 0, sy, 0, 0];

// ---------------------------------------------------------------------------
// Entidades interpretadas (en las coordenadas de su bloque o del espacio modelo)
// ---------------------------------------------------------------------------

interface Common {
  layer: string;
  /** 256 PorCapa, 0 PorBloque, 1–255 índice. */
  aci: number;
  /** Color verdadero (0xRRGGBB), si lo tiene. */
  rgb: number;
  ltype: string;
}

interface PathEnt extends Common {
  k: 'path';
  part: Part;
  src: string;
  fill?: boolean;
  hatch?: number;
  width?: number;
}

interface TextEnt extends Common {
  k: 'text';
  x: number;
  y: number;
  h: number;
  rot: number;
  text: string;
  halign: DxfText['halign'];
  valign: DxfText['valign'];
  wf: number;
  src: string;
  /** ATTRIB: etiqueta del atributo. */
  tag?: string;
  hidden?: boolean;
}

interface InsertEnt extends Common {
  k: 'insert';
  name: string;
  /** Matriz del bloque (sin el punto base, que se aplica al expandir) para la celda (0, 0). */
  m: Mat;
  cols: number;
  rows: number;
  dx: number;
  dy: number;
  /** Giro y OCS de la inserción, para desplazar las celdas de una matriz de bloques. */
  frame: Mat;
  attribs: TextEnt[];
  /** DIMENSION y ACAD_TABLE: su bloque anónimo ya está en coordenadas del mundo. */
  anonymous?: boolean;
}

type Ent = PathEnt | TextEnt | InsertEnt;

interface Block {
  name: string;
  bx: number;
  by: number;
  ents: Ent[];
}

const common = (raw: Raw): Common => ({ layer: unescapeUnicode(str(raw, 8, '0')) || '0', aci: has(raw, 62) ? Math.abs(Math.trunc(num(raw, 62, 256))) : 256, rgb: has(raw, 420) ? Math.trunc(num(raw, 420, -1)) : -1, ltype: str(raw, 6, 'BYLAYER') });

const finite = (part: Part): boolean => part.v.every((p) => Number.isFinite(p.x + p.y + (p.b ?? 0)) && (!p.c || Number.isFinite(p.c[0] + p.c[1] + p.c[2] + p.c[3])));

/** Trazo en OCS → entidad en las coordenadas de su contenedor. */
function pathEnt(raw: Raw, part: Part, src: string, m: Mat = IDENTITY, extra: Partial<PathEnt> = {}): PathEnt | null {
  if (part.v.length < 2 || !finite(part)) return null;
  return { k: 'path', ...common(raw), part: m === IDENTITY ? part : transformPart(part, m), src, ...extra };
}

function circlePart(cx: number, cy: number, r: number): Part {
  const v = arcToVertices(cx, cy, r, 0, 2 * Math.PI);
  v.pop();
  return { v, closed: true };
}

/** Ángulo barrido en sentido antihorario de `from` a `to` (grados), en (0, 2π]. */
function ccwSweep(fromDeg: number, toDeg: number): number {
  let d = (toDeg - fromDeg) % 360;
  if (d <= 0) d += 360;
  return d * DEG;
}

/** Si el trazo vuelve a su punto inicial, lo marca como cerrado y quita el vértice repetido. */
function closeIfLoop(part: Part): Part {
  const v = part.v;
  if (part.closed || v.length < 3) return part;
  const a = v[0];
  const z = v[v.length - 1];
  const span = Math.max(Math.abs(a.x), Math.abs(a.y), 1);
  if (Math.abs(a.x - z.x) > 1e-9 * span || Math.abs(a.y - z.y) > 1e-9 * span) return part;
  return { v: v.slice(0, -1), closed: true };
}

// ---------------------------------------------------------------------------
// Splines
// ---------------------------------------------------------------------------

/**
 * Valor de la "flor" (blossom) de una B-spline en el tramo k para los argumentos dados: con todos iguales es el
 * punto de la curva; con (a…a, b…b) da los puntos de control Bézier del tramo [a, b]. Coordenadas homogéneas (x, y, w).
 */
function blossom(deg: number, knots: number[], ctrl: number[][], k: number, args: number[]): number[] {
  const d: number[][] = [];
  for (let i = 0; i <= deg; i++) d.push(ctrl[k - deg + i].slice());
  for (let r = 1; r <= deg; r++) {
    const t = args[r - 1];
    for (let i = deg; i >= r; i--) {
      const idx = k - deg + i;
      const den = knots[idx + deg - r + 1] - knots[idx];
      const a = den === 0 ? 0 : (t - knots[idx]) / den;
      for (let c = 0; c < 3; c++) d[i][c] = (1 - a) * d[i - 1][c] + a * d[i][c];
    }
  }
  return d[deg];
}

/** Spline (NURBS) → vértices. Exacta como Bézier si no es racional y su grado es ≤ 3; si no, muestreada fina. */
export function splineVertices(degree: number, knots: number[], points: [number, number][], weights: number[]): Vtx[] {
  const n = points.length;
  const deg = Math.max(1, Math.min(degree, n - 1));
  if (n < 2) return [];
  if (knots.length !== n + deg + 1) {
    // Sin nudos válidos: nudos uniformes con extremos fijos.
    knots = [];
    for (let i = 0; i < n + deg + 1; i++) knots.push(Math.max(0, Math.min(n - deg, i - deg)));
  }
  const rational = weights.length === n && weights.some((w) => Math.abs(w - weights[0]) > 1e-12);
  const ctrl = points.map((p, i) => {
    const w = rational ? weights[i] : 1;
    return [p[0] * w, p[1] * w, w];
  });
  const out: Vtx[] = [];
  const pt = (h: number[]): [number, number] => [h[0] / h[2], h[1] / h[2]];
  for (let k = deg; k < n; k++) {
    const a = knots[k];
    const b = knots[k + 1];
    if (!(b > a)) continue;
    if (!rational && deg <= 3) {
      const q: [number, number][] = [];
      for (let j = 0; j <= deg; j++) {
        const args: number[] = [];
        for (let i = 0; i < deg; i++) args.push(i < deg - j ? a : b);
        q.push(pt(blossom(deg, knots, ctrl, k, args)));
      }
      if (out.length === 0) out.push({ x: q[0][0], y: q[0][1] });
      const last = out[out.length - 1];
      const end = q[deg];
      if (deg === 3) last.c = [q[1][0], q[1][1], q[2][0], q[2][1]];
      else if (deg === 2) last.c = [q[0][0] + (2 / 3) * (q[1][0] - q[0][0]), q[0][1] + (2 / 3) * (q[1][1] - q[0][1]), end[0] + (2 / 3) * (q[1][0] - end[0]), end[1] + (2 / 3) * (q[1][1] - end[1])];
      out.push({ x: end[0], y: end[1] });
    } else {
      const steps = 256;
      for (let s = out.length === 0 ? 0 : 1; s <= steps; s++) {
        const t = s === steps ? b : a + ((b - a) * s) / steps;
        // En el extremo derecho del tramo se evalúa por la flor del propio tramo (continua por la izquierda).
        const p = pt(blossom(deg, knots, ctrl, k, new Array<number>(deg).fill(t)));
        out.push({ x: p[0], y: p[1] });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Interpretación de cada tipo de entidad
// ---------------------------------------------------------------------------

function lwpolyline(raw: Raw): PathEnt | null {
  const v: Vtx[] = [];
  let cur: Vtx | null = null;
  for (let i = 0; i < raw.c.length; i++) {
    const code = raw.c[i];
    if (code === 10) {
      cur = { x: parseFloat(raw.v[i]), y: 0 };
      v.push(cur);
    } else if (code === 20 && cur) cur.y = parseFloat(raw.v[i]);
    else if (code === 42 && cur) {
      const b = parseFloat(raw.v[i]);
      if (b !== 0 && Number.isFinite(b)) cur.b = b;
    }
  }
  const closed = (Math.trunc(num(raw, 70)) & 1) === 1 && v.length > 2;
  if (!closed && v.length) delete v[v.length - 1].b;
  const width = num(raw, 43);
  return pathEnt(raw, closed ? { v, closed: true } : { v }, 'LWPOLYLINE', ocsMatrix(raw, num(raw, 38)), width > 0 ? { width } : {});
}

function polyline(raw: Raw, vertices: Raw[]): PathEnt | null {
  const flags = Math.trunc(num(raw, 70));
  if (flags & (16 | 64)) return null; // mallas: no son trazos
  const v: Vtx[] = [];
  for (const vr of vertices) {
    const vf = Math.trunc(num(vr, 70));
    if (vf & 16 || (vf & 128 && !(vf & 64))) continue; // puntos de control de una curva ajustada / caras
    const p: Vtx = { x: num(vr, 10), y: num(vr, 20) };
    const b = num(vr, 42);
    if (b !== 0 && !(flags & 8)) p.b = b;
    v.push(p);
  }
  const closed = (flags & 1) === 1 && v.length > 2;
  if (!closed && v.length) delete v[v.length - 1].b;
  const width = num(raw, 40) > 0 && num(raw, 40) === num(raw, 41) ? num(raw, 40) : 0;
  // Las polilíneas 3D van en coordenadas del mundo; las 2D, en su OCS.
  return pathEnt(raw, closed ? { v, closed: true } : { v }, 'POLYLINE', flags & 8 ? IDENTITY : ocsMatrix(raw, num(raw, 30)), width > 0 ? { width } : {});
}

function ellipse(raw: Raw): PathEnt | null {
  const mx = num(raw, 11);
  const my = num(raw, 21);
  const mz = num(raw, 31);
  const ratio = num(raw, 40, 1);
  let nx = num(raw, 210, 0);
  let ny = num(raw, 220, 0);
  let nz = num(raw, 230, 1);
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  // Semieje menor = normal × semieje mayor × relación (se proyecta en XY).
  const bx = (ny * mz - nz * my) * ratio;
  const by = (nz * mx - nx * mz) * ratio;
  const t0 = num(raw, 41, 0);
  let t1 = num(raw, 42, 2 * Math.PI);
  if (t1 <= t0) t1 += 2 * Math.PI;
  const full = Math.abs(t1 - t0 - 2 * Math.PI) < 1e-9;
  const v = ellipseToVertices(num(raw, 10), num(raw, 20), mx, my, bx, by, t0, t1);
  if (full) v.pop();
  return pathEnt(raw, full ? { v, closed: true } : { v }, 'ELLIPSE');
}

function spline(raw: Raw): PathEnt | null {
  const knots: number[] = [];
  const pts: [number, number][] = [];
  const fit: [number, number][] = [];
  const weights: number[] = [];
  for (let i = 0; i < raw.c.length; i++) {
    const code = raw.c[i];
    const val = parseFloat(raw.v[i]);
    if (code === 40) knots.push(val);
    else if (code === 41) weights.push(val);
    else if (code === 10) pts.push([val, 0]);
    else if (code === 20 && pts.length) pts[pts.length - 1][1] = val;
    else if (code === 11) fit.push([val, 0]);
    else if (code === 21 && fit.length) fit[fit.length - 1][1] = val;
  }
  const v = pts.length >= 2 ? splineVertices(Math.trunc(num(raw, 71, 3)), knots, pts, weights) : fit.map(([x, y]): Vtx => ({ x, y }));
  return pathEnt(raw, closeIfLoop({ v }), 'SPLINE');
}

function solid(raw: Raw, type: string): PathEnt | null {
  const p = (a: number, b: number): Vtx => ({ x: num(raw, a), y: num(raw, b) });
  const p1 = p(10, 20);
  const p2 = p(11, 21);
  const p3 = p(12, 22);
  const p4 = has(raw, 13) ? p(13, 23) : p3;
  // SOLID y TRACE guardan el tercer y el cuarto vértice cruzados; 3DFACE, en orden.
  const v = type === '3DFACE' ? [p1, p2, p3, p4] : [p1, p2, p4, p3];
  const ring = v.filter((q, i) => i === 0 || q.x !== v[i - 1].x || q.y !== v[i - 1].y);
  if (ring.length > 2 && ring[0].x === ring[ring.length - 1].x && ring[0].y === ring[ring.length - 1].y) ring.pop();
  if (ring.length < 3) return null;
  return pathEnt(raw, { v: ring, closed: true }, type, type === '3DFACE' ? IDENTITY : ocsMatrix(raw, num(raw, 30)), { fill: true });
}

let hatchCounter = 0;

function hatch(raw: Raw): PathEnt[] {
  const out: PathEnt[] = [];
  const c = raw.c;
  const val = raw.v;
  let i = c.indexOf(91);
  if (i < 0) return out;
  const paths = parseInt(val[i], 10) || 0;
  i++;
  const solidFill = Math.trunc(num(raw, 70)) === 1;
  const id = ++hatchCounter;
  const m = ocsMatrix(raw, num(raw, 30));
  const f = (k: number): number => parseFloat(val[k]);
  const eat = (code: number, fallback = 0): number => (c[i] === code ? f(i++) : fallback);
  const push = (part: Part): void => {
    const e = pathEnt(raw, part, 'HATCH', m, solidFill ? { hatch: id, fill: true } : { hatch: id });
    if (e) out.push(e);
  };
  for (let p = 0; p < paths && i < c.length; p++) {
    if (c[i] !== 92) break;
    const flag = Math.trunc(f(i++));
    if (flag & 2) {
      // Contorno de polilínea
      const hasBulge = eat(72) !== 0;
      eat(73);
      const count = Math.trunc(eat(93));
      const v: Vtx[] = [];
      for (let k = 0; k < count && c[i] === 10; k++) {
        const vx: Vtx = { x: f(i++), y: eat(20) };
        if (hasBulge || c[i] === 42) {
          const b = eat(42);
          if (b !== 0) vx.b = b;
        }
        v.push(vx);
      }
      if (v.length >= 3 || (v.length === 2 && v.some((q) => q.b))) push({ v, closed: true });
    } else {
      // Contorno de aristas encadenadas
      const edges = Math.trunc(eat(93));
      const v: Vtx[] = [];
      const add = (seg: Vtx[]): void => {
        if (seg.length < 2) return;
        const last = v[v.length - 1];
        const first = seg[0];
        if (last && Math.abs(last.x - first.x) <= 1e-9 * Math.max(1, Math.abs(first.x)) && Math.abs(last.y - first.y) <= 1e-9 * Math.max(1, Math.abs(first.y))) {
          if (first.b !== undefined) last.b = first.b;
          if (first.c) last.c = first.c;
          for (let k = 1; k < seg.length; k++) v.push(seg[k]);
        } else {
          if (last) {
            delete last.b;
            delete last.c;
          }
          for (const q of seg) v.push(q);
        }
      };
      for (let e = 0; e < edges && c[i] === 72; e++) {
        const type = Math.trunc(f(i++));
        if (type === 1) {
          const x1 = eat(10);
          const y1 = eat(20);
          add([{ x: x1, y: y1 }, { x: eat(11), y: eat(21) }]);
        } else if (type === 2) {
          const cx = eat(10);
          const cy = eat(20);
          const r = eat(40);
          const a0 = eat(50);
          const a1 = eat(51);
          const ccw = eat(73, 1) !== 0;
          // Los arcos horarios guardan sus ángulos reflejados (360° − ángulo).
          const sweep = ccwSweep(a0, a1);
          add(arcToVertices(cx, cy, r, (ccw ? a0 : -a0) * DEG, ccw ? sweep : -sweep));
        } else if (type === 3) {
          const cx = eat(10);
          const cy = eat(20);
          const mx = eat(11);
          const my = eat(21);
          const ratio = eat(40, 1);
          const a0 = eat(50);
          const a1 = eat(51);
          const ccw = eat(73, 1) !== 0;
          const sweep = ccwSweep(a0, a1);
          const t0 = (ccw ? a0 : -a0) * DEG;
          add(ellipseToVertices(cx, cy, mx, my, -my * ratio, mx * ratio, t0, t0 + (ccw ? sweep : -sweep)));
        } else if (type === 4) {
          const degree = Math.trunc(eat(94, 3));
          eat(73);
          eat(74);
          const nk = Math.trunc(eat(95));
          const nc = Math.trunc(eat(96));
          const knots: number[] = [];
          for (let k = 0; k < nk && c[i] === 40; k++) knots.push(f(i++));
          const pts: [number, number][] = [];
          const weights: number[] = [];
          for (let k = 0; k < nc && c[i] === 10; k++) {
            pts.push([f(i++), eat(20)]);
            if (c[i] === 42) weights.push(f(i++));
          }
          if (c[i] === 97) {
            const nf = Math.trunc(f(i++));
            for (let k = 0; k < nf && c[i] === 11; k++) {
              i++;
              eat(21);
            }
          }
          while (c[i] === 12 || c[i] === 22 || c[i] === 13 || c[i] === 23) i++;
          add(splineVertices(degree, knots, pts, weights));
        } else break;
      }
      if (v.length >= 2) {
        const loop = closeIfLoop({ v });
        push(loop.closed ? loop : { v, closed: true });
      }
    }
    // Objetos de origen del contorno (97 + referencias 330).
    if (c[i] === 97) {
      i++;
      while (c[i] === 330) i++;
    }
  }
  return out;
}

function textEnt(raw: Raw, src: string): TextEnt | null {
  const m = ocsMatrix(raw, num(raw, 30));
  const h72 = Math.trunc(num(raw, 72));
  const v73 = Math.trunc(num(raw, src === 'ATTRIB' ? 74 : 73));
  const aligned = (h72 !== 0 || v73 !== 0) && h72 !== 3 && h72 !== 5 && has(raw, 11);
  const p = matApply(m, aligned ? num(raw, 11) : num(raw, 10), aligned ? num(raw, 21) : num(raw, 20));
  const rot = num(raw, 50) * DEG;
  const dir = { x: m[0] * Math.cos(rot) + m[2] * Math.sin(rot), y: m[1] * Math.cos(rot) + m[3] * Math.sin(rot) };
  const text = plainText(str(raw, 1));
  const h = num(raw, 40, 1);
  if (!Number.isFinite(p.x + p.y + h) || !(h > 0)) return null;
  const e: TextEnt = {
    k: 'text',
    ...common(raw),
    x: p.x,
    y: p.y,
    h,
    rot: Math.atan2(dir.y, dir.x),
    text,
    halign: !aligned ? 'left' : h72 === 1 || h72 === 4 ? 'center' : h72 === 2 ? 'right' : 'left',
    valign: !aligned ? 'baseline' : h72 === 4 ? 'middle' : v73 === 1 ? 'bottom' : v73 === 2 ? 'middle' : v73 === 3 ? 'top' : 'baseline',
    wf: num(raw, 41, 1) || 1,
    src,
  };
  if (src === 'ATTRIB') {
    e.tag = unescapeUnicode(str(raw, 2));
    if (Math.trunc(num(raw, 70)) & 1) e.hidden = true;
  }
  return e;
}

function mtextEnt(raw: Raw): TextEnt | null {
  let body = '';
  for (let i = 0; i < raw.c.length; i++) if (raw.c[i] === 3) body += raw.v[i];
  body += str(raw, 1);
  const attach = Math.min(9, Math.max(1, Math.trunc(num(raw, 71, 1))));
  const rot = has(raw, 11) ? Math.atan2(num(raw, 21), num(raw, 11)) : num(raw, 50) * DEG;
  const h = num(raw, 40, 1);
  const x = num(raw, 10);
  const y = num(raw, 20);
  if (!Number.isFinite(x + y + h + rot) || !(h > 0)) return null;
  return { k: 'text', ...common(raw), x, y, h, rot, text: cleanMText(body), halign: (['left', 'center', 'right'] as const)[(attach - 1) % 3], valign: (['top', 'middle', 'bottom'] as const)[Math.floor((attach - 1) / 3)], wf: 1, src: 'MTEXT' };
}

function insertEnt(raw: Raw, attribs: TextEnt[]): InsertEnt | null {
  const name = unescapeUnicode(str(raw, 2));
  if (!name) return null;
  const ocs = ocsMatrix(raw, num(raw, 30));
  const rot = rotate(num(raw, 50) * DEG);
  const sx = num(raw, 41, 1) || 1;
  const sy = num(raw, 42, 1) || 1;
  const frame = matMul(ocs, rot);
  const m = matMul(matMul(ocs, translate(num(raw, 10), num(raw, 20))), matMul(rot, scaleMat(sx, sy)));
  if (!m.every(Number.isFinite)) return null;
  return { k: 'insert', ...common(raw), name, m, cols: Math.max(1, Math.trunc(num(raw, 70, 1))), rows: Math.max(1, Math.trunc(num(raw, 71, 1))), dx: num(raw, 44), dy: num(raw, 45), frame, attribs };
}

/** Tipos que no dibujan nada o que se tratan junto a otro: no generan aviso. */
const SILENT = new Set(['POINT', 'VIEWPORT', 'ATTDEF', 'SEQEND', 'VERTEX', 'ATTRIB', 'OLEFRAME', 'XLINE', 'RAY', 'LIGHT', 'SUN', 'CAMERA', 'SECTION', 'ACDBPLACEHOLDER']);

/** Interpreta una entidad en bruto. Devuelve [] si no dibuja nada y null si su tipo no se admite. */
function interpret(raw: Raw): Ent[] | null {
  const one = (e: Ent | null): Ent[] => (e ? [e] : []);
  switch (raw.type) {
    case 'LINE':
      return one(pathEnt(raw, { v: [{ x: num(raw, 10), y: num(raw, 20) }, { x: num(raw, 11), y: num(raw, 21) }] }, 'LINE'));
    case 'LWPOLYLINE':
      return one(lwpolyline(raw));
    case 'CIRCLE': {
      const r = num(raw, 40);
      return r > 0 ? one(pathEnt(raw, circlePart(num(raw, 10), num(raw, 20), r), 'CIRCLE', ocsMatrix(raw, num(raw, 30)))) : [];
    }
    case 'ARC': {
      const r = num(raw, 40);
      const a0 = num(raw, 50);
      return r > 0 ? one(pathEnt(raw, { v: arcToVertices(num(raw, 10), num(raw, 20), r, a0 * DEG, ccwSweep(a0, num(raw, 51))) }, 'ARC', ocsMatrix(raw, num(raw, 30)))) : [];
    }
    case 'ELLIPSE':
      return one(ellipse(raw));
    case 'SPLINE':
      return one(spline(raw));
    case 'SOLID':
    case 'TRACE':
    case '3DFACE':
      return one(solid(raw, raw.type));
    case 'HATCH':
      return hatch(raw);
    case 'TEXT':
      return one(textEnt(raw, 'TEXT'));
    case 'MTEXT':
      return one(mtextEnt(raw));
    case 'LEADER': {
      const v: Vtx[] = [];
      for (let i = 0; i < raw.c.length; i++) {
        if (raw.c[i] === 10) v.push({ x: parseFloat(raw.v[i]), y: 0 });
        else if (raw.c[i] === 20 && v.length) v[v.length - 1].y = parseFloat(raw.v[i]);
      }
      return one(pathEnt(raw, { v }, 'LEADER'));
    }
    case 'DIMENSION':
    case 'ACAD_TABLE': {
      const name = unescapeUnicode(str(raw, 2));
      if (!name) return [];
      const m = raw.type === 'DIMENSION' ? IDENTITY : translate(num(raw, 10), num(raw, 20));
      return [{ k: 'insert', ...common(raw), name, m, cols: 1, rows: 1, dx: 0, dy: 0, frame: IDENTITY, attribs: [], anonymous: true }];
    }
    default:
      return SILENT.has(raw.type) ? [] : null;
  }
}

// ---------------------------------------------------------------------------
// Lectura del archivo
// ---------------------------------------------------------------------------

interface LayerInfo extends DxfLayer {
  ltype: string;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export async function parseDxf(input: string | Uint8Array | ArrayBuffer, opts: ParseDxfOptions = {}): Promise<DxfDrawing> {
  const text = decode(input);
  if (!/(^|\n)\s*0\s*\r?\n\s*SECTION\b/.test(text.slice(0, 200_000)) || text.indexOf('ENTITIES') < 0) {
    throw new Error('El archivo no parece un DXF: no tiene la sección de entidades. Expórtalo de nuevo desde AutoCAD como DXF ASCII.');
  }
  const r = new Reader(text);
  const layers: LayerInfo[] = [];
  const layerIndex = new Map<string, number>();
  const addLayer = (name: string, color = '#ffffff', off = false, frozen = false, ltype = 'CONTINUOUS'): number => {
    let i = layerIndex.get(name);
    if (i === undefined) {
      i = layers.length;
      layerIndex.set(name, i);
      layers.push({ name, color, off, frozen, ltype });
    }
    return i;
  };
  const blocks = new Map<string, Block>();
  const model: Ent[] = [];
  const unsupported = new Map<string, number>();
  const byType: Record<string, number> = {};
  let entities = 0;
  let insUnits: number | undefined;
  let version: string | undefined;
  let last = now();
  const breathe = async (): Promise<void> => {
    if (now() - last < 40) return;
    opts.onProgress?.(Math.min(0.95, (r.pos / Math.max(1, text.length)) * 0.9));
    await tick();
    last = now();
  };

  /** Lee entidades hasta `endType` (ENDSEC o ENDBLK). El lector está en el par de código 0 de la primera. */
  const readEntities = async (endType: string, target: Ent[], counting: boolean): Promise<void> => {
    let n = 0;
    while (r.code === 0 && r.value.trim() !== endType && r.value.trim() !== 'EOF') {
      const type = r.value.trim();
      const raw = readRaw(r, type);
      const paper = Math.trunc(num(raw, 67)) === 1;
      const hidden = Math.trunc(num(raw, 60)) === 1;
      let ents: Ent[] | null = [];
      if (type === 'POLYLINE') {
        const vertices: Raw[] = [];
        while (r.code === 0 && r.value.trim() === 'VERTEX') vertices.push(readRaw(r, 'VERTEX'));
        if (r.code === 0 && r.value.trim() === 'SEQEND') readRaw(r, 'SEQEND');
        const e = polyline(raw, vertices);
        ents = e ? [e] : [];
      } else if (type === 'INSERT') {
        const attribs: TextEnt[] = [];
        if (Math.trunc(num(raw, 66)) === 1) {
          while (r.code === 0 && r.value.trim() === 'ATTRIB') {
            const a = textEnt(readRaw(r, 'ATTRIB'), 'ATTRIB');
            if (a) attribs.push(a);
          }
          if (r.code === 0 && r.value.trim() === 'SEQEND') readRaw(r, 'SEQEND');
        }
        const e = insertEnt(raw, attribs);
        ents = e ? [e] : [];
      } else {
        try {
          ents = interpret(raw);
        } catch {
          ents = [];
        }
      }
      if (paper || hidden) continue;
      if (counting) {
        entities++;
        byType[type] = (byType[type] ?? 0) + 1;
      }
      if (ents === null) {
        if (counting) unsupported.set(type, (unsupported.get(type) ?? 0) + 1);
        continue;
      }
      for (const e of ents) target.push(e);
      if (++n % 500 === 0) await breathe();
    }
  };

  while (r.next()) {
    if (r.code !== 0 || r.value.trim() !== 'SECTION') continue;
    if (!r.next()) break;
    const nameCode: number = r.code;
    if (nameCode !== 2) continue;
    const section = r.value.trim();
    if (section === 'HEADER') {
      let variable = '';
      while (r.next()) {
        // (copia local: TypeScript arrastra el estrechamiento de r.code de la comprobación anterior)
        const code: number = r.code;
        if (code === 0 && r.value.trim() === 'ENDSEC') break;
        if (code === 9) variable = r.value.trim();
        else if (variable === '$INSUNITS' && code === 70) insUnits = parseInt(r.value, 10);
        else if (variable === '$ACADVER' && code === 1) version = r.value.trim();
      }
    } else if (section === 'TABLES') {
      r.next();
      while (!(r.code === 0 && r.value.trim() === 'ENDSEC')) {
        if (r.code === 0 && r.value.trim() === 'LAYER') {
          const raw = readRaw(r, 'LAYER');
          const name = unescapeUnicode(str(raw, 2));
          if (!name) continue;
          const aci = Math.trunc(num(raw, 62, 7));
          const color = has(raw, 420) ? rgbToHex(Math.trunc(num(raw, 420))) : (ACI[Math.min(255, Math.abs(aci))] ?? '#ffffff');
          const i = addLayer(name);
          layers[i] = { name, color: Math.abs(aci) === 0 ? '#ffffff' : color, off: aci < 0, frozen: (Math.trunc(num(raw, 70)) & 1) === 1, ltype: str(raw, 6, 'CONTINUOUS') };
        } else if (!r.next()) break;
      }
    } else if (section === 'BLOCKS') {
      r.next();
      while (!(r.code === 0 && r.value.trim() === 'ENDSEC')) {
        if (r.code === 0 && r.value.trim() === 'BLOCK') {
          const head = readRaw(r, 'BLOCK');
          const name = unescapeUnicode(str(head, 2));
          const block: Block = { name, bx: num(head, 10), by: num(head, 20), ents: [] };
          await readEntities('ENDBLK', block.ents, false);
          if (r.code === 0 && r.value.trim() === 'ENDBLK') readRaw(r, 'ENDBLK');
          // Los bloques de las presentaciones (espacio papel) no forman parte del dibujo.
          if (name && !/^\*paper_space/i.test(name) && !/^\*model_space$/i.test(name)) blocks.set(name.toUpperCase(), block);
        } else if (!r.next()) break;
      }
    } else if (section === 'ENTITIES') {
      r.next();
      await readEntities('ENDSEC', model, true);
    }
  }

  // --- Expansión -----------------------------------------------------------
  addLayer('0');
  const paths: DxfPath[] = [];
  const texts: DxfText[] = [];
  const inserts: DxfInsert[] = [];
  const bbox: BBox = emptyBBox();
  const missing = new Map<string, number>();
  let truncated = false;

  interface Ctx {
    /** Capa de la inserción: la heredan las entidades del bloque dibujadas en la capa "0". */
    layer?: string;
    /** Color y tipo de línea de la inserción: los heredan las entidades PorBloque. */
    color?: string;
    dashed?: boolean;
    /** Bloque con nombre más externo. */
    block?: string;
    depth: number;
    /** Número de la expansión de bloque en curso (0 en el espacio modelo): separa los sombreados de cada inserción. */
    inst: number;
  }
  let instances = 0;
  const hatchIds = new Map<string, number>();

  const resolve = (e: Common, ctx: Ctx): { layer: number; color: string; dashed: boolean } => {
    const layerName = e.layer === '0' && ctx.layer !== undefined ? ctx.layer : e.layer;
    const layer = addLayer(layerName);
    const info = layers[layer];
    const color = e.rgb >= 0 ? rgbToHex(e.rgb) : e.aci === 256 ? info.color : e.aci === 0 ? (ctx.color ?? '#ffffff') : (ACI[Math.min(255, e.aci)] ?? '#ffffff');
    const lt = e.ltype.toUpperCase();
    const dashed = lt === 'BYBLOCK' ? !!ctx.dashed : lt === 'BYLAYER' || lt === '' ? !/^CONTINUOUS$/i.test(info.ltype) && info.ltype !== '' : lt !== 'CONTINUOUS';
    return { layer, color, dashed };
  };

  const emitText = (t: TextEnt, m: Mat, ctx: Ctx, out: { attribs?: Record<string, string> }): void => {
    if (t.tag && out.attribs) out.attribs[t.tag] = t.text;
    if (t.hidden || !t.text) return;
    const p = matApply(m, t.x, t.y);
    const ux = m[0] * Math.cos(t.rot) + m[2] * Math.sin(t.rot);
    const uy = m[1] * Math.cos(t.rot) + m[3] * Math.sin(t.rot);
    const vx = -m[0] * Math.sin(t.rot) + m[2] * Math.cos(t.rot);
    const vy = -m[1] * Math.sin(t.rot) + m[3] * Math.cos(t.rot);
    const su = Math.hypot(ux, uy);
    const sv = Math.hypot(vx, vy);
    if (!(su > 0) || !(sv > 0) || !Number.isFinite(p.x + p.y)) return;
    const { layer, color } = resolve(t, ctx);
    const text: DxfText = { x: p.x, y: p.y, height: t.h * sv, rotation: Math.atan2(uy, ux), text: t.text, layer, color, halign: t.halign, valign: t.valign, widthFactor: (t.wf * su) / sv, src: t.src };
    if (ctx.block) text.block = ctx.block;
    texts.push(text);
    extendBBox(bbox, p.x, p.y);
  };

  const emit = (ents: Ent[], m: Mat, ctx: Ctx, stack: string[]): void => {
    for (const e of ents) {
      if (truncated) return;
      if (e.k === 'path') {
        const { layer, color, dashed } = resolve(e, ctx);
        const part = m === IDENTITY ? e.part : transformPart(e.part, m);
        if (!finite(part)) continue;
        const path: DxfPath = { part, layer, color, src: e.src };
        if (e.fill) path.fill = true;
        if (e.hatch !== undefined) {
          const key = `${ctx.inst}:${e.hatch}`;
          let id = hatchIds.get(key);
          if (id === undefined) {
            id = hatchIds.size + 1;
            hatchIds.set(key, id);
          }
          path.hatch = id;
        }
        if (e.width) path.width = e.width * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
        if (dashed) path.dashed = true;
        if (ctx.block) path.block = ctx.block;
        paths.push(path);
        partBBox(part, bbox);
        if (paths.length >= MAX_PATHS) truncated = true;
      } else if (e.k === 'text') {
        emitText(e, m, ctx, {});
      } else {
        const key = e.name.toUpperCase();
        const block = blocks.get(key);
        const named = !e.anonymous && !e.name.startsWith('*');
        if (!block) {
          if (named) missing.set(e.name, (missing.get(e.name) ?? 0) + 1);
          continue;
        }
        if (ctx.depth >= MAX_DEPTH || stack.includes(key)) continue;
        const r0 = resolve(e, ctx);
        const block0 = ctx.block ?? (named ? e.name : undefined);
        stack.push(key);
        for (let row = 0; row < e.rows; row++) {
          for (let col = 0; col < e.cols; col++) {
            // Las celdas de una matriz de bloques se desplazan en el sistema girado de la inserción.
            const off = col || row ? translate(e.frame[0] * col * e.dx + e.frame[2] * row * e.dy, e.frame[1] * col * e.dx + e.frame[3] * row * e.dy) : IDENTITY;
            const local = matMul(matMul(off, e.m), translate(-block.bx, -block.by));
            const world = m === IDENTITY ? local : matMul(m, local);
            const child: Ctx = { layer: layers[r0.layer].name, color: r0.color, dashed: r0.dashed, block: block0, depth: ctx.depth + 1, inst: ++instances };
            if (named) {
              const origin = matApply(world, block.bx, block.by);
              const ins: DxfInsert = { name: e.name, x: origin.x, y: origin.y, rotation: Math.atan2(world[1], world[0]), sx: Math.hypot(world[0], world[1]) * (world[0] * world[3] - world[1] * world[2] < 0 ? -1 : 1), sy: Math.hypot(world[2], world[3]), layer: r0.layer, depth: ctx.depth };
              const bag: { attribs?: Record<string, string> } = e.attribs.length && !col && !row ? { attribs: {} } : {};
              // Los atributos ya vienen en las coordenadas del contenedor de la inserción, no en las del bloque.
              for (const a of e.attribs) emitText(a, matMul(m, off), { ...ctx, block: block0 }, bag);
              if (bag.attribs && Object.keys(bag.attribs).length) ins.attribs = bag.attribs;
              inserts.push(ins);
              extendBBox(bbox, origin.x, origin.y);
            }
            emit(block.ents, world, child, stack);
          }
        }
        stack.pop();
      }
    }
  };

  for (let i = 0; i < model.length; i += 2000) {
    emit(model.slice(i, i + 2000), IDENTITY, { depth: 0, inst: 0 }, []);
    if (now() - last >= 40) {
      opts.onProgress?.(0.9 + 0.1 * (i / model.length));
      await tick();
      last = now();
    }
  }
  opts.onProgress?.(1);

  const warnings: string[] = [];
  for (const [type, n] of unsupported) warnings.push(`${n} ${n === 1 ? 'entidad' : 'entidades'} ${type} no ${n === 1 ? 'se muestra' : 'se muestran'} (tipo no admitido).`);
  for (const [name, n] of missing) warnings.push(`El bloque «${name}» no está definido en el archivo (${n} ${n === 1 ? 'inserción' : 'inserciones'}).`);
  if (truncated) warnings.push(`El dibujo es demasiado grande: solo se leyeron los primeros ${MAX_PATHS.toLocaleString('es')} trazos.`);

  const drawing: DxfDrawing = { layers: layers.map(({ name, color, off, frozen }) => ({ name, color, off, frozen })), paths, texts, inserts, bbox, warnings, stats: { entities, byType } };
  if (insUnits !== undefined && Number.isFinite(insUnits)) drawing.insUnits = insUnits;
  if (version) drawing.version = version;
  return drawing;
}
