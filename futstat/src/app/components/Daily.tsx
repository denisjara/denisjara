import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Crosshair, FlagTriangleRight, Goal, Hand, RectangleVertical, Trophy, UserRound, type LucideIcon } from 'lucide-react';
import type { DailyCategory, DailyPick, MatchSummary } from '../../types/data';
import { DAILY_CATEGORY_LABEL, hasStarted, pickRecord } from '../lib/daily';
import { localizeDecimals, pickMarketLabel } from '../lib/picks';
import { dayKey, kickoff, num, odds as fmtOdds, pct, time } from '../lib/format';
import { cx } from './Card';
import { OutOfSampleNote, ResultMark } from './Confidence';
import { CompetitionBadge, StatusPill, matchHref } from './MatchStatus';
import { TeamCrest } from './TeamCrest';

/**
 * Piezas compartidas de «Pronósticos del día» (public/data/daily.json): insignia de categoría, récord fuera de muestra
 * de la familia del pick, hora/estado del partido, celdas numéricas y la fila del «Top del día» (página /hoy e Inicio).
 * Mismas reglas de presentación que alta confianza: ningún acierto sin su n; con n < 50, «muestra pequeña».
 */

export const CATEGORY_ICON: Record<DailyCategory, LucideIcon> = {
  resultado: Trophy,
  goles: Goal,
  tiros: Crosshair,
  corners: FlagTriangleRight,
  tarjetas: RectangleVertical,
  faltas: Hand,
  jugadores: UserRound,
};

/**
 * Insignia neutra de categoría (icono + texto: nunca solo color). Por defecto lleva la etiqueta corta («Tiros»); `label`
 * (la de daily.json, que puede ser larga: «Tiros y tiros a puerta») solo donde hay sitio y queda como `title` en el resto.
 */
export function CategoryBadge({ category, label, title, className }: { category: DailyCategory; label?: string; title?: string; className?: string }) {
  const Icon = CATEGORY_ICON[category];
  return (
    <span className={cx('chip shrink-0 whitespace-nowrap', className)} title={title && title !== DAILY_CATEGORY_LABEL[category] ? title : undefined}>
      <Icon className="h-3 w-3 shrink-0 text-accent-text" aria-hidden="true" />
      {label || DAILY_CATEGORY_LABEL[category]}
    </span>
  );
}

export const dailySelection = (p: Pick<DailyPick, 'selection'>) => localizeDecimals(p.selection);
export const dailyMarket = (p: Pick<DailyPick, 'marketId' | 'market'>) => pickMarketLabel(p);

/**
 * Récord FUERA DE MUESTRA de la regla/familia del pick (walk-forward; si falta, holdout de la familia): acierto con n e
 * intervalo, «muestra pequeña» si n < 50, o aviso si no hay dato.
 */
export function DailyRecordNote({ pick, className }: { pick: DailyPick; className?: string }) {
  const rec = pickRecord(pick);
  return (
    <OutOfSampleNote
      className={className}
      pick={{ ...pick, validationHitRate: rec?.rate, validationN: rec?.n, validationWilsonLow: rec?.lo, validationWilsonHigh: rec?.hi }}
    />
  );
}

/**
 * Mejora de la regla sobre la tasa base de su mercado (acierto fuera de muestra − tasa base, en puntos porcentuales).
 * Solo con muestra suficiente (n ≥ 50). Si no mejora, se avisa: ese acierto es puramente estructural.
 */
export function DailyLiftNote({ pick, className }: { pick: DailyPick; className?: string }) {
  const rec = pickRecord(pick);
  if (pick.lift === undefined || !rec || rec.kind !== 'walk-forward' || rec.state !== 'ok') return null;
  const pp = `${pick.lift > 0 ? '+' : pick.lift < 0 ? '−' : ''}${num(Math.abs(pick.lift * 100), 1)}`;
  const title = 'Acierto fuera de muestra de su regla menos la tasa base de su mercado (su selección natural, sin filtrar con el modelo) en los mismos partidos';
  if (pick.lift > 0.0005) {
    return (
      <span className={cx('whitespace-nowrap text-2xs text-ink-3', className)} title={title}>
        <span className="num font-semibold text-ink-2">{pp}</span> pp sobre su tasa base
      </span>
    );
  }
  return (
    <span className={cx('inline-flex items-center gap-1 whitespace-nowrap text-2xs text-ink-2', className)} title={`${title}. Sin mejora, el acierto es estructural: lo aporta el mercado, no el modelo.`}>
      <AlertTriangle className="h-3 w-3 shrink-0 text-warn" aria-hidden="true" />
      <span>
        No mejora su tasa base (<span className="num">{pp}</span> pp)
      </span>
    </span>
  );
}

/**
 * Hora LOCAL del partido (con el día si no coincide con el del listado) o su estado si ya empezó: «● 67'», «Final»,
 * «Empezado» (programado en los datos pero con la hora ya pasada).
 */
export function DailyKickoff({ match: m, now, day, className }: { match: MatchSummary; now: number; day?: string; className?: string }) {
  if (m.status !== 'scheduled') return <StatusPill status={m.status} detail={m.statusDetail} date={m.date} className={className} />;
  if (hasStarted(m, now)) {
    return <span className={cx('rounded-md bg-surface-3 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-ink-2', className)}>Empezado</span>;
  }
  return <span className={cx('num shrink-0 text-[12px] font-medium text-ink-2', className)}>{day && dayKey(m.date) !== day ? kickoff(m.date, new Date(now)) : time(m.date)}</span>;
}

