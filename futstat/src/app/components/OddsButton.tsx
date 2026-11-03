import { Link } from 'react-router-dom';
import { Zap } from 'lucide-react';
import type { ValuePick } from '../../types/data';
import { ev as fmtEv, odds as fmtOdds, pct } from '../lib/format';
import { pickMarketLabel, pickSelection } from '../lib/picks';
import { cx } from './Card';

export interface OddsButtonProps {
  /** nombre de la selección: "Local", "Más de 2.5", "2-1" */
  label: string;
  /** probabilidad del modelo [0,1] */
  prob: number;
  /** cuota justa (1/prob); se calcula si falta */
  fairOdds?: number;
  /** cuota de la casa, si existe */
  marketOdds?: number;
  /** valor esperado por unidad con la cuota de mercado */
  ev?: number;
  /** nota extra (línea, detalle de hándicap) */
  note?: string;
  /** resalta como la selección más probable del mercado */
  highlight?: boolean;
  /** EV mínimo para mostrar la insignia "Valor" (por defecto 0,05 = umbral de picks) */
  valueThreshold?: number;
  selected?: boolean;
  onClick?: () => void;
  href?: string;
  compact?: boolean;
  className?: string;
}

/**
 * Selección estilo casa de apuestas: etiqueta, cuota (de mercado si existe; si no, la justa),
 * probabilidad del modelo y, con cuota de mercado, cuota justa + EV. El EV positivo se marca en
 * verde con signo "+" (nunca solo color).
 */
export function OddsButton({ label, prob, fairOdds, marketOdds, ev, note, highlight, valueThreshold = 0.05, selected, onClick, href, compact, className }: OddsButtonProps) {
  const fair = fairOdds ?? (prob > 0 ? Math.min(1000, 1 / prob) : undefined);
  const hasMarket = typeof marketOdds === 'number' && marketOdds > 1;
  const value = typeof ev === 'number' && hasMarket && ev >= valueThreshold;
  const body = (
    <>
      <span className="flex w-full items-start justify-between gap-2">
        <span className={cx('min-w-0 truncate text-left font-medium', compact ? 'text-[11.5px]' : 'text-[12.5px]', 'text-ink-2')} title={label}>
          {label}
          {note && <span className="ml-1 text-ink-3">{note}</span>}
        </span>
        {value && (
          <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-accent px-1 py-px text-[10px] font-bold uppercase tracking-wide text-accent-ink">
            <Zap className="h-2.5 w-2.5" aria-hidden="true" /> Valor
          </span>
        )}
      </span>
      <span className="mt-1 flex w-full items-end justify-between gap-2">
        <span className={cx('num font-semibold leading-none text-ink-1', compact ? 'text-[15px]' : 'text-[18px]')}>
          {fmtOdds(hasMarket ? marketOdds : fair)}
        </span>
        <span className="num text-[12px] font-medium text-ink-2">{pct(prob, prob < 0.1 ? 1 : 0)}</span>
      </span>
      {!compact && (
        <span className="mt-1.5 flex w-full items-center justify-between gap-2 border-t border-line pt-1.5 text-2xs text-ink-3">
          {hasMarket ? (
            <>
              <span>
                Justa <span className="num text-ink-2">{fmtOdds(fair)}</span>
              </span>
              {typeof ev === 'number' && (
                <span className={cx('num font-semibold', ev > 0 ? 'text-pos' : 'text-ink-3')}>EV {fmtEv(ev)}</span>
              )}
            </>
          ) : (
            <span>Cuota justa del modelo</span>
          )}
        </span>
      )}
    </>
  );
  const cls = cx(
    'group relative flex min-w-0 flex-col items-stretch rounded-lg border px-2.5 py-2 text-left transition-colors',
    selected
      ? 'border-accent-text bg-accent/10'
      : value
        ? 'border-accent-text/50 bg-surface-2 hover:border-accent-text'
        : highlight
          ? 'border-line-strong bg-surface-3/70 hover:border-ink-3'
          : 'border-line bg-surface-2 hover:border-line-strong hover:bg-surface-3',
    className,
  );
  const aria = `${label}: probabilidad ${pct(prob, 1)}, cuota ${hasMarket ? `de mercado ${fmtOdds(marketOdds)}` : `justa ${fmtOdds(fair)}`}${
    typeof ev === 'number' ? `, valor esperado ${fmtEv(ev)}` : ''
  }`;
  if (href) {
    return (
      <Link to={href} className={cls} aria-label={aria}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} aria-pressed={selected} className={cls} aria-label={aria}>
        {body}
      </button>
    );
  }
  return (
    <div className={cls} role="group" aria-label={aria}>
      {body}
    </div>
  );
}

export interface ValuePickChipProps {
  pick: ValuePick;
  className?: string;
  /** muestra también el stake Kelly */
  showKelly?: boolean;
}

/** Píldora compacta de un pick de valor: "⚡ Local @ 2,10 · EV +6,2%". */
export function ValuePickChip({ pick, className, showKelly }: ValuePickChipProps) {
  return (
    <span
      className={cx('inline-flex max-w-full items-center gap-1.5 rounded-md border border-accent-text/40 bg-accent/10 px-2 py-1 text-[12px]', className)}
      title={`${pickMarketLabel(pick)}: ${pickSelection(pick)} — prob. ${pct(pick.prob, 1)}, cuota ${fmtOdds(pick.odds)}, justa ${fmtOdds(pick.fairOdds)}`}
    >
      <Zap className="h-3.5 w-3.5 shrink-0 text-accent-text" aria-hidden="true" />
      <span className="truncate font-medium text-ink-1">{pickSelection(pick)}</span>
      <span className="num shrink-0 text-ink-2">@ {fmtOdds(pick.odds)}</span>
      <span className="num shrink-0 font-semibold text-pos">{fmtEv(pick.ev)}</span>
      {showKelly && <span className="num shrink-0 text-ink-3">· {pct(pick.kelly, 1)} banca</span>}
    </span>
  );
}
