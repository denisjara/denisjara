import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import { cx } from './Card';
import { Sparkline } from './Sparkline';

export interface KpiTileProps {
  label: string;
  /** valor ya formateado ("1.284", "54%") */
  value: ReactNode;
  /** unidad pequeña tras el valor */
  unit?: string;
  /** texto secundario bajo el valor */
  hint?: ReactNode;
  /** variación: texto con signo + dirección + si subir es bueno */
  delta?: { text: string; direction: 'up' | 'down' | 'flat'; good?: boolean };
  /** serie corta para sparkline (cronológica) */
  trend?: number[];
  icon?: ReactNode;
  className?: string;
  /** destaca la cifra con el acento (usar en UNA KPI como mucho) */
  accent?: boolean;
}

/** Tarjeta de cifra clave: etiqueta, valor grande (display), delta y sparkline opcionales. */
export function KpiTile({ label, value, unit, hint, delta, trend, icon, className, accent }: KpiTileProps) {
  const DeltaIcon = delta?.direction === 'up' ? ArrowUpRight : delta?.direction === 'down' ? ArrowDownRight : ArrowRight;
  const deltaColor = !delta || delta.direction === 'flat' || delta.good === undefined ? 'text-ink-2' : delta.good ? 'text-pos' : 'text-neg';
  return (
    <div className={cx('card relative flex min-w-0 flex-col justify-between gap-2 overflow-hidden p-3.5 sm:p-4', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow leading-tight">{label}</span>
        {icon && <span className="hidden shrink-0 text-ink-3 sm:block [&>svg]:h-4 [&>svg]:w-4" aria-hidden="true">{icon}</span>}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className={cx('font-display text-[34px] font-extrabold leading-none tracking-tight sm:text-[40px]', accent ? 'text-accent-text' : 'text-ink-1')}>
            {value}
            {unit && <span className="ml-1 font-sans text-[13px] font-medium tracking-normal text-ink-3">{unit}</span>}
          </div>
          {(hint || delta) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-3">
              {delta && (
                <span className={cx('inline-flex items-center gap-0.5 font-semibold', deltaColor)}>
                  <DeltaIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  {delta.text}
                </span>
              )}
              {hint && <span className="line-clamp-2">{hint}</span>}
            </div>
          )}
        </div>
        {trend && trend.length > 1 && <Sparkline values={trend} width={72} height={28} ariaLabel={`Tendencia de ${label}`} />}
      </div>
    </div>
  );
}
