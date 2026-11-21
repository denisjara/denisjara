/**
 * Capa de mediciones: todo lo que se dibuja encima del plano (mediciones, trazo en curso, marcas de enganche,
 * rótulos y vistas previas). Se repinta entera en cada cambio; el plano va en otro canvas debajo.
 */
import { emptyBBox, flattenPart, partBBox, polygonLabelPoint, polylineMidpoint, type BBox, type Part, type Pt } from '../core/geometry';
import { rawQuantities, type Quantities } from '../core/metrado';
import type { Measurement, Partida, Sheet } from '../core/model';
import { formatNumber } from '../core/units';
import type { SnapKind } from '../core/vector';
import { tracePart } from '../io/dxf/scene';
import { toScreenX, toScreenY, type View } from './plan-layer';

/** Geometría derivada de una medición (se calcula una vez: las mediciones son inmutables). */
export interface Geo {
  path: Path2D;
  box: BBox;
  /** Trazos teselados, para las pruebas de puntería. */
  flat: Pt[][];
  /** Dónde poner el rótulo. */
  label: Pt;
  raw: Quantities;
}

const geoCache = new WeakMap<Measurement, Geo>();

export function geoOf(m: Measurement): Geo {
  let g = geoCache.get(m);
  if (g) return g;
  const box = emptyBBox();
  for (const p of m.parts) partBBox(p, box);
  const span = Math.max(box.maxX - box.minX, box.maxY - box.minY, 1e-9);
  const path = new Path2D();
  const flat: Pt[][] = [];
  for (const p of m.parts) {
    const part: Part = m.kind === 'area' && !p.closed ? { ...p, closed: true } : p;
    if (m.kind !== 'count') tracePart(path, part);
    flat.push(m.kind === 'count' ? p.v : flattenPart(part, span * 2e-4));
  }
  let label: Pt = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
  if (m.kind === 'area') {
    let best = -1;
    for (const f of flat) {
      if (f.length < 3) continue;
      let a = 0;
      for (let i = 0, j = f.length - 1; i < f.length; j = i++) a += f[j].x * f[i].y - f[i].x * f[j].y;
      if (Math.abs(a) > best) {
        best = Math.abs(a);
        label = polygonLabelPoint(f);
      }
    }
  } else if (m.kind === 'line') {
    let best = -1;
    m.parts.forEach((p, i) => {
      const f = p.closed ? [...flat[i], flat[i][0]] : flat[i];
      let len = 0;
      for (let k = 1; k < f.length; k++) len += Math.hypot(f[k].x - f[k - 1].x, f[k].y - f[k - 1].y);
      if (len > best) {
        best = len;
        label = polylineMidpoint(f).p;
      }
    });
  } else if (flat[0]?.length) {
    label = flat[0][0];
  }
  g = { path, box, flat, label, raw: rawQuantities(m.kind, m.parts) };
  geoCache.set(m, g);
  return g;
}

/** Rótulo de la magnitud leída del plano (no el parcial): "3.20 m", "11.20 m²", "5 und". */
export function measureText(m: Measurement, mPerUnit: number | null, decimals: number, unitName: string): string {
  const raw = geoOf(m).raw;
  if (m.kind === 'count') return `${raw.N} ${raw.N === 1 ? 'punto' : 'puntos'}`;
  if (mPerUnit === null) return m.kind === 'area' ? `${formatNumber(raw.A, 1)} ${unitName}²` : `${formatNumber(raw.L, 1)} ${unitName}`;
  return m.kind === 'area' ? `${formatNumber(raw.A * mPerUnit * mPerUnit, decimals)} m²` : `${formatNumber(raw.L * mPerUnit, decimals)} m`;
}

export interface OverlayColors {
  panel: string;
  ink: string;
  ink2: string;
  accent: string;
  danger: string;
  line: string;
}

