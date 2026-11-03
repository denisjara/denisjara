import { useEffect, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Activity, BarChart3, CalendarClock, CalendarDays, Clock, LayoutDashboard, ListOrdered, Shield, TrendingUp, Users } from 'lucide-react';
import type { TeamFile } from '../../../types/data';
import {
  Card,
  Disclaimer,
  cx,
  EmptyState,
  ErrorState,
  Heatmap,
  LineChart,
  MatchCard,
  PageSkeleton,
  SafeBlock,
  Section,
  TabPanel,
  Tabs,
  useUrlTab,
  type TabItem,
} from '../../components';
import { DataError, useCompetition, useMeta, useTeam } from '../../lib/data';
import { useLiveScores } from '../../lib/live';
import { int, num } from '../../lib/format';
import { MiniStandings } from '../competition/StandingsTable';
import { PlayersTable } from '../competition/PlayersTable';
import { HotPlayersList, Note, PERIOD_LABELS, avg, ordinal } from '../competition/shared';
import { FormBlock, HomeAwayBars, dayMonth, OutcomeRates, SeasonMatchesTable, SeasonSummary, SplitTable, TeamHeader, standingWindow } from './parts';

const ALL_TABS = ['resumen', 'estadisticas', 'partidos', 'plantilla'] as const;
type TabId = (typeof ALL_TABS)[number];

function availableTabs(d: TeamFile | undefined): TabId[] {
  if (!d) return ['resumen'];
  return ALL_TABS.filter((t) => (t === 'partidos' ? d.matches.length > 0 : t === 'plantilla' ? d.players.length > 0 : true));
}

