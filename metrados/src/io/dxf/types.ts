/**
 * Resultado de leer un archivo DXF: toda la geometría del espacio modelo en coordenadas del MUNDO (unidades de
 * dibujo, eje y hacia arriba), con los bloques ya expandidos y los colores resueltos.
 *
 * Es el contrato entre el lector (parser.ts) y el resto de la app (visor, enganche, lectura automática).
 */
import type { BBox, Part } from '../../core/geometry';

export interface DxfLayer {
  name: string;
  /** Color de la capa ya resuelto, "#rrggbb" (el ACI 7 "blanco/negro" se entrega como "#ffffff"). */
  color: string;
  /** Capa apagada (color negativo en la tabla). */
  off: boolean;
  /** Capa inutilizada (bit 1 de sus indicadores). */
  frozen: boolean;
}

export interface DxfPath {
  /** Vértices en coordenadas del mundo. Rectas, arcos (bulge) o Bézier (elipses y splines). */
  part: Part;
  /** Índice en `DxfDrawing.layers`. */
  layer: number;
  /** Color resuelto "#rrggbb" (PorCapa y PorBloque ya aplicados). */
  color: string;
  /** Tipo de entidad de origen: LINE, LWPOLYLINE, POLYLINE, ARC, CIRCLE, ELLIPSE, SPLINE, HATCH, SOLID, TRACE, 3DFACE, LEADER… */
  src: string;
  /** Relleno sólido (SOLID, TRACE, 3DFACE y sombreados SOLID). */
  fill?: boolean;
  /** Los anillos de un mismo sombreado (HATCH) comparten este número; sirve para calcular su área (exterior − islas). */
  hatch?: number;
  /** Grosor constante de polilínea en unidades de dibujo (solo si es > 0). */
  width?: number;
  /** Tipo de línea discontinuo (cualquiera distinto de CONTINUOUS). */
  dashed?: boolean;
  /** Nombre del bloque más externo del que procede (ausente en entidades sueltas del espacio modelo). */
  block?: string;
}

export interface DxfText {
  /** Punto de inserción (o de alineación, si la alineación no es la básica) en coordenadas del mundo. */
  x: number;
  y: number;
  /** Altura del texto en unidades de dibujo (ya escalada por los bloques). */
  height: number;
  /** Giro en radianes, antihorario en el mundo (eje y hacia arriba). */
  rotation: number;
  /** Texto limpio: sin códigos de formato de MTEXT, con %%c, %%d, %%p y \U+XXXX ya convertidos. Puede tener saltos de línea. */
  text: string;
  layer: number;
  color: string;
  halign: 'left' | 'center' | 'right';
  valign: 'baseline' | 'bottom' | 'middle' | 'top';
  widthFactor: number;
  /** TEXT, MTEXT, ATTRIB o DIMENSION (texto de cota). */
  src: string;
  block?: string;
}

export interface DxfInsert {
  /** Nombre del bloque insertado. */
  name: string;
  /** Punto de inserción en coordenadas del mundo. */
  x: number;
  y: number;
  /** Giro en radianes (antihorario en el mundo) y escalas resultantes. */
  rotation: number;
  sx: number;
  sy: number;
  layer: number;
  /** 0 si está directamente en el espacio modelo; 1, 2… si está anidado dentro de otros bloques. */
  depth: number;
  /** Atributos (etiqueta → valor) de la inserción, si los tiene. */
  attribs?: Record<string, string>;
}

export interface DxfDrawing {
  layers: DxfLayer[];
  paths: DxfPath[];
  texts: DxfText[];
  /** Todas las inserciones de bloques con nombre (las anónimas "*D…", "*U…", "*T…" de cotas y similares no se listan). */
  inserts: DxfInsert[];
  /** Caja envolvente de toda la geometría (paths y textos) en coordenadas del mundo. */
  bbox: BBox;
  /** $INSUNITS de la cabecera, si existe. */
  insUnits?: number;
  /** $ACADVER de la cabecera, si existe (p. ej. "AC1027"). */
  version?: string;
  /** Avisos para el usuario (entidades no admitidas, bloques que faltan…), ya redactados en español. */
  warnings: string[];
  stats: { entities: number; byType: Record<string, number> };
}

export interface ParseDxfOptions {
  /** Progreso de 0 a 1 (se llama de vez en cuando; el lector cede el hilo entre llamadas). */
  onProgress?: (fraction: number) => void;
}
