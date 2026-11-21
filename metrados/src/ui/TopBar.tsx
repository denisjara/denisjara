/**
 * Barra superior: nombre del proyecto, abrir planos, deshacer, hoja de metrados y menú general.
 */
import { useSyncExternalStore } from 'react';
import { CircleHelp, ClipboardCopy, FileArchive, FileSpreadsheet, FileText, FileUp, FolderOpen, Menu as MenuIcon, Monitor, Moon, PanelRightClose, PanelRightOpen, Redo2, Save, Sun, Table2, Undo2 } from 'lucide-react';
import { fileBaseName } from '../app/export';
import { getSaveState, subscribeSaveState } from '../app/persist';
import { exportProjectFile } from '../app/project-file';
import { saveFile } from '../app/save';
import { store, useStore, type ThemeChoice } from '../app/store';
import { openProjectFile } from './Dialogs';
import { cx, Menu, MenuItem } from './kit';
import { copyTable, exportCsv, exportExcel } from './MetradoTable';
import { openPlanDialog } from './Viewer';

async function saveProjectCopy(): Promise<void> {
  const project = store.get().project;
  store.setUi({ busy: 'Empaquetando el proyecto…' });
  try {
    const { blob, missing } = await exportProjectFile(project);
    store.setUi({ busy: null });
    const r = await saveFile(`${fileBaseName(project).replace(/^Metrados-/, 'Proyecto-')}.zip`, blob, 'application/zip');
    if (r === 'saved') store.toast(missing.length ? `Copia guardada sin estos planos (no están en este navegador): ${missing.join(', ')}` : 'Copia del proyecto guardada, con sus planos.', missing.length ? 'error' : 'ok');
    else if (r === 'failed') store.toast('No se pudo guardar la copia.', 'error');
  } catch (e) {
    store.setUi({ busy: null });
    store.toast(e instanceof Error ? e.message : 'No se pudo guardar la copia.', 'error');
  }
}

const THEMES: { id: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { id: 'system', label: 'Tema del sistema', icon: Monitor },
  { id: 'light', label: 'Tema claro', icon: Sun },
  { id: 'dark', label: 'Tema oscuro', icon: Moon },
];

function SaveBadge() {
  const state = useSyncExternalStore(subscribeSaveState, getSaveState);
  const sample = useStore((s) => s.project.sample === true);
  if (sample) return <span className="shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-2xs font-bold text-accent-text">EJEMPLO</span>;
  const text = state === 'saving' ? 'Guardando…' : state === 'saved' ? 'Guardado' : state === 'error' ? 'Sin guardar' : state === 'unavailable' ? 'Sin guardado local' : '';
  if (!text) return null;
  return (
    <span className={cx('shrink-0 text-2xs max-sm:hidden', state === 'error' || state === 'unavailable' ? 'font-semibold text-warn' : 'text-ink-3')} title={state === 'unavailable' ? 'Este navegador no deja guardar aquí: usa «Guardar copia del proyecto» para no perder el trabajo.' : 'Se guarda solo en este navegador'}>
      {text}
    </span>
  );
}

