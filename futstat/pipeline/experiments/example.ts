/**
 * Variante de EJEMPLO (trivial, solo para enseñar el contrato; no pretende mejorar nada):
 *  - rasgo `restHome`/`restAway`: días de descanso de cada equipo desde su último partido (con `before`, nunca con
 *    datos posteriores al inicio del partido);
 *  - lambdaAdjust: −1 % de goles esperados para un equipo con menos de 3 días de descanso.
 *
 *   npx tsx scripts/eval-model.ts --variant=example --window=tuning
 */
import type { ModelVariant } from './types';

const DAY_MS = 86_400_000;
/** Descanso por defecto (días) si el equipo no tiene partidos anteriores en los datos. */
const DEFAULT_REST = 7;

const example: ModelVariant = {
  name: 'example',
  description: 'Ejemplo: −1 % de goles esperados con menos de 3 días de descanso',
  features(_ctx, match, before) {
    const rest = (teamId: string) => {
      const prev = before.teamMatches(teamId);
      const last = prev[prev.length - 1];
      return last ? (before.cutoff - Date.parse(last.date)) / DAY_MS : DEFAULT_REST;
    };
    return { restHome: rest(match.home.id), restAway: rest(match.away.id) };
  },
  lambdaAdjust({ lambdaHome, lambdaAway, features }) {
    const f = (rest: number) => (rest < 3 ? 0.99 : 1);
    return { lambdaHome: lambdaHome * f(features.restHome), lambdaAway: lambdaAway * f(features.restAway) };
  },
};

export default example;
