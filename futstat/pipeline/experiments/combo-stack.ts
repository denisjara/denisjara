/**
 * Variante «combo-stack» (informativa, agente de combinación): «combo» con el combinador aprendido «stack» en lugar
 * del pool lineal en los partidos CON cuotas. El Elo de cada fila se recalcula con la ventaja local por grupo antes
 * del apilado (entrenamiento y predicción), como pide el informe del agente «tune».
 */
import { StackCombiner } from './stack/combiner';
import totals from './totals-best';
import { HA_REGION_KIND, blendWithTable, eloWithTable } from './tune/variant';
import type { ComponentRow, ModelVariant, WalkForwardRow } from './types';

const comb = new StackCombiner({ kappa: 30, kappaFeat: 1e9, apply: 'odds', lowData: true });
const withHa = <T extends ComponentRow>(r: T): T => ({ ...r, elo: eloWithTable(r, HA_REGION_KIND), production: blendWithTable(r, HA_REGION_KIND) });

const v: ModelVariant = {
  name: 'combo-stack',
  description: 'combo + combinador aprendido (stack) con cuotas',
  combine: {
    refitEvery: 'monthly',
    prepare: (rows, asOf) => comb.prepare(rows.map((r) => withHa(r as WalkForwardRow)), asOf),
    blend: (row) => comb.blend(withHa(row)),
  },
  features: totals.features,
  totals: totals.totals,
  stats: totals.stats,
};

export default v;
