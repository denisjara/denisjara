/**
 * Variante «totals-shrink-nocup»: «totals-shrink» (s = 0,5) salvo en copas nacionales, donde los cruces entre
 * divisiones dan totales extremos reales que no conviene contraer.
 */
import { SHRINK, shrinkVariant } from './totals-shrink';

export default shrinkVariant(
  'totals-shrink-nocup',
  'Sin línea de goles del mercado y fuera de copas nacionales: total esperado contraído 50 % hacia la media de la competición',
  SHRINK,
  true,
);
