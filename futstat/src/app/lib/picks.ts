/**
 * Familias de mercado de los picks de valor. El pipeline publica `marketId` por línea concreta
 * ("ou-2.5", "ah-home--0.5", "ah-home-1.5"...), y `market` lleva el nombre del equipo local en los hándicaps
 * ("Hándicap asiático Cagliari +0.5"), lo que confunde cuando la selección es la del visitante.
 * Estas utilidades agrupan por familia (para filtros) y dan una etiqueta neutra (para subtítulos).
 */
import type { ValuePick } from '../../types/data';

export interface MarketFamily {
  /** clave estable para agrupar/filtrar */
  key: string;
  /** etiqueta corta en español */
  label: string;
}

const FIXED: Record<string, string> = {
  '1x2': '1X2',
  btts: 'Ambos marcan',
  dc: 'Doble oportunidad',
  dnb: 'Empate no apuesta',
};

/** Familia de un marketId: 1X2, Más/Menos N (una por línea), Hándicap asiático (todas las líneas juntas)... */
export function marketFamily(pick: Pick<ValuePick, 'marketId' | 'market'>): MarketFamily {
  const id = pick.marketId;
  if (FIXED[id]) return { key: id, label: FIXED[id] };
  if (id === 'ou25') return { key: 'ou-2.5', label: 'Más/Menos 2,5' }; // forma corta del contrato
  const ou = /^ou-(\d+(?:\.\d+)?)$/.exec(id);
  if (ou) return { key: `ou-${ou[1]}`, label: `Más/Menos ${ou[1].replace('.', ',')}` };
  if (/^ah(-|$)/.test(id)) return { key: 'ah', label: 'Hándicap asiático' };
  return { key: id, label: pick.market };
}

/** Decimales con coma (las etiquetas del pipeline usan punto: "Más de 2.5", "Austin FC +0.5"). */
export function localizeDecimals(s: string): string {
  return s.replace(/(\d)\.(\d)/g, '$1,$2');
}

/** Subtítulo de un pick (bajo la selección): neutro en hándicaps, el nombre del mercado en el resto. */
export function pickMarketLabel(pick: Pick<ValuePick, 'marketId' | 'market'>): string {
  return /^ah(-|$)/.test(pick.marketId) ? 'Hándicap asiático' : localizeDecimals(pick.market);
}

/** Selección de un pick para mostrar ("Más de 2,5", "Osasuna +0,5"). */
export function pickSelection(pick: Pick<ValuePick, 'selection'>): string {
  return localizeDecimals(pick.selection);
}
