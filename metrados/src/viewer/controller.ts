/**
 * Controlador del visor: vista (zoom y desplazamiento), entrada (ratón, táctil y teclado) y herramientas.
 *
 * Convenciones de uso, pensadas para medir sin soltar el ratón:
 *   - clic: coloca un punto (enganchado al plano si hay algo cerca) · arrastrar: mueve el plano · rueda: zoom;
 *   - Intro, doble clic o clic derecho: termina el trazo · Retroceso: borra el último punto · Esc: cancela;
 *   - Mayús: ortogonal · teclear un número + Intro: tramo de esa longitud exacta en la dirección del cursor.
 * En pantallas táctiles: un toque coloca el punto, mantener pulsado apunta con precisión, dos dedos hacen zoom.
 */
import { addMeasurement, currentSheet, patchMeasurement, removeMeasurements, setLayerHidden, setTool, TOOL_BASES } from '../app/actions';
import { getRuntime, type SheetRuntime } from '../app/plans';
import { store, type ToolId } from '../app/store';
import { findRegion } from '../core/boundary';
import { dist, emptyBBox, extendBBox, partBBox, type BBox, type Part, type Pt, type Vtx } from '../core/geometry';
import { rawQuantities } from '../core/metrado';
import type { Measurement, Partida, Sheet } from '../core/model';
import { formatNumber, parseNumber } from '../core/units';
import { nearestPath, partOfPath, PATH_CLOSED, queryBox, snapPoint, type SnapHit } from '../core/vector';
import { tracePart } from '../io/dxf/scene';
import { drawOverlay, geoOf, hitDistance, type DraftView, type OverlayColors } from './overlay';
import { fitView, PlanLayer, toSheet, toScreenX, toScreenY, type BoardColors, type View } from './plan-layer';

const SNAP_PX = 12;
const HANDLE_PX = 9;

export interface ViewerStatus {
  loading: boolean;
  error: string | null;
  zoom: number;
  /** La lámina es una imagen sin líneas a las que engancharse. */
  raster: boolean;
  hasVector: boolean;
  hint: string;
  /** Hay un trazo a medio dibujar. */
  drafting: boolean;
  /** El trazo en curso ya se puede terminar. */
  canFinish: boolean;
}

const INITIAL_STATUS: ViewerStatus = { loading: false, error: null, zoom: 1, raster: false, hasVector: false, hint: '', drafting: false, canFinish: false };
let sharedStatus: ViewerStatus = INITIAL_STATUS;
const statusListeners = new Set<() => void>();

/** Estado del visor para la interfaz (solo hay un visor en pantalla). */
export const getViewerStatus = (): ViewerStatus => sharedStatus;
export const subscribeViewerStatus = (fn: () => void): (() => void) => {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
};

type Gesture =
  | { kind: 'press'; id: number; x: number; y: number; ox: number; oy: number; moved: boolean; pan: boolean; button: number; touch: boolean; aim: boolean; timer: ReturnType<typeof setTimeout> | null }
  | { kind: 'vertex'; id: number; mId: string; part: number; index: number }
  | { kind: 'pinch'; d0: number; zoom0: number; sx: number; sy: number };

interface Handle {
  mId: string;
  part: number;
  index: number;
  /** Si es un punto medio: dónde insertar el vértice nuevo. */
  insert?: Pt;
}

type Draft = { kind: 'line' | 'area'; pts: Pt[] } | { kind: 'rect'; a: Pt } | { kind: 'ruler'; pts: Pt[]; done: boolean } | { kind: 'calibrate'; a: Pt } | { kind: 'count'; id: string };

const HINTS: Record<ToolId, string> = {
  select: 'Clic: seleccionar · arrastra un vértice para ajustarlo · Supr: borrar · arrastrar: mover el plano',
  line: 'Clic: añadir punto · Intro o doble clic: terminar · C: cerrar · Retroceso: deshacer punto · Mayús: ortogonal',
  area: 'Clic: añadir vértice · Intro o doble clic: cerrar el área · Retroceso: deshacer punto · Mayús: ortogonal',
  rect: 'Clic en una esquina y clic en la opuesta',
  count: 'Clic sobre cada elemento · Intro: terminar el grupo · Retroceso: quitar el último',
  ruler: 'Clic en dos o más puntos para medir sin guardar · Esc: limpiar',
  pick: 'Pasa el cursor sobre una línea del plano y haz clic para medirla tal como está dibujada · Mayús+clic: sumar a la medición',
  region: 'Mueve el cursor dentro de un recinto cerrado: se resalta. Clic para medirlo',
  calibrate: 'Clic en los dos extremos de una cota conocida',
};

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

export class ViewerController {
  view: View = { zoom: 1, ox: 0, oy: 0 };
  status: ViewerStatus = INITIAL_STATUS;

  private readonly plan: PlanLayer;
  private readonly pctx: CanvasRenderingContext2D;
  private readonly octx: CanvasRenderingContext2D;
  private readonly ro: ResizeObserver;
  private readonly themeObserver: MutationObserver;
  private readonly media = window.matchMedia('(prefers-color-scheme: dark)');
  private readonly unsub: () => void;
  private readonly views = new Map<string, View>();

