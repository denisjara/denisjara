import { useEffect } from 'react';
import { HashRouter, useLocation } from 'react-router-dom';
import { AppShell } from './layout/AppShell';
import { AppRoutes } from './routes';
import { AppErrorBoundary, RouteErrorBoundary } from './components/ErrorBoundary';

function Shell() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.documentElement.lang = 'es';
  }, []);
  return (
    <AppShell>
      {/* Error de una página: el armazón (menú, buscador) sigue vivo y el error se limpia al cambiar de ruta. */}
      <RouteErrorBoundary resetKey={pathname}>
        <AppRoutes />
      </RouteErrorBoundary>
    </AppShell>
  );
}

export default function App() {
  return (
    <AppErrorBoundary>
      {/* React Router 7: startTransition y rutas splat relativas ya son el comportamiento por defecto. */}
      <HashRouter>
        <Shell />
      </HashRouter>
    </AppErrorBoundary>
  );
}
