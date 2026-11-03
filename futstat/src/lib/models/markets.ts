/**
 * Mercados de goles derivados de la matriz de marcadores Dixon-Coles
 * (equivalente al catálogo de una casa de apuestas: 1X2, totales, hándicaps, marcador exacto, mitades...).
 */
import type { Market, MarketGroup, MarketSelection, OddsSnapshot } from '../../types/data';
import { fairOdds } from './odds';
import { dcTau, goalDiffDist, outcomeProbs, poissonPmfArray, scoreMatrix, totalGoalsDist, type IntDist } from './poisson';

export interface MarketContext {
  lambdaHome: number;
  lambdaAway: number;
  rho: number;
  homeName: string;
  awayName: string;
  odds?: OddsSnapshot;
  /** tamaño de la matriz (0..maxGoals). Default 10 */
  maxGoals?: number;
}

/** Fracción de los goles esperados que corresponden a la primera parte. */
export const FIRST_HALF_SHARE = 0.45;
export const TOTAL_LINES = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];
export const TEAM_TOTAL_LINES = [0.5, 1.5, 2.5];
/** Líneas de hándicap asiático publicadas (perspectiva del local): -2.5..+2.5 cada 0.25. */
export const ASIAN_LINES: number[] = Array.from({ length: 21 }, (_, k) => (k - 10) / 4);
export const EUROPEAN_LINES = [-1, 1];

const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Liquidación de líneas (totales y hándicap asiático)
// ---------------------------------------------------------------------------

export interface AsianResult {
  win: number;
  halfWin: number;
  push: number;
  halfLoss: number;
  loss: number;
  /** cuota que hace EV = 0 considerando devoluciones y medias apuestas (máx. 1000) */
  fairOdds: number;
}

/** Divide una línea de cuarto (x.25 / x.75) en sus dos medias líneas; otras líneas → [l, l]. */
export function splitLine(line: number): [number, number] {
  const q = Math.round(line * 4);
  if (Math.abs(line * 4 - q) < EPS && Math.abs(q % 2) === 1) return [(q - 1) / 4, (q + 1) / 4];
  return [line, line];
}

/** true si la línea es de cuarto (la apuesta se divide en dos). */
export function isQuarterLine(line: number): boolean {
  const [a, b] = splitLine(line);
  return a !== b;
}

/** true si la línea es entera (posible devolución). */
export function isIntegerLine(line: number): boolean {
  return Math.abs(line - Math.round(line)) < EPS;
}

function sgn(v: number): -1 | 0 | 1 {
  return v > EPS ? 1 : v < -EPS ? -1 : 0;
}

/** Probabilidad "efectiva" (1/cuota justa): parte ganadora sobre el capital en riesgo. */
export function asianEffectiveProb(r: Omit<AsianResult, 'fairOdds'>): number {
  const d = r.win + r.halfWin / 2;
  const n = r.win + r.halfWin / 2 + r.halfLoss / 2 + r.loss;
  return n > EPS ? d / n : 0.5;
}

/** EV por unidad apostada de una apuesta asiática a cuota `odds`. */
export function asianEV(r: Omit<AsianResult, 'fairOdds'>, odds: number): number {
  return r.win * (odds - 1) + (r.halfWin * (odds - 1)) / 2 - r.halfLoss / 2 - r.loss;
}

/**
 * Liquida "X + line > 0" con X ~ dist. Gana si > 0, nulo si = 0, pierde si < 0;
 * las líneas de cuarto se dividen en dos medias apuestas.
 */
export function settleLine(dist: IntDist, line: number): AsianResult {
  const [l1, l2] = splitLine(line);
  let win = 0;
  let halfWin = 0;
  let push = 0;
  let halfLoss = 0;
  let loss = 0;
  for (let k = 0; k < dist.p.length; k++) {
    const p = dist.p[k];
    if (!(p > 0)) continue;
    const x = dist.min + k;
    const s = sgn(x + l1) + sgn(x + l2);
    if (s === 2) win += p;
    else if (s === 1) halfWin += p;
    else if (s === 0) push += p;
    else if (s === -1) halfLoss += p;
    else loss += p;
  }
  const tot = win + halfWin + push + halfLoss + loss;
  if (tot > 0 && Math.abs(tot - 1) > 1e-12) {
    win /= tot;
    halfWin /= tot;
    push /= tot;
    halfLoss /= tot;
    loss /= tot;
  }
  const r = { win, halfWin, push, halfLoss, loss };
  const d = win + halfWin / 2;
  const n = win + halfWin / 2 + halfLoss / 2 + loss;
  const fo = d > EPS ? Math.min(1000, n / d) : 1000;
  return { ...r, fairOdds: Math.max(1, fo) };
}

