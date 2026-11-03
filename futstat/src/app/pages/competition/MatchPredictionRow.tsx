import { Link } from 'react-router-dom';
import { ChevronRight, Zap } from 'lucide-react';
import type { MatchSummary, Prob1X2, TeamRef, ValuePick } from '../../../types/data';
import { Mini1X2, StatusPill, TeamCrest, cx, matchHref } from '../../components';
import { capitalize, dayKey, ev as fmtEv, longDate, num, odds as fmtOdds, pct, relativeDay, shortDate, time, xg as fmtXg } from '../../lib/format';
import type { LiveScore } from '../../lib/live';
import { pickMarketLabel, pickSelection } from '../../lib/picks';
import { applyLive } from '../../lib/live';

const SIDES = ['home', 'draw', 'away'] as const;

function TeamLine({ team, score, showScore, winner }: { team: TeamRef; score?: number; showScore: boolean; winner: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <TeamCrest team={team} size={20} />
      <span className={cx('min-w-0 flex-1 truncate text-[14px]', winner ? 'font-bold text-ink-1' : 'font-medium text-ink-1')} title={team.name}>
        {team.name}
      </span>
      {showScore && <span className={cx('num w-5 shrink-0 text-right text-[15px] font-semibold', winner ? 'text-ink-1' : 'text-ink-2')}>{score ?? 0}</span>}
    </span>
  );
}

/** 1X2 del modelo (Mini1X2) con la fila del mercado sin margen alineada debajo. */
export function ModelVsMarket({ p, market, className }: { p: Prob1X2; market?: Prob1X2; className?: string }) {
  return (
    <div className={cx('grid grid-cols-[52px_minmax(0,1fr)] items-center gap-x-2 gap-y-1', className)}>
      <span className="text-2xs font-medium text-ink-3">Modelo</span>
      <Mini1X2 p={p} />
      {market ? (
        <>
          <span className="text-2xs font-medium text-ink-3">Mercado</span>
          <span className="grid grid-cols-3 gap-[2px] text-center" aria-label={`Mercado sin margen: 1 ${pct(market.home)}, X ${pct(market.draw)}, 2 ${pct(market.away)}`} role="img">
            {SIDES.map((s) => {
              const d = p[s] - market[s];
              return (
                <span key={s} className="num text-[11.5px] text-ink-2" aria-hidden="true" title={`Modelo − mercado: ${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d * 100))} pp`}>
                  {pct(market[s])}
                </span>
              );
            })}
          </span>
        </>
      ) : (
        <>
          <span className="text-2xs font-medium text-ink-3">Mercado</span>
          <span className="text-center text-2xs text-ink-3">Sin cuotas</span>
        </>
      )}
    </div>
  );
}

/** Pick de valor en dos líneas (selección completa + cuota y EV). */
export function PickBlock({ pick, className }: { pick: ValuePick; className?: string }) {
  return (
    <span
      className={cx('flex min-w-0 items-center gap-2 rounded-lg border border-accent-text/40 bg-accent/10 px-2 py-1.5', className)}
      title={`${pickMarketLabel(pick)}: ${pickSelection(pick)} — prob. ${pct(pick.prob, 1)}, cuota ${fmtOdds(pick.odds)}, justa ${fmtOdds(pick.fairOdds)}`}
    >
      <Zap className="h-3.5 w-3.5 shrink-0 text-accent-text" aria-hidden="true" />
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-[12px] font-semibold text-ink-1">{pickSelection(pick)}</span>
        <span className="num block whitespace-nowrap text-2xs text-ink-2">
          @ {fmtOdds(pick.odds)} · EV <span className="font-semibold text-pos">{fmtEv(pick.ev)}</span>
        </span>
      </span>
    </span>
  );
}

