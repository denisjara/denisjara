/**
 * Controles que flotan sobre el plano: herramientas, opciones de la medición en curso y zoom.
 */
import type { ReactNode } from 'react';
import { Check, ChevronDown, CircleMinus, DraftingCompass, ListPlus, Magnet, MapPin, Maximize, Minus, MousePointer2, PaintBucket, Pentagon, Pipette, Plus, RectangleHorizontal, Ruler, Tag, TriangleAlert, Undo2, Waypoints, X } from 'lucide-react';
import { selectPartida, setActiveScale, setTool, TOOL_BASES, TOOL_LABEL } from '../app/actions';
import { store, useStore, type ToolId } from '../app/store';
import { formulaText } from '../core/metrado';
import type { ScaleDef, Sheet } from '../core/model';
import { ratioFromMPerUnit } from '../core/units';
import type { SnapModes } from '../core/vector';
import { viewer } from '../viewer/controller';
import { cx, fmt, Menu, MenuItem, Swatch, useViewerStatus } from './kit';

const TOOLS: { id: ToolId; icon: ReactNode; key: string; group: number }[] = [
  { id: 'select', icon: <MousePointer2 size={19} />, key: 'V', group: 0 },
  { id: 'line', icon: <Waypoints size={19} />, key: 'L', group: 1 },
  { id: 'area', icon: <Pentagon size={19} />, key: 'A', group: 1 },
  { id: 'rect', icon: <RectangleHorizontal size={19} />, key: 'R', group: 1 },
  { id: 'count', icon: <MapPin size={19} />, key: 'C', group: 1 },
  { id: 'pick', icon: <Pipette size={19} />, key: 'T', group: 2 },
  { id: 'region', icon: <PaintBucket size={19} />, key: 'B', group: 2 },
  { id: 'ruler', icon: <Ruler size={19} />, key: 'M', group: 3 },
  { id: 'calibrate', icon: <DraftingCompass size={19} />, key: 'K', group: 3 },
];

export function ToolRail() {
  const tool = useStore((s) => s.ui.tool);
  return (
    <nav
      aria-label="Herramientas"
      className="float absolute z-10 flex gap-0.5 p-1 max-md:inset-x-[max(1rem,env(safe-area-inset-left,0px))] max-md:bottom-[calc(0.75rem+env(safe-area-inset-bottom,0px))] max-md:justify-between max-md:overflow-x-auto md:left-[max(1rem,env(safe-area-inset-left,0px))] md:top-1/2 md:-translate-y-1/2 md:flex-col"
    >
      {TOOLS.map((t, i) => (
        <div key={t.id} className="flex md:flex-col">
          {i > 0 && TOOLS[i - 1].group !== t.group && <span className="mx-1 my-1.5 w-px shrink-0 bg-line md:mx-1.5 md:my-1 md:h-px md:w-auto" aria-hidden />}
          <button type="button" className="icon-btn h-10 w-10 shrink-0" aria-pressed={tool === t.id} title={`${TOOL_LABEL[t.id]} (${t.key})`} aria-label={TOOL_LABEL[t.id]} onClick={() => setTool(t.id)}>
            {t.icon}
          </button>
        </div>
      ))}
    </nav>
  );
}

export function scaleText(scale: ScaleDef | null | undefined, sheet: Sheet): string {
  if (!scale) return 'Sin escala';
  if (sheet.kind === 'pdf') return `1:${fmt(ratioFromMPerUnit(scale.mPerUnit), Number.isInteger(Math.round(ratioFromMPerUnit(scale.mPerUnit) * 100) / 100) ? 0 : 2)}`;
  if (scale.source === 'units' && scale.unit) return `1 u = 1 ${scale.unit}`;
  return sheet.kind === 'image' ? `1 px = ${fmt(scale.mPerUnit * 1000, 2)} mm` : `1 u = ${fmt(scale.mPerUnit, 4)} m`;
}

const SNAP_NAMES: [keyof SnapModes, string][] = [
  ['endpoint', 'Extremos y esquinas'],
  ['intersection', 'Intersecciones'],
  ['midpoint', 'Puntos medios'],
  ['perpendicular', 'Perpendicular'],
  ['nearest', 'Sobre la línea'],
];

