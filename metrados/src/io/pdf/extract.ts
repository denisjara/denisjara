/**
 * Lectura exacta de la geometría vectorial de una página PDF.
 *
 * pdf.js entrega la página como una lista de operadores (los mismos que usa para dibujarla). Aquí se recorren
 * llevando la matriz de transformación vigente, y cada trazo pintado (líneas, rectángulos, curvas) se guarda con sus
 * coordenadas tal como están en el archivo, pasadas al espacio de la lámina (puntos, origen arriba a la izquierda).
 * No hay reconocimiento de imagen ni aproximación: un vértice del plano se obtiene con la precisión del propio PDF.
 *
 * Solo cuentan los trazos que se pintan (contorno o relleno); los recortes (clip) no son geometría del plano.
 * Las anotaciones (marcas añadidas encima del PDF) se excluyen.
 */
import { matApply, matDet, matMul, type BBox, type Mat, type Part, type Vtx } from '../../core/geometry';
import { VectorBuilder, type VectorData } from '../../core/vector';

/** Lo que este módulo usa de pdf.js (se le pasa la librería para poder probarlo en Node con la compilación legacy). */
export interface PdfLib {
  OPS: Record<string, number>;
  AnnotationMode: { DISABLE: number };
}

export interface PdfPageLike {
  getViewport(params: { scale: number }): { transform: number[]; width: number; height: number };
  getOperatorList(params?: { annotationMode?: number }): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  getTextContent(): Promise<{ items: unknown[] }>;
}

export interface OptionalContentLike {
  [Symbol.iterator](): Iterator<[string, { name?: string | null; visible?: boolean }]>;
}

export interface PlanStyle {
  stroke: boolean;
  fill: boolean;
  /** Color "#rrggbb" del contorno (o del relleno si no tiene contorno). */
  color: string;
  /** Grosor de línea en unidades de lámina (0 en rellenos). */
  width: number;
  /** Trazos con este estilo. */
  paths: number;
}

export interface PlanLayer {
  id: string;
  name: string;
  /** Visible por defecto en el archivo. */
  visible: boolean;
  /** Trazos en esta capa. */
  paths: number;
}

export interface PlanText {
  str: string;
  /** Origen de la línea base, en unidades de lámina. */
  x: number;
  y: number;
  /** Altura de la letra en unidades de lámina. */
  h: number;
  /** Giro en radianes (sentido horario en pantalla, como canvas). */
  angle: number;
  /** Ancho aproximado del texto en unidades de lámina. */
  w: number;
  /** Capa (0 = sin capa). */
  layer: number;
}

export interface PageVector {
  vector: VectorData;
  styles: PlanStyle[];
  layers: PlanLayer[];
  texts: PlanText[];
  /** Fracción de la página cubierta por imágenes (≈1 en un plano escaneado). */
  imageCoverage: number;
  /** true si la página es esencialmente una imagen: no hay líneas a las que engancharse. */
  raster: boolean;
}

interface GState {
  ctm: Mat;
  stroke: string;
  fill: string;
  lw: number;
}

const DRAW_MOVE = 0;
const DRAW_LINE = 1;
const DRAW_CURVE = 2;
const DRAW_QUAD = 3;
const DRAW_CLOSE = 4;

/** Error de cuerda al convertir curvas del PDF en segmentos para el enganche: 0,01 pt ≈ 3,5 µm en el papel. */
const FLATTEN_TOL = 0.01;

