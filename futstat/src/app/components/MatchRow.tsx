import { Link } from 'react-router-dom';
import { Check, ChevronRight, X, Zap } from 'lucide-react';
import type { MatchSummary, Prob1X2, TeamRef } from '../../types/data';
import type { LiveScore } from '../lib/live';
import { applyLive } from '../lib/live';
import { SIDE_COLOR, type Side } from '../lib/colors';
import { ev as fmtEv, odds as fmtOdds, pct, relativeDay, shortDate, time, topOutcome } from '../lib/format';
import { pickMarketLabel, pickSelection } from '../lib/picks';
import { cx } from './Card';
import { TeamCrest } from './TeamCrest';
import { CompetitionBadge, StatusPill, matchHref } from './MatchStatus';

export interface MatchRowProps {
  match: MatchSummary;
  live?: LiveScore;
  /** muestra la competición sobre los equipos */
  showComp?: boolean;
  /** muestra la fecha además de la hora (listas de varios días) */
  showDate?: boolean;
  /** columnas de predicción (1X2, +2.5, ambos, pick). Por defecto true */
  showPrediction?: boolean;
  /** muestra ✓/✗ de acierto del modelo en partidos terminados */
  showHit?: boolean;
  /** solo 1X2 (sin +2,5, ambos ni pick): para contenedores estrechos (< 640px) */
  compact?: boolean;
  className?: string;
}

const SIDES: Side[] = ['home', 'draw', 'away'];
const SHORT: Record<Side, string> = { home: '1', draw: 'X', away: '2' };

function Team({ team, score, showScore, winner }: { team: TeamRef; score?: number; showScore: boolean; winner: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <TeamCrest team={team} size={18} />
      <span className={cx('min-w-0 flex-1 truncate text-[13.5px]', winner ? 'font-bold text-ink-1' : 'font-medium text-ink-1')} title={team.name}>
        <span className="sm:hidden">{team.short || team.name}</span>
        <span className="hidden sm:inline">{team.name}</span>
      </span>
      {showScore && <span className={cx('num w-5 shrink-0 text-right text-[14px] font-semibold', winner ? 'text-ink-1' : 'text-ink-2')}>{score ?? 0}</span>}
    </span>
  );
}

