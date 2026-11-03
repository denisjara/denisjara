import { useEffect, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Activity, BarChart3, Brain, CalendarClock, ClipboardCheck, FileQuestion, History, Store, Swords, Users } from 'lucide-react';
import type { MatchSummary } from '../../../types/data';
import { Disclaimer, EmptyState, ErrorState, Skeleton, SkeletonCard, TabPanel, Tabs, useUrlTab, type TabItem } from '../../components';
import { DataError, useMatch } from '../../lib/data';
import { applyLive, useLiveScores } from '../../lib/live';
import { timeAgo } from '../../lib/format';
import { MatchHeader } from './MatchHeader';
import { AnalysisTab } from './AnalysisTab';
import { MarketsTab } from './MarketsTab';
import { StatsTab } from './StatsTab';
import { FormTab } from './FormTab';
import { H2HTab } from './H2HTab';
import { PlayersTab } from './PlayersTab';
import { ResultTab } from './ResultTab';

const TAB_IDS = ['analisis', 'mercados', 'estadisticas', 'forma', 'h2h', 'jugadores', 'resultado'] as const;
type TabId = (typeof TAB_IDS)[number];

/** Esqueleto con la forma de la página (marcador + pestañas + tarjetas). */
function MatchSkeleton() {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">Cargando el análisis del partido…</span>
      <div className="card overflow-hidden" aria-hidden="true">
        <div className="flex items-center justify-between border-b border-line/70 px-4 py-3 sm:px-6">
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3.5 w-52" />
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 py-7 sm:px-6">
          <div className="flex items-center gap-4">
            <Skeleton className="h-14 w-14 rounded-full" />
            <Skeleton className="h-7 w-40 max-w-full" />
          </div>
          <Skeleton className="h-14 w-28" />
          <div className="flex items-center justify-end gap-4">
            <Skeleton className="h-7 w-40 max-w-full" />
            <Skeleton className="h-14 w-14 rounded-full" />
          </div>
        </div>
        <div className="border-t border-line/70 px-4 py-4 sm:px-6">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="mt-3 h-3 w-2/3" />
        </div>
      </div>
      <div className="flex gap-3 border-b border-line pb-2.5" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-5 w-20" />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <SkeletonCard lines={7} />
        <SkeletonCard lines={5} />
      </div>
    </div>
  );
}

function NoAnalysis({ matchId }: { matchId?: string }) {
  return (
    <div className="space-y-6">
      <h1 className="sr-only">Partido sin análisis</h1>
      <EmptyState
        icon={<FileQuestion />}
        title="Partido sin análisis"
        description={
          <>
            Todavía no hemos publicado el análisis de este partido{matchId ? ` (ID ${matchId})` : ''}. Los análisis completos se generan cada día para los
            partidos de los próximos días y los jugados recientemente.
          </>
        }
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Link to="/partidos" className="btn">
              <CalendarClock className="h-4 w-4" aria-hidden="true" /> Ver calendario
            </Link>
            <Link to="/" className="btn-ghost">
              Ir al inicio
            </Link>
          </div>
        }
      />
    </div>
  );
}

export default function MatchPage() {
  const { matchId } = useParams();
  const { data, error, loading, reload } = useMatch(matchId);

  const liveInput = useMemo<MatchSummary[] | undefined>(() => (data ? [data.match] : undefined), [data]);
  const liveScores = useLiveScores(liveInput);
  const match = useMemo(() => (data ? applyLive(data.match, liveScores[data.match.id]) : undefined), [data, liveScores]);
  const finished = match?.status === 'finished';

  const [rawTab, setTab] = useUrlTab<TabId>(TAB_IDS, finished ? 'resultado' : 'analisis');
  const tab: TabId = rawTab === 'resultado' && !finished ? 'analisis' : rawTab;

  // Título del documento
  useEffect(() => {
    if (!match) return;
    const prev = document.title;
    document.title = `${match.home.short || match.home.name} – ${match.away.short || match.away.name} · Análisis · FutStat Lab`;
    return () => {
      document.title = prev;
    };
  }, [match]);

  if (loading && !data) return <MatchSkeleton />;
  if (error instanceof DataError && error.notFound) return <NoAnalysis matchId={matchId} />;
  if (error || !data || !match) return <ErrorState error={error} onRetry={reload} />;

  const file = data;
  const valueCount = file.valueBets?.length ?? 0;
  const marketCount = file.markets?.length ?? 0;
  const playersCount = (file.players?.home?.length ?? 0) + (file.players?.away?.length ?? 0);
  const tabs: TabItem<TabId>[] = [
    ...(finished ? [{ id: 'resultado' as const, label: 'Resultado', icon: <ClipboardCheck /> }] : []),
    { id: 'analisis', label: 'Análisis', icon: <Brain />, badge: valueCount > 0 ? `${valueCount} valor` : undefined },
    { id: 'mercados', label: 'Mercados', icon: <Store />, badge: marketCount || undefined },
    { id: 'estadisticas', label: 'Estadísticas', icon: <BarChart3 /> },
    { id: 'forma', label: 'Forma', icon: <Activity /> },
    { id: 'h2h', label: 'H2H', icon: <Swords />, badge: file.h2h?.matches?.length || undefined },
    { id: 'jugadores', label: 'Jugadores', icon: <Users />, badge: playersCount || undefined },
  ];

  return (
    <div className="space-y-6">
      <MatchHeader file={file} match={match} />

      <div key={match.id}>
        <Tabs idBase="match" value={tab} onChange={setTab} tabs={tabs} ariaLabel="Secciones del análisis del partido" />
        <TabPanel idBase="match" id="resultado" active={tab}>
          <ResultTab file={file} match={match} />
        </TabPanel>
        <TabPanel idBase="match" id="analisis" active={tab}>
          <AnalysisTab file={file} match={match} />
        </TabPanel>
        <TabPanel idBase="match" id="mercados" active={tab}>
          <MarketsTab file={file} match={match} />
        </TabPanel>
        <TabPanel idBase="match" id="estadisticas" active={tab}>
          <StatsTab file={file} match={match} />
        </TabPanel>
        <TabPanel idBase="match" id="forma" active={tab}>
          <FormTab file={file} match={match} />
        </TabPanel>
        <TabPanel idBase="match" id="h2h" active={tab}>
          <H2HTab file={file} match={match} />
        </TabPanel>
        <TabPanel idBase="match" id="jugadores" active={tab}>
          <PlayersTab file={file} match={match} />
        </TabPanel>
      </div>

      <p className="flex items-center gap-1.5 text-[12px] text-ink-3">
        <History className="h-3.5 w-3.5" aria-hidden="true" />
        Análisis generado {timeAgo(file.generatedAt)} · los datos se actualizan cada día.
      </p>
      <Disclaimer />
    </div>
  );
}
