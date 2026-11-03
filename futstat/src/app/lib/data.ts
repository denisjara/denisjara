/**
 * Capa de datos de la app: lectura de los JSON estáticos publicados por el pipeline
 * (contrato en src/types/data.ts) con caché en memoria y hooks React.
 *
 *   base = import.meta.env.BASE_URL + (import.meta.env.VITE_DATA_DIR ?? 'data')
 *   VITE_DATA_DIR=mock-data → usa public/mock-data (generado con `npm run data:mock`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CompetitionFile,
  CompetitionMeta,
  HomeFile,
  MatchFile,
  MetaFile,
  ModelFile,
  PlayersFile,
  TeamFile,
  ValueFile,
} from '../../types/data';

/** Directorio de datos configurado ("data" en producción, "mock-data" en desarrollo de UI). */
export const DATA_DIR: string = (import.meta.env.VITE_DATA_DIR as string | undefined) || 'data';

function joinBase(base: string, dir: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}${dir.replace(/^\/+|\/+$/g, '')}`;
}

/** URL base de los JSON (sin barra final). */
export const DATA_BASE: string = joinBase(import.meta.env.BASE_URL || './', DATA_DIR);

/** URL absoluta/relativa de un archivo de datos, p. ej. dataUrl('competitions/laliga.json'). */
export function dataUrl(path: string): string {
  return `${DATA_BASE}/${path.replace(/^\/+/, '')}`;
}

export class DataError extends Error {
  readonly status: number | undefined;
  readonly url: string;
  readonly notFound: boolean;
  constructor(message: string, url: string, status?: number) {
    super(message);
    this.name = 'DataError';
    this.url = url;
    this.status = status;
    this.notFound = status === 404;
  }
}

const promiseCache = new Map<string, Promise<unknown>>();
const valueCache = new Map<string, unknown>();

/** Valor ya resuelto en caché (sin disparar red). Útil para estados iniciales síncronos. */
export function peekJson<T>(path: string): T | undefined {
  return valueCache.get(path) as T | undefined;
}

/** Vacía la caché (todo o una ruta). */
export function invalidateJson(path?: string): void {
  if (path) {
    promiseCache.delete(path);
    valueCache.delete(path);
  } else {
    promiseCache.clear();
    valueCache.clear();
  }
}

/**
 * Descarga y parsea un JSON de datos con caché en memoria (una sola petición por ruta).
 * Lanza DataError (notFound=true si el archivo no existe). Los errores no se cachean.
 */
export function fetchJson<T>(path: string, opts: { force?: boolean } = {}): Promise<T> {
  if (opts.force) invalidateJson(path);
  const cached = promiseCache.get(path);
  if (cached) return cached as Promise<T>;
  const url = dataUrl(path);
  const p = (async () => {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch {
      throw new DataError('No se pudo conectar para descargar los datos.', url);
    }
    if (res.status === 404) throw new DataError('Datos no encontrados.', url, 404);
    if (!res.ok) throw new DataError(`Error ${res.status} al descargar los datos.`, url, res.status);
    const text = await res.text();
    // El servidor de desarrollo devuelve index.html para rutas inexistentes: trátalo como 404.
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json') && text.trimStart().startsWith('<')) {
      throw new DataError('Datos no encontrados.', url, 404);
    }
    try {
      const value = JSON.parse(text) as T;
      valueCache.set(path, value);
      return value;
    } catch {
      throw new DataError('Los datos recibidos no son válidos.', url, res.status);
    }
  })();
  promiseCache.set(path, p);
  p.catch(() => {
    if (promiseCache.get(path) === p) promiseCache.delete(path);
  });
  return p;
}

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  /** vuelve a descargar ignorando la caché */
  reload: () => void;
}

/** Hook genérico: carga `path` (o nada si es null). Mantiene datos previos mientras recarga. */
export function useJson<T>(path: string | null): AsyncState<T> {
  const [state, setState] = useState<{ path: string | null; data: T | undefined; error: Error | undefined; loading: boolean }>(() => {
    const data = path ? peekJson<T>(path) : undefined;
    return { path, data, error: undefined, loading: !!path && data === undefined };
  });
  const [nonce, setNonce] = useState(0);
  const forceRef = useRef(false);

  useEffect(() => {
    if (!path) {
      setState({ path, data: undefined, error: undefined, loading: false });
      return;
    }
    let alive = true;
    const force = forceRef.current;
    forceRef.current = false;
    const cachedValue = force ? undefined : peekJson<T>(path);
    if (cachedValue !== undefined) {
      setState({ path, data: cachedValue, error: undefined, loading: false });
      return;
    }
    setState((s) => ({ path, data: s.path === path ? s.data : undefined, error: undefined, loading: true }));
    fetchJson<T>(path, { force }).then(
      (data) => alive && setState({ path, data, error: undefined, loading: false }),
      (error: Error) => alive && setState({ path, data: undefined, error, loading: false }),
    );
    return () => {
      alive = false;
    };
  }, [path, nonce]);

  const reload = useCallback(() => {
    forceRef.current = true;
    setNonce((n) => n + 1);
  }, []);

  // Si cambia la ruta, no devolvemos datos de la ruta anterior.
  const stale = state.path !== path;
  return {
    data: stale ? (path ? peekJson<T>(path) : undefined) : state.data,
    error: stale ? undefined : state.error,
    loading: stale ? !!path && peekJson<T>(path) === undefined : state.loading,
    reload,
  };
}

// ---------------------------------------------------------------------------
// Hooks por archivo
// ---------------------------------------------------------------------------
export const useMeta = () => useJson<MetaFile>('meta.json');
export const useHome = () => useJson<HomeFile>('home.json');
export const useCompetition = (id: string | undefined) => useJson<CompetitionFile>(id ? `competitions/${id}.json` : null);
export const useMatch = (id: string | undefined) => useJson<MatchFile>(id ? `matches/${id}.json` : null);
export const useTeam = (id: string | undefined) => useJson<TeamFile>(id ? `teams/${id}.json` : null);
export const usePlayers = () => useJson<PlayersFile>('players.json');
export const useValue = () => useJson<ValueFile>('value.json');
export const useModel = () => useJson<ModelFile>('model.json');

/** CompetitionMeta por id desde meta.json (undefined mientras carga o si no existe). */
export function useCompetitionMeta(id: string | undefined): CompetitionMeta | undefined {
  const { data } = useMeta();
  return useMemo(() => data?.competitions.find((c) => c.id === id), [data, id]);
}

export interface MultiState<T> {
  /** archivos ya cargados, por id */
  data: Record<string, T>;
  /** ids que fallaron */
  errors: Record<string, Error>;
  /** true mientras quede alguno por cargar */
  loading: boolean;
  loaded: number;
  total: number;
}

/**
 * Carga varias competiciones en paralelo (concurrencia limitada) y va entregando
 * resultados parciales. Útil para el calendario y vistas agregadas.
 */
export function useCompetitions(ids: string[], concurrency = 4): MultiState<CompetitionFile> {
  const key = ids.join(',');
  const [state, setState] = useState<MultiState<CompetitionFile>>(() => initialMulti(ids));

  useEffect(() => {
    const list = key ? key.split(',') : [];
    let alive = true;
    setState(initialMulti(list));
    const queue = list.filter((id) => !peekJson(`competitions/${id}.json`));
    if (!queue.length) return;
    let cursor = 0;
    const worker = async () => {
      while (alive && cursor < queue.length) {
        const id = queue[cursor++];
        try {
          const file = await fetchJson<CompetitionFile>(`competitions/${id}.json`);
          if (!alive) return;
          setState((s) => {
            const data = { ...s.data, [id]: file };
            const loaded = Object.keys(data).length + Object.keys(s.errors).length;
            return { ...s, data, loaded, loading: loaded < s.total };
          });
        } catch (e) {
          if (!alive) return;
          setState((s) => {
            const errors = { ...s.errors, [id]: e as Error };
            const loaded = Object.keys(s.data).length + Object.keys(errors).length;
            return { ...s, errors, loaded, loading: loaded < s.total };
          });
        }
      }
    };
    for (let i = 0; i < Math.min(concurrency, queue.length); i++) void worker();
    return () => {
      alive = false;
    };
  }, [key, concurrency]);

  return state;
}

function initialMulti(ids: string[]): MultiState<CompetitionFile> {
  const data: Record<string, CompetitionFile> = {};
  for (const id of ids) {
    const v = peekJson<CompetitionFile>(`competitions/${id}.json`);
    if (v) data[id] = v;
  }
  const loaded = Object.keys(data).length;
  return { data, errors: {}, loading: loaded < ids.length, loaded, total: ids.length };
}
