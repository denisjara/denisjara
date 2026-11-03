import { lazy } from 'react';
import { Route, Routes } from 'react-router-dom';

// Carga perezosa: cada página es un chunk independiente.
const HomePage = lazy(() => import('./pages/HomePage'));
const CalendarPage = lazy(() => import('./pages/CalendarPage'));
const CompetitionPage = lazy(() => import('./pages/competition/CompetitionPage'));
const MatchPage = lazy(() => import('./pages/match/MatchPage'));
const TeamPage = lazy(() => import('./pages/team/TeamPage'));
const PlayersPage = lazy(() => import('./pages/PlayersPage'));
const ValuePage = lazy(() => import('./pages/ValuePage'));
const ModelPage = lazy(() => import('./pages/ModelPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

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
