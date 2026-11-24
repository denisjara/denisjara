/**
 * Variante «totals-shrink-goal»: como «totals-shrink» (s = 0,5) pero la contracción del total se aplica a los λ de la
 * FUENTE DE GOLES (lambdaAdjust) en partidos sin línea de goles del mercado, así que también cambia su 1X2 (más empates
 * cuando el total baja) y, por tanto, el ensamble sin cuotas. Sirve para medir si la misma idea ayuda al 1X2.
 */
import { leagueTotal, shrinkFactor } from './totals/model';
import type { ModelVariant } from './types';

const v: ModelVariant = {
  name: 'totals-shrink-goal',
  description: 'Sin línea de goles del mercado: λ de la fuente de goles contraídos 50 % hacia la media de la competición (afecta al 1X2)',
  features(_ctx, match, before) {
    return { lgTotal: leagueTotal(before, match.compId).mean };
  },
  lambdaAdjust({ ctx, lambdaHome, lambdaAway, features }) {
    if (ctx.market?.over25 !== undefined) return { lambdaHome, lambdaAway };
    const f = shrinkFactor(lambdaHome + lambdaAway, features.lgTotal, 0.5);
    return { lambdaHome: lambdaHome * f, lambdaAway: lambdaAway * f };
  },
};

export default v;
