/** Dixon-Coles con goles ajustados = 0,50·goles + 0,50·xG por tiros (r = 0,2), λ reescalados por liga. */
import { makeShotsVariant } from './shots/xg';

export default makeShotsVariant({
  name: 'shots-w50',
  description: 'Dixon-Coles con goles ajustados = 0,50·goles + 0,50·xG por tiros (a puerta + 0,2·fuera), λ reescalados por liga (local y visitante por separado)',
  w: 0.50,
  normalize: 'split',
});
