/**
 * Gráficos SVG propios de la página de competición (siguen las reglas de dataviz de DESIGN.md:
 * marcas finas, rejilla hairline, un solo eje Y, tooltip + teclado, texto en tintas, nunca en color de serie).
 */
import { useMemo, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { CalibrationBin, TeamRef } from '../../../types/data';
import { cx } from '../../components';
import { token } from '../../lib/colors';
import { useElementWidth } from '../../lib/hooks';
import { int, num, pct } from '../../lib/format';
import { niceTicks } from '../../lib/ticks';

const GRID = token('line');
const AXIS_TEXT = 'fill-ink-3 font-mono text-[10.5px]';
const MARK = token('accent-text');
const RING = token('surface-1');

// ---------------------------------------------------------------------------
// Dispersión ataque vs defensa (Dixon-Coles)
// ---------------------------------------------------------------------------
export interface ScatterPoint {
  team: TeamRef;
  attack: number;
  defence: number;
  elo?: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * Ataque (multiplicador, → mejor) frente a defensa (multiplicador de goles concedidos; eje invertido:
 * ↑ mejor). Cuadrantes partidos en 1 = media de la liga. Etiquetas de abreviatura con evitación de
 * solapes; hover/teclado muestran el detalle.
 */
export function AttackDefenceScatter({ points, ariaLabel, className }: { points: ScatterPoint[]; ariaLabel: string; className?: string }) {
  const [ref, width] = useElementWidth<HTMLDivElement>(640);
  const [hover, setHover] = useState<number | null>(null);
  const W = Math.max(280, width);
  const H = Math.round(Math.min(460, Math.max(300, W * 0.62)));
  const m = { l: 44, r: 16, t: 16, b: 40 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;

  const ordered = useMemo(() => [...points].sort((a, b) => (b.elo ?? 0) - (a.elo ?? 0)), [points]);
  const xs = ordered.map((p) => p.attack);
  const ys = ordered.map((p) => p.defence);
  const pad = (lo: number, hi: number) => {
    const span = Math.max(hi - lo, 0.2);
    return [Math.min(lo, 1) - span * 0.08, Math.max(hi, 1) + span * 0.08] as const;
  };
  const [xlo, xhi] = pad(Math.min(...xs), Math.max(...xs));
  const [ylo, yhi] = pad(Math.min(...ys), Math.max(...ys));
  const sx = (v: number) => m.l + ((v - xlo) / (xhi - xlo)) * iw;
  // defensa baja (mejor) arriba
  const sy = (v: number) => m.t + ((v - ylo) / (yhi - ylo)) * ih;
  const xTicks = niceTicks(xlo, xhi, Math.max(3, Math.min(6, Math.floor(iw / 90))));
  const yTicks = niceTicks(ylo, yhi, 4);

  // etiquetas con evitación de solapes (orden: equipos de más Elo primero)
  const labels = useMemo(() => {
    const placed: Box[] = ordered.map((p) => ({ x: sx(p.attack) - 6, y: sy(p.defence) - 6, w: 12, h: 12 }));
    const out: ({ x: number; y: number; anchor: 'start' | 'end' | 'middle' } | null)[] = [];
    ordered.forEach((p) => {
      const cx0 = sx(p.attack);
      const cy0 = sy(p.defence);
      const text = p.team.abbr || p.team.short.slice(0, 3);
      const w = text.length * 6.6 + 2;
      const h = 12;
      const cands: { box: Box; x: number; y: number; anchor: 'start' | 'end' | 'middle' }[] = [
        { box: { x: cx0 + 8, y: cy0 - h / 2, w, h }, x: cx0 + 8, y: cy0 + 3.5, anchor: 'start' },
        { box: { x: cx0 - 8 - w, y: cy0 - h / 2, w, h }, x: cx0 - 8, y: cy0 + 3.5, anchor: 'end' },
        { box: { x: cx0 - w / 2, y: cy0 - 8 - h, w, h }, x: cx0, y: cy0 - 10, anchor: 'middle' },
        { box: { x: cx0 - w / 2, y: cy0 + 8, w, h }, x: cx0, y: cy0 + 18, anchor: 'middle' },
      ];
      const ok = cands.find(
        (c) => c.box.x >= m.l && c.box.x + c.box.w <= W - m.r && c.box.y >= m.t - 4 && c.box.y + c.box.h <= m.t + ih + 4 && !placed.some((b) => overlaps(b, c.box)),
      );
      if (ok) {
        placed.push(ok.box);
        out.push({ x: ok.x, y: ok.y, anchor: ok.anchor });
      } else out.push(null);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered, W, H]);

  const nearest = (px: number, py: number) => {
    let best = -1;
    let bd = 26 * 26;
    ordered.forEach((p, i) => {
      const d = (sx(p.attack) - px) ** 2 + (sy(p.defence) - py) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best >= 0 ? best : null;
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(nearest(((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') setHover((h) => ((h ?? -1) + 1) % ordered.length);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') setHover((h) => ((h ?? ordered.length) - 1 + ordered.length) % ordered.length);
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };

  const midX = sx(1);
  const midY = sy(1);
  const wide = W >= 560;
  const quad = (label: string, desc: string, x: number, y: number, anchor: 'start' | 'end') => (
    <text x={x} y={y} textAnchor={anchor} className="pointer-events-none">
      <tspan className="fill-ink-2 text-[11px] font-semibold uppercase tracking-[0.08em]">{label}</tspan>
      {wide && (
        <tspan x={x} dy={13} className="fill-ink-3 text-[10.5px]">
          {desc}
        </tspan>
      )}
    </text>
  );
  const hp = hover !== null ? ordered[hover] : null;

  return (
    <div ref={ref} className={cx('relative w-full', className)}>
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
        {/* cuadrante "completos" ligeramente realzado */}
        <rect x={midX} y={m.t} width={Math.max(0, m.l + iw - midX)} height={Math.max(0, midY - m.t)} fill={token('accent-text', 0.05)} />
        {xTicks.map((t) => (
          <g key={`x${t}`}>
            <line x1={sx(t)} x2={sx(t)} y1={m.t} y2={m.t + ih} stroke={GRID} strokeWidth={1} />
            <text x={sx(t)} y={m.t + ih + 14} textAnchor="middle" className={AXIS_TEXT}>
              {num(t, 1)}
            </text>
          </g>
        ))}
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={m.l} x2={m.l + iw} y1={sy(t)} y2={sy(t)} stroke={GRID} strokeWidth={1} />
            <text x={m.l - 6} y={sy(t)} dy="0.32em" textAnchor="end" className={AXIS_TEXT}>
              {num(t, 1)}
            </text>
          </g>
        ))}
        <line x1={midX} x2={midX} y1={m.t} y2={m.t + ih} stroke={token('ink-3')} strokeWidth={1} opacity={0.7} />
        <line x1={m.l} x2={m.l + iw} y1={midY} y2={midY} stroke={token('ink-3')} strokeWidth={1} opacity={0.7} />
        {quad('Completos', 'Atacan y defienden mejor que la media', m.l + iw - 6, m.t + 14, 'end')}
        {quad('Defensivos', 'Encajan poco, marcan poco', m.l + 6, m.t + 14, 'start')}
        {quad('Ofensivos', 'Marcan mucho, encajan mucho', m.l + iw - 6, m.t + ih - (wide ? 20 : 8), 'end')}
        {quad('En apuros', 'Por debajo en ambas facetas', m.l + 6, m.t + ih - (wide ? 20 : 8), 'start')}
        <text x={m.l + iw} y={H - 4} textAnchor="end" className="fill-ink-3 text-[10.5px]">
          Ataque (× media de la liga) →
        </text>
        <text x={12} y={m.t + ih / 2} transform={`rotate(-90 12 ${m.t + ih / 2})`} textAnchor="middle" className="fill-ink-3 text-[10.5px]">
          Defensa (goles encajados × media) · arriba, mejor →
        </text>
        {ordered.map((p, i) => (
          <circle key={p.team.id} cx={sx(p.attack)} cy={sy(p.defence)} r={hover === i ? 6.5 : 5} fill={MARK} stroke={RING} strokeWidth={2} />
        ))}
        {ordered.map((p, i) => {
          const l = labels[i];
          if (!l) return null;
          return (
            <text key={`l${p.team.id}`} x={l.x} y={l.y} textAnchor={l.anchor} className={cx('pointer-events-none font-mono text-[10.5px]', hover === i ? 'fill-ink-1 font-semibold' : 'fill-ink-2')}>
              {p.team.abbr || p.team.short.slice(0, 3)}
            </text>
          );
        })}
        {hp && <circle cx={sx(hp.attack)} cy={sy(hp.defence)} r={10} fill="none" stroke={token('ink-1')} strokeWidth={1.5} pointerEvents="none" />}
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute z-20 min-w-[170px] rounded-lg border border-line-strong bg-surface-2 px-2.5 py-2 text-[12px] shadow-pop"
          style={{
            left: Math.min(Math.max(sx(hp.attack) + 14, 0), W - 186),
            top: Math.max(0, Math.min(sy(hp.defence) - 20, H - 96)),
          }}
          aria-hidden="true"
        >
          <div className="mb-1 font-semibold text-ink-1">{hp.team.name}</div>
          <div className="flex justify-between gap-3 text-ink-2">
            Ataque <span className="num text-ink-1">{num(hp.attack, 2)}</span>
          </div>
          <div className="flex justify-between gap-3 text-ink-2">
            Defensa <span className="num text-ink-1">{num(hp.defence, 2)}</span>
          </div>
          {hp.elo !== undefined && (
            <div className="flex justify-between gap-3 text-ink-2">
              Elo <span className="num text-ink-1">{int(hp.elo)}</span>
            </div>
          )}
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {hp ? `${hp.team.name}: ataque ${num(hp.attack, 2)}, defensa ${num(hp.defence, 2)}` : ''}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Curva de calibración
// ---------------------------------------------------------------------------
/**
 * Probabilidad predicha (X) frente a frecuencia observada (Y). Diagonal = calibración perfecta.
 * El radio de cada punto crece con el nº de casos del tramo.
 */
export function CalibrationChart({ bins, ariaLabel, className }: { bins: CalibrationBin[]; ariaLabel: string; className?: string }) {
  const [ref, width] = useElementWidth<HTMLDivElement>(420);
  const [hover, setHover] = useState<number | null>(null);
  const W = Math.max(260, Math.min(width, 520));
  const m = { l: 40, r: 14, t: 12, b: 34 };
  const size = W - m.l - m.r;
  const H = size + m.t + m.b;
  const s = (v: number) => v * size;
  const sx = (v: number) => m.l + s(v);
  const sy = (v: number) => m.t + size - s(v);
  const pts = bins.filter((b) => b.n > 0).sort((a, b) => a.predicted - b.predicted);
  const maxN = Math.max(1, ...pts.map((b) => b.n));
  const r = (n: number) => 4 + 5 * Math.sqrt(n / maxN);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  // los tramos con pocos casos (< MIN_N) se dibujan huecos y no entran en la línea: su frecuencia es ruido
  const MIN_N = 5;
  const solid = pts.filter((b) => b.n >= MIN_N);
  const d = solid.map((b, i) => `${i ? 'L' : 'M'}${sx(b.predicted).toFixed(1)},${sy(b.observed).toFixed(1)}`).join('');
  const hasHollow = pts.some((b) => b.n < MIN_N);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const py = ((e.clientY - rect.top) / rect.height) * H;
    let best: number | null = null;
    let bd = 28 * 28;
    pts.forEach((b, i) => {
      const dd = (sx(b.predicted) - px) ** 2 + (sy(b.observed) - py) ** 2;
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    });
    setHover(best);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight') setHover((h) => Math.min(pts.length - 1, (h ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? pts.length) - 1));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };
  const hb = hover !== null ? pts[hover] : null;

  return (
    <div ref={ref} className={cx('relative w-full', className)}>
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
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={m.l + size} y1={sy(t)} y2={sy(t)} stroke={GRID} strokeWidth={1} />
            <line x1={sx(t)} x2={sx(t)} y1={m.t} y2={m.t + size} stroke={GRID} strokeWidth={1} />
            <text x={m.l - 6} y={sy(t)} dy="0.32em" textAnchor="end" className={AXIS_TEXT}>
              {pct(t)}
            </text>
            <text x={sx(t)} y={m.t + size + 14} textAnchor={t === 0 ? 'start' : t === 1 ? 'end' : 'middle'} className={AXIS_TEXT}>
              {pct(t)}
            </text>
          </g>
        ))}
        <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke={token('ink-3')} strokeWidth={1} />
        <text
          x={sx(0.62)}
          y={sy(0.62) - 6}
          transform={`rotate(-45 ${sx(0.62)} ${sy(0.62) - 6})`}
          textAnchor="middle"
          className="fill-ink-3 text-[10.5px]"
        >
          Calibración perfecta
        </text>
        <text x={m.l + size} y={H - 2} textAnchor="end" className="fill-ink-3 text-[10.5px]">
          Probabilidad predicha →
        </text>
        <text x={10} y={m.t + size / 2} transform={`rotate(-90 10 ${m.t + size / 2})`} textAnchor="middle" className="fill-ink-3 text-[10.5px]">
          Frecuencia observada →
        </text>
        {solid.length > 1 && <path d={d} fill="none" stroke={MARK} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {pts.map((b, i) =>
          b.n >= MIN_N ? (
            <circle key={b.from} cx={sx(b.predicted)} cy={sy(b.observed)} r={r(b.n) + (hover === i ? 1.5 : 0)} fill={MARK} stroke={RING} strokeWidth={2} />
          ) : (
            <circle key={b.from} cx={sx(b.predicted)} cy={sy(b.observed)} r={4 + (hover === i ? 1.5 : 0)} fill={RING} stroke={MARK} strokeWidth={1.5} opacity={0.8} />
          ),
        )}
      </svg>
      {hasHollow && <p className="mt-1 text-2xs text-ink-3">Puntos huecos: tramos con menos de {MIN_N} casos (poco fiables, fuera de la línea).</p>}
      {hb && (
        <div
          className="pointer-events-none absolute z-20 min-w-[160px] rounded-lg border border-line-strong bg-surface-2 px-2.5 py-2 text-[12px] shadow-pop"
          style={{ left: Math.min(Math.max(sx(hb.predicted) + 14, 0), W - 176), top: Math.max(0, Math.min(sy(hb.observed) - 24, H - 90)) }}
          aria-hidden="true"
        >
          <div className="mb-1 text-2xs text-ink-3">
            Tramo {pct(hb.from)}–{pct(hb.to)}
          </div>
          <div className="flex justify-between gap-3 text-ink-2">
            Predicho <span className="num text-ink-1">{pct(hb.predicted, 1)}</span>
          </div>
          <div className="flex justify-between gap-3 text-ink-2">
            Observado <span className="num text-ink-1">{pct(hb.observed, 1)}</span>
          </div>
          <div className="flex justify-between gap-3 text-ink-2">
            Casos <span className="num text-ink-1">{int(hb.n)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Barras horizontales (ranking de un solo valor)
// ---------------------------------------------------------------------------
export interface BarItem {
  id: string;
  label: ReactNode;
  value: number;
  display: string;
  /** realza esta barra (el resto en gris) */
  emphasis?: boolean;
  hint?: ReactNode;
}

/** Barras horizontales finas (≤ 10px) desde una línea base común; valor al final. */
export function BarList({ items, domain, className, ariaLabel }: { items: BarItem[]; domain?: [number, number]; className?: string; ariaLabel: string }) {
  const lo = domain?.[0] ?? 0;
  const hi = domain?.[1] ?? Math.max(1e-9, ...items.map((i) => i.value));
  return (
    <ul className={cx('space-y-2.5', className)} aria-label={ariaLabel}>
      {items.map((it) => {
        const w = Math.max(0, Math.min(1, (it.value - lo) / (hi - lo || 1)));
        return (
          <li key={it.id} className="grid grid-cols-[minmax(84px,132px)_minmax(0,1fr)_auto] items-center gap-3 text-[13px]">
            <span className={cx('truncate', it.emphasis ? 'font-semibold text-ink-1' : 'text-ink-2')}>{it.label}</span>
            <span className="relative h-2.5 rounded-r-[4px]" aria-hidden="true">
              <span
                className="absolute inset-y-0 left-0 rounded-r-[4px]"
                style={{ width: `${Math.max(w * 100, 1)}%`, background: it.emphasis ? token('accent-text') : token('ink-3', 0.55) }}
              />
            </span>
            <span className={cx('num text-right', it.emphasis ? 'font-semibold text-ink-1' : 'text-ink-2')}>
              {it.display}
              {it.hint && <span className="ml-1.5 text-2xs text-ink-3">{it.hint}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
