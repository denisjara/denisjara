import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useElementWidth } from '../lib/hooks';
import { num, shortDate } from '../lib/format';
import { cx } from './Card';

export interface LinePoint {
  /** número o fecha ISO */
  x: number | string;
  y: number;
}

export interface LineSeries {
  id: string;
  label: string;
  points: LinePoint[];
  /** color CSS; por defecto la paleta de series (acento, local, visitante, tinta) */
  color?: string;
}

export interface LineChartProps {
  series: LineSeries[];
  /** alto del área de trazado (los ejes se suman aparte) */
  height?: number;
  yFormat?: (v: number) => string;
  /** formato del eje X (por defecto fecha corta si x es fecha) */
  xFormat?: (x: number) => string;
  yDomain?: [number, number];
  /** líneas de referencia horizontales (media de liga, 50%...) */
  refLines?: { y: number; label: string }[];
  /** relleno suave bajo la línea (solo con una serie) */
  area?: boolean;
  /** descripción accesible del gráfico */
  ariaLabel: string;
  className?: string;
}

export const SERIES_COLORS = ['rgb(var(--c-accent-text))', 'rgb(var(--c-home))', 'rgb(var(--c-away))', 'rgb(var(--c-ink-2))'];

function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 1e-6; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/**
 * Gráfico de líneas SVG propio: líneas de 2px, rejilla hairline, cruz que se ajusta al X más
 * cercano y tooltip con todas las series. Teclado: ←/→ recorre los puntos. Leyenda si ≥2 series.
 */
