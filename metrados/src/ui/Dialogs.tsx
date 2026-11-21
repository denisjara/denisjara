/**
 * Ventanas de diálogo: escala de la lámina, partidas, catálogo, proyectos, ayuda y confirmaciones.
 */
import { useEffect, useMemo, useState } from 'react';
import { DraftingCompass, FileArchive, FolderOpen, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { addPartida, patchPartida, removeScale, saveScale, setTool, takePendingTool } from '../app/actions';
import { deleteProject, listProjects, loadProject, type ProjectInfo } from '../app/persist';
import { importProjectFile } from '../app/project-file';
import { registerFile } from '../app/plans';
import { store, useStore, type Dialog } from '../app/store';
import { CATALOG, nextCode, partidaFromTemplate, type PartidaTemplate } from '../core/catalog';
import { dist } from '../core/geometry';
import { allowedParams, formulaText } from '../core/metrado';
import { emptyProject, kindForBase, newId, nextPartidaColor, PARTIDA_COLORS, type Base, type DrawingUnit, type ParamKey, type Partida, type ScaleDef } from '../core/model';
import { COMMON_RATIOS, drawingUnitFromInsUnits, guessDrawingUnit, mPerUnitFromRatio, ratioFromMPerUnit, UNIT_LABEL, UNIT_TO_M } from '../core/units';
import { pickFiles } from './files';
import { cx, fmt, Modal, NumberField, Spinner, useRuntime } from './kit';
import { paramLabel } from './PartidasTab';
import { loadSample } from './Viewer';

const close = () => store.setUi({ dialog: null });

// ---------------------------------------------------------------------------
// Escala
// ---------------------------------------------------------------------------

type ScaleMode = 'ratio' | 'units' | 'calib';

function ScaleDialog({ d }: { d: Extract<Dialog, { type: 'scale' }> }) {
  const sheet = useStore((s) => s.project.sheets.find((x) => x.id === d.sheetId) ?? null);
  const rt = useRuntime(sheet);
  const existing = sheet?.scales.find((s) => s.id === d.scaleId) ?? null;
  const calib = d.calib ?? existing?.calib ?? null;
  const [mode, setMode] = useState<ScaleMode>(d.calib ? 'calib' : existing ? (existing.source === 'calibration' ? 'calib' : existing.source === 'units' ? 'units' : 'ratio') : sheet?.kind === 'pdf' ? 'ratio' : sheet?.kind === 'dxf' ? 'units' : 'calib');
  const [name, setName] = useState(existing?.name ?? '');
  const [ratio, setRatio] = useState<number | undefined>(existing?.ratio);
  const [unit, setUnit] = useState<DrawingUnit>(existing?.unit ?? 'm');
  const [real, setReal] = useState<number | undefined>(d.calib ? undefined : existing?.calib?.real);
  // Sugiere la escala escrita en el plano en cuanto se termina de leer.
  useEffect(() => {
    if (ratio === undefined && !existing && rt?.ratios.length) setRatio(rt.ratios[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt]);
  if (!sheet) return null;

  const planDist = calib ? dist(calib.a, calib.b) : null;
  const mPerUnit = mode === 'ratio' ? (ratio && ratio > 0 ? mPerUnitFromRatio(ratio) : null) : mode === 'units' ? UNIT_TO_M[unit] : planDist && real && real > 0 ? real / planDist : null;
  const modes: ScaleMode[] = sheet.kind === 'pdf' ? ['ratio', 'calib'] : sheet.kind === 'dxf' ? ['units', 'calib'] : ['calib'];
  const modeLabel: Record<ScaleMode, string> = { ratio: 'Escala del plano', units: 'Unidad de dibujo', calib: 'Calibrar con una cota' };
  // La lámina de un DXF lleva alrededor un margen del 2 % de su lado mayor.
  const margin = (Math.max(sheet.w, sheet.h) / 1.04) * 0.02;
  const declared = drawingUnitFromInsUnits(rt?.dxf?.insUnits);
  const guessed = sheet.kind === 'dxf' ? guessDrawingUnit(Math.max(sheet.w, sheet.h) / 1.04) : null;
  const otherRatio = sheet.scales.find((s) => s.source === 'ratio' && s.id !== existing?.id)?.ratio ?? rt?.ratios[0];
  const equivalent = mode === 'calib' && mPerUnit && sheet.kind === 'pdf' ? ratioFromMPerUnit(mPerUnit) : null;

  const save = () => {
    if (!mPerUnit) return;
    const auto = mode === 'ratio' ? `Escala 1:${fmt(ratio!, Number.isInteger(ratio!) ? 0 : 2)}` : mode === 'units' ? `1 unidad = 1 ${unit === 'm' ? 'metro' : UNIT_LABEL[unit].replace(/s$/, '')}` : `Calibrada con cota de ${fmt(real!, 2)} m`;
    const scale: ScaleDef = { id: existing?.id ?? newId('esc'), name: name.trim() || auto, mPerUnit, source: mode === 'ratio' ? 'ratio' : mode === 'units' ? 'units' : 'calibration' };
    if (mode === 'ratio') scale.ratio = ratio;
    if (mode === 'units') scale.unit = unit;
    if (mode === 'calib' && calib && real) scale.calib = { a: calib.a, b: calib.b, real };
    saveScale(sheet.id, scale);
    close();
    store.toast('Escala guardada. Compruébala midiendo una cota con la Regla (M).', 'ok');
  };

  return (
    <Modal
      title={existing ? (existing.source === 'units' ? 'Unidad del dibujo' : 'Editar escala') : sheet.scales.length ? 'Añadir otra escala a la lámina' : 'Escala de la lámina'}
      onClose={close}
      footer={
        <>
          {existing && (
            <button
              type="button"
              className="btn btn-danger mr-auto"
              onClick={() => {
                removeScale(sheet.id, existing.id);
                close();
              }}
            >
              <Trash2 size={15} /> Eliminar
            </button>
          )}
          <button type="button" className="btn" onClick={close}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" disabled={!mPerUnit} onClick={save}>
            Guardar escala
          </button>
        </>
      }
    >
      <p className="text-ink-2">
        La escala convierte lo que se lee del plano en metros reales. <b className="text-ink">{sheet.name}</b>
        {sheet.scales.length > 0 && !existing && ' ya tiene escala: añade otra solo si la lámina tiene detalles dibujados a una escala distinta.'}
      </p>
      {modes.length > 1 && (
        <div className="mt-3 flex gap-1 rounded-lg bg-panel-2 p-1" role="tablist">
          {modes.map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={cx('flex-1 rounded-md px-2 py-1.5 font-semibold', mode === m ? 'bg-panel shadow-float' : 'text-ink-2 hover:text-ink')} onClick={() => setMode(m)}>
              {modeLabel[m]}
            </button>
          ))}
        </div>
      )}

      {mode === 'ratio' && (
        <div className="mt-4">
          <label className="rotulo" htmlFor="scale-ratio">
            Escala gráfica
          </label>
          <div className="mt-1 flex items-center gap-2">
            <span className="num text-lg font-bold">1 :</span>
            <NumberField id="scale-ratio" className="!w-28 text-lg font-bold" value={ratio} onChange={setRatio} placeholder="50" autoFocus />
          </div>
          {rt && rt.ratios.length > 0 && (
            <p className="mt-2 text-2xs text-ink-2">
              Escrita en el plano:{' '}
              {rt.ratios.slice(0, 5).map((r) => (
                <button key={r} type="button" className="chip mr-1 h-6 min-h-0 px-2 text-2xs" aria-pressed={ratio === r} onClick={() => setRatio(r)}>
                  1/{r}
                </button>
              ))}
            </p>
          )}
          <p className="mt-2 flex flex-wrap gap-1">
            {COMMON_RATIOS.map((r) => (
              <button key={r} type="button" className="chip h-6 min-h-0 px-2 text-2xs" aria-pressed={ratio === r} onClick={() => setRatio(r)}>
                1:{r}
              </button>
            ))}
          </p>
          <p className="mt-3 flex items-start gap-1.5 rounded-md bg-warn-soft px-2.5 py-2 text-2xs text-warn">
            <TriangleAlert size={14} className="mt-px shrink-0" />
            <span>La escala escrita solo vale si el PDF se generó a tamaño real de papel. Si alguien lo exportó con «ajustar a página», no coincide: compruébalo con una cota o usa «Calibrar con una cota», que no depende de eso.</span>
          </p>
        </div>
      )}

      {mode === 'units' && (
        <div className="mt-4">
          <p className="rotulo">Una unidad del dibujo es</p>
          <div className="mt-1 grid grid-cols-3 gap-1.5 sm:grid-cols-5">
            {(['m', 'cm', 'mm', 'in', 'ft'] as DrawingUnit[]).map((u) => (
              <button key={u} type="button" className="chip justify-center" aria-pressed={unit === u} onClick={() => setUnit(u)}>
                1 {u === 'in' ? 'pulg' : u === 'ft' ? 'pie' : u}
              </button>
            ))}
          </div>
          <p className="num mt-3 rounded-md bg-panel-2 px-2.5 py-2">
            Con esta unidad el dibujo mide <b>{fmt((sheet.w - 2 * margin) * UNIT_TO_M[unit], 2)} × {fmt((sheet.h - 2 * margin) * UNIT_TO_M[unit], 2)} m</b>. ¿Tiene sentido para tu plano?
          </p>
          <p className="mt-2 text-2xs text-ink-3">
            {declared ? `El archivo declara ${UNIT_LABEL[declared]}.` : guessed ? `El archivo no declara su unidad; por el tamaño del dibujo parecen ${UNIT_LABEL[guessed]}.` : ''} Muchos planos se dibujan en metros aunque la plantilla diga milímetros: ante la duda, mide una cota con la Regla.
          </p>
        </div>
      )}

      {mode === 'calib' && (
        <div className="mt-4">
          {!calib || !planDist ? (
            <div className="rounded-md bg-panel-2 p-3 text-center">
              <p className="text-ink-2">Marca en el plano los dos extremos de una medida que conozcas (una cota, un eje, la escala gráfica). Cuanto más larga, mejor.</p>
              <button
                type="button"
                className="btn btn-primary mt-3"
                onClick={() => {
                  close();
                  setTool('calibrate');
                }}
              >
                <DraftingCompass size={16} /> Marcar los dos puntos
              </button>
            </div>
          ) : (
            <>
              <p className="num text-ink-2">
                Distancia entre los dos puntos en el plano: <b className="text-ink">{fmt(planDist, 3)}</b> {sheet.kind === 'pdf' ? 'pt' : sheet.kind === 'image' ? 'px' : 'u'}
              </p>
              <label className="rotulo mt-3 block" htmlFor="scale-real">
                Distancia real entre esos puntos (metros)
              </label>
              <NumberField id="scale-real" className="mt-1 !w-40 text-lg font-bold" value={real} onChange={setReal} placeholder="p. ej. 10.00" autoFocus />
              {equivalent && (
                <p className="num mt-3 rounded-md bg-panel-2 px-2.5 py-2">
                  Equivale a una escala <b>1:{fmt(equivalent, 2)}</b>
                  {otherRatio ? (
                    <>
                      {' '}
                      — difiere un <b>{fmt(Math.abs(equivalent / otherRatio - 1) * 100, 2)} %</b> de 1:{otherRatio}
                      {Math.abs(equivalent / otherRatio - 1) > 0.005 ? '. La diferencia es apreciable: fíate de la cota.' : '.'}
                    </>
                  ) : (
                    '.'
                  )}
                </p>
              )}
              <button
                type="button"
                className="mt-2 text-2xs font-semibold text-accent-text hover:underline"
                onClick={() => {
                  close();
                  setTool('calibrate');
                }}
              >
                Volver a marcar los puntos
              </button>
            </>
          )}
        </div>
      )}

      <label className="rotulo mt-5 block" htmlFor="scale-name">
        Nombre (opcional)
      </label>
      <input id="scale-name" className="field mt-1" placeholder="Planta, Detalle 1, Corte A-A…" value={name} onChange={(e) => setName(e.target.value)} />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Partidas
// ---------------------------------------------------------------------------

const BASE_OPTIONS: { base: Base; label: string; hint: string }[] = [
  { base: 'L', label: 'Longitud', hint: 'se dibuja una línea' },
  { base: 'A', label: 'Área', hint: 'se dibuja un contorno' },
  { base: 'P', label: 'Perímetro', hint: 'el contorno de un área' },
  { base: 'N', label: 'Cantidad', hint: 'se marcan puntos' },
];
const UNITS = ['m', 'm²', 'm³', 'kg', 'und', 'pto', 'pza', 'glb'];

function defaultUnit(base: Base, use: Partida['use']): string {
  const dims = (base === 'L' || base === 'P' ? 1 : base === 'A' ? 2 : 0) + (use.largo ? 1 : 0) + (use.ancho ? 1 : 0) + (use.alto ? 1 : 0);
  if (use.factor) return base === 'L' ? 'kg' : 'und';
  return dims === 0 ? 'und' : dims === 1 ? 'm' : dims === 2 ? 'm²' : 'm³';
}

function PartidaDialog({ d }: { d: Extract<Dialog, { type: 'partida' }> }) {
  const partidas = useStore((s) => s.project.partidas);
  const measurements = useStore((s) => s.project.measurements);
  const existing = partidas.find((p) => p.id === d.partidaId) ?? null;
  const [draft, setDraft] = useState<Partida>(
    () =>
      existing ?? {
        id: newId('par'),
        code: nextCode(partidas),
        name: '',
        unit: defaultUnit(d.base ?? 'L', {}),
        base: d.base ?? 'L',
        use: {},
        color: nextPartidaColor(partidas),
      },
  );
  const [unitTouched, setUnitTouched] = useState(!!existing);
  const used = existing ? measurements.filter((m) => m.partidaId === existing.id && m.kind !== 'manual').length : 0;
  const set = (patch: Partial<Partida>) =>
    setDraft((p) => {
      const next = { ...p, ...patch };
      if (!unitTouched && (patch.base || patch.use)) next.unit = defaultUnit(next.base, next.use);
      return next;
    });
  const valid = draft.name.trim().length > 0 && draft.unit.trim().length > 0;
  const save = () => {
    if (!valid) return;
    const clean: Partida = { ...draft, name: draft.name.trim(), code: draft.code.trim(), unit: draft.unit.trim() };
    // Solo se guardan los multiplicadores que la fórmula usa.
    const use: Partida['use'] = {};
    for (const k of allowedParams(clean.base)) if (clean.use[k]) use[k] = true;
    clean.use = use;
    if (existing) patchPartida(existing.id, clean, false);
    else addPartida(clean);
    close();
    const tool = existing ? null : takePendingTool();
    if (tool) setTool(tool);
  };
  return (
    <Modal
      title={existing ? 'Editar partida' : 'Nueva partida'}
      onClose={() => {
        takePendingTool();
        close();
      }}
      footer={
        <>
          {!existing && (
            <button type="button" className="btn mr-auto" onClick={() => store.setUi({ dialog: { type: 'catalog' } })}>
              Elegir del catálogo
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => {
              takePendingTool();
              close();
            }}
          >
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" disabled={!valid} onClick={save}>
            {existing ? 'Guardar' : 'Crear partida'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-[5.5rem_1fr] gap-2">
        <div>
          <label className="rotulo" htmlFor="par-code">
            Ítem
          </label>
          <input id="par-code" className="field num mt-0.5" value={draft.code} onChange={(e) => set({ code: e.target.value })} />
        </div>
        <div>
          <label className="rotulo" htmlFor="par-name">
            Descripción
          </label>
          <input id="par-name" data-autofocus className="field mt-0.5" placeholder="Muro de ladrillo KK de soga" value={draft.name} onChange={(e) => set({ name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && save()} />
        </div>
      </div>

      <p className="rotulo mt-4">Qué se lee del plano</p>
      <div className="mt-1 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {BASE_OPTIONS.map((o) => {
          const blocked = used > 0 && kindForBase(o.base) !== kindForBase(draft.base);
          return (
            <button
              key={o.base}
              type="button"
              disabled={blocked}
              aria-pressed={draft.base === o.base}
              title={blocked ? 'La partida ya tiene mediciones de otro tipo' : undefined}
              className={cx('rounded-md border px-2 py-1.5 text-left disabled:opacity-40', draft.base === o.base ? 'border-accent bg-accent-soft' : 'border-line-strong/70 hover:bg-panel-3')}
              onClick={() => set({ base: o.base })}
            >
              <span className="block font-semibold">{o.label}</span>
              <span className="block text-2xs text-ink-3">{o.hint}</span>
            </button>
          );
        })}
      </div>

      <p className="rotulo mt-4">Se multiplica por</p>
      <div className="mt-1 space-y-1.5">
        {allowedParams(draft.base).map((key: ParamKey) => (
          <div key={key} className="flex items-center gap-2">
            <label className="flex w-36 shrink-0 items-center gap-2">
              <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--c-accent))]" checked={!!draft.use[key]} onChange={(e) => set({ use: { ...draft.use, [key]: e.target.checked } })} />
              {key === 'factor' ? 'Factor' : paramLabel(draft, key)}
            </label>
            {draft.use[key] && (
              <>
                <NumberField ariaLabel={`Valor de ${paramLabel(draft, key)}`} className="!w-24" value={draft[key]} onChange={(v) => set({ [key]: v })} placeholder={key === 'factor' ? '1' : 'm'} />
                {key === 'factor' ? <input className="field !w-32" placeholder="kg/m, caras…" aria-label="Qué es el factor" value={draft.factorLabel ?? ''} onChange={(e) => set({ factorLabel: e.target.value })} /> : <span className="text-2xs text-ink-3">m · se puede cambiar en cada medición</span>}
              </>
            )}
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-[1fr_7rem] gap-2">
        <div>
          <p className="rotulo">Fórmula</p>
          <p className="mt-1 rounded-md bg-panel-2 px-2.5 py-2 font-semibold">N.º de veces × {formulaText(draft)}</p>
        </div>
        <div>
          <label className="rotulo" htmlFor="par-unit">
            Unidad
          </label>
          <input
            id="par-unit"
            className="field mt-1"
            list="par-units"
            value={draft.unit}
            onChange={(e) => {
              setUnitTouched(true);
              set({ unit: e.target.value });
            }}
          />
          <datalist id="par-units">
            {UNITS.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </div>
      </div>

      <p className="rotulo mt-4">Color en el plano</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {PARTIDA_COLORS.map((c) => (
          <button key={c} type="button" aria-label={`Color ${c}`} aria-pressed={draft.color === c} className={cx('h-7 w-7 rounded-md border-2', draft.color === c ? 'border-ink' : 'border-transparent')} style={{ background: c }} onClick={() => set({ color: c })} />
        ))}
      </div>
    </Modal>
  );
}

function CatalogDialog() {
  const partidas = useStore((s) => s.project.partidas);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<PartidaTemplate>>(new Set());
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const map = new Map<string, PartidaTemplate[]>();
    for (const t of CATALOG) {
      if (needle && !t.name.toLowerCase().includes(needle)) continue;
      const list = map.get(t.group);
      if (list) list.push(t);
      else map.set(t.group, [t]);
    }
    return [...map.entries()];
  }, [q]);
  const add = () => {
    const created: Partida[] = [];
    for (const t of CATALOG) if (picked.has(t)) created.push(partidaFromTemplate(t, [...partidas, ...created]));
    if (!created.length) return;
    store.update((p) => ({ ...p, partidas: [...p.partidas, ...created] }));
    store.setUi({ dialog: null, activePartidaId: created[0].id, panelTab: 'partidas', panelOpen: true });
    const tool = takePendingTool();
    if (tool) setTool(tool);
  };
  return (
    <Modal
      title="Catálogo de partidas"
      wide
      onClose={close}
      footer={
        <>
          <button type="button" className="btn mr-auto" onClick={() => store.setUi({ dialog: { type: 'partida' } })}>
            <Plus size={15} /> Crear una a medida
          </button>
          <button type="button" className="btn" onClick={close}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" disabled={picked.size === 0} onClick={add}>
            Añadir {picked.size > 0 ? `${picked.size} ${picked.size === 1 ? 'partida' : 'partidas'}` : ''}
          </button>
        </>
      }
    >
      <input className="field" data-autofocus placeholder="Buscar: muro, piso, tubería, acero…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar en el catálogo" />
      <p className="mt-2 text-2xs text-ink-3">Partidas habituales en edificación con su fórmula. Todo se puede cambiar después: nombre, unidad, alturas, anchos.</p>
      {groups.length === 0 && <p className="mt-6 text-center text-ink-3">Nada coincide con «{q}». Puedes crearla a medida.</p>}
      {groups.map(([group, list]) => (
        <section key={group} className="mt-4">
          <h3 className="rotulo">{group}</h3>
          <ul className="mt-1 grid gap-x-4 sm:grid-cols-2">
            {list.map((t) => {
              const on = picked.has(t);
              return (
                <li key={t.name}>
                  <label className={cx('flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5', on ? 'bg-accent-soft' : 'hover:bg-panel-3')}>
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--c-accent))]"
                      checked={on}
                      onChange={() =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (next.has(t)) next.delete(t);
                          else next.add(t);
                          return next;
                        })
                      }
                    />
                    <span className="min-w-0">
                      <span className="block">{t.name}</span>
                      <span className="block text-2xs text-ink-3">
                        {formulaText({ base: t.base, use: Object.fromEntries((t.use ?? []).map((k) => [k, true])), factorLabel: t.factorLabel })} · {t.unit}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Proyectos
// ---------------------------------------------------------------------------

export async function openProjectFile(): Promise<void> {
  const [file] = await pickFiles('.zip,application/zip', false);
  if (!file) return;
  store.setUi({ busy: 'Abriendo el proyecto…', dialog: null });
  try {
    const { project, blobs, missing } = await importProjectFile(file);
    for (const f of project.files) {
      const blob = blobs.get(f.id);
      if (blob) registerFile(f, blob);
    }
    store.loadProject(project, { busy: null });
    store.toast(missing.length ? `Proyecto abierto. Faltan planos en el archivo: ${missing.join(', ')}` : `Proyecto «${project.name}» abierto.`, missing.length ? 'error' : 'ok');
  } catch (e) {
    store.setUi({ busy: null });
    store.toast(e instanceof Error ? e.message : 'No se pudo abrir el proyecto.', 'error');
  }
}

function ProjectsDialog() {
  const currentId = useStore((s) => s.project.id);
  const [list, setList] = useState<ProjectInfo[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  useEffect(() => {
    void listProjects().then(setList);
  }, []);
  const open = async (id: string) => {
    store.setUi({ busy: 'Abriendo el proyecto…', dialog: null });
    const p = await loadProject(id);
    store.setUi({ busy: null });
    if (p) store.loadProject(p);
    else store.toast('No se pudo abrir ese proyecto.', 'error');
  };
  return (
    <Modal title="Proyectos" onClose={close}>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" onClick={() => store.loadProject(emptyProject(), { dialog: null })}>
          <Plus size={15} /> Proyecto nuevo
        </button>
        <button type="button" className="btn" onClick={() => void openProjectFile()}>
          <FileArchive size={15} /> Abrir archivo de proyecto (.zip)
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            close();
            void loadSample();
          }}
        >
          Ver el ejemplo
        </button>
      </div>
      <h3 className="rotulo mt-5">Guardados en este navegador</h3>
      {list === null ? (
        <p className="mt-3 flex items-center gap-2 text-ink-2">
          <Spinner /> Buscando…
        </p>
      ) : list.length === 0 ? (
        <p className="mt-2 text-ink-3">Todavía no hay proyectos guardados. Se guardan solos mientras trabajas.</p>
      ) : (
        <ul className="mt-1 divide-y divide-line">
          {list.map((p) => (
            <li key={p.id} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">
                  {p.name} {p.id === currentId && <span className="ml-1 rounded bg-accent-soft px-1.5 py-0.5 text-2xs text-accent-text">abierto</span>}
                </span>
                <span className="num block text-2xs text-ink-3">
                  {p.sheets} {p.sheets === 1 ? 'lámina' : 'láminas'} · {p.measurements} mediciones · {new Date(p.updatedAt).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' })}
                </span>
              </span>
              {confirmId === p.id ? (
                <>
                  <button
                    type="button"
                    className="btn btn-danger h-8 min-h-0"
                    onClick={async () => {
                      await deleteProject(p.id);
                      setConfirmId(null);
                      setList(await listProjects());
                      if (p.id === currentId) store.loadProject(emptyProject(), { dialog: { type: 'projects' } });
                    }}
                  >
                    Borrar del navegador
                  </button>
                  <button type="button" className="btn h-8 min-h-0" onClick={() => setConfirmId(null)}>
                    No
                  </button>
                </>
              ) : (
                <>
                  {p.id !== currentId && (
                    <button type="button" className="btn h-8 min-h-0" onClick={() => void open(p.id)}>
                      <FolderOpen size={15} /> Abrir
                    </button>
                  )}
                  <button type="button" className="icon-btn h-8 w-8 hover:!text-danger" aria-label={`Borrar ${p.name}`} title="Borrar" onClick={() => setConfirmId(p.id)}>
                    <Trash2 size={15} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 rounded-md bg-panel-2 px-2.5 py-2 text-2xs text-ink-2">
        Los proyectos y sus planos se guardan solo en este navegador de este equipo; no se suben a ningún servidor. Para una copia de seguridad o para llevar el trabajo a otro equipo, usa «Guardar copia del proyecto (.zip)» en el menú.
      </p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Ayuda
// ---------------------------------------------------------------------------

const SHORTCUTS: [string, string][] = [
  ['V', 'Seleccionar y editar'],
  ['L', 'Longitud'],
  ['A', 'Área'],
  ['R', 'Rectángulo'],
  ['C', 'Conteo (o cerrar la línea en curso)'],
  ['T', 'Tomar un trazo del plano'],
  ['B', 'Área automática'],
  ['M', 'Regla (medir sin guardar)'],
  ['K', 'Calibrar escala'],
  ['Intro', 'Terminar el trazo'],
  ['Retroceso', 'Quitar el último punto'],
  ['Esc', 'Cancelar'],
  ['Mayús', 'Ortogonal (horizontal o vertical)'],
  ['0-9 + Intro', 'Tramo de longitud exacta'],
  ['D', 'Descuento sí/no'],
  ['S', 'Enganche sí/no'],
  ['F', 'Ver toda la lámina'],
  ['Espacio + arrastrar', 'Mover el plano'],
  ['Ctrl + Z / Y', 'Deshacer / rehacer'],
  ['Supr', 'Borrar lo seleccionado'],
];

function HelpDialog() {
  return (
    <Modal title="Cómo metrar con Metrado Lab" wide onClose={close}>
      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        <section>
          <h3 className="rotulo">En cuatro pasos</h3>
          <ol className="mt-1.5 list-decimal space-y-1.5 pl-5 text-ink-2">
            <li>
              <b className="text-ink">Abre el plano</b>: PDF de AutoCAD o Revit, DXF o imagen. Cada página es una lámina.
            </li>
            <li>
              <b className="text-ink">Fija la escala</b> y compruébala midiendo una cota con la Regla.
            </li>
            <li>
              <b className="text-ink">Crea las partidas</b> (o tómalas del catálogo) y mide: clic para cada punto; el cursor se engancha solo a las esquinas del plano.
            </li>
            <li>
              <b className="text-ink">Revisa la hoja de metrados</b> y expórtala a Excel con sus fórmulas.
            </li>
          </ol>
          <h3 className="rotulo mt-5">Qué tan exacta es la lectura</h3>
          <ul className="mt-1.5 list-disc space-y-1.5 pl-5 text-ink-2">
            <li>
              <b className="text-ink">DXF</b>: se leen las coordenadas del dibujo tal cual, con precisión doble. Longitudes y áreas (rectas, arcos y curvas) se calculan con fórmula, no con aproximaciones.
            </li>
            <li>
              <b className="text-ink">PDF vectorial</b>: se leen los vértices que el PDF contiene; el enganche coloca cada punto exactamente sobre ellos. El límite es el del propio archivo: un PDF de CAD suele guardar las coordenadas con una resolución en torno a 0.02 mm de papel (±1 mm reales a escala 1:50).
            </li>
            <li>
              <b className="text-ink">Escaneos y fotos</b>: no hay vértices que leer; la precisión depende de la imagen y de dónde hagas clic. Calibra con la cota más larga que tengas y trabaja con mucho zoom.
            </li>
            <li>
              La escala manda: una escala 1:50 escrita en un PDF que se imprimió «ajustado a página» da medidas falsas. Por eso la app te pide comprobarla con una cota.
            </li>
            <li>
              En la hoja, cada medida se redondea a los decimales del proyecto antes de multiplicar, como en una hoja hecha a mano: lo que ves es lo que suma, y el Excel da lo mismo.
            </li>
          </ul>
        </section>
        <section>
          <h3 className="rotulo">Leer el plano de una vez</h3>
          <ul className="mt-1.5 list-disc space-y-1.5 pl-5 text-ink-2">
            <li>
              <b className="text-ink">Tomar trazo (T)</b>: clic sobre una línea, polilínea o contorno del plano y se mide tal como está dibujado.
            </li>
            <li>
              <b className="text-ink">Área automática (B)</b>: mueve el cursor dentro de un ambiente cerrado; se resalta su contorno y un clic lo mide. Si las puertas o el mobiliario lo cortan, oculta esas capas en Láminas.
            </li>
            <li>
              <b className="text-ink">Pestaña Lectura</b>: mide todo lo de una capa o de un color, cuenta bloques de un DXF o las veces que aparece un rótulo (P-1, V-2…).
            </li>
          </ul>
          <h3 className="rotulo mt-5">Atajos de teclado</h3>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1">
            {SHORTCUTS.map(([k, v]) => (
              <div key={k} className="contents">
                <dt>
                  <span className="kbd">{k}</span>
                </dt>
                <dd className="text-ink-2">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-2xs text-ink-3">En pantallas táctiles: un toque coloca el punto; mantén pulsado para apuntar con precisión (el punto queda por encima del dedo); dos dedos para acercar y mover.</p>
        </section>
      </div>
    </Modal>
  );
}

function ConfirmDialog({ d }: { d: Extract<Dialog, { type: 'confirm' }> }) {
  return (
    <Modal
      title={d.title}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            Cancelar
          </button>
          <button
            type="button"
            className={cx('btn', d.danger ? 'btn-danger' : 'btn-primary')}
            data-autofocus
            onClick={() => {
              close();
              d.onConfirm();
            }}
          >
            {d.confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-ink-2">{d.message}</p>
    </Modal>
  );
}

export function Dialogs() {
  const d = useStore((s) => s.ui.dialog);
  if (!d) return null;
  switch (d.type) {
    case 'scale':
      return <ScaleDialog key={`${d.sheetId}:${d.scaleId ?? ''}:${d.calib ? 'c' : ''}`} d={d} />;
    case 'partida':
      return <PartidaDialog key={d.partidaId ?? 'new'} d={d} />;
    case 'catalog':
      return <CatalogDialog />;
    case 'projects':
      return <ProjectsDialog />;
    case 'help':
      return <HelpDialog />;
    case 'confirm':
      return <ConfirmDialog d={d} />;
    default:
      return null;
  }
}
