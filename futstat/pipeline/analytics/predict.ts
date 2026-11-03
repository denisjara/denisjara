/**
 * Predicción de un partido: ensamble de Dixon-Coles (o Elo→goles), Elo y mercado sin margen.
 *
 *  1. λ por Dixon-Coles de la liga del partido (o de la liga doméstica común de ambos equipos).
 *  2. Probabilidades Elo (eloProbs con drawParams calibrados).
 *  3. Mercado sin margen (Shin) si hay cuotas 1X2 completas.
 *  4. Ensamble lineal con pesos MODEL (renormalizados si falta una fuente). Sin DC, la parte de goles
 *     usa el modelo Elo→goles con peso reducido (ELO_GOAL_WEIGHT_FACTOR).
 *  5. λ finales con fitLambdas hacia el objetivo ensamblado (1X2 + P(más de 2.5) mezcla DC/mercado; si la casa
 *     ofrece otra línea x.5 se traduce a P(más de 2.5) con un total Poisson equivalente).
 *  6. Matriz final con rho (DC o −0.05), mercados de goles, mercados de estadísticas, apuestas de valor.
 *
 * Decisiones calibradas con un backtest walk-forward sobre datos reales (mar–oct 2026, cuotas de cierre):
 *  - Elo→goles con peso 0.2·wDixonColes: con más peso empeoraba el RPS en cruces entre ligas (0.183 → 0.181).
 *  - Apuestas de valor solo con modelo Dixon-Coles y EV <= MAX_EV: los picks de cruces entre ligas perdían ~35%
 *    y los de EV > 20% ~28% frente a cuotas de cierre; con estas reglas el ROI ≈ −5% (≈ margen de la casa).
 */
import type {
  Market,
  MarketSelection,
  ModelBreakdown,
  OddsSnapshot,
  Prob1X2,
  QuickPrediction,
  StatProjection,
  ValuePick,
} from '../../src/types/data';
import {
  blend,
  bttsProb,
  buildGoalMarkets,
  devigDetailed,
  eloProbs,
  fairOdds,
  fitLambdas,
  mostLikelyScore,
  outcomeProbs,
  predictDC,
  round,
  roundMarkets,
  scoreMatrix,
  totalGoalsDist,
  type DCModel,
  type Elo,
} from '../../src/lib/models';
import { COMPETITION_BY_ID, MODEL, type CompetitionConfig } from '../config';
import type { MatchRecord } from '../types';
import {
  eloGoalBaseTotal,
  eloGoalModel,
  expectedTotalGoals,
  initialElo,
  type EloDrawParams,
  type EloGoalCoeffs,
  type ModelSuite,
} from './ratings';
import { statMarkets } from './projections';
import { findValueBets } from './value';

/** rho por defecto cuando no hay modelo Dixon-Coles. */
export const DEFAULT_RHO = -0.05;
/** Factor de peso de la parte "goles" cuando se usa Elo→goles en lugar de Dixon-Coles. */
export const ELO_GOAL_WEIGHT_FACTOR = 0.2;
/** Tamaño de la matriz interna (0..10). */
const FULL_GOALS = 10;
/** Divergencia Jensen-Shannon (nats) a partir de la cual el acuerdo entre fuentes se considera nulo (≈ percentil 98 real). */
const JS_REF = 0.04;

export interface PredictContext {
  elo: Elo;
  drawParams: EloDrawParams;
  dcModels: Map<string, DCModel>;
  homeLeague: Map<string, string>;
  eloGoal: EloGoalCoeffs;
  leagueAvgGoals: Map<string, number>;
  comp: CompetitionConfig;
  /** ratings Elo pre-partido (de buildElo): si el partido está aquí se usan en lugar de los actuales (sin fuga de información) */
  preMatch?: Map<string, { home: number; away: number }>;
  /** configuraciones por id (tiers para equipos nuevos y nombres de ligas). Default: COMPETITION_BY_ID */
  configs?: Map<string, CompetitionConfig>;
}

