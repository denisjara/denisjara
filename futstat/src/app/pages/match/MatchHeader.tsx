import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, MapPin, Trophy } from 'lucide-react';
import type { MatchEventPublic, MatchFile, MatchSummary, TeamRef } from '../../../types/data';
import { CompetitionBadge, ConfidenceMeter, FormChips, ProbBar1X2, StatusPill, TeamCrest, cx } from '../../components';
import { useNow } from '../../lib/hooks';
import { capitalize, longDate, num, pct, time, timeAgo, xg } from '../../lib/format';

export interface MatchHeaderProps {
  file: MatchFile;
  /** partido con el marcador en vivo ya aplicado */
  match: MatchSummary;
}

const GOAL_TYPES = new Set<MatchEventPublic['type']>(['goal', 'penalty', 'own-goal']);

function Scorers({ events, teamId, align }: { events: MatchEventPublic[]; teamId: string; align: 'left' | 'right' }) {
  const goals = events.filter((e) => GOAL_TYPES.has(e.type) && e.teamId === teamId);
  if (!goals.length) return null;
  return (
    <ul className={cx('mt-2 space-y-0.5 text-[12px] text-ink-2', align === 'right' && 'text-right')} aria-label="Goles">
      {goals.map((g, i) => (
        <li key={i} className="truncate">
          <span className="text-ink-1">{g.player ?? 'Gol'}</span>{' '}
          <span className="num text-ink-3">{g.minute}</span>
          {g.type === 'penalty' && <span className="text-ink-3"> (pen.)</span>}
          {g.type === 'own-goal' && <span className="text-ink-3"> (p.p.)</span>}
        </li>
      ))}
    </ul>
  );
}

function TeamBlock({ team, form, rank, side, events }: { team: TeamRef; form?: string; rank?: number; side: 'home' | 'away'; events?: MatchEventPublic[] }) {
  const right = side === 'away';
  return (
    <div className={cx('flex min-w-0 flex-col items-center gap-2 text-center sm:flex-row sm:gap-4', right ? 'sm:flex-row-reverse sm:text-right' : 'sm:text-left')}>
      <div className="relative shrink-0">
        <TeamCrest team={team} size={64} className="hidden sm:inline-flex" />
        <TeamCrest team={team} size={48} className="sm:hidden" />
      </div>
      <div className={cx('flex min-w-0 max-w-full flex-col items-center', right ? 'sm:items-end' : 'sm:items-start')}>
        <span className="eyebrow flex items-center gap-1.5">
          <span className={cx('h-1.5 w-3 rounded-full', side === 'home' ? 'bg-home' : 'bg-away')} aria-hidden="true" />
          <span className="hidden sm:inline">{side === 'home' ? 'Local' : 'Visitante'}</span>
          <span className="sr-only sm:hidden">{side === 'home' ? 'Local' : 'Visitante'}</span>
          {rank !== undefined && (
            <span className="num text-ink-2" title={`${rank}º en la clasificación`}>
              <span className="hidden sm:inline">· </span>
              {rank}º
            </span>
          )}
        </span>
        <Link
          to={`/t/${team.id}`}
          className="mt-0.5 block max-w-full truncate pt-0.5 font-display text-[22px] font-extrabold uppercase leading-[1.12] text-ink-1 hover:text-accent-text sm:text-[30px] lg:text-[34px]"
          title={team.name}
        >
          <span className="sm:hidden">{team.short || team.name}</span>
          <span className="hidden sm:inline">{team.name}</span>
        </Link>
        {form && <FormChips form={form} size="xs" className="mt-1.5" label={undefined} />}
        {events && events.length > 0 && <Scorers events={events} teamId={team.id} align={right ? 'right' : 'left'} />}
      </div>
    </div>
  );
}

/** Centro del marcador: hora y cuenta atrás (programado) o resultado con estado (en vivo / final). */
function ScoreCenter({ match }: { match: MatchSummary }) {
  const now = useNow(30_000);
  const s = match.score;
  const played = (match.status === 'live' || match.status === 'finished') && s;
  if (played) {
    const hasHt = typeof s.htHome === 'number' && typeof s.htAway === 'number';
    const hasPen = typeof s.penHome === 'number' && typeof s.penAway === 'number';
    return (
      <div className="flex flex-col items-center gap-1.5">
        <StatusPill status={match.status} detail={match.statusDetail} />
        <div
          className={cx('flex items-center gap-2 font-display font-black leading-none text-ink-1 sm:gap-3', 'text-[52px] sm:text-[72px]')}
          aria-label={`Marcador: ${match.home.name} ${s.home}, ${match.away.name} ${s.away}`}
          role="img"
        >
          <span>{s.home}</span>
          <span className="text-[0.55em] text-ink-3" aria-hidden="true">
            –
          </span>
          <span>{s.away}</span>
        </div>
        {(hasHt || hasPen) && (
          <span className="num text-[12px] text-ink-3">
            {hasHt && `Descanso ${s.htHome}-${s.htAway}`}
            {hasHt && hasPen && ' · '}
            {hasPen && `Penaltis ${s.penHome}-${s.penAway}`}
          </span>
        )}
      </div>
    );
  }
  if (match.status === 'postponed' || match.status === 'cancelled') {
    return (
      <div className="flex flex-col items-center gap-2">
        <StatusPill status={match.status} />
        <span className="font-display text-[40px] font-black leading-none text-ink-3 sm:text-[56px]">vs</span>
      </div>
    );
  }
  const t = new Date(match.date).getTime();
  const soon = t - now.getTime();
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="eyebrow">Inicio</span>
      <span className="font-display text-[44px] font-black leading-none text-ink-1 sm:text-[60px]">{time(match.date)}</span>
      <span className={cx('text-[12px] font-medium', soon > 0 && soon < 3 * 3_600_000 ? 'text-accent-text' : 'text-ink-2')}>
        {soon > 0 ? capitalize(timeAgo(match.date, now)) : 'Pendiente de inicio'}
      </span>
    </div>
  );
}

