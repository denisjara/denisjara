/**
 * Proyecto de demostración: el plano de ejemplo con unas pocas mediciones ya hechas, para que la primera vez que
 * se abre la app se vea cómo queda un metrado. En cuanto el usuario abre su propio plano, se sustituye.
 */
import type { Pt } from '../core/geometry';
import { partidaFromTemplate, CATALOG } from '../core/catalog';
import { emptyProject, newId, type Measurement, type Partida, type PlanFile, type Project, type ScaleDef, type Sheet } from '../core/model';
import { mPerUnitFromRatio } from '../core/units';
import { snapPoint } from '../core/vector';
import { buildSamplePdf, SAMPLE_PAGE, SAMPLE_RATIO, SAMPLE_ROOMS, sampleToSheet } from '../io/sample';
import { getRuntime, registerFile } from './plans';

const DOOR_CENTERS: readonly [number, number][] = [
  [2.5, 0.125],
  [5.825, 1.95],
  [1.45, 4.475],
  [4.75, 4.475],
  [6.75, 4.475],
];
const LIGHTS: readonly [number, number][] = [
  [3.0, 2.3],
  [7.8, 2.3],
  [2.0, 6.15],
  [4.9, 6.15],
  [7.9, 6.15],
];

export async function buildSampleProject(): Promise<Project> {
  const bytes = buildSamplePdf();
  const file: PlanFile = { id: newId('file'), name: 'Vivienda-ejemplo-A01.pdf', kind: 'pdf', size: bytes.length };
  registerFile(file, new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const scale: ScaleDef = { id: newId('esc'), name: `Escala 1:${SAMPLE_RATIO}`, mPerUnit: mPerUnitFromRatio(SAMPLE_RATIO), source: 'ratio', ratio: SAMPLE_RATIO };
  const sheet: Sheet = { id: newId('lam'), fileId: file.id, kind: 'pdf', name: 'A-01 Planta primer piso', page: 1, w: SAMPLE_PAGE.w, h: SAMPLE_PAGE.h, scales: [scale], activeScaleId: scale.id };
  const rt = await getRuntime(sheet);
  // Los vértices se enganchan a la geometría real del PDF, igual que si se hubieran marcado a mano.
  const corner = (x: number, y: number): Pt => {
    const s = sampleToSheet(x, y);
    const hit = snapPoint(rt.vector, s, { modes: { endpoint: true, midpoint: false, intersection: true, perpendicular: false, nearest: false }, radius: 0.5 });
    return hit ? { x: hit.x, y: hit.y } : s;
  };
  const tpl = (name: string) => CATALOG.find((t) => t.name === name)!;
  const partidas: Partida[] = [];
  for (const name of ['Muro de ladrillo KK de soga', 'Piso de cerámico', 'Puertas', 'Salida de techo (centro de luz)']) partidas.push(partidaFromTemplate(tpl(name), partidas));
  const [muro, piso, puertas, luces] = partidas;
  let t = Date.now();
  const base = { sheetId: sheet.id, scaleId: scale.id, times: 1, deduct: false };
  const room = (name: string): Measurement => {
    const r = SAMPLE_ROOMS.find((x) => x.name === name)!;
    return { ...base, id: newId('med'), partidaId: piso.id, kind: 'area', label: name[0] + name.slice(1).toLowerCase(), createdAt: t++, parts: [{ v: [corner(r.x0, r.y0), corner(r.x1, r.y0), corner(r.x1, r.y1), corner(r.x0, r.y1)], closed: true }] };
  };
  const wall = (label: string, x: number): Measurement => ({ ...base, id: newId('med'), partidaId: muro.id, kind: 'line', label, createdAt: t++, parts: [{ v: [corner(x, 4.55), corner(x, 7.75)] }] });
  const count = (partida: Partida, label: string, pts: readonly [number, number][]): Measurement => ({
    ...base,
    id: newId('med'),
    partidaId: partida.id,
    kind: 'count',
    label,
    createdAt: t++,
    parts: [{ v: pts.map(([x, y]) => sampleToSheet(x, y)) }],
  });
  const measurements = [wall('Entre dormitorio 1 y baño', 3.75), wall('Entre baño y dormitorio 2', 5.9), room('DORMITORIO 1'), room('DORMITORIO 2'), count(puertas, 'Puertas de la planta', DOOR_CENTERS), count(luces, 'Centros de luz', LIGHTS)];
  return { ...emptyProject('Vivienda de ejemplo'), files: [file], sheets: [sheet], partidas, measurements, sample: true };
}