  private runtime: SheetRuntime | null = null;
  private sheetId: string | null = null;
  private hiddenKey = '';
  private layerHidden: Uint8Array | null = null;
  private loadToken = 0;
  private tool: ToolId = 'select';
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private raf = 0;
  private needPlan = true;
  private gesture: Gesture | null = null;
  private pointers = new Map<number, Pt>();
  private draft: Draft | null = null;
  private cursorScreen: Pt | null = null;
  private cursor: Pt | null = null;
  private snap: SnapHit | null = null;
  private activeVertex: { id: string; part: number; index: number } | null = null;
  private pick: { path: number; shape: Path2D } | null = null;
  private preview: Path2D | null = null;
  private region: { outer: Pt[]; holes: Pt[][] } | null = null;
  private regionTimer: ReturnType<typeof setTimeout> | null = null;
  private typed: string | null = null;
  private keys = { space: false, shift: false };
  private board!: BoardColors;
  private colors!: OverlayColors;
  private own: { key: unknown; exclude: string | null; pts: Pt[] } = { key: null, exclude: null, pts: [] };
  private marks: Pt[] = [];
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly planCanvas: HTMLCanvasElement,
    private readonly overCanvas: HTMLCanvasElement,
  ) {
    this.plan = new PlanLayer(() => this.invalidate(true));
    this.pctx = planCanvas.getContext('2d', { alpha: false })!;
    this.octx = overCanvas.getContext('2d')!;
    this.readColors();
    const o = overCanvas;
    o.addEventListener('pointerdown', this.onDown);
    o.addEventListener('pointermove', this.onMove);
    o.addEventListener('pointerup', this.onUp);
    o.addEventListener('pointercancel', this.onCancel);
    o.addEventListener('pointerleave', this.onLeave);
    o.addEventListener('wheel', this.onWheel, { passive: false });
    o.addEventListener('dblclick', this.onDblClick);
    o.addEventListener('contextmenu', this.onContext);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.media.addEventListener('change', this.onTheme);
    this.themeObserver = new MutationObserver(this.onTheme);
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.unsub = store.subscribe(this.onStore);
    this.resize();
    this.onStore();
    void document.fonts?.ready.then(() => this.invalidate(false));
  }

  destroy(): void {
    this.destroyed = true;
    const o = this.overCanvas;
    o.removeEventListener('pointerdown', this.onDown);
    o.removeEventListener('pointermove', this.onMove);
    o.removeEventListener('pointerup', this.onUp);
    o.removeEventListener('pointercancel', this.onCancel);
    o.removeEventListener('pointerleave', this.onLeave);
    o.removeEventListener('wheel', this.onWheel);
    o.removeEventListener('dblclick', this.onDblClick);
    o.removeEventListener('contextmenu', this.onContext);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.media.removeEventListener('change', this.onTheme);
    this.themeObserver.disconnect();
    this.ro.disconnect();
    this.unsub();
    this.plan.destroy();
    sharedStatus = INITIAL_STATUS;
    cancelAnimationFrame(this.raf);
    if (this.regionTimer) clearTimeout(this.regionTimer);
    if (this.statusTimer) clearTimeout(this.statusTimer);
  }

  private setStatus(patch: Partial<ViewerStatus>): void {
    let changed = false;
    for (const k of Object.keys(patch) as (keyof ViewerStatus)[]) if (patch[k] !== this.status[k]) changed = true;
    if (!changed) return;
    this.status = { ...this.status, ...patch };
    sharedStatus = this.status;
    for (const fn of statusListeners) fn();
  }

  // -------------------------------------------------------------------------
  // Colores, tamaño y bucle de dibujo
  // -------------------------------------------------------------------------

  private onTheme = (): void => {
    this.readColors();
    this.invalidate(true);
  };

  private readColors(): void {
    const css = getComputedStyle(document.documentElement);
    const rgb = (name: string, alpha = 1): string => {
      const v = css.getPropertyValue(name).trim().split(/\s+/).join(', ');
      return alpha === 1 ? `rgb(${v})` : `rgba(${v}, ${alpha})`;
    };
    this.board = { board: rgb('--c-board'), grid: rgb('--c-board-grid'), paper: rgb('--c-paper'), shadow: rgb('--c-shadow', 0.28), ink: rgb('--c-ink') };
    this.colors = { panel: rgb('--c-panel'), ink: rgb('--c-ink'), ink2: rgb('--c-ink-2'), accent: rgb('--c-accent'), danger: rgb('--c-danger'), line: rgb('--c-line-strong') };
  }

  private resize(): void {
    const r = this.host.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (w === this.cssW && h === this.cssH && dpr === this.dpr) return;
    // Mantiene en su sitio el punto del plano que estaba en el centro.
    const first = this.cssW <= 1;
    this.view.ox += (w - this.cssW) / 2;
    this.view.oy += (h - this.cssH) / 2;
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    for (const c of [this.planCanvas, this.overCanvas]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    if (first) this.fit();
    this.invalidate(true);
  }

  invalidate(plan: boolean): void {
    if (plan) this.needPlan = true;
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private draw(): void {
    const { project, ui } = store.get();
    const sheet = project.sheets.find((s) => s.id === this.sheetId) ?? null;
    if (this.needPlan) {
      this.needPlan = false;
      this.plan.draw(this.pctx, this.view, this.cssW, this.cssH, this.dpr, this.board);
      this.plan.requestDetail(this.view, this.cssW, this.cssH, this.dpr);
      if (!this.statusTimer) {
        this.statusTimer = setTimeout(() => {
          this.statusTimer = null;
          this.setStatus({ zoom: this.view.zoom });
          // Vista actual (zoom y desplazamiento) a la vista de las pruebas automáticas y de quien inspeccione la página.
          this.host.dataset.view = `${this.view.zoom} ${this.view.ox} ${this.view.oy}`;
        }, 120);
      }
    }
    const d = this.draft;
    this.setStatus({
      drafting: d !== null && !(d.kind === 'ruler' && d.done),
      canFinish: !!d && ((d.kind === 'line' && d.pts.length >= 2) || (d.kind === 'area' && d.pts.length >= 3) || (d.kind === 'ruler' && !d.done && d.pts.length >= 2) || d.kind === 'count'),
    });
    if (!sheet) {
      this.octx.setTransform(1, 0, 0, 1, 0, 0);
      this.octx.clearRect(0, 0, this.overCanvas.width, this.overCanvas.height);
      return;
    }
    const partidas = new Map<string, Partida>(project.partidas.map((p) => [p.id, p]));
    drawOverlay(this.octx, {
      view: this.view,
      dpr: this.dpr,
      cssW: this.cssW,
      cssH: this.cssH,
      sheet,
      measurements: project.measurements,
      partidas,
      selection: new Set(ui.selection),
      hoverId: ui.hoverId,
      showLabels: project.settings.showLabels,
      decimals: project.settings.decimals,
      unitName: sheet.kind === 'pdf' ? 'pt' : sheet.kind === 'image' ? 'px' : 'u',
      colors: this.colors,
      draft: this.draftView(sheet, partidas.get(ui.activePartidaId ?? '')),
      snap: this.snap,
      activeVertex: this.activeVertex,
      pick: this.tool === 'pick' ? (this.pick?.shape ?? null) : this.preview,
      region: this.tool === 'region' ? (this.region?.outer ?? null) : null,
      typed: this.typed,
      cursorScreen: this.cursorScreen,
      marks: this.marks,
    });
  }

  // -------------------------------------------------------------------------
  // Estado de la app → visor
  // -------------------------------------------------------------------------

  private onStore = (): void => {
    const { project, ui } = store.get();
    const sheet = project.sheets.find((s) => s.id === ui.sheetId) ?? null;
    if ((sheet?.id ?? null) !== this.sheetId) this.switchSheet(sheet);
    else if (sheet && this.runtime) this.syncHidden(sheet);
    if (ui.tool !== this.tool) {
      this.tool = ui.tool;
      this.resetTool();
    }
    this.overCanvas.style.cursor = this.cursorStyle();
    this.setStatus({ hint: sheet ? HINTS[this.tool] : '' });
    this.invalidate(false);
  };

  private resetTool(): void {
    this.draft = null;
    this.typed = null;
    this.pick = null;
    this.region = null;
    this.snap = null;
    this.activeVertex = null;
  }

  private cursorStyle(): string {
    if (this.gesture?.kind === 'press' && this.gesture.moved) return 'grabbing';
    if (this.keys.space) return 'grab';
    if (this.tool === 'select') return store.get().ui.hoverId ? 'pointer' : 'default';
    return 'crosshair';
  }

  private syncHidden(sheet: Sheet): void {
    const key = (sheet.hiddenLayers ?? []).join('\u0001');
    if (key === this.hiddenKey) return;
    this.hiddenKey = key;
    const hidden = new Set(sheet.hiddenLayers ?? []);
    const layers = this.runtime?.layers ?? [];
    this.layerHidden = hidden.size ? new Uint8Array(layers.length + 1) : null;
    if (this.layerHidden) layers.forEach((l, i) => (this.layerHidden![i + 1] = hidden.has(l.id) ? 1 : 0));
    this.plan.setHidden(hidden);
  }

  private switchSheet(sheet: Sheet | null): void {
    if (this.sheetId) this.views.set(this.sheetId, { ...this.view });
    this.sheetId = sheet?.id ?? null;
    this.runtime = null;
    this.layerHidden = null;
    this.hiddenKey = '';
    this.marks = [];
    this.preview = null;
    this.resetTool();
    this.plan.setSheet(null, null, new Set());
    const token = ++this.loadToken;
    if (!sheet) {
      this.setStatus({ loading: false, error: null, raster: false, hasVector: false });
      return;
    }
    const saved = this.views.get(sheet.id);
    if (saved) this.view = { ...saved };
    else this.fitTo(sheet);
    this.setStatus({ loading: true, error: null });
    getRuntime(sheet)
      .then((rt) => {
        if (token !== this.loadToken || this.destroyed) return;
        this.runtime = rt;
        let current = store.get().project.sheets.find((s) => s.id === sheet.id) ?? sheet;
        if (current.hiddenLayers === undefined) {
          const off = rt.layers.filter((l) => !l.visible).map((l) => l.id);
          if (off.length) {
            setLayerHidden(sheet.id, off, true);
            current = store.get().project.sheets.find((s) => s.id === sheet.id) ?? current;
          }
        }
        this.hiddenKey = '\u0000';
        this.plan.setSheet(current, rt, new Set(current.hiddenLayers ?? []));
        this.syncHidden(current);
        this.setStatus({ loading: false, raster: rt.raster, hasVector: rt.vector !== null });
        this.invalidate(true);
      })
      .catch((e: unknown) => {
        if (token !== this.loadToken) return;
        this.setStatus({ loading: false, error: e instanceof Error ? e.message : 'No se pudo abrir la lámina.' });
      });
  }

  // -------------------------------------------------------------------------
  // Vista
  // -------------------------------------------------------------------------

  private pad(): { l: number; t: number; r: number; b: number } {
    return this.cssW < 720 ? { l: 16, t: 64, r: 16, b: 96 } : { l: 84, t: 64, r: 28, b: 44 };
  }

  private fitTo(sheet: Sheet): void {
    this.view = fitView(sheet.w, sheet.h, this.cssW, this.cssH, this.pad());
    this.invalidate(true);
  }

  fit(): void {
    const sheet = currentSheet();
    if (sheet) this.fitTo(sheet);
  }

  private zoomLimits(): [number, number] {
    const sheet = currentSheet();
    if (!sheet) return [0.01, 100];
    const fitZoom = Math.min(this.cssW / sheet.w, this.cssH / sheet.h);
    return [fitZoom * 0.2, 2e6 / Math.max(sheet.w, sheet.h)];
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const [min, max] = this.zoomLimits();
    const zoom = Math.min(max, Math.max(min, this.view.zoom * factor));
    const k = zoom / this.view.zoom;
    this.view = { zoom, ox: sx - (sx - this.view.ox) * k, oy: sy - (sy - this.view.oy) * k };
    this.invalidate(true);
  }

  zoomBy(factor: number): void {
    this.zoomAt(this.cssW / 2, this.cssH / 2, factor);
  }

  /** Encuadra una caja de la lámina (p. ej. una medición elegida en la hoja). */
  zoomToBox(box: BBox): void {
    const w = Math.max(box.maxX - box.minX, 1e-9);
    const h = Math.max(box.maxY - box.minY, 1e-9);
    const pad = this.pad();
    const margin = 70;
    const [, max] = this.zoomLimits();
    const zoom = Math.min(max, (this.cssW - pad.l - pad.r - margin * 2) / w, (this.cssH - pad.t - pad.b - margin * 2) / h);
    const z = Math.max(zoom, this.zoomLimits()[0]);
    this.view = { zoom: z, ox: pad.l + (this.cssW - pad.l - pad.r) / 2 - ((box.minX + box.maxX) / 2) * z, oy: pad.t + (this.cssH - pad.t - pad.b) / 2 - ((box.minY + box.maxY) / 2) * z };
    this.invalidate(true);
  }

  zoomToMeasurement(m: Measurement): void {
    if (m.kind === 'manual' || !m.parts.length) return;
    const box = emptyBBox();
    for (const p of m.parts) partBBox(p, box);
    const sheet = currentSheet();
    // Un solo punto contado no tiene tamaño: se encuadra una zona alrededor.
    const min = sheet ? Math.max(sheet.w, sheet.h) * 0.04 : 1;
    if (box.maxX - box.minX < min) {
      box.minX -= min / 2;
      box.maxX += min / 2;
    }
    if (box.maxY - box.minY < min) {
      box.minY -= min / 2;
      box.maxY += min / 2;
    }
    this.zoomToBox(box);
  }

  /** Resalta trazos del plano (vista previa de un grupo de la lectura automática). */
  setPreview(shape: Path2D | null): void {
    this.preview = shape;
    this.invalidate(false);
  }

  /** Marcas temporales sobre el plano (coincidencias de una búsqueda de texto). */
  setMarks(pts: Pt[]): void {
    this.marks = pts;
    this.invalidate(false);
  }

  // -------------------------------------------------------------------------
  // Punto bajo el cursor: enganche y ortogonal
  // -------------------------------------------------------------------------

  private ownVertices(exclude: string | null): Pt[] {
    const ms = store.get().project.measurements;
    if (this.own.key === ms && this.own.exclude === exclude) return this.own.pts;
    const pts: Pt[] = [];
    for (const m of ms) {
      if (m.sheetId !== this.sheetId || m.id === exclude || m.kind === 'manual') continue;
      for (const p of m.parts) for (const v of p.v) pts.push(v);
      if (pts.length > 20000) break;
    }
    this.own = { key: ms, exclude, pts };
    return pts;
  }

  private resolve(pt: Pt, from: Pt | null, exclude: string | null = null): { p: Pt; snap: SnapHit | null } {
    const raw = toSheet(this.view, pt.x, pt.y);
    const ui = store.get().ui;
    if (ui.snapOn) {
      const hit = snapPoint(this.runtime?.vector ?? null, raw, { modes: ui.snaps, radius: SNAP_PX / this.view.zoom, from, layerHidden: this.layerHidden, extra: this.ownVertices(exclude) });
      if (hit) return { p: { x: hit.x, y: hit.y }, snap: hit };
    }
    if (this.keys.shift && from) {
      return Math.abs(raw.x - from.x) >= Math.abs(raw.y - from.y) ? { p: { x: raw.x, y: from.y }, snap: null } : { p: { x: from.x, y: raw.y }, snap: null };
    }
    return { p: raw, snap: null };
  }

  private lastDraftPoint(): Pt | null {
    const d = this.draft;
    if (!d) return null;
    if (d.kind === 'line' || d.kind === 'area') return d.pts[d.pts.length - 1] ?? null;
    if (d.kind === 'ruler') return d.done ? null : (d.pts[d.pts.length - 1] ?? null);
    if (d.kind === 'calibrate') return d.a;
    return null;
  }

  private mPerUnit(): number | null {
    const sheet = currentSheet();
    return sheet?.scales.find((s) => s.id === sheet.activeScaleId)?.mPerUnit ?? null;
  }

  private fmtLen(units: number): string {
    const k = this.mPerUnit();
    const d = store.get().project.settings.decimals;
    return k === null ? `${formatNumber(units, 1)} (sin escala)` : `${formatNumber(units * k, Math.max(d, 3))} m`;
  }

  private fmtArea(units2: number): string {
    const k = this.mPerUnit();
    const d = store.get().project.settings.decimals;
    return k === null ? `${formatNumber(units2, 1)} (sin escala)` : `${formatNumber(units2 * k * k, Math.max(d, 3))} m²`;
  }

  private draftView(_sheet: Sheet, partida: Partida | undefined): DraftView | null {
    const d = this.draft;
    const cur = this.cursor;
    const color = store.get().ui.deduct ? this.colors.danger : (partida?.color ?? this.colors.accent);
    if (!d) return null;
    if (d.kind === 'line' || d.kind === 'area') {
      const pts = d.pts;
      const hud: string[] = [];
      if (pts.length && cur) {
        const all = [...pts, cur];
        const seg = dist(pts[pts.length - 1], cur);
        if (d.kind === 'line') {
          const total = rawQuantities('line', [{ v: all }]).L;
          hud.push(`Tramo ${this.fmtLen(seg)}`);
          if (pts.length > 1) hud.push(`Total ${this.fmtLen(total)}`);
        } else {
          hud.push(`Tramo ${this.fmtLen(seg)}`);
          if (all.length >= 3) hud.push(`Área ${this.fmtArea(rawQuantities('area', [{ v: all, closed: true }]).A)}`);
        }
      }
      return { kind: d.kind, pts, cursor: cur, color, hud };
    }
    if (d.kind === 'rect') {
      const hud = cur ? [`${this.fmtLen(Math.abs(cur.x - d.a.x))} × ${this.fmtLen(Math.abs(cur.y - d.a.y))}`, `Área ${this.fmtArea(Math.abs((cur.x - d.a.x) * (cur.y - d.a.y)))}`] : [];
      return { kind: 'rect', pts: [d.a], cursor: cur, color, hud };
    }
    if (d.kind === 'ruler') {
      const segLabels = d.pts.slice(1).map((p, i) => this.fmtLen(dist(d.pts[i], p)));
      const hud: string[] = [];
      const last = d.pts[d.pts.length - 1];
      if (!d.done && last && cur) {
        const dx = cur.x - last.x;
        const dy = cur.y - last.y;
        hud.push(this.fmtLen(Math.hypot(dx, dy)), `Δx ${this.fmtLen(Math.abs(dx))} · Δy ${this.fmtLen(Math.abs(dy))}`, `${formatNumber((Math.atan2(-dy, dx) * 180) / Math.PI, 1)}°`);
      } else if (d.pts.length > 2) {
        hud.push(`Total ${this.fmtLen(rawQuantities('line', [{ v: d.pts }]).L)}`);
      }
      return { kind: 'ruler', pts: d.pts, cursor: d.done ? null : cur, color: this.colors.ink, hud, segLabels };
    }
    if (d.kind === 'calibrate') {
      const hud = cur ? [`En el plano: ${formatNumber(dist(d.a, cur), 2)}`, 'Clic en el otro extremo de la cota'] : [];
      return { kind: 'calibrate', pts: [d.a], cursor: cur, color: this.colors.accent, hud };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Entrada: puntero
  // -------------------------------------------------------------------------

  private local(e: { clientX: number; clientY: number }): Pt {
    const r = this.overCanvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button > 2) return;
    if (!this.sheetId) return;
    try {
      this.overCanvas.setPointerCapture(e.pointerId);
    } catch {
      /* puntero ya liberado */
    }
    const pt = this.local(e);
    this.pointers.set(e.pointerId, pt);
    if (this.pointers.size === 2) {
      this.clearPress();
      const [a, b] = [...this.pointers.values()];
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const s = toSheet(this.view, cx, cy);
      this.gesture = { kind: 'pinch', d0: Math.max(1, dist(a, b)), zoom0: this.view.zoom, sx: s.x, sy: s.y };
      this.snap = null;
      this.cursor = null;
      return;
    }
    if (this.pointers.size > 2) return;
    const forcePan = e.button === 1 || e.button === 2 || this.keys.space;
    if (!forcePan && this.tool === 'select') {
      const h = this.hitHandle(pt, e.pointerType === 'mouse' ? HANDLE_PX : 20);
      if (h) {
        if (h.insert) this.insertVertex(h.mId, h.part, h.index, h.insert);
        this.activeVertex = { id: h.mId, part: h.part, index: h.index };
        this.gesture = { kind: 'vertex', id: e.pointerId, mId: h.mId, part: h.part, index: h.index };
        store.breakCoalesce();
        this.invalidate(false);
        return;
      }
    }
    const touch = e.pointerType !== 'mouse';
    const g: Gesture = { kind: 'press', id: e.pointerId, x: pt.x, y: pt.y, ox: this.view.ox, oy: this.view.oy, moved: false, pan: forcePan, button: e.button, touch, aim: false, timer: null };
    // Táctil: mantener pulsado activa el modo de puntería (el punto se coloca al soltar, por encima del dedo).
    if (touch && this.tool !== 'select' && !forcePan) {
      g.timer = setTimeout(() => {
        g.timer = null;
        if (this.gesture !== g || g.moved) return;
        g.aim = true;
        this.hover({ x: g.x, y: g.y - 56 });
      }, 320);
    }
    this.gesture = g;
    if (touch && this.tool !== 'select') this.hover(pt);
  };

  private clearPress(): void {
    const g = this.gesture;
    if (g?.kind === 'press' && g.timer) clearTimeout(g.timer);
  }

  private onMove = (e: PointerEvent): void => {
    const pt = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, pt);
    const g = this.gesture;
    if (g?.kind === 'pinch') {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const [min, max] = this.zoomLimits();
      const zoom = Math.min(max, Math.max(min, (g.zoom0 * dist(a, b)) / g.d0));
      this.view = { zoom, ox: (a.x + b.x) / 2 - g.sx * zoom, oy: (a.y + b.y) / 2 - g.sy * zoom };
      this.invalidate(true);
      return;
    }
    if (g?.kind === 'vertex') {
      if (g.id === e.pointerId) this.dragVertex(g, pt);
      return;
    }
    if (g?.kind === 'press') {
      if (g.id !== e.pointerId) return;
      if (g.aim) {
        this.hover({ x: pt.x, y: pt.y - 56 });
        return;
      }
      const dx = pt.x - g.x;
      const dy = pt.y - g.y;
      if (!g.moved && Math.hypot(dx, dy) > (g.touch ? 10 : 4)) {
        g.moved = true;
        if (g.timer) clearTimeout(g.timer);
        this.snap = null;
        this.overCanvas.style.cursor = 'grabbing';
      }
      if (g.moved) {
        this.view = { ...this.view, ox: g.ox + dx, oy: g.oy + dy };
        this.invalidate(true);
      }
      return;
    }
    if (e.pointerType === 'mouse') this.hover(pt);
  };

  private onUp = (e: PointerEvent): void => {
    const pt = this.local(e);
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'pinch') {
      if (this.pointers.size < 2) this.gesture = null;
      return;
    }
    if (g.kind === 'vertex') {
      if (g.id !== e.pointerId) return;
      this.gesture = null;
      store.breakCoalesce();
      return;
    }
    if (g.id !== e.pointerId) return;
    this.clearPress();
    this.gesture = null;
    this.overCanvas.style.cursor = this.cursorStyle();
    if (g.moved && !g.aim) return;
    const at = g.aim ? { x: pt.x, y: pt.y - 56 } : pt;
    if (g.button === 2) this.finishDraft() || this.cancelDraft();
    else if (g.button === 0 && !g.pan) this.click(at, e.shiftKey);
    if (g.touch) {
      this.snap = null;
      this.cursor = null;
      this.invalidate(false);
    }
  };

  private onCancel = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.clearPress();
    if (this.gesture?.kind === 'vertex') store.breakCoalesce();
    this.gesture = null;
  };

  private onLeave = (): void => {
    if (this.gesture) return;
    this.cursorScreen = null;
    this.cursor = null;
    this.snap = null;
    this.pick = null;
    this.region = null;
    if (store.get().ui.hoverId) store.setUi({ hoverId: null });
    this.invalidate(false);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (!this.sheetId) return;
    const pt = this.local(e);
    const k = e.ctrlKey ? 0.012 : e.deltaMode === 1 ? 0.06 : 0.0018;
    this.zoomAt(pt.x, pt.y, Math.min(2.5, Math.max(0.4, Math.exp(-e.deltaY * k))));
    if (!this.gesture) this.hover(pt);
  };

  private onDblClick = (e: MouseEvent): void => {
    e.preventDefault();
    if (this.tool === 'select') {
      const hit = this.hitMeasurement(this.local(e));
      if (hit) store.setUi({ selection: [hit.id], panelOpen: true, panelTab: 'partidas', activePartidaId: hit.partidaId });
      return;
    }
    this.finishDraft();
  };

  private onContext = (e: Event): void => {
    e.preventDefault();
  };

  // -------------------------------------------------------------------------
  // Movimiento del cursor según la herramienta
  // -------------------------------------------------------------------------

  private hover(pt: Pt): void {
    this.cursorScreen = pt;
    const ui = store.get().ui;
    if (this.tool === 'select') {
      const hit = this.hitMeasurement(pt);
      const id = hit?.id ?? null;
      if (id !== ui.hoverId) store.setUi({ hoverId: id });
      this.overCanvas.style.cursor = this.hitHandle(pt) ? 'move' : this.cursorStyle();
      this.snap = null;
      this.cursor = null;
    } else if (this.tool === 'pick') {
      const raw = toSheet(this.view, pt.x, pt.y);
      const np = nearestPath(this.runtime?.vector ?? null, raw, 9 / this.view.zoom, this.layerHidden);
      if (!np) this.pick = null;
      else if (this.pick?.path !== np.path) {
        const shape = new Path2D();
        tracePart(shape, partOfPath(this.runtime!.vector!, np.path));
        this.pick = { path: np.path, shape };
      }
      this.cursor = raw;
      this.snap = null;
    } else if (this.tool === 'region') {
      const raw = toSheet(this.view, pt.x, pt.y);
      this.cursor = raw;
      this.snap = null;
      if (this.regionTimer) clearTimeout(this.regionTimer);
      this.regionTimer = setTimeout(() => {
        this.regionTimer = null;
        this.region = this.detectRegion(raw);
        this.invalidate(false);
      }, 45);
    } else {
      const r = this.resolve(pt, this.lastDraftPoint());
      this.cursor = r.p;
      this.snap = r.snap;
    }
    this.invalidate(false);
  }

  private detectRegion(p: Pt): { outer: Pt[]; holes: Pt[][] } | null {
    const v = this.runtime?.vector;
    const sheet = currentSheet();
    if (!v || !sheet) return null;
    const hidden = this.layerHidden;
    const k = this.mPerUnit();
    const gap = store.get().ui.regionGap;
    const res = findRegion(v.xy, p, {
      bridge: k !== null && gap > 0 ? gap / k : 0,
      eps: sheet.kind === 'pdf' ? 0.05 : Math.max(sheet.w, sheet.h) * 1e-6,
      bounds: { minX: 0, minY: 0, maxX: sheet.w, maxY: sheet.h },
      query: (a, b, c, d) => queryBox(v, a, b, c, d),
      accept: hidden ? (i) => !hidden[v.pathLayer[v.pathOf[i]]] : undefined,
    });
    return res.ok ? { outer: res.outer, holes: res.holes } : null;
  }

  // -------------------------------------------------------------------------
  // Selección y edición de vértices
  // -------------------------------------------------------------------------

  private hitMeasurement(pt: Pt): Measurement | null {
    const { project, ui } = store.get();
    let best: Measurement | null = null;
    let bestD = Infinity;
    for (let i = project.measurements.length - 1; i >= 0; i--) {
      const m = project.measurements[i];
      if (m.sheetId !== this.sheetId || m.kind === 'manual') continue;
      let d = hitDistance(m, this.view, pt.x, pt.y);
      // A igual distancia gana la que ya está seleccionada; un área solo gana "por dentro" si nada más cerca.
      if (ui.selection.includes(m.id)) d -= 0.5;
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  private hitHandle(pt: Pt, tol = HANDLE_PX): Handle | null {
    const { project, ui } = store.get();
    if (!ui.selection.length) return null;
    const st: { best: Handle | null; d: number } = { best: null, d: tol };
    const selected = project.measurements.filter((m) => m.sheetId === this.sheetId && m.kind !== 'manual' && ui.selection.includes(m.id));
    for (const m of selected) {
      m.parts.forEach((part, pi) => {
        part.v.forEach((v, i) => {
          const d = Math.hypot(toScreenX(this.view, v.x) - pt.x, toScreenY(this.view, v.y) - pt.y);
          if (d < st.d) {
            st.d = d;
            st.best = { mId: m.id, part: pi, index: i };
          }
        });
      });
    }
    if (st.best) return st.best;
    // Puntos medios de los tramos rectos: arrastrarlos inserta un vértice.
    for (const m of selected) {
      if (m.kind === 'count') continue;
      m.parts.forEach((part, pi) => {
        const v = part.v;
        const closed = part.closed || m.kind === 'area';
        for (let i = 0; i < (closed ? v.length : v.length - 1); i++) {
          const a = v[i];
          const b = v[(i + 1) % v.length];
          if (a.c || (a.b !== undefined && Math.abs(a.b) > 1e-12)) continue;
          const ax = toScreenX(this.view, a.x);
          const ay = toScreenY(this.view, a.y);
          const bx = toScreenX(this.view, b.x);
          const by = toScreenY(this.view, b.y);
          if (Math.hypot(bx - ax, by - ay) < 36) continue;
          const d = Math.hypot((ax + bx) / 2 - pt.x, (ay + by) / 2 - pt.y);
          if (d < st.d) {
            st.d = d;
            st.best = { mId: m.id, part: pi, index: i + 1, insert: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
          }
        }
      });
    }
    return st.best;
  }

  private insertVertex(mId: string, part: number, index: number, at: Pt): void {
    const m = store.get().project.measurements.find((x) => x.id === mId);
    if (!m) return;
    const parts = m.parts.map((p, i) => (i === part ? { ...p, v: [...p.v.slice(0, index), { x: at.x, y: at.y }, ...p.v.slice(index)] } : p));
    patchMeasurement(mId, { parts });
  }

  private dragVertex(g: Extract<Gesture, { kind: 'vertex' }>, pt: Pt): void {
    const m = store.get().project.measurements.find((x) => x.id === g.mId);
    const part = m?.parts[g.part];
    const old = part?.v[g.index];
    if (!m || !part || !old) return;
    const prev = part.v[(g.index - 1 + part.v.length) % part.v.length];
    const r = this.resolve(pt, part.v.length > 1 ? prev : null, m.id);
    this.snap = r.snap;
    this.cursorScreen = pt;
    if (r.p.x === old.x && r.p.y === old.y) {
      this.invalidate(false);
      return;
    }
    const dx = r.p.x - old.x;
    const dy = r.p.y - old.y;
    const v = part.v.map((p, i): Vtx => {
      if (i === g.index) {
        const moved: Vtx = { ...p, x: r.p.x, y: r.p.y };
        if (p.c) moved.c = [p.c[0] + dx, p.c[1] + dy, p.c[2], p.c[3]];
        return moved;
      }
      // El tirador de llegada de la curva anterior acompaña al vértice.
      if (p.c && (i + 1) % part.v.length === g.index) return { ...p, c: [p.c[0], p.c[1], p.c[2] + dx, p.c[3] + dy] };
      return p;
    });
    patchMeasurement(m.id, { parts: m.parts.map((p, i) => (i === g.part ? { ...p, v } : p)) }, `drag:${m.id}`);
  }

  private deleteActiveVertex(): boolean {
    const a = this.activeVertex;
    if (!a) return false;
    const m = store.get().project.measurements.find((x) => x.id === a.id);
    const part = m?.parts[a.part];
    if (!m || !part) return false;
    const min = m.kind === 'area' ? 3 : m.kind === 'line' ? 2 : 1;
    this.activeVertex = null;
    if (part.v.length <= min) {
      const parts = m.parts.filter((_, i) => i !== a.part);
      if (parts.length) patchMeasurement(m.id, { parts });
      else removeMeasurements([m.id]);
      return true;
    }
    const v = part.v.filter((_, i) => i !== a.index).map((p): Vtx => ({ x: p.x, y: p.y }));
    patchMeasurement(m.id, { parts: m.parts.map((p, i) => (i === a.part ? { ...p, v } : p)) });
    return true;
  }

  // -------------------------------------------------------------------------
  // Clics de cada herramienta
  // -------------------------------------------------------------------------

  private click(pt: Pt, shift: boolean): void {
    const tool = this.tool;
    if (tool === 'select') {
      const hit = this.hitMeasurement(pt);
      this.activeVertex = null;
      const sel = store.get().ui.selection;
      if (!hit) store.setUi({ selection: [] });
      else if (shift) store.setUi({ selection: sel.includes(hit.id) ? sel.filter((x) => x !== hit.id) : [...sel, hit.id] });
      else store.setUi({ selection: [hit.id], activePartidaId: hit.partidaId });
      return;
    }
    if (tool === 'pick') {
      this.clickPick(shift);
      return;
    }
    if (tool === 'region') {
      this.clickRegion(pt);
      return;
    }
    const { p, snap } = this.resolve(pt, this.lastDraftPoint());
    this.cursor = p;
    this.snap = snap;
    this.placePoint(p);
  }

  private placePoint(p: Pt): void {
    const tool = this.tool;
    const tooClose = (a: Pt | undefined): boolean => !!a && dist(a, p) * this.view.zoom < 2;
    if (tool === 'line' || tool === 'area') {
      if (!this.draft || this.draft.kind !== tool) this.draft = { kind: tool, pts: [] };
      const d = this.draft as Extract<Draft, { kind: 'line' | 'area' }>;
      if (tool === 'area' && d.pts.length >= 3 && dist(d.pts[0], p) * this.view.zoom < 10) {
        this.finishDraft();
        return;
      }
      if (!tooClose(d.pts[d.pts.length - 1])) d.pts.push(p);
    } else if (tool === 'rect') {
      if (this.draft?.kind !== 'rect') this.draft = { kind: 'rect', a: p };
      else {
        const a = this.draft.a;
        this.draft = null;
        if (Math.abs(p.x - a.x) * this.view.zoom >= 2 && Math.abs(p.y - a.y) * this.view.zoom >= 2) {
          addMeasurement({ kind: 'area', parts: [{ v: [a, { x: p.x, y: a.y }, p, { x: a.x, y: p.y }], closed: true }] });
        }
      }
    } else if (tool === 'count') {
      const cur = this.draft?.kind === 'count' ? store.get().project.measurements.find((m) => m.id === (this.draft as { id: string }).id) : undefined;
      if (cur && cur.kind === 'count' && cur.partidaId === store.get().ui.activePartidaId && cur.sheetId === this.sheetId) {
        patchMeasurement(cur.id, { parts: [{ v: [...(cur.parts[0]?.v ?? []), p] }] });
      } else {
        const id = addMeasurement({ kind: 'count', parts: [{ v: [p] }] });
        this.draft = id ? { kind: 'count', id } : null;
      }
    } else if (tool === 'ruler') {
      if (this.draft?.kind !== 'ruler' || this.draft.done) this.draft = { kind: 'ruler', pts: [p], done: false };
      else if (!tooClose(this.draft.pts[this.draft.pts.length - 1])) this.draft.pts.push(p);
    } else if (tool === 'calibrate') {
      if (this.draft?.kind !== 'calibrate') this.draft = { kind: 'calibrate', a: p };
      else {
        const a = this.draft.a;
        if (dist(a, p) * this.view.zoom < 4) return;
        this.draft = null;
        const sheet = currentSheet();
        if (sheet) store.setUi({ dialog: { type: 'scale', sheetId: sheet.id, calib: { a, b: p } } });
      }
    }
    this.typed = null;
    this.invalidate(false);
  }

  /** Termina el trazo en curso. Devuelve true si había algo que terminar. */
  finishDraft(close = false): boolean {
    const d = this.draft;
    if (!d) return false;
    this.typed = null;
    if (d.kind === 'line') {
      if (d.pts.length < 2) return false;
      this.draft = null;
      addMeasurement({ kind: 'line', parts: [close && d.pts.length >= 3 ? { v: d.pts, closed: true } : { v: d.pts }] });
    } else if (d.kind === 'area') {
      if (d.pts.length < 3) return false;
      this.draft = null;
      addMeasurement({ kind: 'area', parts: [{ v: d.pts, closed: true }] });
    } else if (d.kind === 'ruler') {
      if (d.done || d.pts.length < 2) return false;
      d.done = true;
    } else if (d.kind === 'count') {
      this.draft = null;
      store.setUi({ selection: [] });
    } else return false;
    this.invalidate(false);
    return true;
  }

  cancelDraft(): boolean {
    if (!this.draft && this.typed === null) return false;
    this.draft = null;
    this.typed = null;
    this.invalidate(false);
    return true;
  }

  private clickPick(shift: boolean): void {
    const v = this.runtime?.vector;
    const partida = store.get().project.partidas.find((p) => p.id === store.get().ui.activePartidaId);
    if (!v || !partida) {
      if (!v) store.toast('Esta lámina es una imagen: no tiene líneas que tomar. Usa Longitud o Área y marca los puntos.', 'info');
      return;
    }
    if (!this.pick) return;
    const part = partOfPath(v, this.pick.path);
    const closed = (v.pathFlags[this.pick.path] & PATH_CLOSED) !== 0 || (part.v.length > 2 && dist(part.v[0], part.v[part.v.length - 1]) === 0);
    const sel = store.get().ui.selection;
    const target = shift && sel.length === 1 ? store.get().project.measurements.find((m) => m.id === sel[0] && m.partidaId === partida.id && m.sheetId === this.sheetId) : undefined;
    if (partida.base === 'N') {
      const box = partBBox(part);
      const c = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
      if (target?.kind === 'count') patchMeasurement(target.id, { parts: [{ v: [...(target.parts[0]?.v ?? []), c] }] });
      else addMeasurement({ kind: 'count', parts: [{ v: [c] }] });
      return;
    }
    if (partida.base === 'L') {
      const p: Part = closed ? { v: part.v, closed: true } : { v: part.v };
      if (target?.kind === 'line') patchMeasurement(target.id, { parts: [...target.parts, p] });
      else addMeasurement({ kind: 'line', parts: [p] });
      return;
    }
    if (!closed) {
      store.toast('Ese trazo no está cerrado: no tiene área. Usa «Área automática» o dibuja el contorno con Área.', 'info');
      return;
    }
    const ring: Part = { v: part.v, closed: true };
    if (target?.kind === 'area') patchMeasurement(target.id, { parts: [...target.parts, ring] });
    else addMeasurement({ kind: 'area', parts: [ring] });
  }

  private clickRegion(pt: Pt): void {
    if (!this.runtime?.vector) {
      store.toast('Esta lámina es una imagen: no se pueden detectar recintos. Dibuja el contorno con Área.', 'info');
      return;
    }
    const region = this.detectRegion(toSheet(this.view, pt.x, pt.y));
    const partida = store.get().project.partidas.find((p) => p.id === store.get().ui.activePartidaId);
    if (!region || !partida) {
      if (!region) store.toast('Aquí no hay un recinto cerrado (puede tener una abertura). Dibuja el contorno con Área, enganchando a las esquinas.', 'info');
      return;
    }
    this.region = null;
    if (partida.base === 'L') addMeasurement({ kind: 'line', parts: [{ v: region.outer, closed: true }] });
    else addMeasurement({ kind: 'area', parts: [{ v: region.outer, closed: true }] });
  }

  // -------------------------------------------------------------------------
  // Teclado
  // -------------------------------------------------------------------------

  private onBlur = (): void => {
    this.keys.space = false;
    this.keys.shift = false;
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === ' ') this.keys.space = false;
    if (e.key === 'Shift') {
      this.keys.shift = false;
      if (this.cursorScreen && !this.gesture) this.hover(this.cursorScreen);
    }
    this.overCanvas.style.cursor = this.cursorStyle();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const { ui } = store.get();
    if (isTyping(e.target) || ui.dialog || ui.tableOpen) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    if (mod && key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else if (!this.undoDraftPoint()) store.undo();
      return;
    }
    if (mod && key.toLowerCase() === 'y') {
      e.preventDefault();
      store.redo();
      return;
    }
    if (mod || e.altKey) return;
    if (key === 'Shift') {
      this.keys.shift = true;
      if (this.cursorScreen && !this.gesture) this.hover(this.cursorScreen);
      return;
    }
    if (key === ' ') {
      e.preventDefault();
      this.keys.space = true;
      this.overCanvas.style.cursor = 'grab';
      return;
    }
    // Longitud exacta del tramo: teclear un número mientras se dibuja.
    const canType = this.lastDraftPoint() !== null && this.draft?.kind !== 'calibrate';
    if (canType && (/^[0-9]$/.test(key) || ((key === '.' || key === ',') && this.typed !== null && !/[.,]/.test(this.typed)))) {
      e.preventDefault();
      this.typed = (this.typed ?? '') + key;
      this.invalidate(false);
      return;
    }
    switch (key) {
      case 'Enter':
        e.preventDefault();
        if (this.typed !== null) this.commitTyped();
        else this.finishDraft();
        return;
      case 'Escape':
        if (this.cancelDraft()) return;
        if (this.marks.length) {
          this.setMarks([]);
          return;
        }
        if (ui.selection.length) {
          this.activeVertex = null;
          store.setUi({ selection: [] });
        } else if (ui.tool !== 'select') setTool('select');
        return;
      case 'Backspace':
      case 'Delete':
        e.preventDefault();
        if (this.typed !== null) {
          this.typed = this.typed.length > 1 ? this.typed.slice(0, -1) : null;
          this.invalidate(false);
        } else if (this.undoDraftPoint()) {
          /* se quitó el último punto del trazo en curso */
        } else if (!this.deleteActiveVertex()) removeMeasurements(ui.selection);
        return;
    }
    if (this.typed !== null) return;
    const k = key.toLowerCase();
    if (k === 'c' && this.draft?.kind === 'line' && this.draft.pts.length >= 3) {
      this.finishDraft(true);
      return;
    }
    const tools: Record<string, ToolId> = { v: 'select', l: 'line', a: 'area', r: 'rect', c: 'count', m: 'ruler', t: 'pick', b: 'region', k: 'calibrate' };
    if (tools[k]) setTool(tools[k]);
    else if (k === 'f') this.fit();
    else if (k === '+' || k === '=') this.zoomBy(1.4);
    else if (k === '-') this.zoomBy(1 / 1.4);
    else if (k === 's' || key === 'F3') {
      e.preventDefault();
      store.setUi({ snapOn: !ui.snapOn });
      store.toast(ui.snapOn ? 'Enganche al plano desactivado' : 'Enganche al plano activado');
    } else if (k === 'd' && TOOL_BASES[ui.tool]) store.setUi({ deduct: !ui.deduct });
  };

  /** Quita el último punto del trazo en curso (o del grupo de conteo). */
  undoDraftPoint(): boolean {
    const d = this.draft;
    if (!d) return false;
    if (d.kind === 'line' || d.kind === 'area') {
      d.pts.pop();
      if (!d.pts.length) this.draft = null;
    } else if (d.kind === 'ruler') {
      if (d.done) this.draft = null;
      else {
        d.pts.pop();
        if (!d.pts.length) this.draft = null;
      }
    } else if (d.kind === 'count') {
      const m = store.get().project.measurements.find((x) => x.id === d.id);
      const pts = m?.parts[0]?.v ?? [];
      if (!m) {
        this.draft = null;
        return false;
      }
      if (pts.length <= 1) {
        removeMeasurements([m.id]);
        this.draft = null;
      } else patchMeasurement(m.id, { parts: [{ v: pts.slice(0, -1) }] });
    } else this.draft = null;
    this.invalidate(false);
    return true;
  }

  private commitTyped(): void {
    const from = this.lastDraftPoint();
    const value = this.typed === null ? null : parseNumber(this.typed);
    this.typed = null;
    if (!from || value === null || !(value > 0)) {
      this.invalidate(false);
      return;
    }
    const k = this.mPerUnit();
    const len = k === null ? value : value / k;
    const to = this.cursor ?? { x: from.x + 1, y: from.y };
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    const n = Math.hypot(dx, dy);
    if (n === 0) {
      dx = 1;
      dy = 0;
    } else {
      dx /= n;
      dy /= n;
    }
    const p = { x: from.x + dx * len, y: from.y + dy * len };
    this.placePoint(p);
    // Deja el punto nuevo a la vista.
    const sx = toScreenX(this.view, p.x);
    const sy = toScreenY(this.view, p.y);
    if (sx < 40 || sy < 40 || sx > this.cssW - 40 || sy > this.cssH - 40) {
      this.view = { ...this.view, ox: this.view.ox + (this.cssW / 2 - sx), oy: this.view.oy + (this.cssH / 2 - sy) };
      this.invalidate(true);
    }
  }

  /** Caja de la lámina que se ve ahora (para crear cosas "en lo visible"). */
  visibleBox(): BBox {
    const a = toSheet(this.view, 0, 0);
    const b = toSheet(this.view, this.cssW, this.cssH);
    const box = emptyBBox();
    extendBBox(box, a.x, a.y);
    extendBBox(box, b.x, b.y);
    return box;
  }

  /** Geometría derivada de una medición (para que la interfaz no dependa del módulo de dibujo). */
  static geo = geoOf;
}

/** El visor montado en pantalla (lo usan los botones de zoom, la hoja de metrados, la búsqueda de texto…). */
export const viewer: { current: ViewerController | null } = { current: null };
