/** Ablación: shots-w50 SIN el reescalado dinámico de λ por liga (escala k global de 2025). */
import { makeShotsVariant } from './shots/xg';

export default makeShotsVariant({
  name: 'shots-w50-nonorm',
  description: 'Ablación: shots-w50 sin reescalar los λ por liga (xG por tiros con la escala global de 2025)',
  w: 0.5,
  normalize: false,
});
