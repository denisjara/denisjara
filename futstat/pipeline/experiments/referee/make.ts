/** Fábrica de las variantes referee-*.ts (ver referee/model.ts y la cabecera de referee-k30.ts). */
import type { ModelVariant } from '../types';
import { refereeMultipliers, type RefereeOptions } from './model';

export function makeRefereeVariant(name: string, description: string, opts: RefereeOptions): ModelVariant {
  return {
    name,
    description,
    stats: {
      adjust({ match, history, base }) {
        return refereeMultipliers(match, history, base, opts);
      },
    },
  };
}
