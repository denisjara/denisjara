/**
 * Planos cargados en memoria: abrir archivos (PDF, DXF, imágenes), convertirlos en láminas y preparar, para cada
 * lámina, lo que el visor necesita: cómo dibujarla y su geometría vectorial para enganchar y leer.
 *
 * Nada de esto se guarda en el proyecto (son objetos del navegador): el proyecto solo referencia los archivos
 * por su identificador y aquí se vuelven a abrir cuando hace falta.
 */
import { newId, type DrawingUnit, type PlanFile, type ScaleDef, type Sheet, type SheetKind } from '../core/model';
import { detectScales, drawingUnitFromInsUnits, guessDrawingUnit, UNIT_LABEL, UNIT_TO_M } from '../core/units';
import type { VectorData } from '../core/vector';
import { buildDxfScene, drawDxfScene, type DxfScene } from '../io/dxf/scene';
import { extractPdfPage, type OptionalContentLike, type PdfLib, type PdfPageLike, type PlanLayer, type PlanStyle, type PlanText } from '../io/pdf/extract';
import { openPdf, pdfLib, PdfPasswordError, type PDFDocumentProxy, type PDFPageProxy } from '../io/pdf/pdfjs';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RenderJob {
  /** El canvas con la región dibujada, o null si se canceló. */
  promise: Promise<HTMLCanvasElement | null>;
  cancel(): void;
}

export interface SheetRuntime {
  sheetId: string;
  kind: SheetKind;
  /** Dibuja una región de la lámina a `scale` píxeles por unidad. */
  render(region: Rect, scale: number, hidden: ReadonlySet<string>): RenderJob;
  /** Geometría vectorial (null en imágenes). */
  vector: VectorData | null;
  layers: PlanLayer[];
  styles: PlanStyle[];
  texts: PlanText[];
  /** La lámina es una imagen (foto o escaneo): no hay líneas a las que engancharse. */
  raster: boolean;
  /** Escalas 1:N que aparecen escritas en la lámina. */
  ratios: number[];
  /** Solo DXF. */
  dxf?: DxfScene;
}

interface LoadedFile {
  blob: Blob;
  kind: SheetKind;
  pdf?: Promise<PDFDocumentProxy>;
  dxf?: Promise<DxfScene>;
  image?: Promise<ImageBitmap>;
}

const loaded = new Map<string, LoadedFile>();
const runtimes = new Map<string, Promise<SheetRuntime>>();

export function registerFile(file: PlanFile, blob: Blob): void {
  if (!loaded.has(file.id)) loaded.set(file.id, { blob, kind: file.kind });
}

export const fileBlob = (fileId: string): Blob | null => loaded.get(fileId)?.blob ?? null;
export const hasFile = (fileId: string): boolean => loaded.has(fileId);

export function forgetFile(fileId: string): void {
  const f = loaded.get(fileId);
  if (!f) return;
  loaded.delete(fileId);
  void f.pdf?.then((d) => d.destroy()).catch(() => undefined);
  void f.image?.then((b) => b.close()).catch(() => undefined);
}

export function forgetSheet(sheetId: string): void {
  runtimes.delete(sheetId);
}

function pdfOf(fileId: string): Promise<PDFDocumentProxy> {
  const f = loaded.get(fileId);
  if (!f) return Promise.reject(new Error('Falta el archivo del plano. Vuelve a abrirlo.'));
  f.pdf ??= f.blob.arrayBuffer().then((buf) => openPdf(new Uint8Array(buf)));
  return f.pdf;
}

function dxfOf(fileId: string): Promise<DxfScene> {
  const f = loaded.get(fileId);
  if (!f) return Promise.reject(new Error('Falta el archivo del plano. Vuelve a abrirlo.'));
  f.dxf ??= (async () => {
    const { parseDxf } = await import('../io/dxf/parser');
    return buildDxfScene(await parseDxf(await f.blob.arrayBuffer()));
  })();
  return f.dxf;
}

