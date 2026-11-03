import type { ReactNode } from 'react';
import { AlertTriangle, Home, RefreshCw, SearchX } from 'lucide-react';
import { DataError } from '../lib/data';
import { cx } from './Card';

/** Bloque gris animado. Dale tamaño con className (h-4 w-32 ...). */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden="true" />;
}

/** Tarjeta esqueleto con N líneas. */
export function SkeletonCard({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cx('card p-4', className)} aria-hidden="true">
      <Skeleton className="mb-4 h-3 w-24" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cx('mb-2.5 h-4', i % 3 === 2 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}

/** Esqueleto de página completa (cabecera + rejilla). Anunciado como "Cargando". */
export function PageSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Cargando…</span>
      <div className="card p-6">
        <Skeleton className="mb-3 h-3 w-28" />
        <Skeleton className="h-10 w-72 max-w-full" />
        <Skeleton className="mt-3 h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: cards }, (_, i) => (
          <SkeletonCard key={i} lines={4} />
        ))}
      </div>
    </div>
  );
}

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

/** Estado vacío: icono, título, explicación y acción opcional. */
export function EmptyState({ title, description, icon, action, className, compact }: EmptyStateProps) {
  return (
    <div className={cx('flex flex-col items-center justify-center rounded-card border border-dashed border-line-strong text-center', compact ? 'px-4 py-6' : 'px-6 py-12', className)}>
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-3 text-ink-2 [&>svg]:h-5 [&>svg]:w-5" aria-hidden="true">
        {icon ?? <SearchX />}
      </div>
      <p className="font-display text-[20px] font-bold uppercase tracking-wide text-ink-1">{title}</p>
      {description && <p className="mt-1 max-w-md text-[13px] text-ink-2">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  error?: Error | unknown;
  title?: string;
  onRetry?: () => void;
  className?: string;
  compact?: boolean;
  /** muestra también "Ir al inicio" (por defecto en errores de página completa) */
  home?: boolean;
}

/**
 * Error de carga con mensaje en español y botón de reintento. Solo se muestran mensajes propios
 * (DataError); nunca detalles técnicos ni pilas de llamadas.
 */
export function ErrorState({ error, title, onRetry, className, compact, home = !compact }: ErrorStateProps) {
  const notFound = error instanceof DataError && error.notFound;
  const t = title ?? (notFound ? 'No hay datos disponibles' : 'No se pudieron cargar los datos');
  const msg = notFound
    ? 'Este análisis todavía no se ha publicado. Los datos se actualizan cada día.'
    : error instanceof DataError
      ? error.message
      : 'Inténtalo de nuevo en unos segundos.';
  return (
    <div role="alert" className={cx('flex flex-col items-center justify-center rounded-card border border-line bg-surface-1/80 text-center', compact ? 'px-4 py-6' : 'px-6 py-12', className)}>
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-loss/15 text-loss" aria-hidden="true">
        <AlertTriangle className="h-5 w-5" />
      </div>
      <p className="font-display text-[20px] font-bold uppercase tracking-wide text-ink-1">{t}</p>
      <p className="mt-1 max-w-md text-[13px] text-ink-2">{msg}</p>
      {((onRetry && !notFound) || home) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {onRetry && !notFound && (
            <button type="button" onClick={onRetry} className="btn">
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Reintentar
            </button>
          )}
          {home && (
            <a href="#/" className="btn-ghost">
              <Home className="h-4 w-4" aria-hidden="true" /> Ir al inicio
            </a>
          )}
        </div>
      )}
    </div>
  );
}
