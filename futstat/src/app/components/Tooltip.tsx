import { useId, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { cx } from './Card';

export interface TooltipProps {
  /** contenido del globo (texto corto o nodos) */
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom';
  align?: 'center' | 'start' | 'end';
  className?: string;
  /** ancho máximo del globo en px */
  maxWidth?: number;
}

/**
 * Tooltip ligero: aparece con hover y con foco de teclado (el hijo debe ser enfocable o el
 * envoltorio recibe tabIndex). Nunca debe ser la única vía para leer un dato.
 */
export function Tooltip({ content, children, side = 'top', align = 'center', className, maxWidth = 260 }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const pos = side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2';
  const al = align === 'center' ? 'left-1/2 -translate-x-1/2' : align === 'start' ? 'left-0' : 'right-0';
  return (
    <span
      className={cx('relative inline-flex', className)}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      aria-describedby={open ? id : undefined}
    >
      {children}
      <span
        id={id}
        role="tooltip"
        hidden={!open}
        className={cx(
          'pointer-events-none absolute z-50 w-max rounded-lg border border-line-strong bg-surface-2 px-2.5 py-1.5 text-left text-[12px] font-normal normal-case leading-snug tracking-normal text-ink-1 shadow-pop',
          pos,
          al,
        )}
        style={{ maxWidth }}
      >
        {content}
      </span>
    </span>
  );
}

/** Icono (i) con tooltip, para explicar métricas junto a un título. */
export function InfoTip({ content, label = 'Más información' }: { content: ReactNode; label?: string }) {
  return (
    <Tooltip content={content}>
      <button type="button" className="inline-flex h-5 w-5 items-center justify-center rounded-full text-ink-3 hover:text-ink-1" aria-label={label}>
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
