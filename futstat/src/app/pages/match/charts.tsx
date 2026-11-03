/**
 * Gráficos propios de la página de partido (SVG sin librerías, mismas reglas que src/app/components):
 * columnas finas (≤24px) con extremo redondeado de 4px y base recta, hueco de 2px, rejilla hairline,
 * tooltip por marca con ratón y teclado (←/→) y una tabla equivalente para lectores de pantalla.
 */
import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cx } from '../../components';
import { useElementWidth } from '../../lib/hooks';
import { fairOddsFromProb, pct } from '../../lib/format';
import { fmtLine, overProb } from './utils';

export interface DistColumnsProps {
  /** P(X = k), k = 0..n-1 */
  dist: number[];
  /** índices [desde, hasta] a dibujar (por defecto todos) */
  range?: [number, number];
  /** etiqueta de k ("3", "6+") */
  kLabel?: (k: number) => string;
  /** sustantivo para el tooltip: "goles", "córners" */
  unit: string;
  /** línea de over/under a marcar (p. ej. 9.5) */
  line?: number;
  /** descripción accesible del gráfico */
  ariaLabel: string;
  /** alto del área de trazado (sin el eje) */
  height?: number;
  className?: string;
}

const AXIS_H = 20;
const TOP_PAD = 30;

/** Columnas de una distribución discreta con la línea O/U marcada (más = acento, menos = gris). */
export function DistColumns({ dist, range, kLabel = (k) => String(k), unit, line, ariaLabel, height = 120, className }: DistColumnsProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(420);
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  const [lo, hi] = range ?? [0, Math.max(0, dist.length - 1)];
  const ks = useMemo(() => Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i), [lo, hi]);
  const vmax = Math.max(1e-9, ...ks.map((k) => dist[k] ?? 0));
  const modeK = ks.reduce((b, k) => ((dist[k] ?? 0) > (dist[b] ?? 0) ? k : b), ks[0] ?? 0);

  if (!ks.length) return <div className={cx('text-[12px] text-ink-3', className)}>Sin datos suficientes</div>;

  const n = ks.length;
  const slot = width / n;
  const gap = Math.max(2, slot * 0.22);
  const barW = Math.max(2, Math.min(24, slot - gap));
  const plotH = height;
  const totalH = TOP_PAD + plotH + AXIS_H;
  const cx0 = (k: number) => (k - lo + 0.5) * slot;
  const labelEvery = Math.max(1, Math.ceil(22 / slot));
  const hasLine = typeof line === 'number' && Number.isFinite(line);
  const pOver = hasLine ? overProb(dist, line!) : undefined;

  const colorFor = (k: number) => (!hasLine || k > line! ? 'rgb(var(--c-seq))' : 'rgb(var(--c-ink-3) / 0.42)');

  const bar = (k: number) => {
    const p = dist[k] ?? 0;
    const h = (p / vmax) * plotH;
    if (h <= 0.25) return null;
    const x = cx0(k) - barW / 2;
    const y = TOP_PAD + plotH - h;
    const r = Math.min(4, barW / 2, h);
    const d = `M${x},${TOP_PAD + plotH}V${y + r}Q${x},${y} ${x + r},${y}H${x + barW - r}Q${x + barW},${y} ${x + barW},${y + r}V${TOP_PAD + plotH}Z`;
    return <path key={k} d={d} fill={colorFor(k)} />;
  };

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - rect.left) / rect.width) * n);
    setActive(lo + Math.max(0, Math.min(n - 1, i)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Escape') return setActive(null);
    const cur = active ?? modeK;
    if (e.key === 'ArrowLeft') setActive(Math.max(lo, cur - 1));
    if (e.key === 'ArrowRight') setActive(Math.min(hi, cur + 1));
    if (e.key === 'Home') setActive(lo);
    if (e.key === 'End') setActive(hi);
  };

  const tipText = (k: number) => `${kLabel(k)} ${unit}: ${pct(dist[k] ?? 0, 1)}`;
  const tipLeft = active !== null ? Math.max(56, Math.min(width - 56, cx0(active))) : 0;

  return (
    <figure className={cx('relative m-0 min-w-0', className)}>
      <figcaption className="sr-only">{ariaLabel}</figcaption>
      <div
        ref={ref}
        className="relative cursor-crosshair touch-pan-y rounded-md focus-visible:outline-offset-2"
        tabIndex={0}
        role="group"
        aria-label={`${ariaLabel}. Usa las flechas para recorrer los valores.`}
        aria-describedby={tableId}
        onPointerMove={onMove}
        onPointerLeave={() => setActive(null)}
        onKeyDown={onKey}
        onFocus={() => setActive((a) => a ?? modeK)}
        onBlur={() => setActive(null)}
      >
        <svg width={width} height={totalH} viewBox={`0 0 ${width} ${totalH}`} className="block overflow-visible" aria-hidden="true">
          {/* rejilla: base + mitad */}
          <line x1={0} x2={width} y1={TOP_PAD + plotH + 0.5} y2={TOP_PAD + plotH + 0.5} stroke="rgb(var(--c-line-strong))" strokeWidth={1} />
          <line x1={0} x2={width} y1={TOP_PAD + plotH / 2 + 0.5} y2={TOP_PAD + plotH / 2 + 0.5} stroke="rgb(var(--c-line))" strokeWidth={1} />
          {active !== null && (
            <rect x={cx0(active) - slot / 2} y={TOP_PAD - 4} width={slot} height={plotH + 4} rx={4} fill="rgb(var(--c-surface-3))" opacity={0.75} />
          )}
          {ks.map(bar)}
          {/* etiqueta del máximo (selectiva) */}
          {(dist[modeK] ?? 0) > 0 && active === null && (
            <text x={cx0(modeK)} y={TOP_PAD + plotH - ((dist[modeK] ?? 0) / vmax) * plotH - 5} textAnchor="middle" className="num" fontSize={10} fill="rgb(var(--c-ink-2))">
              {pct(dist[modeK] ?? 0)}
            </text>
          )}
          {hasLine && line! >= lo - 0.5 && line! <= hi + 0.5 && (
            <g>
              <line x1={cx0(line!)} x2={cx0(line!)} y1={TOP_PAD - 2} y2={TOP_PAD + plotH} stroke="rgb(var(--c-ink-1))" strokeWidth={1} />
              <rect x={cx0(line!) - 17} y={0} width={34} height={15} rx={4} fill="rgb(var(--c-ink-1))" />
              <text x={cx0(line!)} y={11} textAnchor="middle" fontSize={10} fontWeight={600} className="num" fill="rgb(var(--c-bg))">
                {fmtLine(line!)}
              </text>
            </g>
          )}
          {ks.map((k, i) =>
            i % labelEvery === 0 || k === hi ? (
              <text key={k} x={cx0(k)} y={TOP_PAD + plotH + 14} textAnchor="middle" fontSize={10} className="num" fill={active === k ? 'rgb(var(--c-ink-1))' : 'rgb(var(--c-ink-3))'}>
                {kLabel(k)}
              </text>
            ) : null,
          )}
        </svg>
        {active !== null && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-line-strong bg-surface-2 px-2.5 py-1.5 text-[12px] shadow-pop"
            style={{ left: tipLeft, top: Math.max(0, TOP_PAD + plotH - ((dist[active] ?? 0) / vmax) * plotH - 58) }}
          >
            <div className="num text-[14px] font-semibold leading-tight text-ink-1">{pct(dist[active] ?? 0, 1)}</div>
            <div className="whitespace-nowrap text-ink-2">
              {kLabel(active)} {unit} · cuota justa <span className="num text-ink-1">{fairOddsFromProb(dist[active] ?? 0)}</span>
            </div>
          </div>
        )}
        <span className="sr-only" aria-live="polite">
          {active !== null ? tipText(active) : ''}
        </span>
      </div>
      {hasLine && pOver !== undefined && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: 'rgb(var(--c-seq))' }} aria-hidden="true" />
            Más de {fmtLine(line!)} <span className="num font-semibold text-ink-1">{pct(pOver)}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: 'rgb(var(--c-ink-3) / 0.42)' }} aria-hidden="true" />
            Menos de {fmtLine(line!)} <span className="num font-semibold text-ink-1">{pct(1 - pOver)}</span>
          </span>
        </div>
      )}
      <div id={tableId} className="sr-only">
      <table>
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">{unit}</th>
            <th scope="col">Probabilidad</th>
          </tr>
        </thead>
        <tbody>
          {ks.map((k) => (
            <tr key={k}>
              <th scope="row">{kLabel(k)}</th>
              <td>{pct(dist[k] ?? 0, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </figure>
  );
}

export interface SplitBarProps {
  /** valores [local, visitante] (≥0) */
  home: number;
  away: number;
  className?: string;
  /** alto px */
  height?: number;
}

/** Barra fina partida local/visitante (proporción de la suma) — figura, sin texto. */
export function SplitBar({ home, away, className, height = 6 }: SplitBarProps) {
  const t = Math.max(0, home) + Math.max(0, away);
  const h = t > 0 ? Math.max(0, home) / t : 0.5;
  return (
    <div className={cx('flex w-full gap-[2px]', className)} style={{ height }} aria-hidden="true">
      <div className="rounded-l-full bg-home" style={{ width: `${h * 100}%` }} />
      <div className="flex-1 rounded-r-full bg-away" />
    </div>
  );
}
