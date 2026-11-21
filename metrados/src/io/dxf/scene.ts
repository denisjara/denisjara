/**
 * Un DXF ya leído, convertido a "lámina": coordenadas con el origen arriba a la izquierda y la y hacia abajo
 * (como las de un PDF), con su índice espacial para enganchar y sus datos para dibujar.
 */
import { arcFromBulge, bboxIsEmpty, emptyBBox, partBBox, transformPart, type BBox, type Mat, type Part } from '../../core/geometry';
import { VectorBuilder, type VectorData } from '../../core/vector';
import type { PlanLayer, PlanStyle, PlanText } from '../pdf/extract';
import type { DxfDrawing } from './types';

export interface ScenePath {
  part: Part;
  /** Índice de capa + 1 (0 = sin capa). */
  layer: number;
  color: string;
  fill: boolean;
  dashed: boolean;
  width: number;
  box: BBox;
  /** Trazo correspondiente en `vector` (−1 si no tiene). */
  vectorPath: number;
  /** Sombreado al que pertenece el anillo (−1 si no es de un sombreado). */
  hatch: number;
  /** Entidad DXF de origen. */
  src: string;
}

export interface SceneText extends PlanText {
  color: string;
  halign: 'left' | 'center' | 'right';
  valign: 'baseline' | 'bottom' | 'middle' | 'top';
  widthFactor: number;
}

export interface SceneInsert {
  name: string;
  x: number;
  y: number;
  layer: number;
  depth: number;
}

export interface DxfScene {
  w: number;
  h: number;
  /** Mundo (unidades de dibujo, y hacia arriba) → lámina. */
  toSheet: Mat;
  vector: VectorData;
  layers: PlanLayer[];
  styles: PlanStyle[];
  paths: ScenePath[];
  texts: SceneText[];
  inserts: SceneInsert[];
  insUnits?: number;
  warnings: string[];
}

export function buildDxfScene(d: DxfDrawing): DxfScene {
  if (bboxIsEmpty(d.bbox)) throw new Error('El DXF no tiene geometría en el espacio modelo (¿el dibujo está solo en una presentación?).');
  const bw = d.bbox.maxX - d.bbox.minX;
  const bh = d.bbox.maxY - d.bbox.minY;
  const span = Math.max(bw, bh, 1e-9);
  const pad = span * 0.02;
  const w = bw + 2 * pad;
  const h = bh + 2 * pad;
  const toSheet: Mat = [1, 0, 0, -1, pad - d.bbox.minX, d.bbox.maxY + pad];
  const builder = new VectorBuilder(span * 1e-6);
  const layers: PlanLayer[] = d.layers.map((l) => ({ id: l.name, name: l.name, visible: !l.off && !l.frozen, paths: 0 }));
  const styles: PlanStyle[] = [];
  const styleIndex = new Map<string, number>();
  const paths: ScenePath[] = [];
  for (const p of d.paths) {
    const part = transformPart(p.part, toSheet);
    let style = styleIndex.get(p.color);
    if (style === undefined) {
      style = styles.length;
      styleIndex.set(p.color, style);
      styles.push({ stroke: true, fill: false, color: p.color, width: 0, paths: 0 });
    }
    const layer = p.layer >= 0 && p.layer < layers.length ? p.layer + 1 : 0;
    const vectorPath = builder.addPart(part, layer, Math.min(style, 65535), !!p.fill);
    if (vectorPath >= 0) {
      styles[style].paths++;
      if (layer > 0) layers[layer - 1].paths++;
    }
    paths.push({ part, layer, color: p.color, fill: !!p.fill, dashed: !!p.dashed, width: p.width ?? 0, box: partBBox(part, emptyBBox()), vectorPath, hatch: p.hatch ?? -1, src: p.src });
  }
  const texts: SceneText[] = d.texts.map((t) => ({
    str: t.text,
    x: toSheet[0] * t.x + toSheet[4],
    y: toSheet[3] * t.y + toSheet[5],
    h: t.height,
    angle: -t.rotation,
    w: t.text.length * t.height * 0.6 * (t.widthFactor || 1),
    layer: t.layer >= 0 && t.layer < layers.length ? t.layer + 1 : 0,
    color: t.color,
    halign: t.halign,
    valign: t.valign,
    widthFactor: t.widthFactor || 1,
  }));
  const inserts: SceneInsert[] = d.inserts.map((i) => ({ name: i.name, x: toSheet[0] * i.x + toSheet[4], y: toSheet[3] * i.y + toSheet[5], layer: i.layer >= 0 && i.layer < layers.length ? i.layer + 1 : 0, depth: i.depth }));
  return { w, h, toSheet, vector: builder.finish({ minX: 0, minY: 0, maxX: w, maxY: h }), layers, styles, paths, texts, inserts, insUnits: d.insUnits, warnings: d.warnings };
}

