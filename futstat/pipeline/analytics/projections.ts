/**
 * Proyecciones de estadísticas contables de un partido (córners, tarjetas, tiros, tiros a puerta, faltas,
 * fueras de juego) con binomial negativa y contracción empírico-bayesiana.
 *
 *   E[local]     = L_local  · rFor(local, casa)  · rAg(visitante, fuera)
 *   E[visitante] = L_visit  · rFor(visit, fuera) · rAg(local, casa)
 *
 * L_lado = media de la competición para ese lado. rFor/rAg = cociente observado/esperado del equipo (a favor y
 * en contra), donde "esperado" es la media del lado en la competición de cada partido; se contrae hacia 1 con
 * PRIOR_N partidos ficticios (y la versión casa/fuera hacia el cociente global del equipo). Los partidos se
 * ponderan por antigüedad (vida media HALF_LIFE_DAYS). El total se obtiene por convolución de las dos NB.
 */
import type { Market, MarketGroup, MarketSelection, Prob1X2, StatProjection } from '../../src/types/data';
import {
  compareDists,
  convolve,
  fairOdds,
  nbPmfArray,
  overUnderFromDist,
  round,
  shrink,
} from '../../src/lib/models';
import type { MatchRecord, TeamMatchStats } from '../types';

export type StatKey = StatProjection['key'];

export interface StatDef {
  key: StatKey;
  label: string;
  group: MarketGroup;
  /** prefijo de ids de mercado */
  idPrefix: string;
  /** líneas de más/menos del total */
  lines: number[];
  /** tamaño de la distribución por equipo / total (cola plegada) */
  maxK: number;
  /** medias por defecto por lado (fútbol europeo) usadas como prior cuando hay pocos datos */
  defaultHome: number;
  defaultAway: number;
  read: (s: TeamMatchStats) => number | undefined;
}

const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined);

export const STAT_DEFS: StatDef[] = [
  {
    key: 'corners',
    label: 'Córners',
    group: 'Córners',
    idPrefix: 'corners',
    lines: [7.5, 8.5, 9.5, 10.5, 11.5, 12.5],
    maxK: 30,
    defaultHome: 5.3,
    defaultAway: 4.4,
    read: (s) => num(s.corners),
  },
  {
    key: 'cards',
    label: 'Tarjetas',
    group: 'Tarjetas',
    idPrefix: 'cards',
    lines: [2.5, 3.5, 4.5, 5.5, 6.5],
    maxK: 16,
    defaultHome: 2.0,
    defaultAway: 2.3,
    read: (s) => {
      const y = num(s.yellow);
      if (y === undefined) return undefined;
      return y + (num(s.red) ?? 0);
    },
  },
  {
    key: 'shots',
    label: 'Tiros',
    group: 'Tiros',
    idPrefix: 'shots',
    lines: [18.5, 20.5, 22.5, 24.5, 26.5, 28.5],
    maxK: 60,
    defaultHome: 13.2,
    defaultAway: 10.8,
    read: (s) => num(s.shots),
  },
  {
    key: 'shotsOnTarget',
    label: 'Tiros a puerta',
    group: 'Tiros',
    idPrefix: 'sot',
    lines: [6.5, 7.5, 8.5, 9.5, 10.5],
    maxK: 30,
    defaultHome: 4.6,
    defaultAway: 3.8,
    read: (s) => num(s.shotsOnTarget),
  },
  {
    key: 'fouls',
    label: 'Faltas',
    group: 'Faltas',
    idPrefix: 'fouls',
    lines: [18.5, 20.5, 22.5, 24.5, 26.5, 28.5],
    maxK: 50,
    defaultHome: 11.6,
    defaultAway: 12.0,
    read: (s) => num(s.fouls),
  },
  {
    key: 'offsides',
    label: 'Fueras de juego',
    group: 'Faltas',
    idPrefix: 'offsides',
    lines: [2.5, 3.5, 4.5, 5.5],
    maxK: 16,
    defaultHome: 1.8,
    defaultAway: 1.7,
    read: (s) => num(s.offsides),
  },
];

