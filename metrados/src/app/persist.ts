/**
 * Guardado automático en el navegador (IndexedDB): el proyecto y los archivos de los planos.
 *
 * Es una comodidad, no una copia de seguridad: los datos viven solo en este navegador y pueden no estar
 * disponibles (modo privado, almacenamiento bloqueado o lleno). Todo acceso está protegido: si falla, la app sigue
 * funcionando en memoria y avisa de que conviene exportar el proyecto a un archivo.
 */
import { sanitizeProject, type Project } from '../core/model';
import { fileBlob, registerFile } from './plans';
import { store } from './store';

const DB_NAME = 'metrado-lab';
const LAST_KEY = 'metrado-last-project';

export interface ProjectInfo {
  id: string;
  name: string;
  updatedAt: number;
  sheets: number;
  measurements: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function run<T>(storeName: 'projects' | 'files', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      let result: T | undefined;
      req.onsuccess = () => (result = req.result);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('Error de almacenamiento'));
      tx.onabort = () => reject(tx.error ?? new Error('Almacenamiento lleno o no disponible'));
    } catch (e) {
      reject(e instanceof Error ? e : new Error('Error de almacenamiento'));
    }
  });
}

export async function storageAvailable(): Promise<boolean> {
  return (await openDb()) !== null;
}

export async function listProjects(): Promise<ProjectInfo[]> {
  try {
    const all = (await run<unknown[]>('projects', 'readonly', (s) => s.getAll())) ?? [];
    const out: ProjectInfo[] = [];
    for (const raw of all) {
      const p = sanitizeProject(raw);
      if (p) out.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, sheets: p.sheets.length, measurements: p.measurements.length });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

const storedFiles = new Set<string>();

async function saveProject(project: Project): Promise<void> {
  for (const f of project.files) {
    if (storedFiles.has(f.id)) continue;
    const blob = fileBlob(f.id);
    if (!blob) continue;
    await run('files', 'readwrite', (s) => s.put(blob, f.id));
    storedFiles.add(f.id);
  }
  await run('projects', 'readwrite', (s) => s.put(project));
  try {
    window.localStorage.setItem(LAST_KEY, project.id);
  } catch {
    /* sin almacenamiento local */
  }
}

/** Carga un proyecto guardado y registra sus planos en memoria. Devuelve null si no existe o no se puede leer. */
export async function loadProject(id: string): Promise<Project | null> {
  try {
    const project = sanitizeProject(await run<unknown>('projects', 'readonly', (s) => s.get(id)));
    if (!project) return null;
    for (const f of project.files) {
      const blob = await run<unknown>('files', 'readonly', (s) => s.get(f.id));
      if (blob instanceof Blob) {
        registerFile(f, blob);
        storedFiles.add(f.id);
      }
    }
    return project;
  } catch {
    return null;
  }
}

export async function loadLastProject(): Promise<Project | null> {
  let id: string | null = null;
  try {
    id = window.localStorage.getItem(LAST_KEY);
  } catch {
    /* sin almacenamiento local */
  }
  if (!id) id = (await listProjects())[0]?.id ?? null;
  return id ? loadProject(id) : null;
}

export async function deleteProject(id: string): Promise<void> {
  try {
    const project = sanitizeProject(await run<unknown>('projects', 'readonly', (s) => s.get(id)));
    for (const f of project?.files ?? []) {
      await run('files', 'readwrite', (s) => s.delete(f.id));
      storedFiles.delete(f.id);
    }
    await run('projects', 'readwrite', (s) => s.delete(id));
  } catch {
    /* no se pudo borrar: no hay nada más que hacer */
  }
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'unavailable';

let saveState: SaveState = 'idle';
const saveListeners = new Set<() => void>();

export const getSaveState = (): SaveState => saveState;
export const subscribeSaveState = (fn: () => void): (() => void) => {
  saveListeners.add(fn);
  return () => saveListeners.delete(fn);
};

function setSaveState(s: SaveState): void {
  if (s === saveState) return;
  saveState = s;
  for (const fn of saveListeners) fn();
}

/** Guarda el proyecto cada vez que cambia (con una pequeña espera). El proyecto de demostración intacto no se guarda. */
export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: Project | null = store.get().project;
  let warned = false;
  let running = false;
  let again = false;
  const flush = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    const project = store.get().project;
    if (project.sample || (project.sheets.length === 0 && project.partidas.length === 0)) return;
    running = true;
    setSaveState('saving');
    try {
      if (!(await storageAvailable())) {
        setSaveState('unavailable');
        return;
      }
      await saveProject(project);
      setSaveState('saved');
    } catch {
      setSaveState('error');
      if (!warned) {
        warned = true;
        store.toast('No se pudo guardar en el navegador (almacenamiento lleno o bloqueado). Exporta el proyecto a un archivo para no perderlo.', 'error', undefined, 10000);
      }
    } finally {
      running = false;
      if (again) {
        again = false;
        void flush();
      }
    }
  };
  const unsub = store.subscribe(() => {
    const project = store.get().project;
    if (project === last) return;
    last = project;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, 700);
  });
  const onHide = (): void => {
    if (document.visibilityState === 'hidden' && timer) {
      clearTimeout(timer);
      timer = null;
      void flush();
    }
  };
  document.addEventListener('visibilitychange', onHide);
  return () => {
    unsub();
    document.removeEventListener('visibilitychange', onHide);
    if (timer) clearTimeout(timer);
  };
}
