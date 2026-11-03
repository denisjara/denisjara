/**
 * Utilidades puras de la página de partido: derivados de la matriz de marcadores, agrupación de
 * mercados por familias de líneas y formateo de etiquetas que llegan del pipeline.
 */
import type { Market, MatchSummary, Prob1X2 } from '../../../types/data';
import { lookup } from '../../lib/lookup';

// ---------------------------------------------------------------------------
// Matriz de marcadores
// ---------------------------------------------------------------------------

/** Matriz válida (cuadrada o rectangular, números finitos). */
export function validMatrix(m: number[][] | undefined): m is number[][] {
  return Array.isArray(m) && m.length > 0 && m.every((r) => Array.isArray(r) && r.length > 0);
}

/** P(total = k) para k = 0..(filas+columnas-2). */
export function totalGoalsDist(m: number[][]): number[] {
  const rows = m.length;
  const cols = Math.max(...m.map((r) => r.length));
  const out = new Array(rows + cols - 1).fill(0);
  m.forEach((row, i) => row.forEach((v, j) => (out[i + j] += Number.isFinite(v) ? v : 0)));
  return out;
}

/** Pliega la cola de una distribución: [p0..p(k-1), P(≥k)]. */
export function foldTail(dist: number[], from: number): number[] {
  if (dist.length <= from + 1) return dist;
  const head = dist.slice(0, from);
  const tail = dist.slice(from).reduce((s, v) => s + v, 0);
  return [...head, tail];
}

export interface ScoreCell {
  home: number;
  away: number;
  p: number;
}

/** Los n marcadores más probables. */
export function topScores(m: number[][], n = 5): ScoreCell[] {
  const cells: ScoreCell[] = [];
  m.forEach((row, i) => row.forEach((p, j) => cells.push({ home: i, away: j, p })));
  return cells.sort((a, b) => b.p - a.p).slice(0, n);
}

export interface MatrixStats {
  outcome: Prob1X2;
  over15: number;
  over25: number;
  over35: number;
  btts: number;
  /** portería a cero del local (visitante no marca) */
  csHome: number;
  csAway: number;
  /** distribución de goles de cada equipo */
  homeGoals: number[];
  awayGoals: number[];
  expHome: number;
  expAway: number;
}

export function matrixStats(m: number[][]): MatrixStats {
  let home = 0;
  let draw = 0;
  let away = 0;
  let o15 = 0;
  let o25 = 0;
  let o35 = 0;
  let btts = 0;
  let csHome = 0;
  let csAway = 0;
  let expHome = 0;
  let expAway = 0;
  const cols = Math.max(...m.map((r) => r.length));
  const homeGoals = new Array(m.length).fill(0);
  const awayGoals = new Array(cols).fill(0);
  m.forEach((row, i) =>
    row.forEach((raw, j) => {
      const p = Number.isFinite(raw) ? raw : 0;
      if (i > j) home += p;
      else if (i === j) draw += p;
      else away += p;
      const t = i + j;
      if (t > 1.5) o15 += p;
      if (t > 2.5) o25 += p;
      if (t > 3.5) o35 += p;
      if (i > 0 && j > 0) btts += p;
      if (j === 0) csHome += p;
      if (i === 0) csAway += p;
      homeGoals[i] += p;
      awayGoals[j] += p;
      expHome += i * p;
      expAway += j * p;
    }),
  );
  const s = home + draw + away || 1;
  return {
    outcome: { home: home / s, draw: draw / s, away: away / s },
    over15: o15,
    over25: o25,
    over35: o35,
    btts,
    csHome,
    csAway,
    homeGoals,
    awayGoals,
    expHome,
    expAway,
  };
}

/** Probabilidad de un marcador exacto (0 si queda fuera de la matriz). */
export function scoreProb(m: number[][], home: number, away: number): number {
  return m[home]?.[away] ?? 0;
}

// ---------------------------------------------------------------------------
// Distribuciones discretas
// ---------------------------------------------------------------------------

