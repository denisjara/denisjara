/** shots-w70 con un único factor de reescalado de λ por liga. */
import { makeShotsVariant } from './shots/xg';

export default makeShotsVariant({
  name: 'shots-w70-norm1',
  description: 'Dixon-Coles con goles ajustados = 0,70·goles + 0,30·xG por tiros (a puerta + 0,2·fuera), un único factor de reescalado de λ por liga',
  w: 0.70,
  normalize: 'single',
});