function negate(dist: IntDist): IntDist {
  const p = [...dist.p].reverse();
  return { min: -(dist.min + dist.p.length - 1), p };
}

function totalAsDist(matrix: number[][]): IntDist {
  return { min: 0, p: totalGoalsDist(matrix) };
}

/** Más/Menos (estricto): over = P(T > línea), under = P(T < línea), push = P(T = línea). */
export function overUnder(matrix: number[][], line: number): { over: number; under: number; push: number } {
  const t = totalGoalsDist(matrix);
  let over = 0;
  let under = 0;
  let push = 0;
  for (let k = 0; k < t.length; k++) {
    if (k > line + EPS) over += t[k];
    else if (k < line - EPS) under += t[k];
    else push += t[k];
  }
  return { over, under, push };
}

/**
 * Hándicap asiático: `line` se aplica al equipo `side` (p. ej. -0.75 local).
 * Gana si (goles propios − ajenos) + línea > 0. Las líneas de cuarto se dividen en dos medias apuestas.
 */
export function asianHandicap(
  matrix: number[][],
  line: number,
  side: 'home' | 'away',
): { win: number; halfWin: number; push: number; halfLoss: number; loss: number; fairOdds: number } {
  const d = goalDiffDist(matrix);
  return settleLine(side === 'home' ? d : negate(d), line);
}

/** Total asiático (líneas enteras o de cuarto): 'over' gana si T > línea, 'under' si T < línea. */
export function asianTotal(matrix: number[][], line: number, side: 'over' | 'under'): AsianResult {
  const t = totalAsDist(matrix);
  return side === 'over' ? settleLine(t, -line) : settleLine(negate(t), line);
}

// ---------------------------------------------------------------------------
// Mitades: 1ª parte = 0.45·λ, 2ª = 0.55·λ (Poisson independientes) con τ de DC sobre el marcador final
// ---------------------------------------------------------------------------

export interface HalvesModel {
  /** matriz de marcadores al descanso [i][j] */
  ht: number[][];
  /** distribución de goles totales en la 2ª parte */
  secondHalfTotal: number[];
  /** [resultado descanso][resultado final], 0 = local, 1 = empate, 2 = visitante */
  htft: number[][];
}

function res(i: number, j: number): 0 | 1 | 2 {
  return i > j ? 0 : i === j ? 1 : 2;
}

/**
 * Modelo conjunto de las dos mitades. Cada mitad es Poisson independiente (λ·share), y la corrección
 * τ de Dixon-Coles se aplica sobre el marcador final, de modo que las marginales del final coinciden
 * con `scoreMatrix(λh, λa, rho)` y los mercados de mitades son coherentes con el 1X2.
 */
export function halvesModel(
  lambdaHome: number,
  lambdaAway: number,
  rho = 0,
  share = FIRST_HALF_SHARE,
  maxPerHalf = 10,
): HalvesModel {
  const M = Math.max(1, Math.floor(maxPerHalf));
  const h1 = poissonPmfArray(lambdaHome * share, M);
  const a1 = poissonPmfArray(lambdaAway * share, M);
  const h2 = poissonPmfArray(lambdaHome * (1 - share), M);
  const a2 = poissonPmfArray(lambdaAway * (1 - share), M);
  const ht: number[][] = Array.from({ length: M + 1 }, () => new Array<number>(M + 1).fill(0));
  const htft: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const sh = new Array<number>(2 * M + 1).fill(0);
  let total = 0;
  for (let a = 0; a <= M; a++) {
    for (let b = 0; b <= M; b++) {
      const pab = h1[a] * a1[b];
      if (pab < 1e-300) continue;
      const rHT = res(a, b);
      const htRow = htft[rHT];
      let cell = 0;
      for (let c = 0; c <= M; c++) {
        const pabc = pab * h2[c];
        if (pabc < 1e-300) continue;
        const i = a + c;
        for (let d = 0; d <= M; d++) {
          let p = pabc * a2[d];
          const j = b + d;
          if (i < 2 && j < 2) p *= dcTau(i, j, lambdaHome, lambdaAway, rho);
          cell += p;
          htRow[res(i, j)] += p;
          sh[c + d] += p;
        }
      }
      ht[a][b] = cell;
      total += cell;
    }
  }
  if (total > 0) {
    for (const row of ht) for (let j = 0; j < row.length; j++) row[j] /= total;
    for (const row of htft) for (let j = 0; j < 3; j++) row[j] /= total;
    for (let k = 0; k < sh.length; k++) sh[k] /= total;
  }
  return { ht, secondHalfTotal: sh, htft };
}

