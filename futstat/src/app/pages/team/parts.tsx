/** Piezas de la ficha de equipo (componentes locales de página). */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Home, Plane } from 'lucide-react';
import type { CompetitionMeta, FormMatch, LeagueAverages, SplitStat, StandingRow, TeamFile, TeamSeasonStats } from '../../../types/data';
import { Card, CompetitionBadge, DataTable, FormChips, Meter, OutcomeChip, Sparkline, StatCompareBar, TeamCrest, cx, formMatchHref, type Column, type StatFormat } from '../../components';
import { SIDE_COLOR, deltaClass, teamColor, token } from '../../lib/colors';
import { int, num, pct, shortDate, signed, xg as fmtXg } from '../../lib/format';
import { noteColor, ordinal } from '../competition/shared';

// ---------------------------------------------------------------------------
// Cabecera
// ---------------------------------------------------------------------------
function HeaderKpi({ label, value, hint, children, className }: { label: string; value?: ReactNode; hint?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx('min-w-0 rounded-lg border border-line bg-surface-2/80 px-3 py-2', className)}>
      <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</div>
      {value !== undefined && <div className="font-display text-[22px] font-extrabold leading-tight text-ink-1">{value}</div>}
      {children}
      {hint && <div className="truncate text-2xs text-ink-3">{hint}</div>}
    </div>
  );
}

export interface TeamHeaderProps {
  data: TeamFile;
  primaryMeta?: CompetitionMeta;
  /** posición en el ranking Elo de su liga */
  leagueEloRank?: number;
  children?: ReactNode;
}

