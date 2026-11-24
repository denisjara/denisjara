/** Variante «tune-ha-prior5» (DESCARTADA, registro): tune-ha + prior del Dixon-Coles de 5 partidos. Ver tune-prior5. */
import { HA_REGION_KIND, makeTuneVariant } from './tune/variant';

export default makeTuneVariant({
  name: 'tune-ha-prior5',
  description: 'Ventaja local del Elo por grupo (tune-ha) + Dixon-Coles con prior de 5 partidos',
  table: HA_REGION_KIND,
  dc: { priorWeight: 5 },
});
