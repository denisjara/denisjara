/**
 * Variante «context-dlog»: única pieza de la regresión de contexto con signo estable: CALIBRACIÓN DE LA DIFERENCIA DE
 * FUERZAS de la fuente de goles («encoger hacia la media»). Regresión de Poisson walk-forward con offset log λ y un
 * solo término, log(λ propio / λ rival), con modelos separados para Dixon-Coles y Elo→goles (κ = 30, reajuste cada
 * 7 días). En septiembre el Dixon-Coles sale con β ≈ −0,09 (± 0,025): sus diferencias de goles esperados son ~9 %
 * demasiado amplias; el Elo→goles, β ≈ +0,03 (sin señal).
 *
 * Resultado: mejora la fuente de goles sola en T1, T2 y pre, y el ensamble en las tres ventanas, pero con intervalos
 * bootstrap que cruzan el 0 (con cuotas la fuente de goles pesa un 5 %). Ver context/README.md.
 *
 *   npx tsx scripts/eval-model.ts --variant=context-dlog --window=tuning
 */
import { makeContextVariant } from './context/make';

export default makeContextVariant({
  name: 'context-dlog',
  description: 'Calibración walk-forward de la diferencia de fuerzas de la fuente de goles (Poisson, por tipo de fuente)',
  options: { level: 'goal', terms: ['dlog'], kappa: 30, byKind: true },
});
