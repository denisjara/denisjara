import { useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { CalibrationBin } from '../../../types/data';
import { cx } from '../../components';
import { token } from '../../lib/colors';
import { useElementWidth } from '../../lib/hooks';
import { int, pct, signedPct } from '../../lib/format';

const GRID = token('line');
const MARK = token('accent-text');
const RING = token('surface-1');
const AXIS = 'fill-ink-3 font-mono text-[10.5px]';

/** Intervalo de Wilson al 95% de una frecuencia observada con n casos (correcto también con 0% o 100%). */
export function binCI(b: CalibrationBin): [number, number] {
  const n = b.n;
  if (!(n > 0)) return [0, 1];
  const p = Math.min(1, Math.max(0, b.observed));
  const z = 1.96;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Error de calibración esperado (ECE): media ponderada por n de |predicho − observado|. */
export function expectedCalibrationError(bins: CalibrationBin[]): number | undefined {
  const n = bins.reduce((s, b) => s + b.n, 0);
  if (!n) return undefined;
  return bins.reduce((s, b) => s + b.n * Math.abs(b.predicted - b.observed), 0) / n;
}

// ---------------------------------------------------------------------------
// Curva de calibración + histograma de casos por tramo
// ---------------------------------------------------------------------------
export function CalibrationPlot({ bins, ariaLabel, className }: { bins: CalibrationBin[]; ariaLabel: string; className?: string }) {
  const [ref, width] = useElementWidth<HTMLDivElement>(480);
  const [hover, setHover] = useState<number | null>(null);
  const pts = bins.filter((b) => b.n > 0).sort((a, b) => a.from - b.from);
  const W = Math.max(280, Math.min(width, 600));
  const m = { l: 44, r: 14, t: 12 };
  const plot = Math.min(W - m.l - m.r, 340);
  const iw = W - m.l - m.r;
  const histH = 52;
  const gap = 30; // eje X del gráfico principal
  const H = m.t + plot + gap + histH + 26;
  const sx = (v: number) => m.l + v * iw;
  const sy = (v: number) => m.t + (1 - v) * plot;
  const hy0 = m.t + plot + gap; // parte superior del histograma
  const maxN = Math.max(1, ...pts.map((b) => b.n));
  const r = (n: number) => 4 + 4.5 * Math.sqrt(n / maxN);
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const MIN_N = 5;
  const solid = pts.filter((b) => b.n >= MIN_N);
  const d = solid.map((b, i) => `${i ? 'L' : 'M'}${sx(b.predicted).toFixed(1)},${sy(b.observed).toFixed(1)}`).join('');
  const biggest = pts.reduce<CalibrationBin | null>((a, b) => (!a || b.n > a.n ? b : a), null);

  const nearest = (px: number) => {
    let best = 0;
    let bd = Infinity;
    pts.forEach((b, i) => {
      const dd = Math.abs(sx((b.from + b.to) / 2) - px);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    });
    return best;
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    if (px < m.l - 10 || px > W - m.r + 10) return setHover(null);
    setHover(nearest(px));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') setHover((h) => Math.min(pts.length - 1, (h ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? pts.length) - 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };
  const hb = hover !== null ? pts[hover] : null;
  const hci = hb ? binCI(hb) : null;

  if (!pts.length) return <p className="text-[13px] text-ink-3">Sin datos de calibración.</p>;

  return (
    <div ref={ref} className={cx('relative w-full', className)}>
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2" aria-label="Leyenda">
        <li className="inline-flex items-center gap-1.5">
          <span className="h-px w-4 bg-ink-3" aria-hidden="true" />
          Calibración perfecta
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: MARK }} aria-hidden="true" />
          Modelo (tamaño = nº de casos)
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span className="h-3 w-px bg-ink-3" aria-hidden="true" />
          IC 95%
        </li>
        {pts.some((b) => b.n < MIN_N) && (
          <li className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full border-[1.5px]" style={{ borderColor: MARK }} aria-hidden="true" />
            Menos de {MIN_N} casos
          </li>
        )}
      </ul>
      <div className="relative">
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={onKey}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        className="block max-w-full overflow-visible focus-visible:outline-offset-4"
      >
        {/* rejilla y ejes */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={m.l + iw} y1={sy(t)} y2={sy(t)} stroke={GRID} strokeWidth={1} />
            <text x={m.l - 6} y={sy(t)} dy="0.32em" textAnchor="end" className={AXIS}>
              {pct(t)}
            </text>
            <text x={sx(t)} y={m.t + plot + 14} textAnchor={t === 0 ? 'start' : t === 1 ? 'end' : 'middle'} className={AXIS}>
              {pct(t)}
            </text>
          </g>
        ))}
        <text x={m.l + iw} y={m.t + plot + 26} textAnchor="end" className="fill-ink-3 text-[10.5px]">
          Probabilidad predicha →
        </text>
        <text x={11} y={m.t + plot / 2} transform={`rotate(-90 11 ${m.t + plot / 2})`} textAnchor="middle" className="fill-ink-3 text-[10.5px]">
          Frecuencia observada →
        </text>
        {/* diagonal = calibración perfecta */}
        <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke={token('ink-3')} strokeWidth={1} />
        {/* banda del tramo activo */}
        {hb && <rect x={sx(hb.from)} y={m.t} width={Math.max(1, sx(hb.to) - sx(hb.from))} height={plot + gap + histH} fill={token('ink-3', 0.08)} />}
        {/* intervalos de confianza */}
        {pts.map((b) => {
          const [lo, hi] = binCI(b);
          return <line key={`ci-${b.from}`} x1={sx(b.predicted)} x2={sx(b.predicted)} y1={sy(lo)} y2={sy(hi)} stroke={token('ink-3')} strokeWidth={1.25} strokeLinecap="round" />;
        })}
        {solid.length > 1 && <path d={d} fill="none" stroke={MARK} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {pts.map((b, i) =>
          b.n >= MIN_N ? (
            <circle key={b.from} cx={sx(b.predicted)} cy={sy(b.observed)} r={r(b.n) + (hover === i ? 1.5 : 0)} fill={MARK} stroke={RING} strokeWidth={2} />
          ) : (
            <circle key={b.from} cx={sx(b.predicted)} cy={sy(b.observed)} r={4 + (hover === i ? 1.5 : 0)} fill={RING} stroke={MARK} strokeWidth={1.5} />
          ),
        )}
        {/* histograma: nº de predicciones por tramo */}
        <line x1={m.l} x2={m.l + iw} y1={hy0 + histH} y2={hy0 + histH} stroke={token('line-strong')} strokeWidth={1} />
        {pts.map((b, i) => {
          const x0 = sx(b.from) + 1;
          const w = Math.max(1, sx(b.to) - sx(b.from) - 2);
          const h = Math.max(1, (b.n / maxN) * (histH - 12));
          const y = hy0 + histH - h;
          return (
            <path
              key={`h-${b.from}`}
              d={`M${x0},${hy0 + histH}V${y + 3}Q${x0},${y} ${x0 + 3},${y}H${x0 + w - 3}Q${x0 + w},${y} ${x0 + w},${y + 3}V${hy0 + histH}Z`}
              fill={hover === i ? token('ink-2', 0.75) : token('ink-3', 0.5)}
            />
          );
        })}
        {biggest && (
          <text x={sx((biggest.from + biggest.to) / 2)} y={hy0 + histH - (biggest.n / maxN) * (histH - 12) - 4} textAnchor="middle" className={AXIS}>
            {int(biggest.n)}
          </text>
        )}
        <text x={m.l} y={hy0 + histH + 16} className="fill-ink-3 text-[10.5px]">
          Nº de predicciones por tramo
        </text>
      </svg>
      {hb && hci && (
        <div
          className="pointer-events-none absolute z-20 min-w-[176px] rounded-lg border border-line-strong bg-surface-2 px-2.5 py-2 text-[12px] shadow-pop"
          style={{ left: Math.min(Math.max(sx(hb.predicted) + 14, 0), W - 190), top: Math.max(0, Math.min(sy(hb.observed) - 30, m.t + plot - 100)) }}
          aria-hidden="true"
        >
          <div className="mb-1 text-2xs text-ink-3">
            Tramo {pct(hb.from)}–{pct(hb.to)}
          </div>
          <Row label="Predicho" value={pct(hb.predicted, 1)} />
          <Row label="Observado" value={pct(hb.observed, 1)} strong />
          <Row label="IC 95%" value={`${pct(hci[0])}–${pct(hci[1])}`} />
          <Row label="Predicciones" value={int(hb.n)} />
        </div>
      )}
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-ink-2">{label}</span>
      <span className={cx('num text-ink-1', strong && 'font-semibold')}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Barras horizontales con línea de cero (valores positivos y negativos)
// ---------------------------------------------------------------------------
export interface SkillItem {
  id: string;
  label: ReactNode;
  value: number;
  display: string;
  hint?: ReactNode;
  emphasis?: boolean;
}

/**
 * Barras finas desde una línea de cero común: a la derecha mejora, a la izquierda empeora.
 * Un solo tono neutro; `emphasis` resalta una barra con el acento (la del modelo).
 */
export function SkillBars({ items, ariaLabel, className, labelWidth = 128 }: { items: SkillItem[]; ariaLabel: string; className?: string; labelWidth?: number }) {
  const [ref, width] = useElementWidth<HTMLUListElement>(600);
  const stacked = width < labelWidth + 260;
  const vals = items.map((i) => i.value).filter((v) => Number.isFinite(v));
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const zero = ((0 - lo) / span) * 100;
  return (
    <ul ref={ref} className={cx(stacked ? 'space-y-3' : 'space-y-2', className)} aria-label={ariaLabel}>
      {items.map((it) => {
        const v = Number.isFinite(it.value) ? it.value : 0;
        const left = v >= 0 ? zero : ((v - lo) / span) * 100;
        const w = (Math.abs(v) / span) * 100;
        const label = <span className={cx('min-w-0 truncate', it.emphasis ? 'font-semibold text-ink-1' : 'text-ink-2')}>{it.label}</span>;
        const value = (
          <span className={cx('num whitespace-nowrap text-right', it.emphasis ? 'font-semibold text-ink-1' : 'text-ink-2')}>
            {it.display}
            {it.hint && <span className="ml-1.5 text-2xs font-normal text-ink-3">{it.hint}</span>}
          </span>
        );
        const bar = (
          <span className={cx('relative block', stacked ? 'col-span-2 h-3' : 'h-5')} aria-hidden="true">
            <span className="absolute inset-y-0 w-px bg-ink-3/70" style={{ left: `${zero}%` }} />
            <span
              className={cx('absolute top-1/2 h-2.5 -translate-y-1/2', v >= 0 ? 'rounded-r-[4px]' : 'rounded-l-[4px]')}
              style={{ left: `${left}%`, width: `${Math.max(w, 0.6)}%`, background: it.emphasis ? token('accent-text') : token('ink-2', 0.55) }}
            />
          </span>
        );
        return stacked ? (
          <li key={it.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-[13px]">
            {label}
            {value}
            {bar}
          </li>
        ) : (
          <li key={it.id} className="grid items-center gap-3 text-[13px]" style={{ gridTemplateColumns: `minmax(72px, ${labelWidth}px) minmax(0, 1fr) auto` }}>
            {label}
            {bar}
            {value}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// ROI con intervalo de confianza
// ---------------------------------------------------------------------------
export function roiInterval(roi: { bets: number; roi: number; hitRate: number; avgOdds: number }): [number, number] | undefined {
  if (!(roi.bets > 0) || !(roi.avgOdds > 1)) return undefined;
  const q = Math.min(1, Math.max(0, roi.hitRate));
  const se = roi.avgOdds * Math.sqrt((q * (1 - q)) / roi.bets);
  return [roi.roi - 1.96 * se, roi.roi + 1.96 * se];
}

/** Recta numérica: intervalo al 95% del ROI, estimación puntual y línea de cero. */
export function RoiIntervalBar({ roi, ci, className }: { roi: number; ci: [number, number]; className?: string }) {
  const lo = Math.min(ci[0], -0.1);
  const hi = Math.max(ci[1], 0.1);
  const pad = (hi - lo) * 0.06;
  const a = lo - pad;
  const b = hi + pad;
  const f = (v: number) => (v - a) / (b - a);
  const x = (v: number) => `${f(v) * 100}%`;
  // la etiqueta "0%" se omite si choca con la de un extremo del intervalo (la marca vertical se mantiene)
  const showZero = Math.abs(f(ci[0]) - f(0)) > 0.08 && Math.abs(f(ci[1]) - f(0)) > 0.08;
  return (
    <div
      className={cx('relative h-16 select-none', className)}
      role="img"
      aria-label={`ROI estimado ${signedPct(roi, 1)}; intervalo aproximado al 95% entre ${signedPct(ci[0], 0)} y ${signedPct(ci[1], 0)}`}
    >
      <span className="absolute inset-x-0 top-[38px] h-px bg-line-strong" aria-hidden="true" />
      <span className="absolute top-[26px] h-6 w-px bg-ink-3" style={{ left: x(0) }} aria-hidden="true" />
      {showZero && (
        <span className="num absolute top-[52px] -translate-x-1/2 text-[10.5px] text-ink-3" style={{ left: x(0) }} aria-hidden="true">
          0%
        </span>
      )}
      <span className="absolute top-[34px] h-2 rounded-full bg-ink-2/45" style={{ left: x(ci[0]), width: `calc(${x(ci[1])} - ${x(ci[0])})` }} aria-hidden="true" />
      <span className="num absolute top-[52px] text-[10.5px] text-ink-2" style={{ left: x(ci[0]) }} aria-hidden="true">
        {signedPct(ci[0], 0)}
      </span>
      <span className="num absolute top-[52px] -translate-x-full text-[10.5px] text-ink-2" style={{ left: x(ci[1]) }} aria-hidden="true">
        {signedPct(ci[1], 0)}
      </span>
      <span className="absolute top-[32px] h-3 w-3 -translate-x-1/2 rounded-full ring-2 ring-surface-1" style={{ left: x(roi), background: MARK }} aria-hidden="true" />
      <span className="num absolute top-1 -translate-x-1/2 whitespace-nowrap text-[12px] font-semibold text-ink-1" style={{ left: x(roi) }} aria-hidden="true">
        {signedPct(roi, 1)}
      </span>
    </div>
  );
}
