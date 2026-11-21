import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { partArea, partLength } from '../src/core/geometry';
import { ALL_SNAPS, nearestPath, partOfPath, snapPoint } from '../src/core/vector';
import { detectScales } from '../src/core/units';
import { extractPdfPage, type PdfLib, type PdfPageLike } from '../src/io/pdf/extract';
import { buildPdf, PdfCanvas } from '../src/io/minipdf';

const lib = pdfjs as unknown as PdfLib;

async function load(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: false, verbosity: 0 }).promise;
  return doc;
}

async function extractFirst(bytes: Uint8Array, page = 1) {
  const doc = await load(bytes);
  const p = await doc.getPage(page);
  const oc = await doc.getOptionalContentConfig();
  return extractPdfPage(p as unknown as PdfPageLike, lib, oc as never);
}

const near = (a: number, b: number, tol = 1e-3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('lectura vectorial de PDF', () => {
  it('rectángulo y línea: coordenadas de lámina exactas (origen arriba a la izquierda)', async () => {
    const c = new PdfCanvas().lineWidth(0.5).rect(100, 200, 300, 150).stroke().line(50, 50, 450, 350);
    const pv = await extractFirst(buildPdf([{ width: 600, height: 800, content: c.toString() }]));
    expect(pv.raster).toBe(false);
    expect(pv.vector.pathCount).toBe(2);
    const rect = partOfPath(pv.vector, 0);
    expect(rect.closed).toBe(true);
    expect(rect.v.map((p) => [p.x, p.y])).toEqual([
      [100, 600],
      [400, 600],
      [400, 450],
      [100, 450],
    ]);
    expect(partLength(rect)).toBe(900);
    expect(partArea(rect)).toBe(45000);
    const line = partOfPath(pv.vector, 1);
    expect(line.closed).toBeUndefined();
    expect(partLength(line)).toBe(500);
    expect(pv.styles).toHaveLength(1);
    expect(pv.styles[0]).toMatchObject({ stroke: true, fill: false, color: '#000000', width: 0.5, paths: 2 });
  });

  it('respeta las transformaciones anidadas (cm), como los PDF de CAD que dibujan en 1/1200 de pulgada', async () => {
    const k = 72 / 1200;
    const c = new PdfCanvas().save().transform(k, 0, 0, k, 36, 36).lineWidth(10).moveTo(0, 0).lineTo(12000, 0).lineTo(12000, 6000).stroke().restore().line(0, 0, 10, 0);
    const pv = await extractFirst(buildPdf([{ width: 1000, height: 500, content: c.toString() }]));
    const p = partOfPath(pv.vector, 0);
    near(p.v[0].x, 36, 1e-9);
    near(p.v[0].y, 500 - 36, 1e-9);
    near(p.v[1].x, 36 + 720, 1e-9);
    near(p.v[2].y, 500 - 36 - 360, 1e-9);
    near(partLength(p), 1080, 1e-9);
    // el grosor también se transforma
    near(pv.styles[0].width, 0.6, 1e-9);
    // tras el restore la matriz vuelve a ser la de la página
    expect(partLength(partOfPath(pv.vector, 1))).toBe(10);
  });

  it('círculo de curvas Bézier: longitud y área con el error propio de la aproximación del archivo', async () => {
    const r = 100;
    const c = new PdfCanvas().circle(300, 300, r).stroke();
    const pv = await extractFirst(buildPdf([{ width: 600, height: 600, content: c.toString() }]));
    const circle = partOfPath(pv.vector, 0);
    expect(circle.closed).toBe(true);
    expect(circle.v).toHaveLength(4);
    expect(circle.v.every((p) => p.c)).toBe(true);
    near(partLength(circle) / (2 * Math.PI * r), 1, 3e-4);
    near(partArea(circle) / (Math.PI * r * r), 1, 6e-4);
  });

  it('página girada (/Rotate 90) y con /UserUnit: la lámina queda como se ve', async () => {
    const c = new PdfCanvas().line(0, 0, 100, 0);
    const rotated = await extractFirst(buildPdf([{ width: 400, height: 200, content: c.toString(), rotate: 90 }]));
    expect(rotated.vector.bounds).toMatchObject({ maxX: 200, maxY: 400 });
    const p = partOfPath(rotated.vector, 0);
    // la esquina inferior izquierda del PDF pasa a la superior izquierda y la línea baja por el borde izquierdo
    expect(p.v.map((q) => [Math.round(q.x), Math.round(q.y)])).toEqual([
      [0, 0],
      [0, 100],
    ]);
    const scaled = await extractFirst(buildPdf([{ width: 400, height: 200, content: c.toString(), userUnit: 2 }]));
    expect(scaled.vector.bounds).toMatchObject({ maxX: 800, maxY: 400 });
    expect(partLength(partOfPath(scaled.vector, 0))).toBe(200);
  });

  it('capas (OCG), rellenos, recortes y textos', async () => {
    const c = new PdfCanvas()
      .beginLayer(0)
      .strokeColor(1, 0, 0)
      .line(10, 10, 110, 10)
      .endLayer()
      .beginLayer(1)
      .fillColor(0, 0, 1)
      .rect(200, 200, 50, 40)
      .fill()
      .endLayer()
      // un recorte no es geometría del plano
      .rect(0, 0, 300, 300)
      .raw('W n')
      .text(20, 280, 10, 'ESC: 1/50')
      .text(20, 260, 10, 'DORMITORIO Ñ');
    const pv = await extractFirst(buildPdf([{ width: 300, height: 300, content: c.toString() }], { layers: ['MUROS', 'COLUMNAS'], hiddenLayers: [1] }));
    expect(pv.layers.map((l) => [l.name, l.visible, l.paths])).toEqual([
      ['MUROS', true, 1],
      ['COLUMNAS', false, 1],
    ]);
    expect(pv.vector.pathCount).toBe(2);
    expect(pv.vector.pathLayer[0]).toBe(1);
    expect(pv.vector.pathLayer[1]).toBe(2);
    expect(pv.styles.map((s) => [s.color, s.stroke, s.fill])).toEqual([
      ['#ff0000', true, false],
      ['#0000ff', false, true],
    ]);
    expect(partArea(partOfPath(pv.vector, 1))).toBe(2000);
    expect(pv.texts.map((t) => t.str)).toEqual(['ESC: 1/50', 'DORMITORIO Ñ']);
    near(pv.texts[0].x, 20, 1e-6);
    near(pv.texts[0].y, 20, 1e-6);
    near(pv.texts[0].h, 10, 1e-6);
    expect(detectScales(pv.texts.map((t) => t.str))).toEqual([50]);
  });

  it('enganche: extremo, punto medio, intersección y perpendicular exactos', async () => {
    const c = new PdfCanvas().line(100, 100, 300, 100).line(200, 50, 200, 150).line(100, 100, 100, 300);
    const pv = await extractFirst(buildPdf([{ width: 400, height: 400, content: c.toString() }]));
    const v = pv.vector;
    const q = { modes: ALL_SNAPS, radius: 6 };
    // (100,100) en PDF es (100,300) en la lámina
    expect(snapPoint(v, { x: 102.3, y: 298.9 }, q)).toMatchObject({ x: 100, y: 300, kind: 'endpoint' });
    expect(snapPoint(v, { x: 198.5, y: 301.2 }, q)).toMatchObject({ x: 200, y: 300, kind: 'intersection' });
    expect(snapPoint(v, { x: 101.5, y: 201 }, q)).toMatchObject({ x: 100, y: 200, kind: 'midpoint' });
    expect(snapPoint(v, { x: 270.4, y: 302 }, q)).toMatchObject({ x: 270.4, y: 300, kind: 'nearest' });
    // perpendicular desde un punto anterior del trazo sobre la línea horizontal
    expect(snapPoint(v, { x: 131, y: 298 }, { ...q, from: { x: 130, y: 200 } })).toMatchObject({ x: 130, y: 300, kind: 'perpendicular' });
    expect(snapPoint(v, { x: 20, y: 20 }, q)).toBeNull();
    // con la capa oculta no se engancha
    const hidden = new Uint8Array(4);
    hidden[0] = 1;
    expect(snapPoint(v, { x: 102, y: 299 }, { ...q, layerHidden: hidden })).toBeNull();
    expect(nearestPath(v, { x: 150, y: 303 }, 6)).toMatchObject({ path: 0 });
  });

  it('un PDF con cien mil segmentos se lee, se indexa y se consulta con rapidez', async () => {
    const c = new PdfCanvas().lineWidth(0.1);
    const N = 400;
    for (let i = 0; i < N; i++) {
      c.moveTo(0, i * 2);
      for (let j = 1; j <= 250; j++) c.lineTo(j * 4, i * 2 + (j % 2));
      c.stroke();
    }
    const t0 = performance.now();
    const pv = await extractFirst(buildPdf([{ width: 1000, height: 800, content: c.toString() }]));
    const t1 = performance.now();
    expect(pv.vector.count).toBe(N * 250);
    const hit = snapPoint(pv.vector, { x: 400.3, y: 800 - 200.2 }, { modes: ALL_SNAPS, radius: 1 });
    expect(hit).toMatchObject({ x: 400, y: 600, kind: 'endpoint' });
    expect(t1 - t0).toBeLessThan(8000);
  });
});
