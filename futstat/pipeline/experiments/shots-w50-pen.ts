/** Ablación de shots-w50-norm1: penaltis marcados valorados a 0,76 (resto de tiros a puerta a k). */
import { makeShotsVariant } from './shots/xg';

export default makeShotsVariant({
  name: 'shots-w50-pen',
  description: 'Ablación de shots-w50-norm1: penaltis marcados (eventos) valorados a 0,76 xG',
  w: 0.5,
  pen: true,
});
