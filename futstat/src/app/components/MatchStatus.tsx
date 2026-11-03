import { Link } from 'react-router-dom';
import type { MatchStatus, MatchSummary } from '../../types/data';
import { useCompetitionMeta } from '../lib/data';
import { minute, relativeDay, time } from '../lib/format';
import { cx } from './Card';

export interface StatusPillProps {
  status: MatchStatus;
  detail?: string;
  /** fecha ISO (para mostrar la hora si está programado) */
  date?: string;
  className?: string;
  /** muestra también "Hoy/Mañana" en programados */
  withDay?: boolean;
}

/** Estado del partido: "● 67'" en vivo (rojo pulsante), "Final", "Aplazado" o la hora. */
export function StatusPill({ status, detail, date, className, withDay }: StatusPillProps) {
  if (status === 'live') {
    const d = detail ? (/^\d+$/.test(detail) ? minute(detail) : detail) : 'En vivo';
    return (
      <span className={cx('inline-flex items-center gap-1.5 rounded-md bg-live/15 px-1.5 py-0.5 text-2xs font-bold uppercase tracking-wide text-live', className)}>
        <span className="h-1.5 w-1.5 animate-live-pulse rounded-full bg-live" aria-hidden="true" />
        <span className="num normal-case">{d}</span>
        <span className="sr-only">en vivo</span>
      </span>
    );
  }
  if (status === 'finished') {
    return <span className={cx('rounded-md bg-surface-3 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-ink-2', className)}>{detail && detail !== 'FT' ? detail : 'Final'}</span>;
  }
  if (status === 'postponed' || status === 'cancelled') {
    return (
      <span className={cx('rounded-md border border-warn/50 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-warn', className)}>
        {status === 'postponed' ? 'Aplazado' : 'Cancelado'}
      </span>
    );
  }
  return (
    <span className={cx('num text-[12px] font-medium text-ink-2', className)}>
      {withDay && date ? `${relativeDay(date)} · ` : ''}
      {date ? time(date) : '–'}
    </span>
  );
}

export interface CompetitionBadgeProps {
  compId: string;
  /** nombre de reserva si meta.json aún no ha cargado */
  name?: string;
  /** enlaza a /c/:compId */
  link?: boolean;
  className?: string;
  /** muestra el nombre corto */
  short?: boolean;
}

/** Bandera + nombre de competición (lee meta.json; cacheado). */
export function CompetitionBadge({ compId, name, link, className, short = true }: CompetitionBadgeProps) {
  const meta = useCompetitionMeta(compId);
  const label = meta ? (short ? meta.shortName : meta.name) : name ?? compId;
  const inner = (
    <>
      <span aria-hidden="true" className="text-[13px] leading-none">{meta?.flag ?? '⚽'}</span>
      <span className="truncate">{label}</span>
    </>
  );
  const cls = cx('inline-flex min-w-0 items-center gap-1.5 text-[12px] font-semibold text-ink-2', className);
  if (link) {
    return (
      <Link to={`/c/${compId}`} className={cx(cls, 'hover:text-ink-1')}>
        {inner}
      </Link>
    );
  }
  return <span className={cls}>{inner}</span>;
}

/** Ruta del análisis de un partido (o de su competición si no hay detalle publicado). */
export function matchHref(m: Pick<MatchSummary, 'id' | 'compId' | 'hasDetail'>): string {
  return m.hasDetail ? `/m/${m.id}` : `/c/${m.compId}`;
}
