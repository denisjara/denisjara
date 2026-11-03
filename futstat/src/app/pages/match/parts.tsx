/** Piezas de presentación compartidas por las pestañas del análisis de partido. */
import type { ReactNode } from 'react';
import type { TeamRef } from '../../../types/data';
import { Card, InfoTip, TeamCrest, cx } from '../../components';

export interface PanelProps {
  title: ReactNode;
  /** icono lucide junto al título */
  icon?: ReactNode;
  /** texto corto sobre el título */
  eyebrow?: ReactNode;
  /** explicación bajo el título */
  description?: ReactNode;
  /** ayuda (i) junto al título */
  info?: ReactNode;
  /** controles a la derecha de la cabecera */
  action?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** sin padding en el cuerpo (listas/tablas a sangre) */
  flush?: boolean;
  id?: string;
  children?: ReactNode;
}

/** Tarjeta con cabecera (h2 con estilo de h3 de tarjeta) para los bloques de cada pestaña. */
export function Panel({ title, icon, eyebrow, description, info, action, className, bodyClassName, flush, id, children }: PanelProps) {
  const hid = id ? `${id}-title` : undefined;
  return (
    <Card as="section" pad="none" className={cx('flex flex-col', className)} aria-labelledby={hid} id={id}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 pt-4">
        <div className="min-w-0">
          {eyebrow && <div className="eyebrow mb-0.5">{eyebrow}</div>}
          <h2 id={hid} className="flex items-center gap-2 font-display text-[18px] font-bold uppercase leading-tight tracking-[0.02em] text-ink-1">
            {icon && <span className="text-accent-text [&>svg]:h-4 [&>svg]:w-4" aria-hidden="true">{icon}</span>}
            {title}
            {info && <InfoTip content={info} />}
          </h2>
          {description && <p className="mt-1 max-w-2xl text-[12.5px] leading-snug text-ink-2">{description}</p>}
        </div>
        {action && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{action}</div>}
      </div>
      <div className={cx('min-w-0 flex-1', flush ? 'pt-3' : 'p-4 pt-3', bodyClassName)}>{children}</div>
    </Card>
  );
}

/** Escudo + nombre corto con la marca de color del lado (local/visitante). */
export function TeamTag({ team, side, size = 18, full, className }: { team: TeamRef; side: 'home' | 'away'; size?: number; full?: boolean; className?: string }) {
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-1.5', className)}>
      <span className={cx('h-2 w-2 shrink-0 rounded-full', side === 'home' ? 'bg-home' : 'bg-away')} aria-hidden="true" />
      <TeamCrest team={team} size={size} />
      <span className="truncate font-medium text-ink-1" title={team.name}>
        {full ? team.name : team.short || team.name}
      </span>
    </span>
  );
}

/** Par etiqueta / valor compacto (dentro de rejillas de datos). */
export function Stat({ label, value, hint, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cx('min-w-0 rounded-lg border border-line bg-surface-2/60 px-3 py-2', className)}>
      <div className="truncate text-2xs font-medium text-ink-3">{label}</div>
      <div className="num mt-0.5 text-[15px] font-semibold text-ink-1">{value}</div>
      {hint && <div className="mt-0.5 truncate text-2xs text-ink-3">{hint}</div>}
    </div>
  );
}
