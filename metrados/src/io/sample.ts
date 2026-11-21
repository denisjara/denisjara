/**
 * Plano de ejemplo: la planta de una vivienda de 10 × 8 m, generada con medidas conocidas.
 *
 * El mismo dibujo se escribe como PDF vectorial (A3 a escala 1/50, con capas, cotas y rótulos de área) y como DXF
 * (en metros, con bloques para puertas y luminarias). Como las medidas son conocidas, sirve de demostración y de
 * prueba: lo que la app mide sobre el archivo tiene que coincidir con `SAMPLE_ROOMS`.
 */
import { buildPdf, PdfCanvas } from './minipdf';

export interface SampleRoom {
  name: string;
  /** Rectángulo interior libre, en metros (origen en la esquina exterior inferior izquierda, y hacia arriba). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const SAMPLE_ROOMS: readonly SampleRoom[] = [
  { name: 'SALA - COMEDOR', x0: 0.25, y0: 0.25, x1: 5.75, y1: 4.4 },
  { name: 'COCINA', x0: 5.9, y0: 0.25, x1: 9.75, y1: 4.4 },
  { name: 'DORMITORIO 1', x0: 0.25, y0: 4.55, x1: 3.75, y1: 7.75 },
  { name: 'BAÑO', x0: 3.9, y0: 4.55, x1: 5.9, y1: 7.75 },
  { name: 'DORMITORIO 2', x0: 6.05, y0: 4.55, x1: 9.75, y1: 7.75 },
];

export const SAMPLE_SIZE = { w: 10, h: 8 } as const;
export const SAMPLE_RATIO = 50;

interface Opening {
  kind: 'door' | 'window';
  /** Rectángulo del vano dentro del muro (de cara a cara). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Puertas: esquina de la bisagra y hacia dónde abre la hoja (vector unitario) y hacia dónde queda el vano. */
  hinge?: [number, number];
  leaf?: [number, number];
  along?: [number, number];
}

const OPENINGS: readonly Opening[] = [
  // Puertas (ancho 1.00 la principal, 0.90 interiores, 0.70 baño)
  { kind: 'door', x0: 2.0, y0: 0, x1: 3.0, y1: 0.25, hinge: [2.0, 0.25], leaf: [0, 1], along: [1, 0] },
  { kind: 'door', x0: 5.75, y0: 1.5, x1: 5.9, y1: 2.4, hinge: [5.9, 1.5], leaf: [1, 0], along: [0, 1] },
  { kind: 'door', x0: 1.0, y0: 4.4, x1: 1.9, y1: 4.55, hinge: [1.0, 4.55], leaf: [0, 1], along: [1, 0] },
  { kind: 'door', x0: 4.4, y0: 4.4, x1: 5.1, y1: 4.55, hinge: [5.1, 4.55], leaf: [0, 1], along: [-1, 0] },
  { kind: 'door', x0: 6.3, y0: 4.4, x1: 7.2, y1: 4.55, hinge: [6.3, 4.55], leaf: [0, 1], along: [1, 0] },
  // Ventanas
  { kind: 'window', x0: 0, y0: 1.5, x1: 0.25, y1: 3.0 },
  { kind: 'window', x0: 3.8, y0: 0, x1: 5.3, y1: 0.25 },
  { kind: 'window', x0: 9.75, y0: 1.2, x1: 10, y1: 2.7 },
  { kind: 'window', x0: 1.25, y0: 7.75, x1: 2.75, y1: 8 },
  { kind: 'window', x0: 4.6, y0: 7.75, x1: 5.2, y1: 8 },
  { kind: 'window', x0: 7.15, y0: 7.75, x1: 8.65, y1: 8 },
];

/** Columnas de 0.25 × 0.25 (esquina inferior izquierda). */
const COLUMNS: readonly [number, number][] = [
  [0, 0],
  [9.75, 0],
  [0, 7.75],
  [9.75, 7.75],
  [0, 4.35],
  [9.75, 4.35],
  [5.7, 0],
  [5.85, 7.75],
];

/** Centros de luz (uno por ambiente) y tomacorrientes. */
const LIGHTS: readonly [number, number][] = [
  [3.0, 2.3],
  [7.8, 2.3],
  [2.0, 6.15],
  [4.9, 6.15],
  [7.9, 6.15],
];
const OUTLETS: readonly [number, number, number][] = [
  [0.25, 0.9, 0],
  [5.75, 3.5, 180],
  [9.75, 3.4, 180],
  [5.9, 0.8, 0],
  [0.25, 5.2, 0],
  [3.75, 7.0, 180],
  [6.05, 5.2, 0],
  [9.75, 7.0, 180],
];