export interface DraftView {
  kind: 'line' | 'area' | 'rect' | 'ruler' | 'calibrate';
  pts: readonly Pt[];
  /** Punto bajo el cursor (ya enganchado), si lo hay. */
  cursor: Pt | null;
  color: string;
  /** Líneas de texto junto al cursor. */
  hud: string[];
  /** Rótulo de cada tramo ya colocado (regla). */
  segLabels?: string[];
}

export interface OverlayScene {
  view: View;
  dpr: number;
  cssW: number;
  cssH: number;
  sheet: Sheet;
  measurements: readonly Measurement[];
  partidas: ReadonlyMap<string, Partida>;
  selection: ReadonlySet<string>;
  hoverId: string | null;
  showLabels: boolean;
  decimals: number;
  unitName: string;
  colors: OverlayColors;
  draft: DraftView | null;
  snap: { x: number; y: number; kind: SnapKind } | null;
  /** Vértice activo de la medición seleccionada (resaltado). */
  activeVertex: { id: string; part: number; index: number } | null;
  /** Trazo del plano bajo el cursor (herramienta de tomar trazos). */
  pick: Path2D | null;
  /** Recinto detectado bajo el cursor (área automática). */
  region: Pt[] | null;
  /** Texto que se está tecleando (longitud exacta del tramo). */
  typed: string | null;
  cursorScreen: Pt | null;
  /** Marcas de coincidencias de texto (buscar/contar por texto). */
  marks: readonly Pt[];
}

const FONT = '600 12px "Sofia Sans", system-ui, sans-serif';

function hexAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function sheetTransform(ctx: CanvasRenderingContext2D, s: OverlayScene): void {
  ctx.setTransform(s.dpr * s.view.zoom, 0, 0, s.dpr * s.view.zoom, s.dpr * s.view.ox, s.dpr * s.view.oy);
}

function screenTransform(ctx: CanvasRenderingContext2D, s: OverlayScene): void {
  ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
}

/** Etiqueta con fondo: devuelve su caja para evitar solapes. */
function tag(ctx: CanvasRenderingContext2D, s: OverlayScene, lines: string[], x: number, y: number, border: string, align: 'center' | 'left' = 'center'): void {
  ctx.font = FONT;
  let w = 0;
  for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
  const padX = 6;
  const lineH = 15;
  const bw = w + padX * 2;
  const bh = lines.length * lineH + 5;
  let bx = align === 'center' ? x - bw / 2 : x;
  let by = y - bh / 2;
  bx = Math.max(4, Math.min(s.cssW - bw - 4, bx));
  by = Math.max(4, Math.min(s.cssH - bh - 4, by));
  ctx.fillStyle = s.colors.panel;
  ctx.globalAlpha = 0.94;
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 4);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = border;
  ctx.lineWidth = 1.25;
  ctx.stroke();
  ctx.fillStyle = s.colors.ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, bx + padX, by + 3 + lineH * i + lineH / 2));
}

function onScreen(s: OverlayScene, b: BBox): boolean {
  const v = s.view;
  return toScreenX(v, b.maxX) >= -20 && toScreenX(v, b.minX) <= s.cssW + 20 && toScreenY(v, b.maxY) >= -20 && toScreenY(v, b.minY) <= s.cssH + 20;
}

