import { Link } from 'react-router-dom';
import { Activity, Flame, History, TrendingUp } from 'lucide-react';
import type { FormMatch, MatchFile, MatchSummary, TeamFormBlock } from '../../../types/data';
import { CompetitionBadge, DataTable, EmptyState, FormChips, LineChart, Meter, OutcomeChip, Sparkline, TeamCrest, cx, formMatchHref, type Column } from '../../components';
import { SIDE_COLOR } from '../../lib/colors';
import { int, num, shortDate, signed, xg } from '../../lib/format';
import { Panel, Stat, TeamTag } from './parts';
import { asShare } from './utils';

interface TabProps {
  file: MatchFile;
  match: MatchSummary;
}

function avg(xs: (number | undefined)[]): number | undefined {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : undefined;
}

function formLabel(v: number): string {
  if (v >= 75) return 'Excelente';
  if (v >= 60) return 'Buena';
  if (v >= 40) return 'Regular';
  if (v >= 25) return 'Mala';
  return 'Muy mala';
}

function SummaryCard({ block, side }: { block: TeamFormBlock; side: 'home' | 'away' }) {
  const last = block.last ?? [];
  const trend = block.eloTrend ?? [];
  const eloDelta = trend.length > 1 ? trend[trend.length - 1] - trend[0] : undefined;
  const chrono10 = [...last].reverse().map((m) => m.result).join('');
  const split = block.venueSplit;
  return (
    <Panel
      title={<TeamTag team={block.team} side={side} size={22} full className="font-display text-[18px] font-bold" />}
      eyebrow={side === 'home' ? 'Local' : 'Visitante'}
      action={
        <div className="text-right">
          <div className="font-display text-[34px] font-extrabold leading-none text-ink-1">{int(block.formIndex)}</div>
          <div className="text-2xs text-ink-3">Índice de forma · {formLabel(block.formIndex)}</div>
        </div>
      }
    >
      <Meter value={block.formIndex / 100} height={6} color={SIDE_COLOR[side]} label={`Índice de forma ${int(block.formIndex)} de 100`} />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="eyebrow mb-1">Últimos {Math.min(10, chrono10.length || 5)}</div>
          <FormChips form={chrono10 || block.formString} max={10} size="sm" label={undefined} />
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="eyebrow mb-0.5">Elo</div>
            <div className="num text-[16px] font-semibold text-ink-1">
              {int(block.elo)}
              {eloDelta !== undefined && <span className={cx('ml-1.5 text-[12px]', eloDelta > 0 ? 'text-pos' : eloDelta < 0 ? 'text-neg' : 'text-ink-3')}>{signed(eloDelta, 0)}</span>}
            </div>
          </div>
          {trend.length > 1 && <Sparkline values={trend} width={96} height={32} color={SIDE_COLOR[side]} area ariaLabel={`Evolución del Elo de ${block.team.name}: de ${int(trend[0])} a ${int(trend[trend.length - 1])}`} />}
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Pts/partido (5)" value={num(block.ppg5, 2)} />
        <Stat label="Pts/partido (10)" value={num(block.ppg10, 2)} />
        <Stat label="Goles a favor (5)" value={num(block.gf5, 2)} />
        <Stat label="Goles en contra (5)" value={num(block.ga5, 2)} />
      </dl>
      {split && split.played > 0 && (
        <div className="mt-3 rounded-lg border border-line bg-surface-2/60 px-3 py-2.5">
          <div className="eyebrow mb-1">{side === 'home' ? 'Como local' : 'Como visitante'} esta temporada</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-2">
            <span>
              <span className="num font-semibold text-ink-1">{int(split.played)}</span> PJ
            </span>
            <span>
              <span className="num font-semibold text-ink-1">{num(split.ppg, 2)}</span> pts/p
            </span>
            <span>
              <span className="num font-semibold text-ink-1">{num(split.gf, 2)}</span> GF/p
            </span>
            <span>
              <span className="num font-semibold text-ink-1">{num(split.ga, 2)}</span> GC/p
            </span>
          </div>
        </div>
      )}
      {last.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-3">
          <span>
            Últimos {last.length}: xG <span className="num text-ink-1">{xg(avg(last.map((m) => m.xg)))}</span> – <span className="num text-ink-1">{xg(avg(last.map((m) => m.xga)))}</span>
          </span>
          <span>
            Tiros <span className="num text-ink-1">{num(avg(last.map((m) => m.shots)), 1)}</span>
          </span>
          <span>
            Córners <span className="num text-ink-1">{num(avg(last.map((m) => m.corners)), 1)}</span>
          </span>
          <span>
            Tarjetas <span className="num text-ink-1">{num(avg(last.map((m) => m.cards)), 1)}</span>
          </span>
        </div>
      )}
      {(block.streaks?.length ?? 0) > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Rachas">
          {block.streaks.map((s, i) => (
            <li key={i} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] text-ink-1">
              <Flame className="h-3.5 w-3.5 text-accent-text" aria-hidden="true" />
              {s}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function lastColumns(): Column<FormMatch>[] {
  return [
    {
      key: 'opponent',
      header: 'Rival',
      sticky: true,
      sortValue: (r) => r.opponent.name,
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="w-4 shrink-0 text-center text-2xs font-semibold text-ink-3" title={r.isHome ? 'En casa' : 'Fuera'}>
            {r.isHome ? 'C' : 'F'}
            <span className="sr-only">{r.isHome ? ' (en casa)' : ' (fuera)'}</span>
          </span>
          <TeamCrest team={r.opponent} size={18} />
          <span className="max-w-[140px] truncate font-medium text-ink-1 sm:max-w-[200px]" title={r.opponent.name}>
            {r.opponent.short || r.opponent.name}
          </span>
        </span>
      ),
    },
    {
      key: 'result',
      header: 'Res.',
      title: 'Resultado',
      align: 'center',
      sortValue: (r) => (r.result === 'W' ? 3 : r.result === 'D' ? 1 : 0),
      cell: (r) => {
        const href = formMatchHref(r);
        const inner = (
          <>
            <OutcomeChip outcome={r.result} size="sm" />
            <span className="num font-semibold text-ink-1">
              {r.gf}-{r.ga}
            </span>
          </>
        );
        return href ? (
          <Link to={href} className="inline-flex items-center gap-2 hover:underline" title="Ver el análisis del partido">
            {inner}
          </Link>
        ) : (
          <span className="inline-flex items-center gap-2">{inner}</span>
        );
      },
      className: 'whitespace-nowrap',
    },
    {
      key: 'date',
      header: 'Fecha',
      sortValue: (r) => new Date(r.date).getTime(),
      firstDir: 'desc',
      cell: (r) => (
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span className="num text-[12.5px] text-ink-2">{shortDate(r.date)}</span>
          <CompetitionBadge compId={r.compId} className="!text-2xs !font-medium" />
        </span>
      ),
      className: 'whitespace-nowrap',
    },
    {
      key: 'xg',
      header: 'xG',
      title: 'Goles esperados a favor – en contra (modelo)',
      numeric: true,
      sortValue: (r) => r.xg,
      cell: (r) => (r.xg === undefined ? '—' : `${xg(r.xg)}–${xg(r.xga)}`),
    },
    { key: 'shots', header: 'Tiros', title: 'Tiros (a puerta)', numeric: true, sortValue: (r) => r.shots, cell: (r) => (r.shots === undefined ? '—' : `${r.shots} (${r.shotsOnTarget ?? '—'})`) },
    {
      key: 'corners',
      header: 'Córn.',
      title: 'Córners a favor – en contra',
      numeric: true,
      sortValue: (r) => r.corners,
      cell: (r) => (r.corners === undefined ? '—' : `${r.corners}–${r.cornersAgainst ?? '—'}`),
    },
    { key: 'cards', header: 'Tarj.', title: 'Tarjetas recibidas', numeric: true, sortValue: (r) => r.cards, cell: (r) => r.cards ?? '—' },
    {
      key: 'poss',
      header: 'Pos.',
      title: 'Posesión',
      numeric: true,
      hideBelow: 'md',
      sortValue: (r) => asShare(r.possession),
      cell: (r) => (r.possession === undefined ? '—' : `${Math.round((asShare(r.possession) ?? 0) * 100)}%`),
    },
  ];
}

function LastTable({ block, side }: { block: TeamFormBlock; side: 'home' | 'away' }) {
  const rows = block.last ?? [];
  return (
    <section aria-labelledby={`last-${side}`} className="min-w-0">
      <h3 id={`last-${side}`} className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-ink-1">
        <TeamTag team={block.team} side={side} size={18} full />
        {rows.length > 0 && <span className="text-ink-3">· últimos {rows.length}</span>}
      </h3>
      {rows.length ? (
        <DataTable
          caption={`Últimos ${rows.length} partidos de ${block.team.name}`}
          columns={lastColumns()}
          rows={rows}
          rowKey={(r, i) => `${r.matchId}-${i}`}
          rowHref={formMatchHref}
          initialSort={{ key: 'date', dir: 'desc' }}
          dense
        />
      ) : (
        <EmptyState compact icon={<History />} title="Sin partidos recientes" />
      )}
    </section>
  );
}

function EloPanel({ home, away, match }: { home: TeamFormBlock; away: TeamFormBlock; match: MatchSummary }) {
  const toSeries = (b: TeamFormBlock) => {
    const t = b.eloTrend ?? [];
    return t.map((y, i) => ({ x: i - (t.length - 1), y }));
  };
  if ((home.eloTrend?.length ?? 0) < 2 && (away.eloTrend?.length ?? 0) < 2) return null;
  return (
    <Panel title="Evolución del Elo" icon={<TrendingUp />} description="Rating Elo tras cada uno de los últimos partidos (0 = actual).">
      <LineChart
        series={[
          { id: 'home', label: match.home.short || match.home.name, points: toSeries(home), color: SIDE_COLOR.home },
          { id: 'away', label: match.away.short || match.away.name, points: toSeries(away), color: SIDE_COLOR.away },
        ]}
        height={170}
        yFormat={(v) => num(v, 0)}
        xFormat={(x) => (x === 0 ? 'Actual' : `${x}`)}
        ariaLabel={`Evolución del Elo de ${match.home.name} (${int(home.elo)}) y ${match.away.name} (${int(away.elo)})`}
      />
    </Panel>
  );
}

export function FormTab({ file, match }: TabProps) {
  const home = file.form?.home;
  const away = file.form?.away;
  if (!home || !away) {
    return <EmptyState icon={<Activity />} title="Sin datos de forma" description="No hay partidos recientes suficientes para calcular la forma." />;
  }
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <SummaryCard block={home} side="home" />
        <SummaryCard block={away} side="away" />
      </div>
      <EloPanel home={home} away={away} match={match} />
      <Panel title="Últimos 10 partidos" icon={<History />} description="C = en casa, F = fuera. xG del modelo (a favor–en contra), tiros (a puerta), córners (a favor–en contra) y tarjetas recibidas.">
        <div className="grid gap-6 2xl:grid-cols-2">
          <LastTable block={home} side="home" />
          <LastTable block={away} side="away" />
        </div>
      </Panel>
    </div>
  );
}
