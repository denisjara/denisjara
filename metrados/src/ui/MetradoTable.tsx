/**
 * Hoja de metrados: todas las partidas con sus filas, editable, con los totales y la exportación.
 */
import { useMemo } from 'react';
import { ClipboardCopy, FileSpreadsheet, FileText, LocateFixed, Plus, Printer, Trash2, X } from 'lucide-react';
import { addManualRow, patchMeasurement, removeMeasurements } from '../app/actions';
import { buildCsv, buildTsv, buildWorkbook, fileBaseName, rowLabel } from '../app/export';
import { copyText, hostedInClaude, saveFile } from '../app/save';
import { store, useStore } from '../app/store';
import { buildSheet, usedParams, type MetradoRow, type PartidaBlock } from '../core/metrado';
import type { Measurement, ParamKey, Project } from '../core/model';
import { cx, fmt, NumberField, Swatch } from './kit';
import { focusMeasurement } from './PartidasTab';

export async function exportExcel(): Promise<void> {
  const project = store.get().project;
  if (!project.partidas.length) return void store.toast('Todavía no hay partidas que exportar.');
  const r = await saveFile(`${fileBaseName(project)}.xlsx`, buildWorkbook(project), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  if (r === 'saved') store.toast('Excel generado: los parciales y totales van como fórmulas.', 'ok');
  else if (r === 'failed') store.toast('No se pudo guardar el Excel aquí. Usa «Copiar» y pega la tabla en tu hoja de cálculo.', 'error');
}

export async function exportCsv(): Promise<void> {
  const project = store.get().project;
  const r = await saveFile(`${fileBaseName(project)}.csv`, buildCsv(project), 'text/csv;charset=utf-8');
  if (r === 'failed') store.toast('No se pudo guardar el CSV aquí. Usa «Copiar» y pega la tabla en tu hoja de cálculo.', 'error');
}

export async function copyTable(): Promise<void> {
  const ok = await copyText(buildTsv(store.get().project));
  store.toast(ok ? 'Tabla copiada: pégala en Excel o Google Sheets.' : 'El navegador no permitió copiar.', ok ? 'ok' : 'error');
}

const cellNum = 'num whitespace-nowrap px-2 py-1 text-right';

function EditableParam({ m, block, k }: { m: Measurement; block: PartidaBlock; k: ParamKey }) {
  if (!usedParams(block.partida).includes(k)) return <td className={cellNum} />;
  return (
    <td className="px-1 py-0.5 text-right">
      <NumberField
        ariaLabel={k}
        className="!min-h-0 h-7 !w-20 !px-1.5"
        value={m[k]}
        placeholder={block.partida[k] !== undefined ? String(block.partida[k]) : 'falta'}
        onChange={(v) => patchMeasurement(m.id, { [k]: v }, `m:${m.id}:${k}`)}
      />
    </td>
  );
}

function Row({ m, row, block, index, d, selected }: { m: Measurement; row: MetradoRow; block: PartidaBlock; index: number; d: number; selected: boolean }) {
  const base = block.partida.base;
  const measured = (v: number | undefined) => (v === undefined ? '' : fmt(v, d));
  return (
    <tr className={cx('border-b border-line', selected && 'bg-accent-soft')}>
      <td className="px-2 py-1" />
      <td className="px-1 py-0.5">
        <input
          className="field !min-h-0 h-7 min-w-[12rem] !px-1.5"
          aria-label="Descripción de la fila"
          placeholder={rowLabel(row, index)}
          value={m.label}
          onChange={(e) => patchMeasurement(m.id, { label: e.target.value }, `m:${m.id}:label`)}
        />
      </td>
      <td className="px-2 py-1 text-2xs text-ink-3">{m.kind === 'manual' ? 'manual' : row.sheetName}</td>
      <td className="px-1 py-0.5 text-right">
        <div className="flex items-center justify-end gap-1">
          {m.deduct && <span className="font-bold text-danger">−</span>}
          <NumberField ariaLabel="N.º de veces" className="!min-h-0 h-7 !w-16 !px-1.5" value={m.times} onChange={(v) => patchMeasurement(m.id, { times: v ?? 1 }, `m:${m.id}:times`)} />
        </div>
      </td>
      {/* Cant. */}
      {base === 'N' && m.kind === 'manual' ? (
        <td className="px-1 py-0.5 text-right">
          <NumberField ariaLabel="Cantidad" className="!min-h-0 h-7 !w-16 !px-1.5" value={m.manual} onChange={(v) => patchMeasurement(m.id, { manual: v ?? 0 }, `m:${m.id}:manual`)} />
        </td>
      ) : (
        <td className={cellNum}>{row.cant ?? ''}</td>
      )}
      {/* Largo */}
      {(base === 'L' || base === 'P') && m.kind === 'manual' ? (
        <td className="px-1 py-0.5 text-right">
          <NumberField ariaLabel="Largo" className="!min-h-0 h-7 !w-20 !px-1.5" value={m.manual} onChange={(v) => patchMeasurement(m.id, { manual: v ?? 0 }, `m:${m.id}:manual`)} />
        </td>
      ) : base === 'N' ? (
        <EditableParam m={m} block={block} k="largo" />
      ) : (
        <td className={cellNum}>{row.issue === 'sin-escala' && (base === 'L' || base === 'P') ? <span className="text-warn">sin escala</span> : measured(row.largo)}</td>
      )}
      <EditableParam m={m} block={block} k="ancho" />
      <EditableParam m={m} block={block} k="alto" />
      {/* Área */}
      {base === 'A' && m.kind === 'manual' ? (
        <td className="px-1 py-0.5 text-right">
          <NumberField ariaLabel="Área" className="!min-h-0 h-7 !w-20 !px-1.5" value={m.manual} onChange={(v) => patchMeasurement(m.id, { manual: v ?? 0 }, `m:${m.id}:manual`)} />
        </td>
      ) : (
        <td className={cellNum}>{row.issue === 'sin-escala' && base === 'A' ? <span className="text-warn">sin escala</span> : measured(row.area)}</td>
      )}
      <EditableParam m={m} block={block} k="factor" />
      <td className={cx(cellNum, 'font-semibold', row.parcial === null && 'text-warn')}>{row.parcial === null ? '—' : fmt(row.parcial, d)}</td>
      <td />
      <td className="whitespace-nowrap px-1 py-0.5 text-right print:hidden">
        {m.kind !== 'manual' && (
          <button
            type="button"
            className="icon-btn h-7 w-7"
            title="Ver en el plano"
            aria-label="Ver en el plano"
            onClick={() => {
              store.setUi({ tableOpen: false });
              focusMeasurement(m);
            }}
          >
            <LocateFixed size={15} />
          </button>
        )}
        <button type="button" className="icon-btn h-7 w-7 hover:!text-danger" title="Eliminar fila" aria-label="Eliminar fila" onClick={() => removeMeasurements([m.id])}>
          <Trash2 size={15} />
        </button>
      </td>
    </tr>
  );
}

function Block({ block, project, selection }: { block: PartidaBlock; project: Project; selection: string[] }) {
  const d = project.settings.decimals;
  const ms = useMemo(() => project.measurements.filter((m) => m.partidaId === block.partida.id), [project.measurements, block.partida.id]);
  return (
    <tbody>
      <tr className="border-b border-line-strong/60 bg-panel-2 font-bold">
        <td className="num whitespace-nowrap px-2 py-1.5">{block.partida.code}</td>
        <td className="px-2 py-1.5" colSpan={2}>
          <span className="flex items-center gap-2">
            <Swatch color={block.partida.color} /> {block.partida.name}
          </span>
        </td>
        <td colSpan={7} />
        <td />
        <td className={cx(cellNum, 'text-[15px]')}>
          {fmt(block.total, d)} <span className="text-2xs font-semibold text-ink-3">{block.partida.unit}</span>
        </td>
        <td className="px-1 text-right print:hidden">
          <button type="button" className="icon-btn h-7 w-7" title="Añadir una fila con medidas tecleadas" aria-label={`Añadir fila manual a ${block.partida.name}`} onClick={() => addManualRow(block.partida.id)}>
            <Plus size={15} />
          </button>
        </td>
      </tr>
      {ms.map((m, i) => (
        <Row key={m.id} m={m} row={block.rows[i]} block={block} index={i} d={d} selected={selection.includes(m.id)} />
      ))}
      {ms.length === 0 && (
        <tr className="border-b border-line">
          <td />
          <td colSpan={12} className="px-2 py-1.5 text-2xs text-ink-3">
            Sin mediciones todavía.
          </td>
        </tr>
      )}
    </tbody>
  );
}

export function MetradoTable() {
  const open = useStore((s) => s.ui.tableOpen);
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.ui.selection);
  const blocks = useMemo(() => (open ? buildSheet(project) : []), [open, project]);
  if (!open) return null;
  const d = project.settings.decimals;
  const incomplete = blocks.some((b) => b.incomplete);
  return (
    <section aria-label="Hoja de metrados" className="absolute inset-0 z-40 flex animate-sheet-up flex-col bg-panel print:static">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-[max(1rem,env(safe-area-inset-left,0px))] py-2 print:hidden">
        <div className="mr-auto min-w-0">
          <p className="rotulo">Hoja de metrados</p>
          <h2 className="truncate text-base font-bold">{project.name}</h2>
        </div>
        <label className="flex items-center gap-1.5 text-2xs text-ink-2">
          Decimales
          <select className="field !min-h-0 h-8 !w-16 !py-0" value={d} onChange={(e) => store.update((p) => ({ ...p, settings: { ...p.settings, decimals: Number(e.target.value) as 2 | 3 | 4 } }))}>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
          </select>
        </label>
        <button type="button" className="btn btn-primary h-8 min-h-0" onClick={() => void exportExcel()}>
          <FileSpreadsheet size={15} /> Excel
        </button>
        <button type="button" className="btn h-8 min-h-0" onClick={() => void copyTable()}>
          <ClipboardCopy size={15} /> Copiar
        </button>
        <button type="button" className="btn h-8 min-h-0" onClick={() => void exportCsv()}>
          <FileText size={15} /> CSV
        </button>
        {!hostedInClaude && (
          <button type="button" className="btn h-8 min-h-0" onClick={() => window.print()}>
            <Printer size={15} /> Imprimir
          </button>
        )}
        <button type="button" className="icon-btn" onClick={() => store.setUi({ tableOpen: false })} aria-label="Cerrar la hoja de metrados" title="Cerrar (volver al plano)">
          <X size={18} />
        </button>
      </header>
      {incomplete && (
        <p className="border-b border-line bg-warn-soft px-4 py-1.5 text-2xs text-warn print:hidden">Hay filas sin calcular (lámina sin escala o falta un dato): no entran en los totales hasta que se completen.</p>
      )}
      <div className="min-h-0 flex-1 overflow-auto pb-10">
        {blocks.length === 0 ? (
          <p className="px-4 py-10 text-center text-ink-3">Aún no hay partidas. Crea una en el panel Partidas y mide sobre el plano.</p>
        ) : (
          <table className="w-full min-w-[60rem] border-collapse text-[13px]">
            <thead className="sticky top-0 z-10 bg-panel shadow-[0_1px_0_rgb(var(--c-line-strong))]">
              <tr className="rotulo text-left">
                <th className="px-2 py-2 font-semibold">Ítem</th>
                <th className="px-2 py-2 font-semibold">Descripción</th>
                <th className="px-2 py-2 font-semibold">Lámina</th>
                <th className="px-2 py-2 text-right font-semibold">N.º veces</th>
                <th className="px-2 py-2 text-right font-semibold">Cant.</th>
                <th className="px-2 py-2 text-right font-semibold">Largo</th>
                <th className="px-2 py-2 text-right font-semibold">Ancho</th>
                <th className="px-2 py-2 text-right font-semibold">Alto</th>
                <th className="px-2 py-2 text-right font-semibold">Área</th>
                <th className="px-2 py-2 text-right font-semibold">Factor</th>
                <th className="px-2 py-2 text-right font-semibold">Parcial</th>
                <th className="px-2 py-2 text-right font-semibold">Total</th>
                <th className="print:hidden" />
              </tr>
            </thead>
            {blocks.map((b) => (
              <Block key={b.partida.id} block={b} project={project} selection={selection} />
            ))}
          </table>
        )}
        <p className="px-4 py-3 text-2xs text-ink-3">
          Parcial = N.º de veces × las medidas de la fila. Las medidas leídas del plano se redondean a {d} decimales antes de multiplicar; el total de cada partida es la suma de sus parciales. Los descuentos restan.
        </p>
      </div>
    </section>
  );
}
