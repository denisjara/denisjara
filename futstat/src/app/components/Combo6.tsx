import { Link } from 'react-router-dom';
import { ArrowRight, Crosshair, FlagTriangleRight, Goal, Hand, RectangleVertical, Target, Ticket, Trophy, UserRound, type LucideIcon } from 'lucide-react';
import type { Combo6Category, Combo6Leg } from '../../types/data';
import { COMBO6_CATEGORY_LABEL, COMBO6_ODDS_SOURCE_LABEL, combo6LegOddsText, combo6LegStarted } from '../lib/combo6';
import { localizeDecimals } from '../lib/picks';
import { dayKey, kickoff, odds as fmtOdds, pct, time } from '../lib/format';
import { cx } from './Card';
import { CompetitionBadge } from './MatchStatus';
import { TeamCrest } from './TeamCrest';
import { ResultMark } from './Confidence';
import { legHref } from './Longshot';

/**
 * Piezas compartidas de «Combinada 6» (public/data/combo6.json): insignia de categoría, cuota de una pata con su origen
 * (de la casa o estimada, siempre dicho) y la fila de una pata. Las usan la página /combinada-6 y la tarjeta de Inicio.
 */

export const COMBO6_CATEGORY_ICON: Record<Combo6Category, LucideIcon> = {
  ganador: Trophy,
  goles: Goal,
  corners: FlagTriangleRight,
  'tiros-puerta': Target,
  tiros: Crosshair,
  tarjetas: RectangleVertical,
  faltas: Hand,
  jugadores: UserRound,
};

/** Insignia neutra de la categoría de una pata (icono + texto; nunca un color por categoría). */
export function Combo6CategoryBadge({ category, className }: { category: Combo6Category; className?: string }) {
  const Icon = COMBO6_CATEGORY_ICON[category] ?? Trophy;
  return (
    <span className={cx('chip shrink-0 whitespace-nowrap', className)}>
      <Icon className="h-3 w-3 shrink-0 text-accent-text" aria-hidden="true" />
      {COMBO6_CATEGORY_LABEL[category] ?? 'Otra'}
    </span>
  );
}

const LEG_RESULT = { hit: 'acertada', miss: 'fallada', void: 'nula (se quita de la combinada)' } as const;

/** Hora local de la pata (con el día si no es el del listado), «Empezado» si ya pasó o «Final» si está resuelta. */
function LegTime({ leg, now, day, settled }: { leg: Combo6Leg; now: number; day?: string; settled?: boolean }) {
  if (!leg.kickoff) return null;
  if (settled || combo6LegStarted(leg, now)) {
    return <span className="shrink-0 rounded-md bg-surface-3 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-ink-2">{settled ? 'Final' : 'Empezado'}</span>;
  }
  return <span className="num shrink-0 text-[12px] font-semibold text-ink-1">{day && dayKey(leg.kickoff) !== day ? kickoff(leg.kickoff, new Date(now)) : time(leg.kickoff)}</span>;
}

/** Celda numérica con etiqueta encima. */
function Num({ label, value, sub, title, strong, className }: { label: string; value: string; sub?: string; title?: string; strong?: boolean; className?: string }) {
  return (
    <span className={cx('min-w-[46px] shrink-0 text-right', className)} title={title}>
      <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</span>
      <span className={cx('num block whitespace-nowrap text-[13px]', strong ? 'font-semibold text-ink-1' : 'text-ink-2')}>{value}</span>
      {sub && <span className="block whitespace-nowrap text-[10px] leading-tight text-ink-3">{sub}</span>}
    </span>
  );
}

export interface Combo6LegRowProps {
  leg: Combo6Leg;
  /** número de pata (0-based) */
  index?: number;
  now: number;
  /** día del listado (YYYY-MM-DD) */
  day?: string;
  /** la combinada está resuelta (muestra «Final» y el resultado de la pata) */
  settled?: boolean;
  /** oculta la explicación (listas compactas) */
  hideReason?: boolean;
}

/**
 * Fila de una pata: hora local y competición, escudos y equipos, categoría y selección, la explicación con los números
 * esperados y, a la derecha (debajo en móvil), probabilidad, cuota justa y cuota de la casa («≈ x,xx» si es estimada).
 */
