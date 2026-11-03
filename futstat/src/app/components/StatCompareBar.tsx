import { SIDE_COLOR } from '../lib/colors';
import { int, num, pct } from '../lib/format';
import { cx } from './Card';

export type StatFormat = 'int' | 'dec1' | 'dec2' | 'pct';

export function formatStat(v: number | undefined, f: StatFormat = 'dec1'): string {
  if (v === undefined || !Number.isFinite(v)) return '–';
  if (f === 'int') return int(v);
  if (f === 'dec2') return num(v, 2);
  if (f === 'pct') return pct(v);
  return num(v, 1);
}

export interface StatCompareBarProps {
  label: string;
  home: number;
  away: number;
  format?: StatFormat;
  /** qué dirección es mejor: el lado mejor se pinta pleno; el otro atenuado */
  better?: 'high' | 'low';
  /** media de la liga para contexto (texto bajo la etiqueta) */
  leagueAvg?: number;
  className?: string;
}

/**
 * Barra enfrentada local vs visitante: valores a los lados, etiqueta en el centro y dos barras que
 * crecen desde el centro hacia fuera (proporción de la suma). El lado que "gana" la métrica va en su
 * color pleno y en negrita; el otro, atenuado.
 */
export function StatCompareBar({ label, home, away, format = 'dec1', better = 'high', leagueAvg, className }: StatCompareBarProps) {
  const h = Math.max(0, home || 0);
  const a = Math.max(0, away || 0);
  const total = h + a;
  const hs = total > 0 ? h / total : 0.5;
  const as = total > 0 ? a / total : 0.5;
  const homeWins = better === 'high' ? home > away : home < away;
  const awayWins = better === 'high' ? away > home : away < home;
  return (
    <div className={cx('w-full', className)} role="group" aria-label={`${label}: local ${formatStat(home, format)}, visitante ${formatStat(away, format)}`}>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[13px]">
        <span className={cx('num w-12 shrink-0 sm:w-16', homeWins ? 'font-semibold text-ink-1' : 'text-ink-2')}>{formatStat(home, format)}</span>
        <span className="min-w-0 text-balance text-center text-[12px] leading-snug text-ink-2">
          {label}
          {leagueAvg !== undefined && <span className="block whitespace-nowrap text-ink-3 sm:ml-1 sm:inline">(media {formatStat(leagueAvg, format)})</span>}
        </span>
        <span className={cx('num w-12 shrink-0 text-right sm:w-16', awayWins ? 'font-semibold text-ink-1' : 'text-ink-2')}>{formatStat(away, format)}</span>
      </div>
      <div className="flex h-1.5 gap-[2px]" aria-hidden="true">
        <div className="flex flex-1 justify-end rounded-l-full bg-surface-3">
          <div className="rounded-l-full" style={{ width: `${hs * 100}%`, background: SIDE_COLOR.home, opacity: homeWins || !awayWins ? 1 : 0.45 }} />
        </div>
        <div className="flex flex-1 justify-start rounded-r-full bg-surface-3">
          <div className="rounded-r-full" style={{ width: `${as * 100}%`, background: SIDE_COLOR.away, opacity: awayWins || !homeWins ? 1 : 0.45 }} />
        </div>
      </div>
    </div>
  );
}