/** Rango [lo, hi] de índices que concentra (1 - 2·eps) de la masa (para recortar ejes). */
export function massRange(dist: number[], eps = 0.002, minSpan = 6): [number, number] {
  const total = dist.reduce((s, v) => s + v, 0) || 1;
  let acc = 0;
  let lo = 0;
  let hi = dist.length - 1;
  for (let k = 0; k < dist.length; k++) {
    acc += dist[k] / total;
    if (acc > eps) {
      lo = k;
      break;
    }
  }
  acc = 0;
  for (let k = dist.length - 1; k >= 0; k--) {
    acc += dist[k] / total;
    if (acc > eps) {
      hi = k;
      break;
    }
  }
  while (hi - lo < minSpan) {
    if (lo > 0) lo--;
    if (hi - lo < minSpan && hi < dist.length - 1) hi++;
    if (lo === 0 && hi === dist.length - 1) break;
  }
  return [lo, hi];
}

/** P(X > line) de una distribución discreta. */
export function overProb(dist: number[], line: number): number {
  let s = 0;
  dist.forEach((p, k) => {
    if (k > line) s += p;
  });
  return s;
}

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

/** Decimales con coma: "Más de 2.5" → "Más de 2,5"; "53.6%" → "53,6%". */
export function localizeNumbers(s: string): string {
  return s.replace(/(\d)\.(\d)/g, '$1,$2');
}

/** Sustituye los nombres completos de los equipos por los cortos (selecciones compactas). */
export function shortTeams(s: string, match: Pick<MatchSummary, 'home' | 'away'>): string {
  let out = s;
  for (const t of [match.home, match.away]) {
    if (t.short && t.name && t.short !== t.name) out = out.split(t.name).join(t.short);
  }
  return out;
}

/** Etiqueta de selección lista para mostrar. */
export function selectionLabel(label: string, match: Pick<MatchSummary, 'home' | 'away'>): string {
  return localizeNumbers(shortTeams(label, match));
}

/** Línea con signo para hándicaps: −0,5 · 0 · +1,25 */
export function fmtLine(line: number, signed = false): string {
  const abs = Math.abs(line);
  const s = localizeNumbers(String(Number(abs.toFixed(2))));
  if (!signed) return line < 0 ? `−${s}` : s;
  if (line === 0) return '0';
  return `${line > 0 ? '+' : '−'}${s}`;
}

/** Minuto "45'+2'" → 45.02 (para ordenar y situar en la línea de tiempo). */
export function minuteValue(m: string | undefined): number {
  if (!m) return 0;
  const nums = m.match(/\d+/g)?.map(Number) ?? [];
  if (!nums.length) return 0;
  return nums[0] + (nums[1] ? nums[1] / 100 : 0);
}

/** Posesión → fracción [0,1] (acepta 0..1 o 0..100). */
export function asShare(v: number | undefined): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return v > 1.0001 ? v / 100 : v;
}

// ---------------------------------------------------------------------------
// Mercados: familias de líneas
// ---------------------------------------------------------------------------

export const GROUP_ORDER = ['Principales', 'Goles', 'Hándicap', 'Marcador', 'Mitades', 'Equipos', 'Córners', 'Tarjetas', 'Tiros', 'Faltas'] as const;

/** Tarjeta de mercado mostrada: un mercado suelto o una familia de líneas (O/U, hándicap…). */
export interface MarketEntry {
  key: string;
  group: Market['group'];
  title: string;
  /** mercados (1 si es suelto; varios ordenados por línea si es una familia) */
  markets: Market[];
  /** true si es una familia de líneas */
  family: boolean;
}

const LINE_ID = /^(.+?)-(-?\d+(?:\.\d+)?)$/;