// ---------------------------------------------------------------------------
// Construcción del catálogo de mercados
// ---------------------------------------------------------------------------

/** "+0.75", "-1", "0". */
export function formatSignedLine(line: number): string {
  const v = Math.abs(line) < EPS ? 0 : line;
  return v > 0 ? `+${v}` : `${v}`;
}

/** Línea para ids estables: -0.75 → "-0.75", 0 → "0", 1 → "1". */
function idLine(line: number): string {
  return String(Math.abs(line) < EPS ? 0 : line);
}

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

function validOdds(o: number | undefined): o is number {
  return typeof o === 'number' && Number.isFinite(o) && o > 1;
}

function sel(label: string, prob: number, note?: string): MarketSelection {
  const p = Math.min(1, Math.max(0, prob));
  const s: MarketSelection = { label, prob: p, fairOdds: fairOdds(p) };
  if (note) s.note = note;
  return s;
}

function withOdds(s: MarketSelection, odds: number | undefined, ev?: number): MarketSelection {
  if (!validOdds(odds)) return s;
  s.marketOdds = odds;
  s.ev = ev ?? s.prob * odds - 1;
  return s;
}

function asianNote(r: AsianResult, line: number, signed: boolean): string {
  const parts = [`Gana ${pct(r.win)}`];
  if (r.halfWin > EPS) parts.push(`medio gana ${pct(r.halfWin)}`);
  if (r.push > EPS) parts.push(`nulo ${pct(r.push)}`);
  if (r.halfLoss > EPS) parts.push(`medio pierde ${pct(r.halfLoss)}`);
  parts.push(`pierde ${pct(r.loss)}`);
  const [a, b] = splitLine(line);
  const f = (x: number) => (signed ? formatSignedLine(x) : String(x));
  if (a !== b) parts.push(`apuesta dividida en ${f(a)} y ${f(b)}`);
  else if (isIntegerLine(line)) parts.push('si se iguala la línea se devuelve la apuesta');
  return parts.join(' · ');
}

function asianSelection(label: string, r: AsianResult, line: number, signed: boolean, odds?: number): MarketSelection {
  const prob = asianEffectiveProb(r);
  const s: MarketSelection = { label, prob, fairOdds: r.fairOdds, note: asianNote(r, line, signed) };
  if (validOdds(odds)) {
    s.marketOdds = odds;
    s.ev = asianEV(r, odds);
  }
  return s;
}

function sameLine(a: number | undefined, b: number): boolean {
  return typeof a === 'number' && Math.abs(a - b) < 1e-6;
}

function isQuarterMultiple(x: number | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x) && Math.abs(x * 4 - Math.round(x * 4)) < 1e-6;
}

function overUnderMarket(
  id: string,
  group: MarketGroup,
  name: string,
  dist: number[],
  line: number,
  oddsOver?: number,
  oddsUnder?: number,
): Market {
  if (Math.abs(line * 2 - Math.round(line * 2)) < EPS && !isIntegerLine(line)) {
    // media línea: sin devolución
    let over = 0;
    for (let k = 0; k < dist.length; k++) if (k > line) over += dist[k];
    over = Math.min(1, Math.max(0, over));
    return {
      id,
      group,
      name,
      line,
      selections: [
        withOdds(sel(`Más de ${line}`, over), oddsOver),
        withOdds(sel(`Menos de ${line}`, 1 - over), oddsUnder),
      ],
    };
  }
  // línea entera o de cuarto: liquidación asiática
  const t: IntDist = { min: 0, p: dist };
  const rOver = settleLine(t, -line);
  const rUnder = settleLine(negate(t), line);
  return {
    id,
    group,
    name,
    line,
    selections: [
      asianSelection(`Más de ${line}`, rOver, line, false, oddsOver),
      asianSelection(`Menos de ${line}`, rUnder, line, false, oddsUnder),
    ],
  };
}

