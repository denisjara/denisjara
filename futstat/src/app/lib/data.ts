/**
 * Capa de datos de la app: lectura de los JSON estáticos publicados por el pipeline
 * (contrato en src/types/data.ts) con caché en memoria y hooks React.
 *
 *   base = import.meta.env.BASE_URL + (import.meta.env.VITE_DATA_DIR ?? 'data')
 *   VITE_DATA_DIR=mock-data → usa public/mock-data (generado con `npm run data:mock`).
 *
 * Defensas (la web nunca debe romperse por datos malos ni por la red):
 *  - Parámetros de ruta validados ANTES de construir URLs (compId /^[a-z0-9-]{1,40}$/, ids numéricos
 *    /^[0-9]{1,15}$/). Si no cumplen → "no encontrado" sin hacer ninguna petición (evita path traversal
 *    tipo /m/..%2F..). Además fetchJson solo acepta rutas de una lista blanca de patrones.
 *  - Timeout de 15 s (AbortController) y un reintento con espera ante fallo de red, timeout o 5xx/429.
 *  - Se comprueba res.ok, que la respuesta no sea HTML (fallback SPA) y que el JSON se pueda parsear.
 *  - Forma mínima del JSON raíz (objeto con generatedAt) y normalización defensiva (lib/sanitize.ts).
 *  - Caché en memoria ACOTADA (LRU de 80 archivos): una sesión larga no crece sin límite.
 *  - Los errores se entregan como DataError con mensaje en español; nunca se cachean.
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
import { normalizeDataFile } from './sanitize';
import { decodePacked } from './packed';

/** Directorio de datos configurado ("data" en producción, "mock-data" en desarrollo de UI). */
export const DATA_DIR: string = (() => {
  const raw = (import.meta.env.VITE_DATA_DIR as string | undefined) || 'data';
  // Solo un nombre de carpeta simple: nunca "..", barras ni URLs.
  return /^[a-z0-9][a-z0-9_-]{0,40}$/i.test(raw) ? raw : 'data';
})();

