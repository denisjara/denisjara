import { Link } from 'react-router-dom';
import { ChevronRight, Zap } from 'lucide-react';
import type { MatchSummary, ValuePick } from '../../../types/data';
import { CompetitionBadge, TeamCrest, cx, matchHref } from '../../components';
import { ev as fmtEv, kickoff, odds as fmtOdds, pct, signed } from '../../lib/format';
import { pickMarketLabel, pickSelection } from '../../lib/picks';
import { ConfidenceTag } from './ui';

export interface ValueItem {
  match: MatchSummary;
  pick: ValuePick;
}

/** Cuota mínima a la que la selección sigue teniendo EV ≥ minEv: (1 + minEv) / p. */
export function minOddsFor(p: number, minEv: number): number | undefined {
  return p > 0 ? (1 + minEv) / p : undefined;
}

export const impliedOf = (odds: number) => (odds > 1 ? 1 / odds : undefined);

/** Texto para un pick cuyo partido ya no está pendiente. */
export function startedLabel(m: Pick<MatchSummary, 'status'>): string {
  return m.status === 'postponed' ? 'Aplazado' : m.status === 'cancelled' ? 'Cancelado' : m.status === 'finished' ? 'Terminado' : 'Ya empezado';
}

/**
 * Probabilidad del modelo frente a la implícita en la cuota: relleno = modelo, marca vertical = cuota.
 * `compact` (tablas): cifras en una línea y barra corta.
 */
export function ProbVsImplied({ prob, odds, edge, className, compact }: { prob: number; odds: number; edge?: number; className?: string; compact?: boolean }) {
  const implied = impliedOf(odds) ?? 0;
  const e = edge ?? prob - implied;
  const bar = (
    <span
      className={cx('relative block rounded-full bg-surface-3', compact ? 'mt-1 h-1.5' : 'mt-1.5 h-2')}
      role="img"
      aria-label={`Probabilidad del modelo ${pct(prob, 1)} frente a ${pct(implied, 1)} implícita en la cuota: ventaja de ${signed(e * 100, 1)} puntos`}
    >
      <span className="absolute inset-y-0 left-0 rounded-full bg-accent-text/85" style={{ width: `${Math.min(100, prob * 100)}%` }} />
      <span className="absolute -inset-y-[3px] w-[2px] rounded-full bg-ink-1 ring-2 ring-surface-1" style={{ left: `calc(${Math.min(100, implied * 100)}% - 1px)` }} />
    </span>
  );
  if (compact) {
    return (
      <span className={cx('block min-w-0', className)}>
        <span className="block whitespace-nowrap text-right text-[12.5px]">
          <span className="font-semibold text-ink-1">{pct(prob, 1)}</span>
          <span className="text-ink-3"> vs {pct(implied, 1)}</span>
        </span>
        {bar}
      </span>
    );
  }
  return (
    <div className={cx('min-w-0', className)}>
      <div className="flex items-baseline justify-between gap-2 text-2xs text-ink-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2.5 rounded-sm bg-accent-text" aria-hidden="true" />
          Modelo <span className="num font-semibold text-ink-1">{pct(prob, 1)}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-[2px] rounded-full bg-ink-1" aria-hidden="true" />
          Implícita <span className="num font-semibold text-ink-1">{pct(implied, 1)}</span>
        </span>
      </div>
      {bar}
    </div>
  );
}

function Metric({ label, value, tone, title }: { label: string; value: string; tone?: 'pos'; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</div>
      <div className={cx('num mt-0.5 truncate text-[14px] font-semibold', tone === 'pos' ? 'text-pos' : 'text-ink-1')}>{value}</div>
    </div>
  );
}

/** Tarjeta de un pick de valor (boleto): partido, mercado, selección, cuota, prob. vs implícita, EV, Kelly y confianza. */
export function ValueCard({ item, minEv, started }: { item: ValueItem; minEv: number; started?: boolean }) {
  const { match: m, pick } = item;
  const minOdds = minOddsFor(pick.prob, minEv);
  const titleId = `pick-${m.id}-${pick.marketId}-${pick.selection}`.replace(/[^\w-]/g, '_');
  return (
    <article aria-labelledby={titleId} className={cx('card card-hover relative flex min-w-0 flex-col gap-3 p-4', started && 'opacity-70')}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-2xs text-ink-3">
          <CompetitionBadge compId={m.compId} name={m.compName} className="text-2xs" />
          <span aria-hidden="true">·</span>
          {started ? (
            <span className="rounded-md border border-warn/50 px-1.5 py-px font-semibold uppercase tracking-wide text-warn">{startedLabel(m)}</span>
          ) : (
            <span className="num truncate">{kickoff(m.date)}</span>
          )}
        </span>
        <ConfidenceTag level={pick.confidence} />
      </div>

      <h3 id={titleId} className="min-w-0">
        <Link to={matchHref(m)} className="stretched-link flex min-w-0 items-center gap-2 text-[14px] font-semibold text-ink-1">
          <TeamCrest team={m.home} size={22} />
          <span className="truncate">{m.home.short || m.home.name}</span>
          <span className="shrink-0 text-ink-3">–</span>
          <span className="truncate">{m.away.short || m.away.name}</span>
          <TeamCrest team={m.away} size={22} />
          <span className="sr-only">
            : {pickMarketLabel(pick)}, {pickSelection(pick)} a cuota {fmtOdds(pick.odds)}, valor esperado {fmtEv(pick.ev)}
          </span>
        </Link>
      </h3>

      <div className="flex items-end justify-between gap-3 rounded-lg border border-accent-text/35 bg-accent/[0.06] px-3 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-2xs text-ink-3">{pickMarketLabel(pick)}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
            <Zap className="h-4 w-4 shrink-0 text-accent-text" aria-hidden="true" />
            <span className="truncate text-[15px] font-semibold text-ink-1">{pickSelection(pick)}</span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Cuota</div>
          <div className="num text-[22px] font-semibold leading-none text-ink-1">{fmtOdds(pick.odds)}</div>
        </div>
      </div>

      <ProbVsImplied prob={pick.prob} odds={pick.odds} edge={pick.edge} />

      <div className="grid grid-cols-4 gap-2 border-t border-line pt-3">
        <Metric label="EV" value={fmtEv(pick.ev)} tone="pos" title="Valor esperado por unidad apostada" />
        <Metric label="Justa" value={fmtOdds(pick.fairOdds)} title="Cuota justa del modelo (1 / probabilidad)" />
        <Metric label="Stake" value={pct(pick.kelly, 1)} title="Stake recomendado (Kelly fraccional) en % de la banca" />
        <Metric label="Mín." value={minOdds ? fmtOdds(minOdds) : '–'} title={`Cuota mínima para mantener un EV de al menos ${pct(minEv)}`} />
      </div>
      <div className="-mt-1 flex items-center justify-between gap-2 text-2xs text-ink-3">
        <span>
          Ventaja <span className="num font-semibold text-ink-2">{signed(pick.edge * 100, 1)} pp</span>
        </span>
        <span className="inline-flex items-center gap-0.5 font-medium text-ink-2">
          Ver análisis <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </div>
    </article>
  );
}
