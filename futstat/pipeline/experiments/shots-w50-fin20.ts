/** shots-w50-norm1 + corrección de calidad de remate por equipo (prior de 20 partidos). */
import { makeShotsVariant } from './shots/xg';

export default makeShotsVariant({
  name: 'shots-w50-fin20',
  description: 'shots-w50-norm1 + calidad de remate por equipo (goles/ajustados en su liga, contraída con 20 partidos ficticios)',
  w: 0.5,
  finishing: 20,
});
