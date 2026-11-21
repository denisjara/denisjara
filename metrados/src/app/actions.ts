/**
 * Acciones de la app: cada función es algo que el usuario hace (medir, crear una partida, cambiar la escala,
 * abrir un plano…) y se traduce en un cambio del proyecto y/o de la interfaz.
 */
import type { Part } from '../core/geometry';
import { kindForBase, newId, type Base, type Measurement, type MeasurementKind, type Partida, type ScaleDef, type Sheet } from '../core/model';
import { forgetSheet, importFiles, type ImportResult } from './plans';
import { store, type ToolId } from './store';

/** Bases de partida con las que trabaja cada herramienta de medición. */
export const TOOL_BASES: Partial<Record<ToolId, Base[]>> = {
  line: ['L'],
  area: ['A', 'P'],
  rect: ['A', 'P'],
  count: ['N'],
  region: ['A', 'P', 'L'],
  pick: ['L', 'A', 'P', 'N'],
};

export const TOOL_LABEL: Record<ToolId, string> = {
  select: 'Seleccionar',
  line: 'Longitud',
  area: 'Área',
  rect: 'Rectángulo',
  count: 'Conteo',
  ruler: 'Regla',
  pick: 'Tomar trazo',
  region: 'Área automática',
  calibrate: 'Calibrar escala',
};

const askedScale = new Set<string>();

export function currentSheet(): Sheet | null {
  const { project, ui } = store.get();
  return project.sheets.find((s) => s.id === ui.sheetId) ?? null;
}

export function activePartida(): Partida | null {
  const { project, ui } = store.get();
  return project.partidas.find((p) => p.id === ui.activePartidaId) ?? null;
}

/** Activa una herramienta. Las de medir necesitan una partida compatible y, salvo el conteo, una escala. */
export function setTool(tool: ToolId): void {
  const { project, ui } = store.get();
  const sheet = currentSheet();
  if (tool !== 'select' && !sheet) {
    store.toast('Abre primero un plano (PDF, DXF o imagen).');
    return;
  }
  const bases = TOOL_BASES[tool];
  let activePartidaId = ui.activePartidaId;
  if (bases) {
    const active = project.partidas.find((p) => p.id === activePartidaId);
    if (!active || !bases.includes(active.base)) {
      const candidate = project.partidas.find((p) => bases.includes(p.base));
      if (!candidate) {
        store.setUi({ dialog: { type: 'partida', base: bases[0] }, tool: 'select' });
        pendingTool = tool;
        return;
      }
      activePartidaId = candidate.id;
      store.toast(`Partida activa: ${candidate.name}`);
    }
    if (sheet && !sheet.activeScaleId && tool !== 'count' && !askedScale.has(sheet.id)) {
      askedScale.add(sheet.id);
      store.setUi({ tool, activePartidaId, selection: [], dialog: { type: 'scale', sheetId: sheet.id } });
      return;
    }
  }
  store.setUi({ tool, activePartidaId, selection: tool === 'select' ? ui.selection : [] });
}

/** Herramienta que se activará al crear la partida que faltaba. */
let pendingTool: ToolId | null = null;

export function takePendingTool(): ToolId | null {
  const t = pendingTool;
  pendingTool = null;
  return t;
}

/** Elige la partida activa; si la herramienta en uso no sirve para ella, cambia a la suya. */
export function selectPartida(id: string, startMeasuring = false): void {
  const { project, ui } = store.get();
  const partida = project.partidas.find((p) => p.id === id);
  if (!partida) return;
  const bases = TOOL_BASES[ui.tool];
  const natural: ToolId = kindForBase(partida.base);
  if (startMeasuring) {
    store.setUi({ activePartidaId: id });
    setTool(ui.tool !== 'select' && bases?.includes(partida.base) ? ui.tool : natural);
    return;
  }
  store.setUi({ activePartidaId: id, tool: bases && !bases.includes(partida.base) ? natural : ui.tool });
}

export function addPartida(p: Partida): void {
  store.update((proj) => ({ ...proj, partidas: [...proj.partidas, p] }));
  store.setUi({ activePartidaId: p.id, panelTab: 'partidas' });
}

