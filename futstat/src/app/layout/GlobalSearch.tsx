import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Trophy, X } from 'lucide-react';
import { useMeta } from '../lib/data';
import { normalizeText } from '../lib/format';
import { useDismiss, useHotkey } from '../lib/hooks';
import { KIND_LABEL } from '../lib/competitions';
import { TeamCrest } from '../components/TeamCrest';
import { cx } from '../components/Card';

interface Result {
  kind: 'comp' | 'team';
  id: string;
  label: string;
  sub: string;
  href: string;
  flag?: string;
  logo?: string;
  abbr?: string;
}

export interface GlobalSearchProps {
  /** registra el atajo "/" para enfocar */
  hotkey?: boolean;
  autoFocus?: boolean;
  /** se llama tras navegar (cerrar overlay móvil) */
  onNavigate?: () => void;
  className?: string;
}

const MAX = 8;

/**
 * Buscador global (combobox ARIA): equipos (meta.teams) y competiciones (meta.competitions).
 * Navega a /t/:id o /c/:id. Atajo "/" para enfocar, ↑/↓ para moverse, Enter para abrir, Esc para cerrar.
 */
export function GlobalSearch({ hotkey, autoFocus, onNavigate, className }: GlobalSearchProps) {
  const { data: meta } = useMeta();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useHotkey(
    '/',
    (e) => {
      e.preventDefault();
      inputRef.current?.focus();
      setOpen(true);
    },
    !!hotkey,
  );
  useDismiss(wrapRef, open, () => setOpen(false));
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const compName = useMemo(() => new Map((meta?.competitions ?? []).map((c) => [c.id, c.shortName])), [meta]);

  const results = useMemo<Result[]>(() => {
    if (!meta) return [];
    const nq = normalizeText(q);
    const comps = meta.competitions
      .filter((c) => !nq || normalizeText(`${c.name} ${c.shortName} ${c.country}`).includes(nq))
      .sort((a, b) => b.tier - a.tier)
      .map<Result>((c) => ({ kind: 'comp', id: c.id, label: c.name, sub: `${c.country} · ${KIND_LABEL[c.kind]}`, href: `/c/${c.id}`, flag: c.flag }));
    if (!nq) return comps.slice(0, 6);
    const teams = meta.teams
      .map((t) => {
        const name = normalizeText(t.name);
        const abbr = normalizeText(t.abbr);
        const score = name.startsWith(nq) ? 0 : abbr === nq ? 0 : name.split(/\s+/).some((w) => w.startsWith(nq)) ? 1 : name.includes(nq) ? 2 : abbr.includes(nq) ? 3 : 9;
        return { t, score };
      })
      .filter((x) => x.score < 9)
      .sort((a, b) => a.score - b.score || a.t.name.localeCompare(b.t.name, 'es'))
      .map<Result>(({ t }) => ({ kind: 'team', id: t.id, label: t.name, sub: compName.get(t.compId) ?? t.abbr, href: `/t/${t.id}`, logo: t.logo, abbr: t.abbr }));
    return [...teams.slice(0, MAX - Math.min(3, comps.length)), ...comps.slice(0, 3)].slice(0, MAX);
  }, [meta, q, compName]);

  useEffect(() => setActive(0), [q]);

  const go = (r: Result) => {
    navigate(r.href);
    setQ('');
    setOpen(false);
    inputRef.current?.blur();
    onNavigate?.();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      const r = results[active];
      if (r) {
        e.preventDefault();
        go(r);
      }
    } else if (e.key === 'Escape') {
      if (q) setQ('');
      else {
        setOpen(false);
        inputRef.current?.blur();
      }
    }
  };

  const showList = open && results.length > 0;
  const optId = (i: number) => `${listId}-opt-${i}`;

  return (
    <div ref={wrapRef} className={cx('relative w-full', className)}>
      <label className="sr-only" htmlFor={`${listId}-input`}>
        Buscar equipos y competiciones
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden="true" />
        <input
          ref={inputRef}
          id={`${listId}-input`}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? optId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          value={q}
          placeholder="Buscar equipo o competición…"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          className="input h-9 pl-9 pr-16"
        />
        {q ? (
          <button
            type="button"
            onClick={() => {
              setQ('');
              inputRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-ink-3 hover:text-ink-1"
            aria-label="Borrar búsqueda"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : (
          hotkey && (
            <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-line-strong bg-surface-3 px-1.5 font-mono text-[11px] text-ink-3 sm:inline-block" aria-hidden="true">
              /
            </kbd>
          )
        )}
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label="Resultados de búsqueda"
        hidden={!showList}
        className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 max-h-[60vh] overflow-auto rounded-xl border border-line-strong bg-surface-2 p-1.5 shadow-pop"
      >
        {!q && <li className="px-2 pb-1 pt-0.5 text-2xs font-semibold uppercase tracking-[0.1em] text-ink-3" role="presentation">Competiciones destacadas</li>}
        {results.map((r, i) => (
          <li
            key={`${r.kind}-${r.id}`}
            id={optId(i)}
            role="option"
            aria-selected={i === active}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => go(r)}
            onPointerMove={() => setActive(i)}
            className={cx('flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2', i === active ? 'bg-surface-3' : '')}
          >
            {r.kind === 'team' ? (
              <TeamCrest team={{ name: r.label, abbr: r.abbr, logo: r.logo }} size={24} />
            ) : (
              <span className="flex h-6 w-6 items-center justify-center text-[16px]" aria-hidden="true">{r.flag ?? <Trophy className="h-4 w-4" />}</span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink-1">{r.label}</span>
              <span className="block truncate text-2xs text-ink-3">{r.sub}</span>
            </span>
            <span className="text-2xs text-ink-3">{r.kind === 'team' ? 'Equipo' : 'Competición'}</span>
          </li>
        ))}
      </ul>
      {open && q && results.length === 0 && meta && (
        <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 rounded-xl border border-line-strong bg-surface-2 px-3 py-3 text-[13px] text-ink-2 shadow-pop" role="status">
          Sin resultados para «{q}»
        </div>
      )}
    </div>
  );
}