function imageOf(fileId: string): Promise<ImageBitmap> {
  const f = loaded.get(fileId);
  if (!f) return Promise.reject(new Error('Falta el archivo del plano. Vuelve a abrirlo.'));
  f.image ??= createImageBitmap(f.blob).catch(() => {
    throw new Error('No se pudo leer la imagen. Usa PNG, JPG o WebP.');
  });
  return f.image;
}

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function pdfRender(doc: PDFDocumentProxy, page: PDFPageProxy, layers: PlanLayer[]) {
  return (region: Rect, scale: number, hidden: ReadonlySet<string>): RenderJob => {
    const canvas = newCanvas(region.w * scale, region.h * scale);
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<unknown> } | null = null;
    const promise = (async () => {
      let oc: Promise<unknown> | undefined;
      if (layers.length) {
        const cfg = await doc.getOptionalContentConfig();
        for (const l of layers) cfg.setVisibility(l.id, !hidden.has(l.id));
        oc = Promise.resolve(cfg);
      }
      if (cancelled) return null;
      const viewport = page.getViewport({ scale, offsetX: -region.x * scale, offsetY: -region.y * scale });
      task = page.render({ canvas, viewport, background: '#ffffff', optionalContentConfigPromise: oc as never });
      try {
        await task.promise;
      } catch (e) {
        if (cancelled || (e as { name?: string })?.name === 'RenderingCancelledException') return null;
        throw e;
      }
      return cancelled ? null : canvas;
    })();
    return {
      promise,
      cancel() {
        cancelled = true;
        task?.cancel();
      },
    };
  };
}

async function buildRuntime(sheet: Sheet): Promise<SheetRuntime> {
  if (sheet.kind === 'pdf') {
    const doc = await pdfOf(sheet.fileId);
    const page = await doc.getPage(sheet.page ?? 1);
    const oc = await doc.getOptionalContentConfig();
    const pv = await extractPdfPage(page as unknown as PdfPageLike, pdfLib() as unknown as PdfLib, oc as unknown as OptionalContentLike);
    return {
      sheetId: sheet.id,
      kind: 'pdf',
      render: pdfRender(doc, page, pv.layers),
      vector: pv.vector.count > 0 ? pv.vector : null,
      layers: pv.layers,
      styles: pv.styles,
      texts: pv.texts,
      raster: pv.raster,
      ratios: detectScales(pv.texts.map((t) => t.str)),
    };
  }
  if (sheet.kind === 'dxf') {
    const scene = await dxfOf(sheet.fileId);
    return {
      sheetId: sheet.id,
      kind: 'dxf',
      render(region, scale, hidden) {
        const canvas = newCanvas(region.w * scale, region.h * scale);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        drawDxfScene(ctx, scene, region.x, region.y, region.w, region.h, scale, hidden);
        return { promise: Promise.resolve(canvas), cancel() {} };
      },
      vector: scene.vector.count > 0 ? scene.vector : null,
      layers: scene.layers,
      styles: scene.styles,
      texts: scene.texts,
      raster: false,
      ratios: [],
      dxf: scene,
    };
  }
  const bitmap = await imageOf(sheet.fileId);
  return {
    sheetId: sheet.id,
    kind: 'image',
    render(region, scale) {
      const canvas = newCanvas(region.w * scale, region.h * scale);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height);
      return { promise: Promise.resolve(canvas), cancel() {} };
    },
    vector: null,
    layers: [],
    styles: [],
    texts: [],
    raster: true,
    ratios: [],
  };
}

/** Lo necesario para mostrar y leer una lámina. Se calcula una vez y se reutiliza. */
export function getRuntime(sheet: Sheet): Promise<SheetRuntime> {
  let r = runtimes.get(sheet.id);
  if (!r) {
    r = buildRuntime(sheet);
    runtimes.set(sheet.id, r);
    r.catch(() => runtimes.delete(sheet.id));
  }
  return r;
}

// ---------------------------------------------------------------------------
// Abrir archivos
// ---------------------------------------------------------------------------

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

async function sniffKind(file: File): Promise<SheetKind | 'dwg' | 'tiff' | null> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const ascii = String.fromCharCode(...head.subarray(0, 64));
  if (ascii.includes('%PDF-')) return 'pdf';
  if (/^AC10\d\d/.test(ascii)) return 'dwg';
  if (ascii.startsWith('II*\0') || ascii.startsWith('MM\0*')) return 'tiff';
  if (file.type.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'image';
  if (/\.dxf$/i.test(file.name) || ascii.startsWith('AutoCAD Binary DXF') || /^\s*0\s*\r?\n\s*SECTION/.test(String.fromCharCode(...head))) return 'dxf';
  if (/\.pdf$/i.test(file.name)) return 'pdf';
  return null;
}