/** Cabecera (h1) del equipo: escudo, color, competiciones, Elo, ranking global, posición y forma. */
export function TeamHeader({ data, primaryMeta, leagueEloRank, children }: TeamHeaderProps) {
  const { team, standing, form, stats } = data;
  const color = teamColor(team);
  const eloSeries = (data.eloHistory?.length ? data.eloHistory.map((h) => h.elo) : form.eloTrend) ?? [];
  const eloDelta = eloSeries.length >= 2 ? eloSeries[eloSeries.length - 1] - eloSeries[0] : undefined;
  const subtitle = [
    standing && primaryMeta ? `${ordinal(standing.rank)} en ${primaryMeta.name}` : null,
    standing ? `${int(standing.points)} pts en ${int(standing.played)} partidos` : null,
    stats ? `${pct(stats.winPct)} de victorias` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <header className="relative overflow-hidden rounded-card border border-line bg-surface-1/80">
      <div className="pitch-lines pointer-events-none absolute inset-0 opacity-[0.05]" aria-hidden="true" />
      <div className="pointer-events-none absolute -left-24 -top-24 h-64 w-64 rounded-full opacity-25 blur-3xl" style={{ background: color }} aria-hidden="true" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px]" style={{ background: color }} aria-hidden="true" />
      <div className="relative flex flex-wrap items-center gap-4 px-4 pb-4 pt-5 sm:px-6">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-line bg-surface-2 sm:h-[76px] sm:w-[76px]">
          <TeamCrest team={team} size={48} alt={`Escudo de ${team.name}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="eyebrow flex flex-wrap items-center gap-x-3 gap-y-1">
            {data.competitions.map((c) => (
              <CompetitionBadge key={c} compId={c} link className="text-2xs uppercase tracking-[0.12em] text-accent-text hover:text-ink-1" />
            ))}
          </div>
          <h1 className="display mt-1 truncate text-[36px] text-ink-1 sm:text-[48px]">{team.name}</h1>
          {subtitle && <p className="mt-1 text-[13px] text-ink-2">{subtitle}</p>}
        </div>
      </div>
      <div className="relative grid grid-cols-2 gap-2 px-4 pb-4 sm:grid-cols-3 sm:px-6 lg:grid-cols-5">
        <HeaderKpi label="Elo" hint={eloDelta !== undefined ? <span className={deltaClass(eloDelta, 0.5)}>{signed(eloDelta, 0)} en el periodo</span> : undefined}>
          <div className="flex items-end justify-between gap-2">
            <span className="font-display text-[22px] font-extrabold leading-tight text-ink-1">{int(data.elo)}</span>
            <Sparkline values={eloSeries} width={64} height={22} ariaLabel={`Evolución reciente del Elo de ${team.name}`} />
          </div>
        </HeaderKpi>
        <HeaderKpi label="Ranking Elo global" value={data.globalEloRank ? ordinal(data.globalEloRank) : '—'} hint={leagueEloRank ? `${ordinal(leagueEloRank)} de su liga` : 'Todas las competiciones'} />
        <HeaderKpi
          label="Posición"
          value={standing ? ordinal(standing.rank) : '—'}
          hint={
            standing?.note?.label ? (
              <span className="inline-flex items-center gap-1">
                <span className="h-2.5 w-[3px] rounded-full" style={{ background: noteColor(standing.note) }} aria-hidden="true" />
                {standing.note.label}
              </span>
            ) : (
              primaryMeta?.shortName
            )
          }
        />
        <HeaderKpi
          label="Puntos"
          value={standing ? int(standing.points) : '—'}
          hint={standing && typeof standing.xPts === 'number' ? `xPts ${num(standing.xPts, 1)} (${signed(standing.points - standing.xPts, 1)})` : undefined}
        />
        <HeaderKpi label="Forma" className="col-span-2 sm:col-span-1" hint={`Índice ${int(form.formIndex)}/100 · ${num(form.ppg5, 2)} pts/p.`}>
          <div className="py-1">
            <FormChips form={form.formString} size="sm" />
          </div>
        </HeaderKpi>
      </div>
      {children && <div className="relative px-2 sm:px-4">{children}</div>}
    </header>
  );
}

/** Fecha compacta "27 sept". */
export function dayMonth(d: string | number): string {
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? '' : `${x.getDate()} ${new Intl.DateTimeFormat('es-ES', { month: 'short' }).format(x).replace('.', '')}`;
}

// ---------------------------------------------------------------------------
// Forma: últimos 10
// ---------------------------------------------------------------------------
function FormTile({ m }: { m: FormMatch }) {
  const hasStats = m.shots !== undefined || m.corners !== undefined || m.cards !== undefined;
  const href = formMatchHref(m);
  const score = (
    <>
      <OutcomeChip outcome={m.result} size="sm" />
      <span className="font-display text-[20px] font-extrabold leading-none text-ink-1">
        {m.gf}-{m.ga}
      </span>
    </>
  );
  return (
    <li className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-line bg-surface-2/60 p-2.5">
      <div className="flex items-center justify-between gap-1 text-2xs text-ink-3">
        <span className="truncate" title={shortDate(m.date)}>
          {dayMonth(m.date)}
        </span>
        <span title={m.isHome ? 'En casa' : 'Fuera'} aria-label={m.isHome ? 'En casa' : 'Fuera'}>
          {m.isHome ? <Home className="h-3.5 w-3.5" aria-hidden="true" /> : <Plane className="h-3.5 w-3.5" aria-hidden="true" />}
        </span>
      </div>
      <Link to={`/t/${m.opponent.id}`} className="flex min-w-0 items-center gap-1.5 hover:underline" title={m.opponent.name}>
        <TeamCrest team={m.opponent} size={18} />
        <span className="truncate text-[12.5px] font-semibold text-ink-1">{m.opponent.short || m.opponent.name}</span>
      </Link>
      {href ? (
        <Link to={href} className="flex items-center gap-2 rounded hover:underline" title="Ver el análisis del partido">
          {score}
        </Link>
      ) : (
        <div className="flex items-center gap-2">{score}</div>
      )}
      {(m.xg !== undefined || m.xga !== undefined) && (
        <div className="num whitespace-nowrap text-2xs text-ink-2" title="Goles esperados a favor–en contra">
          xG {fmtXg(m.xg)}–{fmtXg(m.xga)}
        </div>
      )}
      {hasStats && (
        <dl className="grid grid-cols-3 gap-1 border-t border-line pt-1.5 text-center">
          <div title="Tiros (a puerta)">
            <dt className="text-[9.5px] font-semibold uppercase text-ink-3">Tir</dt>
            <dd className="num text-[11.5px] text-ink-1">{m.shots ?? '—'}</dd>
          </div>
          <div title="Córners a favor">
            <dt className="text-[9.5px] font-semibold uppercase text-ink-3">Cór</dt>
            <dd className="num text-[11.5px] text-ink-1">{m.corners ?? '—'}</dd>
          </div>
          <div title="Tarjetas recibidas">
            <dt className="text-[9.5px] font-semibold uppercase text-ink-3">Tar</dt>
            <dd className="num text-[11.5px] text-ink-1">{m.cards ?? '—'}</dd>
          </div>
        </dl>
      )}
    </li>
  );
}

function FormStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</div>
      <div className="font-display text-[24px] font-extrabold leading-tight text-ink-1">{value}</div>
      {hint && <div className="text-2xs text-ink-3">{hint}</div>}
    </div>
  );
}

/** Bloque de forma: KPIs (pts/partido, goles, índice), rachas y los últimos 10 partidos (más reciente a la derecha). */
export function FormBlock({ data }: { data: TeamFile }) {
  const { form } = data;
  const last = [...(form.last ?? [])].reverse(); // cronológico: más reciente a la derecha
  return (
    <Card className="space-y-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.6fr)]">
        <FormStat label="Pts/partido (5)" value={num(form.ppg5, 2)} hint={`Últimos 10: ${num(form.ppg10, 2)}`} />
        <FormStat label="Goles (5)" value={`${num(form.gf5, 1)}–${num(form.ga5, 1)}`} hint="A favor–en contra por partido" />
        <FormStat label="Índice de forma" value={`${int(form.formIndex)}`} hint="De 0 a 100" />
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Últimos 5</div>
          <div className="mt-1.5">
            <FormChips form={form.formString} size="md" />
          </div>
        </div>
        <div className="col-span-2 min-w-0 sm:col-span-4 lg:col-span-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Rachas</div>
          {form.streaks?.length ? (
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {form.streaks.map((s) => (
                <li key={s} className="chip text-[12px] text-ink-1">
                  {s}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-[12px] text-ink-3">Sin rachas destacadas ahora mismo.</p>
          )}
        </div>
      </div>
      {last.length > 0 && (
        <div>
          <h3 className="eyebrow mb-2">Últimos {last.length} partidos · el más reciente a la derecha</h3>
          <ol className="scrollbar-none grid auto-cols-[minmax(118px,1fr)] grid-flow-col lg:auto-cols-[minmax(100px,1fr)] gap-2 overflow-x-auto pb-1" aria-label="Últimos partidos en orden cronológico">
            {last.map((m) => (
              <FormTile key={m.matchId} m={m} />
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Casa / fuera
// ---------------------------------------------------------------------------
type SplitRow = { key: string; label: string; s: SplitStat; better: 'high' | 'low'; format: StatFormat; league?: number; suffix?: string };

export function splitRows(stats: TeamSeasonStats, la?: LeagueAverages): SplitRow[] {
  const half = (x: number | undefined) => (typeof x === 'number' ? x / 2 : undefined);
  return [
    { key: 'gf', label: 'Goles a favor', s: stats.goalsFor, better: 'high', format: 'dec2', league: half(la?.goalsPerMatch) },
    { key: 'ga', label: 'Goles en contra', s: stats.goalsAgainst, better: 'low', format: 'dec2', league: half(la?.goalsPerMatch) },
    { key: 'xg', label: 'xG a favor', s: stats.xgFor, better: 'high', format: 'dec2' },
    { key: 'xga', label: 'xG en contra', s: stats.xgAgainst, better: 'low', format: 'dec2' },
    { key: 'shots', label: 'Tiros', s: stats.shots, better: 'high', format: 'dec1', league: half(la?.shotsPerMatch) },
    { key: 'sot', label: 'Tiros a puerta', s: stats.shotsOnTarget, better: 'high', format: 'dec1', league: half(la?.shotsOnTargetPerMatch) },
    { key: 'shotsA', label: 'Tiros concedidos', s: stats.shotsAgainst, better: 'low', format: 'dec1', league: half(la?.shotsPerMatch) },
    { key: 'corners', label: 'Córners a favor', s: stats.corners, better: 'high', format: 'dec1', league: half(la?.cornersPerMatch) },
    { key: 'cornersA', label: 'Córners en contra', s: stats.cornersAgainst, better: 'low', format: 'dec1', league: half(la?.cornersPerMatch) },
    { key: 'cards', label: 'Tarjetas', s: stats.cards, better: 'low', format: 'dec2', league: half(la?.cardsPerMatch) },
    { key: 'fouls', label: 'Faltas', s: stats.fouls, better: 'low', format: 'dec1', league: half(la?.foulsPerMatch) },
    { key: 'poss', label: 'Posesión', s: stats.possession, better: 'high', format: 'dec1', league: 50, suffix: '%' },
  ];
}

/** Barras enfrentadas Casa (azul, local) vs Fuera (naranja, visitante) con la media de la liga como contexto. */
export function HomeAwayBars({ stats, la }: { stats: TeamSeasonStats; la?: LeagueAverages }) {
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-[17px] font-bold uppercase tracking-wide text-ink-1">Casa vs fuera</h3>
        <ul className="flex items-center gap-4 text-[12px] text-ink-2" aria-label="Leyenda">
          <li className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: SIDE_COLOR.home }} aria-hidden="true" />
            En casa ({int(stats.played.home)} PJ)
          </li>
          <li className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: SIDE_COLOR.away }} aria-hidden="true" />
            Fuera ({int(stats.played.away)} PJ)
          </li>
        </ul>
      </div>
      <div className="space-y-3.5">
        {splitRows(stats, la).map((r) => (
          <StatCompareBar key={r.key} label={r.label} home={r.s.home} away={r.s.away} better={r.better} format={r.format} leagueAvg={r.key === 'poss' ? undefined : r.league} />
        ))}
      </div>
      <p className="mt-3 text-[12px] text-ink-3">Medias por partido. En negrita y color pleno, el lado mejor en cada métrica; entre paréntesis, la media de un equipo de la liga.</p>
    </Card>
  );
}

/** Tabla Total / Casa / Fuera / Media liga. */
export function SplitTable({ stats, la, leagueName }: { stats: TeamSeasonStats; la?: LeagueAverages; leagueName?: string }) {
  const rows = splitRows(stats, la);
  const fmt = (r: SplitRow, v: number | undefined) =>
    typeof v !== 'number' ? '—' : `${r.format === 'dec2' ? num(v, 2) : num(v, 1)}${r.suffix ?? ''}`;
  const cols: Column<SplitRow>[] = [
    { key: 'label', header: 'Métrica', sticky: true, cell: (r) => <span className="font-medium text-ink-1">{r.label}</span>, className: 'min-w-[140px]' },
    { key: 'all', header: 'Total', numeric: true, cell: (r) => <span className="font-semibold text-ink-1">{fmt(r, r.s.all)}</span> },
    { key: 'home', header: 'Casa', numeric: true, cell: (r) => fmt(r, r.s.home) },
    { key: 'away', header: 'Fuera', numeric: true, cell: (r) => fmt(r, r.s.away) },
  ];
  if (la) {
    cols.push({
      key: 'league',
      header: 'Liga',
      title: `Media por equipo en ${leagueName ?? 'la liga'}`,
      numeric: true,
      cell: (r) => {
        if (typeof r.league !== 'number') return <span className="text-ink-3">–</span>;
        const d = r.s.all - r.league;
        const good = r.better === 'high' ? d : -d;
        return (
          <span className="inline-flex items-center justify-end gap-2">
            <span className="text-ink-2">{fmt(r, r.league)}</span>
            <span
              className={cx('w-12 text-2xs', deltaClass(good, r.league * 0.03))}
              title={good > r.league * 0.03 ? 'Mejor que la media' : good < -r.league * 0.03 ? 'Peor que la media' : 'En la media'}
            >
              {signed(d, r.format === 'dec2' ? 2 : 1)}
            </span>
          </span>
        );
      },
    });
  }
  return (
    <div className="self-start">
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.key} caption="Estadísticas por partido: total, en casa, fuera y media de la liga" dense />
      {la && <p className="mt-2 text-[12px] text-ink-3">Liga: media de un equipo por partido y diferencia del equipo (verde, mejor; rojo, peor).</p>}
    </div>
  );
}

/** Porcentajes de resultados y mercados de goles con medidores. */
export function OutcomeRates({ stats }: { stats: TeamSeasonStats }) {
  const items: { label: string; v: number; color?: string }[] = [
    { label: 'Victorias', v: stats.winPct, color: token('win') },
    { label: 'Empates', v: stats.drawPct, color: token('draw') },
    { label: 'Derrotas', v: stats.lossPct, color: token('loss') },
    { label: 'Más de 1,5 goles', v: stats.over15Pct },
    { label: 'Más de 2,5 goles', v: stats.over25Pct },
    { label: 'Más de 3,5 goles', v: stats.over35Pct },
    { label: 'Ambos marcan', v: stats.bttsPct },
    { label: 'Portería a cero', v: stats.cleanSheetPct },
    { label: 'Sin marcar', v: stats.failedToScorePct },
  ];
  return (
    <Card>
      <h3 className="mb-3 font-display text-[17px] font-bold uppercase tracking-wide text-ink-1">Porcentajes de la temporada</h3>
      <ul className="space-y-2.5">
        {items.map((i, idx) => (
          <li key={i.label} className={cx('grid grid-cols-[minmax(110px,150px)_minmax(0,1fr)_44px] items-center gap-3 text-[13px]', idx === 3 && 'border-t border-line pt-2.5')}>
            <span className="truncate text-ink-2">{i.label}</span>
            <Meter value={i.v} color={i.color ?? token('ink-2', 0.7)} height={6} label={`${i.label}: ${pct(i.v)}`} />
            <span className="num text-right font-semibold text-ink-1">{pct(i.v)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[12px] text-ink-3">Sobre {int(stats.played.all)} partidos de liga.</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Partidos de la temporada
// ---------------------------------------------------------------------------
export function SeasonMatchesTable({ matches, metaById }: { matches: FormMatch[]; metaById: Map<string, CompetitionMeta> }) {
  const cols: Column<FormMatch>[] = [
    {
      key: 'date',
      header: 'Partido',
      title: 'Fecha, competición y rival',
      sticky: true,
      sortValue: (m) => m.date,
      firstDir: 'desc',
      className: 'min-w-[170px] max-w-[240px]',
      cell: (m) => {
        const meta = metaById.get(m.compId);
        return (
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-ink-3" title={m.isHome ? 'En casa' : 'Fuera'}>
                {m.isHome ? <Home className="h-3.5 w-3.5" aria-label="En casa" /> : <Plane className="h-3.5 w-3.5" aria-label="Fuera" />}
              </span>
              <Link to={`/t/${m.opponent.id}`} className="flex min-w-0 items-center gap-2 hover:underline" title={m.opponent.name}>
                <TeamCrest team={m.opponent} size={18} />
                <span className="truncate font-medium text-ink-1">{m.opponent.short || m.opponent.name}</span>
              </Link>
            </span>
            <span className="flex items-center gap-1.5 whitespace-nowrap pl-[22px] text-2xs text-ink-3">
              <span className="capitalize">{shortDate(m.date)}</span>
              <span aria-hidden="true">·</span>
              <Link to={`/c/${m.compId}`} className="inline-flex items-center gap-1 hover:text-ink-1" title={meta?.name ?? m.compId}>
                <span aria-hidden="true">{meta?.flag ?? '⚽'}</span>
                {meta?.shortName ?? m.compId}
              </Link>
            </span>
          </span>
        );
      },
    },
    {
      key: 'res',
      header: 'Resultado',
      cell: (m) => {
        const href = formMatchHref(m);
        const inner = (
          <>
            <OutcomeChip outcome={m.result} size="xs" />
            <span className="num font-semibold text-ink-1">
              {m.gf}-{m.ga}
            </span>
          </>
        );
        return href ? (
          <Link to={href} className="inline-flex items-center gap-2 whitespace-nowrap hover:underline" title="Ver el análisis del partido">
            {inner}
          </Link>
        ) : (
          <span className="inline-flex items-center gap-2 whitespace-nowrap">{inner}</span>
        );
      },
      sortValue: (m) => m.gf - m.ga,
    },
    { key: 'xg', header: 'xG', title: 'Goles esperados a favor (modelo)', numeric: true, cell: (m) => fmtXg(m.xg), sortValue: (m) => m.xg },
    { key: 'xga', header: 'xGC', title: 'Goles esperados en contra (modelo)', numeric: true, cell: (m) => fmtXg(m.xga), sortValue: (m) => m.xga },
    {
      key: 'shots',
      header: 'Tiros',
      title: 'Tiros (a puerta)',
      numeric: true,
      cell: (m) =>
        m.shots === undefined ? (
          '—'
        ) : (
          <span>
            {m.shots}
            <span className="text-ink-3"> ({m.shotsOnTarget ?? '—'})</span>
          </span>
        ),
      sortValue: (m) => m.shots,
    },
    {
      key: 'corners',
      header: 'Córners',
      title: 'Córners a favor / en contra',
      numeric: true,
      cell: (m) =>
        m.corners === undefined ? (
          '—'
        ) : (
          <span>
            {m.corners}
            <span className="text-ink-3"> / {m.cornersAgainst ?? '—'}</span>
          </span>
        ),
      sortValue: (m) => m.corners,
    },
    { key: 'cards', header: 'Tarj.', title: 'Tarjetas recibidas', numeric: true, cell: (m) => m.cards ?? '—', sortValue: (m) => m.cards },
    { key: 'fouls', header: 'Faltas', title: 'Faltas cometidas', numeric: true, cell: (m) => m.fouls ?? '—', sortValue: (m) => m.fouls },
    { key: 'poss', header: 'Pos.', title: 'Posesión', numeric: true, cell: (m) => (typeof m.possession === 'number' ? `${num(m.possession, 0)}%` : '—'), sortValue: (m) => m.possession },
  ];
  return (
    <DataTable
      columns={cols}
      rows={matches}
      rowKey={(m, i) => `${m.matchId}-${i}`}
      rowHref={formMatchHref}
      caption="Todos los partidos de la temporada (los que tienen análisis publicado se pueden abrir)"
      initialSort={{ key: 'date', dir: 'desc' }}
      dense
    />
  );
}

/** Resumen de la temporada (PJ, V-E-D, goles vs xG). */
export function SeasonSummary({ matches }: { matches: FormMatch[] }) {
  const w = matches.filter((m) => m.result === 'W').length;
  const d = matches.filter((m) => m.result === 'D').length;
  const l = matches.filter((m) => m.result === 'L').length;
  const gf = matches.reduce((s, m) => s + m.gf, 0);
  const ga = matches.reduce((s, m) => s + m.ga, 0);
  const withXg = matches.filter((m) => typeof m.xg === 'number');
  const xgSum = withXg.reduce((s, m) => s + (m.xg ?? 0), 0);
  const gfXg = withXg.reduce((s, m) => s + m.gf, 0);
  const withXga = matches.filter((m) => typeof m.xga === 'number');
  const xgaSum = withXga.reduce((s, m) => s + (m.xga ?? 0), 0);
  const gaXga = withXga.reduce((s, m) => s + m.ga, 0);
  const cell = (label: string, value: ReactNode, hint?: ReactNode) => (
    <div className="min-w-0 rounded-lg border border-line bg-surface-2/70 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</div>
      <div className="font-display text-[22px] font-extrabold leading-tight text-ink-1">{value}</div>
      {hint && <div className="text-2xs text-ink-3">{hint}</div>}
    </div>
  );
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cell('Partidos', int(matches.length), 'Todas las competiciones')}
      {cell('V · E · D', `${w}·${d}·${l}`, `${pct(matches.length ? w / matches.length : 0)} de victorias`)}
      {cell('Goles', `${gf}–${ga}`, `${signed(gf - ga, 0)} de diferencia`)}
      {withXg.length > 0 &&
        cell(
          'Goles − xG',
          <span>{signed(gfXg - xgSum, 1)}</span>,
          <span>
            Encajados − xGC: <span className={deltaClass(xgaSum - gaXga, 0.5)}>{signed(gaXga - xgaSum, 1)}</span>
          </span>,
        )}
    </div>
  );
}

/** Contexto de clasificación: filas alrededor del equipo. */
export function standingWindow(rows: StandingRow[], teamId: string, radius = 3): StandingRow[] {
  const i = rows.findIndex((r) => r.team.id === teamId);
  if (i < 0) return rows.slice(0, radius * 2 + 1);
  const from = Math.max(0, Math.min(i - radius, rows.length - (radius * 2 + 1)));
  return rows.slice(from, from + radius * 2 + 1);
}