export function patchPartida(id: string, patch: Partial<Partida>, coalesce = true): void {
  store.update((proj) => ({ ...proj, partidas: proj.partidas.map((p) => (p.id === id ? { ...p, ...patch } : p)) }), coalesce ? { coalesce: `partida:${id}:${Object.keys(patch).join(',')}` } : {});
}

export function removePartida(id: string): void {
  store.update((proj) => ({ ...proj, partidas: proj.partidas.filter((p) => p.id !== id), measurements: proj.measurements.filter((m) => m.partidaId !== id) }));
  const { project, ui } = store.get();
  if (ui.activePartidaId === id) store.setUi({ activePartidaId: project.partidas[0]?.id ?? null, tool: 'select' });
}

export function movePartida(id: string, dir: -1 | 1): void {
  store.update((proj) => {
    const i = proj.partidas.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= proj.partidas.length) return proj;
    const partidas = [...proj.partidas];
    [partidas[i], partidas[j]] = [partidas[j], partidas[i]];
    return { ...proj, partidas };
  });
}

export interface NewMeasurement {
  kind: Exclude<MeasurementKind, 'manual'>;
  parts: Part[];
  label?: string;
  partidaId?: string;
  deduct?: boolean;
}

/** Añade una medición dibujada en la lámina actual, con la partida activa y la escala activa de la lámina. */
export function addMeasurement(input: NewMeasurement, select = true): string | null {
  const sheet = currentSheet();
  const { ui } = store.get();
  const partidaId = input.partidaId ?? ui.activePartidaId;
  if (!sheet || !partidaId) return null;
  const m: Measurement = {
    id: newId('med'),
    partidaId,
    sheetId: sheet.id,
    scaleId: sheet.activeScaleId,
    kind: input.kind,
    parts: input.parts,
    label: input.label ?? '',
    times: 1,
    deduct: input.deduct ?? ui.deduct,
    createdAt: Date.now(),
  };
  store.update((proj) => ({ ...proj, measurements: [...proj.measurements, m] }));
  if (select) store.setUi({ selection: [m.id] });
  return m.id;
}

export function addManualRow(partidaId: string): void {
  const m: Measurement = { id: newId('med'), partidaId, sheetId: null, scaleId: null, kind: 'manual', parts: [], label: '', times: 1, deduct: false, manual: 0, createdAt: Date.now() };
  store.update((proj) => ({ ...proj, measurements: [...proj.measurements, m] }));
}

export function patchMeasurement(id: string, patch: Partial<Measurement>, coalesce?: string): void {
  store.update((proj) => ({ ...proj, measurements: proj.measurements.map((m) => (m.id === id ? { ...m, ...patch } : m)) }), coalesce ? { coalesce } : {});
}

export function removeMeasurements(ids: readonly string[]): void {
  if (!ids.length) return;
  const set = new Set(ids);
  store.update((proj) => ({ ...proj, measurements: proj.measurements.filter((m) => !set.has(m.id)) }));
  store.setUi((ui) => ({ selection: ui.selection.filter((id) => !set.has(id)), hoverId: null }));
}

export function duplicateMeasurement(id: string): void {
  const m = store.get().project.measurements.find((x) => x.id === id);
  if (!m) return;
  const copy: Measurement = { ...m, id: newId('med'), createdAt: Date.now(), label: m.label ? `${m.label} (copia)` : '' };
  store.update((proj) => ({ ...proj, measurements: [...proj.measurements, copy] }));
  store.setUi({ selection: [copy.id] });
}

/** Guarda una escala en la lámina (nueva o existente) y la deja activa. */
export function saveScale(sheetId: string, scale: ScaleDef): void {
  store.update((proj) => ({
    ...proj,
    sheets: proj.sheets.map((s) => {
      if (s.id !== sheetId) return s;
      const exists = s.scales.some((x) => x.id === scale.id);
      return { ...s, scales: exists ? s.scales.map((x) => (x.id === scale.id ? scale : x)) : [...s.scales, scale], activeScaleId: scale.id };
    }),
    // Las mediciones hechas sin escala en esta lámina adoptan la primera que se define.
    measurements: proj.measurements.map((m) => (m.sheetId === sheetId && m.scaleId === null && m.kind !== 'manual' ? { ...m, scaleId: scale.id } : m)),
  }));
}

