/**
 * Escalas, unidades y formato de números.
 *
 * La única conversión entre el plano y la obra es `mPerUnit` (metros reales por unidad de lámina):
 *   longitud real = longitud en lámina × mPerUnit        área real = área en lámina × mPerUnit²
 */
import { dist, type Pt } from './geometry';
import type { DrawingUnit } from './model';

/** Un punto tipográfico de PDF en metros (1/72 de pulgada; la pulgada son exactamente 25,4 mm). */
export const PT_TO_M = 0.0254 / 72;

export const UNIT_TO_M: Record<DrawingUnit, number> = { m: 1, cm: 0.01, mm: 0.001, in: 0.0254, ft: 0.3048 };

export const UNIT_LABEL: Record<DrawingUnit, string> = { m: 'metros', cm: 'centímetros', mm: 'milímetros', in: 'pulgadas', ft: 'pies' };

/** Escala gráfica 1:N de un PDF impreso a tamaño real: metros por punto. */
export const mPerUnitFromRatio = (n: number): number => PT_TO_M * n;

/** El N de la escala 1:N equivalente a un `mPerUnit` de una lámina PDF. */
export const ratioFromMPerUnit = (mPerUnit: number): number => mPerUnit / PT_TO_M;

/** Calibración con dos puntos del plano y la distancia real (en metros) entre ellos. */
export function mPerUnitFromCalibration(a: Pt, b: Pt, realMeters: number): number | null {
  const d = dist(a, b);
  if (!(d > 0) || !(realMeters > 0) || !Number.isFinite(realMeters)) return null;
  return realMeters / d;
}

/** $INSUNITS de la cabecera DXF → unidad de dibujo (null si no declara una que manejemos). */
export function drawingUnitFromInsUnits(code: number | undefined): DrawingUnit | null {
  switch (code) {
    case 1:
      return 'in';
    case 2:
      return 'ft';
    case 4:
      return 'mm';
    case 5:
      return 'cm';
    case 6:
      return 'm';
    default:
      return null;
  }
}

/**
 * Unidad probable de un dibujo sin unidad declarada, por el tamaño de su extensión: un plano de edificación mide
 * decenas de metros, es decir decenas de unidades si se dibujó en metros, miles en centímetros o decenas de miles
 * en milímetros. Es solo una sugerencia: la app siempre pide confirmarla.
 */
export function guessDrawingUnit(extent: number): DrawingUnit {
  if (!(extent > 0)) return 'm';
  if (extent < 1500) return 'm';
  if (extent < 15000) return 'cm';
  return 'mm';
}

/** Redondeo al número de decimales indicado, estable frente a los errores binarios (1.005 → 1.01). */
export function roundTo(n: number, decimals: number): number {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** decimals;
  const r = Math.round(Math.abs(n) * f * (1 + Number.EPSILON)) / f;
  return n < 0 ? -r : r;
}

/** Número con separador de miles "," y decimal "." (formato usual en Perú): 1,234.50 */
export function formatNumber(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return '—';
  const fixed = roundTo(n, decimals).toFixed(decimals);
  const neg = fixed.startsWith('-');
  const [int, frac] = (neg ? fixed.slice(1) : fixed).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const isZero = Number(fixed) === 0;
  return `${neg && !isZero ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

/**
 * Interpreta un número tecleado. Acepta punto o coma decimal ("3.25", "3,25") y separadores de miles cuando hay
 * ambos ("1,234.5" o "1.234,5": el último es el decimal). Devuelve null si no es un número.
 */
export function parseNumber(text: string): number | null {
  let s = text.trim().replace(/\s+/g, '').replace(/−/g, '-');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    s = s.indexOf(',') === lastComma ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const INCH_DENOMINATORS = new Set([2, 4, 8, 16, 32, 64]);

/**
 * Busca notas de escala en los textos de una lámina ("ESC. 1/50", "ESCALA 1:75", "E=1/100", "1:25") y devuelve
 * los N distintos encontrados, del más repetido al menos. Las fracciones de pulgada (1/2, 3/4…) no cuentan.
 */
export function detectScales(texts: Iterable<string>): number[] {
  const counts = new Map<number, number>();
  const add = (raw: string, weight: number) => {
    const n = Number(raw.replace(',', '.'));
    if (!Number.isFinite(n) || n < 1 || n > 20000) return;
    counts.set(n, (counts.get(n) ?? 0) + weight);
  };
  for (const text of texts) {
    if (text.length > 400) continue;
    const t = text.toUpperCase();
    const seen = new Set<number>();
    for (const m of t.matchAll(/(?:\bESC(?:ALA)?S?\b\.?|\bE)\s*[:=.\-]?\s*1\s*[:/]\s*(\d{1,5}(?:[.,]\d{1,2})?)(?![\d"'’”])/g)) {
      add(m[1], 3);
      seen.add(m.index ?? 0);
    }
    for (const m of t.matchAll(/(?<![\d.,/:])1\s*([:/])\s*(\d{1,5})(?![\d"'’”/.,:])/g)) {
      const n = Number(m[2]);
      if (m[1] === '/' && (INCH_DENOMINATORS.has(n) || n < 5)) continue;
      if (m[1] === ':' && n < 2) continue;
      add(m[2], 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([n]) => n);
}

/** Escalas gráficas habituales en planos de edificación. */
export const COMMON_RATIOS = [20, 25, 50, 75, 100, 125, 200, 250, 500] as const;