function Metric({ label, short, value, title, className }: { label: string; short?: string; value: string; title?: string; className?: string }) {
  return (
    <div className={cx('min-w-0', className)} title={title}>
      <dt className="truncate text-[10px] font-semibold uppercase tracking-wide text-ink-3 sm:tracking-wider">
        {short ? (
          <>
            <span className="sm:hidden">{short}</span>
            <span className="hidden sm:inline">{label}</span>
          </>
        ) : (
          label
        )}
      </dt>
      <dd className="num truncate text-[12.5px] font-semibold text-ink-1">{value}</dd>
    </div>
  );
}

export interface MatchPredictionRowProps {
  match: MatchSummary;
  live?: LiveScore;
  /** muestra la fecha bajo la hora */
  showDate?: boolean;
}

/**
 * Fila de partido con la predicción completa compacta: 1X2 modelo vs mercado, xG, +2,5, ambos marcan,
 * córners y tarjetas esperados y pick de valor. Enlaza al análisis del partido.
 * Una línea a ≥1400px; dos líneas en tablet; apilada en móvil.
 */
export function MatchPredictionRow({ match: base, live, showDate }: MatchPredictionRowProps) {
  const m = applyLive(base, live);
  const pr = m.prediction;
  const showScore = (m.status === 'live' || m.status === 'finished') && !!m.score;
  const hw = showScore && m.score!.home > m.score!.away;
  const aw = showScore && m.score!.away > m.score!.home;
  return (
    <Link
      to={matchHref(m)}
      className={cx('group block px-3 py-3 transition-colors hover:bg-surface-2 sm:px-4', m.status === 'live' && 'bg-live/[0.04]')}
      aria-label={`${m.home.name} contra ${m.away.name}${showScore ? `, ${m.score!.home}-${m.score!.away}` : `, ${relativeDay(m.date)} a las ${time(m.date)}`}: ver análisis`}
    >
      <div className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-x-3 gap-y-3 md:grid-cols-[56px_minmax(0,1fr)_232px] min-[1400px]:grid-cols-[56px_minmax(150px,1fr)_220px_auto]">
        <span className="flex flex-col items-start gap-0.5 self-start pt-0.5 md:self-center md:pt-0">
          {m.status === 'scheduled' ? (
            <span className="num text-[13px] font-semibold text-ink-1">{time(m.date)}</span>
          ) : (
            <StatusPill status={m.status} detail={m.statusDetail} date={m.date} />
          )}
          {showDate && <span className="text-2xs capitalize text-ink-3">{shortDate(m.date)}</span>}
        </span>

        <span className="flex min-w-0 flex-col gap-1.5">
          <TeamLine team={m.home} score={m.score?.home} showScore={showScore} winner={hw} />
          <TeamLine team={m.away} score={m.score?.away} showScore={showScore} winner={aw} />
        </span>

        {pr ? (
          <>
            <ModelVsMarket p={pr.p} market={pr.market} className="col-span-2 md:col-span-1" />
            <div className="col-span-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 md:col-span-2 md:col-start-2 min-[1400px]:col-span-1 min-[1400px]:col-start-auto min-[1400px]:flex-nowrap">
              <dl className="grid w-full grid-cols-[1.45fr_1fr_1fr_1fr_1fr] gap-x-2 rounded-lg bg-surface-2/70 px-2.5 py-1.5 sm:w-auto sm:flex-none sm:grid-cols-[84px_52px_52px_56px_56px]">
                <Metric label="xG" value={`${fmtXg(pr.xgHome)}–${fmtXg(pr.xgAway)}`} title="Goles esperados (local–visitante)" />
                <Metric label="+2,5" value={pct(pr.over25)} title="Probabilidad de más de 2,5 goles" />
                <Metric label="Ambos" value={pct(pr.btts)} title="Probabilidad de que marquen ambos equipos" />
                <Metric label="Córners" short="Córn." value={num(pr.expCorners, 1)} title="Córners totales esperados" />
                <Metric label="Tarjetas" short="Tarj." value={num(pr.expCards, 1)} title="Tarjetas totales esperadas" />
              </dl>
              <span className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:justify-end min-[1400px]:w-[208px]">
                {pr.pick ? (
                  <PickBlock pick={pr.pick} />
                ) : (
                  <span className="text-2xs text-ink-3">{pr.market || m.odds ? 'Sin valor frente al mercado' : 'Sin cuotas: no se evalúa valor'}</span>
                )}
                <ChevronRight className="hidden h-4 w-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-1 sm:block" aria-hidden="true" />
              </span>
            </div>
          </>
        ) : (
          <p className="col-span-2 text-[12px] text-ink-3 md:col-span-1">Predicción no disponible para este partido.</p>
        )}
      </div>
    </Link>
  );
}

