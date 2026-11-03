import { lazy, type ComponentType } from 'react';
import { Route, Routes } from 'react-router-dom';

/**
 * Carga perezosa con un reintento: si el chunk de una página falla (red intermitente), se reintenta una vez
 * antes de dejar que la barrera de error de la ruta ofrezca recargar la página.
 */
function lazyPage<T extends ComponentType<object>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().catch(
      () =>
        new Promise<{ default: T }>((resolve, reject) => {
          setTimeout(() => load().then(resolve, reject), 800);
        }),
    ),
  );
}

// Carga perezosa: cada página es un chunk independiente.
const HomePage = lazyPage(() => import('./pages/HomePage'));
const CalendarPage = lazyPage(() => import('./pages/CalendarPage'));
const CompetitionPage = lazyPage(() => import('./pages/competition/CompetitionPage'));
const MatchPage = lazyPage(() => import('./pages/match/MatchPage'));
const TeamPage = lazyPage(() => import('./pages/team/TeamPage'));
const PlayersPage = lazyPage(() => import('./pages/PlayersPage'));
const ValuePage = lazyPage(() => import('./pages/ValuePage'));
const ModelPage = lazyPage(() => import('./pages/ModelPage'));
const NotFoundPage = lazyPage(() => import('./pages/NotFoundPage'));

/** Rutas de la app (HashRouter): /#/c/laliga, /#/m/740001 ... */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/partidos" element={<CalendarPage />} />
      <Route path="/c/:compId" element={<CompetitionPage />} />
      <Route path="/m/:matchId" element={<MatchPage />} />
      <Route path="/t/:teamId" element={<TeamPage />} />
      <Route path="/jugadores" element={<PlayersPage />} />
      <Route path="/valor" element={<ValuePage />} />
      <Route path="/modelo" element={<ModelPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
