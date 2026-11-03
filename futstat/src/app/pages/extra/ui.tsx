/**
 * Piezas locales compartidas por las páginas Jugadores, Valor y Modelo.
 * (No forman parte de src/app/components: solo las usan estas páginas.)
 */
import { useCallback, useId, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, Clock } from 'lucide-react';
import type { PlayerRef, ValuePick } from '../../../types/data';
import { cx } from '../../components';
import { dateTime, int, num, timeAgo } from '../../lib/format';

// ---------------------------------------------------------------------------
// Posiciones
// ---------------------------------------------------------------------------
export type Position = PlayerRef['position'];
export const POSITION_SHORT: Record<Position, string> = { G: 'POR', D: 'DEF', M: 'MED', F: 'DEL', '?': '—' };
export const POSITION_LONG: Record<Position, string> = {
  G: 'Portero',
  D: 'Defensa',
  M: 'Centrocampista',
  F: 'Delantero',
  '?': 'Sin posición',
};

/** Etiqueta compacta de posición (POR/DEF/MED/DEL) con el nombre completo para lectores de pantalla. */
export function PositionTag({ position, className }: { position: Position; className?: string }) {
  return (
    <span className={cx('inline-flex shrink-0 items-center rounded bg-surface-3 px-1 font-mono text-[10px] font-medium leading-4 text-ink-2', className)} title={POSITION_LONG[position]}>
      <span aria-hidden="true">{POSITION_SHORT[position]}</span>
      <span className="sr-only">{POSITION_LONG[position]}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Controles de filtro
// ---------------------------------------------------------------------------
/** Campo de filtro con etiqueta visible en mayúsculas pequeñas. */
export function FilterField({ label, htmlFor, children, className }: { label: string; htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex min-w-0 flex-col gap-1.5', className)}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="eyebrow">
          {label}
        </label>
      ) : (
        <span className="eyebrow" aria-hidden="true">
          {label}
        </span>
      )}
      {children}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  count?: number;
}

/** Select nativo con el estilo de los controles (accesible y cómodo en móvil). */
export function SelectInput({
  id,
  value,
  onChange,
  options,
  className,
  ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <span className={cx('relative inline-flex min-w-0', className)}>
      <select
        id={id}
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
        className="input h-[34px] cursor-pointer appearance-none py-1.5 pr-8 font-medium"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
            {typeof o.count === 'number' ? ` (${o.count})` : ''}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden="true" />
    </span>
  );
}

/** Interruptor accesible (role=switch). */
export function ToggleSwitch({ checked, onChange, label, className }: { checked: boolean; onChange: (v: boolean) => void; label: string; className?: string }) {
  const id = useId();
  return (
    <span className={cx('inline-flex items-center gap-2', className)}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative h-5 w-9 shrink-0 rounded-full border transition-colors',
          checked ? 'border-accent-text bg-accent/80' : 'border-line-strong bg-surface-3',
        )}
      >
        <span
          className={cx('absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full shadow transition-[left]', checked ? 'left-[18px] bg-accent-ink' : 'left-[2px] bg-ink-2')}
          aria-hidden="true"
        />
      </button>
      <label htmlFor={id} className="cursor-pointer select-none text-[13px] text-ink-2">
        {label}
      </label>
    </span>
  );
}

/**
 * Parámetro de búsqueda en la URL (?comp=laliga) con valor por defecto. Valores fuera de
 * `allowed` (si se indica) caen en el valor por defecto.
 */
export function useUrlParam(name: string, defaultValue: string, allowed?: readonly string[]): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(name);
  const value = raw !== null && (!allowed || allowed.includes(raw)) ? raw : defaultValue;
  const set = useCallback(
    (v: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (v === defaultValue) next.delete(name);
          else next.set(name, v);
          return next;
        },
        { replace: true },
      );
    },
    [setParams, name, defaultValue],
  );
  return [value, set];
}

// ---------------------------------------------------------------------------
// Pequeñas piezas de presentación
// ---------------------------------------------------------------------------
/** "Actualizado hace 3 h" con la fecha completa en title. */
export function UpdatedAt({ date, className }: { date: string | undefined; className?: string }) {
  if (!date) return null;
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-[12px] text-ink-3', className)} title={dateTime(date)}>
      <Clock className="h-3.5 w-3.5" aria-hidden="true" />
      Actualizado {timeAgo(date)}
    </span>
  );
}

/** Cifra compacta dentro de una tarjeta (etiqueta + valor + pista). */
export function MiniStat({ label, value, hint, className, emphasis }: { label: ReactNode; value: ReactNode; hint?: ReactNode; className?: string; emphasis?: boolean }) {
  return (
    <div className={cx('min-w-0 rounded-lg border border-line bg-surface-2/70 px-3 py-2', className)}>
      <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-ink-3">{label}</div>
      <div className={cx('font-display text-[22px] font-extrabold leading-tight', emphasis ? 'text-accent-text' : 'text-ink-1')}>{value}</div>
      {hint && <div className="truncate text-2xs text-ink-3">{hint}</div>}
    </div>
  );
}

const CONF_BARS: Record<ValuePick['confidence'], number> = { alta: 3, media: 2, baja: 1 };
const CONF_LABEL: Record<ValuePick['confidence'], string> = { alta: 'Alta', media: 'Media', baja: 'Baja' };

/** Confianza categórica (alta/media/baja): 3 barras tipo señal + texto (nunca solo color). */
export function ConfidenceTag({ level, className, showLabel = true }: { level: ValuePick['confidence']; className?: string; showLabel?: boolean }) {
  const bars = CONF_BARS[level] ?? 1;
  return (
    <span className={cx('inline-flex items-center gap-1.5', className)} title={`Confianza ${CONF_LABEL[level].toLowerCase()}`}>
      <span className="flex items-end gap-[2px]" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span key={i} className={cx('w-[3px] rounded-[1px]', i < bars ? 'bg-accent-text' : 'bg-surface-3')} style={{ height: 5 + i * 3 }} />
        ))}
      </span>
      {showLabel ? <span className="text-2xs font-medium text-ink-2">{CONF_LABEL[level]}</span> : <span className="sr-only">Confianza {CONF_LABEL[level].toLowerCase()}</span>}
    </span>
  );
}

/** Formatea un parámetro numérico con los decimales justos (máx. 4). */
export function fmtParam(v: number | string): string {
  if (typeof v === 'string') return v;
  if (!Number.isFinite(v)) return '—';
  if (Number.isInteger(v)) return int(v);
  for (let d = 1; d <= 4; d++) {
    if (Math.abs(Math.round(v * 10 ** d) / 10 ** d - v) < 1e-9) return num(v, d);
  }
  return num(v, 4);
}
