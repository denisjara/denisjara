/**
 * Colores semánticos de FutStat Lab. SIEMPRE referencia los tokens (variables CSS) en lugar
 * de hex sueltos, para que el tema claro/oscuro funcione. Reglas en src/app/DESIGN.md.
 */
import type { Outcome, TeamRef } from '../../types/data';

/** color CSS de un token: token('home') → "rgb(var(--c-home))"; con alpha → "rgb(var(--c-home) / 0.2)" */
export function token(name: string, alpha?: number): string {
  return alpha === undefined ? `rgb(var(--c-${name}))` : `rgb(var(--c-${name}) / ${alpha})`;
}

export type Side = 'home' | 'draw' | 'away';

/** Relleno de cada lado del 1X2 (Local · Empate · Visitante). */
export const SIDE_COLOR: Record<Side, string> = {
  home: token('home'),
  draw: token('draw'),
  away: token('away'),
};
/** Tinta legible SOBRE el relleno de cada lado. */
export const SIDE_INK: Record<Side, string> = {
  home: token('on-home'),
  draw: token('on-draw'),
  away: token('on-away'),
};
/** Clases Tailwind equivalentes. */
export const SIDE_CLASS: Record<Side, { bg: string; text: string; ink: string; border: string }> = {
  home: { bg: 'bg-home', text: 'text-home', ink: 'text-home-ink', border: 'border-home' },
  draw: { bg: 'bg-draw', text: 'text-draw', ink: 'text-draw-ink', border: 'border-draw' },
  away: { bg: 'bg-away', text: 'text-away', ink: 'text-away-ink', border: 'border-away' },
};

/** V/E/D */
export const OUTCOME_CLASS: Record<Outcome, string> = {
  W: 'bg-win text-win-ink',
  D: 'bg-draw text-draw-ink',
  L: 'bg-loss text-loss-ink',
};

/** Color para un valor esperado / delta: positivo → pos, negativo → neg. */
export function deltaClass(x: number | undefined | null, neutralBand = 0): string {
  if (typeof x !== 'number' || !Number.isFinite(x)) return 'text-ink-3';
  if (x > neutralBand) return 'text-pos';
  if (x < -neutralBand) return 'text-neg';
  return 'text-ink-2';
}

/**
 * Escala secuencial de un solo tono (heatmaps, distribuciones). t ∈ [0,1].
 * Devuelve el fondo y la tinta legible para el texto dentro de la celda.
 */
export function seqFill(t: number): { background: string; color: string } {
  const v = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const alpha = v <= 0 ? 0.04 : 0.08 + 0.92 * v;
  return {
    background: token('seq', Number(alpha.toFixed(3))),
    color: alpha > 0.58 ? token('on-seq') : token('ink-1'),
  };
}

// ---------------------------------------------------------------------------
// Colores de equipo (escudos de reserva)
// ---------------------------------------------------------------------------
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * Color identitario de un equipo como "#rrggbb". Usa team.color si es utilizable; si falta o es
 * casi negro/blanco, genera uno estable a partir del nombre.
 */
export function teamColor(team: Pick<TeamRef, 'name' | 'color'> | { name: string; color?: string }): string {
  const rgb = team.color ? hexToRgb(team.color) : null;
  if (rgb) {
    const l = luminance(rgb);
    if (l > 0.02 && l < 0.85) return `#${team.color!.replace('#', '').toLowerCase()}`;
  }
  const h = hashString(team.name || '?');
  const hue = h % 360;
  const sat = 45 + (h >> 9) % 20;
  const light = 38 + (h >> 17) % 12;
  return hslToHex(hue, sat, light);
}

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sN * Math.min(lN, 1 - lN);
  const f = (n: number) => lN - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/** Tinta legible (#fff o casi negro) sobre un color hex. */
export function readableInk(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#ffffff';
  const l = luminance(rgb);
  // contraste con blanco vs con negro
  return (1.05 / (l + 0.05)) >= ((l + 0.05) / 0.0525) ? '#ffffff' : '#0b0f14';
}

/** Iniciales para escudos de reserva: "Real Madrid" → "RM", abbr preferente. */
export function initials(name: string, abbr?: string): string {
  if (abbr && abbr.length <= 4) return abbr.toUpperCase();
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 || /^[A-Z]{2,}$/.test(w));
  if (!words.length) return name.slice(0, 2).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
