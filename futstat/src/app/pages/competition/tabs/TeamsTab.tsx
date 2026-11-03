import { useMemo, useState } from 'react';
import { BarChart3, Clock, Shield } from 'lucide-react';
import type { CompetitionFile, SplitStat, TeamSeasonStats } from '../../../../types/data';
import { Card, DataTable, EmptyState, FormChips, Heatmap, SegmentedControl, Section, TeamCrest, type Column } from '../../../components';
import { int, num, pct, xg as fmtXg } from '../../../lib/format';
import { Note, PERIOD_LABELS, TeamLink } from '../shared';

type Split = 'all' | 'home' | 'away';
const SPLIT_LABEL: Record<Split, string> = { all: 'Total', home: 'En casa', away: 'Fuera' };

const v = (s: SplitStat | undefined, k: Split) => (s ? s[k] : undefined);

/** Pestaña Equipos: estadísticas de temporada por equipo (Total/Casa/Fuera) y goles por tramo de minutos. */
export function TeamsTab({ data }: { data: CompetitionFile }) {
  const [split, setSplit] = useState<Split>('all');
  const teams = data.teams;

  const columns = useMemo<Column<TeamSeasonStats>[]>(() => {
    const n = (key: string, header: string, title: string, get: (t: TeamSeasonStats) => number | undefined, fmt: (x: number | undefined) => string = (x) => num(x, 1), opts: Partial<Column<TeamSeasonStats>> = {}): Column<TeamSeasonStats> => ({
      key,
      header,
      title,
      numeric: true,
      cell: (t) => fmt(get(t)),
      sortValue: (t) => get(t),
      ...opts,
    });
    return [
      { key: 'team', header: 'Equipo', sticky: true, cell: (t) => <TeamLink team={t.team} />, sortValue: (t) => t.team.name, className: 'min-w-[150px] max-w-[220px]' },
      n('played', 'PJ', 'Partidos jugados', (t) => v(t.played, split), (x) => int(x)),
      n('gf', 'GF', 'Goles a favor por partido', (t) => v(t.goalsFor, split), (x) => num(x, 2), {
        cell: (t) => <span className="font-semibold text-ink-1">{num(v(t.goalsFor, split), 2)}</span>,
      }),
      n('ga', 'GC', 'Goles en contra por partido', (t) => v(t.goalsAgainst, split), (x) => num(x, 2), { firstDir: 'asc' }),
      n('xg', 'xG', 'Goles esperados a favor por partido (modelo)', (t) => v(t.xgFor, split), fmtXg),
      n('xga', 'xGC', 'Goles esperados en contra por partido (modelo)', (t) => v(t.xgAgainst, split), fmtXg, { firstDir: 'asc' }),
      n('shots', 'Tiros', 'Tiros por partido', (t) => v(t.shots, split)),
      n('sot', 'TaP', 'Tiros a puerta por partido', (t) => v(t.shotsOnTarget, split)),
      n('corners', 'Córners', 'Córners a favor por partido (en contra en gris)', (t) => v(t.corners, split), undefined, {
        cell: (t) => (
          <span>
            {num(v(t.corners, split), 1)}
            <span className="text-ink-3"> / {num(v(t.cornersAgainst, split), 1)}</span>
          </span>
        ),
      }),
      n('cards', 'Tarj.', 'Tarjetas recibidas por partido (amarillas + rojas)', (t) => v(t.cards, split), (x) => num(x, 2)),
      n('fouls', 'Faltas', 'Faltas cometidas por partido', (t) => v(t.fouls, split)),
      n('poss', 'Pos.', 'Posesión media', (t) => v(t.possession, split), (x) => (typeof x === 'number' ? `${num(x, 0)}%` : '–')),
      n('o25', '+2,5', 'Partidos con más de 2,5 goles (toda la temporada)', (t) => t.over25Pct, (x) => pct(x)),
      n('btts', 'Ambos', 'Partidos en que marcan ambos equipos (toda la temporada)', (t) => t.bttsPct, (x) => pct(x)),
      n('cs', 'P. cero', 'Partidos con portería a cero (toda la temporada)', (t) => t.cleanSheetPct, (x) => pct(x)),
      {
        key: 'form',
        header: 'Forma',
        title: 'Últimos 5 resultados (el más reciente a la derecha); ordena por índice de forma',
        cell: (t) => <FormChips form={t.formString} size="xs" label={undefined} className="whitespace-nowrap" />,
        sortValue: (t) => t.formIndex,
      },
    ];
  }, [split]);

  const periodTeams = useMemo(
    () =>
      teams
        .filter((t) => (t.goalsByPeriod?.length ?? 0) > 0 || (t.concededByPeriod?.length ?? 0) > 0)
        .map((t) => ({
          team: t.team,
          for: PERIOD_LABELS.map((_, i) => t.goalsByPeriod?.[i] ?? 0),
          against: PERIOD_LABELS.map((_, i) => t.concededByPeriod?.[i] ?? 0),
        }))
        .sort((a, b) => b.for.reduce((s, x) => s + x, 0) - a.for.reduce((s, x) => s + x, 0)),
    [teams],
  );
  const periodMax = Math.max(1, ...periodTeams.flatMap((t) => [...t.for, ...t.against]));

  if (!teams.length) {
    return <EmptyState icon={<Shield />} title="Sin estadísticas de equipos" description="Todavía no hay partidos suficientes con estadísticas en esta competición." />;
  }

  return (
    <div className="space-y-10">
      <Section
        id="teams-stats"
        eyebrow="Por partido"
        title="Estadísticas de equipos"
        icon={<BarChart3 />}
        description="Medias por partido. Pulsa una cabecera para ordenar."
        action={
          <SegmentedControl
            ariaLabel="Partidos considerados"
            value={split}
            onChange={setSplit}
            options={(['all', 'home', 'away'] as Split[]).map((s) => ({ value: s, label: SPLIT_LABEL[s] }))}
          />
        }
      >
        <DataTable
          columns={columns}
          rows={teams}
          rowKey={(t) => t.team.id}
          caption={`Estadísticas de equipos por partido (${SPLIT_LABEL[split].toLowerCase()})`}
          initialSort={{ key: 'gf', dir: 'desc' }}
          dense
          maxHeight={teams.length > 24 ? 680 : undefined}
        />
        <Note>
          xG/xGC: goles esperados según el modelo (λ de cada partido). TaP: tiros a puerta. Los porcentajes +2,5, Ambos y P. cero (portería a cero) son de toda la
          temporada. {split !== 'all' && `Vista: solo partidos ${split === 'home' ? 'como local' : 'como visitante'}.`}
        </Note>
      </Section>

      <Section
        id="teams-periods"
        eyebrow="Tramos de 15 minutos"
        title="Cuándo marcan y cuándo encajan"
        icon={<Clock />}
        description="Goles por tramo de minutos en la temporada (recuento). Equipos ordenados por goles marcados; misma escala de color en ambas tablas."
      >
        {periodTeams.length ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {(['for', 'against'] as const).map((k) => (
              <Card key={k} pad="sm" className="overflow-hidden">
                <h3 className="mb-2 px-1 font-display text-[17px] font-bold uppercase tracking-wide text-ink-1">{k === 'for' ? 'Goles a favor' : 'Goles en contra'}</h3>
                <Heatmap
                  rows={periodTeams.map((t) => (
                    <span key={t.team.id} className="inline-flex max-w-[140px] items-center gap-1.5">
                      <TeamCrest team={t.team} size={16} />
                      <span className="truncate">{t.team.short || t.team.name}</span>
                    </span>
                  ))}
                  cols={PERIOD_LABELS.map((l) => `${l}'`)}
                  values={periodTeams.map((t) => t[k])}
                  caption={`Goles ${k === 'for' ? 'marcados' : 'encajados'} por tramo de minutos`}
                  rowTitle="Equipo"
                  colTitle="Minuto"
                  format={(x) => int(x)}
                  max={periodMax}
                  minLabel={0.5}
                  cellSize={44}
                  rowLabelWidth={130}
                  describe={(r, c, x) => `${periodTeams[r].team.name}, minutos ${PERIOD_LABELS[c]}: ${int(x)} ${x === 1 ? 'gol' : 'goles'} ${k === 'for' ? 'a favor' : 'en contra'}`}
                />
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState compact icon={<Clock />} title="Sin datos por minuto" description="La fuente no publica los minutos de los goles de esta competición." />
        )}
      </Section>
    </div>
  );
}