export interface PredictOptions {
  /** proyecciones de estadísticas del partido (añaden mercados de córners, tarjetas, tiros, faltas y expCorners/expCards) */
  projections?: StatProjection[];
}

export interface PredictionResult {
  quick: QuickPrediction;
  model: ModelBreakdown;
  markets: Market[];
  valueBets: ValuePick[];
  lambdaHome: number;
  lambdaAway: number;
  /** matriz completa 0..10 (sin redondear) */
  matrix: number[][];
}

export interface ProbsOnlyResult {
  p: Prob1X2;
  over25: number;
  btts: number;
  lambdaHome: number;
  lambdaAway: number;
  sources: { elo: Prob1X2; dc?: Prob1X2; eloGoals?: Prob1X2; market?: Prob1X2; marketOver25?: number };
}

/** Contexto de predicción para una competición a partir de un ModelSuite. */
export function contextFor(suite: ModelSuite, comp: CompetitionConfig, configs?: Map<string, CompetitionConfig>): PredictContext {
  return {
    elo: suite.eloBuild.elo,
    drawParams: suite.eloBuild.drawParams,
    dcModels: suite.dcModels,
    homeLeague: suite.eloBuild.homeLeague,
    eloGoal: suite.eloGoal,
    leagueAvgGoals: suite.leagueAvgGoals,
    comp,
    preMatch: suite.eloBuild.preMatch,
    configs,
  };
}

// ---------------------------------------------------------------------------
// Núcleo
// ---------------------------------------------------------------------------

interface GoalSource {
  kind: 'dc' | 'elo-goals';
  lambdaHome: number;
  lambdaAway: number;
  rho: number;
  probs: Prob1X2;
  over25: number;
  /** liga del modelo DC usado */
  compId?: string;
  model?: DCModel;
}

interface Core {
  homeId: string;
  awayId: string;
  neutral: boolean;
  eloHome: number;
  eloAway: number;
  diff: number;
  eloP: Prob1X2;
  goal: GoalSource;
  market?: { probs: Prob1X2; margin: number; method: string; over25?: number };
  weights: { dixonColes: number; elo: number; market: number };
  ensemble: Prob1X2;
  over25Target: number;
  rho: number;
  lambdaHome: number;
  lambdaAway: number;
  matrix: number[][];
}

function validOdds(o: number | undefined): o is number {
  return typeof o === 'number' && Number.isFinite(o) && o > 1;
}

function over25Of(matrix: number[][]): number {
  const t = totalGoalsDist(matrix);
  let s = 0;
  for (let k = 3; k < t.length; k++) s += t[k];
  return s;
}

function configsOf(ctx: PredictContext): Map<string, CompetitionConfig> {
  return ctx.configs ?? COMPETITION_BY_ID;
}

/** Rating de un equipo: pre-partido si existe, actual si el equipo es conocido, inicial por tier si es nuevo. */
function ratingsFor(match: MatchRecord, ctx: PredictContext): { home: number; away: number } {
  const pre = ctx.preMatch?.get(match.id);
  if (pre) return pre;
  const cfgs = configsOf(ctx);
  const r = (team: string) => {
    if (ctx.elo.has(team)) return ctx.elo.get(team);
    // equipo nunca visto en una liga con historial ⇒ ascendido
    const lg = ctx.homeLeague.get(team);
    const promoted = ctx.comp.kind === 'league' && lg === ctx.comp.id && ctx.dcModels.has(lg);
    return initialElo(team, ctx.homeLeague, cfgs, ctx.comp, promoted);
  };
  return { home: r(match.home.id), away: r(match.away.id) };
}

