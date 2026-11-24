/** shots-w50 con un único factor de reescalado por liga (conserva la ventaja local del ajuste con goles ajustados). */
import { makeShotsVariant } from './shots/xg';

export default makeShotsVariant({
  name: 'shots-w50-norm1',
  description: 'shots-w50 con un único factor de reescalado de λ por liga (local y visitante iguales)',
  w: 0.5,
  normalize: 'single',
});
