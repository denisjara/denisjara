/**
 * Zona de trabajo: el plano con sus mediciones y los controles que flotan encima.
 */
import { useEffect, useRef } from 'react';
import { FileUp, Play, TriangleAlert } from 'lucide-react';
import { openPlanFiles } from '../app/actions';
import { buildSampleProject } from '../app/sample-project';
import { store, useStore } from '../app/store';
import { viewer, ViewerController } from '../viewer/controller';
import { PLAN_ACCEPT, pickFiles } from './files';
import { Spinner, useViewerStatus } from './kit';
import { DraftBar, OptionsBar, ToolRail, ZoomBar } from './Toolbars';

export async function openPlanDialog(): Promise<void> {
  const files = await pickFiles(PLAN_ACCEPT, true);
  if (files.length) await openPlanFiles(files);
}

export async function loadSample(): Promise<void> {
  store.setUi({ busy: 'Preparando el plano de ejemplo…' });
  try {
    store.loadProject(await buildSampleProject(), { busy: null, panelTab: 'partidas' });
  } catch (e) {
    store.setUi({ busy: null });
    store.toast(e instanceof Error ? e.message : 'No se pudo preparar el ejemplo.', 'error');
  }
}

function EmptyState() {
  return (
    <div className="absolute inset-0 grid place-items-center overflow-y-auto p-4">
      <div className="float w-full max-w-md p-6 text-center">
        <p className="rotulo">Mesa de dibujo vacía</p>
        <h2 className="mt-1 text-xl font-bold">Abre un plano para empezar a metrar</h2>
        <p className="mt-2 text-ink-2">PDF de AutoCAD o Revit, DXF, o una imagen escaneada. El archivo no sale de tu equipo: se lee aquí, en el navegador.</p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button type="button" className="btn btn-primary" onClick={() => void openPlanDialog()}>
            <FileUp size={16} /> Abrir plano
          </button>
          <button type="button" className="btn" onClick={() => void loadSample()}>
            <Play size={16} /> Ver el plano de ejemplo
          </button>
        </div>
        <p className="mt-4 text-2xs text-ink-3">También puedes arrastrar el archivo y soltarlo aquí.</p>
      </div>
    </div>
  );
}

export function Viewer() {
  const hostRef = useRef<HTMLDivElement>(null);
  const planRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const status = useViewerStatus();
  const sheet = useStore((s) => s.project.sheets.find((x) => x.id === s.ui.sheetId) ?? null);
  const busy = useStore((s) => s.ui.busy);

  useEffect(() => {
    const c = new ViewerController(hostRef.current!, planRef.current!, overRef.current!);
    viewer.current = c;
    return () => {
      c.destroy();
      viewer.current = null;
    };
  }, []);

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div ref={hostRef} className="absolute inset-0 touch-none select-none">
        <canvas ref={planRef} className="absolute inset-0 h-full w-full" />
        <canvas ref={overRef} className="absolute inset-0 h-full w-full" aria-label={sheet ? `Plano: ${sheet.name}` : 'Plano'} />
      </div>
      {!sheet && !busy && <EmptyState />}
      {sheet && (
        <>
          <OptionsBar />
          <ToolRail />
          <ZoomBar />
          <DraftBar />
          {status.hint && (
            <p className="pointer-events-none absolute bottom-3 left-[max(1rem,env(safe-area-inset-left,0px))] right-44 hidden truncate text-2xs text-ink-3 md:block" aria-live="off">
              {status.hint}
            </p>
          )}
        </>
      )}
      {(status.loading || busy) && (
        <div className="pointer-events-none absolute inset-x-0 top-20 flex justify-center px-4">
          <div className="float flex items-center gap-2.5 px-3.5 py-2 font-semibold" role="status">
            <Spinner className="text-accent" />
            {busy ?? 'Leyendo la geometría del plano…'}
          </div>
        </div>
      )}
      {status.error && sheet && (
        <div className="absolute inset-0 grid place-items-center p-4">
          <div className="float max-w-md p-5 text-center" role="alert">
            <TriangleAlert className="mx-auto text-warn" size={28} />
            <p className="mt-2 font-bold">No se pudo mostrar esta lámina</p>
            <p className="mt-1 text-ink-2">{status.error}</p>
            <p className="mt-3 text-2xs text-ink-3">Si el archivo ya no está en este navegador, vuelve a cargarlo desde la pestaña Láminas.</p>
          </div>
        </div>
      )}
    </div>
  );
}
