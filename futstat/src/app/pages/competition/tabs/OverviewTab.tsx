import { useMemo } from 'react';
import { CalendarClock, ChevronRight, History, Lightbulb, ListOrdered, Radio, TrendingUp } from 'lucide-react';
import type { CompetitionFile, MatchSummary } from '../../../../types/data';
import { Card, EmptyState, MatchCard, Section } from '../../../components';
import type { LiveScore } from '../../../lib/live';
import { MiniStandings } from '../StandingsTable';
import { nextMatchLabel } from '../../../lib/competitions';
import { HotPlayersList, ResultsCard } from '../shared';

export interface OverviewTabProps {
  data: CompetitionFile;
  live: MatchSummary[];
  liveScores: Record<string, LiveScore>;
  goTo: (tab: 'partidos' | 'clasificacion' | 'jugadores') => void;
}

function MoreButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button type="button" className="btn-ghost -mr-2 shrink-0" onClick={onClick}>
      {children}
      <ChevronRight className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

/** Texto del estado vacío de próximos partidos (con la fecha del siguiente si se conoce). */
export function noUpcomingText(data: CompetitionFile): string {
  const next = nextMatchLabel(data.meta);
  return next ? `No hay partidos en los próximos 14 días. Próximo partido: ${next}.` : 'No hay partidos programados en los próximos 14 días.';
}

/** Pestaña Resumen: en juego, próximos destacados, claves, mini clasificación, resultados y jugadores en forma. */
export function OverviewTab({ data, live, liveScores, goTo }: OverviewTabProps) {
  const featured = useMemo(
    () =>
      [...data.upcoming]
        .filter((m) => m.status === 'scheduled' || m.status === 'live')
        .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || a.date.localeCompare(b.date))
        .slice(0, 6)
        .sort((a, b) => a.date.localeCompare(b.date)),
    [data.upcoming],
  );
  const group = data.standings[0];

  return (
    <div className="space-y-10">
      {live.length > 0 && (
        <Section id="comp-live" eyebrow="Ahora mismo" title="En juego" icon={<Radio />}>
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {live.map((m, i) => (
              <MatchCard key={m.id} match={m} live={liveScores[m.id]} hideCompetition delay={i * 40} />
            ))}
          </div>
        </Section>
      )}

      <Section
        id="comp-featured"
        eyebrow="Próximos 14 días"
        title="Partidos destacados"
        icon={<CalendarClock />}
        description="Los encuentros con más interés de la competición, con la predicción del modelo frente al mercado."
        action={data.upcoming.length > featured.length ? <MoreButton onClick={() => goTo('partidos')}>Todos los partidos</MoreButton> : undefined}
      >
        {featured.length ? (
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {featured.map((m, i) => (
              <MatchCard key={m.id} match={m} live={liveScores[m.id]} hideCompetition delay={Math.min(i, 6) * 40} />
            ))}
          </div>
        ) : (
          <EmptyState icon={<CalendarClock />} title="Sin partidos próximos" description={noUpcomingText(data)} />
        )}
      </Section>

      <div className="grid grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:gap-6">
        <Section id="comp-insights" eyebrow="Tendencias" title="Claves de la competición" icon={<Lightbulb />}>
          {data.insights.length ? (
            <Card pad="none" className="overflow-hidden">
              <ol className="divide-y divide-line/70">
                {data.insights.map((t, i) => (
                  <li key={i} className="flex gap-3 px-3 py-2.5 text-[13.5px] leading-snug text-ink-1 sm:px-4">
                    <span className="num mt-px shrink-0 text-[11px] font-semibold text-accent-text">{String(i + 1).padStart(2, '0')}</span>
                    <span>{t}</span>
                  </li>
                ))}
              </ol>
            </Card>
          ) : (
            <EmptyState compact icon={<Lightbulb />} title="Sin tendencias todavía" description="Se publicarán cuando haya suficientes partidos jugados." />
          )}
        </Section>

        {group ? (
          <Section
            id="comp-mini-table"
            eyebrow={data.standings.length > 1 ? group.name : 'Clasificación'}
            title={data.standings.length > 1 ? 'Clasificación' : 'Tabla'}
            icon={<ListOrdered />}
            action={<MoreButton onClick={() => goTo('clasificacion')}>Completa</MoreButton>}
          >
            <MiniStandings group={group} limit={8} />
          </Section>
        ) : (
          <Section id="comp-hot" eyebrow="Estado de forma" title="Jugadores en forma" icon={<TrendingUp />} action={data.players.length > 6 ? <MoreButton onClick={() => goTo('jugadores')}>Todos</MoreButton> : undefined}>
            <HotPlayersList players={data.players} limit={8} />
          </Section>
        )}
      </div>

      <div className={group ? 'grid grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] xl:gap-6' : undefined}>
        <Section
          id="comp-results"
          eyebrow="Últimos 30 días"
          title="Últimos resultados"
          icon={<History />}
          description="Marcador final y si el pronóstico 1X2 del modelo (resultado más probable) acertó."
          action={data.results.length > 8 ? <MoreButton onClick={() => goTo('partidos')}>Ver todos</MoreButton> : undefined}
        >
          <ResultsCard matches={data.results} limit={8} compact={!!group} />
        </Section>
        {group && (
          <Section
            id="comp-hot"
            eyebrow="Estado de forma"
            title="Jugadores en forma"
            icon={<TrendingUp />}
            description="Índice 0-100 y notas de los últimos 5 partidos."
            action={data.players.length > 6 ? <MoreButton onClick={() => goTo('jugadores')}>Todos</MoreButton> : undefined}
          >
            <HotPlayersList players={data.players} limit={8} />
          </Section>
        )}
      </div>
    </div>
  );
}