/** Modelo DC aplicable: el de la competición (si es liga) o el de la liga doméstica común. */
function pickDcModel(match: MatchRecord, ctx: PredictContext): { compId: string; model: DCModel } | undefined {
  const h = match.home.id;
  const a = match.away.id;
  const ok = (m: DCModel | undefined) => !!m && m.attack[h] !== undefined && m.attack[a] !== undefined;
  const own = ctx.dcModels.get(ctx.comp.id);
  if (ctx.comp.kind === 'league' && ok(own)) return { compId: ctx.comp.id, model: own! };
  const lh = ctx.homeLeague.get(h);
  const la = ctx.homeLeague.get(a);
  if (lh && lh === la) {
    const m = ctx.dcModels.get(lh);
    if (ok(m)) return { compId: lh, model: m! };
  }
  if (ok(own)) return { compId: ctx.comp.id, model: own! };
  return undefined;
}

function goalSource(match: MatchRecord, ctx: PredictContext, diff: number, neutral: boolean): GoalSource {
  const dc = pickDcModel(match, ctx);
  if (dc) {
    const l = predictDC(dc.model, match.home.id, match.away.id, neutral);
    if (l && Number.isFinite(l.lambdaHome) && Number.isFinite(l.lambdaAway)) {
      const rho = Number.isFinite(dc.model.rho) ? dc.model.rho : DEFAULT_RHO;
      const m = scoreMatrix(l.lambdaHome, l.lambdaAway, rho, FULL_GOALS);
      return { kind: 'dc', lambdaHome: l.lambdaHome, lambdaAway: l.lambdaAway, rho, probs: outcomeProbs(m), over25: over25Of(m), compId: dc.compId, model: dc.model };
    }
  }
  // Elo→goles: total de referencia de las ligas domésticas × estilo (apertura) de cada equipo × factor de la competición
  const total = eloGoalBaseTotal(match.home.id, match.away.id, ctx.comp.id, ctx.homeLeague, ctx.leagueAvgGoals, ctx.eloGoal, ctx.dcModels);
  const l = eloGoalModel(diff, total, ctx.eloGoal);
  const m = scoreMatrix(l.lambdaHome, l.lambdaAway, DEFAULT_RHO, FULL_GOALS);
  return { kind: 'elo-goals', lambdaHome: l.lambdaHome, lambdaAway: l.lambdaAway, rho: DEFAULT_RHO, probs: outcomeProbs(m), over25: over25Of(m) };
}

function marketFrom(odds: OddsSnapshot | undefined): Core['market'] {
  if (!odds || !validOdds(odds.home) || !validOdds(odds.draw) || !validOdds(odds.away)) return undefined;
  const d = devigDetailed([odds.home, odds.draw, odds.away], 'shin');
  if (!d.probs.every((p) => p > 0 && Number.isFinite(p))) return undefined;
  const out: NonNullable<Core['market']> = {
    probs: { home: d.probs[0], draw: d.probs[1], away: d.probs[2] },
    margin: d.margin,
    method: d.method,
  };
  const line = odds.totalLine;
  if (line !== undefined && isHalfLine(line) && line > 0 && line < 8 && validOdds(odds.over) && validOdds(odds.under)) {
    const ou = devigDetailed([odds.over, odds.under], 'shin');
    const pOver = ou.probs[0];
    if (pOver > 0 && pOver < 1) out.over25 = Math.abs(line - 2.5) < 1e-9 ? pOver : over25FromLine(line, pOver);
  }
  return out;
}

function isHalfLine(x: number): boolean {
  return Number.isFinite(x) && Math.abs(x * 2 - Math.round(x * 2)) < 1e-9 && Math.abs(x - Math.round(x)) > 1e-9;
}

/** P(total >= k) con total ~ Poisson(t). */
function poissonTail(k: number, t: number): number {
  let p = Math.exp(-t);
  let cdf = 0;
  for (let i = 0; i < k; i++) {
    cdf += p;
    p *= t / (i + 1);
  }
  return Math.max(0, 1 - cdf);
}

/**
 * Traduce P(más de `line`) del mercado a P(más de 2.5): busca el total Poisson t con P(T > line) = pOver
 * (bisección) y devuelve P(T >= 3).
 */
