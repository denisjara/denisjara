/** Dixon-Coles con goles ajustados = 0,30·goles + 0,70·xG por tiros (r = 0,2), λ reescalados por liga. */
import { makeShotsVariant } from './shots/xg';

export default makeShotsVariant({
  name: 'shots-w30',
  description: 'Dixon-Coles con goles ajustados = 0,30·goles + 0,70·xG por tiros (a puerta + 0,2·fuera), λ reescalados por liga (local y visitante por separado)',
  w: 0.30,
  normalize: 'split',
});
