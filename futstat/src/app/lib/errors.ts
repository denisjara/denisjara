/**
 * Manejo global de errores: la UI nunca debe quedarse en blanco.
 *
 * - installGlobalErrorHandlers(): escucha 'error' y 'unhandledrejection' en window. Registra el fallo de
 *   forma compacta (sin repetirlo en bucle) y nunca lanza: un error fuera de React (un temporizador, un
 *   manejador de eventos, una promesa olvidada) no desmonta la app.
 * - Errores de carga de código (chunks de Vite que ya no existen tras un despliegue nuevo, o red caída):
 *   se detectan y se ofrece recargar la página. Como mucho una recarga automática por sesión cada 60 s,
 *   para no entrar en bucles.
 */

const RELOAD_KEY = 'futstat-chunk-reload-at';
const RELOAD_COOLDOWN_MS = 60_000;
const MAX_LOGGED = 30;

/** Últimos errores vistos (solo en memoria; útil para depurar desde la consola). */
const recent: { at: number; kind: string; message: string }[] = [];
const seen = new Set<string>();

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return String(err);
  } catch {
    return 'Error desconocido';
  }
}

/** true si el error es un fallo al cargar un módulo/chunk de la app (dynamic import, preload de Vite). */
export function isChunkLoadError(err: unknown): boolean {
  const msg = messageOf(err);
  const name = err instanceof Error ? err.name : '';
  return (
    name === 'ChunkLoadError' ||
    /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading chunk [\w-]+ failed|Loading CSS chunk/i.test(
      msg,
    )
  );
}

/** true si el error es una cancelación esperada (AbortController al desmontar o por timeout propio). */
export function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError';
}

/** Registra un error una sola vez por mensaje (evita inundar la consola en bucles de render). */
export function reportError(kind: string, err: unknown): void {
  try {
    const message = messageOf(err).slice(0, 300);
    const key = `${kind}:${message}`;
    recent.push({ at: Date.now(), kind, message });
    if (recent.length > MAX_LOGGED) recent.shift();
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 200) seen.clear();
    console.error(`[FutStat] ${kind}: ${message}`);
  } catch {
    /* el registro nunca debe fallar */
  }
}

/** Copia de los últimos errores registrados. */
export function recentErrors(): { at: number; kind: string; message: string }[] {
  return recent.slice();
}

/**
 * Recarga la página para obtener la versión nueva de la app, salvo que ya se haya recargado hace poco
 * (en ese caso devuelve false y la interfaz debe mostrar el error con un botón manual).
 */
export function reloadOnceForNewVersion(): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Number.isFinite(last) && Date.now() - last < RELOAD_COOLDOWN_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // sin sessionStorage no podemos evitar bucles: no recargamos automáticamente
    return false;
  }
  window.location.reload();
  return true;
}

let installed = false;

/** Instala los manejadores globales (idempotente). */
export function installGlobalErrorHandlers(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event: ErrorEvent) => {
    try {
      // Fallos de carga de recursos (img, link) llegan aquí sin `error`: los ignoramos (cada componente tiene su alternativa).
      if (!event.error && !event.message) return;
      const err = event.error ?? event.message;
      if (isChunkLoadError(err)) {
        reloadOnceForNewVersion();
        return;
      }
      reportError('Error no controlado', err);
    } catch {
      /* nunca relanzar */
    }
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    try {
      const reason = event.reason;
      if (isAbortError(reason)) {
        // cancelaciones propias (navegación, timeout): no son errores
        event.preventDefault();
        return;
      }
      if (isChunkLoadError(reason)) {
        event.preventDefault();
        reloadOnceForNewVersion();
        return;
      }
      reportError('Promesa rechazada sin controlar', reason);
      event.preventDefault();
    } catch {
      /* nunca relanzar */
    }
  });

  // Vite emite este evento cuando falla la precarga de un chunk (típico tras un despliegue nuevo).
  window.addEventListener('vite:preloadError', (event: Event) => {
    try {
      if (reloadOnceForNewVersion()) event.preventDefault();
    } catch {
      /* nunca relanzar */
    }
  });
}
