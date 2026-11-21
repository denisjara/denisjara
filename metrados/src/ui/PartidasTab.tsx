/**
 * Pestaña Partidas: la lista de partidas con su total, las mediciones de la partida activa y el editor de la
 * medición seleccionada.
 */
import { memo, useMemo } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, CircleMinus, Copy, Ellipsis, ListPlus, LocateFixed, PencilRuler, Plus, Settings2, Trash2, TriangleAlert } from 'lucide-react';
import { addManualRow, duplicateMeasurement, movePartida, patchMeasurement, removeMeasurements, removePartida, selectPartida } from '../app/actions';
import { store, useStore } from '../app/store';
import { BASIC_FORMULAS } from '../core/catalog';
import { buildRow, formulaText, usedParams, type MetradoRow } from '../core/metrado';
import { kindForBase, type Measurement, type ParamKey, type Partida, type Project } from '../core/model';
import { viewer } from '../viewer/controller';
import { rowLabel } from '../app/export';
import { cx, fmt, Menu, MenuItem, NumberField, Swatch } from './kit';
import { scaleText } from './Toolbars';

const PARAM_LABEL: Record<ParamKey, string> = { largo: 'Largo', ancho: 'Ancho', alto: 'Alto', factor: 'Factor' };

export function paramLabel(p: Partida, key: ParamKey): string {
  if (key === 'factor') return p.factorLabel || 'Factor';
  if (key === 'alto' && p.base === 'A') return 'Espesor / alto';
  return PARAM_LABEL[key];
}

/** Lleva la vista a una medición (cambiando de lámina si hace falta). */
export function focusMeasurement(m: Measurement): void {
  if (m.kind === 'manual' || !m.sheetId) {
    store.setUi({ selection: [m.id], activePartidaId: m.partidaId });
    return;
  }
  const changeSheet = store.get().ui.sheetId !== m.sheetId;
  store.setUi({ sheetId: m.sheetId, selection: [m.id], activePartidaId: m.partidaId, tool: 'select' });
  // Si cambia la lámina, el visor necesita un instante para montarla antes de encuadrar.
  setTimeout(() => viewer.current?.zoomToMeasurement(m), changeSheet ? 350 : 0);
}

function measuredText(row: MetradoRow, decimals: number): string {
  if (row.issue === 'sin-escala') return 'sin escala';
  if (row.cant !== undefined && row.kind !== 'manual') return `${row.cant} ${row.cant === 1 ? 'punto' : 'puntos'}`;
  if (row.area !== undefined) return `${fmt(row.area, decimals)} m²`;
  if (row.largo !== undefined) return `${fmt(row.largo, decimals)} m`;
  if (row.cant !== undefined) return `${fmt(row.cant, decimals)}`;
  return '—';
}

