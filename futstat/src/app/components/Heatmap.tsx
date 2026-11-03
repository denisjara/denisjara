import { useState, type ReactNode } from 'react';
import { seqFill } from '../lib/colors';
import { pct } from '../lib/format';
import { cx } from './Card';

export interface HeatmapProps {
  /** etiquetas de filas (p. ej. goles local 0..7 o nombres de equipo) */
  rows: ReactNode[];
  /** etiquetas de columnas */
  cols: ReactNode[];
  /** valores[fila][columna] */
  values: number[][];
  /** formato del valor dentro de la celda y en el tooltip (por defecto %, 1 decimal si cabe) */
  format?: (v: number) => string;
  /** título del eje de filas / columnas */
  rowTitle?: string;
  colTitle?: string;
  /** valor que satura la escala (por defecto el máximo) */
  max?: number;
  /** oculta el texto de celdas por debajo de este valor (por defecto 1% del máximo… usa 0 para mostrar todo) */
  minLabel?: number;
  /** marca la celda máxima con un anillo */
  highlightMax?: boolean;
  /** tamaño mínimo de celda en px */
  cellSize?: number;
  /** texto de ayuda para lectores / tooltip: (fila, col, valor) → texto */
  describe?: (r: number, c: number, v: number) => string;
  /** título accesible (caption) */
  caption: string;
  /** ancho de la columna de etiquetas de fila */
  rowLabelWidth?: number;
  className?: string;
}

/**
 * Matriz de calor secuencial de un solo tono (acento). Se renderiza como <table> HTML: es a la vez
 * gráfico y "vista de tabla" accesible. Úsala para marcador exacto (8×8) y distribución de posiciones.
 */
export function Heatmap({
  rows,
  cols,
  values,
  format,
  rowTitle,
  colTitle,
  max,
  minLabel,
  highlightMax = true,
  cellSize = 34,
  describe,
  caption,
  rowLabelWidth,
  className,
}: HeatmapProps) {
  // por defecto: 1 decimal solo si cabe (celdas ≥ 34px) y el valor es < 9,5%
  const fmt = format ?? ((v: number) => pct(v, cellSize >= 34 && v < 0.095 ? 1 : 0));
  const flat = values.flat().filter((v) => Number.isFinite(v));
  const vmax = max ?? Math.max(1e-9, ...flat);
  const threshold = minLabel ?? vmax * 0.02;
  let maxR = -1;
  let maxC = -1;
  if (highlightMax) {
    let best = -Infinity;
    values.forEach((row, r) =>
      row.forEach((v, c) => {
        if (v > best) {
          best = v;
          maxR = r;
          maxC = c;
        }
      }),
    );
  }
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);

  return (
    <div className={cx('relative max-w-full overflow-x-auto', className)}>
      <table className="border-separate border-spacing-[2px] text-[11px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          {colTitle && (
            <tr>
              <th aria-hidden="true" />
              <th colSpan={cols.length} scope="colgroup" className="pb-1 text-center text-2xs font-semibold uppercase tracking-[0.1em] text-ink-3">
                {colTitle}
              </th>
            </tr>
          )}
          <tr>
            <th scope="col" className="px-1 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3" style={{ width: rowLabelWidth }}>
              {rowTitle && <span className="sr-only">{rowTitle}</span>}
            </th>
            {cols.map((c, i) => (
              <th key={i} scope="col" className="num px-0.5 pb-0.5 text-center text-2xs font-medium text-ink-3" style={{ minWidth: cellSize }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {values.map((row, r) => (
            <tr key={r}>
              <th scope="row" className="whitespace-nowrap pr-1.5 text-right text-2xs font-medium text-ink-2" style={{ width: rowLabelWidth }}>
                {rows[r]}
              </th>
              {row.map((v, c) => {
                const t = Math.sqrt(Math.max(0, v) / vmax); // raíz: realza diferencias en valores pequeños
                const fill = seqFill(t);
                const isMax = r === maxR && c === maxC;
                const label = describe ? describe(r, c, v) : fmt(v);
                return (
                  <td
                    key={c}
                    tabIndex={-1}
                    title={label}
                    onPointerEnter={() => setHover({ r, c })}
                    onPointerLeave={() => setHover(null)}
                    className={cx(
                      'num rounded-[4px] p-0 text-center align-middle font-medium transition-[box-shadow]',
                      isMax && 'ring-2 ring-inset ring-ink-1',
                      hover?.r === r && hover?.c === c && 'ring-2 ring-inset ring-accent-text',
                    )}
                    style={{ ...fill, minWidth: cellSize, height: Math.max(24, cellSize * 0.8) }}
                  >
                    {v >= threshold ? fmt(v) : <span className="sr-only">{fmt(v)}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex items-center gap-2 text-2xs text-ink-3" aria-hidden="true">
        <span>Menos</span>
        <span className="h-2 w-28 rounded-full" style={{ background: 'linear-gradient(90deg, rgb(var(--c-seq) / 0.08), rgb(var(--c-seq) / 1))' }} />
        <span>Más</span>
        {rowTitle && colTitle && <span className="ml-2">Filas: {rowTitle} · Columnas: {colTitle}</span>}
      </div>
    </div>
  );
}
