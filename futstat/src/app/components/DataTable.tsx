import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cx } from './Card';

export interface Column<R> {
  /** id único de la columna (también clave de orden) */
  key: string;
  /** cabecera visible (corta) */
  header: ReactNode;
  /** texto completo de la cabecera (tooltip + aria) cuando header es una abreviatura */
  title?: string;
  /** contenido de la celda; por defecto row[key] */
  cell?: (row: R, index: number) => ReactNode;
  /** valor para ordenar; si falta, la columna no es ordenable */
  sortValue?: (row: R) => number | string | undefined | null;
  /** columna numérica → alineada a la derecha y monoespaciada */
  numeric?: boolean;
  align?: 'left' | 'right' | 'center';
  /** fija la columna a la izquierda en scroll horizontal (normalmente la del nombre) */
  sticky?: boolean;
  /** ancho CSS (p. ej. '3rem', 160) */
  width?: string | number;
  /** dirección inicial al pulsar por primera vez (por defecto 'desc' en numéricas) */
  firstDir?: 'asc' | 'desc';
  className?: string;
  /** ocultar por debajo de un breakpoint: 'sm' | 'md' | 'lg' */
  hideBelow?: 'sm' | 'md' | 'lg';
}

export interface DataTableProps<R> {
  columns: Column<R>[];
  rows: R[];
  rowKey: (row: R, index: number) => string;
  /** orden inicial */
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  /** altura máxima con scroll vertical y cabecera fija (p. ej. 560) */
  maxHeight?: number | string;
  dense?: boolean;
  /** enlace por fila (fila clicable + Enter) */
  rowHref?: (row: R) => string | undefined;
  onRowClick?: (row: R) => void;
  /** clases extra por fila (resaltar el equipo actual, zonas…) */
  rowClassName?: (row: R, index: number) => string | undefined;
  /** título accesible de la tabla (se renderiza como caption oculto) */
  caption: string;
  emptyText?: string;
  className?: string;
}

const HIDE = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' } as const;

/**
 * Tabla de datos ordenable con cabecera fija, numéricas a la derecha (tabulares) y scroll
 * horizontal en móvil (con primera columna opcionalmente fija).
 */
export function DataTable<R>({
  columns,
  rows,
  rowKey,
  initialSort,
  maxHeight,
  dense,
  rowHref,
  onRowClick,
  rowClassName,
  caption,
  emptyText = 'Sin datos',
  className,
}: DataTableProps<R>) {
  const [sort, setSort] = useState(initialSort);
  const navigate = useNavigate();

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const sv = col.sortValue;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = sv(a);
      const vb = sv(b);
      const na = va === undefined || va === null || (typeof va === 'number' && !Number.isFinite(va));
      const nb = vb === undefined || vb === null || (typeof vb === 'number' && !Number.isFinite(vb));
      if (na && nb) return 0;
      if (na) return 1; // vacíos siempre al final
      if (nb) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb), 'es') * dir;
    });
  }, [rows, sort, columns]);

  const toggle = (c: Column<R>) => {
    if (!c.sortValue) return;
    setSort((s) => {
      if (s?.key === c.key) return { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' };
      return { key: c.key, dir: c.firstDir ?? (c.numeric ? 'desc' : 'asc') };
    });
  };

  const py = dense ? 'py-1.5' : 'py-2.5';
  const clickable = !!rowHref || !!onRowClick;

  return (
    <div
      className={cx('relative overflow-auto rounded-card border border-line bg-surface-1/90', className)}
      style={maxHeight !== undefined ? { maxHeight } : undefined}
      tabIndex={0}
      role="region"
      aria-label={caption}
    >
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const align = c.align ?? (c.numeric ? 'right' : 'left');
              const ariaSort = active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : c.sortValue ? 'none' : undefined;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={ariaSort}
                  title={c.title}
                  style={{ width: c.width }}
                  className={cx(
                    'sticky top-0 z-20 whitespace-nowrap border-b border-line bg-surface-2 px-3 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3',
                    dense ? 'py-2' : 'py-2.5',
                    align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left',
                    c.sticky && 'left-0 z-30',
                    c.hideBelow && HIDE[c.hideBelow],
                    c.className,
                  )}
                >
                  {c.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggle(c)}
                      className={cx('inline-flex items-center gap-1 uppercase hover:text-ink-1', active && 'text-ink-1', align === 'right' && 'flex-row-reverse')}
                      aria-label={`Ordenar por ${c.title ?? (typeof c.header === 'string' ? c.header : c.key)}`}
                    >
                      {c.header}
                      {active ? (
                        sort!.dir === 'asc' ? <ArrowUp className="h-3 w-3 text-accent-text" aria-hidden="true" /> : <ArrowDown className="h-3 w-3 text-accent-text" aria-hidden="true" />
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden="true" />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-ink-3">
                {emptyText}
              </td>
            </tr>
          )}
          {sorted.map((r, i) => {
            const href = rowHref?.(r);
            const go = () => (href ? navigate(href) : onRowClick?.(r));
            return (
              <tr
                key={rowKey(r, i)}
                onClick={clickable ? go : undefined}
                onKeyDown={clickable ? (e) => e.key === 'Enter' && go() : undefined}
                tabIndex={clickable ? 0 : undefined}
                className={cx('group', clickable && 'cursor-pointer', rowClassName?.(r, i))}
              >
                {columns.map((c) => {
                  const align = c.align ?? (c.numeric ? 'right' : 'left');
                  const content = c.cell ? c.cell(r, i) : ((r as Record<string, unknown>)[c.key] as ReactNode);
                  return (
                    <td
                      key={c.key}
                      className={cx(
                        'border-b border-line/70 px-3 transition-colors group-last:border-b-0 group-hover:bg-surface-2',
                        py,
                        align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left',
                        c.numeric && 'num whitespace-nowrap',
                        c.sticky && 'sticky left-0 z-10 bg-surface-1',
                        c.hideBelow && HIDE[c.hideBelow],
                        c.className,
                      )}
                    >
                      {content}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