export function Combo6LegRow({ leg, index, now, day, settled, hideReason }: Combo6LegRowProps) {
  const estimated = leg.bookOddsEstimated || leg.oddsSource !== 'casa';
  const selection = localizeDecimals(leg.selection);
  const nums = (
    <>
      <Num label="Prob." value={pct(leg.prob)} strong title="Probabilidad de la pata según el modelo (calibrada)" />
      <Num label="Justa" value={fmtOdds(leg.fairOdds)} title="Cuota justa (1 / probabilidad)" />
      <Num
        label="Casa"
        value={combo6LegOddsText(leg, fmtOdds)}
        sub={estimated ? 'estimada' : undefined}
        title={COMBO6_ODDS_SOURCE_LABEL[leg.oddsSource] ? `Cuota ${COMBO6_ODDS_SOURCE_LABEL[leg.oddsSource]}` : undefined}
        className="min-w-[58px]"
      />
    </>
  );
  return (
    <Link
      to={legHref(leg)}
      className="group flex min-w-0 items-start gap-2.5 px-3 py-3 transition-colors hover:bg-surface-2 sm:gap-3 sm:px-4"
      aria-label={`${index !== undefined ? `Pata ${index + 1}: ` : ''}${leg.home.name} – ${leg.away.name}, ${COMBO6_CATEGORY_LABEL[leg.category] ?? ''}: ${selection}, probabilidad ${pct(leg.prob)}, cuota ${estimated ? 'estimada ' : ''}${fmtOdds(leg.bookOdds)}${leg.result ? `, ${LEG_RESULT[leg.result]}` : ''}`}
    >
      {index !== undefined && (
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line-strong font-display text-[13px] font-extrabold leading-none text-ink-2" aria-hidden="true">
          {index + 1}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2 text-2xs text-ink-3">
          <LegTime leg={leg} now={now} day={day} settled={settled} />
          {leg.compId ? <CompetitionBadge compId={leg.compId} name={leg.compName} link={false} className="min-w-0 text-2xs font-medium" /> : leg.compName ? <span className="truncate">{leg.compName}</span> : null}
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-2">
          <span className="flex shrink-0 -space-x-1.5">
            <TeamCrest team={leg.home} size={20} className="ring-2 ring-surface-1" />
            <TeamCrest team={leg.away} size={20} className="ring-2 ring-surface-1" />
          </span>
          <span className="truncate text-[13.5px] font-semibold text-ink-1 group-hover:underline" title={`${leg.home.name} – ${leg.away.name}`}>
            {leg.home.short || leg.home.name} – {leg.away.short || leg.away.name}
          </span>
        </span>
        <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Combo6CategoryBadge category={leg.category} />
          <span className="min-w-0 text-[14px] font-semibold leading-snug text-ink-1 [overflow-wrap:anywhere]">{selection}</span>
        </span>
        {!hideReason && leg.reason && <span className="mt-1 block text-[12px] leading-snug text-ink-3">{localizeDecimals(leg.reason)}</span>}
        <span className="mt-2 flex items-start gap-3 sm:hidden [&>span]:text-left">{nums}</span>
      </span>
      <span className="hidden shrink-0 items-start gap-2 sm:flex">{nums}</span>
      {leg.result && <ResultMark result={leg.result} className="mt-0.5 h-5 w-5" />}
    </Link>
  );
}

/** Enlace destacado a /combinada-6 desde otras páginas (Cuota alta 6+, Pronósticos del día). */
export function Combo6Callout({ text, className }: { text?: string; className?: string }) {
  return (
    <Link to="/combinada-6" className={cx('card card-hover group flex min-w-0 items-center gap-3 px-3 py-3 sm:px-4', className)}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface-2 text-accent-text" aria-hidden="true">
        <Ticket className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-display text-[16px] font-bold uppercase leading-tight text-ink-1">Combinada 6</span>
        <span className="block text-[12.5px] leading-snug text-ink-2">
          {text ?? 'Una pata por partido en mercados distintos: las selecciones más probables que, juntas, pagan unas 6 veces en la casa.'}
        </span>
      </span>
      <span className="hidden shrink-0 items-center gap-1 text-[12.5px] font-semibold text-ink-1 sm:inline-flex">
        Ver la combinada
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
    </Link>
  );
}
