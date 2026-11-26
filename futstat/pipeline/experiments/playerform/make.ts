/** Fábrica de las variantes playerform-*.ts (ver playerform/model.ts y el pre-registro en playerform-hl60.ts). */
import type { PlayerPropsInput } from '../../analytics/players';
import type { ModelVariant } from '../types';
import { factorRatios, formMultipliers, scaleLines, FORM_DEFAULTS, type FormOptions } from './model';

export interface PlayerFormOptions {
  /** (a) vida media de la ponderación de las tasas por 90 (gancho del núcleo players.rateHalfLifeDays) */
  rateHalfLifeDays?: number;
  /** (b) multiplicador de forma de las 5 últimas apariciones en goles, tiros y tiros a puerta */
  form?: FormOptions | true;
  /** (c) factores del rival de las props con otra contracción de las tasas de equipo: «a favor» propio y «en contra» del rival */
  factors?: { forN: number; agN: number };
}

/** Un factor de producción exactamente 1 es el de respaldo de propsFor (sin proyección o con < 3 partidos): se deja. */
const scaled = (f: number, r: number) => (f === 1 || !(r > 0) || !Number.isFinite(r) ? f : f * r);

export function makePlayerFormVariant(name: string, description: string, o: PlayerFormOptions): ModelVariant {
  const v: ModelVariant = { name, description };
  const form = o.form === true ? FORM_DEFAULTS : o.form;
  const factors = o.factors;
  if (o.rateHalfLifeDays === undefined && !form && !factors) return v;
  v.players = {};
  if (o.rateHalfLifeDays !== undefined) v.players.rateHalfLifeDays = o.rateHalfLifeDays;
  if (form || factors) {
    v.players.adjust = ({ match, teamId, side, history, base }) => {
      const out: Partial<PlayerPropsInput> = {};
      if (form) {
        const mult = formMultipliers(base.lines, teamId, form);
        if ([...mult.values()].some((m) => m !== 1)) out.lines = scaleLines(base.lines, teamId, mult);
      }
      if (factors) {
        const r = factorRatios(match, history, side, factors.forN, factors.agN);
        out.oppShotsFactor = scaled(base.oppShotsFactor, r.shots);
        out.oppSotFactor = scaled(base.oppSotFactor, r.shotsOnTarget);
        out.cardsFactor = scaled(base.cardsFactor, r.cards);
      }
      return out;
    };
  }
  return v;
}
