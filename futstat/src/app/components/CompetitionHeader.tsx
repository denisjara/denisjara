import { useState, type ReactNode } from 'react';
import type { CompetitionMeta } from '../../types/data';
import { KIND_LABEL } from '../lib/competitions';
import { useTheme } from '../lib/theme';
import { cx } from './Card';

export interface CompetitionHeaderProps {
  meta: CompetitionMeta;
  /** línea secundaria (p. ej. "Jornada 12 de 38") */
  subtitle?: ReactNode;
  /** cifras rápidas a la derecha */
  stats?: { label: string; value: ReactNode }[];
  /** botones/acciones */
  actions?: ReactNode;
  /** contenido bajo la cabecera (pestañas) */
  children?: ReactNode;
  className?: string;
}

/**
 * Cabecera de competición (h1): logo o bandera, nombre en tipografía de marcador, país · tipo ·
 * temporada y cifras clave. Pon las <Tabs> como children para que queden pegadas a la cabecera.
 */
export function CompetitionHeader({ meta, subtitle, stats, actions, children, className }: CompetitionHeaderProps) {
  const [theme] = useTheme();
  // ESPN publica una variante "-dark" (logos claros) para fondos oscuros; si falla se usa la normal y, después, la bandera.
  const [failed, setFailed] = useState<string[]>([]);
  const logo = (theme === 'dark' ? [meta.logoDark, meta.logo] : [meta.logo]).find((u): u is string => !!u && !failed.includes(u));
  const accent = meta.color && /^[0-9a-fA-F]{6}$/.test(meta.color) ? `#${meta.color}` : undefined;
  return (
    <header className={cx('relative overflow-hidden rounded-card border border-line bg-surface-1/80', className)}>
      <div className="pitch-lines pointer-events-none absolute inset-0 opacity-[0.05]" aria-hidden="true" />
      <div
        className="pointer-events-none absolute -left-24 -top-24 h-64 w-64 rounded-full opacity-20 blur-3xl"
        style={{ background: accent ?? 'rgb(var(--c-accent))' }}
        aria-hidden="true"
      />
      <div className="relative flex flex-wrap items-center gap-4 px-4 pb-4 pt-5 sm:px-6">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-line bg-surface-2 sm:h-[72px] sm:w-[72px]">
          {logo ? (
            <img src={logo} alt="" className="h-11 w-11 object-contain sm:h-12 sm:w-12" onError={() => setFailed((f) => [...f, logo])} />
          ) : (
            <span className="text-[34px] leading-none" aria-hidden="true">{meta.flag}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="eyebrow flex flex-wrap items-center gap-x-2 text-accent-text">
            <span>{meta.country}</span>
            <span aria-hidden="true">·</span>
            <span>{KIND_LABEL[meta.kind]}</span>
            {meta.seasonLabel && (
              <>
                <span aria-hidden="true">·</span>
                <span>Temporada {meta.seasonLabel}</span>
              </>
            )}
          </div>
          <h1 className="display mt-1 truncate text-[36px] text-ink-1 sm:text-[48px]">{meta.name}</h1>
          {subtitle && <p className="mt-1 text-[13px] text-ink-2">{subtitle}</p>}
        </div>
        {(stats?.length || actions) && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {stats?.map((s) => (
              <div key={s.label} className="min-w-[84px] rounded-lg border border-line bg-surface-2/80 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{s.label}</div>
                <div className="font-display text-[22px] font-extrabold leading-tight text-ink-1">{s.value}</div>
              </div>
            ))}
            {actions}
          </div>
        )}
      </div>
      {children && <div className="relative px-2 sm:px-4">{children}</div>}
    </header>
  );
}