export function over25FromLine(line: number, pOver: number): number {
  const k = Math.floor(line) + 1;
  let lo = 0.05;
  let hi = 12;
  for (let it = 0; it < 80; it++) {
    const mid = 0.5 * (lo + hi);
    if (poissonTail(k, mid) < pOver) lo = mid;
    else hi = mid;
  }
  return poissonTail(3, 0.5 * (lo + hi));
}

function core(match: MatchRecord, ctx: PredictContext): Core {
  const homeId = match.home.id;
  const awayId = match.away.id;
  const neutral = !!match.neutral;
  const r = ratingsFor(match, ctx);
  const diff = r.home + (neutral ? 0 : MODEL.eloHomeAdv) - r.away;
  const eloP = eloProbs(diff, ctx.drawParams);
  const goal = goalSource(match, ctx, diff, neutral);
  const market = marketFrom(match.odds);

  const wGoal = goal.kind === 'dc' ? MODEL.wDixonColes : MODEL.wDixonColes * ELO_GOAL_WEIGHT_FACTOR;
  const wElo = MODEL.wElo;
  const wMkt = market ? MODEL.wMarket : 0;
  const sw = wGoal + wElo + wMkt;
  const ensemble = blend([
    { probs: goal.probs, weight: wGoal },
    { probs: eloP, weight: wElo },
    ...(market ? [{ probs: market.probs, weight: wMkt }] : []),
  ]);
  // pesos publicados: con Elo→goles, la parte de goles se reporta dentro de Elo (ambas derivan del rating)
  const weights =
    goal.kind === 'dc'
      ? { dixonColes: wGoal / sw, elo: wElo / sw, market: wMkt / sw }
      : { dixonColes: 0, elo: (wGoal + wElo) / sw, market: wMkt / sw };

  // objetivo de Más de 2.5: mezcla modelo de goles / mercado
  const over25Target =
    market?.over25 !== undefined ? (wGoal * goal.over25 + MODEL.wMarket * market.over25) / (wGoal + MODEL.wMarket) : goal.over25;

  const rho = goal.rho;
  const fitted = fitLambdas({ ...ensemble, over25: over25Target }, rho, { lambdaHome: goal.lambdaHome, lambdaAway: goal.lambdaAway });
  const matrix = scoreMatrix(fitted.lambdaHome, fitted.lambdaAway, rho, FULL_GOALS);
  return {
    homeId,
    awayId,
    neutral,
    eloHome: r.home,
    eloAway: r.away,
    diff,
    eloP,
    goal,
    market,
    weights,
    ensemble,
    over25Target,
    rho,
    lambdaHome: fitted.lambdaHome,
    lambdaAway: fitted.lambdaAway,
    matrix,
  };
}

// ---------------------------------------------------------------------------
// Confianza
// ---------------------------------------------------------------------------

function entropy(p: Prob1X2): number {
  let h = 0;
  for (const x of [p.home, p.draw, p.away]) if (x > 0) h -= x * Math.log(x);
  return h;
}

/** Divergencia Jensen-Shannon generalizada (nats) de varias distribuciones 1X2 ponderadas. */
export function jsDivergence(sources: { probs: Prob1X2; weight: number }[]): number {
  const valid = sources.filter((s) => s.weight > 0);
  if (valid.length < 2) return 0;
  const mix = blend(valid);
  const sw = valid.reduce((t, s) => t + s.weight, 0);
  let h = 0;
  for (const s of valid) h += (s.weight / sw) * entropy(s.probs);
  return Math.max(0, entropy(mix) - h);
}