export function TopBar() {
  const name = useStore((s) => s.project.name);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const tableOpen = useStore((s) => s.ui.tableOpen);
  const panelOpen = useStore((s) => s.ui.panelOpen);
  const theme = useStore((s) => s.ui.theme);
  const hasPartidas = useStore((s) => s.project.partidas.length > 0);
  return (
    <header className="z-40 flex h-12 shrink-0 items-center gap-1.5 border-b border-line bg-panel pl-[max(1rem,env(safe-area-inset-left,0px))] pr-[max(1rem,env(safe-area-inset-right,0px))] print:hidden">
      <div className="flex shrink-0 items-center gap-2" aria-label="Metrado Lab">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-accent text-accent-ink" aria-hidden>
          <svg width="17" height="17" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 25V7h4.5l5.5 10 5.5-10H26v18" />
          </svg>
        </span>
        <span className="font-cond text-[17px] font-bold uppercase tracking-wide max-lg:hidden">Metrado Lab</span>
      </div>
      <span className="mx-1 h-5 w-px bg-line max-lg:hidden" aria-hidden />
      <input
        className="min-w-0 max-w-[18rem] flex-1 truncate rounded-md border border-transparent bg-transparent px-2 py-1 font-semibold hover:border-line focus:border-line-strong focus:bg-panel"
        aria-label="Nombre del proyecto"
        value={name}
        onChange={(e) => store.update((p) => ({ ...p, name: e.target.value }), { coalesce: 'project-name' })}
        onBlur={() => !name.trim() && store.update((p) => ({ ...p, name: 'Proyecto sin título' }))}
      />
      <SaveBadge />
      <span className="flex-1" />
      <button type="button" className="btn btn-primary h-8 min-h-0 shrink-0" onClick={() => void openPlanDialog()}>
        <FileUp size={16} /> <span className="max-md:hidden">Abrir plano</span>
      </button>
      <button type="button" className="icon-btn shrink-0 max-sm:hidden" disabled={!canUndo} onClick={() => store.undo()} title="Deshacer (Ctrl+Z)" aria-label="Deshacer">
        <Undo2 size={18} />
      </button>
      <button type="button" className="icon-btn shrink-0 max-sm:hidden" disabled={!canRedo} onClick={() => store.redo()} title="Rehacer (Ctrl+Y)" aria-label="Rehacer">
        <Redo2 size={18} />
      </button>
      <button type="button" className={cx('btn h-8 min-h-0 shrink-0', tableOpen && '!border-accent !bg-accent-soft !text-accent-text')} aria-pressed={tableOpen} onClick={() => store.setUi({ tableOpen: !tableOpen })}>
        <Table2 size={16} /> <span className="max-md:hidden">Hoja de metrados</span>
      </button>
      <Menu label="Menú" className="icon-btn shrink-0" content={<MenuIcon size={19} />}>
        {(close) => (
          <>
            <MenuItem icon={<FolderOpen size={16} />} onClick={() => (close(), store.setUi({ dialog: { type: 'projects' } }))}>
              Proyectos…
            </MenuItem>
            <MenuItem icon={<Save size={16} />} onClick={() => (close(), void saveProjectCopy())}>
              Guardar copia del proyecto (.zip)
            </MenuItem>
            <MenuItem icon={<FileArchive size={16} />} onClick={() => (close(), void openProjectFile())}>
              Abrir copia de proyecto (.zip)
            </MenuItem>
            <div className="my-1 h-px bg-line" />
            <MenuItem icon={<FileSpreadsheet size={16} />} disabled={!hasPartidas} onClick={() => (close(), void exportExcel())}>
              Exportar a Excel (.xlsx)
            </MenuItem>
            <MenuItem icon={<FileText size={16} />} disabled={!hasPartidas} onClick={() => (close(), void exportCsv())}>
              Exportar a CSV
            </MenuItem>
            <MenuItem icon={<ClipboardCopy size={16} />} disabled={!hasPartidas} onClick={() => (close(), void copyTable())}>
              Copiar la hoja para pegar en Excel
            </MenuItem>
            <div className="my-1 h-px bg-line" />
            <MenuItem icon={<Undo2 size={16} />} disabled={!canUndo} hint="Ctrl+Z" onClick={() => store.undo()}>
              Deshacer
            </MenuItem>
            <MenuItem icon={<Redo2 size={16} />} disabled={!canRedo} hint="Ctrl+Y" onClick={() => store.redo()}>
              Rehacer
            </MenuItem>
            <div className="my-1 h-px bg-line" />
            {THEMES.map((t) => (
              <MenuItem key={t.id} icon={<t.icon size={16} />} hint={theme === t.id ? '✓' : undefined} onClick={() => store.setTheme(t.id)}>
                {t.label}
              </MenuItem>
            ))}
            <div className="my-1 h-px bg-line" />
            <MenuItem icon={<CircleHelp size={16} />} onClick={() => (close(), store.setUi({ dialog: { type: 'help' } }))}>
              Cómo se usa y qué tan exacta es
            </MenuItem>
          </>
        )}
      </Menu>
      <button type="button" className="icon-btn shrink-0" aria-pressed={false} onClick={() => store.setUi({ panelOpen: !panelOpen })} title={panelOpen ? 'Ocultar el panel' : 'Mostrar el panel'} aria-label={panelOpen ? 'Ocultar el panel' : 'Mostrar el panel'}>
        {panelOpen ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}
      </button>
    </header>
  );
}
