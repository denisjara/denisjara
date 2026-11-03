/**
 * Valor esperado y criterio de Kelly (fraccional) para apuestas de valor.
 */

/** EV por unidad apostada: p·cuota − 1. */
export function expectedValue(p: number, odds: number): number {
  return p * odds - 1;
}

/** Ventaja: p − 1/cuota (probabilidad implícita bruta). */
export function edge(p: number, odds: number): number {
  return odds > 0 ? p - 1 / odds : 0;
}

/**
 * Fracción de banca: max(0, (p·cuota − 1)/(cuota − 1)) · fraction, recortada a cap.
 * Por defecto Kelly 1/4 con tope del 5 %.
 */
export function kelly(p: number, odds: number, fraction = 0.25, cap = 0.05): number {
  if (!Number.isFinite(p) || !Number.isFinite(odds) || odds <= 1) return 0;
  const full = (p * odds - 1) / (odds - 1);
  if (!(full > 0)) return 0;
  const f = full * Math.max(0, fraction);
  return Math.min(Math.max(0, cap), f);
}
