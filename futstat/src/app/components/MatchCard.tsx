import { Link } from 'react-router-dom';
import { Flame } from 'lucide-react';
import type { MatchSummary, TeamRef } from '../../types/data';
import type { LiveScore } from '../lib/live';
import { applyLive } from '../lib/live';
import { pct, relativeDay, time, xg as fmtXg } from '../lib/format';
import { cx } from './Card';
import { TeamCrest } from './TeamCrest';
import { FormChips } from './FormChips';
import { ProbBar1X2 } from './ProbBar1X2';
import { ConfidenceMeter } from './ProbabilityBadge';
import { ValuePickChip } from './OddsButton';
import { CompetitionBadge, StatusPill, matchHref } from './MatchStatus';

export interface MatchCardProps {
  match: MatchSummary;
  /** marcador en vivo (de useLiveScores) — se fusiona sobre match */
  live?: LiveScore;
  /** oculta la competición (cuando ya está agrupado por competición) */
  hideCompetition?: boolean;
  /** muestra el icono de "popular" si popularity ≥ este umbral */
  hotThreshold?: number;
  className?: string;
  /** retraso de animación de entrada (ms) para escalonar rejillas */
  delay?: number;
}

function TeamLine({ team, form, score, winner, showScore }: { team: TeamRef; form?: string; score?: number; winner?: boolean; showScore: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <TeamCrest team={team} size={28} />
      <span className={cx('min-w-0 flex-1 truncate text-[15px] leading-tight', winner ? 'font-bold text-ink-1' : 'font-semibold text-ink-1')} title={team.name}>
        {team.name}
      </span>
      {form && <FormChips form={form} size="xs" className="hidden shrink-0 min-[380px]:inline-flex" label={undefined} />}
      {showScore && (
        <span className={cx('w-7 shrink-0 text-right font-display text-[26px] font-extrabold leading-none', winner ? 'text-ink-1' : 'text-ink-2')}>{score ?? 0}</span>
      )}
    </span>
  );
}

/**
 * Tarjeta de partido para la portada: competición, estado/hora, equipos con forma, marcador
 * (en vivo o final), barra 1X2, xG, +2.5, ambos marcan, marcador probable, pick de valor y confianza.
 * Toda la tarjeta enlaza al análisis del partido.
 */
export function MatchCard({ match: base, live, hideCompetition, hotThreshold = 85, className, delay }: MatchCardProps) {
  const m = applyLive(base, live);
  const pr = m.prediction;
  const showScore = (m.status === 'live' || m.status === 'finished') && !!m.score;
  const homeWin = showScore && m.score!.home > m.score!.away;
  const awayWin = showScore && m.score!.away > m.score!.home;
  const isLive = m.status === 'live';
  const title = `${m.home.name} contra ${m.away.name}`;

  return (
    <article
      className={cx(
        'card card-hover group relative flex flex-col gap-3 p-4 animate-fade-up',
        isLive && 'border-live/40',
        className,
      )}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      {isLive && <div className="pointer-events-none absolute inset-x-4 top-0 h-[2px] rounded-b bg-live" aria-hidden="true" />}
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {!hideCompetition && <CompetitionBadge compId={m.compId} name={m.compName} />}
          {m.round && <span className="truncate text-2xs text-ink-3">{hideCompetition ? m.round : `· ${m.round}`}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {typeof m.popularity === 'number' && m.popularity >= hotThreshold && (
            <span className="text-warn" title="Partido destacado" aria-label="Partido destacado">
              <Flame className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          )}
          {m.status === 'scheduled' ? (
            <span className="text-right leading-none">
              <span className="eyebrow block text-[10px]">{relativeDay(m.date)}</span>
              <span className="num text-[15px] font-semibold text-ink-1">{time(m.date)}</span>
            </span>
          ) : (
            <StatusPill status={m.status} detail={m.statusDetail} date={m.date} />
          )}
        </div>
      </header>

      <h3 className="flex flex-col gap-2">
        <Link to={matchHref(m)} className="stretched-link flex flex-col gap-2 focus-visible:outline-none" aria-label={`${title}: ver análisis`}>
          <TeamLine team={m.home} form={m.homeForm} score={m.score?.home} winner={homeWin} showScore={showScore} />
          <TeamLine team={m.away} form={m.awayForm} score={m.score?.away} winner={awayWin} showScore={showScore} />
        </Link>
      </h3>

      {pr ? (
        <>
          <ProbBar1X2 p={pr.p} market={pr.market} size="md" />
          <dl className="grid grid-cols-4 gap-1 rounded-lg bg-surface-2/70 p-2 text-center">
            <div className="min-w-0">
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">xG</dt>
              <dd className="num truncate text-[12.5px] font-semibold text-ink-1">
                {fmtXg(pr.xgHome)}
                <span className="text-ink-3">–</span>
                {fmtXg(pr.xgAway)}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-ink-3" title="Más de 2,5 goles">+2,5</dt>
              <dd className="num text-[12.5px] font-semibold text-ink-1">{pct(pr.over25)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-ink-3" title="Ambos equipos marcan">Ambos</dt>
              <dd className="num text-[12.5px] font-semibold text-ink-1">{pct(pr.btts)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-ink-3" title="Marcador exacto más probable">Marcador</dt>
              <dd className="num truncate text-[12.5px] font-semibold text-ink-1">
                {pr.likelyScore}
                <span className="ml-1 text-[11px] font-normal text-ink-3">{pct(pr.likelyScoreProb)}</span>
              </dd>
            </div>
          </dl>
          <footer className="flex min-h-[28px] items-center justify-between gap-2">
            {pr.pick ? (
              <ValuePickChip pick={pr.pick} className="min-w-0" />
            ) : (
              <span className="text-2xs text-ink-3">Sin valor frente al mercado</span>
            )}
            <ConfidenceMeter value={pr.confidence} />
          </footer>
        </>
      ) : (
        <p className="text-[12px] text-ink-3">Predicción no disponible para este partido.</p>
      )}
    </article>
  );
}