export interface ImportResult {
  files: PlanFile[];
  sheets: Sheet[];
  errors: string[];
  /** Hay un DXF nuevo cuya unidad de dibujo conviene confirmar. */
  askUnits: boolean;
}

const baseName = (name: string): string => name.replace(/\.[^.]+$/, '');

export function unitScale(unit: DrawingUnit): ScaleDef {
  return { id: newId('esc'), name: `1 unidad = 1 ${unit === 'm' ? 'metro' : UNIT_LABEL[unit].replace(/s$/, '')}`, mPerUnit: UNIT_TO_M[unit], source: 'units', unit };
}

/** Abre los archivos elegidos y devuelve los planos y láminas que hay que añadir al proyecto. */
export async function importFiles(input: File[], onProgress: (text: string) => void): Promise<ImportResult> {
  const result: ImportResult = { files: [], sheets: [], errors: [], askUnits: false };
  for (const file of input) {
    const kind = await sniffKind(file);
    if (kind === 'dwg') {
      result.errors.push(`${file.name}: es un DWG. Ábrelo en AutoCAD y usa «Guardar como → DXF» (o imprímelo a PDF); la geometría se lee igual de exacta.`);
      continue;
    }
    if (kind === 'tiff') {
      result.errors.push(`${file.name}: los navegadores no leen TIFF. Conviértelo a PDF, PNG o JPG.`);
      continue;
    }
    if (!kind) {
      result.errors.push(`${file.name}: formato no admitido. Usa PDF, DXF o una imagen (PNG, JPG, WebP).`);
      continue;
    }
    const meta: PlanFile = { id: newId('file'), name: file.name, kind, size: file.size };
    registerFile(meta, file);
    onProgress(`Abriendo ${file.name}…`);
    try {
      if (kind === 'pdf') {
        const doc = await pdfOf(meta.id);
        const many = doc.numPages > 1;
        for (let n = 1; n <= doc.numPages; n++) {
          if (many && n % 10 === 0) onProgress(`Abriendo ${file.name}… página ${n} de ${doc.numPages}`);
          const page = await doc.getPage(n);
          const vp = page.getViewport({ scale: 1 });
          result.sheets.push({ id: newId('lam'), fileId: meta.id, kind, name: many ? `${baseName(file.name)} · pág. ${n}` : baseName(file.name), page: n, w: vp.width, h: vp.height, scales: [], activeScaleId: null });
        }
      } else if (kind === 'dxf') {
        onProgress(`Leyendo la geometría de ${file.name}…`);
        const scene = await dxfOf(meta.id);
        const unit = drawingUnitFromInsUnits(scene.insUnits) ?? guessDrawingUnit(Math.max(scene.w, scene.h) / 1.04);
        const scale = unitScale(unit);
        const hidden = scene.layers.filter((l) => !l.visible).map((l) => l.id);
        const sheet: Sheet = { id: newId('lam'), fileId: meta.id, kind, name: baseName(file.name), w: scene.w, h: scene.h, scales: [scale], activeScaleId: scale.id };
        if (hidden.length) sheet.hiddenLayers = hidden;
        result.sheets.push(sheet);
        result.askUnits = true;
        for (const w of scene.warnings.slice(0, 3)) result.errors.push(`${file.name}: ${w}`);
      } else {
        const bmp = await imageOf(meta.id);
        result.sheets.push({ id: newId('lam'), fileId: meta.id, kind, name: baseName(file.name), w: bmp.width, h: bmp.height, scales: [], activeScaleId: null });
      }
      result.files.push(meta);
    } catch (e) {
      forgetFile(meta.id);
      result.sheets = result.sheets.filter((s) => s.fileId !== meta.id);
      const msg = e instanceof PdfPasswordError ? 'está protegido con contraseña. Quítale la protección y vuelve a abrirlo.' : e instanceof Error ? e.message : 'no se pudo abrir.';
      result.errors.push(`${file.name}: ${msg}`);
    }
  }
  return result;
}
