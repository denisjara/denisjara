import { Users } from 'lucide-react';
import type { CompetitionFile } from '../../../../types/data';
import { Section } from '../../../components';
import { PlayersTable } from '../PlayersTable';

/** Pestaña Jugadores: tabla ordenable con forma, Totales / Por 90, filtro por posición y búsqueda. */
export function PlayersTab({ data }: { data: CompetitionFile }) {
  return (
    <Section
      id="comp-players"
      eyebrow="Estado de forma diario"
      title="Jugadores"
      icon={<Users />}
      description="Goles, asistencias, tiros, tarjetas y faltas de los jugadores más destacados de la competición. La forma combina rendimiento reciente (ponderado por recencia) y minutos."
    >
      <PlayersTable players={data.players} caption={`Jugadores de ${data.meta.name}`} />
    </Section>
  );
}