export async function extractPdfPage(page: PdfPageLike, lib: PdfLib, optionalContent?: OptionalContentLike | null): Promise<PageVector> {
  const OPS = lib.OPS;
  const viewport = page.getViewport({ scale: 1 });
  const base = viewport.transform as unknown as Mat;
  const bounds: BBox = { minX: 0, minY: 0, maxX: viewport.width, maxY: viewport.height };
  const pageArea = Math.max(1e-9, viewport.width * viewport.height);

  const layers: PlanLayer[] = [];
  const layerIndex = new Map<string, number>();
  if (optionalContent) {
    for (const [id, group] of optionalContent) {
      layerIndex.set(id, layers.length + 1);
      layers.push({ id, name: (group.name ?? '').trim() || `Capa ${layers.length + 1}`, visible: group.visible !== false, paths: 0 });
    }
  }

  const styles: PlanStyle[] = [];
  const styleIndex = new Map<string, number>();
  const styleOf = (stroke: boolean, fill: boolean, color: string, width: number): number => {
    const w = stroke ? Math.round(width * 1000) / 1000 : 0;
    const key = `${stroke ? 1 : 0}${fill ? 1 : 0}${color}|${w}`;
    let idx = styleIndex.get(key);
    if (idx === undefined) {
      idx = styles.length;
      if (idx >= 65535) return 65535;
      styleIndex.set(key, idx);
      styles.push({ stroke, fill, color, width: w, paths: 0 });
    }
    return idx;
  };

  const builder = new VectorBuilder(FLATTEN_TOL);
  const { fnArray, argsArray } = await page.getOperatorList({ annotationMode: lib.AnnotationMode.DISABLE });

  const strokeOps = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const fillOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat]);

  let st: GState = { ctm: base, stroke: '#000000', fill: '#000000', lw: 1 };
  const stack: GState[] = [];
  const marked: number[] = [];
  let layer = 0;
  let imageArea = 0;

  const emit = (v: Vtx[], closed: boolean, fillOnly: boolean, style: number) => {
    if (v.length < 2) return;
    // Un subtrazo cerrado que vuelve explícitamente al punto inicial: se quita el vértice repetido.
    if (closed && v.length > 2) {
      const a = v[0];
      const z = v[v.length - 1];
      if (z.c === undefined && Math.abs(a.x - z.x) < 1e-9 && Math.abs(a.y - z.y) < 1e-9) v.pop();
    }
    const part: Part = closed && v.length > 2 ? { v, closed: true } : { v };
    const id = builder.addPart(part, layer, style, fillOnly);
    if (id >= 0) {
      if (style < styles.length) styles[style].paths++;
      if (layer > 0) layers[layer - 1].paths++;
    }
  };

  const addPath = (data: ArrayLike<number>, stroke: boolean, fill: boolean) => {
    const m = st.ctm;
    const color = stroke ? st.stroke : st.fill;
    if (color === 'none') return;
    const style = styleOf(stroke, fill, color, st.lw * Math.sqrt(Math.abs(matDet(m))));
    const fillOnly = fill && !stroke;
    let v: Vtx[] = [];
    let closed = false;
    let startX = 0;
    let startY = 0;
    const flush = () => {
      emit(v, closed || fillOnly, fillOnly, style);
      v = [];
      closed = false;
    };
    const point = (x: number, y: number): Vtx => matApply(m, x, y);
    for (let i = 0, n = data.length; i < n; ) {
      const op = data[i++];
      if (op === DRAW_MOVE) {
        flush();
        startX = data[i++];
        startY = data[i++];
        v.push(point(startX, startY));
      } else if (op === DRAW_LINE) {
        if (v.length === 0) v.push(point(startX, startY));
        v.push(point(data[i++], data[i++]));
      } else if (op === DRAW_CURVE) {
        if (v.length === 0) v.push(point(startX, startY));
        const c1 = matApply(m, data[i++], data[i++]);
        const c2 = matApply(m, data[i++], data[i++]);
        v[v.length - 1].c = [c1.x, c1.y, c2.x, c2.y];
        v.push(point(data[i++], data[i++]));
      } else if (op === DRAW_QUAD) {
        // Cuadrática (solo aparece en contornos de letras): se eleva a cúbica, que la representa exactamente.
        if (v.length === 0) v.push(point(startX, startY));
        const q = matApply(m, data[i++], data[i++]);
        const e = point(data[i++], data[i++]);
        const p0 = v[v.length - 1];
        v[v.length - 1].c = [p0.x + (2 / 3) * (q.x - p0.x), p0.y + (2 / 3) * (q.y - p0.y), e.x + (2 / 3) * (q.x - e.x), e.y + (2 / 3) * (q.y - e.y)];
        v.push(e);
      } else if (op === DRAW_CLOSE) {
        closed = true;
        flush();
      } else {
        break; // operador desconocido: no se puede seguir interpretando este trazo
      }
    }
    flush();
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | null;
    switch (fn) {
      case OPS.save:
      case OPS.beginGroup:
        stack.push(st);
        st = { ...st };
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(st);
        st = { ...st };
        if (args && Array.isArray(args[0]) && args[0].length === 6) st.ctm = matMul(st.ctm, args[0] as unknown as Mat);
        break;
      case OPS.restore:
      case OPS.endGroup:
      case OPS.paintFormXObjectEnd:
        st = stack.pop() ?? st;
        break;
      case OPS.transform:
        if (args && args.length >= 6) st.ctm = matMul(st.ctm, args as unknown as Mat);
        break;
      case OPS.setLineWidth:
        if (args && typeof args[0] === 'number') st.lw = args[0];
        break;
      case OPS.setGState:
        if (args && Array.isArray(args[0])) for (const pair of args[0] as [string, unknown][]) if (pair[0] === 'LW' && typeof pair[1] === 'number') st.lw = pair[1];
        break;
      case OPS.setStrokeRGBColor:
        if (args && typeof args[0] === 'string') st.stroke = args[0].toLowerCase();
        break;
      case OPS.setFillRGBColor:
        if (args && typeof args[0] === 'string') st.fill = args[0].toLowerCase();
        break;
      case OPS.setStrokeTransparent:
        st.stroke = 'none';
        break;
      case OPS.setFillTransparent:
        st.fill = 'none';
        break;
      case OPS.setStrokeColorN:
        st.stroke = '#000000'; // patrón: no hay un color único
        break;
      case OPS.setFillColorN:
        st.fill = '#000000';
        break;
      case OPS.beginMarkedContent:
        marked.push(layer);
        break;
      case OPS.beginMarkedContentProps: {
        marked.push(layer);
        const props = args?.[1] as { type?: string; id?: string } | undefined;
        if (args?.[0] === 'OC' && props?.type === 'OCG' && typeof props.id === 'string') layer = layerIndex.get(props.id) ?? layer;
        break;
      }
      case OPS.endMarkedContent:
        if (marked.length) layer = marked.pop()!;
        break;
      case OPS.constructPath: {
        if (!args) break;
        const op = args[0] as number;
        const data = (args[1] as unknown[] | null)?.[0] as ArrayLike<number> | null | undefined;
        if (!data || data.length < 3) break;
        const stroke = strokeOps.has(op);
        const fill = fillOps.has(op);
        if (stroke || fill) addPath(data, stroke, fill);
        break;
      }
      default:
        if (imageOps.has(fn)) imageArea += Math.abs(matDet(st.ctm));
    }
  }

  const texts = await extractTexts(page, base);
  const vector = builder.finish(bounds);
  const imageCoverage = Math.min(1, imageArea / pageArea);
  return { vector, styles, layers, texts, imageCoverage, raster: imageCoverage > 0.5 && vector.count < 200 };
}

async function extractTexts(page: PdfPageLike, base: Mat): Promise<PlanText[]> {
  const out: PlanText[] = [];
  let content: { items: unknown[] };
  try {
    content = await page.getTextContent();
  } catch {
    return out;
  }
  for (const raw of content.items) {
    const item = raw as { str?: unknown; transform?: unknown; width?: unknown };
    if (typeof item.str !== 'string' || !Array.isArray(item.transform) || item.transform.length < 6) continue;
    const str = item.str.trim();
    if (!str) continue;
    const m = matMul(base, item.transform as unknown as Mat);
    const h = Math.hypot(m[2], m[3]);
    if (!Number.isFinite(m[4] + m[5] + h)) continue;
    out.push({ str, x: m[4], y: m[5], h, angle: Math.atan2(m[1], m[0]), w: typeof item.width === 'number' ? item.width : 0, layer: 0 });
  }
  return out;
}
