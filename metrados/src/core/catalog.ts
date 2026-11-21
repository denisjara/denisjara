/**
 * Catálogo de partidas frecuentes en edificación (terminología de la Norma Técnica de Metrados peruana).
 * Son plantillas: al añadir una se puede cambiar todo (nombre, unidad, fórmula y valores).
 */
import { newId, nextPartidaColor, type Base, type ParamKey, type Partida } from './model';

export interface PartidaTemplate {
  group: string;
  name: string;
  unit: string;
  base: Base;
  use?: ParamKey[];
  largo?: number;
  ancho?: number;
  alto?: number;
  factor?: number;
  factorLabel?: string;
}

const t = (group: string, name: string, unit: string, base: Base, use: ParamKey[] = [], values: Partial<Pick<PartidaTemplate, 'largo' | 'ancho' | 'alto' | 'factor' | 'factorLabel'>> = {}): PartidaTemplate => ({
  group,
  name,
  unit,
  base,
  use,
  ...values,
});

const EST = 'Estructuras';
const ARQ = 'Arquitectura';
const SAN = 'Instalaciones sanitarias';
const ELE = 'Instalaciones eléctricas';

export const CATALOG: readonly PartidaTemplate[] = [
  t(EST, 'Trazo y replanteo', 'm²', 'A'),
  t(EST, 'Excavación de zanjas para cimientos', 'm³', 'L', ['ancho', 'alto'], { ancho: 0.5, alto: 1.0 }),
  t(EST, 'Excavación para zapatas', 'm³', 'N', ['largo', 'ancho', 'alto'], { largo: 1.2, ancho: 1.2, alto: 1.2 }),
  t(EST, 'Relleno compactado con material propio', 'm³', 'A', ['alto'], { alto: 0.3 }),
  t(EST, 'Solado de concreto e = 4"', 'm²', 'A'),
  t(EST, 'Cimientos corridos, concreto ciclópeo', 'm³', 'L', ['ancho', 'alto'], { ancho: 0.5, alto: 0.8 }),
  t(EST, 'Sobrecimientos, concreto', 'm³', 'L', ['ancho', 'alto'], { ancho: 0.15, alto: 0.3 }),
  t(EST, 'Sobrecimientos, encofrado y desencofrado', 'm²', 'L', ['alto', 'factor'], { alto: 0.3, factor: 2, factorLabel: 'Caras' }),
  t(EST, 'Falso piso e = 4"', 'm²', 'A'),
  t(EST, 'Zapatas, concreto f\'c = 210 kg/cm²', 'm³', 'N', ['largo', 'ancho', 'alto'], { largo: 1.2, ancho: 1.2, alto: 0.6 }),
  t(EST, 'Columnas, concreto f\'c = 210 kg/cm²', 'm³', 'N', ['largo', 'ancho', 'alto'], { largo: 0.25, ancho: 0.25, alto: 2.6 }),
  t(EST, 'Vigas, concreto f\'c = 210 kg/cm²', 'm³', 'L', ['ancho', 'alto'], { ancho: 0.25, alto: 0.4 }),
  t(EST, 'Losa aligerada h = 0.20 m, concreto', 'm³', 'A', ['factor'], { factor: 0.0875, factorLabel: 'm³/m²' }),
  t(EST, 'Losa aligerada, encofrado y desencofrado', 'm²', 'A'),
  t(EST, 'Losa aligerada, ladrillo hueco 15×30×30', 'und', 'A', ['factor'], { factor: 8.33, factorLabel: 'und/m²' }),
  t(EST, 'Losa maciza, concreto', 'm³', 'A', ['alto'], { alto: 0.15 }),
  t(EST, 'Acero fy = 4200 kg/cm², ø 1/4"', 'kg', 'L', ['factor'], { factor: 0.248, factorLabel: 'kg/m' }),
  t(EST, 'Acero fy = 4200 kg/cm², ø 3/8"', 'kg', 'L', ['factor'], { factor: 0.56, factorLabel: 'kg/m' }),
  t(EST, 'Acero fy = 4200 kg/cm², ø 1/2"', 'kg', 'L', ['factor'], { factor: 0.994, factorLabel: 'kg/m' }),
  t(EST, 'Acero fy = 4200 kg/cm², ø 5/8"', 'kg', 'L', ['factor'], { factor: 1.552, factorLabel: 'kg/m' }),
  t(EST, 'Acero fy = 4200 kg/cm², ø 3/4"', 'kg', 'L', ['factor'], { factor: 2.235, factorLabel: 'kg/m' }),

  t(ARQ, 'Muro de ladrillo KK de soga', 'm²', 'L', ['alto'], { alto: 2.4 }),
  t(ARQ, 'Muro de ladrillo KK de cabeza', 'm²', 'L', ['alto'], { alto: 2.4 }),
  t(ARQ, 'Tarrajeo de muros interiores', 'm²', 'L', ['alto'], { alto: 2.4 }),
  t(ARQ, 'Tarrajeo de muros exteriores', 'm²', 'L', ['alto'], { alto: 2.6 }),
  t(ARQ, 'Tarrajeo por ambiente (perímetro × alto)', 'm²', 'P', ['alto'], { alto: 2.4 }),
  t(ARQ, 'Cielorraso con mezcla', 'm²', 'A'),
  t(ARQ, 'Contrapiso de 48 mm', 'm²', 'A'),
  t(ARQ, 'Piso de cerámico', 'm²', 'A'),
  t(ARQ, 'Piso de porcelanato', 'm²', 'A'),
  t(ARQ, 'Piso de cemento pulido', 'm²', 'A'),
  t(ARQ, 'Zócalo de cerámico', 'm²', 'L', ['alto'], { alto: 1.8 }),
  t(ARQ, 'Contrazócalo', 'm', 'L'),
  t(ARQ, 'Contrazócalo por ambiente (perímetro)', 'm', 'P'),
  t(ARQ, 'Pintura látex en muros', 'm²', 'L', ['alto'], { alto: 2.4 }),
  t(ARQ, 'Pintura látex en cielorraso', 'm²', 'A'),
  t(ARQ, 'Puertas', 'und', 'N'),
  t(ARQ, 'Ventanas', 'und', 'N'),
  t(ARQ, 'Ventanas de vidrio (ancho × alto)', 'm²', 'N', ['ancho', 'alto'], { ancho: 1.2, alto: 1.2 }),
  t(ARQ, 'Cobertura de techo', 'm²', 'A'),

  t(SAN, 'Salida de agua fría', 'pto', 'N'),
  t(SAN, 'Salida de agua caliente', 'pto', 'N'),
  t(SAN, 'Salida de desagüe', 'pto', 'N'),
  t(SAN, 'Tubería PVC clase 10, ø 1/2"', 'm', 'L'),
  t(SAN, 'Tubería PVC clase 10, ø 3/4"', 'm', 'L'),
  t(SAN, 'Tubería PVC desagüe ø 2"', 'm', 'L'),
  t(SAN, 'Tubería PVC desagüe ø 4"', 'm', 'L'),
  t(SAN, 'Inodoros', 'und', 'N'),
  t(SAN, 'Lavatorios', 'und', 'N'),
  t(SAN, 'Cajas de registro', 'und', 'N'),
  t(SAN, 'Válvulas de compuerta', 'und', 'N'),

  t(ELE, 'Salida de techo (centro de luz)', 'pto', 'N'),
  t(ELE, 'Salida para tomacorriente', 'pto', 'N'),
  t(ELE, 'Salida para interruptor', 'pto', 'N'),
  t(ELE, 'Tubería PVC SEL ø 20 mm', 'm', 'L'),
  t(ELE, 'Cable 2.5 mm² (por conductor)', 'm', 'L', ['factor'], { factor: 2, factorLabel: 'Conductores' }),
  t(ELE, 'Tableros', 'und', 'N'),
];

