import { Link } from 'react-router-dom';
import { Moon, Sun } from 'lucide-react';
import { useMeta } from '../lib/data';
import { dateTime, hoursSince, timeAgo } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useTheme } from '../lib/theme';
import { cx } from '../components/Card';

/** Marca FutStat Lab: monograma + logotipo en tipografía de marcador. */
export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <Link to="/" className={cx('group inline-flex items-center gap-2.5 rounded-lg', className)} aria-label="FutStat Lab — Inicio">
      <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
        <rect width="32" height="32" rx="8" fill="rgb(var(--c-surface-3))" />
        <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="rgb(var(--c-line-strong))" />
        <path d="M9 23V9h12M9 16h8" stroke="rgb(var(--c-accent-text))" strokeWidth="3.2" fill="none" strokeLinecap="square" />
        <circle cx="23" cy="22" r="3" fill="rgb(var(--c-ink-1))" />
      </svg>
      {!compact && (
        <span className="flex items-baseline gap-1.5 leading-none">
          <span className="font-display text-[22px] font-black uppercase tracking-[0.02em] text-ink-1">FutStat</span>
          <span className="rounded-[4px] bg-accent px-1 py-[3px] font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-accent-ink">Lab</span>
        </span>
      )}
    </Link>
  );
}

/** Conmutador de tema claro/oscuro (persistido). */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, toggle] = useTheme();
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      className={cx('inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-2 transition-colors hover:border-line-strong hover:text-ink-1', className)}
      aria-label={dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
      title={dark ? 'Tema claro' : 'Tema oscuro'}
    >
      {dark ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
    </button>
  );
}

/**
 * Indicador de última actualización de datos: la última descarga correcta de ESPN (meta.dataUpdatedAt) y, en datos
 * antiguos sin ese campo, la hora del build (meta.generatedAt). Verde < 30 h; ámbar si los datos son más viejos.
 */
export function UpdatedIndicator({ className, compact }: { className?: string; compact?: boolean }) {
  const { data, error } = useMeta();
  const now = useNow(60_000);
  if (error) {
    return (
      <span className={cx('inline-flex items-center gap-1.5 text-[12px] text-neg', className)}>
        <span className="h-2 w-2 rounded-full bg-neg" aria-hidden="true" /> Sin datos
      </span>
    );
  }
  if (!data) return <span className={cx('skeleton h-4 w-32', className)} aria-hidden="true" />;
  const at = data.dataUpdatedAt ?? data.generatedAt;
  const h = hoursSince(at, now);
  const fresh = h < 30;
  return (
    <span
      className={cx('inline-flex items-center gap-2 text-[12px] text-ink-2', className)}
      title={`Datos descargados de ESPN el ${dateTime(at)} · web generada el ${dateTime(data.generatedAt)} · Fuente: ${data.dataSource} · v${data.version}`}
    >
      <span className="relative flex h-2 w-2" aria-hidden="true">
        {fresh && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-pos opacity-50 motion-reduce:hidden" />}
        <span className={cx('relative inline-flex h-2 w-2 rounded-full', fresh ? 'bg-pos' : 'bg-warn')} />
      </span>
      <span>
        {compact ? '' : fresh ? 'Actualizado ' : 'Datos de '}
        <time dateTime={at} className="font-medium text-ink-1">
          {timeAgo(at, now)}
        </time>
      </span>
    </span>
  );
}
