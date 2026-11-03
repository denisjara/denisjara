import { useState } from 'react';
import { CalendarClock, History, Radio } from 'lucide-react';
import type { CompetitionFile, MatchSummary } from '../../../../types/data';
import { Card, EmptyState, MatchRow, Section } from '../../../components';
import type { LiveScore } from '../../../lib/live';
import { MatchBlocks, MatchPredictionRow } from '../MatchPredictionRow';
import { HitSummary } from '../shared';

export interface MatchesTabProps {
  data: CompetitionFile;
  live: MatchSummary[];
  liveScores: Record<string, LiveScore>;
}

const RESULTS_PAGE = 15;

/** Pestaña Partidos: en juego, próximos por jornada con predicción completa y resultados con acierto del modelo. */
export function MatchesTab({ data, live, liveScores }: MatchesTabProps) {
  const [shown, setShown] = useState(RESULTS_PAGE);
  const upcoming = data.upcoming.filter((m) => !live.some((l) => l.id === m.id));
  const results = data.results;

  return (
    <div className="space-y-10">
      {live.length > 0 && (
        <Section id="m-live" eyebrow="Ahora mismo" title="En juego" icon={<Radio />}>
          <Card pad="none" className="overflow-hidden">
            <ul className="divide-y divide-line/70">
              {live.map((m) => (
                <li key={m.id}>
                  <MatchPredictionRow match={m} live={liveScores[m.id]} />
                </li>
              ))}
            </ul>
          </Card>
        </Section>
      )}

      <Section
        id="m-upcoming"
        eyebrow="Próximos 14 días"
        title="Próximos partidos"
        icon={<CalendarClock />}
        description="Probabilidades 1X2 del modelo frente al mercado sin margen, goles esperados (xG), +2,5, ambos marcan, córners y tarjetas esperados y el pick de valor si lo hay."
      >
        {upcoming.length ? (
          <MatchBlocks matches={upcoming} live={liveScores} />
        ) : (
          <EmptyState icon={<CalendarClock />} title="Sin partidos próximos" description="No hay partidos programados en los próximos 14 días." />
        )}
      </Section>

      <Section
        id="m-results"
        eyebrow="Últimos 30 días"
        title="Resultados recientes"
        icon={<History />}
        description="Marcador final, probabilidades previas del modelo y si su resultado más probable acertó (✓) o falló (✗)."
      >
        {results.length ? (
          <Card pad="none" className="overflow-hidden">
            <HitSummary matches={results} />
            <ul className="divide-y divide-line/70">
              {results.slice(0, shown).map((m) => (
                <li key={m.id}>
                  <MatchRow match={m} showDate showHit />
                </li>
              ))}
            </ul>
            {results.length > shown && (
              <div className="flex justify-center border-t border-line p-3">
                <button type="button" className="btn" onClick={() => setShown((s) => s + RESULTS_PAGE)}>
                  Ver {Math.min(RESULTS_PAGE, results.length - shown)} resultados más
                </button>
              </div>
            )}
          </Card>
        ) : (
          <EmptyState icon={<History />} title="Sin resultados recientes" description="No hay partidos terminados en los últimos 30 días." />
        )}
      </Section>
    </div>
  );
}
