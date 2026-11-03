import { cx } from '../../components';
import { num } from '../../lib/format';

export interface FormTrendProps {
  /** notas 0..10 cronológicas (la más reciente a la derecha); 0 = no jugó */
  values: number[];
  width?: number;
  height?: number;
  /** nombre del jugador para el texto accesible */
  name?: string;
  className?: string;
}

const LO = 3;
const HI = 10;

/**
 * Sparkline de las notas de los últimos partidos. Los partidos sin minutos (nota 0) no se unen a
 * la línea: se marcan con un punto hueco en la base para no fingir una nota inexistente.
 */
export function FormTrend({ values, width = 64, height = 22, name, className }: FormTrendProps) {
  const vs = values.filter((v) => Number.isFinite(v));
  const label = vs.length
    ? `${name ? `Notas recientes de ${name}` : 'Notas recientes'}: ${vs.map((v) => (v > 0 ? num(v, 1) : 'no jugó')).join(', ')}`
    : 'Sin notas recientes';
  if (vs.length === 0) return <svg width={width} height={height} className={className} role="img" aria-label={label} />;
  const pad = 4;
  const n = vs.length;
  const x = (i: number) => (n === 1 ? width / 2 : pad + (i * (width - pad * 2)) / (n - 1));
  const y = (v: number) => height - pad - ((Math.min(HI, Math.max(LO, v)) - LO) / (HI - LO)) * (height - pad * 2);
  // segmentos continuos de partidos jugados
  const segs: string[] = [];
  let cur = '';
  vs.forEach((v, i) => {
    if (v > 0) {
      cur += `${cur ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    } else if (cur) {
      segs.push(cur);
      cur = '';
    }
  });
  if (cur) segs.push(cur);
  const lastPlayed = vs.reduce((acc, v, i) => (v > 0 ? i : acc), -1);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cx('shrink-0 overflow-visible', className)} role="img" aria-label={label}>
      <title>{label}</title>
      {segs.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="rgb(var(--c-ink-2))" strokeOpacity={0.8} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {vs.map((v, i) => {
        if (!(v > 0)) return <circle key={i} cx={x(i)} cy={height - pad} r={2} fill="rgb(var(--c-surface-1))" stroke="rgb(var(--c-ink-3))" strokeWidth={1.2} />;
        if (i === lastPlayed) return <circle key={i} cx={x(i)} cy={y(v)} r={3} fill="rgb(var(--c-accent-text))" stroke="rgb(var(--c-surface-1))" strokeWidth={2} />;
        const isolated = !(vs[i - 1] > 0) && !(vs[i + 1] > 0);
        return isolated ? <circle key={i} cx={x(i)} cy={y(v)} r={2} fill="rgb(var(--c-ink-2))" /> : null;
      })}
    </svg>
  );
}