function drawMeasurement(ctx: CanvasRenderingContext2D, s: OverlayScene, m: Measurement, partida: Partida | undefined, selected: boolean, hovered: boolean): void {
  const g = geoOf(m);
  if (!onScreen(s, g.box)) return;
  const color = m.deduct ? s.colors.danger : (partida?.color ?? s.colors.accent);
  const z = s.view.zoom;
  if (m.kind === 'count') {
    screenTransform(ctx, s);
    const r = selected ? 7.5 : hovered ? 7 : 6;
    for (const p of g.flat[0] ?? []) {
      const x = toScreenX(s.view, p.x);
      const y = toScreenY(s.view, p.y);
      if (x < -10 || y < -10 || x > s.cssW + 10 || y > s.cssH + 10) continue;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = hexAlpha(color, 0.85);
      ctx.fill();
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
    return;
  }
  sheetTransform(ctx, s);
  if (m.kind === 'area') {
    ctx.fillStyle = hexAlpha(color, selected ? 0.36 : hovered ? 0.3 : 0.2);
    ctx.fill(g.path, 'evenodd');
  }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (selected || hovered) {
    ctx.strokeStyle = hexAlpha(color, 0.3);
    ctx.lineWidth = (m.kind === 'line' ? 9 : 7) / z;
    ctx.stroke(g.path);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = (m.kind === 'line' ? 3 : 2) / z;
  ctx.setLineDash(m.deduct ? [7 / z, 5 / z] : []);
  ctx.stroke(g.path);
  ctx.setLineDash([]);
}

function drawHandles(ctx: CanvasRenderingContext2D, s: OverlayScene, m: Measurement, color: string): void {
  if (m.kind === 'count') return;
  screenTransform(ctx, s);
  m.parts.forEach((part, pi) => {
    const v = part.v;
    const closed = part.closed || m.kind === 'area';
    // Puntos medios de los tramos rectos: al arrastrarlos se inserta un vértice.
    const last = closed ? v.length : v.length - 1;
    for (let i = 0; i < last; i++) {
      const a = v[i];
      const b = v[(i + 1) % v.length];
      if (a.c || (a.b !== undefined && Math.abs(a.b) > 1e-12)) continue;
      const x = toScreenX(s.view, (a.x + b.x) / 2);
      const y = toScreenY(s.view, (a.y + b.y) / 2);
      if (Math.hypot(toScreenX(s.view, b.x) - toScreenX(s.view, a.x), toScreenY(s.view, b.y) - toScreenY(s.view, a.y)) < 36) continue;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = s.colors.panel;
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
    v.forEach((p, i) => {
      const x = toScreenX(s.view, p.x);
      const y = toScreenY(s.view, p.y);
      const active = s.activeVertex?.id === m.id && s.activeVertex.part === pi && s.activeVertex.index === i;
      const h = active ? 6 : 4.5;
      ctx.fillStyle = active ? color : '#ffffff';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.rect(x - h, y - h, h * 2, h * 2);
      ctx.fill();
      ctx.stroke();
    });
  });
}

function drawSnap(ctx: CanvasRenderingContext2D, s: OverlayScene): void {
  const snap = s.snap;
  if (!snap) return;
  screenTransform(ctx, s);
  const x = toScreenX(s.view, snap.x);
  const y = toScreenY(s.view, snap.y);
  const r = 7;
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ff8a00';
  ctx.fillStyle = 'rgba(255, 138, 0, 0.18)';
  ctx.beginPath();
  switch (snap.kind) {
    case 'endpoint':
    case 'vertex':
      ctx.rect(x - r, y - r, r * 2, r * 2);
      break;
    case 'midpoint':
      ctx.moveTo(x, y - r - 1);
      ctx.lineTo(x + r + 1, y + r);
      ctx.lineTo(x - r - 1, y + r);
      ctx.closePath();
      break;
    case 'intersection':
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r);
      ctx.lineTo(x - r, y + r);
      break;
    case 'perpendicular':
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x - r, y + r);
      ctx.lineTo(x + r, y + r);
      ctx.moveTo(x - r, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + r);
      break;
    default:
      ctx.moveTo(x - r, y - r);
      ctx.lineTo(x + r, y - r);
      ctx.lineTo(x - r, y + r);
      ctx.lineTo(x + r, y + r);
      ctx.closePath();
  }
  if (snap.kind !== 'intersection' && snap.kind !== 'perpendicular') ctx.fill();
  ctx.stroke();
  const names: Record<SnapKind, string> = { endpoint: 'Extremo', vertex: 'Vértice', midpoint: 'Punto medio', intersection: 'Intersección', perpendicular: 'Perpendicular', nearest: 'Sobre la línea' };
  ctx.font = '600 11px "Sofia Sans", system-ui, sans-serif';
  const label = names[snap.kind];
  const w = ctx.measureText(label).width + 8;
  const lx = Math.min(s.cssW - w - 4, x + 12);
  const ly = Math.max(4, y - 26);
  ctx.fillStyle = '#ff8a00';
  ctx.beginPath();
  ctx.roundRect(lx, ly, w, 16, 3);
  ctx.fill();
  ctx.fillStyle = '#1a1206';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, lx + 4, ly + 8.5);
}

