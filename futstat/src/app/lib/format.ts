/**
 * Formato es-ES para toda la app. Probabilidades llegan en [0,1]; cuotas decimales.
 * Fechas/horas en la zona horaria local del navegador.
 */
import type { MatchStatus, Outcome, Prob1X2 } from '../../types/data';

const LOCALE = 'es-ES';
const nfCache = new Map<string, Intl.NumberFormat>();

function nf(min: number, max: number, extra: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${min}|${max}|${JSON.stringify(extra)}`;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: min, maximumFractionDigits: max, ...extra });
    nfCache.set(key, f);
  }
  return f;
}

const DASH = '–';
const ok = (x: number | undefined | null): x is number => typeof x === 'number' && Number.isFinite(x);

/** Número con `digits` decimales fijos: num(1.456, 2) → "1,46". */
export function num(x: number | undefined | null, digits = 1): string {
  return ok(x) ? nf(digits, digits).format(x) : DASH;
}

/** Entero con separador de miles: int(12840) → "12.840". */
export function int(x: number | undefined | null): string {
  return ok(x) ? nf(0, 0, { useGrouping: true }).format(Math.round(x)) : DASH;
}

/** Número compacto: compact(12900) → "12,9 mil". */
export function compact(x: number | undefined | null): string {
  return ok(x) ? new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 }).format(x) : DASH;
}

/** Probabilidad [0,1] → "54%". digits = decimales. Valores <0,5% se muestran "<1%" con digits=0. */
export function pct(p: number | undefined | null, digits = 0): string {
  if (!ok(p)) return DASH;
  const v = p * 100;
  if (digits === 0 && v > 0 && v < 0.5) return '<1%';
  if (digits === 0 && v < 100 && v > 99.5) return '>99%';
  return `${nf(digits, digits).format(v)}%`;
}

/** Diferencia con signo en puntos porcentuales: signedPct(0.084) → "+8,4%". */
export function signedPct(x: number | undefined | null, digits = 1): string {
  if (!ok(x)) return DASH;
  const s = nf(digits, digits).format(Math.abs(x * 100));
  if (Math.abs(x * 100) < 0.5 * 10 ** -digits) return `${s}%`;
  return `${x > 0 ? '+' : '−'}${s}%`;
}

/** Valor esperado por unidad → "+6,2%" */
export const ev = (x: number | undefined | null) => signedPct(x, 1);

/** Número con signo: signed(0.35, 2) → "+0,35". */
export function signed(x: number | undefined | null, digits = 1): string {
  if (!ok(x)) return DASH;
  const s = nf(digits, digits).format(Math.abs(x));
  return x > 0 ? `+${s}` : x < 0 ? `−${s}` : s;
}

/** Cuota decimal → "2,10" (1 decimal ≥ 10, 0 decimales ≥ 100). */
export function odds(o: number | undefined | null): string {
  if (!ok(o) || o <= 1) return DASH;
  if (o >= 100) return nf(0, 0).format(o);
  if (o >= 10) return nf(1, 1).format(o);
  return nf(2, 2).format(o);
}

/** Probabilidad → cuota justa formateada. */
export function fairOddsFromProb(p: number | undefined | null): string {
  return ok(p) && p > 0 ? odds(Math.min(1000, 1 / p)) : DASH;
}

/** xG / goles esperados → "1,45" */
export const xg = (x: number | undefined | null) => num(x, 2);

/** Minuto de juego → "67'" ; acepta "67'" ya formateado. */
export function minute(m: number | string | undefined | null): string {
  if (m === undefined || m === null || m === '') return '';
  if (typeof m === 'number') return `${Math.round(m)}'`;
  return /\d$/.test(m) ? `${m}'` : m;
}

// ---------------------------------------------------------------------------
// Fechas (zona local del navegador)
// ---------------------------------------------------------------------------
const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts);
  let f = dtfCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE, opts);
    dtfCache.set(key, f);
  }
  return f;
}

const toDate = (d: string | Date | number) => (d instanceof Date ? d : new Date(d));
const valid = (d: Date) => !Number.isNaN(d.getTime());

/** "21:00" */
export function time(d: string | Date | number): string {
  const x = toDate(d);
  return valid(x) ? dtf({ hour: '2-digit', minute: '2-digit', hour12: false }).format(x) : DASH;
}

