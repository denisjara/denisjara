import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { HashRouter, useLocation } from 'react-router-dom';
import { AppShell } from './layout/AppShell';
import { AppRoutes } from './routes';
import { ErrorState } from './components/States';

/** Captura errores de render de una página sin tumbar la navegación. */
class PageErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Error de página', error, info.componentStack);
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      return <ErrorState title="Algo ha fallado al mostrar esta página" error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

function Shell() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.documentElement.lang = 'es';
  }, []);
  return (
    <AppShell>
      <PageErrorBoundary resetKey={pathname}>
        <AppRoutes />
      </PageErrorBoundary>
    </AppShell>
  );
}

export default function App() {
  return (
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Shell />
    </HashRouter>
  );
}