export interface MatchBlock {
  key: string;
  title: string;
  /** subtítulo: rango de fechas */
  subtitle?: string;
  matches: MatchSummary[];
  /** true si el bloque es una jornada (dentro se separan los días) */
  byRound: boolean;
}

/** Agrupa partidos por jornada (si todos traen `round`) o por día, conservando el orden cronológico. */
export function groupByRound(matches: MatchSummary[]): MatchBlock[] {
  const sorted = [...matches].sort((a, b) => a.date.localeCompare(b.date));
  const byRound = sorted.length > 0 && sorted.every((m) => !!m.round);
  const map = new Map<string, MatchSummary[]>();
  for (const m of sorted) {
    const k = byRound ? m.round! : dayKey(m.date);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(m);
  }
  return [...map.entries()].map(([k, ms]) => {
    const first = ms[0].date;
    const last = ms[ms.length - 1].date;
    const range = dayKey(first) === dayKey(last) ? capitalize(longDate(first)) : `${shortDate(first)} – ${shortDate(last)}`;
    return {
      key: k,
      title: byRound ? k : capitalize(relativeDay(first) === shortDate(first) ? longDate(first) : `${relativeDay(first)} · ${longDate(first)}`),
      subtitle: byRound ? range : undefined,
      matches: ms,
      byRound,
    };
  });
}

/** Tarjeta de una jornada / día con separadores de día y filas de predicción. */
export function MatchBlockCard({ block, live }: { block: MatchBlock; live?: Record<string, LiveScore> }) {
  const headingId = `blk-${block.key.replace(/[^\w-]/g, '_')}`;
  const rows: ({ kind: 'day'; key: string; date: string } | { kind: 'match'; m: MatchSummary })[] = [];
  let lastDay = '';
  for (const m of block.matches) {
    const d = dayKey(m.date);
    if (block.byRound && d !== lastDay) rows.push({ kind: 'day', key: d, date: m.date });
    lastDay = d;
    rows.push({ kind: 'match', m });
  }
  return (
    <section aria-labelledby={headingId} className="card overflow-hidden p-0">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line bg-surface-2/70 px-3 py-2.5 sm:px-4">
        <h3 id={headingId} className="flex items-center gap-2 font-display text-[18px] font-bold uppercase tracking-wide text-ink-1">
          {block.title}
          <span className="num rounded bg-surface-3 px-1.5 font-sans text-2xs font-medium normal-case tracking-normal text-ink-2">{block.matches.length}</span>
        </h3>
        {block.subtitle && <span className="text-[12px] capitalize text-ink-3">{block.subtitle}</span>}
      </header>
      <ul className="divide-y divide-line/70">
        {rows.map((r) =>
          r.kind === 'day' ? (
            <li key={`d-${r.key}`} className="bg-surface-2/35 px-3 py-1.5 sm:px-4">
              <span className="eyebrow">{capitalize(relativeDay(r.date) === shortDate(r.date) ? longDate(r.date) : `${relativeDay(r.date)} · ${longDate(r.date)}`)}</span>
            </li>
          ) : (
            <li key={r.m.id}>
              <MatchPredictionRow match={r.m} live={live?.[r.m.id]} />
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

/** Lista de bloques; vacío → nada (el llamador pone el EmptyState). */
export function MatchBlocks({ matches, live }: { matches: MatchSummary[]; live?: Record<string, LiveScore> }) {
  const blocks = groupByRound(matches);
  return (
    <div className="space-y-4">
      {blocks.map((b) => (
        <MatchBlockCard key={b.key} block={b} live={live} />
      ))}
    </div>
  );
}

