/**
 * Fábrica de las variantes stakes-*.ts (factor NECESIDAD DE MARCAR / QUÉ SE JUEGA). Piezas en legs.ts (vuelta de
 * eliminatoria) y table.ts (recta final de liga); pre-registro y métricas objetivo en la cabecera de stakes-all.ts.
 *
 * Palancas (todas con efectos FIJOS declarados antes de evaluar):
 *   - total de goles: totals.adjustTotal = factor de producción (contracción sin línea de goles) × factor del factor;
 *     el efecto solo se aplica SIN línea de goles del mercado (con ella el factor es el de producción, 1);
 *   - 1X2 (solo recta final de liga, solo SIN cuotas 1X2): combine.blend desplaza el ensamble de producción;
 *   - estadísticas: stats.adjust (multiplicadores por equipo; no hay mercado de estadísticas).
 * Sin vuelta/recta final aplicable todo es exactamente producción.
 */
import { productionTotalFactor } from '../../analytics/totals';
import type { Prob1X2 } from '../../../src/types/data';
import type { ComponentRow, Features, ModelVariant, StatPairs } from '../types';
import { legGoalsFactor, legStatMultipliers, tieState } from './legs';
import { matchStakes, TABLE_EFFECTS, type StakesMode } from './table';

export interface StakesOptions {
  /** sub-factor (a): vuelta de eliminatoria */
  legs: boolean;
  /** sub-factor (b): recta final de liga con la definición dada (ausente = no se aplica) */
  table?: StakesMode;
}

/** Desplaza un 1X2 hacia un lado: p(lado)·e^{δ}, p(otro)·e^{−δ}, empate igual, renormalizado. */
export function shiftTowards(p: Prob1X2, side: 'home' | 'away', delta: number): Prob1X2 {
  const h = p.home * Math.exp(side === 'home' ? delta : -delta);
  const a = p.away * Math.exp(side === 'home' ? -delta : delta);
  const s = h + p.draw + a;
  return { home: h / s, draw: p.draw / s, away: a / s };
}

/** Multiplica dos conjuntos de multiplicadores por equipo. */
function mergeMult(a: StatPairs, b: StatPairs): StatPairs {
  const out: StatPairs = { ...a };
  for (const [k, v] of Object.entries(b) as [keyof StatPairs, { home: number; away: number }][]) {
    const x = out[k];
    out[k] = x ? { home: x.home * v.home, away: x.away * v.away } : v;
  }
  return out;
}

export function makeStakesVariant(name: string, description: string, opts: StakesOptions): ModelVariant {
  const v: ModelVariant = {
    name,
    description,
    features(ctx, match, before): Features {
      const f: Features = {};
      if (opts.legs) {
        const st = tieState(match, before);
        if (st) {
          f.stkLeg = 1;
          f.stkLegAgg = st.agg;
          f.stkLegGoals = legGoalsFactor(st);
        }
      }
      if (opts.table) {
        const s = matchStakes(ctx.comp, match, before, opts.table);
        if (s) {
          f.stkTable = 1;
          f.stkHomeNothing = s.home.nothing ? 1 : 0;
          f.stkAwayNothing = s.away.nothing ? 1 : 0;
        }
      }
      return f;
    },
    totals: {
      adjustTotal(input) {
        const hasMarketTotal = input.ctx.market?.over25 !== undefined;
        const base = productionTotalFactor({
          hasMarketTotal,
          kind: input.ctx.comp.kind,
          compId: input.match.compId,
          before: input.ctx.history,
          lambdaHome: input.lambdaHome,
          lambdaAway: input.lambdaAway,
        });
        if (hasMarketTotal) return base;
        let k = input.features.stkLegGoals ?? 1;
        if (input.features.stkTable === 1 && input.features.stkHomeNothing === 1 && input.features.stkAwayNothing === 1) k *= TABLE_EFFECTS.bothNothingGoals;
        return base * k;
      },
    },
    stats: {
      adjust({ ctx, match, history, base }) {
        let out: StatPairs = {};
        if (opts.legs) out = mergeMult(out, legStatMultipliers(tieState(match, history), base));
        if (opts.table) {
          const s = matchStakes(ctx.comp, match, history, opts.table);
          if (s) {
            const m: StatPairs = {};
            const hN = s.home.nothing;
            const aN = s.away.nothing;
            if ((hN || aN) && base.cards) m.cards = { home: hN ? TABLE_EFFECTS.nothingCards : 1, away: aN ? TABLE_EFFECTS.nothingCards : 1 };
            if ((hN || aN) && base.fouls) m.fouls = { home: hN ? TABLE_EFFECTS.nothingFouls : 1, away: aN ? TABLE_EFFECTS.nothingFouls : 1 };
            out = mergeMult(out, m);
          }
        }
        return out;
      },
    },
  };
  if (opts.table) {
    v.combine = {
      blend(row: ComponentRow) {
        const f = row.features;
        if (row.hasMarket || f.stkTable !== 1) return row.production;
        const hN = f.stkHomeNothing === 1;
        const aN = f.stkAwayNothing === 1;
        if (hN === aN) return row.production;
        return shiftTowards(row.production, hN ? 'away' : 'home', TABLE_EFFECTS.delta);
      },
    };
  }
  return v;
}