function Fact({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('min-w-0 px-3 py-2.5 sm:px-4', className)}>
      <dt className="eyebrow truncate">{label}</dt>
      <dd className="mt-1 truncate text-[14px] text-ink-1">{children}</dd>
    </div>
  );
}

/**
 * Cabecera tipo marcador de retransmisión: competición, jornada, fecha local, estadio, escudos,
 * forma, estado/marcador, barra 1X2 del modelo (con mercado), xG del modelo y confianza.
 */
export function MatchHeader({ file, match }: MatchHeaderProps) {
  const model = file.model;
  const pred = match.prediction;
  const probs = model?.ensemble ?? pred?.p;
  const market = model?.market?.probs ?? pred?.market;
  const confidence = pred?.confidence ?? model?.confidence;
  const lh = model?.lambdaHome ?? pred?.xgHome;
  const la = model?.lambdaAway ?? pred?.xgAway;
  const showEvents = match.status === 'live' || match.status === 'finished';
  const homeRank = file.table?.homeRank ?? file.table?.rows.find((r) => r.team.id === match.home.id)?.rank;
  const awayRank = file.table?.awayRank ?? file.table?.rows.find((r) => r.team.id === match.away.id)?.rank;

  return (
    <header className="relative overflow-hidden rounded-card border border-line bg-surface-1/80">
      <div className="pitch-lines pointer-events-none absolute inset-0 opacity-[0.05]" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/70 to-transparent" aria-hidden="true" />
      <div className="pointer-events-none absolute -left-24 -top-28 h-64 w-64 rounded-full bg-home/15 blur-3xl" aria-hidden="true" />
      <div className="pointer-events-none absolute -right-24 -top-28 h-64 w-64 rounded-full bg-away/15 blur-3xl" aria-hidden="true" />

      <h1 className="sr-only">
        {match.home.name} contra {match.away.name}: análisis del partido
      </h1>

      {/* Rótulo superior */}
      <div className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-line/70 px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <CompetitionBadge compId={match.compId} name={match.compName} link short={false} className="text-[12.5px]" />
          {match.round && (
            <span className="inline-flex items-center gap-1 text-[12px] text-ink-2">
              <Trophy className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />
              {match.round}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-2">
          <span className="inline-flex items-center gap-1">
            <CalendarDays className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />
            <time dateTime={match.date}>
              {capitalize(longDate(match.date))} · <span className="num">{time(match.date)}</span>
            </time>
          </span>
          {match.venue && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden="true" />
              <span className="truncate">{match.venue}</span>
            </span>
          )}
        </div>
      </div>

      {/* Marcador */}
      <div className="relative grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 py-5 sm:gap-6 sm:px-6 sm:py-7">
        <TeamBlock team={match.home} form={match.homeForm ?? file.form?.home?.formString} rank={homeRank} side="home" events={showEvents ? file.events : undefined} />
        <ScoreCenter match={match} />
        <TeamBlock team={match.away} form={match.awayForm ?? file.form?.away?.formString} rank={awayRank} side="away" events={showEvents ? file.events : undefined} />
      </div>

      {/* Probabilidades */}
      {probs && (
        <div className="relative border-t border-line/70 px-4 pb-4 pt-3.5 sm:px-6">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="eyebrow">Probabilidades del modelo</span>
            {market && <span className="hidden text-2xs text-ink-3 sm:inline">Barra fina: mercado sin margen</span>}
          </div>
          <ProbBar1X2
            p={probs}
            market={market}
            size="lg"
            legend
            labels={{ home: match.home.short || match.home.name, draw: 'Empate', away: match.away.short || match.away.name }}
          />
        </div>
      )}

      {/* Datos clave */}
      <dl className="relative grid grid-cols-2 divide-line/70 border-t border-line/70 bg-surface-2/40 sm:grid-cols-4 sm:divide-x [&>div:nth-child(-n+2)]:border-b [&>div:nth-child(-n+2)]:border-line/70 sm:[&>div:nth-child(-n+2)]:border-b-0">
        <Fact label="xG del modelo">
          <span className="num font-semibold">{xg(lh)}</span>
          <span className="text-ink-3"> – </span>
          <span className="num font-semibold">{xg(la)}</span>
        </Fact>
        <Fact label="Marcador probable" className="border-l border-line/70 sm:border-l-0">
          <span className="num font-semibold">{pred?.likelyScore ?? '–'}</span>
          {pred && <span className="num ml-1.5 text-[12px] text-ink-3">{pct(pred.likelyScoreProb, 1)}</span>}
        </Fact>
        <Fact
          label={
            <>
              <span className="sm:hidden">+2,5 · Ambos marcan</span>
              <span className="hidden sm:inline">Más de 2,5 · Ambos marcan</span>
            </>
          }
        >
          <span className="num font-semibold">{pct(pred?.over25)}</span>
          <span className="text-ink-3"> · </span>
          <span className="num font-semibold">{pct(pred?.btts)}</span>
        </Fact>
        <Fact label="Confianza" className="border-l border-line/70 sm:border-l-0">
          {typeof confidence === 'number' ? (
            <span className="inline-flex items-center gap-2">
              <ConfidenceMeter value={confidence} />
              <span className="num text-[12px] text-ink-3">{num(confidence * 100, 0)}/100</span>
            </span>
          ) : (
            '–'
          )}
        </Fact>
      </dl>
    </header>
  );
}
