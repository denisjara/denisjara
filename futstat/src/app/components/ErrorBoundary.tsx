/**
 * Barreras de error en tres niveles para que la web nunca quede en blanco:
 *
 *  1. <AppErrorBoundary>   global (envuelve toda la app): pantalla de error amable con "Reintentar" e
 *                          "Ir al inicio". Sin pila técnica para el usuario.
 *  2. <RouteErrorBoundary> por ruta: si una página falla, el resto del armazón (menú, buscador) sigue
 *                          funcionando y el error se limpia al cambiar de ruta.
 *  3. <SafeBlock>          por sección/panel: un bloque roto muestra "No se pudo mostrar este bloque" y el
 *                          resto de la página sigue. <Section> y <TabPanel> lo aplican automáticamente.
 *
 * Errores al cargar código (chunks que ya no existen tras un despliegue) se tratan aparte: se ofrece
 * recargar la página para obtener la versión nueva.
 */
import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { useInRouterContext, useLocation } from 'react-router-dom';
import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { isChunkLoadError, reloadOnceForNewVersion, reportError } from '../lib/errors';

const join = (...p: (string | false | undefined)[]) => p.filter(Boolean).join(' ');

/** Va al inicio de la app sin depender del router (sirve también fuera de él). */
function goHome() {
  try {
    window.location.hash = '#/';
  } catch {
    /* sin acceso a location: nada que hacer */
  }
}

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------
interface BoundaryProps {
  children?: ReactNode;
  /** al cambiar, se limpia el error (p. ej. la ruta) */
  resetKey?: string;
  /** etiqueta para el registro en consola */
  scope: string;
  fallback: (error: Error, reset: () => void) => ReactNode;
}

class Boundary extends Component<BoundaryProps, { error: Error | null; key: string | undefined }> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: { error: Error | null; key: string | undefined }) {
    // Cambio de ruta (u otra clave): se descarta el error anterior.
    if (props.resetKey !== state.key) return { error: null, key: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(this.props.scope, error);
    if (import.meta.env.DEV && info.componentStack) console.debug(`[FutStat] ${this.props.scope} — componentes:`, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      try {
        return this.props.fallback(this.state.error, this.reset);
      } catch {
        return null;
      }
    }
    return this.props.children ?? null;
  }
}

// ---------------------------------------------------------------------------
// 1. Global
// ---------------------------------------------------------------------------
function AppFallback({ error, reset }: { error: Error; reset: () => void }) {
  const chunk = isChunkLoadError(error);
  return (
    <div role="alert" className="flex min-h-[100dvh] items-center justify-center bg-bg px-4 py-10 text-ink-1">
      <div className="w-full max-w-md rounded-card border border-line bg-surface-1 p-6 text-center shadow-card">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-loss/15 text-loss" aria-hidden="true">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <p className="font-display text-[26px] font-extrabold uppercase leading-tight tracking-wide">
          {chunk ? 'Hay una versión nueva' : 'Algo ha salido mal'}
        </p>
        <p className="mt-2 text-[14px] text-ink-2">
          {chunk
            ? 'FutStat Lab se ha actualizado mientras tenías la página abierta. Recarga para usar la versión nueva.'
            : 'No hemos podido mostrar la aplicación. Tus datos no se han perdido: vuelve a intentarlo o ve al inicio.'}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            className="btn-accent"
            onClick={() => {
              if (chunk) window.location.reload();
              else reset();
            }}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> {chunk ? 'Recargar' : 'Reintentar'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              goHome();
              reset();
            }}
          >
            <Home className="h-4 w-4" aria-hidden="true" /> Ir al inicio
          </button>
        </div>
      </div>
    </div>
  );
}

/** Barrera global: si todo lo demás falla, pantalla amable en lugar de una página en blanco. */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <Boundary scope="Error global de la app" fallback={(error, reset) => <AppFallback error={error} reset={reset} />}>
      {children}
    </Boundary>
  );
}

