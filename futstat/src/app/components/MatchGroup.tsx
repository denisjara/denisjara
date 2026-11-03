import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import type { CompetitionMeta, MatchSummary } from '../../types/data';
import type { LiveScore } from '../lib/live';
import { cx } from './Card';
import { MatchRow } from './MatchRow';

export interface MatchGroupProps {
  compId: string;
  compName: string;
  meta?: CompetitionMeta;
  matches: MatchSummary[];
  live?: Record<string, LiveScore>;
  showDate?: boolean;
  showPrediction?: boolean;
  showHit?: boolean;
  /** filas compactas (solo 1X2) para columnas estrechas */
  compact?: boolean;
  className?: string;
}

/**
 * Bloque de partidos de una competición: cabecera (bandera, nombre, nº de partidos, enlace a la
 * competición) + filas MatchRow separadas por hairlines. Patrón estándar de listas agrupadas.
 */
export function MatchGroup({ compId, compName, meta, matches, live, showDate, showPrediction = true, showHit, compact, className }: MatchGroupProps) {
  const headingId = `grp-${compId}-${matches[0]?.id ?? 'x'}`;
  return (
    <section aria-labelledby={headingId} className={cx('card overflow-hidden p-0', className)}>
      <header className="flex items-center justify-between gap-2 border-b border-line bg-surface-2/70 px-3 py-2 sm:px-4">
        <h3 id={headingId} className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="text-[15px] leading-none">{meta?.flag ?? '⚽'}</span>
          <span className="truncate font-display text-[17px] font-bold uppercase tracking-wide text-ink-1">{meta?.name ?? compName}</span>
          <span className="num rounded bg-surface-3 px-1.5 text-2xs text-ink-2">{matches.length}</span>
        </h3>
        <Link to={`/c/${compId}`} className="btn-ghost -mr-1 shrink-0 px-2 py-1 text-[12px]" aria-label={`Ir a ${meta?.name ?? compName}`}>
          <span className="hidden sm:inline">Competición</span>
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </header>
      <ul className="divide-y divide-line/70">
        {matches.map((m) => (
          <li key={m.id}>
            <MatchRow match={m} live={live?.[m.id]} showDate={showDate} showPrediction={showPrediction} showHit={showHit} compact={compact} />
          </li>
        ))}
      </ul>
    </section>
  );
}