// ---------------------------------------------------------------------------
// Dibujo (solo navegador)
// ---------------------------------------------------------------------------

interface Batch {
  layer: number;
  color: string;
  fill: boolean;
  dashed: boolean;
  width: number;
  path: Path2D;
}

const batchCache = new WeakMap<DxfScene, Batch[]>();

/** Traza un trazo exacto (rectas, arcos y Bézier) en un Path2D o en un contexto de canvas. */
export function tracePart(target: Path2D | CanvasRenderingContext2D, part: Part): void {
  const v = part.v;
  if (v.length === 0) return;
  target.moveTo(v[0].x, v[0].y);
  const n = v.length;
  const last = part.closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = v[i];
    const b = v[(i + 1) % n];
    if (a.c) target.bezierCurveTo(a.c[0], a.c[1], a.c[2], a.c[3], b.x, b.y);
    else {
      const arc = a.b !== undefined ? arcFromBulge(a, b, a.b) : null;
      if (arc) target.arc(arc.cx, arc.cy, arc.r, arc.a0, arc.a1, arc.theta < 0);
      else target.lineTo(b.x, b.y);
    }
  }
  if (part.closed) target.closePath();
}

function batches(scene: DxfScene): Batch[] {
  let list = batchCache.get(scene);
  if (list) return list;
  const map = new Map<string, Batch>();
  for (const p of scene.paths) {
    const key = `${p.layer}|${p.color}|${p.fill ? 1 : 0}|${p.dashed ? 1 : 0}|${p.width}`;
    let b = map.get(key);
    if (!b) {
      b = { layer: p.layer, color: p.color, fill: p.fill, dashed: p.dashed, width: p.width, path: new Path2D() };
      map.set(key, b);
    }
    tracePart(b.path, p.part);
  }
  list = [...map.values()];
  batchCache.set(scene, list);
  return list;
}

/** Color de un trazo de CAD sobre papel blanco: los claros (amarillo, cian, blanco) se oscurecen para que se lean. */
export function inkOnPaper(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  if (!Number.isFinite(n)) return '#000000';
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum <= 0.55) return hex;
  if (r > 245 && g > 245 && b > 245) return '#000000';
  const k = 0.42 / lum;
  const c = (x: number) => Math.round(x * k)
    .toString(16)
    .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Dibuja la región de la lámina que empieza en (rx, ry) a `scale` píxeles por unidad sobre el contexto dado
 * (cuyo origen es la esquina de la región).
 */
export function drawDxfScene(ctx: CanvasRenderingContext2D, scene: DxfScene, rx: number, ry: number, rw: number, rh: number, scale: number, hidden: ReadonlySet<string>): void {
  const hiddenIdx = new Set<number>();
  scene.layers.forEach((l, i) => {
    if (hidden.has(l.id)) hiddenIdx.add(i + 1);
  });
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, -rx * scale, -ry * scale);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const b of batches(scene)) {
    if (hiddenIdx.has(b.layer)) continue;
    const color = inkOnPaper(b.color);
    if (b.fill) {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.fill(b.path, 'evenodd');
      ctx.globalAlpha = 1;
      continue;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(b.width, 1 / scale);
    ctx.setLineDash(b.dashed ? [6 / scale, 4 / scale] : []);
    ctx.stroke(b.path);
  }
  ctx.setLineDash([]);
  ctx.restore();

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const t of scene.texts) {
    if (hiddenIdx.has(t.layer)) continue;
    const px = (t.h / 0.72) * scale;
    if (px < 3) continue;
    if (t.x < rx - t.w - t.h * 4 || t.x > rx + rw + t.w + t.h * 4 || t.y < ry - t.w - t.h * 4 || t.y > ry + rh + t.w + t.h * 4) continue;
    ctx.save();
    ctx.translate((t.x - rx) * scale, (t.y - ry) * scale);
    ctx.rotate(t.angle);
    if (t.widthFactor !== 1) ctx.scale(t.widthFactor, 1);
    ctx.font = `400 ${px}px "Sofia Sans Condensed", "Arial Narrow", Arial, sans-serif`;
    ctx.fillStyle = inkOnPaper(t.color);
    ctx.textAlign = t.halign;
    ctx.textBaseline = t.valign === 'baseline' ? 'alphabetic' : t.valign;
    const lines = t.str.split('\n');
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], 0, i * px * 1.25);
    ctx.restore();
  }
  ctx.restore();
}
