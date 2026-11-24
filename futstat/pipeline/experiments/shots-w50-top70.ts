/**
 * Por competición: w = 0,7 en las ligas top (tier >= 8: LaLiga, Premier, Serie A, Bundesliga, Ligue 1) y w = 0,5 en el
 * resto, con un único factor de reescalado por liga. OJO: la separación se eligió DESPUÉS de ver en T2 que el xG por
 * tiros comprime a los favoritos de las ligas top (su mejora en T2-top es en la muestra de ajuste).
 */
import { COMPETITION_BY_ID } from '../config';
import { makeShotsVariant } from './shots/xg';

export default makeShotsVariant({
  name: 'shots-w50-top70',
  description: 'Por competición: goles ajustados con w = 0,7 en ligas top (tier >= 8) y 0,5 en el resto, un único factor de reescalado por liga',
  w: (compId) => ((COMPETITION_BY_ID.get(compId)?.tier ?? 0) >= 8 ? 0.7 : 0.5),
});
