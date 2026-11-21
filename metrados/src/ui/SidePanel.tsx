/**
 * Panel lateral: Partidas, Láminas (planos, escalas y capas) y Lectura (medir de una vez lo que la app ya leyó
 * del plano: por capa, por color, por bloque o por texto).
 */
import { useEffect, useMemo, useState } from 'react';
import { DraftingCompass, Eye, EyeOff, FileUp, Layers, Plus, ScanSearch, Search, Trash2, TriangleAlert, X } from 'lucide-react';
import { activePartida, addMeasurement, removeFile, renameSheet, setActiveScale, setLayerHidden, setTool } from '../app/actions';
import { forgetSheet, hasFile, registerFile, type SheetRuntime } from '../app/plans';
import { store, useStore, type PanelTab } from '../app/store';
import { partBBox, pointInPolygon, flattenPart, type Part, type Pt } from '../core/geometry';
import type { Sheet } from '../core/model';
import { partOfPath, PATH_CLOSED, PATH_FILL } from '../core/vector';
import { tracePart } from '../io/dxf/scene';
import { viewer } from '../viewer/controller';
import { pickFiles, PLAN_ACCEPT } from './files';
import { cx, fmt, Spinner, Swatch, useRuntime } from './kit';
import { PartidasTab } from './PartidasTab';
import { scaleText } from './Toolbars';
import { openPlanDialog } from './Viewer';

const MAX_GROUP = 40000;

// ---------------------------------------------------------------------------
// Láminas
// ---------------------------------------------------------------------------