// ---------------------------------------------------------------------------
// 2. Por ruta
// ---------------------------------------------------------------------------
function RouteFallback({ error, reset }: { error: Error; reset: () => void }) {
  const chunk = isChunkLoadError(error);
  useEffect(() => {
    // tras un despliegue nuevo, una recarga automática (como mucho una por minuto) trae los chunks actuales
    if (chunk) reloadOnceForNewVersion();
  }, [chunk]);
  return (
    <div role="alert" className="flex flex-col items-center justify-center rounded-card border border-line bg-surface-1/80 px-6 py-12 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-loss/15 text-loss" aria-hidden="true">
        <AlertTriangle className="h-5 w-5" />
      </div>
      <h1 className="font-display text-[22px] font-bold uppercase tracking-wide text-ink-1">
        {chunk ? 'No se pudo cargar esta sección' : 'Algo ha fallado al mostrar esta página'}
      </h1>
      <p className="mt-1 max-w-md text-[13px] text-ink-2">
        {chunk
          ? 'Puede que la web se haya actualizado o que se haya cortado la conexión. Recarga la página para continuar.'
          : 'El resto de la aplicación sigue funcionando. Puedes reintentar o volver al inicio.'}
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <button type="button" className="btn" onClick={() => (chunk ? window.location.reload() : reset())}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> {chunk ? 'Recargar' : 'Reintentar'}
        </button>
        <a href="#/" className="btn-ghost" onClick={() => reset()}>
          <Home className="h-4 w-4" aria-hidden="true" /> Ir al inicio
        </a>
      </div>
    </div>
  );
}

/** Barrera por ruta: el error se limpia al cambiar `resetKey` (la ruta). */
export function RouteErrorBoundary({ children, resetKey }: { children: ReactNode; resetKey: string }) {
  return (
    <Boundary scope="Error en la página" resetKey={resetKey} fallback={(error, reset) => <RouteFallback error={error} reset={reset} />}>
      {children}
    </Boundary>
  );
}

// ---------------------------------------------------------------------------
// 3. Por bloque
// ---------------------------------------------------------------------------
/** Aviso compacto de bloque roto. */
export function BlockError({ onRetry, className, label }: { onRetry?: () => void; className?: string; label?: string }) {
  return (
    <div role="status" className={join('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-dashed border-line-strong bg-surface-1/60 px-4 py-3 text-[13px] text-ink-2', className)}>
      <AlertTriangle className="h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        No se pudo mostrar {label ? `«${label}»` : 'este bloque'}. El resto de la página sigue disponible.
      </span>
      {onRetry && (
        <button type="button" className="btn-ghost -my-1 shrink-0 text-[12.5px]" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Reintentar
        </button>
      )}
    </div>
  );
}

export interface SafeBlockProps {
  children?: ReactNode;
  /** nombre del bloque (opcional) para el aviso */
  label?: string;
  /** clave extra de reinicio (además de la ruta) */
  resetKey?: string;
  className?: string;
}

function RoutedSafeBlock({ children, label, resetKey, className }: SafeBlockProps) {
  const { pathname } = useLocation();
  return (
    <Boundary scope="Error en un bloque" resetKey={`${pathname}|${resetKey ?? ''}`} fallback={(_, reset) => <BlockError onRetry={reset} label={label} className={className} />}>
      {children}
    </Boundary>
  );
}

/** Aísla un bloque: si falla al renderizar, muestra un aviso y el resto de la página sigue. Se reinicia al cambiar de ruta. */
export function SafeBlock(props: SafeBlockProps) {
  const inRouter = useInRouterContext();
  if (inRouter) return <RoutedSafeBlock {...props} />;
  return (
    <Boundary scope="Error en un bloque" resetKey={props.resetKey} fallback={(_, reset) => <BlockError onRetry={reset} label={props.label} className={props.className} />}>
      {props.children}
    </Boundary>
  );
}
