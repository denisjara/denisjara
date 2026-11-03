import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { cx } from './Card';
import { SafeBlock } from './ErrorBoundary';

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  /** contador / insignia */
  badge?: ReactNode;
  disabled?: boolean;
}

/**
 * Pestaña activa sincronizada con la URL (?tab=...). Valores desconocidos caen en `defaultId`.
 * const [tab, setTab] = useUrlTab(['resumen','tabla'] as const, 'resumen');
 */
export function useUrlTab<T extends string>(ids: readonly T[], defaultId: T, param = 'tab'): [T, (id: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(param) as T | null;
  const active = raw && ids.includes(raw) ? raw : defaultId;
  const set = useCallback(
    (id: T) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id === defaultId) next.delete(param);
          else next.set(param, id);
          return next;
        },
        { replace: true },
      );
    },
    [setParams, defaultId, param],
  );
  return [active, set];
}

export interface TabsProps<T extends string> {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** prefijo de ids para enlazar tab ↔ panel (usa el mismo en <TabPanel>) */
  idBase: string;
  /** nombre accesible de la lista */
  ariaLabel?: string;
  className?: string;
}

/**
 * Lista de pestañas accesible (role=tablist, flechas/Inicio/Fin, activación automática).
 * Barra inferior con el acento en la activa. Desplazable en móvil.
 */
export function Tabs<T extends string>({ tabs, value, onChange, idBase, ariaLabel, className }: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = tabs.filter((t) => !t.disabled);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const idx = enabled.findIndex((t) => t.id === value);
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % enabled.length;
    if (e.key === 'ArrowLeft') next = (idx - 1 + enabled.length) % enabled.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = enabled.length - 1;
    const t = enabled[next];
    onChange(t.id);
    refs.current[tabs.indexOf(t)]?.focus();
  };

  // En móvil la lista se desplaza: difumina el borde por el que quedan pestañas ocultas y mantiene visible la activa.
  const listRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((p) => (p.left === left && p.right === right ? p : { left, right }));
  }, []);
  useEffect(() => {
    measure();
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, tabs.length]);
  useEffect(() => {
    const el = listRef.current;
    const btn = refs.current[tabs.findIndex((t) => t.id === value)];
    if (!el || !btn || el.scrollWidth <= el.clientWidth) return;
    const l = btn.offsetLeft - 32;
    const r = btn.offsetLeft + btn.offsetWidth + 32;
    if (l < el.scrollLeft) el.scrollTo({ left: Math.max(0, l), behavior: 'smooth' });
    else if (r > el.scrollLeft + el.clientWidth) el.scrollTo({ left: r - el.clientWidth, behavior: 'smooth' });
  }, [value]);
  const mask =
    edges.left || edges.right
      ? `linear-gradient(to right, ${edges.left ? 'transparent, #000 32px' : '#000'}, ${edges.right ? '#000 calc(100% - 32px), transparent' : '#000'})`
      : undefined;

  return (
    <div className={cx('relative border-b border-line', className)}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={ariaLabel}
        onScroll={measure}
        className="scrollbar-none -mb-px flex gap-1 overflow-x-auto"
        style={mask ? { WebkitMaskImage: mask, maskImage: mask } : undefined}
      >
        {tabs.map((t, i) => {
          const active = t.id === value;
          return (
            <button
              key={t.id}
              ref={(el) => (refs.current[i] = el)}
              id={`${idBase}-tab-${t.id}`}
              role="tab"
              type="button"
              aria-selected={active}
              aria-controls={`${idBase}-panel-${t.id}`}
              tabIndex={active ? 0 : -1}
              disabled={t.disabled}
              onClick={() => onChange(t.id)}
              onKeyDown={onKey}
              className={cx(
                'relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] font-semibold transition-colors disabled:opacity-40',
                active ? 'border-accent-text text-ink-1' : 'border-transparent text-ink-3 hover:text-ink-1',
              )}
            >
              {t.icon && <span className="[&>svg]:h-4 [&>svg]:w-4" aria-hidden="true">{t.icon}</span>}
              {t.label}
              {t.badge !== undefined && (
                <span className={cx('num rounded px-1 text-2xs font-medium', active ? 'bg-surface-3 text-ink-1' : 'bg-surface-2 text-ink-3')}>{t.badge}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface TabPanelProps {
  idBase: string;
  id: string;
  /** id de la pestaña activa */
  active: string;
  children: ReactNode;
  className?: string;
  /** mantener montado aunque esté oculto (por defecto solo se monta el activo) */
  keepMounted?: boolean;
}

export function TabPanel({ idBase, id, active, children, className, keepMounted }: TabPanelProps) {
  const isActive = id === active;
  if (!isActive && !keepMounted) return null;
  return (
    <div
      role="tabpanel"
      id={`${idBase}-panel-${id}`}
      aria-labelledby={`${idBase}-tab-${id}`}
      hidden={!isActive}
      tabIndex={0}
      className={cx('pt-5 focus-visible:outline-offset-4', className)}
    >
      <SafeBlock resetKey={id}>{children}</SafeBlock>
    </div>
  );
}