function LayerList({ sheet, rt }: { sheet: Sheet; rt: SheetRuntime }) {
  const [filter, setFilter] = useState('');
  const hidden = useMemo(() => new Set(sheet.hiddenLayers ?? []), [sheet.hiddenLayers]);
  const layers = rt.layers.filter((l) => !filter || l.name.toLowerCase().includes(filter.toLowerCase()));
  if (!rt.layers.length) return null;
  return (
    <section className="mt-4">
      <div className="flex items-center gap-2">
        <h3 className="rotulo flex-1">Capas del plano ({rt.layers.length})</h3>
        <button type="button" className="text-2xs font-semibold text-accent-text hover:underline" onClick={() => setLayerHidden(sheet.id, rt.layers.map((l) => l.id), false)}>
          Todas
        </button>
        <button type="button" className="text-2xs font-semibold text-accent-text hover:underline" onClick={() => setLayerHidden(sheet.id, rt.layers.map((l) => l.id), true)}>
          Ninguna
        </button>
      </div>
      {rt.layers.length > 12 && <input className="field mt-1.5 h-8 min-h-0" placeholder="Filtrar capas" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrar capas" />}
      <ul className="mt-1.5 max-h-64 overflow-y-auto">
        {layers.map((l) => {
          const off = hidden.has(l.id);
          return (
            <li key={l.id}>
              <button type="button" className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-panel-3" aria-pressed={!off} onClick={() => setLayerHidden(sheet.id, [l.id], !off)}>
                {off ? <EyeOff size={15} className="shrink-0 text-ink-3" /> : <Eye size={15} className="shrink-0 text-accent-text" />}
                <span className={cx('min-w-0 flex-1 truncate', off && 'text-ink-3 line-through')}>{l.name}</span>
                <span className="num shrink-0 text-2xs text-ink-3">{fmt(l.paths, 0)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-2xs text-ink-3">Una capa oculta no se dibuja, no engancha y no cuenta en «Área automática».</p>
    </section>
  );
}

function LaminasTab() {
  const project = useStore((s) => s.project);
  const sheetId = useStore((s) => s.ui.sheetId);
  const sheet = project.sheets.find((s) => s.id === sheetId) ?? null;
  const rt = useRuntime(sheet);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const m of project.measurements) if (m.sheetId) c.set(m.sheetId, (c.get(m.sheetId) ?? 0) + 1);
    return c;
  }, [project.measurements]);

  const relink = async (fileId: string) => {
    const meta = project.files.find((f) => f.id === fileId);
    const [file] = await pickFiles(PLAN_ACCEPT, false);
    if (!meta || !file) return;
    registerFile(meta, file);
    for (const s of project.sheets) if (s.fileId === fileId) forgetSheet(s.id);
    const current = store.get().ui.sheetId;
    store.setUi({ sheetId: null });
    store.setUi({ sheetId: current });
  };

  return (
    <div className="h-full overflow-y-auto px-4 pb-6 pt-3">
      <button type="button" className="btn h-8 min-h-0 w-full text-[13px]" onClick={() => void openPlanDialog()}>
        <FileUp size={15} /> Añadir plano (PDF, DXF o imagen)
      </button>
      {project.files.length === 0 && <p className="mt-4 text-center text-ink-3">No hay planos en el proyecto.</p>}
      {project.files.map((f) => {
        const sheets = project.sheets.filter((s) => s.fileId === f.id);
        const missing = !hasFile(f.id);
        return (
          <section key={f.id} className="mt-3">
            <div className="flex items-center gap-1.5">
              <span className="rounded bg-panel-3 px-1.5 py-0.5 text-2xs font-bold uppercase text-ink-2">{f.kind === 'image' ? 'IMG' : f.kind}</span>
              <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={f.name}>
                {f.name}
              </h3>
              <button
                type="button"
                className="icon-btn h-7 w-7 hover:!text-danger"
                title="Quitar este plano del proyecto"
                aria-label={`Quitar ${f.name}`}
                onClick={() => {
                  const n = project.measurements.filter((m) => m.sheetId && sheets.some((s) => s.id === m.sheetId)).length;
                  if (n === 0) removeFile(f.id);
                  else store.setUi({ dialog: { type: 'confirm', title: 'Quitar plano', message: `«${f.name}» tiene ${n} ${n === 1 ? 'medición' : 'mediciones'} que se eliminarán con él. Puedes deshacerlo con Ctrl+Z.`, confirmLabel: 'Quitar plano', danger: true, onConfirm: () => removeFile(f.id) } });
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
            {missing && (
              <div className="mt-1 flex items-center gap-2 rounded-md bg-warn-soft px-2 py-1.5 text-2xs text-warn">
                <TriangleAlert size={14} className="shrink-0" />
                <span className="flex-1">El archivo no está en este navegador.</span>
                <button type="button" className="font-bold underline" onClick={() => void relink(f.id)}>
                  Volver a cargarlo
                </button>
              </div>
            )}
            <ul className="mt-1 space-y-0.5">
              {sheets.map((s) => {
                const active = s.id === sheetId;
                const sc = s.scales.find((x) => x.id === s.activeScaleId);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={cx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left', active ? 'bg-accent-soft' : 'hover:bg-panel-3')}
                      aria-current={active || undefined}
                      onClick={() => store.setUi({ sheetId: s.id, selection: [], tool: 'select' })}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{s.name}</span>
                        <span className={cx('num block text-2xs', sc ? 'text-ink-3' : 'text-warn')}>
                          {scaleText(sc, s)}
                          {counts.get(s.id) ? ` · ${counts.get(s.id)} med.` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {sheet && (
        <section className="mt-5 border-t border-line pt-3">
          <label className="rotulo" htmlFor="sheet-name">
            Nombre de la lámina
          </label>
          <input id="sheet-name" className="field mt-0.5" value={sheet.name} onChange={(e) => renameSheet(sheet.id, e.target.value)} />
          <h3 className="rotulo mt-4">Escala</h3>
          {sheet.scales.length === 0 ? (
            <p className="mt-1 flex items-start gap-1.5 rounded-md bg-warn-soft px-2 py-1.5 text-2xs text-warn">
              <TriangleAlert size={14} className="mt-px shrink-0" /> Sin escala: las medidas de esta lámina todavía no están en metros.
            </p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {sheet.scales.map((sc) => (
                <li key={sc.id} className="flex items-center gap-2">
                  <input type="radio" id={`sc-${sc.id}`} name="active-scale" className="accent-[rgb(var(--c-accent))]" checked={sc.id === sheet.activeScaleId} onChange={() => setActiveScale(sheet.id, sc.id)} />
                  <label htmlFor={`sc-${sc.id}`} className="min-w-0 flex-1 truncate">
                    {sc.name}
                  </label>
                  <button type="button" className="num text-2xs font-semibold text-accent-text hover:underline" onClick={() => store.setUi({ dialog: { type: 'scale', sheetId: sheet.id, scaleId: sc.id } })}>
                    {scaleText(sc, sheet)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className="btn h-8 min-h-0 flex-1 text-[13px]" onClick={() => store.setUi({ dialog: { type: 'scale', sheetId: sheet.id } })}>
              <Plus size={15} /> {sheet.scales.length ? 'Otra escala' : 'Definir escala'}
            </button>
            <button type="button" className="btn h-8 min-h-0 flex-1 text-[13px]" onClick={() => setTool('calibrate')}>
              <DraftingCompass size={15} /> Calibrar con una cota
            </button>
          </div>
          {rt ? <LayerList sheet={sheet} rt={rt} /> : null}
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lectura automática
// ---------------------------------------------------------------------------

interface Group {
  key: string;
  label: string;
  color?: string;
  detail: string;
  count: number;
  /** El grupo son posiciones (bloques), no trazos: solo se puede contar. */
  pointsOnly?: boolean;
  /** Trazos del grupo según la magnitud de la partida activa. */
  parts(base: 'L' | 'A' | 'P' | 'N'): { parts: Part[]; points: Pt[] };
}

const center = (part: Part): Pt => {
  const b = partBBox(part);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
};

/** Clave de un trazo para descartar duplicados exactos (un mismo contorno pintado como relleno y como línea). */
function partKey(part: Part): string {
  let k = `${part.v.length}`;
  for (let i = 0; i < part.v.length && i < 5; i++) k += `|${part.v[i].x.toFixed(4)},${part.v[i].y.toFixed(4)}`;
  return k;
}

function collectPdf(rt: SheetRuntime, pred: (path: number) => boolean) {
  return (base: 'L' | 'A' | 'P' | 'N') => {
    const v = rt.vector!;
    const parts: Part[] = [];
    const points: Pt[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < v.pathCount && parts.length + points.length < MAX_GROUP; i++) {
      if (!pred(i)) continue;
      const flags = v.pathFlags[i];
      if (base === 'L' && flags & PATH_FILL) continue;
      if ((base === 'A' || base === 'P') && !(flags & PATH_CLOSED)) continue;
      const part = partOfPath(v, i);
      const key = partKey(part);
      if (seen.has(key)) continue;
      seen.add(key);
      if (base === 'N') points.push(center(part));
      else parts.push(part);
    }
    return { parts, points };
  };
}

function collectDxf(rt: SheetRuntime, pred: (index: number) => boolean) {
  return (base: 'L' | 'A' | 'P' | 'N') => {
    const scene = rt.dxf!;
    const parts: Part[] = [];
    const points: Pt[] = [];
    const hatchRings = new Map<number, Part[]>();
    for (let i = 0; i < scene.paths.length && parts.length + points.length < MAX_GROUP; i++) {
      const p = scene.paths[i];
      if (!pred(i)) continue;
      if (base === 'N') points.push(center(p.part));
      else if (base === 'L') {
        if (!p.fill && p.hatch < 0) parts.push(p.part);
      } else if (p.part.closed) {
        if (p.hatch >= 0) {
          const list = hatchRings.get(p.hatch);
          if (list) list.push(p.part);
          else hatchRings.set(p.hatch, [p.part]);
        } else parts.push(p.part);
      }
    }
    // Sombreados: un anillo contenido en un número impar de otros anillos del mismo sombreado es una isla (resta).
    for (const rings of hatchRings.values()) {
      const flat = rings.map((r) => flattenPart(r, 1e-6 * Math.max(scene.w, scene.h)));
      rings.forEach((ring, i) => {
        let depth = 0;
        flat.forEach((poly, j) => {
          if (j !== i && poly.length >= 3 && pointInPolygon(flat[i][0], poly)) depth++;
        });
        parts.push(depth % 2 === 1 ? { ...ring, hole: true } : ring);
      });
    }
    return { parts, points };
  };
}

function useGroups(rt: SheetRuntime | null): { layers: Group[]; styles: Group[]; blocks: Group[] } {
  return useMemo(() => {
    if (!rt?.vector) return { layers: [], styles: [], blocks: [] };
    const v = rt.vector;
    if (rt.dxf) {
      const scene = rt.dxf;
      const layers = rt.layers.map((l, i): Group => ({ key: `l${i}`, label: l.name, detail: `${fmt(l.paths, 0)} trazos`, count: l.paths, parts: collectDxf(rt, (k) => scene.paths[k].layer === i + 1) })).filter((g) => g.count > 0);
      const byName = new Map<string, Pt[]>();
      for (const ins of scene.inserts) {
        const list = byName.get(ins.name);
        if (list) list.push({ x: ins.x, y: ins.y });
        else byName.set(ins.name, [{ x: ins.x, y: ins.y }]);
      }
      const blocks = [...byName.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([name, pts]): Group => ({ key: `b${name}`, label: name, detail: `${pts.length} ${pts.length === 1 ? 'inserción' : 'inserciones'}`, count: pts.length, pointsOnly: true, parts: () => ({ parts: [], points: pts }) }));
      return { layers: layers.sort((a, b) => b.count - a.count), styles: [], blocks };
    }
    const layers = rt.layers.map((l, i): Group => ({ key: `l${i}`, label: l.name, detail: `${fmt(l.paths, 0)} trazos`, count: l.paths, parts: collectPdf(rt, (p) => v.pathLayer[p] === i + 1) })).filter((g) => g.count > 0);
    const styles = rt.styles
      .map(
        (s, i): Group => ({
          key: `s${i}`,
          label: s.stroke ? `Línea ${fmt(s.width, 2)} pt` : 'Relleno',
          color: s.color,
          detail: `${fmt(s.paths, 0)} trazos`,
          count: s.paths,
          parts: collectPdf(rt, (p) => v.pathStyle[p] === i),
        }),
      )
      .filter((g) => g.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 40);
    return { layers: layers.sort((a, b) => b.count - a.count), styles, blocks: [] };
  }, [rt]);
}

function measureGroup(g: Group, prefix: string): void {
  const partida = activePartida();
  if (!partida) {
    store.toast('Elige o crea primero la partida que vas a medir.');
    store.setUi({ dialog: { type: 'partida' } });
    return;
  }
  if (g.pointsOnly && partida.base !== 'N') {
    store.toast('Para contar bloques elige una partida de cantidad (und, pto…).');
    return;
  }
  const { parts, points } = g.parts(partida.base);
  const label = `${prefix} ${g.label}`.trim();
  let id: string | null = null;
  if (partida.base === 'N') {
    if (!points.length) return void store.toast('Ese grupo no tiene elementos que contar.');
    id = addMeasurement({ kind: 'count', parts: [{ v: points }], label, deduct: false });
  } else if (partida.base === 'L') {
    if (!parts.length) return void store.toast('Ese grupo no tiene líneas que medir.');
    id = addMeasurement({ kind: 'line', parts, label, deduct: false });
  } else {
    if (!parts.length) return void store.toast('Ese grupo no tiene contornos cerrados: no hay áreas que medir. Prueba con una partida de longitud.');
    id = addMeasurement({ kind: 'area', parts: parts.map((p) => ({ ...p, closed: true })), label, deduct: false });
  }
  if (id) {
    const n = partida.base === 'N' ? points.length : parts.length;
    store.setUi({ panelTab: 'partidas', tool: 'select' });
    store.toast(`${fmt(n, 0)} ${n === 1 ? 'elemento medido' : 'elementos medidos'} en «${partida.name}»${n >= MAX_GROUP ? ' (límite alcanzado: el grupo es mayor)' : ''}. Revisa el resultado en el plano.`, 'ok');
  }
}

function GroupList({ title, groups, prefix, shown, onShow }: { title: string; groups: Group[]; prefix: string; shown: string | null; onShow: (g: Group | null) => void }) {
  const [all, setAll] = useState(false);
  if (!groups.length) return null;
  const list = all ? groups : groups.slice(0, 12);
  return (
    <section className="mt-4">
      <h3 className="rotulo">{title}</h3>
      <ul className="mt-1 space-y-0.5">
        {list.map((g) => (
          <li key={g.key} className={cx('flex items-center gap-1.5 rounded-md py-0.5 pl-1.5 pr-0.5', shown === g.key ? 'bg-accent-soft' : 'hover:bg-panel-3')}>
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left" title="Resaltar en el plano" aria-pressed={shown === g.key} onClick={() => onShow(shown === g.key ? null : g)}>
              {g.color ? <Swatch color={g.color} /> : <Layers size={14} className="shrink-0 text-ink-3" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{g.label}</span>
                <span className="num block text-2xs text-ink-3">{g.detail}</span>
              </span>
            </button>
            <button type="button" className="btn h-7 min-h-0 shrink-0 px-2 text-2xs" onClick={() => measureGroup(g, prefix)}>
              {g.pointsOnly ? 'Contar' : 'Medir'}
            </button>
          </li>
        ))}
      </ul>
      {groups.length > 12 && (
        <button type="button" className="mt-1 text-2xs font-semibold text-accent-text hover:underline" onClick={() => setAll(!all)}>
          {all ? 'Ver menos' : `Ver los ${groups.length}`}
        </button>
      )}
    </section>
  );
}

function TextSearch({ rt }: { rt: SheetRuntime }) {
  const [q, setQ] = useState('');
  const [exact, setExact] = useState(true);
  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return rt.texts.filter((t) => {
      const s = t.str.trim().toLowerCase();
      return exact ? s === needle : s.includes(needle);
    });
  }, [q, exact, rt.texts]);
  useEffect(() => {
    viewer.current?.setMarks(hits.map((t) => ({ x: t.x + (Math.cos(t.angle) * t.w) / 2, y: t.y + (Math.sin(t.angle) * t.w) / 2 - t.h / 2 })));
    return () => viewer.current?.setMarks([]);
  }, [hits]);
  if (!rt.texts.length) return null;
  const count = () => {
    const partida = activePartida();
    if (!partida || partida.base !== 'N') return void store.toast('Para contar, elige una partida de cantidad (und, pto…).');
    if (!hits.length) return;
    addMeasurement({ kind: 'count', parts: [{ v: hits.map((t) => ({ x: t.x + (Math.cos(t.angle) * t.w) / 2, y: t.y + (Math.sin(t.angle) * t.w) / 2 - t.h / 2 })) }], label: `Texto «${q.trim()}»`, deduct: false });
    store.setUi({ panelTab: 'partidas', tool: 'select' });
  };
  return (
    <section className="mt-4">
      <h3 className="rotulo">Contar por texto</h3>
      <p className="mt-0.5 text-2xs text-ink-3">Escribe un rótulo del plano (P-1, V-2, C1…) y cuenta cuántas veces aparece.</p>
      <div className="relative mt-1.5">
        <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
        <input className="field pl-8 pr-8" placeholder="Texto a buscar" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Texto a buscar en el plano" />
        {q && (
          <button type="button" className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink" onClick={() => setQ('')} aria-label="Borrar búsqueda">
            <X size={15} />
          </button>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <label className="flex flex-1 items-center gap-1.5 text-2xs text-ink-2">
          <input type="checkbox" className="accent-[rgb(var(--c-accent))]" checked={exact} onChange={(e) => setExact(e.target.checked)} /> Texto completo
        </label>
        {q.trim() && <span className="num text-[13px] font-bold">{hits.length} coincidencias</span>}
        <button type="button" className="btn h-7 min-h-0 px-2 text-2xs" disabled={!hits.length} onClick={count}>
          Contar
        </button>
      </div>
    </section>
  );
}

function LecturaTab() {
  const sheet = useStore((s) => s.project.sheets.find((x) => x.id === s.ui.sheetId) ?? null);
  const partidas = useStore((s) => s.project.partidas);
  const activeId = useStore((s) => s.ui.activePartidaId);
  const rt = useRuntime(sheet);
  const groups = useGroups(rt);
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    setShown(null);
    return () => viewer.current?.setPreview(null);
  }, [rt]);
  if (!sheet) return <p className="px-4 py-6 text-center text-ink-3">Abre un plano para leer su geometría.</p>;
  if (!rt)
    return (
      <p className="flex items-center justify-center gap-2 px-4 py-6 text-ink-2">
        <Spinner /> Leyendo el plano…
      </p>
    );
  const active = partidas.find((p) => p.id === activeId);
  const show = (g: Group | null) => {
    setShown(g?.key ?? null);
    if (!g) return void viewer.current?.setPreview(null);
    const { parts, points } = g.parts(g.key.startsWith('b') ? 'N' : 'L');
    const shape = new Path2D();
    for (const p of parts) tracePart(shape, p);
    const r = Math.max(sheet.w, sheet.h) * 0.004;
    for (const p of points) {
      shape.moveTo(p.x + r, p.y);
      shape.arc(p.x, p.y, r, 0, Math.PI * 2);
    }
    viewer.current?.setPreview(shape);
  };
  if (!rt.vector)
    return (
      <div className="px-4 py-6 text-ink-2">
        <p className="font-semibold text-ink">Esta lámina es una imagen</p>
        <p className="mt-1">Un escaneo o una foto no tiene líneas que leer. Mide marcando los puntos con Longitud, Área y Conteo, después de calibrar la escala con una cota conocida.</p>
      </div>
    );
  return (
    <div className="h-full overflow-y-auto px-4 pb-6 pt-3">
      <div className="rounded-md border border-line bg-panel-2 px-2.5 py-2 text-[13px] text-ink-2">
        <p>
          <ScanSearch size={15} className="mr-1 inline text-accent-text" />
          La app leyó <b className="num text-ink">{fmt(rt.vector.pathCount, 0)}</b> trazos de esta lámina. Elige un grupo, mira qué resalta en el plano y pulsa <b className="text-ink">Medir</b>: se mide tal como está dibujado.
        </p>
        <p className="mt-1.5 text-2xs">
          Va a la partida activa: {active ? <b className="text-ink">{active.name}</b> : <b className="text-warn">ninguna (elige una)</b>}
          {active && (active.base === 'L' ? ' (suma longitudes)' : active.base === 'N' ? ' (cuenta elementos)' : ' (suma áreas cerradas)')}.
        </p>
      </div>
      <GroupList title="Por capa" groups={groups.layers} prefix="Capa" shown={shown} onShow={show} />
      <GroupList title="Bloques" groups={groups.blocks} prefix="Bloque" shown={shown} onShow={show} />
      <GroupList title="Por color y grosor de línea" groups={groups.styles} prefix="" shown={shown} onShow={show} />
      <TextSearch rt={rt} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'partidas', label: 'Partidas' },
  { id: 'laminas', label: 'Láminas' },
  { id: 'lectura', label: 'Lectura' },
];

export function SidePanel({ narrow }: { narrow: boolean }) {
  const tab = useStore((s) => s.ui.panelTab);
  const open = useStore((s) => s.ui.panelOpen);
  if (!open) return null;
  return (
    <aside
      aria-label="Panel del proyecto"
      className={cx(
        'z-30 flex flex-col border-line bg-panel',
        narrow ? 'absolute inset-x-0 bottom-0 max-h-[72%] min-h-[45%] animate-sheet-up rounded-t-xl border-t pb-[env(safe-area-inset-bottom,0px)] shadow-pop' : 'w-[calc(348px+env(safe-area-inset-right,0px))] shrink-0 border-l pr-[env(safe-area-inset-right,0px)]',
      )}
    >
      <div className="flex items-center gap-1 border-b border-line px-2 pt-1.5" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={cx('rotulo -mb-px border-b-2 px-2.5 py-2 text-[13px]', tab === t.id ? 'border-accent !text-ink' : 'border-transparent hover:!text-ink-2')}
            onClick={() => store.setUi({ panelTab: t.id })}
          >
            {t.label}
          </button>
        ))}
        <span className="flex-1" />
        {narrow && (
          <button type="button" className="icon-btn h-8 w-8" onClick={() => store.setUi({ panelOpen: false })} aria-label="Cerrar panel">
            <X size={17} />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1" role="tabpanel">
        {tab === 'partidas' ? <PartidasTab /> : tab === 'laminas' ? <LaminasTab /> : <LecturaTab />}
      </div>
    </aside>
  );
}
