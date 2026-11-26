/** Fábrica de las variantes availability-*.ts (ver availability/model.ts y la cabecera de availability-susp.ts). */
import type { ModelVariant } from '../types';
import { minutesFactors, statMultipliers, teamAbsences, teamMultipliers, type MinutesFactors } from './model';

export interface AvailabilityOptions {
  /** props: corrección de minutos de las bajas ('susp' = solo sancionados, 'all' = todas las clases, sin = nada) */
  props?: 'susp' | 'all';
  /** efecto de equipo: λ de la fuente de goles (lambdaAdjust) y tiros / tiros a puerta (stats.adjust) */
  team?: boolean;
  /** factores de minutos por clase (por defecto los del banco, MINUTES_FACTOR: sancionado ×0,03) */
  minutesFactors?: MinutesFactors;
}

export function makeAvailabilityVariant(name: string, description: string, o: AvailabilityOptions): ModelVariant {
  const v: ModelVariant = { name, description };
  if (o.team) {
    v.lambdaAdjust = ({ ctx, match, lambdaHome, lambdaAway }) => ({
      lambdaHome: lambdaHome * teamMultipliers(match, match.home.id, ctx.history).goals,
      lambdaAway: lambdaAway * teamMultipliers(match, match.away.id, ctx.history).goals,
    });
    v.stats = { adjust: ({ match, history, base }) => statMultipliers(match, history, base) };
  }
  if (o.props || o.team) {
    const props = o.props;
    const team = !!o.team;
    const factors = o.minutesFactors;
    v.players = {
      adjust({ match, teamId, history, base }) {
        const out: Partial<typeof base> = {};
        if (props) {
          const mf = minutesFactors(teamAbsences(match, teamId, base.lines, history), props === 'susp', factors);
          if (Object.keys(mf).length) out.minutesFactor = { ...(base.minutesFactor ?? {}), ...mf };
        }
        if (team) {
          // los tiros que pierde el equipo por sus bajas no se quitan a los compañeros que sí juegan: se deshace el
          // multiplicador de stats.adjust en los factores de tiros de sus props (vuelven a los de producción)
          const m = teamMultipliers(match, teamId, history);
          // (un factor exactamente 1 es el de respaldo de propsFor sin proyección o sin historial: no lleva el multiplicador)
          if (m.shots !== 1 && base.oppShotsFactor !== 1) out.oppShotsFactor = base.oppShotsFactor / m.shots;
          if (m.sot !== 1 && base.oppSotFactor !== 1) out.oppSotFactor = base.oppSotFactor / m.sot;
        }
        return out;
      },
    };
  }
  return v;
}