/** Celda numérica con etiqueta (prob., cuota justa, cuota de mercado), como en las filas de alta confianza. */
export function DailyNum({ label, value, title, strong, className }: { label: string; value: string; title?: string; strong?: boolean; className?: string }) {
  return (
    <span className={cx('w-[46px] shrink-0 text-right', className)} title={title}>
      <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</span>
      <span className={cx('num block text-[13px]', strong ? 'font-semibold text-ink-1' : 'text-ink-2')}>{value}</span>
    </span>
  );
}

/** Cuota de mercado de un pick: «1,07», «1,07*» (sintética) o «—» si la fuente no la publica. */
export function marketOddsText(p: Pick<DailyPick, 'marketOdds' | 'oddsKind'>): string {
  return p.marketOdds ? `${fmtOdds(p.marketOdds)}${p.oddsKind === 'sintetica' ? '*' : ''}` : '—';
}
export function marketOddsTitle(p: Pick<DailyPick, 'marketOdds' | 'oddsKind'>): string {
  return p.marketOdds ? (p.oddsKind === 'sintetica' ? 'Cuota sintética calculada desde el 1X2 de la casa' : 'Cuota de la casa') : 'La fuente no publica cuota para este mercado';
}

/** Prob., cuota justa y cuota de mercado de un pick, alineadas a la derecha. */
export function DailyOdds({ pick, className }: { pick: DailyPick; className?: string }) {
  return (
    <span className={cx('flex shrink-0 items-start gap-1.5', className)}>
      <DailyNum label="Prob." value={pct(pick.prob)} strong title="Probabilidad del modelo" />
      <DailyNum label="Justa" value={fmtOdds(pick.fairOdds)} title="Cuota justa (1 / probabilidad): por debajo de ella, la apuesta pierde dinero a la larga" />
      <DailyNum label="Mercado" value={marketOddsText(pick)} title={marketOddsTitle(pick)} className="w-[54px]" />
    </span>
  );
}

/** Aviso de los props de jugador. */
export const PLAYER_VOID_NOTE = 'Si no juega, la apuesta suele anularse: comprueba la alineación.';
export function PlayerVoidNote({ className }: { className?: string }) {
  return (
    <span className={cx('flex items-start gap-1 text-2xs text-ink-2', className)}>
      <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-warn" aria-hidden="true" />
      {PLAYER_VOID_NOTE}
    </span>
  );
}

export interface DailyTopRowProps {
  match: MatchSummary;
  pick: DailyPick;
  /** puesto en la lista (1..10) */
  rank?: number;
  /** ahora (ms), para saber si el partido ya empezó */
  now: number;
  /** día del listado (YYYY-MM-DD): la hora solo lleva día si el partido cae en otro día local */
  day?: string;
  /** etiqueta larga de la categoría (daily.json): solo como `title` de la insignia */
  categoryLabel?: string;
}

/**
 * Fila del «Top del día»: partido, competición y hora local · categoría · mercado → selección · récord fuera de muestra
 * de su familia · frase con los datos · probabilidad, cuota justa y cuota de mercado. Toda la fila enlaza al partido.
 */
export function DailyTopRow({ match: m, pick, rank, now, day, categoryLabel }: DailyTopRowProps) {
  const teams = `${m.home.short || m.home.name} – ${m.away.short || m.away.name}`;
  const started = hasStarted(m, now);
  const sel = dailySelection(pick);
  return (
    <Link
      to={matchHref(m)}
      className="group grid gap-x-6 gap-y-2.5 px-3 py-3 transition-colors hover:bg-surface-2 sm:px-4 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.6fr)] lg:items-start"
      aria-label={`${rank ? `${rank}. ` : ''}${teams}: ${sel}, ${pct(pick.prob)}${started ? ' (partido ya empezado)' : ''}`}
    >
      <span className="flex min-w-0 items-center gap-3">
        {rank !== undefined && <span className="num w-5 shrink-0 text-center font-display text-[18px] font-extrabold leading-none text-ink-3">{rank}</span>}
        <span className="flex shrink-0 -space-x-1.5">
          <TeamCrest team={m.home} size={22} className="ring-2 ring-surface-1" />
          <TeamCrest team={m.away} size={22} className="ring-2 ring-surface-1" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-semibold text-ink-1" title={`${m.home.name} – ${m.away.name}`}>
            {teams}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-2xs text-ink-3">
            <CompetitionBadge compId={m.compId} name={m.compName} link={false} className="min-w-0 text-2xs font-medium" />
            <DailyKickoff match={m} now={now} day={day} className="text-2xs" />
          </span>
        </span>
      </span>
      <span className={cx('block min-w-0 border-l-2 border-line pl-3 lg:border-l-0 lg:pl-0', rank !== undefined && 'ml-8 lg:ml-0')}>
        <span className="flex min-w-0 items-start gap-3">
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <CategoryBadge category={pick.category} title={categoryLabel} />
              <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 text-[13px] leading-snug">
                <span className="text-ink-3">{dailyMarket(pick)}</span>
                <ArrowRight className="h-3 w-3 shrink-0 text-ink-3" aria-hidden="true" />
                <span className="font-semibold text-ink-1">{sel}</span>
              </span>
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
              <DailyRecordNote pick={pick} />
              <DailyLiftNote pick={pick} />
            </span>
          </span>
          <DailyOdds pick={pick} className="hidden sm:flex" />
          {pick.result && <ResultMark result={pick.result} />}
        </span>
        {pick.reason && <span className="mt-1.5 block text-[12.5px] leading-snug text-ink-2">{pick.reason}</span>}
        {pick.category === 'jugadores' && <PlayerVoidNote className="mt-1" />}
        <DailyOdds pick={pick} className="mt-2 justify-start sm:hidden [&>span]:text-left" />
      </span>
    </Link>
  );
}
