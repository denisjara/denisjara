import type { ElementType, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export interface CardProps {
  as?: ElementType;
  className?: string;
  /** padding interno: 'none' | 'sm' (12px) | 'md' (16px, por defecto) | 'lg' (20px) */
  pad?: 'none' | 'sm' | 'md' | 'lg';
  /** estilo hover (para tarjetas clicables) */
  interactive?: boolean;
  children?: ReactNode;
  [key: string]: unknown;
}

const PAD = { none: '', sm: 'p-3', md: 'p-4', lg: 'p-5' } as const;

/** Superficie base: borde hairline, fondo surface-1, radio 14px. */
export function Card({ as: Tag = 'div', className, pad = 'md', interactive, children, ...rest }: CardProps) {
  return (
    <Tag className={cx('card relative min-w-0', PAD[pad], interactive && 'card-hover', className)} {...rest}>
      {children}
    </Tag>
  );
}

export interface SectionProps {
  title: ReactNode;
  /** texto pequeño en mayúsculas sobre el título */
  eyebrow?: ReactNode;
  description?: ReactNode;
  /** icono lucide junto al título */
  icon?: ReactNode;
  /** enlace "Ver todo" a la derecha */
  moreTo?: string;
  moreLabel?: string;
  /** controles a la derecha (SegmentedControl, etc.) */
  action?: ReactNode;
  id?: string;
  className?: string;
  children?: ReactNode;
}

/** Bloque de página con cabecera (h2) estilo rótulo de retransmisión. */
export function Section({ title, eyebrow, description, icon, moreTo, moreLabel = 'Ver todo', action, id, className, children }: SectionProps) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section id={id} aria-labelledby={headingId} className={cx('min-w-0 animate-fade-up', className)}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
          <h2 id={headingId} className="display flex items-center gap-2 text-[22px] text-ink-1 sm:text-[26px]">
            {icon && <span className="text-accent-text [&>svg]:h-5 [&>svg]:w-5" aria-hidden="true">{icon}</span>}
            {title}
          </h2>
          {description && <p className="mt-1 max-w-2xl text-[13px] text-ink-2">{description}</p>}
        </div>
        <div className="flex items-center gap-2">
          {action}
          {moreTo && (
            <Link to={moreTo} className="btn-ghost -mr-2 shrink-0">
              {moreLabel}
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

export interface PageHeaderProps {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  /** controles a la derecha */
  actions?: ReactNode;
  /** contenido extra bajo el título (KPIs, filtros) */
  children?: ReactNode;
  /** dibuja las marcas de campo de fondo */
  pitch?: boolean;
  className?: string;
}

/** Cabecera de página (h1). Una por página. */
export function PageHeader({ title, eyebrow, description, actions, children, pitch = true, className }: PageHeaderProps) {
  return (
    <header className={cx('relative overflow-hidden rounded-card border border-line bg-surface-1/70 px-4 py-5 sm:px-6 sm:py-6', className)}>
      {pitch && <div className="pitch-lines pointer-events-none absolute inset-0 opacity-[0.05]" aria-hidden="true" />}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent" aria-hidden="true" />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && <div className="eyebrow mb-1.5 text-accent-text">{eyebrow}</div>}
          <h1 className="display text-[34px] text-ink-1 sm:text-[44px]">{title}</h1>
          {description && <p className="mt-2 max-w-3xl text-[14px] text-ink-2">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="relative mt-5">{children}</div>}
    </header>
  );
}
