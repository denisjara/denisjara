/**
 * Capa del plano: dibuja la lámina bajo las mediciones y la mantiene nítida a cualquier zoom.
 *
 * Hay dos imágenes: una "base" de la lámina entera a resolución media, que se estira al instante al mover o
 * acercar, y una de "detalle" que cubre solo lo que se ve, a la resolución exacta de la pantalla, y que se
 * vuelve a generar cuando la vista se queda quieta. Así el zoom es fluido y las líneas finas nunca se ven borrosas
 * más de un instante.
 */
import type { Rect, RenderJob, SheetRuntime } from '../app/plans';
import type { Sheet } from '../core/model';

/** Vista: pantalla = lámina × zoom + (ox, oy), en píxeles CSS. */
export interface View {
  zoom: number;
  ox: number;
  oy: number;
}

export const toScreenX = (v: View, x: number): number => x * v.zoom + v.ox;
export const toScreenY = (v: View, y: number): number => y * v.zoom + v.oy;
export const toSheet = (v: View, sx: number, sy: number): { x: number; y: number } => ({ x: (sx - v.ox) / v.zoom, y: (sy - v.oy) / v.zoom });

export function fitView(sheetW: number, sheetH: number, viewW: number, viewH: number, pad: { l: number; t: number; r: number; b: number }): View {
  const availW = Math.max(40, viewW - pad.l - pad.r);
  const availH = Math.max(40, viewH - pad.t - pad.b);
  const zoom = Math.min(availW / sheetW, availH / sheetH);
  return { zoom, ox: pad.l + (availW - sheetW * zoom) / 2, oy: pad.t + (availH - sheetH * zoom) / 2 };
}

export interface BoardColors {
  board: string;
  grid: string;
  paper: string;
  shadow: string;
  ink: string;
}

const BASE_MAX_SIDE = 2400;
const BASE_MAX_PIXELS = 5_000_000;
const DETAIL_MAX_PIXELS = 16_000_000;
const DETAIL_DELAY_MS = 130;

export class PlanLayer {
  private sheet: Sheet | null = null;
  private runtime: SheetRuntime | null = null;
  private hidden: ReadonlySet<string> = new Set();
  private base: HTMLCanvasElement | null = null;
  private detail: { canvas: HTMLCanvasElement; rect: Rect } | null = null;
  private baseJob: RenderJob | null = null;
  private detailJob: RenderJob | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private lastKey = '';
  error: string | null = null;

  constructor(private readonly onChange: () => void) {}

  get ready(): boolean {
    return this.base !== null;
  }

  setSheet(sheet: Sheet | null, runtime: SheetRuntime | null, hidden: ReadonlySet<string>): void {
    this.cancel();
    this.sheet = sheet;
    this.runtime = runtime;
    this.hidden = hidden;
    this.base = null;
    this.detail = null;
    this.error = null;
    this.lastKey = '';
    this.generation++;
    if (sheet && runtime) this.renderBase();
    this.onChange();
  }

  setHidden(hidden: ReadonlySet<string>): void {
    this.hidden = hidden;
    if (!this.sheet || !this.runtime) return;
    this.generation++;
    this.lastKey = '';
    this.renderBase();
  }