function confidenceOf(c: Core, ctx: PredictContext, match: MatchRecord): { value: number; agreement: number; volume: number } {
  const srcs: { probs: Prob1X2; weight: number }[] = [
    { probs: c.goal.probs, weight: 1 },
    { probs: c.eloP, weight: 1 },
  ];
  if (c.market) srcs.push({ probs: c.market.probs, weight: 1 });
  const agreement = 1 - Math.min(1, jsDivergence(srcs) / JS_REF);
  const t = Date.parse(match.date);
  const eloGames = (team: string) => ctx.elo.history(team).filter((e) => !(Date.parse(e.date) >= t)).length;
  const volElo = Math.min(1, Math.min(eloGames(c.homeId), eloGames(c.awayId)) / 30);
  let volume: number;
  if (c.goal.kind === 'dc' && c.goal.model) {
    const mb = c.goal.model.matchesByTeam;
    const volDc = Math.min(1, Math.min(mb[c.homeId] ?? 0, mb[c.awayId] ?? 0) / 30);
    volume = 0.6 * volDc + 0.4 * volElo;
  } else {
    volume = 0.75 * volElo;
  }
  // sin mercado hay una fuente independiente menos (y el acuerdo DC/Elo es más fácil): se descuenta un 10%
  const value = Math.min(1, Math.max(0, (0.55 * agreement + 0.45 * volume) * (c.market ? 1 : 0.9)));
  return { value, agreement, volume };
}

// ---------------------------------------------------------------------------
// Explicación
// ---------------------------------------------------------------------------

