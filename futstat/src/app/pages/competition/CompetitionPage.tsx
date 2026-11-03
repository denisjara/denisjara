import { useEffect, useMemo, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BarChart3, CalendarDays, Dices, FlaskConical, Gauge, LayoutDashboard, ListOrdered, Trophy, Users } from 'lucide-react';
import type { CompetitionFile, MatchSummary } from '../../../types/data';
import { CompetitionHeader, Disclaimer, cx, EmptyState, ErrorState, PageSkeleton, ProbBar1X2, SafeBlock, TabPanel, Tabs, useUrlTab, type TabItem } from '../../components';
import { DataError, useCompetition, useCompetitionMeta } from '../../lib/data';
import { useLiveScores, withLive } from '../../lib/live';
import { num, pct, PICK_LABEL, plural, timeAgo } from '../../lib/format';
import { nextMatchLabel } from '../../lib/competitions';
import { SIDE_COLOR } from '../../lib/colors';
import { OverviewTab } from './tabs/OverviewTab';
import { MatchesTab } from './tabs/MatchesTab';
import { StandingsTab } from './tabs/StandingsTab';
import { SimulationTab } from './tabs/SimulationTab';
import { TeamsTab } from './tabs/TeamsTab';
import { PlayersTab } from './tabs/PlayersTab';
import { RatingsTab } from './tabs/RatingsTab';
import { ModelTab } from './tabs/ModelTab';

const ALL_TABS = ['resumen', 'partidos', 'clasificacion', 'simulacion', 'equipos', 'jugadores', 'ratings', 'modelo'] as const;
type TabId = (typeof ALL_TABS)[number];

/** Pestañas con datos para esta competición (se ocultan las vacías). */
function availableTabs(d: CompetitionFile | undefined): TabId[] {
  if (!d) return ['resumen'];
  return ALL_TABS.filter((t) => {
    switch (t) {
      case 'clasificacion':
        return d.standings.length > 0;
      case 'simulacion':
        return d.simulations.length > 0;
      case 'equipos':
        return d.teams.length > 0;
      case 'jugadores':
        return d.players.length > 0;
      case 'ratings':
        return d.ratings.length > 0;
      case 'modelo':
        return !!d.backtest;
      default:
        return true;
    }
  });
}

/** Jornada en curso: la del próximo partido programado (o la del último resultado). */
function currentRound(d: CompetitionFile): string | undefined {
  return d.upcoming.find((m) => m.round)?.round ?? d.results.find((m) => m.round)?.round;
}

function Kpi({ label, short, value, title, className }: { label: string; short?: string; value: ReactNode; title?: string; className?: string }) {
  return (
    <div className={cx('min-w-0 rounded-lg border border-line bg-surface-2/80 px-3 py-2', className)} title={title}>
      <div className="truncate text-[10px] font-semibold uppercase tracking-normal text-ink-3 sm:tracking-wider">
        {short ? (
          <>
            <span className="sm:hidden">{short}</span>
            <span className="hidden sm:inline">{label}</span>
          </>
        ) : (
          label
        )}
      </div>
      <div className="font-display text-[22px] font-extrabold leading-tight text-ink-1">{value}</div>
    </div>
  );
}

/** Tira de KPIs de la competición: goles, 1X2, +2,5, ambos marcan, córners, tarjetas y tiros por partido. */
function LeagueKpis({ data }: { data: CompetitionFile }) {
  const la = data.leagueAverages;
  const p = { home: la.homeWinPct, draw: la.drawPct, away: la.awayWinPct };
  return (
    <div className="grid grid-cols-3 gap-2 px-2 pb-4 lg:grid-cols-6 xl:grid-cols-[repeat(6,minmax(0,1fr))_minmax(250px,1.9fr)]" aria-label="Medias de la competición por partido" role="group">
      <Kpi label="Goles/p." value={num(la.goalsPerMatch, 2)} title={`Local ${num(la.homeGoals, 2)} · Visitante ${num(la.awayGoals, 2)}`} />
      <Kpi label="+2,5 goles" value={pct(la.over25Pct)} title="Partidos con más de 2,5 goles" />
      <Kpi label="Ambos marcan" short="Ambos" value={pct(la.bttsPct)} title="Partidos en los que marcan los dos equipos" />
      <Kpi label="Córners/p." value={num(la.cornersPerMatch, 1)} title="Córners totales por partido" />
      <Kpi label="Tarjetas/p." value={num(la.cardsPerMatch, 1)} title="Tarjetas totales (amarillas + rojas) por partido" />
      <Kpi label="Tiros/p." value={num(la.shotsPerMatch, 1)} title={`Tiros totales por partido (${num(la.shotsOnTargetPerMatch, 1)} a puerta)`} />
      <div className="col-span-3 min-w-0 rounded-lg border border-line bg-surface-2/80 px-3 py-2 lg:col-span-6 xl:col-span-1">
        <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
          <span>Resultados</span>
          <span className="flex items-center gap-2.5 normal-case tracking-normal" aria-hidden="true">
            {(['home', 'draw', 'away'] as const).map((s) => (
              <span key={s} className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full" style={{ background: SIDE_COLOR[s] }} />
                {PICK_LABEL[s]}
              </span>
            ))}
          </span>
        </div>
        <ProbBar1X2 p={p} size="md" />
      </div>
    </div>
  );
}

