import { Fragment, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown } from 'lucide-react';
import type { PlayerSeasonRow } from '../../../types/data';
import { TeamCrest, cx } from '../../components';
import { useCompetitionMeta } from '../../lib/data';
import { useElementWidth } from '../../lib/hooks';
import { int } from '../../lib/format';
import { FormTrend } from './FormTrend';
import { PlayerDetail } from './PlayerDetail';
import { METRICS, fmtMetric, metricValue, rowKey, type MetricKey, type Mode, type PeerTable, type SortKey } from './players';
import { PositionTag } from './ui';

interface Col {
  key: SortKey;
  header: string;
  title: string;
  numeric: boolean;
  cell: (r: PlayerSeasonRow) => ReactNode;
  className?: string;
}

const METRIC_TITLE: Record<MetricKey, string> = {
  form: 'Índice de forma (0-100) y notas de los últimos 5 partidos',
  goals: 'Goles',
  assists: 'Asistencias',
  shots: 'Tiros totales',
  sot: 'Tiros a puerta',
  cards: 'Tarjetas (amarillas + rojas)',
  fouls: 'Faltas cometidas',
};

function CompFlag({ compId }: { compId: string }) {
  const meta = useCompetitionMeta(compId);
  return (
    <span className="inline-flex shrink-0 items-center gap-1" title={meta?.name ?? compId}>
      <span aria-hidden="true" className="text-[11px] leading-none">
        {meta?.flag ?? '⚽'}
      </span>
      <span className="hidden lg:inline">{meta?.shortName ?? compId}</span>
      <span className="sr-only lg:hidden">{meta?.name ?? compId}</span>
    </span>
  );
}

export interface PlayerRankingTableProps {
  /** filas ya ordenadas y recortadas */
  rows: PlayerSeasonRow[];
  mode: Mode;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (key: SortKey) => void;
  expanded: string | null;
  onToggle: (key: string) => void;
  peers: PeerTable;
  caption: string;
  maxHeight?: number | string;
  className?: string;
  /** muestra la bandera/nombre de la competición en cada fila (por defecto true) */
  showComp?: boolean;
}

/**
 * Ranking de jugadores ordenable con fila desplegable (detalle + últimos 5 partidos).
 * Primera columna fija en scroll horizontal; el detalle se ajusta al ancho visible.
 */
