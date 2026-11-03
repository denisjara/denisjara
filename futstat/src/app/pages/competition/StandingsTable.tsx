import { Link } from 'react-router-dom';
import type { StandingGroup, StandingRow } from '../../../types/data';
import { DataTable, FormChips, TeamCrest, cx, type Column } from '../../components';
import { deltaClass } from '../../lib/colors';
import { int, num, signed } from '../../lib/format';
import { RankCell, TeamLink, ZoneLegend, noteColor } from './shared';

/** Tabla de clasificación completa de un grupo (ordenable, con xPts, Elo, forma y zonas). */
export function StandingsTable({ group, highlightTeamId }: { group: StandingGroup; highlightTeamId?: string }) {
  const hasXPts = group.rows.some((r) => typeof r.xPts === 'number');
  const hasElo = group.rows.some((r) => typeof r.elo === 'number');
  const hasForm = group.rows.some((r) => !!r.form);
  const cols: Column<StandingRow>[] = [
    { key: 'rank', header: '#', title: 'Posición', cell: (r) => <RankCell row={r} />, sortValue: (r) => r.rank, firstDir: 'asc', width: 56 },
    {
      key: 'team',
      header: 'Equipo',
      sticky: true,
      cell: (r) => <TeamLink team={r.team} bold={r.team.id === highlightTeamId} />,
      sortValue: (r) => r.team.name,
      className: 'min-w-[128px] max-w-[240px] sm:min-w-[150px]',
    },
    { key: 'played', header: 'PJ', title: 'Partidos jugados', numeric: true, sortValue: (r) => r.played },
    { key: 'won', header: 'G', title: 'Ganados', numeric: true, sortValue: (r) => r.won, hideBelow: 'sm' },
    { key: 'drawn', header: 'E', title: 'Empatados', numeric: true, sortValue: (r) => r.drawn, hideBelow: 'sm' },
    { key: 'lost', header: 'P', title: 'Perdidos', numeric: true, sortValue: (r) => r.lost, hideBelow: 'sm' },
    { key: 'gf', header: 'GF', title: 'Goles a favor', numeric: true, sortValue: (r) => r.gf, hideBelow: 'sm' },
    { key: 'ga', header: 'GC', title: 'Goles en contra', numeric: true, sortValue: (r) => r.ga, hideBelow: 'sm' },
    { key: 'gd', header: 'DG', title: 'Diferencia de goles', numeric: true, cell: (r) => signed(r.gd, 0), sortValue: (r) => r.gd },
    {
      key: 'points',
      header: 'Pts',
      title: 'Puntos',
      numeric: true,
      cell: (r) => <span className="font-bold text-ink-1">{int(r.points)}</span>,
      sortValue: (r) => r.points,
    },
  ];
  if (hasXPts) {
    cols.push(
      { key: 'xPts', header: 'xPts', title: 'Puntos esperados según el modelo', numeric: true, cell: (r) => num(r.xPts, 1), sortValue: (r) => r.xPts },
      {
        key: 'dxPts',
        header: 'Pts−xPts',
        title: 'Diferencia entre puntos reales y esperados (positivo: suma más de lo que merece su juego)',
        numeric: true,
        cell: (r) => (typeof r.xPts === 'number' ? <span className={deltaClass(r.points - r.xPts, 0.5)}>{signed(r.points - r.xPts, 1)}</span> : '—'),
        sortValue: (r) => (typeof r.xPts === 'number' ? r.points - r.xPts : undefined),
      },
    );
  }
  if (hasElo) cols.push({ key: 'elo', header: 'Elo', title: 'Rating Elo', numeric: true, cell: (r) => int(r.elo), sortValue: (r) => r.elo, hideBelow: 'md' });
  if (hasForm) cols.push({ key: 'form', header: 'Forma', title: 'Últimos 5 resultados (el más reciente a la derecha)', cell: (r) => <FormChips form={r.form} size="xs" />, align: 'left', className: 'whitespace-nowrap' });

  return (
    <div>
      <DataTable
        columns={cols}
        rows={group.rows}
        rowKey={(r) => r.team.id}
        caption={`Clasificación: ${group.name}`}
        dense
        rowClassName={(r) => (r.team.id === highlightTeamId ? '[&>td]:bg-accent/[0.07]' : undefined)}
      />
      <ZoneLegend rows={group.rows} className="mt-3" />
    </div>
  );
}

/** Mini clasificación (posición, equipo, PJ, DG, Pts y forma) para el resumen. */
export function MiniStandings({ group, limit = 8, highlightTeamId }: { group: StandingGroup; limit?: number; highlightTeamId?: string }) {
  const rows = group.rows.slice(0, limit);
  return (
    <div className="relative overflow-hidden rounded-card border border-line bg-surface-1/90">
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <caption className="sr-only">Clasificación resumida: {group.name}</caption>
        <thead>
          <tr className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3">
            <th scope="col" className="border-b border-line bg-surface-2 py-2 pl-3 text-left" title="Posición">
              #
            </th>
            <th scope="col" className="border-b border-line bg-surface-2 px-2 py-2 text-left">
              Equipo
            </th>
            <th scope="col" className="border-b border-line bg-surface-2 px-2 py-2 text-right" title="Partidos jugados">
              PJ
            </th>
            <th scope="col" className="border-b border-line bg-surface-2 px-2 py-2 text-right" title="Diferencia de goles">
              DG
            </th>
            <th scope="col" className="border-b border-line bg-surface-2 px-2 py-2 text-right" title="Puntos">
              Pts
            </th>
            <th scope="col" className="hidden border-b border-line bg-surface-2 py-2 pl-2 pr-3 text-left sm:table-cell">
              Forma
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const c = noteColor(r.note);
            const me = r.team.id === highlightTeamId;
            return (
              <tr key={r.team.id} className={cx('group', me && 'bg-accent/[0.07]')}>
                <td className="border-b border-line/70 py-2 pl-3 group-last:border-b-0" title={r.note?.label}>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-4 w-[3px] rounded-full" style={{ background: c ?? 'transparent' }} aria-hidden="true" />
                    <span className="num w-5 text-right font-semibold text-ink-1">{r.rank}</span>
                    {r.note?.label && <span className="sr-only">({r.note.label})</span>}
                  </span>
                </td>
                <th scope="row" className="w-full max-w-0 border-b border-line/70 px-2 py-2 text-left font-normal group-last:border-b-0">
                  <Link to={`/t/${r.team.id}`} className="flex min-w-0 items-center gap-2 hover:underline" title={r.team.name}>
                    <TeamCrest team={r.team} size={18} />
                    <span className={cx('truncate text-ink-1', me ? 'font-bold' : 'font-medium')}>{r.team.short || r.team.name}</span>
                  </Link>
                </th>
                <td className="num border-b border-line/70 px-2 py-2 text-right text-ink-2 group-last:border-b-0">{int(r.played)}</td>
                <td className="num border-b border-line/70 px-2 py-2 text-right text-ink-2 group-last:border-b-0">{signed(r.gd, 0)}</td>
                <td className="num border-b border-line/70 px-2 py-2 text-right font-bold text-ink-1 group-last:border-b-0">{int(r.points)}</td>
                <td className="hidden border-b border-line/70 py-2 pl-2 pr-3 group-last:border-b-0 sm:table-cell">
                  <FormChips form={r.form} size="xs" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
