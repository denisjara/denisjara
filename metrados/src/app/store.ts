/**
 * Estado de la app: el proyecto (con deshacer/rehacer) y el estado de la interfaz.
 *
 * El proyecto es inmutable: cada cambio crea un objeto nuevo y el anterior queda en el historial. La interfaz
 * (herramienta activa, selección, paneles…) no entra en el historial.
 */
import { useSyncExternalStore } from 'react';
import type { Pt } from '../core/geometry';
import { emptyProject, type Base, type Project } from '../core/model';
import { ALL_SNAPS, type SnapModes } from '../core/vector';

export type ToolId = 'select' | 'line' | 'area' | 'rect' | 'count' | 'ruler' | 'pick' | 'region' | 'calibrate';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'ok' | 'error';
  action?: { label: string; run: () => void };
}

export type Dialog =
  | { type: 'scale'; sheetId: string; calib?: { a: Pt; b: Pt }; scaleId?: string }
  | { type: 'partida'; partidaId?: string; base?: Base }
  | { type: 'catalog' }
  | { type: 'export' }
  | { type: 'projects' }
  | { type: 'help' }
  | { type: 'confirm'; title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void };

export type PanelTab = 'partidas' | 'laminas' | 'lectura';
export type ThemeChoice = 'system' | 'light' | 'dark';

export interface UiState {
  sheetId: string | null;
  tool: ToolId;
  activePartidaId: string | null;
  selection: string[];
  hoverId: string | null;
  /** La próxima medición será un descuento. */
  deduct: boolean;
  snapOn: boolean;
  snaps: SnapModes;
  panelTab: PanelTab;
  panelOpen: boolean;
  tableOpen: boolean;
  dialog: Dialog | null;
  toasts: Toast[];
  /** Texto de la operación larga en curso (abrir un plano, leer geometría…). */
  busy: string | null;
  theme: ThemeChoice;
}

export interface AppState {
  project: Project;
  ui: UiState;
  canUndo: boolean;
  canRedo: boolean;
}

const HISTORY_LIMIT = 200;
const COALESCE_MS = 1500;

function initialTheme(): ThemeChoice {
  try {
    const s = window.localStorage.getItem('metrado-theme');
    if (s === 'light' || s === 'dark') return s;
  } catch {
    /* almacenamiento no disponible */
  }
  return 'system';
}

export class Store {
  private state: AppState;
  private listeners = new Set<() => void>();
  private past: Project[] = [];
  private future: Project[] = [];
  private lastKey: string | null = null;
  private lastTime = 0;
  private toastId = 0;

  constructor() {
    this.state = {
      project: emptyProject(),
      canUndo: false,
      canRedo: false,
      ui: {
        sheetId: null,
        tool: 'select',
        activePartidaId: null,
        selection: [],
        hoverId: null,
        deduct: false,
        snapOn: true,
        snaps: { ...ALL_SNAPS },
        panelTab: 'partidas',
        panelOpen: typeof window === 'undefined' ? true : window.innerWidth >= 900,
        tableOpen: false,
        dialog: null,
        toasts: [],
        busy: null,
        theme: typeof window === 'undefined' ? 'system' : initialTheme(),
      },
    };
  }

  get = (): AppState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(next: AppState): void {
    this.state = next;
    for (const fn of this.listeners) fn();
  }

  setUi(patch: Partial<UiState> | ((ui: UiState) => Partial<UiState>)): void {
    const p = typeof patch === 'function' ? patch(this.state.ui) : patch;
    let changed = false;
    for (const k of Object.keys(p) as (keyof UiState)[]) {
      if (p[k] !== this.state.ui[k]) {
        changed = true;
        break;
      }
    }
    if (changed) this.emit({ ...this.state, ui: { ...this.state.ui, ...p } });
  }