export default function TeamPage() {
  const { teamId } = useParams();
  const { data, error, loading, reload } = useTeam(teamId);
  const { data: meta } = useMeta();
  const { data: comp } = useCompetition(data?.primaryCompId);
  const tabIds = useMemo(() => availableTabs(data), [data]);
  const [tab, setTab] = useUrlTab<TabId>(tabIds, 'resumen');
  const live = useLiveScores(data?.upcoming);

  const metaById = useMemo(() => new Map((meta?.competitions ?? []).map((c) => [c.id, c])), [meta]);
  const primaryMeta = data ? metaById.get(data.primaryCompId) ?? comp?.meta : undefined;

  const pageTitle = data?.team.name;
  useEffect(() => {
    if (!pageTitle) return;
    const prev = document.title;
    document.title = `${pageTitle} · FutStat Lab`;
    return () => {
      document.title = prev;
    };
  }, [pageTitle]);

  if (loading && !data) return <PageSkeleton cards={4} />;
  if (error || !data) {
    if (error instanceof DataError && error.notFound) {
      const idx = meta?.teams.find((t) => t.id === teamId);
      return (
        <div className="space-y-6">
          <h1 className="sr-only">{idx ? idx.name : 'Equipo no disponible'}</h1>
          <EmptyState
            icon={<Shield />}
            title={idx ? `${idx.name}: ficha no disponible` : 'Equipo no disponible'}
            description="Todavía no hemos publicado el análisis detallado de este equipo. Los datos se actualizan cada día."
            action={
              <Link to={idx ? `/c/${idx.compId}` : '/'} className="btn">
                {idx ? 'Ver su competición' : 'Volver al inicio'}
              </Link>
            }
          />
        </div>
      );
    }
    return <ErrorState error={error} onRetry={reload} />;
  }

  const { team, stats } = data;
  const la = comp?.leagueAverages;
  const rating = comp?.ratings.find((r) => r.team.id === team.id);
  const leagueAvgElo = comp?.ratings.length ? avg(comp.ratings.map((r) => r.elo)) : undefined;
  const group = comp?.standings.find((g) => g.rows.some((r) => r.team.id === team.id));
  const eloPoints = (data.eloHistory ?? []).map((h) => ({ x: h.date, y: h.elo }));
  const recent = [...(data.form.last ?? [])].reverse().filter((m) => typeof m.xg === 'number' && typeof m.xga === 'number');
  const xgSeries =
    recent.length >= 3
      ? [
          { id: 'xg', label: 'xG a favor', points: recent.map((m) => ({ x: m.date, y: m.xg! })) },
          { id: 'xga', label: 'xG en contra', points: recent.map((m) => ({ x: m.date, y: m.xga! })) },
        ]
      : null;
  const periods = stats.goalsByPeriod?.length || stats.concededByPeriod?.length ? [stats.goalsByPeriod ?? [], stats.concededByPeriod ?? []] : null;

  const TAB_META: Record<TabId, Omit<TabItem<TabId>, 'id'>> = {
    resumen: { label: 'Resumen', icon: <LayoutDashboard /> },
    estadisticas: { label: 'Estadísticas', icon: <BarChart3 /> },
    partidos: { label: 'Partidos', icon: <CalendarDays />, badge: data.matches.length || undefined },
    plantilla: { label: 'Plantilla', icon: <Users />, badge: data.players.length || undefined },
  };
  const tabs: TabItem<TabId>[] = tabIds.map((id) => ({ id, ...TAB_META[id] }));

  return (
    <div className="space-y-6">
      <SafeBlock label="Cabecera del equipo">
        <TeamHeader data={data} primaryMeta={primaryMeta} leagueEloRank={rating?.eloRank}>
          <Tabs idBase="team" value={tab} onChange={setTab} tabs={tabs} ariaLabel={`Secciones de ${team.name}`} />
        </TeamHeader>
      </SafeBlock>

      <TabPanel idBase="team" id="resumen" active={tab}>
        <div className="space-y-10">
          <Section id="team-upcoming" eyebrow="Próximos 14 días" title="Próximos partidos" icon={<CalendarClock />} description="Predicción del modelo frente al mercado para cada partido.">
            {data.upcoming.length ? (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {data.upcoming.map((m, i) => (
                  <MatchCard key={m.id} match={m} live={live[m.id]} delay={i * 40} />
                ))}
              </div>
            ) : (
              <EmptyState compact icon={<CalendarClock />} title="Sin partidos próximos" description="No tiene partidos programados en los próximos 14 días." />
            )}
          </Section>

          <Section id="team-form" eyebrow="Estado de forma" title="Forma reciente" icon={<Activity />}>
            <FormBlock data={data} />
          </Section>

          <div className="grid grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] xl:gap-6">
            <Section
              id="team-elo"
              eyebrow="Rating"
              title="Evolución Elo"
              icon={<TrendingUp />}
              description={`Elo actual ${int(data.elo)}${data.globalEloRank ? ` · ${ordinal(data.globalEloRank)} del ranking global` : ''}${rating ? ` · ${ordinal(rating.eloRank)} de ${primaryMeta?.shortName ?? 'su liga'}` : ''}.`}
            >
              <Card>
                {eloPoints.length >= 2 ? (
                  <LineChart
                    series={[{ id: 'elo', label: 'Elo', points: eloPoints }]}
                    area
                    height={220}
                    yFormat={(v) => num(v, 0)}
                    xFormat={dayMonth}
                    refLines={leagueAvgElo ? [{ y: leagueAvgElo, label: `Media ${primaryMeta?.shortName ?? 'liga'} ${int(leagueAvgElo)}` }] : undefined}
                    ariaLabel={`Evolución del Elo de ${team.name}: de ${int(eloPoints[0].y)} a ${int(eloPoints[eloPoints.length - 1].y)}`}
                  />
                ) : (
                  <p className="text-[13px] text-ink-3">Sin historial suficiente.</p>
                )}
              </Card>
            </Section>
            {group ? (
              <Section
                id="team-table"
                eyebrow={primaryMeta?.name ?? 'Clasificación'}
                title="Su zona de la tabla"
                icon={<ListOrdered />}
                action={
                  <Link to={`/c/${data.primaryCompId}?tab=clasificacion`} className="btn-ghost -mr-2">
                    Completa
                  </Link>
                }
              >
                <MiniStandings group={{ name: group.name, rows: standingWindow(group.rows, team.id, 3) }} limit={7} highlightTeamId={team.id} />
              </Section>
            ) : (
              <Section id="team-players-hot" eyebrow="Plantilla" title="Jugadores en forma" icon={<Users />}>
                <HotPlayersList players={data.players} limit={6} showTeam={false} />
              </Section>
            )}
          </div>

          <div className={cx('grid grid-cols-1 gap-10 xl:gap-6', group && data.players.length > 0 && xgSeries && 'xl:grid-cols-2')}>
            {xgSeries && (
              <Section id="team-xg" eyebrow="Últimos partidos" title="Ocasiones a favor y en contra" icon={<Activity />} description="Goles esperados (xG) generados y concedidos en cada partido reciente.">
                <Card>
                  <LineChart series={xgSeries} height={200} yFormat={(v) => num(v, 1)} xFormat={dayMonth} ariaLabel={`xG a favor y en contra de ${team.name} en los últimos partidos`} />
                </Card>
              </Section>
            )}
            {group && data.players.length > 0 && (
              <Section id="team-players-hot" eyebrow="Plantilla" title="Jugadores en forma" icon={<Users />} description="Índice 0-100 y notas de los últimos 5 partidos.">
                <HotPlayersList players={data.players} limit={6} showTeam={false} />
              </Section>
            )}
          </div>
        </div>
      </TabPanel>

      <TabPanel idBase="team" id="estadisticas" active={tab}>
        <div className="space-y-10">
          <Section
            id="team-split"
            eyebrow={primaryMeta ? `${primaryMeta.name} · por partido` : 'Por partido'}
            title="Estadísticas en casa y fuera"
            icon={<BarChart3 />}
            description="Goles, xG, tiros, córners, tarjetas, faltas y posesión del equipo en su liga."
          >
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <HomeAwayBars stats={stats} la={la} />
              <SplitTable stats={stats} la={la} leagueName={primaryMeta?.name} />
            </div>
          </Section>
          <div className="grid grid-cols-1 gap-10 xl:grid-cols-2 xl:gap-6">
            <Section id="team-rates" eyebrow="Resultados y goles" title="Tendencias" icon={<Activity />}>
              <OutcomeRates stats={stats} />
            </Section>
            <Section id="team-periods" eyebrow="Tramos de 15 minutos" title="Cuándo marca y encaja" icon={<Clock />}>
              {periods ? (
                <Card pad="sm" className="overflow-hidden">
                  <Heatmap
                    rows={['A favor', 'En contra']}
                    cols={PERIOD_LABELS.map((l) => `${l}'`)}
                    values={periods.map((arr) => PERIOD_LABELS.map((_, i) => arr[i] ?? 0))}
                    caption={`Goles de ${team.name} por tramo de minutos`}
                    rowTitle="Goles"
                    colTitle="Minuto"
                    format={(x) => int(x)}
                    minLabel={0.5}
                    cellSize={50}
                    rowLabelWidth={76}
                    describe={(r, c, x) => `${x} ${x === 1 ? 'gol' : 'goles'} ${r === 0 ? 'a favor' : 'en contra'} entre los minutos ${PERIOD_LABELS[c]}`}
                  />
                  <Note>Recuento de goles de la temporada en liga por tramo de minutos.</Note>
                </Card>
              ) : (
                <EmptyState compact icon={<Clock />} title="Sin datos por minuto" />
              )}
            </Section>
          </div>
        </div>
      </TabPanel>

      <TabPanel idBase="team" id="partidos" active={tab}>
        <Section
          id="team-season"
          eyebrow="Temporada"
          title="Todos los partidos"
          icon={<CalendarDays />}
          description="Resultados de la temporada en todas las competiciones con goles, goles esperados (xG), tiros, córners, tarjetas, faltas y posesión."
        >
          <div className="space-y-4">
            <SeasonSummary matches={data.matches} />
            <SeasonMatchesTable matches={data.matches} metaById={metaById} />
            <Note>Tiros entre paréntesis: a puerta. Córners: a favor / en contra. xG y xGC: goles esperados del modelo para el equipo y para el rival.</Note>
          </div>
        </Section>
      </TabPanel>

      <TabPanel idBase="team" id="plantilla" active={tab}>
        <Section id="team-squad" eyebrow="Estado de forma diario" title="Plantilla" icon={<Users />} description="Jugadores con minutos esta temporada: forma, goles, asistencias, tiros, tarjetas y faltas.">
          <PlayersTable players={data.players} showTeam={false} caption={`Plantilla de ${team.name}`} maxHeight={720} />
        </Section>
      </TabPanel>

      <Disclaimer />
    </div>
  );
}