/**
 * Catálogo completo de mercados de goles para un partido. Probabilidades de cada mercado de
 * selecciones excluyentes suman 1 (la doble oportunidad suma 2). En hándicap asiático y totales
 * con devolución, `prob` es la probabilidad efectiva (= 1/cuota justa) y `note` detalla gana/nulo/pierde.
 */
export function buildGoalMarkets(ctx: MarketContext): Market[] {
  const lh = Number.isFinite(ctx.lambdaHome) && ctx.lambdaHome > 0 ? ctx.lambdaHome : 0;
  const la = Number.isFinite(ctx.lambdaAway) && ctx.lambdaAway > 0 ? ctx.lambdaAway : 0;
  const rho = Number.isFinite(ctx.rho) ? ctx.rho : 0;
  const H = ctx.homeName?.trim() || 'Local';
  const A = ctx.awayName?.trim() || 'Visitante';
  const odds = ctx.odds;
  const m = scoreMatrix(lh, la, rho, ctx.maxGoals ?? 10);
  const n = m.length;
  const markets: Market[] = [];

  // ---- Principales
  const p = outcomeProbs(m);
  markets.push({
    id: '1x2',
    group: 'Principales',
    name: 'Resultado final (1X2)',
    selections: [
      withOdds(sel(H, p.home, '1'), odds?.home),
      withOdds(sel('Empate', p.draw, 'X'), odds?.draw),
      withOdds(sel(A, p.away, '2'), odds?.away),
    ],
  });
  markets.push({
    id: 'dc',
    group: 'Principales',
    name: 'Doble oportunidad',
    selections: [
      sel(`${H} o empate`, p.home + p.draw, '1X'),
      sel(`${H} o ${A}`, p.home + p.away, '12'),
      sel(`Empate o ${A}`, p.draw + p.away, 'X2'),
    ],
  });
  const nd = p.home + p.away;
  markets.push({
    id: 'dnb',
    group: 'Principales',
    name: 'Empate no apuesta',
    selections: [
      sel(H, nd > 0 ? p.home / nd : 0.5, 'Si hay empate se devuelve la apuesta'),
      sel(A, nd > 0 ? p.away / nd : 0.5, 'Si hay empate se devuelve la apuesta'),
    ],
  });

  let bttsYes = 0;
  let hYes = 0;
  let dYes = 0;
  let aYes = 0;
  for (let i = 1; i < n; i++) {
    for (let j = 1; j < n; j++) {
      const v = m[i][j];
      bttsYes += v;
      if (i > j) hYes += v;
      else if (i === j) dYes += v;
      else aYes += v;
    }
  }
  markets.push({
    id: 'btts',
    group: 'Principales',
    name: 'Ambos equipos marcan',
    selections: [sel('Sí', bttsYes), sel('No', 1 - bttsYes)],
  });
  markets.push({
    id: 'btts-result',
    group: 'Principales',
    name: 'Resultado + ambos marcan',
    selections: [
      sel(`${H} / Sí`, hYes, '1 y ambos marcan'),
      sel('Empate / Sí', dYes, 'X y ambos marcan'),
      sel(`${A} / Sí`, aYes, '2 y ambos marcan'),
      sel(`${H} / No`, Math.max(0, p.home - hYes), '1 y no marcan ambos'),
      sel('Empate / No', Math.max(0, p.draw - dYes), 'X y no marcan ambos (0-0)'),
      sel(`${A} / No`, Math.max(0, p.away - aYes), '2 y no marcan ambos'),
    ],
  });

  // ---- Goles
  const total = totalGoalsDist(m);
  const totalLines = [...TOTAL_LINES];
  const bookTotal = odds?.totalLine;
  if (isQuarterMultiple(bookTotal) && bookTotal > 0 && !totalLines.some((l) => sameLine(bookTotal, l))) {
    totalLines.push(bookTotal);
    totalLines.sort((a, b) => a - b);
  }
  for (const line of totalLines) {
    const isBook = sameLine(bookTotal, line);
    markets.push(
      overUnderMarket(
        `ou-${idLine(line)}`,
        'Goles',
        `Más/Menos ${line} goles`,
        total,
        line,
        isBook ? odds?.over : undefined,
        isBook ? odds?.under : undefined,
      ),
    );
  }
  const exact: MarketSelection[] = [];
  let acc = 0;
  for (let k = 0; k <= 5; k++) {
    const v = total[k] ?? 0;
    acc += v;
    exact.push(sel(k === 1 ? '1 gol' : `${k} goles`, v));
  }
  exact.push(sel('6 o más', Math.max(0, 1 - acc)));
  markets.push({ id: 'total-exact', group: 'Goles', name: 'Goles totales exactos', selections: exact });
  let even = 0;
  for (let k = 0; k < total.length; k += 2) even += total[k];
  markets.push({
    id: 'odd-even',
    group: 'Goles',
    name: 'Goles totales: par/impar',
    selections: [sel('Par', even, '0 goles cuenta como par'), sel('Impar', 1 - even)],
  });

  // ---- Equipos
  const homeDist = new Array<number>(n).fill(0);
  const awayDist = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      homeDist[i] += m[i][j];
      awayDist[j] += m[i][j];
    }
  }
  for (const [side, name, dist] of [
    ['home', H, homeDist],
    ['away', A, awayDist],
  ] as const) {
    for (const line of TEAM_TOTAL_LINES) {
      markets.push(overUnderMarket(`team-${side}-ou-${idLine(line)}`, 'Equipos', `Goles de ${name}: más/menos ${line}`, dist, line));
    }
  }
  const csHome = awayDist[0]; // local no encaja
  const csAway = homeDist[0];
  markets.push({
    id: 'clean-sheet-home',
    group: 'Equipos',
    name: `Portería a cero: ${H}`,
    selections: [sel('Sí', csHome), sel('No', 1 - csHome)],
  });
  markets.push({
    id: 'clean-sheet-away',
    group: 'Equipos',
    name: `Portería a cero: ${A}`,
    selections: [sel('Sí', csAway), sel('No', 1 - csAway)],
  });
  const wtnHome = Math.max(0, csHome - m[0][0]);
  const wtnAway = Math.max(0, csAway - m[0][0]);
  markets.push({
    id: 'win-to-nil-home',
    group: 'Equipos',
    name: `${H} gana sin encajar`,
    selections: [sel('Sí', wtnHome), sel('No', 1 - wtnHome)],
  });
  markets.push({
    id: 'win-to-nil-away',
    group: 'Equipos',
    name: `${A} gana sin encajar`,
    selections: [sel('Sí', wtnAway), sel('No', 1 - wtnAway)],
  });
  const p00 = m[0][0];
  const shareHome = lh + la > 0 ? lh / (lh + la) : 0.5;
  markets.push({
    id: 'first-goal',
    group: 'Equipos',
    name: 'Primer equipo en marcar',
    selections: [
      sel(H, (1 - p00) * shareHome),
      sel('Sin goles', p00),
      sel(A, (1 - p00) * (1 - shareHome)),
    ],
  });

  // ---- Hándicap
  const diff = goalDiffDist(m);
  const negDiff = negate(diff);
  const ahLines = [...ASIAN_LINES];
  const spread = odds?.spreadLine;
  if (isQuarterMultiple(spread) && Math.abs(spread) <= 6 && !ahLines.some((l) => sameLine(spread, l))) {
    ahLines.push(spread);
    ahLines.sort((a, b) => a - b);
  }
  for (const line of ahLines) {
    const isBook = sameLine(spread, line);
    const rH = settleLine(diff, line);
    const rA = settleLine(negDiff, -line);
    markets.push({
      id: `ah-home-${idLine(line)}`,
      group: 'Hándicap',
      name: `Hándicap asiático ${H} ${formatSignedLine(line)}`,
      line,
      selections: [
        asianSelection(`${H} ${formatSignedLine(line)}`, rH, line, true, isBook ? odds?.spreadHome : undefined),
        asianSelection(`${A} ${formatSignedLine(-line)}`, rA, -line, true, isBook ? odds?.spreadAway : undefined),
      ],
    });
  }
  for (const line of EUROPEAN_LINES) {
    let ph = 0;
    let pd = 0;
    let pa = 0;
    for (let k = 0; k < diff.p.length; k++) {
      const x = diff.min + k + line;
      if (x > 0) ph += diff.p[k];
      else if (x === 0) pd += diff.p[k];
      else pa += diff.p[k];
    }
    markets.push({
      id: `eh-home-${idLine(line)}`,
      group: 'Hándicap',
      name: `Hándicap europeo ${H} ${formatSignedLine(line)}`,
      line,
      selections: [
        sel(`${H} (${formatSignedLine(line)})`, ph),
        sel(`Empate (${formatSignedLine(line)})`, pd),
        sel(`${A} (${formatSignedLine(-line)})`, pa),
      ],
    });
  }
  const dAt = (d: number) => diff.p[d - diff.min] ?? 0;
  let h3 = 0;
  let a3 = 0;
  for (let k = 0; k < diff.p.length; k++) {
    const d = diff.min + k;
    if (d >= 3) h3 += diff.p[k];
    if (d <= -3) a3 += diff.p[k];
  }
  markets.push({
    id: 'margin',
    group: 'Hándicap',
    name: 'Margen de victoria',
    selections: [
      sel(`${H} por 1`, dAt(1)),
      sel(`${H} por 2`, dAt(2)),
      sel(`${H} por 3 o más`, h3),
      sel('Empate', dAt(0)),
      sel(`${A} por 1`, dAt(-1)),
      sel(`${A} por 2`, dAt(-2)),
      sel(`${A} por 3 o más`, a3),
    ],
  });

  // ---- Marcador exacto (top 15 + "Otro")
  const cells: { i: number; j: number; v: number }[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cells.push({ i, j, v: m[i][j] });
  cells.sort((a, b) => b.v - a.v || a.i + a.j - (b.i + b.j) || a.i - b.i);
  const top = cells.slice(0, 15);
  const topSum = top.reduce((s, c) => s + c.v, 0);
  markets.push({
    id: 'cs',
    group: 'Marcador',
    name: 'Marcador exacto',
    selections: [...top.map((c) => sel(`${c.i}-${c.j}`, c.v)), sel('Otro', Math.max(0, 1 - topSum), 'Cualquier otro marcador')],
  });

  // ---- Mitades
  const halves = halvesModel(lh, la, rho);
  const htP = outcomeProbs(halves.ht);
  markets.push({
    id: 'ht-1x2',
    group: 'Mitades',
    name: 'Descanso: resultado (1X2)',
    selections: [sel(H, htP.home, '1'), sel('Empate', htP.draw, 'X'), sel(A, htP.away, '2')],
  });
  const htTotal = totalGoalsDist(halves.ht);
  for (const line of [0.5, 1.5]) {
    markets.push(overUnderMarket(`ht-ou-${line}`, 'Mitades', `Descanso: más/menos ${line} goles`, htTotal, line));
  }
  const names = [H, 'Empate', A];
  const codes = ['1', 'X', '2'];
  const htftSel: MarketSelection[] = [];
  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) htftSel.push(sel(`${names[a]} / ${names[b]}`, halves.htft[a][b], `${codes[a]}/${codes[b]}`));
  }
  markets.push({ id: 'htft', group: 'Mitades', name: 'Descanso / Final', selections: htftSel });
  markets.push(
    overUnderMarket('2h-ou-1.5', 'Mitades', '2ª parte: más/menos 1.5 goles', halves.secondHalfTotal, 1.5),
  );

  return markets;
}

/** Copia de los mercados con probabilidades/cuotas redondeadas (para publicar JSON compacto). */
export function roundMarkets(markets: Market[], probDigits = 4, oddsDigits = 3): Market[] {
  const r = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
  return markets.map((mk) => ({
    ...mk,
    selections: mk.selections.map((s) => {
      const o: MarketSelection = { ...s, prob: r(s.prob, probDigits), fairOdds: r(s.fairOdds, oddsDigits) };
      if (s.marketOdds !== undefined) o.marketOdds = r(s.marketOdds, oddsDigits);
      if (s.ev !== undefined) o.ev = r(s.ev, probDigits);
      return o;
    }),
  }));
}
