import { ListOrdered } from 'lucide-react';
import type { CompetitionFile } from '../../../../types/data';
import { EmptyState, Section } from '../../../components';
import { StandingsTable } from '../StandingsTable';
import { Note } from '../shared';

/** Pestaña Clasificación: tabla completa por grupo con xPts, Elo, forma y zonas. */
export function StandingsTab({ data }: { data: CompetitionFile }) {
  if (!data.standings.length) {
    return <EmptyState icon={<ListOrdered />} title="Sin clasificación" description="Esta competición se juega por eliminatorias y no tiene tabla." />;
  }
  const multi = data.standings.length > 1;
  const hasXPts = data.standings.some((g) => g.rows.some((r) => typeof r.xPts === 'number'));
  return (
    <div className="space-y-10">
      {data.standings.map((g, i) => (
        <Section
          key={g.name}
          id={`tabla-${i}`}
          eyebrow={multi ? 'Grupo' : data.meta.seasonLabel ? `Temporada ${data.meta.seasonLabel}` : undefined}
          title={multi ? g.name : 'Clasificación'}
          icon={<ListOrdered />}
          description={i === 0 ? 'Pulsa en una cabecera para ordenar. El color a la izquierda de la posición indica la zona (ver leyenda).' : undefined}
        >
          <StandingsTable group={g} />
        </Section>
      ))}
      {hasXPts && (
        <Note>
          <strong className="font-semibold text-ink-2">xPts (puntos esperados):</strong> puntos que habría sumado cada equipo de media según los goles esperados (λ) del modelo
          en cada partido jugado. <strong className="font-semibold text-ink-2">Pts−xPts</strong> positivo indica que el equipo ha sumado más de lo que reflejan sus
          ocasiones (posible sobrerrendimiento o acierto puntual); negativo, que merece más de lo que tiene.
        </Note>
      )}
    </div>
  );
}
