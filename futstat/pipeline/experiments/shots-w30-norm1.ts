/** shots-w30 con un único factor de reescalado de λ por liga. */
import { makeShotsVariant } from './shots/xg';

export default makeShotsVariant({
  name: 'shots-w30-norm1',
  description: 'Dixon-Coles con goles ajustados = 0,30·goles + 0,70·xG por tiros (a puerta + 0,2·fuera), un único factor de reescalado de λ por liga',
  w: 0.30,
  normalize: 'single',
});
