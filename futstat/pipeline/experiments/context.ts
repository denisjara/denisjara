/**
 * Variante «context»: FACTORES DE CONTEXTO como ajustes multiplicativos de los λ de la fuente de goles (Dixon-Coles o
 * Elo→goles), estimados con regresión de Poisson walk-forward sobre los residuos (offset log λ, L2 κ = 30, reajuste
 * cada 7 días con partidos terminados al menos 3 h antes; rasgos en context/features.ts):
 *   descanso < 4 días y >= 10 días (propio y del rival), partidos en 14 días, partido continental hace <= 4 días,
 *   recién ascendido e inicio de temporada (propio y del rival).
 * La fuente de goles ajustada sustituye a la original en el pool lineal de producción (mismos pesos) y en el objetivo
 * de más de 2,5. Calendario: solo partidos YA JUGADOS antes del inicio (los ganchos no ven partidos programados).
 *
 * Resultado (banco 21-nov-2026, resultado a 90'): NO mejora. Ver pipeline/experiments/context/README.md.
 *
 *   npx tsx scripts/eval-model.ts --variant=context --window=tuning
 */
import { makeContextVariant } from './context/make';

export default makeContextVariant({
  name: 'context',
  description: 'Contexto (descanso, congestión, Europa, ascenso, inicio de temporada) → λ de la fuente de goles por regresión de Poisson walk-forward',
  options: { level: 'goal', terms: ['short', 'long', 'n14', 'euro', 'prom', 'early'], kappa: 30 },
});