function familyTitle(prefix: string, sample: Market, match: Pick<MatchSummary, 'home' | 'away'>): string {
  const fixed: Record<string, string> = {
    ou: 'Total de goles · más/menos',
    'ht-ou': 'Descanso · total de goles',
    '2h-ou': '2ª parte · total de goles',
    'team-home-ou': `Goles de ${match.home.name} · más/menos`,
    'team-away-ou': `Goles de ${match.away.name} · más/menos`,
    'ah-home': `Hándicap asiático · ${match.home.name}`,
    'ah-away': `Hándicap asiático · ${match.away.name}`,
    'eh-home': `Hándicap europeo · ${match.home.name}`,
    'eh-away': `Hándicap europeo · ${match.away.name}`,
    'corners-ou': 'Córners totales · más/menos',
    'cards-ou': 'Tarjetas totales · más/menos',
    'shots-ou': 'Tiros totales · más/menos',
    'shotsOnTarget-ou': 'Tiros a puerta totales · más/menos',
    'fouls-ou': 'Faltas totales · más/menos',
    'offsides-ou': 'Fueras de juego totales · más/menos',
  };
  const known = lookup(fixed, prefix);
  if (known) return known;
  // genérico: quita el último número del nombre
  return localizeNumbers(sample.name.replace(/\s*[+\-−]?\d+(?:[.,]\d+)?(?!.*\d)/, '').trim());
}

/** Línea de un mercado (campo line o número final del id). */
export function marketLine(m: Market): number | undefined {
  if (typeof m.line === 'number' && Number.isFinite(m.line)) return m.line;
  const g = LINE_ID.exec(m.id);
  return g ? Number(g[2]) : undefined;
}

/**
 * Agrupa los mercados en tarjetas: los que comparten prefijo de id + grupo y difieren solo en la
 * línea forman una familia (una tarjeta con selector de línea). Conserva el orden de aparición.
 */
export function buildEntries(markets: Market[], match: Pick<MatchSummary, 'home' | 'away'>): MarketEntry[] {
  const byPrefix = new Map<string, Market[]>();
  const prefixOf = (m: Market): string | undefined => {
    const g = LINE_ID.exec(m.id);
    return g ? `${m.group}|${g[1]}|${m.selections.length}` : undefined;
  };
  for (const m of markets) {
    const p = prefixOf(m);
    if (!p) continue;
    if (!byPrefix.has(p)) byPrefix.set(p, []);
    byPrefix.get(p)!.push(m);
  }
  const out: MarketEntry[] = [];
  const done = new Set<string>();
  for (const m of markets) {
    const p = prefixOf(m);
    const fam = p ? byPrefix.get(p) : undefined;
    if (p && fam && fam.length > 1) {
      if (done.has(p)) continue;
      done.add(p);
      const sorted = [...fam].sort((a, b) => (marketLine(a) ?? 0) - (marketLine(b) ?? 0));
      out.push({ key: `fam:${p}`, group: m.group, title: familyTitle(LINE_ID.exec(m.id)![1], m, match), markets: sorted, family: true });
    } else {
      out.push({ key: m.id, group: m.group, title: localizeNumbers(m.name), markets: [m], family: false });
    }
  }
  return out;
}

/** Índice de la línea "principal" de una familia: la que tiene cuota de mercado o la más equilibrada. */
export function mainLineIndex(markets: Market[]): number {
  const withOdds = markets.findIndex((m) => m.selections.some((s) => typeof s.marketOdds === 'number'));
  if (withOdds >= 0) return withOdds;
  let best = 0;
  let bestD = Infinity;
  markets.forEach((m, i) => {
    const p = m.selections[0]?.prob ?? 0;
    const d = Math.abs(p - (m.selections.length === 2 ? 0.5 : 1 / m.selections.length));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** EV máximo con cuota de mercado en un conjunto de mercados (undefined si no hay cuotas). */
export function bestEv(markets: Market[]): number | undefined {
  let best: number | undefined;
  for (const m of markets)
    for (const s of m.selections)
      if (typeof s.ev === 'number' && typeof s.marketOdds === 'number' && s.marketOdds > 1) best = best === undefined ? s.ev : Math.max(best, s.ev);
  return best;
}

/** Nota corta (1, X, 1X, 1/X) que cabe junto a la etiqueta; las largas se muestran aparte. */
export function isShortNote(note: string | undefined): boolean {
  return !!note && note.length <= 4;
}

/** Cabecera genérica de columna de una familia: "Más de 2.5" → "Más de"; "Napoli -0.5" → "Napoli". */
export function stripLine(label: string): string {
  return label
    .replace(/\(\s*[+\-−]?\d+(?:[.,]\d+)?\s*\)/g, '')
    .replace(/\s*[+\-−]?\d+(?:[.,]\d+)?/g, '')
    .trim();
}