export function OptionsBar() {
  const tool = useStore((s) => s.ui.tool);
  const partidas = useStore((s) => s.project.partidas);
  const activeId = useStore((s) => s.ui.activePartidaId);
  const deduct = useStore((s) => s.ui.deduct);
  const snapOn = useStore((s) => s.ui.snapOn);
  const snaps = useStore((s) => s.ui.snaps);
  const regionGap = useStore((s) => s.ui.regionGap);
  const showLabels = useStore((s) => s.project.settings.showLabels);
  const sheet = useStore((s) => s.project.sheets.find((x) => x.id === s.ui.sheetId) ?? null);
  const status = useViewerStatus();
  if (!sheet) return null;
  const active = partidas.find((p) => p.id === activeId) ?? null;
  const bases = TOOL_BASES[tool];
  const scale = sheet.scales.find((s) => s.id === sheet.activeScaleId) ?? null;
  const measuring = !!bases;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex flex-col items-center gap-2 px-[max(1rem,env(safe-area-inset-left,0px))]">
      <div className="float pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1.5 p-1.5">
        <Menu
          label="Partida activa"
          align="left"
          className="chip h-9 max-w-[15rem] shrink-0 rounded-md"
          content={
            <>
              {active ? <Swatch color={active.color} /> : <Plus size={14} />}
              <span className="truncate">{active ? active.name : 'Elegir partida'}</span>
              <ChevronDown size={14} className="shrink-0 text-ink-3" />
            </>
          }
        >
          {(close) => (
            <div className="w-72 max-w-[80vw]">
              {partidas.length === 0 && <p className="px-2.5 py-2 text-ink-3">Aún no hay partidas.</p>}
              {partidas.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="menuitem"
                  className={cx('flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-panel-3', p.id === activeId && 'bg-accent-soft')}
                  onClick={() => {
                    selectPartida(p.id, true);
                    close();
                  }}
                >
                  <Swatch color={p.color} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{p.name}</span>
                    <span className="block truncate text-2xs text-ink-3">
                      {formulaText(p)} · {p.unit}
                    </span>
                  </span>
                  {p.id === activeId && <Check size={15} className="text-accent-text" />}
                </button>
              ))}
              <div className="my-1 h-px bg-line" />
              <MenuItem
                icon={<Plus size={16} />}
                onClick={() => {
                  close();
                  store.setUi({ dialog: { type: 'partida' } });
                }}
              >
                Nueva partida…
              </MenuItem>
              <MenuItem
                icon={<ListPlus size={16} />}
                onClick={() => {
                  close();
                  store.setUi({ dialog: { type: 'catalog' } });
                }}
              >
                Añadir del catálogo…
              </MenuItem>
            </div>
          )}
        </Menu>

        {measuring && (
          <button type="button" className={cx('chip h-9 shrink-0 rounded-md', deduct && '!border-danger/60 !bg-danger-soft !text-danger')} aria-pressed={deduct} title="La próxima medición resta: vanos, ductos… (D)" onClick={() => store.setUi({ deduct: !deduct })}>
            <CircleMinus size={15} />
            <span className="max-sm:hidden">Descuento</span>
          </button>
        )}

        {tool === 'region' && (
          <Menu
            label="Cerrar los vanos de puerta al detectar el recinto"
            className="chip h-9 shrink-0 rounded-md"
            content={
              <>
                {regionGap > 0 ? `Cierra vanos ≤ ${fmt(regionGap, 2)} m` : 'Sin cerrar vanos'}
                <ChevronDown size={14} className="text-ink-3" />
              </>
            }
          >
            {(close) => (
              <div className="w-64">
                <p className="px-2.5 py-1.5 text-2xs text-ink-3">Une las caras de muro alineadas que una puerta interrumpe. Oculta antes las capas de puertas y mobiliario para que no recorten el ambiente.</p>
                {[0, 0.8, 1.0, 1.2, 1.5, 2.0, 3.0].map((g) => (
                  <MenuItem
                    key={g}
                    icon={regionGap === g ? <Check size={15} /> : undefined}
                    onClick={() => {
                      store.setUi({ regionGap: g });
                      close();
                    }}
                  >
                    {g === 0 ? 'No cerrar (solo lo dibujado)' : `Vanos de hasta ${fmt(g, 2)} m`}
                  </MenuItem>
                ))}
              </div>
            )}
          </Menu>
        )}

        <span className="mx-0.5 h-6 w-px shrink-0 bg-line" aria-hidden />

        {sheet.scales.length > 1 ? (
          <Menu
            label="Escala de la lámina"
            className={cx('chip h-9 shrink-0 rounded-md num', !scale && '!border-warn/60 !bg-warn-soft !text-warn')}
            content={
              <>
                {!scale && <TriangleAlert size={14} />}
                {scaleText(scale, sheet)}
                <ChevronDown size={14} className="text-ink-3" />
              </>
            }
          >
            {(close) => (
              <>
                {sheet.scales.map((sc) => (
                  <MenuItem
                    key={sc.id}
                    icon={sc.id === sheet.activeScaleId ? <Check size={15} /> : undefined}
                    hint={scaleText(sc, sheet)}
                    onClick={() => {
                      setActiveScale(sheet.id, sc.id);
                      close();
                    }}
                  >
                    {sc.name}
                  </MenuItem>
                ))}
                <div className="my-1 h-px bg-line" />
                <MenuItem
                  icon={<DraftingCompass size={16} />}
                  onClick={() => {
                    close();
                    store.setUi({ dialog: { type: 'scale', sheetId: sheet.id } });
                  }}
                >
                  Escalas de la lámina…
                </MenuItem>
              </>
            )}
          </Menu>
        ) : (
          <button
            type="button"
            className={cx('chip h-9 shrink-0 rounded-md num', !scale && '!border-warn/60 !bg-warn-soft !text-warn')}
            title="Escala de la lámina"
            onClick={() => store.setUi({ dialog: { type: 'scale', sheetId: sheet.id, scaleId: scale?.id } })}
          >
            {!scale && <TriangleAlert size={14} />}
            {scaleText(scale, sheet)}
          </button>
        )}

        {status.hasVector && (
          <Menu label="Enganche al plano" className="icon-btn h-9 w-9 shrink-0" content={<Magnet size={17} className={snapOn ? 'text-accent-text' : 'opacity-50'} />}>
            {() => (
              <>
                <MenuItem icon={snapOn ? <Check size={15} /> : undefined} hint="S" onClick={() => store.setUi({ snapOn: !snapOn })}>
                  Enganchar al plano
                </MenuItem>
                <div className="my-1 h-px bg-line" />
                {SNAP_NAMES.map(([key, label]) => (
                  <MenuItem key={key} disabled={!snapOn} icon={snaps[key] ? <Check size={15} /> : undefined} onClick={() => store.setUi({ snaps: { ...snaps, [key]: !snaps[key] } })}>
                    {label}
                  </MenuItem>
                ))}
              </>
            )}
          </Menu>
        )}
        <button
          type="button"
          className="icon-btn h-9 w-9 shrink-0"
          title={showLabels ? 'Ocultar las medidas sobre el plano' : 'Mostrar las medidas sobre el plano'}
          aria-pressed={false}
          onClick={() => store.update((p) => ({ ...p, settings: { ...p.settings, showLabels: !p.settings.showLabels } }), { undo: false })}
        >
          <Tag size={17} className={showLabels ? 'text-accent-text' : 'opacity-50'} />
        </button>
      </div>

      {!status.loading && status.raster && tool !== 'select' && (
        <p className="float pointer-events-auto max-w-xl px-3 py-1.5 text-2xs text-ink-2">
          Esta lámina es una imagen (escaneo o foto): no tiene líneas a las que engancharse. La precisión depende del escaneo; calibra con una cota conocida y marca los puntos con mucho zoom.
        </p>
      )}
    </div>
  );
}