function joinBase(base: string, dir: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}${dir}`;
}

/** URL base de los JSON (sin barra final). */
export const DATA_BASE: string = joinBase(import.meta.env.BASE_URL || './', DATA_DIR);

// ---------------------------------------------------------------------------
// Validación de parámetros y rutas
// ---------------------------------------------------------------------------
const COMP_ID_RE = /^[a-z0-9-]{1,40}$/;
const NUM_ID_RE = /^[0-9]{1,15}$/;

/** true si `id` es un id de competición válido ("laliga", "champions"...). */
export function isValidCompId(id: unknown): id is string {
  return typeof id === 'string' && COMP_ID_RE.test(id);
}
/** true si `id` es un id numérico de ESPN válido (partido, equipo, jugador). */
export function isValidNumericId(id: unknown): id is string {
  return typeof id === 'string' && NUM_ID_RE.test(id);
}

/** Lista blanca de archivos que la app puede pedir. */
const ALLOWED_PATH = /^(?:(?:meta|home|players|value|model)\.json|competitions\/[a-z0-9-]{1,40}\.json|(?:matches|teams)\/[0-9]{1,15}\.json)$/;
export function isAllowedDataPath(path: string): boolean {
  return ALLOWED_PATH.test(path);
}

/** URL relativa de un archivo de datos, p. ej. dataUrl('competitions/laliga.json'). */
export function dataUrl(path: string): string {
  return `${DATA_BASE}/${path.replace(/^\/+/, '')}`;
}

export type DataErrorKind = 'not-found' | 'network' | 'timeout' | 'http' | 'invalid';

export class DataError extends Error {
  readonly status: number | undefined;
  readonly url: string;
  readonly kind: DataErrorKind;
  /** true si el archivo no existe (o la ruta pedida no es válida) */
  readonly notFound: boolean;
  constructor(message: string, url: string, kind: DataErrorKind, status?: number) {
    super(message);
    this.name = 'DataError';
    this.url = url;
    this.status = status;
    this.kind = kind;
    this.notFound = kind === 'not-found';
  }
}

const notFoundError = (path: string) => new DataError('Datos no encontrados.', path, 'not-found', 404);

// ---------------------------------------------------------------------------
// Caché LRU acotada + peticiones en curso
// ---------------------------------------------------------------------------
export const CACHE_MAX_ENTRIES = 80;
const valueCache = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

function cacheGet(path: string): unknown {
  if (!valueCache.has(path)) return undefined;
  const v = valueCache.get(path);
  // "usado recientemente": se mueve al final
  valueCache.delete(path);
  valueCache.set(path, v);
  return v;
}

function cacheSet(path: string, value: unknown): void {
  valueCache.delete(path);
  valueCache.set(path, value);
  while (valueCache.size > CACHE_MAX_ENTRIES) {
    const oldest = valueCache.keys().next().value;
    if (oldest === undefined) break;
    valueCache.delete(oldest);
  }
}

/** Valor ya resuelto en caché (sin disparar red). Útil para estados iniciales síncronos. */
export function peekJson<T>(path: string): T | undefined {
  return cacheGet(path) as T | undefined;
}

/** Vacía la caché (todo o una ruta). */
export function invalidateJson(path?: string): void {
  if (path) {
    inflight.delete(path);
    valueCache.delete(path);
  } else {
    inflight.clear();
    valueCache.clear();
  }
}

/** Número de archivos en caché (diagnóstico). */
export function cacheSize(): number {
  return valueCache.size;
}

// ---------------------------------------------------------------------------
// Descarga
// ---------------------------------------------------------------------------
export const FETCH_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 900;
/** Tamaño máximo razonable de un JSON (caracteres). Muy por encima de los archivos reales. */
const MAX_JSON_CHARS = 40_000_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchOnce(url: string, revalidate: boolean): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
      credentials: 'same-origin',
      // al reintentar o recargar a mano se revalida con el servidor (por si la copia en caché del navegador está rota)
      cache: revalidate ? 'no-cache' : 'default',
    });
  } catch (e) {
    if (ctrl.signal.aborted) throw new DataError('La descarga de datos ha tardado demasiado.', url, 'timeout');
    throw new DataError('No se pudo conectar para descargar los datos. Comprueba tu conexión.', url, 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** Respuesta → JSON validado. Lanza DataError con mensaje amable. */
async function readJson(res: Response, url: string, path: string): Promise<unknown> {
  if (res.status === 404 || res.status === 410) throw new DataError('Datos no encontrados.', url, 'not-found', res.status);
  if (!res.ok) throw new DataError(`El servidor de datos respondió con un error (${res.status}).`, url, 'http', res.status);
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new DataError('La descarga de datos se interrumpió.', url, 'network', res.status);
  }
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  // Los servidores de desarrollo/preview devuelven index.html para rutas inexistentes: es un 404.
  if (ct.includes('html') || (!ct.includes('json') && text.trimStart().startsWith('<'))) {
    throw new DataError('Datos no encontrados.', url, 'not-found', 404);
  }
  if (text.length > MAX_JSON_CHARS) throw new DataError('Los datos recibidos son demasiado grandes.', url, 'invalid', res.status);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DataError('Los datos recibidos están dañados o incompletos. Se corregirán en la próxima actualización.', url, 'invalid', res.status);
  }
  try {
    return normalizeDataFile(path, parsed);
  } catch {
    throw new DataError('Los datos recibidos no tienen el formato esperado. Se corregirán en la próxima actualización.', url, 'invalid', res.status);
  }
}

// ---------------------------------------------------------------------------
// Datos incrustados (versión portátil de un solo archivo, `npm run build:standalone`)
// ---------------------------------------------------------------------------
/**
 * En la versión portátil todos los JSON van dentro del propio HTML, en <script id="futstat-data"
 * type="application/json">: { "format": "futstat-gz64-v1", "files": { "home.json": "<gzip en base64>", ... } }
 * (o, sin comprimir, { "home.json": {...}, ... }). Así el archivo se abre con doble clic (file://), sin servidor ni
 * red. Si el bloque existe NUNCA se hacen peticiones de datos: lo que no está incluido es «no encontrado». Cada archivo
 * se descomprime solo cuando se visita y pasa por la misma validación que los descargados.
 */
export const PACKED_FORMAT = 'futstat-gz64-v1';
interface EmbeddedBundle {
  packed: boolean;
  files: Record<string, unknown>;
}
let embedded: EmbeddedBundle | null | undefined;

export function embeddedData(): EmbeddedBundle | null {
  if (embedded !== undefined) return embedded;
  embedded = null;
  try {
    const el = typeof document !== 'undefined' ? document.getElementById('futstat-data') : null;
    const text = el?.textContent;
    if (text) {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const packed = obj.format === PACKED_FORMAT && !!obj.files && typeof obj.files === 'object' && !Array.isArray(obj.files);
        const files = Object.assign(Object.create(null) as Record<string, unknown>, packed ? (obj.files as object) : obj);
        embedded = { packed, files };
      }
    }
  } catch {
    embedded = null;
  }
  return embedded;
}

/** Solo para tests: olvida el bloque de datos leído del documento. */
export function resetEmbeddedDataForTests(): void {
  embedded = undefined;
}

function fetchEmbedded<T>(bundle: EmbeddedBundle, path: string): Promise<T> {
  if (!Object.prototype.hasOwnProperty.call(bundle.files, path)) return Promise.reject(notFoundError(path));
  const running = inflight.get(path);
  if (running) return running as Promise<T>;
  const p = (async () => {
    let raw = bundle.files[path];
    if (bundle.packed) {
      if (typeof raw !== 'string') throw new DataError('Los datos incluidos en el archivo están dañados.', path, 'invalid');
      try {
        raw = await decodePacked(raw);
      } catch (e) {
        const old = e instanceof Error && e.message.includes('DecompressionStream');
        throw new DataError(
          old
            ? 'Tu navegador es demasiado antiguo para abrir este archivo. Actualízalo (Safari 16.4+, Chrome o Edge recientes).'
            : 'Los datos incluidos en el archivo están dañados.',
          path,
          'invalid',
        );
      }
    }
    try {
      const value = normalizeDataFile(path, raw);
      cacheSet(path, value);
      return value as T;
    } catch {
      throw new DataError('Los datos incluidos en el archivo no tienen el formato esperado.', path, 'invalid');
    }
  })();
  inflight.set(path, p);
  const clear = () => {
    if (inflight.get(path) === p) inflight.delete(path);
  };
  p.then(clear, clear);
  return p;
}

const retryable = (e: unknown) =>
  e instanceof DataError && (e.kind === 'network' || e.kind === 'timeout' || (e.kind === 'http' && (e.status === 429 || (e.status ?? 0) >= 500)));

/**
 * Descarga, valida y normaliza un JSON de datos con caché en memoria (una sola petición en curso por ruta).
 * Lanza DataError (notFound=true si el archivo no existe o la ruta no es válida). Los errores no se cachean.
 */
export function fetchJson<T>(path: string, opts: { force?: boolean } = {}): Promise<T> {
  if (!isAllowedDataPath(path)) return Promise.reject(notFoundError(path));
  if (opts.force) invalidateJson(path);
  else {
    const cached = cacheGet(path);
    if (cached !== undefined) return Promise.resolve(cached as T);
  }
  const bundle = embeddedData();
  if (bundle) return fetchEmbedded<T>(bundle, path);
  const running = inflight.get(path);
  if (running) return running as Promise<T>;
  const url = dataUrl(path);
  const revalidate = !!opts.force;
  const p = (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAY_MS + Math.round(Math.random() * 400));
      try {
        const res = await fetchOnce(url, revalidate || attempt > 0);
        const value = await readJson(res, url, path);
        cacheSet(path, value);
        return value as T;
      } catch (e) {
        lastError = e;
        if (!retryable(e)) break;
      }
    }
    throw lastError instanceof DataError ? lastError : new DataError('No se pudieron cargar los datos.', url, 'network');
  })();
  inflight.set(path, p);
  const clear = () => {
    if (inflight.get(path) === p) inflight.delete(path);
  };
  p.then(clear, clear);
  return p;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  /** vuelve a descargar ignorando la caché */
  reload: () => void;
}

/** Ruta centinela para parámetros inválidos: produce "no encontrado" sin red. */
const INVALID_PATH = '#invalid';

/** Hook genérico: carga `path` (o nada si es null). Mantiene datos previos mientras recarga. */
export function useJson<T>(path: string | null): AsyncState<T> {
  const invalid = path !== null && !isAllowedDataPath(path);
  const [state, setState] = useState<{ path: string | null; data: T | undefined; error: Error | undefined; loading: boolean }>(() => {
    const data = path && !invalid ? peekJson<T>(path) : undefined;
    return { path, data, error: undefined, loading: !!path && !invalid && data === undefined };
  });
  const [nonce, setNonce] = useState(0);
  const forceRef = useRef(false);

  useEffect(() => {
    if (!path || invalid) {
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
      (data) => {
        if (alive) setState({ path, data, error: undefined, loading: false });
      },
      (error: unknown) => {
        if (alive) setState({ path, data: undefined, error: error instanceof Error ? error : new DataError('No se pudieron cargar los datos.', path, 'network'), loading: false });
      },
    );
    return () => {
      alive = false;
    };
  }, [path, invalid, nonce]);

  const reload = useCallback(() => {
    forceRef.current = true;
    setNonce((n) => n + 1);
  }, []);

  if (invalid) return { data: undefined, error: notFoundError(path ?? ''), loading: false, reload };
  // Si cambia la ruta, no devolvemos datos de la ruta anterior.
  const stale = state.path !== path;
  return {
    data: stale ? (path ? peekJson<T>(path) : undefined) : state.data,
    error: stale ? undefined : state.error,
    loading: stale ? !!path && peekJson<T>(path) === undefined : state.loading,
    reload,
  };
}

/** Ruta del archivo de una competición (null si no hay id; centinela inválido si no cumple el patrón). */
export function competitionPath(id: string | undefined): string | null {
  if (id === undefined) return null;
  return isValidCompId(id) ? `competitions/${id}.json` : INVALID_PATH;
}
function numericPath(dir: 'matches' | 'teams', id: string | undefined): string | null {
  if (id === undefined) return null;
  return isValidNumericId(id) ? `${dir}/${id}.json` : INVALID_PATH;
}

// ---------------------------------------------------------------------------
// Hooks por archivo
// ---------------------------------------------------------------------------
export const useMeta = () => useJson<MetaFile>('meta.json');
export const useHome = () => useJson<HomeFile>('home.json');
export const useCompetition = (id: string | undefined) => useJson<CompetitionFile>(competitionPath(id));
export const useMatch = (id: string | undefined) => useJson<MatchFile>(numericPath('matches', id));
export const useTeam = (id: string | undefined) => useJson<TeamFile>(numericPath('teams', id));
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
 * resultados parciales. Útil para el calendario y vistas agregadas. Ids inválidos se ignoran.
 */
export function useCompetitions(ids: string[], concurrency = 4): MultiState<CompetitionFile> {
  const key = ids.filter(isValidCompId).join(',');
  const [state, setState] = useState<MultiState<CompetitionFile>>(() => initialMulti(key ? key.split(',') : []));

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
            const errors = { ...s.errors, [id]: e instanceof Error ? e : new Error('Error') };
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