  private cancel(): void {
    this.baseJob?.cancel();
    this.detailJob?.cancel();
    this.baseJob = null;
    this.detailJob = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private renderBase(): void {
    const sheet = this.sheet!;
    const gen = this.generation;
    this.baseJob?.cancel();
    const scale = Math.min(BASE_MAX_SIDE / Math.max(sheet.w, sheet.h), Math.sqrt(BASE_MAX_PIXELS / (sheet.w * sheet.h)));
    const job = this.runtime!.render({ x: 0, y: 0, w: sheet.w, h: sheet.h }, scale, this.hidden);
    this.baseJob = job;
    job.promise
      .then((canvas) => {
        if (gen !== this.generation || !canvas) return;
        this.base = canvas;
        this.detail = null;
        this.lastKey = '';
        this.onChange();
      })
      .catch((e: unknown) => {
        if (gen !== this.generation) return;
        this.error = e instanceof Error ? e.message : 'No se pudo dibujar la lámina.';
        this.onChange();
      });
  }

  /** Pide el detalle de la zona visible cuando la vista lleve un momento quieta. */
  requestDetail(view: View, cssW: number, cssH: number, dpr: number): void {
    const sheet = this.sheet;
    if (!sheet || !this.runtime || !this.base) return;
    const key = `${view.zoom}|${view.ox}|${view.oy}|${cssW}|${cssH}|${dpr}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (this.timer) clearTimeout(this.timer);
    this.detailJob?.cancel();
    this.detailJob = null;
    this.timer = setTimeout(() => {
      this.timer = null;
      const marginX = (cssW * 0.12) / view.zoom;
      const marginY = (cssH * 0.12) / view.zoom;
      const x0 = Math.max(0, -view.ox / view.zoom - marginX);
      const y0 = Math.max(0, -view.oy / view.zoom - marginY);
      const x1 = Math.min(sheet.w, (cssW - view.ox) / view.zoom + marginX);
      const y1 = Math.min(sheet.h, (cssH - view.oy) / view.zoom + marginY);
      if (!(x1 > x0) || !(y1 > y0)) return;
      const rect: Rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      let scale = view.zoom * dpr;
      const pixels = rect.w * scale * rect.h * scale;
      if (pixels > DETAIL_MAX_PIXELS) scale *= Math.sqrt(DETAIL_MAX_PIXELS / pixels);
      const gen = this.generation;
      const job = this.runtime!.render(rect, scale, this.hidden);
      this.detailJob = job;
      job.promise
        .then((canvas) => {
          if (gen !== this.generation || this.detailJob !== job || !canvas) return;
          this.detail = { canvas, rect };
          this.onChange();
        })
        .catch(() => {
          /* el detalle es una mejora: si falla queda la imagen base */
        });
    }, DETAIL_DELAY_MS);
  }

  draw(ctx: CanvasRenderingContext2D, view: View, cssW: number, cssH: number, dpr: number, colors: BoardColors): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = colors.board;
    ctx.fillRect(0, 0, cssW, cssH);
    drawBoardGrid(ctx, view, cssW, cssH, colors.grid);
    const sheet = this.sheet;
    if (!sheet) return;
    const x = toScreenX(view, 0);
    const y = toScreenY(view, 0);
    const w = sheet.w * view.zoom;
    const h = sheet.h * view.zoom;
    ctx.save();
    ctx.shadowColor = colors.shadow;
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = colors.paper;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (this.base) ctx.drawImage(this.base, x, y, w, h);
    const d = this.detail;
    if (d) ctx.drawImage(d.canvas, toScreenX(view, d.rect.x), toScreenY(view, d.rect.y), d.rect.w * view.zoom, d.rect.h * view.zoom);
    ctx.strokeStyle = colors.ink;
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) - 0.5, Math.round(y) - 0.5, Math.round(w) + 1, Math.round(h) + 1);
    ctx.globalAlpha = 1;
  }

  destroy(): void {
    this.cancel();
    this.generation++;
    this.base = null;
    this.detail = null;
  }
}

/** Retícula del tablero: se mueve con el plano y se subdivide al acercar (siempre entre ~24 y ~48 px). */
function drawBoardGrid(ctx: CanvasRenderingContext2D, view: View, cssW: number, cssH: number, color: string): void {
  if (!(view.zoom > 0) || !Number.isFinite(view.zoom)) return;
  const target = 32 / view.zoom;
  const step = 2 ** Math.round(Math.log2(target)) * view.zoom;
  if (!(step > 8)) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = ((view.ox % step) + step) % step; x < cssW; x += step) {
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, cssH);
  }
  for (let y = ((view.oy % step) + step) % step; y < cssH; y += step) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(cssW, Math.round(y) + 0.5);
  }
  ctx.stroke();
}
