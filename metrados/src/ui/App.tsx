/**
 * Metrado Lab — pantalla principal: barra superior, mesa de dibujo (visor) y panel del proyecto.
 */
import { Component, useEffect, useState, type ReactNode } from 'react';
import { openPlanFiles } from '../app/actions';
import { loadLastProject, startAutosave } from '../app/persist';
import { importProjectFile } from '../app/project-file';
import { registerFile } from '../app/plans';
import { store, useStore } from '../app/store';
import { Dialogs } from './Dialogs';
import { Toasts, useIsNarrow } from './kit';
import { MetradoTable } from './MetradoTable';
import { SidePanel } from './SidePanel';
import { TopBar } from './TopBar';
import { loadSample, Viewer } from './Viewer';

let started = false;

/** Arranque: el último proyecto guardado en este navegador o, la primera vez, el plano de ejemplo ya medido. */
async function boot(): Promise<void> {
  if (started) return;
  started = true;
  store.setUi({ busy: 'Abriendo…' });
  const last = await loadLastProject().catch(() => null);
  if (last && (last.sheets.length > 0 || last.partidas.length > 0)) store.loadProject(last, { busy: null });
  else await loadSample();
  startAutosave();
}

async function handleDroppedFiles(files: File[]): Promise<void> {
  const zip = files.find((f) => /\.zip$/i.test(f.name));
  if (zip) {
    store.setUi({ busy: 'Abriendo el proyecto…' });
    try {
      const { project, blobs } = await importProjectFile(zip);
      for (const f of project.files) {
        const blob = blobs.get(f.id);
        if (blob) registerFile(f, blob);
      }
      store.loadProject(project, { busy: null });
      store.toast(`Proyecto «${project.name}» abierto.`, 'ok');
    } catch (e) {
      store.setUi({ busy: null });
      store.toast(e instanceof Error ? e.message : 'No se pudo abrir el proyecto.', 'error');
    }
    return;
  }
  await openPlanFiles(files);
}

function useFileDrop(): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const dragOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const files = e.dataTransfer ? [...e.dataTransfer.files] : [];
      if (files.length) void handleDroppedFiles(files);
    };
    // Pegar una captura o una imagen copiada también abre un plano.
    const paste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const files = e.clipboardData ? [...e.clipboardData.files].filter((f) => f.type.startsWith('image/') || f.type === 'application/pdf') : [];
      if (files.length) {
        e.preventDefault();
        void openPlanFiles(files.map((f) => (f.name && f.name !== 'image.png' ? f : new File([f], `Imagen pegada.${f.type.split('/')[1] || 'png'}`, { type: f.type }))));
      }
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', dragOver);
    window.addEventListener('drop', drop);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', dragOver);
      window.removeEventListener('drop', drop);
      window.removeEventListener('paste', paste);
    };
  }, []);
  return over;
}

export function App() {
  const narrow = useIsNarrow(900);
  const dropping = useFileDrop();
  const tableOpen = useStore((s) => s.ui.tableOpen);
  useEffect(() => {
    void boot();
  }, []);
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="relative flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1" aria-hidden={tableOpen || undefined}>
          <Viewer />
        </main>
        <SidePanel narrow={narrow} />
        <MetradoTable />
      </div>
      <Dialogs />
      <Toasts />
      {dropping && (
        <div className="pointer-events-none fixed inset-0 z-[70] grid place-items-center bg-[rgb(var(--c-accent)/0.14)] p-6">
          <div className="float border-2 border-dashed !border-accent px-8 py-6 text-center">
            <p className="text-lg font-bold">Suelta el plano aquí</p>
            <p className="text-ink-2">PDF, DXF, imagen o una copia de proyecto (.zip)</p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Si algo falla al pintar la interfaz, se ofrece recargar en vez de dejar la pantalla en blanco. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="float max-w-md p-6 text-center" role="alert">
          <p className="text-lg font-bold">Algo ha fallado en la app</p>
          <p className="mt-1 text-ink-2">Tu proyecto se guarda solo en este navegador mientras trabajas. Recarga la página para continuar.</p>
          <p className="mt-2 break-words text-2xs text-ink-3">{this.state.error.message}</p>
          <button type="button" className="btn btn-primary mt-4" onClick={() => window.location.reload()}>
            Recargar
          </button>
        </div>
      </div>
    );
  }
}
