import type { Outcome } from '../../types/data';
import { OUTCOME_CLASS } from '../lib/colors';
import { OUTCOME_LABEL, OUTCOME_LETTER } from '../lib/format';
import { cx } from './Card';

export interface FormChipsProps {
  /** cadena cronológica "WWDLW" (el más reciente al FINAL, a la derecha) */
  form: string | undefined;
  /** cuántos resultados mostrar (los últimos N). Por defecto 5 */
  max?: number;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
  /** muestra "Últimos 5" delante para lectores de pantalla y visualmente */
  label?: string;
}

const SIZE = {
  xs: 'h-4 w-4 text-[9.5px] rounded-[3px]',
  sm: 'h-5 w-5 text-[11px] rounded-[4px]',
  md: 'h-6 w-6 text-[12px] rounded-[5px]',
} as const;

/**
 * Racha de resultados con letra visible V/E/D (Victoria/Empate/Derrota) + color.
 * El más reciente queda a la derecha y se marca con un subrayado.
 */
export function FormChips({ form, max = 5, size = 'sm', className, label }: FormChipsProps) {
  const items = (form ?? '').toUpperCase().replace(/[^WDL]/g, '').slice(-max).split('').filter(Boolean) as Outcome[];
  if (!items.length) return <span className={cx('text-2xs text-ink-3', className)}>Sin datos</span>;
  const aria = `${label ?? 'Forma reciente'}: ${items.map((o) => OUTCOME_LABEL[o]).join(', ')} (el más reciente al final)`;
  return (
    <span className={cx('inline-flex items-center gap-[3px]', className)} role="img" aria-label={aria}>
      {label && <span className="mr-1 text-2xs text-ink-3" aria-hidden="true">{label}</span>}
      {items.map((o, i) => (
        <span
          key={i}
          aria-hidden="true"
          title={OUTCOME_LABEL[o]}
          className={cx(
            'forced-border inline-flex items-center justify-center font-mono font-semibold leading-none',
            SIZE[size],
            OUTCOME_CLASS[o],
            i === items.length - 1 && 'shadow-[0_2px_0_0_rgb(var(--c-ink-1)/0.75)]',
          )}
        >
          {OUTCOME_LETTER[o]}
        </span>
      ))}
    </span>
  );
}

/** Un único resultado V/E/D. */
export function OutcomeChip({ outcome, size = 'sm', className }: { outcome: Outcome; size?: 'xs' | 'sm' | 'md'; className?: string }) {
  return (
    <span
      title={OUTCOME_LABEL[outcome]}
      aria-label={OUTCOME_LABEL[outcome]}
      className={cx('forced-border inline-flex items-center justify-center font-mono font-semibold leading-none', SIZE[size], OUTCOME_CLASS[outcome], className)}
    >
      {OUTCOME_LETTER[outcome]}
    </span>
  );
}