/** Acciones del trazo en curso. Va abajo, lejos de donde se dibuja; con teclado bastan Intro, Retroceso y Esc. */
export function DraftBar() {
  const status = useViewerStatus();
  if (!status.drafting) return null;
  return (
    <div className="float absolute bottom-[calc(4.75rem+env(safe-area-inset-bottom,0px))] left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 p-1 md:bottom-9">
      {status.canFinish && (
        <button type="button" className="btn btn-primary h-9 min-h-0" onClick={() => viewer.current?.finishDraft()}>
          <Check size={16} /> Terminar
        </button>
      )}
      <button type="button" className="btn btn-ghost h-9 min-h-0" onClick={() => viewer.current?.undoDraftPoint()}>
        <Undo2 size={16} /> <span className="max-sm:hidden">Quitar punto</span>
      </button>
      <button type="button" className="btn btn-ghost h-9 min-h-0" onClick={() => viewer.current?.cancelDraft()}>
        <X size={16} /> <span className="max-sm:hidden">Cancelar</span>
      </button>
    </div>
  );
}

export function ZoomBar() {
  const status = useViewerStatus();
  const sheet = useStore((s) => s.project.sheets.find((x) => x.id === s.ui.sheetId) ?? null);
  if (!sheet) return null;
  // Porcentaje respecto del tamaño real del papel (PDF) o de "encajar en pantalla" en el resto.
  const pct = sheet.kind === 'pdf' ? status.zoom * (72 / 96) * 100 : null;
  return (
    <div className="float absolute bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] right-[max(1rem,env(safe-area-inset-right,0px))] z-10 flex items-center p-1 md:bottom-3">
      <button type="button" className="icon-btn h-9 w-9" title="Alejar (−)" aria-label="Alejar" onClick={() => viewer.current?.zoomBy(1 / 1.5)}>
        <Minus size={17} />
      </button>
      {pct !== null && <span className="num w-14 text-center text-2xs font-semibold text-ink-2 max-sm:hidden">{pct >= 1000 ? `${fmt(pct / 100, 0)}×` : `${fmt(pct, 0)} %`}</span>}
      <button type="button" className="icon-btn h-9 w-9" title="Acercar (+)" aria-label="Acercar" onClick={() => viewer.current?.zoomBy(1.5)}>
        <Plus size={17} />
      </button>
      <button type="button" className="icon-btn h-9 w-9" title="Ver toda la lámina (F)" aria-label="Ver toda la lámina" onClick={() => viewer.current?.fit()}>
        <Maximize size={17} />
      </button>
    </div>
  );
}
