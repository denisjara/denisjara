/**
 * Marcas "redondas" para ejes numéricos (1, 2, 5 × 10^n), compartidas por LineChart y los gráficos de competición.
 *
 * Robustez: nunca entra en bucle ni genera listas enormes. Con rangos degenerados (no finitos, vacíos, desbordados
 * o más estrechos que la resolución de coma flotante, p. ej. 1500 y 1500.0000000000002) devuelve los extremos.
 */
export const MAX_TICKS = 50;

export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return Number.isFinite(lo) ? [lo] : Number.isFinite(hi) ? [hi] : [];
  if (!(hi > lo)) return [lo];
  const n = Math.max(1, Math.min(20, Math.floor(count) || 1));
  const span = hi - lo;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.ceil(lo / step) * step;
  // Paso inútil (no avanza al sumarlo, no finito o demasiadas marcas): solo los extremos.
  if (!(step > 0) || !Number.isFinite(step) || !Number.isFinite(start) || !Number.isFinite(span) || start + step === start || span / step > MAX_TICKS) {
    return [lo, hi];
  }
  const out: number[] = [];
  // v = start + i·step (sin acumular error) y como mucho MAX_TICKS iteraciones pase lo que pase.
  for (let i = 0; i < MAX_TICKS; i++) {
    const v = start + i * step;
    if (v > hi + step * 1e-6) break;
    out.push(Number(v.toFixed(10)));
  }
  return out.length ? out : [lo, hi];
}
