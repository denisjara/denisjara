import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { partArea, partLength, type Part } from '../src/core/geometry';
import { mPerUnitFromRatio, detectScales, mPerUnitFromCalibration } from '../src/core/units';
import { ALL_SNAPS, snapPoint } from '../src/core/vector';
import { extractPdfPage, type PdfLib, type PdfPageLike } from '../src/io/pdf/extract';
import { buildSamplePdf, SAMPLE_PAGE, SAMPLE_RATIO, SAMPLE_ROOMS, sampleToSheet } from '../src/io/sample';

describe('plano de ejemplo (PDF A3 a 1/50)', () => {
  it('lo que se mide enganchando a las esquinas coincide con las medidas con las que se dibujó', async () => {
    const doc = await pdfjs.getDocument({ data: buildSamplePdf(), useSystemFonts: false, verbosity: 0 }).promise;
    const page = await doc.getPage(1);
    const pv = await extractPdfPage(page as unknown as PdfPageLike, pdfjs as unknown as PdfLib, (await doc.getOptionalContentConfig()) as never);
    expect(pv.vector.bounds.maxX).toBeCloseTo(SAMPLE_PAGE.w, 6);
    expect(pv.vector.bounds.maxY).toBeCloseTo(SAMPLE_PAGE.h, 6);
    expect(pv.raster).toBe(false);
    expect(pv.layers.map((l) => l.name)).toEqual(['MUROS', 'COLUMNAS', 'VENTANAS', 'PUERTAS', 'MOBILIARIO', 'ELECTRICAS', 'TEXTOS', 'COTAS', 'MEMBRETE']);
    expect(pv.layers.filter((l) => l.paths === 0).map((l) => l.name)).toEqual(['TEXTOS']);
    expect(detectScales(pv.texts.map((t) => t.str))[0]).toBe(SAMPLE_RATIO);
    expect(pv.texts.some((t) => t.str.includes('DORMITORIO 1'))).toBe(true);

    const mPerUnit = mPerUnitFromRatio(SAMPLE_RATIO);
    for (const r of SAMPLE_ROOMS) {
      const corners = [
        [r.x0, r.y0],
        [r.x1, r.y0],
        [r.x1, r.y1],
        [r.x0, r.y1],
      ].map(([x, y]) => {
        const s = sampleToSheet(x, y);
        // el cursor cae a 2 puntos de la esquina, como al hacer clic a mano; el enganche lo lleva al vértice exacto
        const hit = snapPoint(pv.vector, { x: s.x + 1.4, y: s.y - 1.1 }, { modes: ALL_SNAPS, radius: 4 });
        expect(hit?.kind === 'endpoint' || hit?.kind === 'intersection').toBe(true);
        return { x: hit!.x, y: hit!.y };
      });
      const ring: Part = { v: corners, closed: true };
      const w = r.x1 - r.x0;
      const h = r.y1 - r.y0;
      // el PDF guarda 4 decimales de punto: el error real queda por debajo de 0,01 mm por lado
      expect(partArea(ring) * mPerUnit * mPerUnit).toBeCloseTo(w * h, 4);
      expect(partLength(ring) * mPerUnit).toBeCloseTo(2 * (w + h), 4);
    }

    // Calibrar con la cota total (10.00 m) da la misma escala que 1/50.
    const a = sampleToSheet(0, 0);
    const b = sampleToSheet(10, 0);
    const calibrated = mPerUnitFromCalibration(a, b, 10)!;
    expect(calibrated / mPerUnit).toBeCloseTo(1, 9);
  });
});