export function PlayerRankingTable({ rows, mode, sort, onSort, expanded, onToggle, peers, caption, maxHeight, className, showComp = true }: PlayerRankingTableProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(900);
  const p90 = mode === 'p90';

  const metricCols: Col[] = METRICS.filter((m) => m.key !== 'form').map((m) => ({
    key: m.key,
    header: p90 ? m.shortP90 : m.short,
    title: `${METRIC_TITLE[m.key]}${p90 ? ' por 90 minutos' : ''}`,
    numeric: true,
    cell: (r) => {
      const v = metricValue(r, m.key, mode);
      if (!p90 && m.key === 'cards') {
        return (
          <span className="inline-flex items-center justify-end gap-1.5" title={`${r.yellow} amarillas, ${r.red} rojas`}>
            {r.red > 0 && (
              <span className="inline-flex items-center gap-0.5 text-2xs text-ink-3">
                <span className="h-2.5 w-[7px] rounded-[1px] bg-loss" aria-hidden="true" />
                {r.red}
                <span className="sr-only">rojas,</span>
              </span>
            )}
            <span>{fmtMetric(v, m.key, mode)}</span>
          </span>
        );
      }
      return fmtMetric(v, m.key, mode);
    },
  }));

  const cols: Col[] = [
    {
      key: 'form',
      header: 'Forma',
      title: METRIC_TITLE.form,
      numeric: true,
      cell: (r) => (
        <span className="inline-flex items-center justify-end gap-2.5">
          <FormTrend values={r.formTrend ?? []} width={58} height={22} name={r.player.name} className="hidden sm:block" />
          <span className="w-7 text-right text-[14px] font-bold text-ink-1">{int(r.formIndex)}</span>
        </span>
      ),
    },
    { key: 'apps', header: 'PJ', title: 'Partidos jugados', numeric: true, cell: (r) => int(r.apps) },
    { key: 'minutes', header: 'Min', title: 'Minutos jugados', numeric: true, cell: (r) => int(r.minutes) },
    ...metricCols,
  ];

  const thBase = 'sticky top-0 z-20 whitespace-nowrap border-b border-line bg-surface-2 px-3 py-2.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3';
  const sortIcon = (k: SortKey) =>
    sort.key === k ? (
      sort.dir === 'asc' ? <ArrowUp className="h-3 w-3 text-accent-text" aria-hidden="true" /> : <ArrowDown className="h-3 w-3 text-accent-text" aria-hidden="true" />
    ) : (
      <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden="true" />
    );
  const ariaSort = (k: SortKey) => (sort.key === k ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');

  return (
    <div
      ref={ref}
      className={cx('relative overflow-auto rounded-card border border-line bg-surface-1/90', className)}
      style={maxHeight !== undefined ? { maxHeight } : undefined}
      role="region"
      aria-label={caption}
      tabIndex={0}
    >
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <caption className="sr-only">{caption}. Pulsa en un jugador para ver su detalle y sus últimos partidos.</caption>
        <thead>
          <tr>
            <th scope="col" aria-sort={ariaSort('name')} className={cx(thBase, 'left-0 z-30 min-w-[188px] text-left sm:min-w-[240px]')}>
              <button type="button" onClick={() => onSort('name')} className={cx('inline-flex items-center gap-1 uppercase hover:text-ink-1', sort.key === 'name' && 'text-ink-1')} aria-label="Ordenar por nombre del jugador">
                <span className="mr-2 inline-block w-6 text-right">#</span>
                Jugador
                {sortIcon('name')}
              </button>
            </th>
            {cols.map((c) => (
              <th key={c.key} scope="col" aria-sort={ariaSort(c.key)} title={c.title} className={cx(thBase, 'text-right', sort.key === c.key && 'text-ink-1')}>
                <button type="button" onClick={() => onSort(c.key)} className="inline-flex flex-row-reverse items-center gap-1 uppercase hover:text-ink-1" aria-label={`Ordenar por ${c.title.toLowerCase()}`}>
                  {c.header}
                  {sortIcon(c.key)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={cols.length + 1} className="px-3 py-10 text-center text-ink-3">
                Ningún jugador coincide con los filtros.
              </td>
            </tr>
          )}
          {rows.map((r, i) => {
            const k = rowKey(r);
            const open = expanded === k;
            const detailId = `jug-detalle-${k}`;
            const tdBase = cx('border-b border-line/70 px-3 py-2 transition-colors', open ? 'bg-surface-2' : 'group-hover:bg-surface-2');
            return (
              <Fragment key={k}>
                <tr className="group cursor-pointer" onClick={() => onToggle(k)}>
                  <th scope="row" className={cx(tdBase, 'sticky left-0 z-10 text-left font-normal', open ? 'bg-surface-2' : 'bg-surface-1')}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="num w-6 shrink-0 text-right text-[11px] font-semibold text-ink-3">{i + 1}</span>
                      <TeamCrest team={r.team} size={22} />
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-controls={open ? detailId : undefined}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggle(k);
                        }}
                        className="group/btn flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left"
                      >
                        <span className="min-w-0">
                          <span className="block max-w-[150px] truncate font-semibold text-ink-1 group-hover/btn:underline sm:max-w-[200px]" title={r.player.name}>
                            {r.player.name}
                          </span>
                          <span className="flex min-w-0 items-center gap-1.5 text-2xs text-ink-3">
                            <PositionTag position={r.player.position} />
                            <span className="max-w-[90px] truncate sm:max-w-[120px]">{r.team.short || r.team.name}</span>
                            {showComp && <CompFlag compId={r.compId} />}
                          </span>
                        </span>
                        <ChevronDown className={cx('ml-auto h-4 w-4 shrink-0 text-ink-3 transition-transform', open && 'rotate-180 text-ink-1')} aria-hidden="true" />
                        <span className="sr-only">{open ? 'Ocultar detalle' : 'Ver detalle'}</span>
                      </button>
                    </span>
                  </th>
                  {cols.map((c) => (
                    <td key={c.key} className={cx(tdBase, 'num whitespace-nowrap text-right', sort.key === c.key ? 'text-ink-1' : 'text-ink-2', sort.key === c.key && !open && 'bg-surface-2/40')}>
                      {c.cell(r)}
                    </td>
                  ))}
                </tr>
                {open && (
                  <tr id={detailId}>
                    <td colSpan={cols.length + 1} className="border-b border-line bg-surface-2/40 p-0">
                      <div className="sticky left-0 animate-fade-up" style={{ width: Math.max(280, width) }}>
                        <PlayerDetail row={r} peers={peers} />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