/** "mar 4 nov" */
export function shortDate(d: string | Date | number): string {
  const x = toDate(d);
  if (!valid(x)) return DASH;
  const wd = dtf({ weekday: 'short' }).format(x).replace('.', '');
  const day = x.getDate();
  const mon = dtf({ month: 'short' }).format(x).replace('.', '');
  return `${wd} ${day} ${mon}`;
}

/** "martes, 4 de noviembre" */
export function longDate(d: string | Date | number): string {
  const x = toDate(d);
  return valid(x) ? dtf({ weekday: 'long', day: 'numeric', month: 'long' }).format(x) : DASH;
}

/** "4 nov 2026, 21:00" */
export function dateTime(d: string | Date | number): string {
  const x = toDate(d);
  return valid(x) ? dtf({ day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(x) : DASH;
}

/** Clave de día local "YYYY-MM-DD". */
export function dayKey(d: string | Date | number): string {
  const x = toDate(d);
  if (!valid(x)) return '';
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Date local a medianoche desde "YYYY-MM-DD". */
export function fromDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** Suma días a una fecha (local). */
export function addDays(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

/** Diferencia en días naturales locales (b - a). */
export function dayDiff(a: string | Date | number, b: string | Date | number = new Date()): number {
  const da = fromDayKey(dayKey(a));
  const db = fromDayKey(dayKey(b));
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

/** "Hoy" | "Mañana" | "Ayer" | "mié 5 nov" */
export function relativeDay(d: string | Date | number, now: Date = new Date()): string {
  const diff = -dayDiff(d, now); // d - now
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Mañana';
  if (diff === -1) return 'Ayer';
  return shortDate(d);
}

/** "Hoy · 21:00" / "mié 5 nov · 18:45" */
export function kickoff(d: string | Date | number, now: Date = new Date()): string {
  return `${relativeDay(d, now)} · ${time(d)}`;
}

/** "hace 3 h", "hace 12 min", "hace 2 días" */
export function timeAgo(d: string | Date | number, now: Date = new Date()): string {
  const x = toDate(d);
  if (!valid(x)) return DASH;
  const s = Math.round((now.getTime() - x.getTime()) / 1000);
  if (s < 0) {
    const m = Math.round(-s / 60);
    if (m < 60) return `en ${m} min`;
    const h = Math.round(m / 60);
    return h < 24 ? `en ${h} h` : `en ${Math.round(h / 24)} días`;
  }
  if (s < 60) return 'hace un momento';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const days = Math.round(h / 24);
  return days === 1 ? 'hace 1 día' : `hace ${days} días`;
}

/** Horas transcurridas desde una fecha. */
export function hoursSince(d: string | Date | number, now: Date = new Date()): number {
  return (now.getTime() - toDate(d).getTime()) / 3_600_000;
}

// ---------------------------------------------------------------------------
// Fútbol
// ---------------------------------------------------------------------------
/** Letra visible para V/E/D (Victoria, Empate, Derrota). */
export const OUTCOME_LETTER: Record<Outcome, string> = { W: 'V', D: 'E', L: 'D' };
export const OUTCOME_LABEL: Record<Outcome, string> = { W: 'Victoria', D: 'Empate', L: 'Derrota' };

export const STATUS_LABEL: Record<MatchStatus, string> = {
  scheduled: 'Programado',
  live: 'En vivo',
  finished: 'Final',
  postponed: 'Aplazado',
  cancelled: 'Cancelado',
};

/** Etiquetas 1X2 */
export const PICK_LABEL = { home: 'Local', draw: 'Empate', away: 'Visitante' } as const;
export const PICK_SHORT = { home: '1', draw: 'X', away: '2' } as const;

/** Lado más probable de un 1X2. */
export function topOutcome(p: Prob1X2): 'home' | 'draw' | 'away' {
  if (p.home >= p.draw && p.home >= p.away) return 'home';
  if (p.away >= p.draw) return 'away';
  return 'draw';
}

/** Resultado real de un marcador. */
export function scoreOutcome(home: number, away: number): 'home' | 'draw' | 'away' {
  return home > away ? 'home' : home < away ? 'away' : 'draw';
}

/** Quita acentos y pasa a minúsculas para búsquedas. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Plural sencillo: plural(3, 'partido') → "3 partidos" */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${int(n)} ${n === 1 ? one : many}`;
}
