import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './Card';

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  /** contador opcional a la derecha */
  count?: number;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  /** nombre accesible del grupo (obligatorio) */
  ariaLabel: string;
  size?: 'sm' | 'md';
  className?: string;
  /** ocupa todo el ancho repartiendo segmentos */
  full?: boolean;
}

/** Selector exclusivo (radiogroup) con navegación por flechas. */
export function SegmentedControl<T extends string>({ options, value, onChange, ariaLabel, size = 'md', className, full }: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.filter((o) => !o.disabled);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const idx = enabled.findIndex((o) => o.value === value);
    let next = idx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % enabled.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + enabled.length) % enabled.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = enabled.length - 1;
    const opt = enabled[next];
    onChange(opt.value);
    refs.current[options.indexOf(opt)]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cx('inline-flex rounded-lg border border-line bg-surface-2 p-0.5', full && 'flex w-full', className)}>
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => (refs.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={onKey}
            className={cx(
              'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:opacity-40',
              size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-3 py-1.5 text-[13px]',
              full && 'flex-1',
              active ? 'bg-surface-3 text-ink-1 shadow-[inset_0_-2px_0_0_rgb(var(--c-accent-text))]' : 'text-ink-2 hover:text-ink-1',
            )}
          >
            {o.label}
            {typeof o.count === 'number' && (
              <span className={cx('num rounded px-1 text-2xs', active ? 'bg-bg/60 text-ink-1' : 'bg-surface-3 text-ink-3')}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