function Inspector({ m, partida, project }: { m: Measurement; partida: Partida; project: Project }) {
  const sheet = project.sheets.find((s) => s.id === m.sheetId);
  const d = project.settings.decimals;
  const row = buildRow(m, partida, sheet, d);
  const same = project.partidas.filter((p) => kindForBase(p.base) === (m.kind === 'manual' ? kindForBase(partida.base) : m.kind));
  const set = (patch: Partial<Measurement>, key: string) => patchMeasurement(m.id, patch, `m:${m.id}:${key}`);
  return (
    <div className="mt-1 space-y-2.5 rounded-md border border-line bg-panel-2 p-2.5" onClick={(e) => e.stopPropagation()}>
      <div>
        <label className="rotulo" htmlFor={`lbl-${m.id}`}>
          Descripción
        </label>
        <input id={`lbl-${m.id}`} className="field mt-0.5" placeholder="Eje, ambiente o elemento" value={m.label} onChange={(e) => set({ label: e.target.value }, 'label')} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="rotulo" htmlFor={`veces-${m.id}`}>
            N.º de veces
          </label>
          <NumberField id={`veces-${m.id}`} className="mt-0.5" value={m.times} onChange={(v) => set({ times: v ?? 1 }, 'times')} />
        </div>
        {m.kind === 'manual' && (
          <div>
            <label className="rotulo" htmlFor={`man-${m.id}`}>
              {partida.base === 'A' ? 'Área (m²)' : partida.base === 'N' ? 'Cantidad' : 'Longitud (m)'}
            </label>
            <NumberField id={`man-${m.id}`} className="mt-0.5" value={m.manual} onChange={(v) => set({ manual: v ?? 0 }, 'manual')} />
          </div>
        )}
        {usedParams(partida).map((key) => (
          <div key={key}>
            <label className="rotulo" htmlFor={`${key}-${m.id}`}>
              {paramLabel(partida, key)}
            </label>
            <NumberField id={`${key}-${m.id}`} className="mt-0.5" value={m[key]} placeholder={partida[key] !== undefined ? String(partida[key]) : 'Falta'} onChange={(v) => set({ [key]: v }, key)} />
          </div>
        ))}
      </div>
      <button type="button" className={cx('chip', m.deduct && '!border-danger/60 !bg-danger-soft !text-danger')} aria-pressed={m.deduct} onClick={() => patchMeasurement(m.id, { deduct: !m.deduct })}>
        <CircleMinus size={14} /> Descuento (resta)
      </button>
      {same.length > 1 && (
        <div>
          <label className="rotulo" htmlFor={`par-${m.id}`}>
            Partida
          </label>
          <select id={`par-${m.id}`} className="field mt-0.5" value={m.partidaId} onChange={(e) => patchMeasurement(m.id, { partidaId: e.target.value })}>
            {same.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {sheet && sheet.scales.length > 1 && (
        <div>
          <label className="rotulo" htmlFor={`esc-${m.id}`}>
            Escala con la que se mide
          </label>
          <select id={`esc-${m.id}`} className="field mt-0.5" value={m.scaleId ?? ''} onChange={(e) => patchMeasurement(m.id, { scaleId: e.target.value || null })}>
            {sheet.scales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({scaleText(s, sheet)})
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-line pt-2">
        <p className="num min-w-0 text-ink-2">
          {m.kind !== 'manual' && (
            <>
              Leído del plano: <b className="text-ink">{measuredText(row, d)}</b>
            </>
          )}
        </p>
        <div className="flex shrink-0">
          {m.kind !== 'manual' && (
            <button type="button" className="icon-btn" title="Ver en el plano" aria-label="Ver en el plano" onClick={() => focusMeasurement(m)}>
              <LocateFixed size={16} />
            </button>
          )}
          <button type="button" className="icon-btn" title="Duplicar" aria-label="Duplicar" onClick={() => duplicateMeasurement(m.id)}>
            <Copy size={16} />
          </button>
          <button type="button" className="icon-btn hover:!text-danger" title="Eliminar (Supr)" aria-label="Eliminar medición" onClick={() => removeMeasurements([m.id])}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

const PartidaCard = memo(function PartidaCard({ partida, project, active, selection, index, count }: { partida: Partida; project: Project; active: boolean; selection: string[]; index: number; count: number }) {
  const d = project.settings.decimals;
  const sheets = useMemo(() => new Map(project.sheets.map((s) => [s.id, s])), [project.sheets]);
  const ms = useMemo(() => project.measurements.filter((m) => m.partidaId === partida.id), [project.measurements, partida.id]);
  const rows = useMemo(() => ms.map((m) => buildRow(m, partida, m.sheetId ? sheets.get(m.sheetId) : undefined, d)), [ms, partida, sheets, d]);
  const incomplete = rows.some((r) => r.parcial === null);
  const total = rows.reduce((s, r) => s + (r.parcial ?? 0), 0);
  return (
    <li className={cx('rounded-lg border', active ? 'border-accent/50 bg-panel shadow-float' : 'border-transparent hover:bg-panel-2')}>
      <div className="flex items-center gap-1 pr-1">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left" aria-expanded={active} onClick={() => selectPartida(partida.id)}>
          <ChevronRight size={15} className={cx('shrink-0 text-ink-3 transition-transform', active && 'rotate-90')} />
          <Swatch color={partida.color} size={14} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">
              <span className="num mr-1.5 text-ink-3">{partida.code}</span>
              {partida.name}
            </span>
            <span className="block truncate text-2xs text-ink-3">
              {formulaText(partida)} · {ms.length} {ms.length === 1 ? 'medición' : 'mediciones'}
            </span>
          </span>
          <span className="num shrink-0 text-right">
            <span className="block font-bold">{fmt(total, d)}</span>
            <span className="block text-2xs text-ink-3">{partida.unit}</span>
          </span>
          {incomplete && <TriangleAlert size={15} className="shrink-0 text-warn" aria-label="Hay filas sin calcular" />}
        </button>
        <Menu label={`Opciones de ${partida.name}`} className="icon-btn h-8 w-8 shrink-0" content={<Ellipsis size={16} />}>
          {(close) => (
            <>
              <MenuItem
                icon={<Settings2 size={16} />}
                onClick={() => {
                  close();
                  store.setUi({ dialog: { type: 'partida', partidaId: partida.id } });
                }}
              >
                Editar partida…
              </MenuItem>
              <MenuItem
                icon={<ArrowUp size={16} />}
                disabled={index === 0}
                onClick={() => {
                  movePartida(partida.id, -1);
                  close();
                }}
              >
                Subir
              </MenuItem>
              <MenuItem
                icon={<ArrowDown size={16} />}
                disabled={index === count - 1}
                onClick={() => {
                  movePartida(partida.id, 1);
                  close();
                }}
              >
                Bajar
              </MenuItem>
              <MenuItem
                icon={<Trash2 size={16} />}
                danger
                onClick={() => {
                  close();
                  if (ms.length === 0) removePartida(partida.id);
                  else
                    store.setUi({
                      dialog: {
                        type: 'confirm',
                        title: 'Eliminar partida',
                        message: `«${partida.name}» tiene ${ms.length} ${ms.length === 1 ? 'medición' : 'mediciones'}. Se eliminarán con ella. Puedes deshacerlo con Ctrl+Z.`,
                        confirmLabel: 'Eliminar partida',
                        danger: true,
                        onConfirm: () => removePartida(partida.id),
                      },
                    });
                }}
              >
                Eliminar
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
      {active && (
        <div className="px-2.5 pb-2.5">
          {rows.length > 0 && (
            <ul className="mb-2 space-y-0.5">
              {ms.map((m, i) => {
                const row = rows[i];
                const selected = selection.includes(m.id);
                return (
                  <li key={m.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      className={cx('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5', selected ? 'bg-accent-soft' : 'hover:bg-panel-3')}
                      onClick={() => focusMeasurement(m)}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), focusMeasurement(m))}
                      onPointerEnter={() => m.sheetId === store.get().ui.sheetId && store.setUi({ hoverId: m.id })}
                      onPointerLeave={() => store.get().ui.hoverId === m.id && store.setUi({ hoverId: null })}
                    >
                      <span className="min-w-0 flex-1">
                        <span className={cx('block truncate', !m.label && 'text-ink-3')}>
                          {m.deduct && <span className="mr-1 font-bold text-danger">−</span>}
                          {rowLabel(row, i)}
                        </span>
                        <span className="num block truncate text-2xs text-ink-3">
                          {m.kind === 'manual' ? 'Fila manual' : measuredText(row, d)}
                          {m.times !== 1 && ` × ${fmt(m.times, Number.isInteger(m.times) ? 0 : 2)}`}
                          {row.sheetName && project.sheets.length > 1 && ` · ${row.sheetName}`}
                        </span>
                      </span>
                      <span className={cx('num shrink-0 font-semibold', row.parcial === null && 'text-warn')}>{row.parcial === null ? (row.issue === 'sin-escala' ? 'sin escala' : 'falta dato') : fmt(row.parcial, d)}</span>
                    </div>
                    {selected && selection.length === 1 && <Inspector m={m} partida={partida} project={project} />}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className="btn btn-primary h-8 min-h-0 flex-1 text-[13px]" onClick={() => selectPartida(partida.id, true)}>
              <PencilRuler size={15} /> Medir en el plano
            </button>
            <button type="button" className="btn h-8 min-h-0 text-[13px]" title="Añadir una fila con medidas tecleadas" onClick={() => addManualRow(partida.id)}>
              <Plus size={15} /> Fila manual
            </button>
          </div>
        </div>
      )}
    </li>
  );
});

export function PartidasTab() {
  const project = useStore((s) => s.project);
  const activeId = useStore((s) => s.ui.activePartidaId);
  const selection = useStore((s) => s.ui.selection);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-4 pb-2 pt-3">
        <button type="button" className="btn h-8 min-h-0 flex-1 text-[13px]" onClick={() => store.setUi({ dialog: { type: 'partida' } })}>
          <Plus size={15} /> Nueva partida
        </button>
        <button type="button" className="btn h-8 min-h-0 flex-1 text-[13px]" onClick={() => store.setUi({ dialog: { type: 'catalog' } })}>
          <ListPlus size={15} /> Del catálogo
        </button>
      </div>
      {project.partidas.length === 0 ? (
        <div className="px-4 py-6 text-center text-ink-2">
          <p className="font-semibold text-ink">Todavía no hay partidas</p>
          <p className="mt-1">Una partida es lo que vas a metrar (muros, pisos, puertas…) y cómo se calcula. Empieza por una de estas:</p>
          <div className="mt-3 flex flex-wrap justify-center gap-1.5">
            {BASIC_FORMULAS.filter((f) => f.use.length === 0 || f.label === 'Longitud × alto').map((f) => (
              <button key={f.label} type="button" className="chip" onClick={() => store.setUi({ dialog: { type: 'partida', base: f.base } })}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2.5 pb-4">
          {project.partidas.map((p, i) => (
            <PartidaCard key={p.id} partida={p} project={project} active={p.id === activeId} selection={p.id === activeId ? selection : NO_SELECTION} index={i} count={project.partidas.length} />
          ))}
        </ul>
      )}
    </div>
  );
}

const NO_SELECTION: string[] = [];