export const STAT_DEF_BY_KEY = new Map(STAT_DEFS.map((d) => [d.key, d]));

/** Partidos ficticios de prior para la contracción de las tasas de equipo. */
export const PRIOR_N = 6;
/** Partidos ficticios de prior para la media de la competición (hacia los valores por defecto). */
export const LEAGUE_PRIOR_N = 20;
/** Vida media (días) de la ponderación temporal de los partidos. */
export const HALF_LIFE_DAYS = 150;
/** Partidos mínimos de una competición para usar su propia media como normalizador. */
const MIN_COMP_MATCHES = 30;

/** Acumulador ponderado de observado/esperado. */
interface RateAcc {
  w: number;
  obs: number;
  exp: number;
}

export interface TeamStatProfile {
  forAll: RateAcc;
  forHome: RateAcc;
  forAway: RateAcc;
  agAll: RateAcc;
  agHome: RateAcc;
  agAway: RateAcc;
  /** partidos (sin ponderar) con dato */
  n: number;
}

export interface LeagueStatAvg {
  /** media del equipo local en la competición */
  home: number;
  /** media del equipo visitante */
  away: number;
  /** partidos con dato */
  n: number;
}

export interface StatContext {
  compId: string;
  league: Record<StatKey, LeagueStatAvg>;
  /** dispersión NB por equipo y partido (Infinity = Poisson) */
  dispersion: Record<StatKey, number>;
  teams: Map<string, Partial<Record<StatKey, TeamStatProfile>>>;
  priorN: number;
}

const DAY_MS = 86_400_000;

function emptyAcc(): RateAcc {
  return { w: 0, obs: 0, exp: 0 };
}

function emptyProfile(): TeamStatProfile {
  return { forAll: emptyAcc(), forHome: emptyAcc(), forAway: emptyAcc(), agAll: emptyAcc(), agHome: emptyAcc(), agAway: emptyAcc(), n: 0 };
}

function add(acc: RateAcc, w: number, obs: number, exp: number): void {
  acc.w += w;
  acc.obs += w * obs;
  acc.exp += w * exp;
}

/** Cociente observado/esperado contraído hacia `prior` con priorN partidos. */
function ratio(acc: RateAcc | undefined, prior: number, priorN: number): number {
  if (!acc || !(acc.w > 0) || !(acc.exp > 0)) return prior;
  return shrink(acc.obs / acc.exp, acc.w, prior, priorN);
}

function usable(m: MatchRecord): boolean {
  return m.status === 'finished' && !!m.stats?.home && !!m.stats?.away && !!m.home?.id && !!m.away?.id;
}

/**
 * Contexto de estadísticas para una competición.
 * @param matches temporada actual de la competición + últimos partidos de cada equipo en otras competiciones
 *                (los no terminados o sin estadísticas se ignoran; duplicados por id también).
 */
