import { useId, useMemo, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronDown, Star } from 'lucide-react';
import type { CompetitionMeta } from '../../types/data';
import { useMeta } from '../lib/data';
import { featuredCompetitions, groupCompetitions, nextMatchLabel } from '../lib/competitions';
import { cx } from '../components/Card';
import { Skeleton } from '../components/States';
import { MAIN_NAV } from './nav';

function navCls({ isActive }: { isActive: boolean }) {
  return cx(
    'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors',
    isActive ? 'bg-surface-3 text-ink-1' : 'text-ink-2 hover:bg-surface-2 hover:text-ink-1',
  );
}

function CompLink({ c, onNavigate }: { c: CompetitionMeta; onNavigate?: () => void }) {
  const next = nextMatchLabel(c);
  return (
    <NavLink
      to={`/c/${c.id}`}
      onClick={onNavigate}
      className={({ isActive }) =>
        cx(
          'group relative flex items-center gap-2.5 rounded-md px-3 py-[7px] text-[13px] transition-colors',
          isActive ? 'bg-surface-3 font-semibold text-ink-1' : 'text-ink-2 hover:bg-surface-2 hover:text-ink-1',
        )
      }
      title={`${c.name} · ${c.country}`}
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-r bg-accent-text" aria-hidden="true" />}
          <span className="w-5 shrink-0 overflow-hidden whitespace-nowrap text-center text-[14px] leading-none" aria-hidden="true">{c.flag}</span>
          <span className="min-w-0 flex-1 truncate">{c.shortName}</span>
          {c.upcomingCount > 0 ? (
            <span className="num shrink-0 rounded px-1 text-[10.5px] text-ink-3 group-hover:text-ink-2" aria-label={`${c.upcomingCount} próximos partidos`}>
              {c.upcomingCount}
            </span>
          ) : next ? (
            <span className="shrink-0 whitespace-nowrap px-1 text-[10.5px] text-ink-3 group-hover:text-ink-2" title={`Próximo partido: ${next}`}>
              <span className="sr-only">Próximo partido: </span>
              {next}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}

function Group({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  // id único por instancia (la barra lateral y el cajón móvil pueden coexistir en el DOM)
  const id = `nav-${useId().replace(/:/g, '')}`;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full items-center justify-between rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3 hover:text-ink-1"
      >
        {title}
        <ChevronDown className={cx('h-3.5 w-3.5 transition-transform', !open && '-rotate-90')} aria-hidden="true" />
      </button>
      <div id={id} hidden={!open} className="mt-0.5 space-y-px">
        {children}
      </div>
    </div>
  );
}

/**
 * Contenido de navegación (se usa en la barra lateral de escritorio y en el cajón móvil):
 * navegación principal + Ligas (Europa/América/Otras) + Competiciones (continentales/copas).
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { data: meta, error } = useMeta();
  const groups = useMemo(() => (meta ? groupCompetitions(meta.competitions) : null), [meta]);
  const featured = useMemo(() => (meta ? featuredCompetitions(meta.competitions) : []), [meta]);

  return (
    <div className="flex flex-col gap-5">
      <ul className="space-y-0.5">
        {MAIN_NAV.map((item) => (
          <li key={item.to}>
            <NavLink to={item.to} end={item.end} onClick={onNavigate} className={navCls}>
              {({ isActive }) => (
                <>
                  {isActive && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-accent-text" aria-hidden="true" />}
                  <item.icon className={cx('h-[18px] w-[18px] shrink-0', isActive ? 'text-accent-text' : 'text-ink-3 group-hover:text-ink-2')} aria-hidden="true" />
                  {item.label}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>

      {featured.length > 0 && (
        <div>
          <h2 className="mb-1.5 flex items-center gap-1.5 px-3 font-display text-[15px] font-extrabold uppercase tracking-[0.06em] text-ink-1">
            <Star className="h-3.5 w-3.5 text-accent-text" aria-hidden="true" />
            Destacadas
          </h2>
          <div className="space-y-px">
            {featured.map((c) => (
              <CompLink key={c.id} c={c} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      )}

      <div>
        <h2 className="mb-1.5 px-3 font-display text-[15px] font-extrabold uppercase tracking-[0.06em] text-ink-1">Ligas</h2>
        {!groups && !error && (
          <div className="space-y-2 px-3" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        )}
        {error && <p className="px-3 text-[12px] text-ink-3">No se pudo cargar el índice de competiciones.</p>}
        <div className="space-y-2">
          {groups?.leagues.map((g) => (
            <Group key={g.region} title={g.region}>
              {g.items.map((c) => (
                <CompLink key={c.id} c={c} onNavigate={onNavigate} />
              ))}
            </Group>
          ))}
        </div>
      </div>

      {groups && groups.competitions.length > 0 && (
        <div>
          <h2 className="mb-1.5 px-3 font-display text-[15px] font-extrabold uppercase tracking-[0.06em] text-ink-1">Competiciones</h2>
          <div className="space-y-2">
            {groups.competitions.map((g) => (
              <Group key={g.label} title={g.label}>
                {g.items.map((c) => (
                  <CompLink key={c.id} c={c} onNavigate={onNavigate} />
                ))}
              </Group>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
