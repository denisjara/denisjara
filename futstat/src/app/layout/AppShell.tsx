import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Menu, Search, X } from 'lucide-react';
import { useMeta } from '../lib/data';
import { useDismiss, useHotkey } from '../lib/hooks';
import { cx } from '../components/Card';
import { PageSkeleton } from '../components/States';
import { Disclaimer } from '../components/Disclaimer';
import { Logo, ThemeToggle, UpdatedIndicator } from './Brand';
import { GlobalSearch } from './GlobalSearch';
import { SidebarNav } from './Sidebar';
import { MAIN_NAV } from './nav';

/** Vuelve arriba al cambiar de ruta (HashRouter no tiene ScrollRestoration). */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [pathname]);
  return null;
}

function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDismiss(panelRef, open, onClose);
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.querySelector<HTMLElement>('button, a')?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] lg:hidden">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Menú de navegación"
        className="absolute inset-y-0 left-0 flex w-[86%] max-w-[320px] flex-col border-r border-line bg-bg shadow-pop"
      >
        <div className="flex h-[var(--header-h)] items-center justify-between border-b border-line px-4">
          <Logo />
          <button type="button" onClick={onClose} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-3 hover:text-ink-1" aria-label="Cerrar menú">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <nav aria-label="Navegación principal" className="flex-1 overflow-y-auto px-2 py-4">
          <SidebarNav onNavigate={onClose} />
        </nav>
        <div className="border-t border-line px-4 py-3">
          <UpdatedIndicator />
        </div>
      </div>
    </div>
  );
}

function MobileSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] bg-bg/95 backdrop-blur-sm lg:hidden" role="dialog" aria-modal="true" aria-label="Buscar">
      <div className="flex items-center gap-2 border-b border-line px-3 py-3">
        <GlobalSearch autoFocus onNavigate={onClose} />
        <button type="button" onClick={onClose} className="btn-ghost shrink-0">
          Cerrar
        </button>
      </div>
      <p className="px-4 py-3 text-[12px] text-ink-3">Escribe el nombre de un equipo o de una competición.</p>
    </div>
  );
}

/**
 * Estructura de la app: barra lateral (≥1024px), barra superior con buscador, indicador de
 * actualización y tema; en móvil cabecera compacta + cajón + barra inferior.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const [search, setSearch] = useState(false);
  const { data: meta } = useMeta();
  const { pathname } = useLocation();
  useEffect(() => {
    setDrawer(false);
    setSearch(false);
  }, [pathname]);
  // "/" abre el buscador en móvil (en escritorio lo gestiona el GlobalSearch de la barra superior)
  useHotkey('/', (e) => {
    if (window.matchMedia('(min-width: 1024px)').matches) return;
    e.preventDefault();
    setSearch(true);
  });

  return (
    <div className="min-h-[100dvh]">
      <ScrollToTop />
      <a
        href="#contenido"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('contenido')?.focus();
        }}
        className="sr-only z-[100] rounded-lg bg-accent px-3 py-2 font-semibold text-accent-ink focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Saltar al contenido
      </a>

      {/* Barra lateral (escritorio) */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[var(--sidebar-w)] flex-col border-r border-line bg-bg/85 backdrop-blur-md lg:flex">
        <div className="flex h-[var(--header-h)] shrink-0 items-center border-b border-line px-5">
          <Logo />
        </div>
        <nav aria-label="Navegación principal" className="flex-1 overflow-y-auto px-2.5 py-4">
          <SidebarNav />
        </nav>
        <div className="border-t border-line px-5 py-3 text-2xs text-ink-3">
          Datos: {meta?.dataSource ?? 'ESPN (API pública)'}
        </div>
      </aside>

      <div className="lg:pl-[var(--sidebar-w)]">
        {/* Barra superior (escritorio) */}
        <header className="sticky top-0 z-30 hidden h-[var(--header-h)] items-center gap-4 border-b border-line bg-bg/80 px-6 backdrop-blur-md lg:flex">
          <GlobalSearch hotkey className="max-w-[440px]" />
          <div className="ml-auto flex items-center gap-4">
            <UpdatedIndicator />
            <ThemeToggle />
          </div>
        </header>

        {/* Cabecera compacta (móvil/tablet) */}
        <header className="sticky top-0 z-30 flex h-[56px] items-center gap-1 border-b border-line bg-bg/85 px-3 backdrop-blur-md lg:hidden">
          <button
            type="button"
            onClick={() => setDrawer(true)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-3 hover:text-ink-1"
            aria-label="Abrir menú"
            aria-expanded={drawer}
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          <Logo className="ml-1" />
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSearch(true)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-2 hover:text-ink-1"
              aria-label="Buscar equipos y competiciones"
            >
              <Search className="h-4 w-4" aria-hidden="true" />
            </button>
            <ThemeToggle />
          </div>
        </header>

        <main id="contenido" tabIndex={-1} className="mx-auto w-full max-w-page px-4 pb-[calc(var(--bottom-nav-h)+28px)] pt-4 outline-none sm:px-6 lg:pb-12 lg:pt-6">
          <div className="mb-3 lg:hidden">
            <UpdatedIndicator />
          </div>
          <Suspense fallback={<PageSkeleton />}>{children}</Suspense>
          <footer className="mt-12 flex flex-col gap-3 border-t border-line pt-5 text-[12px] text-ink-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              <span className="font-display text-[14px] font-extrabold uppercase tracking-wide text-ink-2">FutStat Lab</span> · Analítica y
              predicción de fútbol · Datos de {meta?.dataSource ?? 'ESPN'}, actualizados a diario.
            </span>
            <Disclaimer compact />
          </footer>
        </main>
      </div>

      {/* Barra inferior (móvil) */}
      <nav
        aria-label="Navegación rápida"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden"
      >
        <ul className="mx-auto grid h-[var(--bottom-nav-h)] max-w-lg grid-cols-5">
          {MAIN_NAV.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cx(
                    'relative flex h-full flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors',
                    isActive ? 'text-ink-1' : 'text-ink-3 hover:text-ink-2',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && <span className="absolute top-0 h-[3px] w-8 rounded-b bg-accent-text" aria-hidden="true" />}
                    <item.icon className={cx('h-5 w-5', isActive && 'text-accent-text')} aria-hidden="true" />
                    {item.label}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <MobileDrawer open={drawer} onClose={() => setDrawer(false)} />
      <MobileSearch open={search} onClose={() => setSearch(false)} />
    </div>
  );
}