export function buildStatContext(matches: MatchRecord[], compId: string): StatContext {
  const seen = new Set<string>();
  const ms: MatchRecord[] = [];
  for (const m of matches) {
    if (!m?.id || seen.has(m.id) || !usable(m)) continue;
    seen.add(m.id);
    ms.push(m);
  }
  const latest = ms.reduce((t, m) => Math.max(t, Date.parse(m.date) || 0), 0);
  const weightOf = (m: MatchRecord) => {
    const t = Date.parse(m.date);
    const age = Number.isFinite(t) && latest > 0 ? Math.max(0, (latest - t) / DAY_MS) : 0;
    return Math.pow(0.5, age / HALF_LIFE_DAYS);
  };

  const league = {} as Record<StatKey, LeagueStatAvg>;
  const dispersion = {} as Record<StatKey, number>;
  const teams = new Map<string, Partial<Record<StatKey, TeamStatProfile>>>();

  for (const def of STAT_DEFS) {
    // ---- medias por competición y lado
    const perComp = new Map<string, { h: number; a: number; n: number }>();
    let gh = 0;
    let ga = 0;
    let gn = 0;
    for (const m of ms) {
      const h = def.read(m.stats!.home);
      const a = def.read(m.stats!.away);
      if (h === undefined || a === undefined) continue;
      const e = perComp.get(m.compId) ?? { h: 0, a: 0, n: 0 };
      e.h += h;
      e.a += a;
      e.n++;
      perComp.set(m.compId, e);
      gh += h;
      ga += a;
      gn++;
    }
    const own = perComp.get(compId);
    // media de la competición (si tiene pocos datos, se apoya en todos los partidos y en los valores por defecto)
    let lh: number;
    let la: number;
    let ln: number;
    if (own && own.n >= MIN_COMP_MATCHES) {
      lh = own.h / own.n;
      la = own.a / own.n;
      ln = own.n;
    } else if (gn > 0) {
      lh = gh / gn;
      la = ga / gn;
      ln = gn;
    } else {
      lh = def.defaultHome;
      la = def.defaultAway;
      ln = 0;
    }
    lh = shrink(lh, ln, def.defaultHome, LEAGUE_PRIOR_N);
    la = shrink(la, ln, def.defaultAway, LEAGUE_PRIOR_N);
    league[def.key] = { home: lh, away: la, n: own?.n ?? 0 };

    const normFor = (cId: string): { h: number; a: number } => {
      const e = perComp.get(cId);
      if (cId !== compId && e && e.n >= MIN_COMP_MATCHES) return { h: e.h / e.n, a: e.a / e.n };
      return { h: lh, a: la };
    };

    // ---- perfiles de equipo
    const profileOf = (team: string): TeamStatProfile => {
      let t = teams.get(team);
      if (!t) {
        t = {};
        teams.set(team, t);
      }
      let p = t[def.key];
      if (!p) {
        p = emptyProfile();
        t[def.key] = p;
      }
      return p;
    };
    for (const m of ms) {
      const h = def.read(m.stats!.home);
      const a = def.read(m.stats!.away);
      if (h === undefined || a === undefined) continue;
      const w = weightOf(m);
      const L = normFor(m.compId);
      const ph = profileOf(m.home.id);
      const pa = profileOf(m.away.id);
      add(ph.forAll, w, h, L.h);
      add(ph.forHome, w, h, L.h);
      add(ph.agAll, w, a, L.a);
      add(ph.agHome, w, a, L.a);
      ph.n++;
      add(pa.forAll, w, a, L.a);
      add(pa.forAway, w, a, L.a);
      add(pa.agAll, w, h, L.h);
      add(pa.agAway, w, h, L.h);
      pa.n++;
    }
    dispersion[def.key] = Infinity;
  }

  const ctx: StatContext = { compId, league, dispersion, teams, priorN: PRIOR_N };

  // ---- dispersión NB por método de momentos sobre los residuos del modelo (partidos de la competición o todos)
  for (const def of STAT_DEFS) {
    const own = ms.filter((m) => m.compId === compId);
    const pool = own.length >= MIN_COMP_MATCHES ? own : ms;
    let smu2 = 0;
    let sex = 0;
    let n = 0;
    for (const m of pool) {
      const h = def.read(m.stats!.home);
      const a = def.read(m.stats!.away);
      if (h === undefined || a === undefined) continue;
      const e = expectedPair(ctx, def.key, m.home.id, m.away.id);
      for (const [x, mu] of [
        [h, e.home],
        [a, e.away],
      ] as const) {
        smu2 += mu * mu;
        sex += (x - mu) * (x - mu) - mu;
        n++;
      }
    }
    if (n >= 20 && sex > 0 && smu2 > 0) {
      const r = smu2 / sex;
      dispersion[def.key] = r > 500 ? Infinity : Math.max(1.5, r);
    } else {
      dispersion[def.key] = Infinity;
    }
  }
  return ctx;
}

