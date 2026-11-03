import { SIDE_COLOR, type Side } from '../lib/colors';
import { pct } from '../lib/format';
import { cx } from './Card';

export interface ProbabilityBadgeProps {
  /** probabilidad [0,1] */
  p: number;
  /** etiqueta corta delante (p. ej. "+2.5", "Ambos") */
  label?: string;
  /** color del mini medidor: 'neutral' (tinta), 'accent', o un lado del 1X2 */
  tone?: 'neutral' | 'accent' | Side;
  size?: 'sm' | 'md';
  className?: string;
  title?: string;
}

/** Píldora compacta con etiqueta, % y mini medidor horizontal. */
export function ProbabilityBadge({ p, label, tone = 'neutral', size = 'sm', className, title }: ProbabilityBadgeProps) {
  const fill = tone === 'neutral' ? 'rgb(var(--c-ink-2))' : tone === 'accent' ? 'rgb(var(--c-accent-text))' : SIDE_COLOR[tone];
  const v = Math.max(0, Math.min(1, p));
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2/80',
        size === 'sm' ? 'px-1.5 py-[3px] text-2xs' : 'px-2 py-1 text-[12px]',
        className,
      )}
    >
      {label && <span className="font-medium text-ink-2">{label}</span>}
      <span className="num font-semibold text-ink-1">{pct(v)}</span>
      <span className="relative h-1 w-6 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${v * 100}%`, background: fill }} />
      </span>
    </span>
  );
}

export interface MeterProps {
  /** valor [0,1] */
  value: number;
  className?: string;
  /** color del relleno (CSS); por defecto acento */
  color?: string;
  /** alto en px (por defecto 6) */
  height?: number;
  label?: string;
}

/** Medidor lineal 0–1 con pista del mismo tono atenuado. */
export function Meter({ value, className, color = 'rgb(var(--c-accent-text))', height = 6, label }: MeterProps) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <span
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      aria-label={label}
      className={cx('relative block w-full overflow-hidden rounded-full', className)}
      style={{ height, background: 'rgb(var(--c-surface-3))' }}
    >
      <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${v * 100}%`, background: color }} />
    </span>
  );
}

export interface ConfidenceMeterProps {
  /** confianza [0,1] */
  value: number;
  /** muestra el texto "Alta/Media/Baja" */
  showLabel?: boolean;
  className?: string;
}

export function confidenceLabel(v: number): 'Alta' | 'Media' | 'Baja' {
  return v >= 0.67 ? 'Alta' : v >= 0.4 ? 'Media' : 'Baja';
}

/** Confianza del modelo como 5 barras tipo "señal" + etiqueta. */
export function ConfidenceMeter({ value, showLabel = true, className }: ConfidenceMeterProps) {
  const v = Math.max(0, Math.min(1, value));
  const bars = Math.max(1, Math.round(v * 5));
  const label = confidenceLabel(v);
  return (
    <span className={cx('inline-flex items-center gap-1.5', className)} role="img" aria-label={`Confianza ${label.toLowerCase()} (${pct(v)})`} title={`Confianza del modelo: ${pct(v)}`}>
      <span className="flex items-end gap-[2px]" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className={cx('w-[3px] rounded-[1px]', i < bars ? 'bg-accent-text' : 'bg-surface-3')} style={{ height: 4 + i * 2 }} />
        ))}
      </span>
      {showLabel && <span className="text-2xs font-medium text-ink-2">{label}</span>}
    </span>
  );
}
