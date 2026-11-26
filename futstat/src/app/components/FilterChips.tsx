import type { ReactNode } from 'react';
import { int } from '../lib/format';
import { cx } from './Card';

/**
 * Chip de filtro con estado pulsado (aria-pressed) y recuento opcional: días, competiciones, categorías o tipos de
 * apuesta en /hoy y /cuota-alta. El activo lleva borde en acento (no solo color: también `aria-pressed`).
 */
export function FilterChip({
  active,
  onClick,
  count,
  disabled,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  disabled?: boolean;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cx(
        'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        active ? 'border-accent-text bg-surface-3 text-ink-1' : 'border-line bg-surface-2 text-ink-2 hover:text-ink-1',
      )}
    >
      {children}
      {count !== undefined && <span className="num text-[11px] text-ink-3">{int(count)}</span>}
    </button>
  );
}

/** Fila de chips con etiqueta (oculta en móvil, solo para lectores de pantalla) y scroll horizontal propio. */
export function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="eyebrow w-[86px] shrink-0 max-sm:sr-only">{label}</span>
      <div className="-mx-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-1 py-1 scrollbar-none" role="group" aria-label={label}>
        {children}
      </div>
    </div>
  );
}