  /**
   * Cambia el proyecto. `coalesce`: los cambios seguidos con la misma clave (teclear en un campo, arrastrar un
   * vértice) cuentan como un solo paso de deshacer. `undo: false`: el cambio no se puede deshacer (cargar láminas).
   */
  update(fn: (p: Project) => Project, opts: { undo?: boolean; coalesce?: string } = {}): void {
    const prev = this.state.project;
    const next = fn(prev);
    if (next === prev) return;
    // Cualquier cambio hace que deje de ser el proyecto de demostración intacto.
    const { sample: _sample, ...rest } = next;
    const stamped: Project = { ...rest, updatedAt: Date.now() };
    if (opts.undo !== false) {
      const now = Date.now();
      const merge = opts.coalesce !== undefined && opts.coalesce === this.lastKey && now - this.lastTime < COALESCE_MS && this.past.length > 0;
      if (!merge) {
        this.past.push(prev);
        if (this.past.length > HISTORY_LIMIT) this.past.shift();
      }
      this.lastKey = opts.coalesce ?? null;
      this.lastTime = now;
      this.future = [];
    }
    this.emit({ ...this.state, project: stamped, canUndo: this.past.length > 0, canRedo: this.future.length > 0 });
  }

  /** Corta la fusión de cambios: el siguiente `update` abre un paso nuevo de deshacer. */
  breakCoalesce(): void {
    this.lastKey = null;
  }

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.state.project);
    this.lastKey = null;
    this.emit({ ...this.state, project: prev, canUndo: this.past.length > 0, canRedo: true, ui: this.cleanUi(prev) });
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.state.project);
    this.lastKey = null;
    this.emit({ ...this.state, project: next, canUndo: true, canRedo: this.future.length > 0, ui: this.cleanUi(next) });
  }

  /** Sustituye el proyecto entero (abrir, nuevo) y vacía el historial. */
  loadProject(project: Project, ui: Partial<UiState> = {}): void {
    this.past = [];
    this.future = [];
    this.lastKey = null;
    const base: UiState = { ...this.state.ui, sheetId: project.sheets[0]?.id ?? null, activePartidaId: project.partidas[0]?.id ?? null, selection: [], hoverId: null, tool: 'select', deduct: false, dialog: null, ...ui };
    this.emit({ project, canUndo: false, canRedo: false, ui: base });
  }

  /** Tras deshacer/rehacer: la selección y la lámina activa pueden apuntar a algo que ya no existe. */
  private cleanUi(p: Project): UiState {
    const ui = this.state.ui;
    const ids = new Set(p.measurements.map((m) => m.id));
    const selection = ui.selection.filter((id) => ids.has(id));
    return {
      ...ui,
      selection: selection.length === ui.selection.length ? ui.selection : selection,
      hoverId: null,
      sheetId: p.sheets.some((s) => s.id === ui.sheetId) ? ui.sheetId : (p.sheets[0]?.id ?? null),
      activePartidaId: p.partidas.some((x) => x.id === ui.activePartidaId) ? ui.activePartidaId : (p.partidas[0]?.id ?? null),
    };
  }

  toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action'], ms = 4500): void {
    const id = ++this.toastId;
    this.setUi((ui) => ({ toasts: [...ui.toasts.slice(-2), { id, text, kind, action }] }));
    setTimeout(() => this.dismissToast(id), action ? Math.max(ms, 7000) : ms);
  }

  dismissToast(id: number): void {
    this.setUi((ui) => (ui.toasts.some((t) => t.id === id) ? { toasts: ui.toasts.filter((t) => t.id !== id) } : {}));
  }

  setTheme(theme: ThemeChoice): void {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      if (theme === 'system') window.localStorage.removeItem('metrado-theme');
      else window.localStorage.setItem('metrado-theme', theme);
    } catch {
      /* almacenamiento no disponible: el tema vale para esta sesión */
    }
    this.setUi({ theme });
  }
}

export const store = new Store();

/** Suscribe un componente a una parte del estado. El selector debe devolver una referencia estable o un primitivo. */
export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