/** Valor esperado de la estadística para cada equipo. */
export function expectedPair(ctx: StatContext, key: StatKey, homeId: string, awayId: string): { home: number; away: number } {
  const L = ctx.league[key];
  const pn = ctx.priorN;
  const ph = ctx.teams.get(homeId)?.[key];
  const pa = ctx.teams.get(awayId)?.[key];
  const forH = ratio(ph?.forHome, ratio(ph?.forAll, 1, pn), pn);
  const agH = ratio(ph?.agHome, ratio(ph?.agAll, 1, pn), pn);
  const forA = ratio(pa?.forAway, ratio(pa?.forAll, 1, pn), pn);
  const agA = ratio(pa?.agAway, ratio(pa?.agAll, 1, pn), pn);
  return { home: L.home * forH * agA, away: L.away * forA * agH };
}

/** Recorta la distribución donde la cola acumulada es despreciable (la masa restante se pliega en el último índice). */
function trimDist(dist: number[], eps = 1e-4): number[] {
  let acc = 0;
  let cut = dist.length - 1;
  for (let k = 0; k < dist.length; k++) {
    acc += dist[k];
    if (1 - acc < eps) {
      cut = k;
      break;
    }
  }
  const out = dist.slice(0, cut + 1);
  let rest = 0;
  for (let k = cut + 1; k < dist.length; k++) rest += dist[k];
  out[cut] += rest;
  return out;
}