export const SAMPLE_COUNTS = { doors: 5, windows: 6, columns: COLUMNS.length, lights: LIGHTS.length, outlets: OUTLETS.length } as const;

/** Receptor del dibujo: lo implementan el escritor de PDF y el de DXF. Todo en metros, y hacia arriba. */
interface Sink {
  layer(name: string): void;
  line(x1: number, y1: number, x2: number, y2: number): void;
  rect(x0: number, y0: number, x1: number, y1: number, filled?: boolean): void;
  arc(cx: number, cy: number, r: number, a0: number, a1: number): void;
  circle(cx: number, cy: number, r: number): void;
  text(x: number, y: number, h: number, text: string, align?: 'left' | 'center' | 'right', angle?: number): void;
  /** Puerta: bisagra, ancho, dirección de la hoja abierta y dirección del vano. */
  door(hx: number, hy: number, w: number, leaf: [number, number], along: [number, number]): void;
  light(x: number, y: number): void;
  outlet(x: number, y: number, angleDeg: number): void;
}

/** Resta de un tramo [a, b] los intervalos de los vanos y devuelve los trozos que quedan. */
function cut(a: number, b: number, gaps: [number, number][]): [number, number][] {
  let pieces: [number, number][] = [[a, b]];
  for (const [g0, g1] of gaps) {
    const next: [number, number][] = [];
    for (const [p0, p1] of pieces) {
      if (g1 <= p0 || g0 >= p1) next.push([p0, p1]);
      else {
        if (g0 > p0) next.push([p0, g0]);
        if (g1 < p1) next.push([g1, p1]);
      }
    }
    pieces = next;
  }
  return pieces;
}

const EPS = 1e-9;

function faceH(s: Sink, y: number, x0: number, x1: number): void {
  const gaps = OPENINGS.filter((o) => o.kind === 'door' && (Math.abs(o.y0 - y) < EPS || Math.abs(o.y1 - y) < EPS) && o.x1 - o.x0 > o.y1 - o.y0).map((o): [number, number] => [o.x0, o.x1]);
  for (const [a, b] of cut(x0, x1, gaps)) s.line(a, y, b, y);
}

function faceV(s: Sink, x: number, y0: number, y1: number): void {
  const gaps = OPENINGS.filter((o) => o.kind === 'door' && (Math.abs(o.x0 - x) < EPS || Math.abs(o.x1 - x) < EPS) && o.y1 - o.y0 > o.x1 - o.x0).map((o): [number, number] => [o.y0, o.y1]);
  for (const [a, b] of cut(y0, y1, gaps)) s.line(x, a, x, b);
}

