import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useElementWidth } from '../lib/hooks';
import { dayMonth, num, shortDate } from '../lib/format';
import { niceTicks } from '../lib/ticks';
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

// ---------------------------------------------------------------------------
// Eje X temporal: marcas en fechas "redondas" (días, semanas, meses), no en índices de datos
// ---------------------------------------------------------------------------
const DAY_MS = 86_400_000;
type TimeStep = { unit: 'day' | 'month'; n: number };
const TIME_STEPS: TimeStep[] = [
  { unit: 'day', n: 1 },
  { unit: 'day', n: 2 },
  { unit: 'day', n: 3 },
  { unit: 'day', n: 7 },
  { unit: 'day', n: 14 },
  { unit: 'month', n: 1 },
  { unit: 'month', n: 2 },
  { unit: 'month', n: 3 },
  { unit: 'month', n: 6 },
  { unit: 'month', n: 12 },
];
const stepMs = (s: TimeStep) => (s.unit === 'day' ? s.n * DAY_MS : s.n * 30.44 * DAY_MS);
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];

/** Marcas temporales entre lo y hi (epoch ms) con como mucho `maxTicks`, alineadas a días/lunes/meses. */
export function timeTicks(lo: number, hi: number, maxTicks: number): { ticks: number[]; step: TimeStep } {
  const span = Math.max(0, hi - lo);
  const step = TIME_STEPS.find((s) => span / stepMs(s) <= Math.max(1, maxTicks)) ?? TIME_STEPS[TIME_STEPS.length - 1];
  const ticks: number[] = [];
  const d = new Date(lo);
  // Fecha fuera del rango representable (Invalid Date): getDay()/getMonth() darían NaN y los bucles no acabarían.
  if (!Number.isFinite(d.getTime()) || !Number.isFinite(hi)) return { ticks, step };
  d.setHours(0, 0, 0, 0);
  if (step.unit === 'day') {
    if (d.getTime() < lo) d.setDate(d.getDate() + 1);
    if (step.n >= 7) for (let g = 0; g < 7 && d.getDay() !== 1; g++) d.setDate(d.getDate() + 1); // semanas: lunes
    for (let guard = 0; d.getTime() <= hi && guard < 400; guard++) {
      ticks.push(d.getTime());
      d.setDate(d.getDate() + step.n);
    }
  } else {
    d.setDate(1);
    if (d.getTime() < lo) d.setMonth(d.getMonth() + 1);
    for (let g = 0; g < 12 && d.getMonth() % step.n !== 0; g++) d.setMonth(d.getMonth() + 1);
    for (let guard = 0; d.getTime() <= hi && guard < 400; guard++) {
      ticks.push(d.getTime());
      d.setMonth(d.getMonth() + step.n);
    }
  }
  return { ticks, step };
}

/** Etiqueta de una marca temporal según el paso: "4 nov" (días/semanas) o "nov" / "jul 2025" (meses). */
function timeTickLabel(t: number, step: TimeStep, multiYear: boolean): string {
  const d = new Date(t);
  if (step.unit === 'day') return dayMonth(d);
  const m = MONTHS[d.getMonth()];
  // año completo para que "jul 2025" no se lea como "25 de julio"
  return multiYear || step.n >= 12 ? `${m} ${d.getFullYear()}` : m;
}

/** Ancho aproximado (px) de una etiqueta del eje a 10,5 px. */
const labelWidth = (s: string) => s.length * 6.2 + 6;

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
    // Rango prácticamente nulo (serie constante o diferencias por debajo de la precisión de coma flotante,
    // p. ej. 1500 y 1500.0000000000002): se trata como constante y se rellena en proporción al valor.
    const span = yhi - ylo;
    const flat = !(span > Math.max(Math.abs(ylo), Math.abs(yhi)) * 1e-9);
    const padY = flat ? Math.abs(yhi) * 0.05 || 1 : span * 0.12;
    ylo -= padY;
    yhi += padY;
  }
  // Valores desbordados (±1e308…) no se pueden escalar: mejor un aviso que un SVG con coordenadas NaN.
  if (!Number.isFinite(ylo) || !Number.isFinite(yhi) || !(yhi > ylo)) return <div className={cx('text-[12px] text-ink-3', className)}>Sin datos suficientes</div>;
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

  // Marcas del eje X. Fechas: por TIEMPO (días/semanas/meses redondos), así la separación refleja el calendario.
  // Números: valores de los datos repartidos. En ambos casos se descartan las etiquetas que se solaparían.
  const xTickCount = Math.max(2, Math.min(10, Math.floor(iw / (isDate ? 64 : 72))));
  let rawTicks: { x: number; label: string }[];
  if (isDate) {
    const { ticks, step } = timeTicks(xlo, xhi, xTickCount);
    const multiYear = new Date(xlo).getFullYear() !== new Date(xhi).getFullYear();
    rawTicks = (ticks.length ? ticks : [xlo]).map((t) => ({ x: t, label: timeTickLabel(t, step, multiYear) }));
  } else {
    const picked = xs.length <= xTickCount ? xs : Array.from({ length: xTickCount }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (xTickCount - 1))]);
    rawTicks = [...new Set(picked)].map((x) => ({ x, label: fmtX(x) }));
  }
  const xTicks: { x: number; label: string; cx: number }[] = [];
  let prevRight = -Infinity;
  for (const t of rawTicks) {
    const w = labelWidth(t.label);
    // centro de la etiqueta, desplazado lo justo para no salirse del área del gráfico
    const cxl = Math.min(Math.max(sx(t.x), m.l + w / 2 - 4), W - m.r - w / 2 + 4);
    if (cxl - w / 2 < prevRight + 8) continue;
    xTicks.push({ ...t, cx: cxl });
    prevRight = cxl + w / 2;
  }

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
          {xTicks.map((t, i) => (
            <g key={`${t.x}-${i}`}>
              {isDate && <line x1={sx(t.x)} x2={sx(t.x)} y1={m.t + height} y2={m.t + height + 4} stroke="rgb(var(--c-line-strong))" strokeWidth={1} />}
              <text x={t.cx} y={H - 6} textAnchor="middle" className="fill-ink-3 text-[10.5px]">
                {t.label}
              </text>
            </g>
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