function drawDraft(ctx: CanvasRenderingContext2D, s: OverlayScene, d: DraftView): void {
  screenTransform(ctx, s);
  const pts = d.pts.map((p) => ({ x: toScreenX(s.view, p.x), y: toScreenY(s.view, p.y) }));
  const cur = d.cursor ? { x: toScreenX(s.view, d.cursor.x), y: toScreenY(s.view, d.cursor.y) } : null;
  const color = d.color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (d.kind === 'rect') {
    if (pts.length === 1 && cur) {
      const [a] = pts;
      ctx.fillStyle = hexAlpha(color, 0.18);
      ctx.fillRect(a.x, a.y, cur.x - a.x, cur.y - a.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(a.x, a.y, cur.x - a.x, cur.y - a.y);
    }
  } else if (pts.length) {
    if (d.kind === 'area' && pts.length >= 2 && cur) {
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.lineTo(cur.x, cur.y);
      ctx.closePath();
      ctx.fillStyle = hexAlpha(color, 0.16);
      ctx.fill();
    }
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.strokeStyle = color;
    ctx.lineWidth = d.kind === 'ruler' || d.kind === 'calibrate' ? 2 : 3;
    ctx.stroke();
    if (cur) {
      const last = pts[pts.length - 1];
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(cur.x, cur.y);
      if (d.kind === 'area' && pts.length >= 2) ctx.lineTo(pts[0].x, pts[0].y);
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  if (d.segLabels) {
    d.segLabels.forEach((text, i) => {
      if (i + 1 >= pts.length) return;
      tag(ctx, s, [text], (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2, color);
    });
  }
  const anchor = cur ?? pts[pts.length - 1];
  if (anchor && d.hud.length) tag(ctx, s, d.hud, anchor.x + 16, anchor.y + 26, color, 'left');
}

export function drawOverlay(ctx: CanvasRenderingContext2D, s: OverlayScene): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const scaleOf = (m: Measurement): number | null => s.sheet.scales.find((x) => x.id === m.scaleId)?.mPerUnit ?? null;

  // Primero las no seleccionadas; las seleccionadas van encima.
  for (const pass of [0, 1]) {
    for (const m of s.measurements) {
      if (m.sheetId !== s.sheet.id || m.kind === 'manual') continue;
      const selected = s.selection.has(m.id);
      if ((pass === 1) !== selected) continue;
      drawMeasurement(ctx, s, m, s.partidas.get(m.partidaId), selected, s.hoverId === m.id);
    }
  }

  if (s.region && s.region.length >= 3) {
    sheetTransform(ctx, s);
    ctx.beginPath();
    s.region.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = hexAlpha('#ff8a00', 0.22);
    ctx.fill();
    ctx.strokeStyle = '#ff8a00';
    ctx.lineWidth = 2 / s.view.zoom;
    ctx.stroke();
  }
  if (s.pick) {
    sheetTransform(ctx, s);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255, 138, 0, 0.35)';
    ctx.lineWidth = 9 / s.view.zoom;
    ctx.stroke(s.pick);
    ctx.strokeStyle = '#ff8a00';
    ctx.lineWidth = 2.5 / s.view.zoom;
    ctx.stroke(s.pick);
  }

  // Rótulos
  screenTransform(ctx, s);
  for (const m of s.measurements) {
    if (m.sheetId !== s.sheet.id || m.kind === 'manual') continue;
    const selected = s.selection.has(m.id);
    const hovered = s.hoverId === m.id;
    if (!s.showLabels && !selected && !hovered) continue;
    const g = geoOf(m);
    if (!onScreen(s, g.box)) continue;
    const sizePx = Math.max(g.box.maxX - g.box.minX, g.box.maxY - g.box.minY) * s.view.zoom;
    if (m.kind !== 'count' && sizePx < 34 && !selected && !hovered) continue;
    const partida = s.partidas.get(m.partidaId);
    const color = m.deduct ? s.colors.danger : (partida?.color ?? s.colors.accent);
    const text = `${m.deduct ? '− ' : ''}${measureText(m, scaleOf(m), s.decimals, s.unitName)}`;
    const lines = (selected || hovered) && m.label ? [m.label, text] : [text];
    const off = m.kind === 'count' ? 20 : 0;
    tag(ctx, s, lines, toScreenX(s.view, g.label.x) + off, toScreenY(s.view, g.label.y) - off, color);
  }

  for (const m of s.measurements) {
    if (m.sheetId === s.sheet.id && s.selection.has(m.id)) drawHandles(ctx, s, m, m.deduct ? s.colors.danger : (s.partidas.get(m.partidaId)?.color ?? s.colors.accent));
  }

  if (s.marks.length) {
    screenTransform(ctx, s);
    ctx.strokeStyle = '#ff8a00';
    ctx.lineWidth = 2;
    for (const p of s.marks) {
      const x = toScreenX(s.view, p.x);
      const y = toScreenY(s.view, p.y);
      if (x < -20 || y < -20 || x > s.cssW + 20 || y > s.cssH + 20) continue;
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  if (s.draft) drawDraft(ctx, s, s.draft);
  drawSnap(ctx, s);

  if (s.typed !== null && s.cursorScreen) {
    screenTransform(ctx, s);
    tag(ctx, s, [`Longitud: ${s.typed}▏ m   ⏎`], s.cursorScreen.x + 16, s.cursorScreen.y - 22, s.colors.accent, 'left');
  }
}

/** Distancia en píxeles de pantalla de un punto a una medición (Infinity si no la toca). */
export function hitDistance(m: Measurement, view: View, sx: number, sy: number): number {
  const g = geoOf(m);
  const px = (sx - view.ox) / view.zoom;
  const py = (sy - view.oy) / view.zoom;
  const tol = 10 / view.zoom;
  if (px < g.box.minX - tol || px > g.box.maxX + tol || py < g.box.minY - tol || py > g.box.maxY + tol) return Infinity;
  let best = Infinity;
  if (m.kind === 'count') {
    for (const p of g.flat[0] ?? []) best = Math.min(best, Math.hypot(p.x - px, p.y - py));
    return best * view.zoom <= 10 ? best * view.zoom : Infinity;
  }
  let inside = false;
  m.parts.forEach((part, i) => {
    const f = g.flat[i];
    const closed = part.closed || m.kind === 'area';
    const n = f.length;
    for (let k = 0; k < (closed ? n : n - 1); k++) {
      const a = f[k];
      const b = f[(k + 1) % n];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((px - a.x) * dx + (py - a.y) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      best = Math.min(best, Math.hypot(a.x + dx * t - px, a.y + dy * t - py));
    }
    if (m.kind === 'area') {
      let c = false;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        if (f[a].y > py !== f[b].y > py && px < ((f[b].x - f[a].x) * (py - f[a].y)) / (f[b].y - f[a].y) + f[a].x) c = !c;
      }
      if (c) inside = !inside;
    }
  });
  const d = best * view.zoom;
  if (d <= 7) return d;
  return inside ? 8 : Infinity;
}
