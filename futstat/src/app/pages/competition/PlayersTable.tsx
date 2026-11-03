import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Users } from 'lucide-react';
import type { PlayerRef, PlayerSeasonRow } from '../../../types/data';
import { DataTable, EmptyState, SegmentedControl, TeamCrest, type Column } from '../../components';
import { int, normalizeText, num, plural } from '../../lib/format';
import { PlayerForm, PositionTag } from './shared';

type Mode = 'total' | 'p90';
type Pos = 'all' | PlayerRef['position'];

const POS_OPTIONS: { value: Pos; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'G', label: 'POR' },
  { value: 'D', label: 'DEF' },
  { value: 'M', label: 'MED' },
  { value: 'F', label: 'DEL' },
];

export interface PlayersTableProps {
  players: PlayerSeasonRow[];
  /** muestra la columna/enlace del equipo (false en la ficha de equipo) */
  showTeam?: boolean;
  caption: string;
  maxHeight?: number;
}

/**
 * Tabla ordenable de jugadores con conmutador Totales / Por 90, filtro por posición y búsqueda.
 * Forma = índice 0-100 + sparkline de las notas de los últimos 5 partidos.
 */
export function PlayersTable({ players, showTeam = true, caption, maxHeight = 640 }: PlayersTableProps) {
  const [mode, setMode] = useState<Mode>('total');
  const [pos, setPos] = useState<Pos>('all');
  const [q, setQ] = useState('');

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: players.length };
    for (const p of players) c[p.player.position] = (c[p.player.position] ?? 0) + 1;
    return c;
  }, [players]);

  const rows = useMemo(() => {
    const nq = normalizeText(q);
    return players.filter(
      (p) =>
        (pos === 'all' || p.player.position === pos) &&
        (!nq || normalizeText(p.player.name).includes(nq) || normalizeText(p.team.name).includes(nq) || normalizeText(p.team.short ?? '').includes(nq)),
    );
  }, [players, pos, q]);

  const p90 = mode === 'p90';
  const columns: Column<PlayerSeasonRow>[] = [
    {
      key: 'player',
      header: 'Jugador',
      sticky: true,
      sortValue: (r) => r.player.name,
      className: 'min-w-[170px] max-w-[260px]',
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          {!showTeam && <PositionTag position={r.player.position} />}
          {showTeam && <TeamCrest team={r.team} size={20} />}
          <span className="min-w-0">
            <span className="block truncate font-semibold text-ink-1" title={r.player.name}>
              {r.player.name}
            </span>
            {showTeam && (
              <span className="flex min-w-0 items-center gap-1.5 text-2xs text-ink-3">
                <PositionTag position={r.player.position} />
                <Link to={`/t/${r.team.id}`} className="truncate hover:text-ink-1 hover:underline" title={r.team.name}>
                  {r.team.short || r.team.name}
                </Link>
              </span>
            )}
          </span>
        </span>
      ),
    },
    { key: 'form', header: 'Forma', title: 'Índice de forma (0-100) y notas de los últimos 5 partidos', cell: (r) => <PlayerForm player={r} />, sortValue: (r) => r.formIndex, firstDir: 'desc', className: 'whitespace-nowrap' },
    { key: 'apps', header: 'PJ', title: 'Partidos jugados (titular)', numeric: true, cell: (r) => (
      <span>
        {r.apps}
        <span className="ml-1 text-ink-3">({r.starts})</span>
      </span>
    ), sortValue: (r) => r.apps },
    { key: 'minutes', header: 'Min', title: 'Minutos jugados', numeric: true, cell: (r) => int(r.minutes), sortValue: (r) => r.minutes },
    p90
      ? { key: 'g90', header: 'Gol/90', title: 'Goles por 90 minutos', numeric: true, cell: (r) => num(r.per90.goals, 2), sortValue: (r) => r.per90.goals }
      : { key: 'goals', header: 'Goles', title: 'Goles', numeric: true, cell: (r) => <span className="font-semibold text-ink-1">{r.goals}</span>, sortValue: (r) => r.goals },
    p90
      ? { key: 'a90', header: 'Asi/90', title: 'Asistencias por 90 minutos', numeric: true, cell: (r) => num(r.per90.assists, 2), sortValue: (r) => r.per90.assists }
      : { key: 'assists', header: 'Asist.', title: 'Asistencias', numeric: true, sortValue: (r) => r.assists },
    p90
      ? { key: 's90', header: 'Tiros/90', title: 'Tiros por 90 minutos', numeric: true, cell: (r) => num(r.per90.shots, 2), sortValue: (r) => r.per90.shots }
      : { key: 'shots', header: 'Tiros', title: 'Tiros totales', numeric: true, sortValue: (r) => r.shots },
    p90
      ? { key: 'sot90', header: 'TaP/90', title: 'Tiros a puerta por 90 minutos', numeric: true, cell: (r) => num(r.per90.shotsOnTarget, 2), sortValue: (r) => r.per90.shotsOnTarget }
      : { key: 'sot', header: 'TaP', title: 'Tiros a puerta', numeric: true, cell: (r) => r.shotsOnTarget, sortValue: (r) => r.shotsOnTarget },
    ...(p90
      ? ([
          { key: 'c90', header: 'Tarj/90', title: 'Tarjetas (amarillas + rojas) por 90 minutos', numeric: true, cell: (r) => num(r.per90.cards, 2), sortValue: (r) => r.per90.cards },
        ] as Column<PlayerSeasonRow>[])
      : ([
          {
            key: 'yellow',
            header: <span className="inline-flex items-center gap-1"><span className="h-3 w-2 rounded-[1px] bg-warn" aria-hidden="true" />TA</span>,
            title: 'Tarjetas amarillas',
            numeric: true,
            sortValue: (r) => r.yellow,
          },
          {
            key: 'red',
            header: <span className="inline-flex items-center gap-1"><span className="h-3 w-2 rounded-[1px] bg-loss" aria-hidden="true" />TR</span>,
            title: 'Tarjetas rojas',
            numeric: true,
            sortValue: (r) => r.red,
          },
        ] as Column<PlayerSeasonRow>[])),
    p90
      ? { key: 'f90', header: 'Faltas/90', title: 'Faltas cometidas por 90 minutos', numeric: true, cell: (r) => num(r.per90.foulsCommitted, 2), sortValue: (r) => r.per90.foulsCommitted }
      : { key: 'fouls', header: 'Faltas', title: 'Faltas cometidas (recibidas)', numeric: true, cell: (r) => (
          <span>
            {r.foulsCommitted}
            <span className="ml-1 text-ink-3">({r.foulsSuffered})</span>
          </span>
        ), sortValue: (r) => r.foulsCommitted },
  ];

  if (!players.length) return <EmptyState icon={<Users />} title="Sin datos de jugadores" description="Todavía no hay estadísticas individuales para esta selección." />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <span className="sr-only">Buscar jugador o equipo</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden="true" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={showTeam ? 'Buscar jugador o equipo…' : 'Buscar jugador…'} className="input pl-8" />
        </label>
        <SegmentedControl
          ariaLabel="Posición"
          size="sm"
          value={pos}
          onChange={setPos}
          options={POS_OPTIONS.map((o) => ({ ...o, count: counts[o.value] ?? 0, disabled: o.value !== 'all' && !counts[o.value] }))}
          className="max-w-full overflow-x-auto scrollbar-none"
        />
        <SegmentedControl
          ariaLabel="Modo de estadísticas"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'total', label: 'Totales' },
            { value: 'p90', label: 'Por 90' },
          ]}
        />
        <span className="ml-auto text-[12px] text-ink-3" aria-live="polite">
          {plural(rows.length, 'jugador', 'jugadores')}
        </span>
      </div>
      <DataTable
        key={mode}
        columns={columns}
        rows={rows}
        rowKey={(r) => `${r.player.id}-${r.compId}`}
        caption={`${caption} (${p90 ? 'por 90 minutos' : 'totales'})`}
        initialSort={{ key: 'form', dir: 'desc' }}
        maxHeight={maxHeight}
        dense
        emptyText="Ningún jugador coincide con el filtro"
      />
      <p className="text-[12px] text-ink-3">
        PJ entre paréntesis: partidos como titular. {p90 ? 'Valores por 90 minutos jugados.' : 'Faltas entre paréntesis: faltas recibidas.'} TaP = tiros a puerta.
      </p>
    </div>
  );
}
