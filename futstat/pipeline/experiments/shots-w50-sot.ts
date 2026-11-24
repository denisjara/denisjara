/** Ablación de shots-w50-norm1: solo tiros a puerta (r = 0). */
import { makeShotsVariant } from './shots/xg';

export default makeShotsVariant({
  name: 'shots-w50-sot',
  description: 'Ablación de shots-w50-norm1: xG solo de tiros a puerta (r = 0)',
  w: 0.5,
  r: 0,
});
