import { Dices, Grid3x3, Sigma } from 'lucide-react';
import type { CompetitionFile, SeasonSimulation, SeasonSimulationRow } from '../../../../types/data';
import { Card, DataTable, EmptyState, Heatmap, KpiTile, Section, TeamCrest, type Column } from '../../../components';
import { seqFill } from '../../../lib/colors';
import { int, num, pct } from '../../../lib/format';
import { Note, TeamLink, ordinal } from '../shared';

function ProbCell({ p }: { p: number | undefined }) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return <span className="text-ink-3">–</span>;
  const fill = seqFill(p <= 0 ? 0 : Math.sqrt(p));
  return (
    <span className="num inline-block min-w-[54px] rounded-[4px] px-1.5 py-0.5 text-right font-medium" style={fill}>
      {p > 0 && p < 0.005 ? '<1%' : pct(p)}
    </span>
  );
}

function SimulationBlock({ sim, multi, fallbackColumns }: { sim: SeasonSimulation; multi: boolean; fallbackColumns?: string[] }) {
  const columns = sim.columns.length ? sim.columns : fallbackColumns ?? [];
  const rows = [...sim.rows].sort((a, b) => b.expectedPoints - a.expectedPoints);
  const first = columns[0];
  const fav = first ? [...sim.rows].sort((a, b) => (b.probs[first] ?? 0) - (a.probs[first] ?? 0))[0] : undefined;
  const nPos = Math.max(0, ...sim.rows.map((r) => r.positionDist.length));
  /** ancho de la columna de equipos del mapa de calor (más estrecha con 30+ puestos para que quepa sin desplazamiento) */
  const labelW = nPos > 30 ? 120 : 150;
  const heatRows = [...sim.rows].sort((a, b) => a.expectedRank - b.expectedRank);

  const cols: Column<SeasonSimulationRow>[] = [
    {
      key: 'team',
      header: 'Equipo',
      sticky: true,
      cell: (r) => <TeamLink team={r.team} />,
      sortValue: (r) => r.team.name,
      className: 'min-w-[150px] max-w-[230px]',
    },
    { key: 'pts', header: 'Pts', title: 'Puntos actuales', numeric: true, cell: (r) => int(r.currentPoints), sortValue: (r) => r.currentPoints },
    {
      key: 'xpts',
      header: 'Pts esp.',
      title: 'Puntos finales esperados (media de las simulaciones)',
      numeric: true,
      cell: (r) => <span className="font-semibold text-ink-1">{num(r.expectedPoints, 1)}</span>,
      sortValue: (r) => r.expectedPoints,
    },
    { key: 'xrank', header: 'Pos. esp.', title: 'Posición final esperada', numeric: true, cell: (r) => num(r.expectedRank, 1), sortValue: (r) => r.expectedRank, firstDir: 'asc' },
    ...columns.map(
      (c): Column<SeasonSimulationRow> => ({
        key: `p-${c}`,
        header: c,
        title: `Probabilidad: ${c}`,
        numeric: true,
        cell: (r) => <ProbCell p={r.probs[c]} />,
        sortValue: (r) => r.probs[c] ?? 0,
      }),
    ),
  ];

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Simulaciones" value={int(sim.iterations)} hint="Temporadas simuladas" icon={<Dices />} />
        <KpiTile label="Partidos restantes" value={int(sim.remainingMatches)} hint={`${multi ? sim.group : 'Calendario'} por jugar`} icon={<Sigma />} />
        {fav && first && (
          <KpiTile
            label={`Favorito · ${first}`}
            value={pct(fav.probs[first])}
            hint={
              <span className="inline-flex items-center gap-1.5">
                <TeamCrest team={fav.team} size={14} />
                {fav.team.name}
              </span>
            }
            accent
          />
        )}
        {rows[0] && <KpiTile label="Más puntos esperados" value={num(rows[0].expectedPoints, 1)} unit="pts" hint={rows[0].team.name} />}
      </div>

      <Section
        id={`sim-probs-${sim.group}`}
        title="Probabilidades finales"
        eyebrow={multi ? sim.group : 'Monte Carlo'}
        icon={<Dices />}
        description="Probabilidad de terminar en cada objetivo y puntos/posición esperados al final de la temporada."
      >
        <DataTable columns={cols} rows={rows} rowKey={(r) => r.team.id} caption={`Simulación de temporada: ${sim.group}`} initialSort={{ key: 'xpts', dir: 'desc' }} dense />
      </Section>

      {nPos > 0 && (
        <Section
          id={`sim-heat-${sim.group}`}
          title="Distribución de posiciones"
          eyebrow="Equipos × posición final"
          icon={<Grid3x3 />}
          description="Cada fila suma 100%: probabilidad de que el equipo acabe en cada puesto. La celda con borde es la más probable de toda la tabla."
        >
          <Card pad="sm" className="overflow-hidden">
            <Heatmap
              rows={heatRows.map((r) => (
                <span key={r.team.id} className="inline-flex items-center gap-1.5" style={{ maxWidth: labelW }}>
                  <TeamCrest team={r.team} size={16} />
                  <span className="truncate">{r.team.short || r.team.name}</span>
                </span>
              ))}
              cols={Array.from({ length: nPos }, (_, i) => String(i + 1))}
              values={heatRows.map((r) => Array.from({ length: nPos }, (_, i) => r.positionDist[i] ?? 0))}
              caption={`Distribución de la posición final por equipo (${sim.group})`}
              rowTitle="Equipo"
              colTitle="Posición final"
              format={(v) => (v > 0 && v < 0.005 ? '<1%' : pct(v))}
              minLabel={0.05}
              cellSize={nPos > 30 ? 24 : nPos > 24 ? 28 : 38}
              rowLabelWidth={labelW}
              describe={(r, c, v) => `${heatRows[r].team.name} termina ${ordinal(c + 1)}: ${pct(v, 1)}`}
            />
          </Card>
        </Section>
      )}
    </div>
  );
}

