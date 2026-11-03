import type { Prob1X2 } from '../../types/data';
import { SIDE_COLOR, SIDE_INK, type Side } from '../lib/colors';
import { pct, signedPct } from '../lib/format';
import { cx } from './Card';

const SIDES: Side[] = ['home', 'draw', 'away'];
const DEFAULT_LABELS: Record<Side, string> = { home: '1', draw: 'X', away: '2' };
const LONG: Record<Side, string> = { home: 'Local', draw: 'Empate', away: 'Visitante' };

export interface ProbBar1X2Props {
  /** probabilidades del modelo (suman 1) */
  p: Prob1X2;
  /** probabilidades del mercado sin margen: dibuja una segunda barra fina debajo */
  market?: Prob1X2;
  /** 'sm' 8px sin texto · 'md' 22px con % dentro · 'lg' 28px con % dentro */
  size?: 'sm' | 'md' | 'lg';
  /** leyenda bajo la barra (1 · X · 2 con %) */
  legend?: boolean;
  /** etiquetas de la leyenda, p. ej. nombres de equipo */
  labels?: Partial<Record<Side, string>>;
  className?: string;
}

function norm(p: Prob1X2): Prob1X2 {
  const s = p.home + p.draw + p.away;
  return s > 0 ? { home: p.home / s, draw: p.draw / s, away: p.away / s } : { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
}

/**
 * Barra apilada Local / Empate / Visitante (esquema divergente azul · gris · naranja).
 * Separación de 2px entre segmentos; el % va dentro solo si cabe. Accesible: role="img" + aria-label.
 */
export function ProbBar1X2({ p, market, size = 'md', legend = false, labels, className }: ProbBar1X2Props) {
  const q = norm(p);
  const h = size === 'sm' ? 'h-2' : size === 'md' ? 'h-[22px]' : 'h-7';
  const showText = size !== 'sm';
  const minForText = size === 'lg' ? 0.11 : 0.13;
  const aria = `Probabilidades: ${LONG.home} ${pct(q.home)}, ${LONG.draw} ${pct(q.draw)}, ${LONG.away} ${pct(q.away)}${
    market ? `. Mercado: ${pct(market.home)}, ${pct(market.draw)}, ${pct(market.away)}` : ''
  }`;
  return (
    <div className={cx('w-full', className)}>
      <div role="img" aria-label={aria} className={cx('flex w-full gap-[2px]', h)}>
        {SIDES.map((s, i) => {
          const v = q[s];
          if (v <= 0.0005) return null;
          return (
            <div
              key={s}
              title={`${labels?.[s] ?? LONG[s]}: ${pct(v, 1)}`}
              className={cx(
                'forced-border flex min-w-[3px] items-center overflow-hidden',
                size === 'sm' ? 'rounded-full' : 'rounded-[4px]',
                i === 0 ? 'justify-start pl-1.5' : i === 2 ? 'justify-end pr-1.5' : 'justify-center',
              )}
              style={{ width: `${v * 100}%`, background: SIDE_COLOR[s], color: SIDE_INK[s] }}
            >
              {showText && v >= minForText && (
                <span className={cx('num font-semibold leading-none', size === 'lg' ? 'text-[13px]' : 'text-[11.5px]')}>{pct(v)}</span>
              )}
            </div>
          );
        })}
      </div>
      {market && (
        <div className="mt-1.5 flex items-center gap-2">
          <span className="w-12 shrink-0 text-2xs text-ink-3">Mercado</span>
          <div className="flex h-1.5 flex-1 gap-[2px] opacity-70" aria-hidden="true">
            {SIDES.map((s) => (
              <div key={s} className="rounded-full" style={{ width: `${norm(market)[s] * 100}%`, background: SIDE_COLOR[s] }} />
            ))}
          </div>
        </div>
      )}
      {legend && <Legend1X2 p={q} market={market} labels={labels} className="mt-2" />}
    </div>
  );
}

export interface Legend1X2Props {
  p: Prob1X2;
  market?: Prob1X2;
  labels?: Partial<Record<Side, string>>;
  className?: string;
}

/** Leyenda 1 · X · 2 con punto de color, % del modelo y diferencia vs mercado (si existe). */
export function Legend1X2({ p, market, labels, className }: Legend1X2Props) {
  return (
    <ul className={cx('grid grid-cols-3 gap-2 text-[12px]', className)}>
      {SIDES.map((s, i) => {
        const d = market ? p[s] - market[s] : undefined;
        return (
          <li key={s} className={cx('flex min-w-0 flex-col', i === 1 && 'items-center text-center', i === 2 && 'items-end text-right')}>
            <span className="flex min-w-0 items-center gap-1.5 text-ink-2">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SIDE_COLOR[s] }} aria-hidden="true" />
              <span className="truncate">{labels?.[s] ?? `${DEFAULT_LABELS[s]} · ${LONG[s]}`}</span>
            </span>
            <span className="num text-[13px] font-semibold text-ink-1">
              {pct(p[s])}
              {d !== undefined && Math.abs(d) >= 0.005 && (
                <span className={cx('ml-1 text-2xs font-medium', d > 0 ? 'text-pos' : 'text-neg')}>{signedPct(d, 0)}</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