/** Fórmulas básicas para crear una partida desde cero. */
export const BASIC_FORMULAS: readonly { label: string; hint: string; unit: string; base: Base; use: ParamKey[] }[] = [
  { label: 'Longitud', hint: 'Tuberías, contrazócalos, cercos', unit: 'm', base: 'L', use: [] },
  { label: 'Longitud × alto', hint: 'Muros, tarrajeos, pintura', unit: 'm²', base: 'L', use: ['alto'] },
  { label: 'Longitud × ancho × alto', hint: 'Cimientos, vigas, zanjas', unit: 'm³', base: 'L', use: ['ancho', 'alto'] },
  { label: 'Longitud × factor', hint: 'Acero en kg, cable por conductor', unit: 'kg', base: 'L', use: ['factor'] },
  { label: 'Área', hint: 'Pisos, cielorrasos, losas', unit: 'm²', base: 'A', use: [] },
  { label: 'Área × espesor', hint: 'Losas macizas, rellenos', unit: 'm³', base: 'A', use: ['alto'] },
  { label: 'Perímetro', hint: 'Contrazócalo de un ambiente', unit: 'm', base: 'P', use: [] },
  { label: 'Perímetro × alto', hint: 'Tarrajeo o zócalo de un ambiente', unit: 'm²', base: 'P', use: ['alto'] },
  { label: 'Cantidad', hint: 'Puertas, puntos de luz, aparatos', unit: 'und', base: 'N', use: [] },
  { label: 'Cantidad × largo × ancho × alto', hint: 'Zapatas, columnas', unit: 'm³', base: 'N', use: ['largo', 'ancho', 'alto'] },
];

export function partidaFromTemplate(tpl: PartidaTemplate, existing: readonly Partida[]): Partida {
  const use: Partida['use'] = {};
  for (const k of tpl.use ?? []) use[k] = true;
  const p: Partida = { id: newId('par'), code: nextCode(existing), name: tpl.name, unit: tpl.unit, base: tpl.base, use, color: nextPartidaColor(existing), group: tpl.group };
  for (const k of ['largo', 'ancho', 'alto', 'factor'] as const) if (tpl[k] !== undefined) p[k] = tpl[k];
  if (tpl.factorLabel) p.factorLabel = tpl.factorLabel;
  return p;
}

/** Siguiente ítem correlativo: 01, 02… (o continúa el último código con formato "…NN"). */
export function nextCode(existing: readonly Partida[]): string {
  let max = 0;
  for (const p of existing) {
    const m = /^(\d{1,3})$/.exec(p.code.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return String(Math.max(max, existing.length) + 1).padStart(2, '0');
}