export function LineChart({ series, height = 180, yFormat = (v) => num(v, 0), xFormat, yDomain, refLines, area, ariaLabel, className }: LineChartProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(560);
  const [hover, setHover] = useState<number | null>(null);

  const isDate = series.some((s) => s.points.some((p) => typeof p.x === 'string'));
  const toX = (x: number | string) => (typeof x === 'string' ? new Date(x).getTime() : x);
  const fmtX = xFormat ?? ((x: number) => (isDate ? shortDate(x) : num(x, 0)));

  const prepared = useMemo(
    () =>
      series.map((s, i) => ({
        ...s,
        color: s.color ?? SERIES_COLORS[i % SERIES_COLORS.length],
        pts: s.points.map((p) => ({ x: toX(p.x), y: p.y })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series],
  );
  const xs = useMemo(() => [...new Set(prepared.flatMap((s) => s.pts.map((p) => p.x)))].sort((a, b) => a - b), [prepared]);
  const allY = prepared.flatMap((s) => s.pts.map((p) => p.y)).concat((refLines ?? []).map((r) => r.y));
  if (!xs.length || !allY.length) return <div className={cx('text-[12px] text-ink-3', className)}>Sin datos suficientes</div>;

  let [ylo, yhi] = yDomain ?? [Math.min(...allY), Math.max(...allY)];
  if (!yDomain) {
    const padY = (yhi - ylo) * 0.12 || Math.abs(yhi) * 0.05 || 1;
    ylo -= padY;
    yhi += padY;
  }
  const ticks = niceTicks(ylo, yhi, 4);
  const yLabelW = Math.max(28, ...ticks.map((t) => yFormat(t).length * 7 + 8));
  const m = { l: yLabelW, r: 12, t: 8, b: 24 };
  const W = Math.max(200, width);
  const H = height + m.t + m.b;
  const iw = W - m.l - m.r;
  const xlo = xs[0];
  const xhi = xs[xs.length - 1];
  const sx = (x: number) => m.l + (xhi === xlo ? iw / 2 : ((x - xlo) / (xhi - xlo)) * iw);
  const sy = (y: number) => m.t + (1 - (y - ylo) / (yhi - ylo || 1)) * height;

  const xTickCount = Math.max(2, Math.min(6, Math.floor(iw / 90)));
  const xTicks = xs.length <= xTickCount ? xs : Array.from({ length: xTickCount }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (xTickCount - 1))]);

  const nearestIndex = (px: number) => {
    let best = 0;
    let bd = Infinity;
    xs.forEach((x, i) => {
      const d = Math.abs(sx(x) - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    setHover(nearestIndex(((e.clientX - rect.left) / rect.width) * W));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') setHover((h) => Math.min(xs.length - 1, (h ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? xs.length) - 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };

  const hx = hover !== null ? xs[hover] : null;
  const readout =
    hx !== null
      ? prepared.map((s) => {
          let best = s.pts[0];
          for (const p of s.pts) if (Math.abs(p.x - hx) < Math.abs(best.x - hx)) best = p;
          return { s, p: best, exact: best && best.x === hx };
        })
      : [];
  const tipLeft = hx !== null ? sx(hx) : 0;

  return (
    <div className={cx('w-full', className)}>
      {prepared.length >= 2 && (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
          {prepared.map((s) => (
            <li key={s.id} className="inline-flex items-center gap-1.5">
              <span className="h-[2px] w-3.5 rounded-full" style={{ background: s.color }} aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div ref={ref} className="relative w-full">
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          className="block max-w-full overflow-visible focus-visible:outline-offset-4"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.l} x2={W - m.r} y1={sy(t)} y2={sy(t)} stroke="rgb(var(--c-line))" strokeWidth={1} />
              <text x={m.l - 8} y={sy(t)} dy="0.32em" textAnchor="end" className="fill-ink-3 font-mono text-[10.5px]">
                {yFormat(t)}
              </text>
            </g>
          ))}
          {(refLines ?? []).map((r) => (
            <g key={r.label}>
              <line x1={m.l} x2={W - m.r} y1={sy(r.y)} y2={sy(r.y)} stroke="rgb(var(--c-ink-3))" strokeWidth={1} opacity={0.7} />
              <text x={W - m.r} y={sy(r.y) - 4} textAnchor="end" className="fill-ink-3 text-[10.5px]">
                {r.label}
              </text>
            </g>
          ))}
          {xTicks.map((x, i) => (
            <text
              key={`${x}-${i}`}
              x={sx(x)}
              y={H - 6}
              textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
              className="fill-ink-3 text-[10.5px]"
            >
              {fmtX(x)}
            </text>
          ))}
          {prepared.map((s) => {
            if (!s.pts.length) return null;
            const d = s.pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
            const last = s.pts[s.pts.length - 1];
            return (
              <g key={s.id}>
                {area && prepared.length === 1 && (
                  <path d={`${d}L${sx(last.x).toFixed(1)},${m.t + height}L${sx(s.pts[0].x).toFixed(1)},${m.t + height}Z`} fill={s.color} opacity={0.1} />
                )}
                <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                <circle cx={sx(last.x)} cy={sy(last.y)} r={4} fill={s.color} stroke="rgb(var(--c-surface-1))" strokeWidth={2} />
              </g>
            );
          })}
          {hx !== null && (
            <g pointerEvents="none">
              <line x1={sx(hx)} x2={sx(hx)} y1={m.t} y2={m.t + height} stroke="rgb(var(--c-ink-3))" strokeWidth={1} />
              {readout.map(({ s, p }) =>
                p ? <circle key={s.id} cx={sx(p.x)} cy={sy(p.y)} r={4.5} fill={s.color} stroke="rgb(var(--c-surface-1))" strokeWidth={2} /> : null,
              )}
            </g>
          )}
          <rect
            x={m.l}
            y={m.t}
            width={iw}
            height={height}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hx !== null && (
          <div
            className="pointer-events-none absolute top-0 z-20 min-w-[120px] rounded-lg border border-line-strong bg-surface-2 px-2.5 py-2 text-[12px] shadow-pop"
            style={{ left: Math.min(Math.max(tipLeft + 12, 0), W - 160) }}
            aria-hidden="true"
          >
            <div className="mb-1 text-2xs text-ink-3">{fmtX(hx)}</div>
            {readout.map(({ s, p }) =>
              p ? (
                <div key={s.id} className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-1.5 text-ink-2">
                    <span className="h-[2px] w-3 rounded-full" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <span className="num font-semibold text-ink-1">{yFormat(p.y)}</span>
                </div>
              ) : null,
            )}
          </div>
        )}
      </div>
    </div>
  );
}