export default function CompetitionPage() {
  const { compId } = useParams();
  const { data: rawData, error, loading, reload } = useCompetition(compId);
  // meta.json puede traer nextMatchDate aunque el archivo de la competición no lo tenga (o sea de una pasada anterior)
  const indexMeta = useCompetitionMeta(compId);
  const data = useMemo<CompetitionFile | undefined>(
    () =>
      rawData && !rawData.meta.nextMatchDate && indexMeta?.nextMatchDate
        ? { ...rawData, meta: { ...rawData.meta, nextMatchDate: indexMeta.nextMatchDate } }
        : rawData,
    [rawData, indexMeta],
  );
  const tabIds = useMemo(() => availableTabs(data), [data]);
  const [tab, setTab] = useUrlTab<TabId>(tabIds, 'resumen');

  // Marcadores en vivo (ESPN) sobre los partidos de hoy de la competición
  const candidates = useMemo<MatchSummary[]>(() => (data ? [...data.live, ...data.upcoming] : []), [data]);
  const scores = useLiveScores(candidates);
  const live = useMemo(() => {
    if (!data) return [];
    const merged = withLive(candidates, scores);
    const seen = new Set<string>();
    return merged.filter((m) => m.status === 'live' && !seen.has(m.id) && seen.add(m.id));
  }, [data, candidates, scores]);

  const pageTitle = data?.meta.name;
  useEffect(() => {
    if (!pageTitle) return;
    const prev = document.title;
    document.title = `${pageTitle} · FutStat Lab`;
    return () => {
      document.title = prev;
    };
  }, [pageTitle]);

  if (loading && !data) return <PageSkeleton />;
  if (error || !data) {
    if (error instanceof DataError && error.notFound) {
      return (
        <div className="space-y-6">
          <h1 className="sr-only">Competición no disponible</h1>
          <EmptyState
          icon={<Trophy />}
          title="Competición no disponible"
          description="No tenemos datos publicados para esta competición. Los datos se actualizan cada día."
          action={
            <Link to="/" className="btn">
              Volver al inicio
            </Link>
          }
          />
        </div>
      );
    }
    return <ErrorState error={error} onRetry={reload} />;
  }

  const { meta } = data;
  const round = currentRound(data);
  const hasLeagueData = data.results.length > 0 || meta.finishedCount > 0;
  const subtitle = [
    round,
    meta.finishedCount ? `${plural(meta.finishedCount, 'partido jugado', 'partidos jugados')}` : null,
    meta.upcomingCount ? `${plural(meta.upcomingCount, 'próximo', 'próximos')} en 14 días` : null,
    nextMatchLabel(meta) ? `Próximo partido: ${nextMatchLabel(meta)}` : null,
    `Actualizado ${timeAgo(data.meta.dataUpdatedAt ?? data.generatedAt)}`,
  ]
    .filter(Boolean)
    .join(' · ');

  const TAB_META: Record<TabId, Omit<TabItem<TabId>, 'id'>> = {
    resumen: { label: 'Resumen', icon: <LayoutDashboard /> },
    partidos: { label: 'Partidos', icon: <CalendarDays />, badge: data.upcoming.length || undefined },
    clasificacion: { label: 'Clasificación', icon: <ListOrdered /> },
    simulacion: { label: 'Simulación', icon: <Dices /> },
    equipos: { label: 'Equipos', icon: <BarChart3 /> },
    jugadores: { label: 'Jugadores', icon: <Users /> },
    ratings: { label: 'Ratings', icon: <Gauge /> },
    modelo: { label: 'Modelo', icon: <FlaskConical /> },
  };
  const tabs: TabItem<TabId>[] = tabIds.map((id) => ({ id, ...TAB_META[id] }));
  const goTo = (t: TabId) => {
    setTab(t);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="space-y-6">
      <SafeBlock label="Cabecera de la competición">
        <CompetitionHeader meta={meta} subtitle={subtitle}>
          {hasLeagueData && (
            <SafeBlock label="Medias de la competición">
              <LeagueKpis data={data} />
            </SafeBlock>
          )}
          <Tabs idBase="comp" value={tab} onChange={setTab} tabs={tabs} ariaLabel={`Secciones de ${meta.name}`} />
        </CompetitionHeader>
      </SafeBlock>

      <TabPanel idBase="comp" id="resumen" active={tab}>
        <OverviewTab data={data} live={live} liveScores={scores} goTo={goTo} />
      </TabPanel>
      <TabPanel idBase="comp" id="partidos" active={tab}>
        <MatchesTab data={data} live={live} liveScores={scores} />
      </TabPanel>
      <TabPanel idBase="comp" id="clasificacion" active={tab}>
        <StandingsTab data={data} />
      </TabPanel>
      <TabPanel idBase="comp" id="simulacion" active={tab}>
        <SimulationTab data={data} />
      </TabPanel>
      <TabPanel idBase="comp" id="equipos" active={tab}>
        <TeamsTab data={data} />
      </TabPanel>
      <TabPanel idBase="comp" id="jugadores" active={tab}>
        <PlayersTab data={data} />
      </TabPanel>
      <TabPanel idBase="comp" id="ratings" active={tab}>
        <RatingsTab data={data} />
      </TabPanel>
      <TabPanel idBase="comp" id="modelo" active={tab}>
        <ModelTab data={data} />
      </TabPanel>

      <Disclaimer />
    </div>
  );
}