/** Pestaña Simulación: Monte Carlo de la temporada (probabilidades por objetivo + heatmap de posiciones). */
export function SimulationTab({ data }: { data: CompetitionFile }) {
  const sims = data.simulations;
  if (!sims.length) {
    return <EmptyState icon={<Dices />} title="Sin simulación" description="Esta competición no tiene simulación de temporada publicada." />;
  }
  const s0 = sims[0];
  const c0 = s0.columns[0] ?? data.meta.simulationColumns?.[0];
  const fav = c0 ? [...s0.rows].sort((a, b) => (b.probs[c0] ?? 0) - (a.probs[c0] ?? 0))[0] : undefined;
  const example =
    c0 && fav && typeof fav.probs[c0] === 'number'
      ? `Por ejemplo, «${c0} ${pct(fav.probs[c0])}» para ${fav.team.name} significa que lo logró en el ${pct(fav.probs[c0])} de las temporadas simuladas.`
      : '';
  return (
    <div className="space-y-10">
      <Card className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent-text" aria-hidden="true">
          <Dices className="h-5 w-5" />
        </span>
        <div className="text-[13.5px] leading-relaxed text-ink-2">
          <p className="font-semibold text-ink-1">¿Cómo se calcula?</p>
          <p className="mt-1">
            Simulamos el resto de la temporada <strong className="text-ink-1">{int(s0.iterations)} veces</strong> (método de Monte Carlo). En cada simulación, cada uno de
            los <strong className="text-ink-1">{int(s0.remainingMatches)} partidos restantes</strong> se juega sorteando un marcador con las probabilidades del
            modelo. Sumamos los puntos a la clasificación actual y contamos en cuántas simulaciones acaba cada equipo en cada posición.{example && ` ${example}`}
          </p>
        </div>
      </Card>
      {sims.map((s) => (
        <SimulationBlock key={s.group} sim={s} multi={sims.length > 1} fallbackColumns={data.meta.simulationColumns} />
      ))}
      <Note>Las probabilidades se recalculan cada día con los resultados nuevos. Las zonas exactas (Champions, descenso…) dependen del reglamento de cada competición.</Note>
    </div>
  );
}
