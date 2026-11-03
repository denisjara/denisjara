import { cx } from './Card';

export interface SparklineProps {
  /** valores cronológicos (el último a la derecha) */
  values: number[];
  width?: number;
  height?: number;
  /** color CSS de la línea; por defecto tinta secundaria con el último punto en acento */
  color?: string;
  /** dibuja relleno suave bajo la línea */
  area?: boolean;
  /** dominio fijo [min,max]; por defecto el de los datos */
  domain?: [number, number];
  /** nombre accesible (si falta, es decorativa) */
  ariaLabel?: string;
  className?: string;
}

/** Línea mínima de 2px con punto final (r=3, anillo de superficie). Sin ejes. */
export function Sparkline({ values, width = 80, height = 24, color, area, domain, ariaLabel, className }: SparklineProps) {
  const vs = (Array.isArray(values) ? values : []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (vs.length < 2) return <svg width={width} height={height} className={className} aria-hidden="true" />;
  const pad = 4;
  const lo = domain ? domain[0] : Math.min(...vs);
  const hi = domain ? domain[1] : Math.max(...vs);
  // Rango vacío o desbordado (valores de ±1e308…): línea plana centrada en lugar de coordenadas NaN/±Infinity.
  const span = Number.isFinite(hi - lo) && hi - lo > 0 ? hi - lo : 0;
  const x = (i: number) => pad + (i * (width - pad * 2)) / (vs.length - 1);
  const y = (v: number) => {
    const r = span ? (v - lo) / span : 0.5;
    return height - pad - (Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.5) * (height - pad * 2);
  };
  const d = vs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const stroke = color ?? 'rgb(var(--c-ink-2))';
  const lastX = x(vs.length - 1);
  const lastY = y(vs[vs.length - 1]);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cx('shrink-0 overflow-visible', className)}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      {ariaLabel && <title>{ariaLabel}</title>}
      {area && <path d={`${d}L${lastX.toFixed(1)},${height - pad}L${x(0).toFixed(1)},${height - pad}Z`} fill={stroke} opacity={0.1} />}
      <path d={d} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={color ? 1 : 0.8} />
      <circle cx={lastX} cy={lastY} r={3} fill={color ?? 'rgb(var(--c-accent-text))'} stroke="rgb(var(--c-surface-1))" strokeWidth={2} />
    </svg>
  );
}
