/**
 * Piezas pequeñas de interfaz que usan todas las pantallas: ventana modal, menú desplegable, campo numérico,
 * avisos y suscripción al estado del visor.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import { getRuntime, type SheetRuntime } from '../app/plans';
import { store, useStore } from '../app/store';
import type { Sheet } from '../core/model';
import { formatNumber, parseNumber } from '../core/units';
import { getViewerStatus, subscribeViewerStatus, type ViewerStatus } from '../viewer/controller';

export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');

export function useViewerStatus(): ViewerStatus {
  return useSyncExternalStore(subscribeViewerStatus, getViewerStatus);
}

/** Datos de lectura de una lámina (capas, estilos, textos…). null mientras se cargan. */
export function useRuntime(sheet: Sheet | null): SheetRuntime | null {
  const [rt, setRt] = useState<SheetRuntime | null>(null);
  const id = sheet?.id ?? null;
  useEffect(() => {
    let alive = true;
    setRt(null);
    if (sheet) {
      getRuntime(sheet)
        .then((r) => alive && setRt(r))
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
    // Solo depende de qué lámina es: el objeto cambia con cada edición del proyecto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return rt;
}

export function useIsNarrow(maxWidth = 900): boolean {
  const query = `(max-width: ${maxWidth - 1}px)`;
  return useSyncExternalStore(
    (fn) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', fn);
      return () => mq.removeEventListener('change', fn);
    },
    () => window.matchMedia(query).matches,
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cx('animate-spin', className)} size={18} aria-hidden />;
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]), select, textarea, button.btn-primary');
    (first ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgb(var(--c-shadow)/0.45)] sm:items-center sm:p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx('flex max-h-[92%] w-full animate-sheet-up flex-col rounded-t-xl border border-line bg-panel shadow-pop outline-none sm:rounded-xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}
      >
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-bold">
            {title}
          </h2>
          <button type="button" className="icon-btn -mr-1.5" onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** Menú desplegable anclado a su botón. Se cierra al elegir, al pulsar fuera o con Esc. */
export function Menu({ className, content, children, align = 'right', label, up }: { className: string; content: ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; label: string; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" className={className} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((o) => !o)}>
        {content}
      </button>
      {open && (
        <div role="menu" className={cx('float absolute z-40 max-h-[70vh] min-w-[15rem] animate-pop-in overflow-y-auto p-1', up ? 'bottom-full mb-1.5' : 'top-full mt-1.5', align === 'right' ? 'right-0' : 'left-0')}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, danger, disabled, hint }: { icon?: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cx('flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-panel-3 disabled:opacity-40 disabled:hover:bg-transparent', danger && 'text-danger')}
    >
      <span className="grid w-5 shrink-0 place-items-center text-ink-3">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {hint && <span className="text-2xs text-ink-3">{hint}</span>}
    </button>
  );
}

/**
 * Campo para un número: admite punto o coma decimal y confirma al salir o con Intro.
 * `value` undefined = vacío. Con `onChange(undefined)` se borra el valor.
 */
export function NumberField({
  id,
  value,
  onChange,
  placeholder,
  decimals = 3,
  className,
  ariaLabel,
  autoFocus,
  allowNegative,
}: {
  id?: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  placeholder?: string;
  decimals?: number;
  className?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  allowNegative?: boolean;
}) {
  const show = (v: number | undefined): string => (v === undefined || !Number.isFinite(v) ? '' : String(Number(v.toFixed(Math.max(decimals, 4)))));
  const [text, setText] = useState(show(value));
  const [focused, setFocused] = useState(false);
  const [bad, setBad] = useState(false);
  useLayoutEffect(() => {
    if (!focused) setText(show(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);
  const commit = () => {
    const t = text.trim();
    if (!t) {
      setBad(false);
      if (value !== undefined) onChange(undefined);
      return;
    }
    const n = parseNumber(t);
    if (n === null || (!allowNegative && n < 0)) {
      setBad(true);
      return;
    }
    setBad(false);
    if (n !== value) onChange(n);
  };
  return (
    <input
      id={id}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      aria-invalid={bad || undefined}
      placeholder={placeholder}
      className={cx('field num text-right', bad && '!border-danger', className)}
      value={text}
      onFocus={(e) => {
        setFocused(true);
        e.currentTarget.select();
      }}
      onChange={(e) => {
        setText(e.target.value);
        setBad(false);
      }}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setText(show(value));
          setBad(false);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.ui.toasts);
  if (!toasts.length) return null;
  return (
    <div
      className="pointer-events-none fixed z-[60] flex flex-col gap-2 max-md:inset-x-0 max-md:top-[calc(3.5rem+env(safe-area-inset-top,0px))] max-md:items-center max-md:px-4 md:bottom-10 md:left-[max(1rem,env(safe-area-inset-left,0px))] md:items-start"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            'pointer-events-auto flex max-w-xl animate-pop-in items-start gap-3 rounded-lg border px-3.5 py-2.5 shadow-pop',
            t.kind === 'error' ? 'border-danger/40 bg-danger-soft text-ink' : 'border-line bg-panel',
          )}
        >
          <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', t.kind === 'error' ? 'bg-danger' : t.kind === 'ok' ? 'bg-ok' : 'bg-accent')} />
          <p className="min-w-0 flex-1 break-words">{t.text}</p>
          {t.action && (
            <button
              type="button"
              className="shrink-0 font-bold text-accent-text hover:underline"
              onClick={() => {
                t.action!.run();
                store.dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="-mr-1 shrink-0 text-ink-3 hover:text-ink" onClick={() => store.dismissToast(t.id)} aria-label="Cerrar aviso">
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}

export const fmt = formatNumber;

/** Punto de color de una partida. */
export function Swatch({ color, size = 12 }: { color: string; size?: number }) {
  return <span className="inline-block shrink-0 rounded-[3px]" style={{ width: size, height: size, background: color }} aria-hidden />;
}