export function setActiveScale(sheetId: string, scaleId: string): void {
  store.update((proj) => ({ ...proj, sheets: proj.sheets.map((s) => (s.id === sheetId ? { ...s, activeScaleId: scaleId } : s)) }));
}

export function removeScale(sheetId: string, scaleId: string): void {
  store.update((proj) => ({
    ...proj,
    sheets: proj.sheets.map((s) => {
      if (s.id !== sheetId) return s;
      const scales = s.scales.filter((x) => x.id !== scaleId);
      return { ...s, scales, activeScaleId: s.activeScaleId === scaleId ? (scales[0]?.id ?? null) : s.activeScaleId };
    }),
    measurements: proj.measurements.map((m) => (m.sheetId === sheetId && m.scaleId === scaleId ? { ...m, scaleId: null } : m)),
  }));
}

export function renameSheet(sheetId: string, name: string): void {
  store.update((proj) => ({ ...proj, sheets: proj.sheets.map((s) => (s.id === sheetId ? { ...s, name } : s)) }), { coalesce: `sheet-name:${sheetId}` });
}

export function setLayerHidden(sheetId: string, layerIds: readonly string[], hidden: boolean): void {
  store.update(
    (proj) => ({
      ...proj,
      sheets: proj.sheets.map((s) => {
        if (s.id !== sheetId) return s;
        const set = new Set(s.hiddenLayers ?? []);
        for (const id of layerIds) {
          if (hidden) set.add(id);
          else set.delete(id);
        }
        return { ...s, hiddenLayers: [...set] };
      }),
    }),
    { undo: false },
  );
}

/** Quita un plano con todas sus láminas y mediciones. */
export function removeFile(fileId: string): void {
  const { project } = store.get();
  const sheetIds = new Set(project.sheets.filter((s) => s.fileId === fileId).map((s) => s.id));
  store.update((proj) => ({
    ...proj,
    files: proj.files.filter((f) => f.id !== fileId),
    sheets: proj.sheets.filter((s) => s.fileId !== fileId),
    measurements: proj.measurements.filter((m) => !m.sheetId || !sheetIds.has(m.sheetId)),
  }));
  for (const id of sheetIds) forgetSheet(id);
  // El archivo sigue en memoria por si se deshace la eliminación; se libera al cerrar el proyecto.
  const after = store.get();
  if (!after.project.sheets.some((s) => s.id === after.ui.sheetId)) store.setUi({ sheetId: after.project.sheets[0]?.id ?? null, tool: 'select', selection: [] });
}

/** Abre archivos de planos y los añade al proyecto. */
export async function openPlanFiles(files: File[]): Promise<void> {
  if (!files.length) return;
  store.setUi({ busy: 'Abriendo plano…' });
  let result: ImportResult;
  try {
    result = await importFiles(files, (text) => store.setUi({ busy: text }));
  } catch (e) {
    store.setUi({ busy: null });
    store.toast(e instanceof Error ? e.message : 'No se pudo abrir el archivo.', 'error');
    return;
  }
  store.setUi({ busy: null });
  for (const err of result.errors.slice(0, 3)) store.toast(err, 'error', undefined, 9000);
  if (!result.sheets.length) return;
  const wasSample = store.get().project.sample === true;
  store.update(
    (proj) =>
      wasSample
        ? { ...proj, name: 'Proyecto sin título', files: result.files, sheets: result.sheets, partidas: [], measurements: [] }
        : { ...proj, files: [...proj.files, ...result.files], sheets: [...proj.sheets, ...result.sheets] },
    { undo: false },
  );
  const first = result.sheets[0];
  store.setUi({
    sheetId: first.id,
    tool: 'select',
    selection: [],
    activePartidaId: wasSample ? null : store.get().ui.activePartidaId,
    panelTab: result.sheets.length > 1 ? 'laminas' : store.get().ui.panelTab,
    dialog: first.kind === 'dxf' ? { type: 'scale', sheetId: first.id, scaleId: first.scales[0]?.id } : null,
  });
  const n = result.sheets.length;
  store.toast(n === 1 ? `Plano abierto: ${first.name}` : `${n} láminas añadidas`, 'ok');
}
