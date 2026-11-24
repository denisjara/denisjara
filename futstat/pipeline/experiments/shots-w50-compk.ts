/** Por competición (estático): shots-w50 con la escala k de cada liga fijada con 2025, sin reescalado dinámico. */
import { K_BY_COMP_2025, makeShotsVariant } from './shots/xg';

export default makeShotsVariant({
  name: 'shots-w50-compk',
  description: 'Por competición: shots-w50 con escala k por liga fijada con datos de 2025 (sin reescalado dinámico)',
  w: 0.5,
  kByComp: K_BY_COMP_2025,
  normalize: false,
});