/** ✓ / ✗ de acierto del pronóstico 1X2 del modelo. */
export function HitMark({ hit, className }: { hit: boolean; className?: string }) {
  return (
    <span
      className={cx('h-6 w-6 items-center justify-center rounded-full', hit ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss', className ?? 'inline-flex')}
      title={hit ? 'El modelo acertó' : 'El modelo falló'}
      role="img"
      aria-label={hit ? 'Acierto del modelo' : 'Fallo del modelo'}
    >
      {hit ? <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" /> : <X className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />}
    </span>
  );
}

/** Tres celdas 1 · X · 2 con el favorito resaltado (fondo del color del lado + negrita). */
export function Mini1X2({ p, className }: { p: Prob1X2; className?: string }) {
  const top = topOutcome(p);
  return (
    <span className={cx('grid grid-cols-3 gap-[2px]', className)} aria-label={`1 ${pct(p.home)}, X ${pct(p.draw)}, 2 ${pct(p.away)}`} role="img">
      {SIDES.map((s) => (
        <span
          key={s}
          aria-hidden="true"
          className={cx('flex flex-col items-center rounded-[5px] px-1 py-1 leading-none', s === top ? 'bg-surface-3' : 'bg-surface-2')}
          style={s === top ? { boxShadow: `inset 0 -2px 0 0 ${SIDE_COLOR[s]}` } : undefined}
        >
          <span className="text-[9.5px] font-semibold text-ink-3">{SHORT[s]}</span>
          <span className={cx('num mt-0.5 text-[12px]', s === top ? 'font-bold text-ink-1' : 'text-ink-2')}>{pct(p[s])}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * Fila compacta de partido (listas por competición, calendario, resultados). Equipos apilados,
 * hora/estado a la izquierda y predicción a la derecha. Toda la fila es un enlace.
 */
export function MatchRow({ match: base, live, showComp, showDate, showPrediction = true, showHit, compact, className }: MatchRowProps) {
  const m = applyLive(base, live);
  const pr = m.prediction;
  const showScore = (m.status === 'live' || m.status === 'finished') && !!m.score;
  const hw = showScore && m.score!.home > m.score!.away;
  const aw = showScore && m.score!.away > m.score!.home;
  const hit = m.predictionHit;
  return (
    <Link
      to={matchHref(m)}
      className={cx(
        'group grid grid-cols-[52px_minmax(96px,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2.5 transition-colors hover:bg-surface-2 sm:grid-cols-[64px_minmax(140px,1fr)_auto] sm:px-4',
        m.status === 'live' && 'bg-live/[0.04]',
        className,
      )}
      aria-label={`${m.home.name} contra ${m.away.name}${showScore ? `, ${m.score!.home}-${m.score!.away}` : ''}`}
    >
      <span className="flex flex-col items-start gap-0.5">
        {m.status === 'scheduled' ? (
          <>
            <span className="num text-[13px] font-semibold text-ink-1">{time(m.date)}</span>
            {showDate && <span className="text-2xs capitalize text-ink-3">{relativeDay(m.date) === shortDate(m.date) ? shortDate(m.date) : relativeDay(m.date)}</span>}
          </>
        ) : (
          <>
            <StatusPill status={m.status} detail={m.statusDetail} date={m.date} />
            {showDate && <span className="text-2xs text-ink-3">{shortDate(m.date)}</span>}
            {showHit && typeof hit === 'boolean' && <HitMark hit={hit} className="mt-0.5 inline-flex sm:hidden" />}
          </>
        )}
      </span>

      <span className="flex min-w-0 flex-col gap-1">
        {showComp && <CompetitionBadge compId={m.compId} name={m.compName} className="mb-0.5 text-2xs" />}
        <Team team={m.home} score={m.score?.home} showScore={showScore} winner={hw} />
        <Team team={m.away} score={m.score?.away} showScore={showScore} winner={aw} />
      </span>

      <span className="flex items-center gap-2 sm:gap-3">
        {showPrediction && pr && (
          <>
            <Mini1X2 p={pr.p} className="w-[118px] sm:w-[132px]" />
            <span className={cx('hidden w-[52px] flex-col items-end leading-tight', !compact && 'md:flex')} title="Más de 2,5 goles">
              <span className="text-[9.5px] font-semibold uppercase text-ink-3">+2,5</span>
              <span className="num text-[12.5px] text-ink-1">{pct(pr.over25)}</span>
            </span>
            <span className={cx('hidden w-[52px] flex-col items-end leading-tight', !compact && 'md:flex')} title="Ambos equipos marcan">
              <span className="text-[9.5px] font-semibold uppercase text-ink-3">Ambos</span>
              <span className="num text-[12.5px] text-ink-1">{pct(pr.btts)}</span>
            </span>
            <span className={cx('hidden w-[188px] justify-end', !compact && 'xl:flex')}>
              {pr.pick ? (
                <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-accent-text/40 bg-accent/10 px-1.5 py-0.5 text-2xs" title={`${pickMarketLabel(pr.pick)}: ${pickSelection(pr.pick)}`}>
                  <Zap className="h-3 w-3 shrink-0 text-accent-text" aria-hidden="true" />
                  <span className="truncate font-medium text-ink-1">{pickSelection(pr.pick)}</span>
                  <span className="num shrink-0 text-ink-2">{fmtOdds(pr.pick.odds)}</span>
                  <span className="num shrink-0 font-semibold text-pos">{fmtEv(pr.pick.ev)}</span>
                </span>
              ) : m.status === 'scheduled' ? (
                <span className="text-2xs text-ink-3" aria-label="Sin pick de valor">—</span>
              ) : null}
            </span>
          </>
        )}
        {showHit && typeof hit === 'boolean' && <HitMark hit={hit} className="hidden sm:inline-flex" />}
        <ChevronRight className="hidden h-4 w-4 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-1 sm:block" aria-hidden="true" />
      </span>
    </Link>
  );
}