function drawPlan(s: Sink): void {
  const { w, h } = SAMPLE_SIZE;
  s.layer('MUROS');
  faceH(s, 0, 0, w);
  faceH(s, h, 0, w);
  faceV(s, 0, 0, h);
  faceV(s, w, 0, h);
  for (const r of SAMPLE_ROOMS) {
    faceH(s, r.y0, r.x0, r.x1);
    faceH(s, r.y1, r.x0, r.x1);
    faceV(s, r.x0, r.y0, r.y1);
    faceV(s, r.x1, r.y0, r.y1);
  }
  // Mochetas: los dos lados cortos de cada vano.
  for (const o of OPENINGS) {
    if (o.x1 - o.x0 > o.y1 - o.y0) {
      s.line(o.x0, o.y0, o.x0, o.y1);
      s.line(o.x1, o.y0, o.x1, o.y1);
    } else {
      s.line(o.x0, o.y0, o.x1, o.y0);
      s.line(o.x0, o.y1, o.x1, o.y1);
    }
  }
  s.layer('COLUMNAS');
  for (const [x, y] of COLUMNS) s.rect(x, y, x + 0.25, y + 0.25, true);
  s.layer('VENTANAS');
  for (const o of OPENINGS) {
    if (o.kind !== 'window') continue;
    if (o.x1 - o.x0 > o.y1 - o.y0) {
      const t = (o.y1 - o.y0) / 3;
      s.line(o.x0, o.y0 + t, o.x1, o.y0 + t);
      s.line(o.x0, o.y0 + 2 * t, o.x1, o.y0 + 2 * t);
    } else {
      const t = (o.x1 - o.x0) / 3;
      s.line(o.x0 + t, o.y0, o.x0 + t, o.y1);
      s.line(o.x0 + 2 * t, o.y0, o.x0 + 2 * t, o.y1);
    }
  }
  s.layer('PUERTAS');
  for (const o of OPENINGS) {
    if (o.kind !== 'door' || !o.hinge || !o.leaf || !o.along) continue;
    s.door(o.hinge[0], o.hinge[1], Math.max(o.x1 - o.x0, o.y1 - o.y0), o.leaf, o.along);
  }
  s.layer('MOBILIARIO');
  // Cama, inodoro, lavatorio y mesa: solo para que haya algo que apagar.
  s.rect(0.6, 5.3, 2.0, 7.3);
  s.rect(0.6, 6.8, 2.0, 7.3);
  s.rect(7.6, 5.3, 9.0, 7.3);
  s.rect(7.6, 6.8, 9.0, 7.3);
  s.rect(4.15, 7.0, 4.55, 7.6);
  s.circle(4.35, 6.75, 0.22);
  s.rect(5.2, 6.9, 5.75, 7.4);
  s.rect(2.2, 1.6, 3.8, 2.6);
  s.rect(6.2, 0.4, 9.5, 1.0);
  s.layer('ELECTRICAS');
  for (const [x, y] of LIGHTS) s.light(x, y);
  for (const [x, y, a] of OUTLETS) s.outlet(x, y, a);
  s.layer('TEXTOS');
  for (const r of SAMPLE_ROOMS) {
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2 + 0.75;
    s.text(cx, cy, 0.16, r.name, 'center');
    s.text(cx, cy - 0.3, 0.12, `A = ${((r.x1 - r.x0) * (r.y1 - r.y0)).toFixed(2)} m2`, 'center');
  }
  s.layer('COTAS');
  const xs = [0, 0.25, 3.75, 3.9, 5.9, 6.05, 9.75, 10];
  const ys = [0, 0.25, 4.4, 4.55, 7.75, 8];
  const tick = 0.08;
  const chainH = (y: number, stops: number[]) => {
    s.line(stops[0], y, stops[stops.length - 1], y);
    for (const x of stops) {
      s.line(x, y - tick, x, y + tick);
      s.line(x - tick, y - tick, x + tick, y + tick);
    }
    for (let i = 1; i < stops.length; i++) s.text((stops[i - 1] + stops[i]) / 2, y + 0.07, 0.1, (stops[i] - stops[i - 1]).toFixed(2), 'center');
  };
  const chainV = (x: number, stops: number[]) => {
    s.line(x, stops[0], x, stops[stops.length - 1]);
    for (const y of stops) {
      s.line(x - tick, y, x + tick, y);
      s.line(x - tick, y - tick, x + tick, y + tick);
    }
    for (let i = 1; i < stops.length; i++) s.text(x - 0.07, (stops[i - 1] + stops[i]) / 2, 0.1, (stops[i] - stops[i - 1]).toFixed(2), 'center', Math.PI / 2);
  };
  chainH(h + 0.7, xs);
  chainH(h + 1.2, [0, w]);
  chainV(-0.7, ys);
  chainV(-1.2, [0, h]);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const MM = 72 / 25.4;
/** A3 apaisado (redondeado a 4 decimales de punto, que es como se escribe en el archivo). */
export const SAMPLE_PAGE = { w: Math.round(420 * MM * 1e4) / 1e4, h: Math.round(297 * MM * 1e4) / 1e4 } as const;
/** Puntos de papel por metro real a 1/50. */
export const SAMPLE_PT_PER_M = (1000 / SAMPLE_RATIO) * MM;
/** Posición en el papel (puntos PDF, origen abajo a la izquierda) del origen de la vivienda. */
export const SAMPLE_ORIGIN = { x: 75 * MM, y: 78 * MM } as const;

const LAYERS = ['MUROS', 'COLUMNAS', 'VENTANAS', 'PUERTAS', 'MOBILIARIO', 'ELECTRICAS', 'TEXTOS', 'COTAS', 'MEMBRETE'] as const;
const LAYER_STYLE: Record<string, { w: number; rgb: [number, number, number] }> = {
  MUROS: { w: 0.7, rgb: [0.07, 0.09, 0.12] },
  COLUMNAS: { w: 0.5, rgb: [0.07, 0.09, 0.12] },
  VENTANAS: { w: 0.3, rgb: [0.1, 0.35, 0.65] },
  PUERTAS: { w: 0.35, rgb: [0.45, 0.25, 0.1] },
  MOBILIARIO: { w: 0.2, rgb: [0.55, 0.57, 0.6] },
  ELECTRICAS: { w: 0.35, rgb: [0.8, 0.15, 0.15] },
  TEXTOS: { w: 0.2, rgb: [0.07, 0.09, 0.12] },
  COTAS: { w: 0.2, rgb: [0.25, 0.35, 0.5] },
  MEMBRETE: { w: 0.5, rgb: [0.07, 0.09, 0.12] },
};

class PdfSink implements Sink {
  readonly c = new PdfCanvas();
  private open = false;
  private k = SAMPLE_PT_PER_M;
  private X = (x: number) => SAMPLE_ORIGIN.x + x * this.k;
  private Y = (y: number) => SAMPLE_ORIGIN.y + y * this.k;

  layer(name: string): void {
    if (this.open) this.c.endLayer();
    const st = LAYER_STYLE[name];
    this.c
      .beginLayer(LAYERS.indexOf(name as (typeof LAYERS)[number]))
      .lineWidth(st.w)
      .strokeColor(...st.rgb)
      .fillColor(...st.rgb);
    this.open = true;
  }
  end(): void {
    if (this.open) this.c.endLayer();
    this.open = false;
  }
  line(x1: number, y1: number, x2: number, y2: number): void {
    this.c.line(this.X(x1), this.Y(y1), this.X(x2), this.Y(y2));
  }
  rect(x0: number, y0: number, x1: number, y1: number, filled = false): void {
    this.c.rect(this.X(x0), this.Y(y0), (x1 - x0) * this.k, (y1 - y0) * this.k);
    if (filled) this.c.fillStroke();
    else this.c.stroke();
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number): void {
    this.c.arc(this.X(cx), this.Y(cy), r * this.k, a0, a1).stroke();
  }
  circle(cx: number, cy: number, r: number): void {
    this.c.circle(this.X(cx), this.Y(cy), r * this.k).stroke();
  }
  text(x: number, y: number, h: number, text: string, align: 'left' | 'center' | 'right' = 'left', angle = 0): void {
    this.c.text(this.X(x), this.Y(y), h * this.k * 1.38, text.replace('m2', 'm²'), { align, angle });
  }
  door(hx: number, hy: number, w: number, leaf: [number, number], along: [number, number]): void {
    this.line(hx, hy, hx + leaf[0] * w, hy + leaf[1] * w);
    const a0 = Math.atan2(leaf[1], leaf[0]);
    const a1 = Math.atan2(along[1], along[0]);
    let sweep = a1 - a0;
    if (sweep > Math.PI) sweep -= 2 * Math.PI;
    if (sweep < -Math.PI) sweep += 2 * Math.PI;
    this.arc(hx, hy, w, a0, a0 + sweep);
  }
  light(x: number, y: number): void {
    const r = 0.14;
    this.circle(x, y, r);
    const d = r * Math.SQRT1_2;
    this.line(x - d, y - d, x + d, y + d);
    this.line(x - d, y + d, x + d, y - d);
  }
  outlet(x: number, y: number, angleDeg: number): void {
    const dir = angleDeg === 0 ? 1 : -1;
    this.line(x, y, x + dir * 0.12, y);
    this.arc(x + dir * 0.2, y, 0.08, Math.PI / 2, (3 * Math.PI) / 2);
    this.line(x + dir * 0.2, y - 0.08, x + dir * 0.2, y + 0.08);
  }
}

/** PDF vectorial del plano de ejemplo (una página A3 a 1/50). */
export function buildSamplePdf(): Uint8Array {
  const s = new PdfSink();
  // Relleno gris de los muros: contorno exterior, ambientes y vanos con la regla par-impar.
  s.c.beginLayer(0).fillColor(0.86, 0.87, 0.89);
  const k = SAMPLE_PT_PER_M;
  const X = (x: number) => SAMPLE_ORIGIN.x + x * k;
  const Y = (y: number) => SAMPLE_ORIGIN.y + y * k;
  s.c.rect(X(0), Y(0), SAMPLE_SIZE.w * k, SAMPLE_SIZE.h * k);
  for (const r of SAMPLE_ROOMS) s.c.rect(X(r.x0), Y(r.y0), (r.x1 - r.x0) * k, (r.y1 - r.y0) * k);
  for (const o of OPENINGS) if (o.kind === 'door') s.c.rect(X(o.x0), Y(o.y0), (o.x1 - o.x0) * k, (o.y1 - o.y0) * k);
  s.c.raw('f*').endLayer();
  drawPlan(s);
  s.end();

  // Membrete, marco y escala gráfica (en milímetros de papel).
  const c = s.c;
  const P = SAMPLE_PAGE;
  c.beginLayer(LAYERS.indexOf('MEMBRETE')).strokeColor(0.07, 0.09, 0.12).fillColor(0.07, 0.09, 0.12).lineWidth(0.8);
  c.rect(10 * MM, 10 * MM, P.w - 20 * MM, P.h - 20 * MM).stroke();
  const bx = P.w - 10 * MM - 120 * MM;
  const by = 10 * MM;
  c.lineWidth(0.5)
    .rect(bx, by, 120 * MM, 40 * MM)
    .stroke();
  c.line(bx, by + 28 * MM, bx + 120 * MM, by + 28 * MM).line(bx, by + 14 * MM, bx + 120 * MM, by + 14 * MM).line(bx + 80 * MM, by, bx + 80 * MM, by + 14 * MM);
  c.text(bx + 4 * MM, by + 32 * MM, 13, 'VIVIENDA UNIFAMILIAR', { bold: true });
  c.text(bx + 4 * MM, by + 18.5 * MM, 10, 'PLANTA PRIMER PISO - ARQUITECTURA');
  c.text(bx + 4 * MM, by + 8 * MM, 7, 'PLANO DE EJEMPLO DE METRADO LAB');
  c.text(bx + 4 * MM, by + 3.5 * MM, 7, 'Medidas en metros');
  c.text(bx + 84 * MM, by + 8 * MM, 8, 'ESCALA:  1/50', { bold: true });
  c.text(bx + 84 * MM, by + 3.5 * MM, 8, 'LÁMINA:  A-01');
  // Escala gráfica de 0 a 5 m.
  const sx = 20 * MM;
  const sy = 18 * MM;
  c.lineWidth(0.4);
  for (let i = 0; i < 5; i++) {
    c.rect(sx + i * k, sy, k, 2 * MM);
    if (i % 2 === 0) c.fillStroke();
    else c.stroke();
  }
  for (let i = 0; i <= 5; i++) c.text(sx + i * k, sy + 3.2 * MM, 6.5, `${i}`, { align: 'center' });
  c.text(sx + 5 * k + 3 * MM, sy + 0.2 * MM, 6.5, 'm');
  c.endLayer();

  return buildPdf([{ width: P.w, height: P.h, content: c.toString() }], { layers: [...LAYERS], title: 'Vivienda unifamiliar - Planta primer piso (ejemplo)' });
}

// ---------------------------------------------------------------------------
// DXF (R12, en metros)
// ---------------------------------------------------------------------------

const DXF_COLORS: Record<string, number> = { MUROS: 7, COLUMNAS: 8, VENTANAS: 5, PUERTAS: 30, MOBILIARIO: 9, ELECTRICAS: 1, TEXTOS: 7, COTAS: 4 };

class DxfSink implements Sink {
  readonly out: string[] = [];
  private cur = '0';
  private e(type: string, pairs: (string | number)[]): void {
    this.out.push('0', type, '8', this.cur);
    for (let i = 0; i < pairs.length; i += 2) this.out.push(String(pairs[i]), String(pairs[i + 1]));
  }
  layer(name: string): void {
    this.cur = name;
  }
  line(x1: number, y1: number, x2: number, y2: number): void {
    this.e('LINE', [10, x1, 20, y1, 11, x2, 21, y2]);
  }
  rect(x0: number, y0: number, x1: number, y1: number, filled = false): void {
    if (filled) {
      this.e('SOLID', [10, x0, 20, y0, 11, x1, 21, y0, 12, x0, 22, y1, 13, x1, 23, y1]);
      return;
    }
    this.e('POLYLINE', [66, 1, 70, 1]);
    for (const [x, y] of [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ])
      this.e('VERTEX', [10, x, 20, y]);
    this.e('SEQEND', []);
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number): void {
    const deg = (a: number) => ((a * 180) / Math.PI + 720) % 360;
    // En DXF los arcos van siempre en sentido antihorario.
    if (a1 >= a0) this.e('ARC', [10, cx, 20, cy, 40, r, 50, deg(a0), 51, deg(a1)]);
    else this.e('ARC', [10, cx, 20, cy, 40, r, 50, deg(a1), 51, deg(a0)]);
  }
  circle(cx: number, cy: number, r: number): void {
    this.e('CIRCLE', [10, cx, 20, cy, 40, r]);
  }
  text(x: number, y: number, h: number, text: string, align: 'left' | 'center' | 'right' = 'left', angle = 0): void {
    const a = align === 'center' ? 1 : align === 'right' ? 2 : 0;
    this.e('TEXT', [10, x, 20, y, 40, h, 1, text.replace('m2', 'm\\U+00B2'), 50, (angle * 180) / Math.PI, 72, a, 11, x, 21, y]);
  }
  door(hx: number, hy: number, w: number, leaf: [number, number], along: [number, number]): void {
    // Bloque unitario: hoja de (0,0) a (0,1) y arco hasta (1,0). El giro lleva la hoja a su dirección; si el vano
    // queda al otro lado, la escala X negativa lo refleja.
    const rot = (Math.atan2(leaf[1], leaf[0]) * 180) / Math.PI - 90;
    const cross = leaf[0] * along[1] - leaf[1] * along[0];
    this.e('INSERT', [2, 'PUERTA', 10, hx, 20, hy, 41, cross < 0 ? w : -w, 42, w, 50, rot]);
  }
  light(x: number, y: number): void {
    this.e('INSERT', [2, 'LUMINARIA', 10, x, 20, y]);
  }
  outlet(x: number, y: number, angleDeg: number): void {
    this.e('INSERT', [2, 'TOMACORRIENTE', 10, x, 20, y, 50, angleDeg]);
  }
}

/** DXF del plano de ejemplo: espacio modelo en metros, capas y bloques (PUERTA, LUMINARIA, TOMACORRIENTE). */
export function buildSampleDxf(): string {
  const s = new DxfSink();
  drawPlan(s);
  const head: (string | number)[] = [0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSUNITS', 70, 6, 0, 'ENDSEC'];
  head.push(0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, Object.keys(DXF_COLORS).length + 1);
  head.push(0, 'LAYER', 2, '0', 70, 0, 62, 7, 6, 'CONTINUOUS');
  for (const [name, color] of Object.entries(DXF_COLORS)) head.push(0, 'LAYER', 2, name, 70, 0, 62, color, 6, 'CONTINUOUS');
  head.push(0, 'ENDTAB', 0, 'ENDSEC');
  const d = 0.14 * Math.SQRT1_2;
  const blocks: (string | number)[] = [0, 'SECTION', 2, 'BLOCKS'];
  blocks.push(0, 'BLOCK', 8, '0', 2, 'PUERTA', 70, 0, 10, 0, 20, 0, 3, 'PUERTA');
  blocks.push(0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 0, 21, 1, 0, 'ARC', 8, '0', 10, 0, 20, 0, 40, 1, 50, 0, 51, 90, 0, 'ENDBLK', 8, '0');
  blocks.push(0, 'BLOCK', 8, '0', 2, 'LUMINARIA', 70, 0, 10, 0, 20, 0, 3, 'LUMINARIA');
  blocks.push(0, 'CIRCLE', 8, '0', 10, 0, 20, 0, 40, 0.14, 0, 'LINE', 8, '0', 10, -d, 20, -d, 11, d, 21, d, 0, 'LINE', 8, '0', 10, -d, 20, d, 11, d, 21, -d, 0, 'ENDBLK', 8, '0');
  blocks.push(0, 'BLOCK', 8, '0', 2, 'TOMACORRIENTE', 70, 0, 10, 0, 20, 0, 3, 'TOMACORRIENTE');
  blocks.push(0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 0.12, 21, 0, 0, 'ARC', 8, '0', 10, 0.2, 20, 0, 40, 0.08, 50, 90, 51, 270, 0, 'LINE', 8, '0', 10, 0.2, 20, -0.08, 11, 0.2, 21, 0.08, 0, 'ENDBLK', 8, '0');
  blocks.push(0, 'ENDSEC');
  return [...head.map(String), ...blocks.map(String), '0', 'SECTION', '2', 'ENTITIES', ...s.out, '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
}

/** Punto del plano de ejemplo (metros) → unidades de lámina del PDF (puntos, origen arriba a la izquierda). */
export function sampleToSheet(x: number, y: number): { x: number; y: number } {
  return { x: SAMPLE_ORIGIN.x + x * SAMPLE_PT_PER_M, y: SAMPLE_PAGE.h - (SAMPLE_ORIGIN.y + y * SAMPLE_PT_PER_M) };
}
