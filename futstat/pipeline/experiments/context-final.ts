/**
 * Variante «context-final»: los mismos factores de contexto que «context», pero sobre los λ FINALES del ensamble de
 * producción (los del mercado, ya recalibrados con fitLambdas como en el núcleo), con κ = 100. El cambio se aplica
 * como delta sobre el 1X2 y el más de 2,5 de producción. Mide si el contexto aporta algo que el mercado de cierre no
 * tenga ya. Resultado: NO (empeora T2 y más/menos 2,5). Ver context/README.md.
 *
 *   npx tsx scripts/eval-model.ts --variant=context-final --window=tuning
 */
import { makeContextVariant } from './context/make';

export default makeContextVariant({
  name: 'context-final',
  description: 'Contexto sobre los λ finales (mercado incluido): ¿aporta algo que el mercado no tenga?',
  options: { level: 'final', terms: ['short', 'long', 'n14', 'euro', 'prom', 'early'], kappa: 100 },
});