/** Proyecciones de todas las estadísticas con datos para un partido. Equipos sin datos ⇒ media de la competición. */
export function projectMatchStats(homeId: string, awayId: string, statCtx: StatContext): StatProjection[] {
  const out: StatProjection[] = [];
  for (const def of STAT_DEFS) {
    const L = statCtx.league[def.key];
    if (!L) continue;
    const hasTeamData = (statCtx.teams.get(homeId)?.[def.key]?.n ?? 0) + (statCtx.teams.get(awayId)?.[def.key]?.n ?? 0) > 0;
    if (L.n === 0 && !hasTeamData) continue; // sin ningún dato de esta estadística
    const e = expectedPair(statCtx, def.key, homeId, awayId);
    const r = statCtx.dispersion[def.key];
    const hd = nbPmfArray(e.home, r, def.maxK);
    const ad = nbPmfArray(e.away, r, def.maxK);
    const total = convolve(hd, ad, def.maxK * 2);
    const most = compareDists(hd, ad);
    out.push({
      key: def.key,
      label: def.label,
      home: round(e.home, 2),
      away: round(e.away, 2),
      total: round(e.home + e.away, 2),
      totalDist: trimDist(total).map((p) => round(p, 5)),
      lines: def.lines.map((line) => {
        const ou = overUnderFromDist(total, line);
        return { line, over: round(ou.over, 4), under: round(ou.under, 4) };
      }),
      most: { home: round(most.home, 4), draw: round(most.draw, 4), away: round(most.away, 4) },
      leagueAvg: round(L.home + L.away, 2),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mercados de estadísticas
// ---------------------------------------------------------------------------

function idLine(line: number): string {
  return String(Math.abs(line) < 1e-9 ? 0 : line);
}

function signed(line: number): string {
  return line > 0 ? `+${line}` : `${line}`;
}

function sel(label: string, prob: number, note?: string): MarketSelection {
  const p = Math.min(1, Math.max(0, prob));
  const s: MarketSelection = { label, prob: round(p, 4), fairOdds: round(fairOdds(p), 3) };
  if (note) s.note = note;
  return s;
}

/**
 * Recupera la dispersión NB de una proyección publicada a partir de la varianza de su distribución total:
 *   Var(total) = μh + μh²/r + μa + μa²/r  ⇒  r = (μh² + μa²) / (Var − μh − μa)
 */
export function dispersionFromProjection(p: StatProjection): number {
  const d = p.totalDist;
  let s = 0;
  let m1 = 0;
  let m2 = 0;
  for (let k = 0; k < d.length; k++) {
    s += d[k];
    m1 += k * d[k];
    m2 += k * k * d[k];
  }
  if (!(s > 0)) return Infinity;
  m1 /= s;
  m2 /= s;
  const v = m2 - m1 * m1;
  const excess = v - p.home - p.away;
  const num2 = p.home * p.home + p.away * p.away;
  if (!(excess > 1e-6) || !(num2 > 0)) return Infinity;
  const r = num2 / excess;
  return r > 500 ? Infinity : Math.max(1, r);
}

/** Líneas por equipo alrededor de su media: ⌊μ⌋−0.5, ⌊μ⌋+0.5, ⌊μ⌋+1.5 (>= 0.5). */
function teamLines(mu: number): number[] {
  const c = Math.floor(mu) + 0.5;
  return [c - 1, c, c + 1].filter((l) => l >= 0.5);
}

function ouMarket(id: string, group: MarketGroup, name: string, dist: number[], line: number): Market {
  const ou = overUnderFromDist(dist, line);
  return {
    id,
    group,
    name,
    line,
    selections: [sel(`Más de ${line}`, ou.over), sel(`Menos de ${line}`, ou.under)],
  };
}

/** P(local − visitante > line) para distribuciones independientes. */
function diffAbove(hd: number[], ad: number[], line: number): number {
  let p = 0;
  for (let i = 0; i < hd.length; i++) {
    if (hd[i] === 0) continue;
    for (let j = 0; j < ad.length; j++) if (i - j > line) p += hd[i] * ad[j];
  }
  return p;
}

/**
 * Mercados de estadísticas a partir de las proyecciones: más/menos del total, más/menos por equipo, quién tiene más
 * (1X2) y, en córners, hándicap −1.5/+1.5. Grupos 'Córners', 'Tarjetas', 'Tiros', 'Faltas'.
 */
export function statMarkets(projections: StatProjection[], homeName: string, awayName: string): Market[] {
  const H = homeName?.trim() || 'Local';
  const A = awayName?.trim() || 'Visitante';
  const out: Market[] = [];
  for (const p of projections) {
    const def = STAT_DEF_BY_KEY.get(p.key);
    if (!def) continue;
    const r = dispersionFromProjection(p);
    const hd = nbPmfArray(p.home, r, def.maxK);
    const ad = nbPmfArray(p.away, r, def.maxK);
    const total = p.totalDist.length ? p.totalDist : convolve(hd, ad, def.maxK * 2);
    const label = def.label;
    const lower = label.toLowerCase();
    // total
    for (const line of p.lines.length ? p.lines.map((l) => l.line) : def.lines) {
      out.push(ouMarket(`${def.idPrefix}-ou-${idLine(line)}`, def.group, `${label}: más/menos ${line}`, total, line));
    }
    // por equipo
    for (const [side, name, dist, mu] of [
      ['home', H, hd, p.home],
      ['away', A, ad, p.away],
    ] as const) {
      for (const line of teamLines(mu)) {
        out.push(ouMarket(`${def.idPrefix}-${side}-ou-${idLine(line)}`, def.group, `${label} de ${name}: más/menos ${line}`, dist, line));
      }
    }
    // quién tiene más
    const most: Prob1X2 = p.most ?? compareDists(hd, ad);
    out.push({
      id: `${def.idPrefix}-most`,
      group: def.group,
      name: `Más ${lower} (1X2)`,
      selections: [sel(H, most.home, '1'), sel('Igual', most.draw, 'X'), sel(A, most.away, '2')],
    });
    // hándicap de córners
    if (p.key === 'corners') {
      for (const line of [-1.5, 1.5]) {
        // local con hándicap `line` gana si (h − a) + line > 0  ⇔  h − a > −line
        const pHome = diffAbove(hd, ad, -line);
        out.push({
          id: `${def.idPrefix}-ah-home-${idLine(line)}`,
          group: def.group,
          name: `Hándicap de córners ${H} ${signed(line)}`,
          line,
          selections: [sel(`${H} ${signed(line)}`, pHome), sel(`${A} ${signed(-line)}`, 1 - pHome)],
        });
      }
    }
  }
  return out;
}
