/** shots-w50 + corrección de calidad de remate por equipo (prior de 50 partidos). */
import { makeShotsVariant } from './shots/xg';

export default makeShotsVariant({
  name: 'shots-w50-fin50',
  description: 'shots-w50 + calidad de remate por equipo (goles/ajustados en su liga, contraída con 50 partidos ficticios), reescalado local/visitante por separado',
  w: 0.5,
  finishing: 50,
  normalize: 'split',
});