const pct = (p: number) => `${Math.round(p * 100)}%`;
const pct1 = (p: number) => `${(p * 100).toFixed(1)}%`;
const fmtSigned = (x: number, d = 0) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`;
const p1x2 = (p: Prob1X2) => `1 ${pct(p.home)} · X ${pct(p.draw)} · 2 ${pct(p.away)}`;

function formPoints(form: string | undefined): { str: string; pts: number; n: number } | undefined {
  if (!form) return undefined;
  const s = form.toUpperCase().replace(/[^WDL]/g, '').slice(-5);
  if (!s) return undefined;
  let pts = 0;
  for (const ch of s) pts += ch === 'W' ? 3 : ch === 'D' ? 1 : 0;
  const es = s.replace(/W/g, 'V').replace(/D/g, 'E').replace(/L/g, 'D');
  return { str: es, pts, n: s.length };
}

/** Variación del Elo en los últimos n partidos (anteriores a `before`). */
function eloTrend(ctx: PredictContext, team: string, before: string, n = 5): { delta: number; games: number } | undefined {
  const t = Date.parse(before);
  const h = ctx.elo.history(team).filter((e) => !(Date.parse(e.date) >= t));
  if (h.length < 2) return undefined;
  const k = Math.min(n, h.length - 1);
  return { delta: h[h.length - 1].elo - h[h.length - 1 - k].elo, games: k };
}

function strengthPhrase(team: string, model: DCModel): string | undefined {
  const at = model.attack[team];
  const de = model.defence[team];
  if (at === undefined || de === undefined) return undefined;
  const a = (at - 1) * 100;
  const d = (de - 1) * 100;
  const atk = Math.abs(a) < 3 ? 'ataque en la media' : `ataque ${Math.abs(a).toFixed(0)}% ${a > 0 ? 'por encima' : 'por debajo'} de la media`;
  const dfn = Math.abs(d) < 3 ? 'defensa en la media' : `encaja un ${Math.abs(d).toFixed(0)}% ${d > 0 ? 'más' : 'menos'} que la media`;
  return `${atk}, ${dfn}`;
}

function buildExplanation(match: MatchRecord, ctx: PredictContext, c: Core, projections: StatProjection[] | undefined): string[] {
  const H = match.home.short || match.home.name;
  const A = match.away.short || match.away.name;
  const cfgs = configsOf(ctx);
  const out: string[] = [];

  // 1. Elo
  const raw = c.eloHome - c.eloAway;
  out.push(
    `Elo: ${H} ${Math.round(c.eloHome)} vs ${A} ${Math.round(c.eloAway)} (${fmtSigned(raw)} para el local` +
      `${c.neutral ? ', campo neutral' : `, ${fmtSigned(c.diff)} con el factor campo`}) → ${p1x2(c.eloP)}.`,
  );

  // 2. Ataque/defensa vs media de liga
  if (c.goal.kind === 'dc' && c.goal.model) {
    const lgName = cfgs.get(c.goal.compId ?? '')?.shortName ?? 'la liga';
    const ph = strengthPhrase(c.homeId, c.goal.model);
    const pa = strengthPhrase(c.awayId, c.goal.model);
    if (ph && pa) out.push(`Dixon-Coles (${lgName}): ${H} ${ph}; ${A} ${pa}.`);
  } else {
    const parts: string[] = [];
    for (const [team, name] of [
      [c.homeId, H],
      [c.awayId, A],
    ] as const) {
      const lg = ctx.homeLeague.get(team);
      const m = lg ? ctx.dcModels.get(lg) : undefined;
      const ph = m ? strengthPhrase(team, m) : undefined;
      if (ph) parts.push(`${name} en ${cfgs.get(lg!)?.shortName ?? lg}: ${ph}`);
    }
    out.push(
      `Equipos de ligas distintas: los goles esperados salen del modelo Elo→goles (${ctx.eloGoal.a.toFixed(2)} goles de diferencia por cada 100 puntos Elo)` +
        (parts.length ? `. ${parts.join('; ')}.` : '.'),
    );
  }

  // 3. Forma reciente
  const fh = formPoints(match.homeForm);
  const fa = formPoints(match.awayForm);
  const th = eloTrend(ctx, c.homeId, match.date);
  const ta = eloTrend(ctx, c.awayId, match.date);
  const formPart = (name: string, f: ReturnType<typeof formPoints>, tr: ReturnType<typeof eloTrend>) => {
    const bits: string[] = [];
    if (f) bits.push(`${f.str} (${f.pts} de ${f.n * 3} pts)`);
    if (tr) bits.push(`Elo ${fmtSigned(tr.delta)} en sus últimos ${tr.games} partidos`);
    return bits.length ? `${name} ${bits.join(', ')}` : undefined;
  };
  const fParts = [formPart(H, fh, th), formPart(A, fa, ta)].filter((x): x is string => !!x);
  if (fParts.length) out.push(`Forma reciente: ${fParts.join('; ')}.`);

  // 4. Mercado vs modelo
  if (c.market) {
    const keys: (keyof Prob1X2)[] = ['home', 'draw', 'away'];
    const names: Record<keyof Prob1X2, string> = { home: `victoria de ${H}`, draw: 'el empate', away: `victoria de ${A}` };
    let k: keyof Prob1X2 = 'home';
    for (const key of keys) if (Math.abs(c.ensemble[key] - c.market.probs[key]) > Math.abs(c.ensemble[k] - c.market.probs[k])) k = key;
    const d = (c.ensemble[k] - c.market.probs[k]) * 100;
    const provider = match.odds?.provider ? ` (${match.odds.provider}, margen ${pct1(c.market.margin)})` : ` (margen ${pct1(c.market.margin)})`;
    out.push(
      `Mercado sin margen${provider}: ${p1x2(c.market.probs)}. ` +
        (Math.abs(d) < 2
          ? 'Modelo y mercado coinciden (diferencias menores de 2 pp).'
          : `El modelo ve ${d > 0 ? 'más' : 'menos'} probable ${names[k]} (${pct(c.ensemble[k])} vs ${pct(c.market.probs[k])}, ${fmtSigned(d, 1)} pp).`),
    );
  } else {
    out.push('Sin cuotas disponibles: la predicción es 100% estadística (Dixon-Coles/Elo), sin señal del mercado.');
  }

  // 5. Factor campo
  if (c.neutral) {
    out.push('Campo neutral: no se aplica ventaja local.');
  } else {
    const withAdv = eloProbs(c.diff, ctx.drawParams).home;
    const without = eloProbs(c.diff - MODEL.eloHomeAdv, ctx.drawParams).home;
    let txt = `Factor campo: +${MODEL.eloHomeAdv} puntos Elo para ${H} (≈ ${fmtSigned((withAdv - without) * 100, 1)} pp de probabilidad de victoria)`;
    if (c.goal.kind === 'dc' && c.goal.model && c.goal.model.homeAdv > 0) {
      txt += `; en esta liga el local marca un ${Math.round((c.goal.model.homeAdv - 1) * 100)}% más`;
    }
    out.push(`${txt}.`);
  }

  // 6. Tendencia de goles
  const lgAvg =
    (c.goal.compId ? ctx.leagueAvgGoals.get(c.goal.compId) : undefined) ??
    ctx.leagueAvgGoals.get(ctx.comp.id) ??
    expectedTotalGoals(c.homeId, c.awayId, ctx.comp.id, ctx.homeLeague, ctx.leagueAvgGoals, ctx.eloGoal.globalAvgGoals);
  const tot = c.lambdaHome + c.lambdaAway;
  out.push(
    `Goles esperados ${c.lambdaHome.toFixed(2)} – ${c.lambdaAway.toFixed(2)} (total ${tot.toFixed(2)} vs media de ${lgAvg.toFixed(2)}): ` +
      `más de 2.5 ${pct(over25Of(c.matrix))}, ambos marcan ${pct(bttsProb(c.matrix))}.`,
  );

  // 7. Estadísticas proyectadas
  if (projections?.length) {
    const corners = projections.find((p) => p.key === 'corners');
    const cards = projections.find((p) => p.key === 'cards');
    const bits: string[] = [];
    if (corners) bits.push(`${corners.total.toFixed(1)} córners${corners.leagueAvg !== undefined ? ` (media ${corners.leagueAvg.toFixed(1)})` : ''}`);
    if (cards) bits.push(`${cards.total.toFixed(1)} tarjetas${cards.leagueAvg !== undefined ? ` (media ${cards.leagueAvg.toFixed(1)})` : ''}`);
    if (bits.length) out.push(`Estadísticas proyectadas: ${bits.join(' y ')}.`);
  }
  return out.slice(0, 7);
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

function roundProbs(p: Prob1X2, d = 4): Prob1X2 {
  return { home: round(p.home, d), draw: round(p.draw, d), away: round(p.away, d) };
}

function withProb(s: MarketSelection, prob: number): MarketSelection {
  const p = Math.min(1, Math.max(0, prob));
  const o: MarketSelection = { ...s, prob: p, fairOdds: fairOdds(p) };
  if (o.marketOdds !== undefined) o.ev = p * o.marketOdds - 1;
  return o;
}

/** Alinea 1X2, doble oportunidad y empate no apuesta con las probabilidades del ensamble. */
function alignMainMarkets(markets: Market[], p: Prob1X2): Market[] {
  return markets.map((m) => {
    if (m.id === '1x2' && m.selections.length === 3) {
      return { ...m, selections: [withProb(m.selections[0], p.home), withProb(m.selections[1], p.draw), withProb(m.selections[2], p.away)] };
    }
    if (m.id === 'dc' && m.selections.length === 3) {
      return {
        ...m,
        selections: [withProb(m.selections[0], p.home + p.draw), withProb(m.selections[1], p.home + p.away), withProb(m.selections[2], p.draw + p.away)],
      };
    }
    if (m.id === 'dnb' && m.selections.length === 2) {
      const nd = p.home + p.away;
      return { ...m, selections: [withProb(m.selections[0], nd > 0 ? p.home / nd : 0.5), withProb(m.selections[1], nd > 0 ? p.away / nd : 0.5)] };
    }
    return m;
  });
}

/** Predicción completa de un partido (quick, desglose del modelo, mercados, apuestas de valor). */
export function predictMatch(match: MatchRecord, ctx: PredictContext, opts: PredictOptions = {}): PredictionResult {
  const c = core(match, ctx);
  const conf = confidenceOf(c, ctx, match);
  const projections = opts.projections ?? [];

  let markets = buildGoalMarkets({
    lambdaHome: c.lambdaHome,
    lambdaAway: c.lambdaAway,
    rho: c.rho,
    homeName: match.home.name,
    awayName: match.away.name,
    odds: match.odds,
  });
  markets = alignMainMarkets(markets, c.ensemble);
  if (projections.length) markets = markets.concat(statMarkets(projections, match.home.name, match.away.name));
  // apuestas de valor solo con modelo Dixon-Coles (en cruces entre ligas el mercado es mucho más preciso)
  const valueBets = match.odds && c.goal.kind === 'dc' ? findValueBets(markets, conf.value) : [];

  const ml = mostLikelyScore(c.matrix);
  const over25 = over25Of(c.matrix);
  const btts = bttsProb(c.matrix);
  const corners = projections.find((p) => p.key === 'corners');
  const cards = projections.find((p) => p.key === 'cards');
  const quick: QuickPrediction = {
    p: roundProbs(c.ensemble),
    xgHome: round(c.lambdaHome, 3),
    xgAway: round(c.lambdaAway, 3),
    over25: round(over25, 4),
    btts: round(btts, 4),
    likelyScore: `${ml.home}-${ml.away}`,
    likelyScoreProb: round(ml.prob, 4),
    confidence: round(conf.value, 3),
  };
  if (corners) quick.expCorners = round(corners.total, 2);
  if (cards) quick.expCards = round(cards.total, 2);
  if (c.market) quick.market = roundProbs(c.market.probs);
  if (valueBets.length) quick.pick = valueBets[0];

  const maxG = MODEL.maxGoals;
  const model: ModelBreakdown = {
    lambdaHome: round(c.lambdaHome, 3),
    lambdaAway: round(c.lambdaAway, 3),
    rho: round(c.rho, 4),
    elo: { home: Math.round(c.eloHome), away: Math.round(c.eloAway), diff: Math.round(c.diff), probs: roundProbs(c.eloP) },
    ensemble: roundProbs(c.ensemble),
    weights: { dixonColes: round(c.weights.dixonColes, 3), elo: round(c.weights.elo, 3), market: round(c.weights.market, 3) },
    scoreMatrix: c.matrix.slice(0, maxG + 1).map((row) => row.slice(0, maxG + 1).map((v) => round(v, 5))),
    explanation: buildExplanation(match, ctx, c, projections),
    confidence: round(conf.value, 3),
  };
  if (c.goal.kind === 'dc') {
    model.dixonColes = { probs: roundProbs(c.goal.probs), lambdaHome: round(c.goal.lambdaHome, 3), lambdaAway: round(c.goal.lambdaAway, 3) };
  }
  if (c.market) model.market = { probs: roundProbs(c.market.probs), margin: round(c.market.margin, 4), method: c.market.method };

  return {
    quick,
    model,
    markets: roundMarkets(markets),
    valueBets,
    lambdaHome: c.lambdaHome,
    lambdaAway: c.lambdaAway,
    matrix: c.matrix,
  };
}

/** Versión rápida para backtest: probabilidades del ensamble, Más de 2.5, ambos marcan y fuentes (sin mercados). */
export function predictProbsOnly(match: MatchRecord, ctx: PredictContext): ProbsOnlyResult {
  const c = core(match, ctx);
  const sources: ProbsOnlyResult['sources'] = { elo: c.eloP };
  if (c.goal.kind === 'dc') sources.dc = c.goal.probs;
  else sources.eloGoals = c.goal.probs;
  if (c.market) {
    sources.market = c.market.probs;
    if (c.market.over25 !== undefined) sources.marketOver25 = c.market.over25;
  }
  return {
    p: c.ensemble,
    over25: over25Of(c.matrix),
    btts: bttsProb(c.matrix),
    lambdaHome: c.lambdaHome,
    lambdaAway: c.lambdaAway,
    sources,
  };
}
