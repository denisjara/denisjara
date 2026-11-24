/**
 * Predicción de un partido: ensamble de Dixon-Coles (o Elo→goles), Elo y mercado sin margen.
 *
 *  1. λ por Dixon-Coles de la liga del partido (o de la liga doméstica común de ambos equipos).
 *  2. Probabilidades Elo (eloProbs con drawParams calibrados). La ventaja local de esta conversión puede depender del
 *     grupo de competiciones (MODEL.eloProbHomeAdv); hoy la tabla está vacía (65 en todos, como los ratings): una
 *     tabla por grupo mejoró la ventana de ajuste pero no el holdout y se revirtió (ver config.ts).
 *  3. Mercado sin margen (Shin) si hay cuotas 1X2 completas.
 *  4. Ensamble lineal. Con cuotas: wDixonColes/wElo/wMarket; sin cuotas: wDixonColesNoMarket/wEloNoMarket
 *     (pesos calibrados por separado en el backtest). Sin DC, la parte de goles usa el modelo Elo→goles con peso
 *     reducido (ELO_GOAL_WEIGHT_FACTOR). Si algún equipo tiene menos de LOW_DATA_GAMES partidos en el Elo y hay
 *     cuotas, el peso de las fuentes estadísticas se reduce (factor lowDataFactor) en favor del mercado.
 *  5. λ finales con fitLambdas hacia el objetivo ensamblado (1X2 + P(más de 2.5) mezcla DC/mercado; si la casa
 *     ofrece otra línea x.5 se traduce a P(más de 2.5) con un total Poisson equivalente).
 *  6. Sin línea de goles del mercado y fuera de copas nacionales, el total esperado se contrae hacia la media de goles
 *     de la competición (MODEL.totalShrink, ver analytics/totals.ts) manteniendo el 1X2.
 *  7. Matriz final con rho (DC o −0.05), mercados de goles, mercados de estadísticas, apuestas de valor.
 *
 * Decisiones calibradas con un backtest walk-forward sobre datos reales (temporadas actuales, cuotas de cierre;
 * números en el comentario de MODEL en pipeline/config.ts):
 *  - Pesos con y sin cuotas elegidos por rejilla (menor RPS); el mercado se limita al 80 % porque el backtest usa
 *    cuotas de cierre y las predicciones de partidos próximos usan cuotas previas.
 *  - Elo→goles con peso eloGoalWeightFactor·wDixonColes (0.2): con más peso no mejora el RPS en cruces entre ligas.
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
import { COMPETITION_BY_ID, MODEL, homeAdvGroup, isPlausibleMargin, overroundOf, type CompetitionConfig } from '../config';
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
import { productionTotalFactor } from './totals';
import { findValueBets } from './value';
import {
  blendParts,
  preMatchView,
  type ComponentRow,
  type Features,
  type HookInfo,
  type ModelVariant,
  type PreMatch,
} from '../experiments/types';
import { historyView, type HistorySource } from '../experiments/history';

/** rho por defecto cuando no hay modelo Dixon-Coles. */
export const DEFAULT_RHO = -0.05;
/** Factor de peso de la parte "goles" cuando se usa Elo→goles en lugar de Dixon-Coles. */
export const ELO_GOAL_WEIGHT_FACTOR = MODEL.eloGoalWeightFactor;
/** Partidos Elo por debajo de los cuales un equipo se considera "con pocos datos" (equipos de copa, recién llegados). */
export const LOW_DATA_GAMES = MODEL.lowDataGames;

/** Pesos del ensamble (por defecto los de MODEL; el backtest de calibración los sustituye). */
export interface EnsembleWeights {
  dixonColes: number;
  elo: number;
  market: number;
  dixonColesNoMarket: number;
  eloNoMarket: number;
  /** factor de la parte de goles cuando sale de Elo→goles en lugar de Dixon-Coles */
  eloGoalFactor: number;
  /** partidos Elo mínimos del equipo con menos datos para usar los pesos completos */
  lowDataGames: number;
  /** factor (0..1) de los pesos estadísticos con 0 partidos Elo y cuotas disponibles (sube linealmente hasta 1) */
  lowDataFloor: number;
}

export function defaultWeights(): EnsembleWeights {
  return {
    dixonColes: MODEL.wDixonColes,
    elo: MODEL.wElo,
    market: MODEL.wMarket,
    dixonColesNoMarket: MODEL.wDixonColesNoMarket,
    eloNoMarket: MODEL.wEloNoMarket,
    eloGoalFactor: MODEL.eloGoalWeightFactor,
    lowDataGames: MODEL.lowDataGames,
    lowDataFloor: MODEL.lowDataFloor,
  };
}

/**
 * Pesos efectivos de un partido: (goles, Elo, mercado) sin renormalizar.
 * `minGames` = partidos Elo previos del equipo con menos historial.
 */
export function ensembleWeights(
  w: EnsembleWeights,
  o: { hasMarket: boolean; goalKind: 'dc' | 'elo-goals'; minGames: number },
): { goal: number; elo: number; market: number } {
  const dc = o.hasMarket ? w.dixonColes : w.dixonColesNoMarket;
  let goal = o.goalKind === 'dc' ? dc : dc * w.eloGoalFactor;
  let elo = o.hasMarket ? w.elo : w.eloNoMarket;
  if (o.hasMarket && w.lowDataGames > 0 && o.minGames < w.lowDataGames) {
    const f = w.lowDataFloor + (1 - w.lowDataFloor) * Math.max(0, o.minGames) / w.lowDataGames;
    goal *= f;
    elo *= f;
  }
  return { goal, elo, market: o.hasMarket ? w.market : 0 };
}
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
  /** pesos del ensamble (por defecto los de MODEL) */
  weights?: EnsembleWeights;
  /** variante del banco de pruebas (pipeline/experiments); sin ella, producción */
  variant?: ModelVariant;
  /**
   * partidos por equipo/competición: vistas del pasado para la contracción del total de producción y para los ganchos
   * de la variante (baseContext/wfContext lo rellenan siempre; sin él no se contrae el total)
   */
  history?: HistorySource;
  /**
   * ensamble ya calculado en el walk-forward por el combinador de la variante (partidos terminados): se usa en lugar
   * de volver a combinar, para que la predicción mostrada sea la del walk-forward (sin fuga del reajuste final).
   */
  precombined?: { p: Prob1X2; over25?: number };
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
  /** partidos Elo previos del equipo con menos historial */
  minEloGames: number;
  /** P(más de 2,5) objetivo usado al recalibrar los λ */
  over25Target: number;
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

/** Componentes de la predicción (antes del ensamble). */
export interface PredictComponents {
  match: MatchRecord;
  homeId: string;
  awayId: string;
  neutral: boolean;
  eloHome: number;
  eloAway: number;
  /** diferencia Elo con la ventaja local de los ratings (MODEL.eloHomeAdv): la usa el modelo Elo→goles */
  diff: number;
  /** diferencia Elo con la ventaja local del grupo de competiciones: la de las probabilidades del Elo */
  probDiff: number;
  /** ventaja local de las probabilidades (0 en campo neutral) */
  probHomeAdv: number;
  eloP: Prob1X2;
  goal: GoalSource;
  market?: { probs: Prob1X2; margin: number; method: string; over25?: number };
  minEloGames: number;
  /** pesos efectivos de producción (sin renormalizar) */
  ew: { goal: number; elo: number; market: number };
  /** rasgos de la variante ({} sin variante) */
  features: Features;
  /** información pre-partido para los ganchos de la variante (solo si la variante la necesita) */
  info?: HookInfo;
  pre?: PreMatch;
}

interface Core {
  homeId: string;
  awayId: string;
  neutral: boolean;
  eloHome: number;
  eloAway: number;
  diff: number;
  /** diferencia y ventaja local de las probabilidades del Elo (ver PredictComponents) */
  probDiff: number;
  probHomeAdv: number;
  eloP: Prob1X2;
  goal: GoalSource;
  market?: { probs: Prob1X2; margin: number; method: string; over25?: number };
  weights: { dixonColes: number; elo: number; market: number };
  ensemble: Prob1X2;
  over25Target: number;
  minEloGames: number;
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

/** Ventaja local del Elo (puntos) de los ratings: la de la variante o MODEL.eloHomeAdv. */
function eloHomeAdvOf(ctx: PredictContext): number {
  return ctx.variant?.elo?.homeAdv ?? MODEL.eloHomeAdv;
}

/**
 * Ventaja local (puntos) de la conversión diferencia Elo → 1X2 en la competición del contexto: la del grupo
 * (MODEL.eloProbHomeAdv o el gancho eloProbs de la variante) o, si el grupo no está en la tabla, la de los ratings.
 */
export function eloProbHomeAdvOf(ctx: PredictContext): number {
  const table = ctx.variant?.eloProbs?.homeAdv ?? MODEL.eloProbHomeAdv;
  return table[homeAdvGroup(ctx.comp)] ?? eloHomeAdvOf(ctx);
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
    return initialElo(team, ctx.homeLeague, cfgs, ctx.comp, promoted, ctx.variant?.elo?.tierOffset ?? MODEL.eloTierOffset);
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
  // a trio with an impossible overround is a feed error: never let it into the ensemble (weight 0.8)
  if (!isPlausibleMargin(overroundOf(odds.home, odds.draw, odds.away))) return undefined;
  const d = devigDetailed([odds.home, odds.draw, odds.away], 'shin');
  if (!d.probs.every((p) => p > 0 && Number.isFinite(p))) return undefined;
  const out: NonNullable<Core['market']> = {
    probs: { home: d.probs[0], draw: d.probs[1], away: d.probs[2] },
    margin: d.margin,
    method: d.method,
  };
  const line = odds.totalLine;
  if (line !== undefined && isHalfLine(line) && line > 0 && line < 8 && validOdds(odds.over) && validOdds(odds.under) && isPlausibleMargin(overroundOf(odds.over, odds.under))) {
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

/** Partidos Elo de un equipo anteriores a un instante (los partidos futuros cuentan todos). */
export function eloGamesBefore(elo: Elo, team: string, t: number): number {
  const h = elo.history(team);
  if (!Number.isFinite(t)) return h.length;
  let n = 0;
  for (const e of h) if (Date.parse(e.date) < t) n++;
  return n;
}

/** Fuente de goles con λ ajustados (matriz, 1X2 y más de 2,5 recalculados). */
function adjustedGoal(goal: GoalSource, l: { lambdaHome: number; lambdaAway: number }): GoalSource {
  const m = scoreMatrix(l.lambdaHome, l.lambdaAway, goal.rho, FULL_GOALS);
  return { ...goal, lambdaHome: l.lambdaHome, lambdaAway: l.lambdaAway, probs: outcomeProbs(m), over25: over25Of(m) };
}

function variantHistory(ctx: PredictContext): HistorySource {
  if (!ctx.history) throw new Error(`La variante «${ctx.variant?.name}» necesita el historial de partidos (PredictContext.history): usa los contextos del build (baseContext/wfContext)`);
  return ctx.history;
}

/** Componentes pre-ensamble de un partido: Elo, fuente de goles (con lambdaAdjust de la variante), mercado y pesos. */
export function predictComponents(match: MatchRecord, ctx: PredictContext): PredictComponents {
  const homeId = match.home.id;
  const awayId = match.away.id;
  const neutral = !!match.neutral;
  const r = ratingsFor(match, ctx);
  const diff = r.home + (neutral ? 0 : eloHomeAdvOf(ctx)) - r.away;
  const probHomeAdv = neutral ? 0 : eloProbHomeAdvOf(ctx);
  const probDiff = r.home + probHomeAdv - r.away;
  const eloP = eloProbs(probDiff, ctx.drawParams);
  let goal = goalSource(match, ctx, diff, neutral);
  const market = marketFrom(match.odds);
  const t = Date.parse(match.date);
  const minEloGames = Math.min(eloGamesBefore(ctx.elo, homeId, t), eloGamesBefore(ctx.elo, awayId, t));
  const ew = ensembleWeights(ctx.weights ?? defaultWeights(), { hasMarket: !!market, goalKind: goal.kind, minGames: minEloGames });
  const v = ctx.variant;
  let features: Features = {};
  let info: HookInfo | undefined;
  let pre: PreMatch | undefined;
  if (v && (v.features || v.lambdaAdjust || v.totals?.adjustTotal)) {
    pre = preMatchView(match);
    const history = historyView(variantHistory(ctx), t);
    const fctx = { comp: ctx.comp, configs: configsOf(ctx), homeLeague: ctx.homeLeague };
    if (v.features) {
      features = v.features(fctx, pre, history);
      for (const [k, x] of Object.entries(features)) {
        if (typeof x !== 'number' || Number.isNaN(x)) throw new Error(`Variante «${v.name}»: el rasgo «${k}» no es un número (${String(x)}) en el partido ${match.id}`);
      }
    }
    info = {
      ...fctx,
      history,
      elo: { home: r.home, away: r.away, diff, probs: eloP },
      goalKind: goal.kind,
      dcModel: goal.model,
      dcCompId: goal.compId,
      rho: goal.rho,
      market: market ? { probs: market.probs, over25: market.over25, margin: market.margin } : undefined,
      minEloGames,
      features,
    };
    if (v.lambdaAdjust) {
      const l = v.lambdaAdjust({ ctx: info, match: pre, lambdaHome: goal.lambdaHome, lambdaAway: goal.lambdaAway, features });
      if (!(l.lambdaHome > 0) || !(l.lambdaAway > 0) || !Number.isFinite(l.lambdaHome) || !Number.isFinite(l.lambdaAway)) {
        throw new Error(`Variante «${v.name}»: lambdaAdjust devolvió λ no válidos (${l.lambdaHome}, ${l.lambdaAway}) en el partido ${match.id}`);
      }
      goal = adjustedGoal(goal, l);
    }
  }
  return { match, homeId, awayId, neutral, eloHome: r.home, eloAway: r.away, diff, probDiff, probHomeAdv, eloP, goal, market, minEloGames, ew, features, info, pre };
}

/** Ensamble de producción (pool lineal con los pesos efectivos). */
function productionBlend(c: PredictComponents): Prob1X2 {
  return blend([
    { probs: c.goal.probs, weight: c.ew.goal },
    { probs: c.eloP, weight: c.ew.elo },
    ...(c.market ? [{ probs: c.market.probs, weight: c.ew.market }] : []),
  ]);
}

/** Fila de componentes (entrada de los combinadores de las variantes). */
export function componentRow(c: PredictComponents, ctx: PredictContext): ComponentRow {
  const row: ComponentRow = {
    matchId: c.match.id,
    date: c.match.date,
    compId: c.match.compId,
    kind: ctx.comp.kind,
    tier: ctx.comp.tier,
    neutral: c.neutral,
    hasMarket: !!c.market,
    goalKind: c.goal.kind,
    goal: c.goal.probs,
    elo: c.eloP,
    goalOver25: c.goal.over25,
    lambdaHome: c.goal.lambdaHome,
    lambdaAway: c.goal.lambdaAway,
    rho: c.goal.rho,
    eloDiff: c.diff,
    minEloGames: c.minEloGames,
    features: c.features,
    production: productionBlend(c),
    weights: { ...c.ew },
  };
  if (c.goal.kind === 'dc') row.dc = c.goal.probs;
  else row.eloGoals = c.goal.probs;
  if (c.market) {
    row.market = c.market.probs;
    if (c.market.over25 !== undefined) row.marketOver25 = c.market.over25;
  }
  return row;
}

/**
 * Ensamble, recalibración de λ y matriz final a partir de los componentes. `combined`: ensamble ya calculado (walk-
 * forward con combinador); si no, el combinador de la variante o el pool lineal de producción.
 */
function finish(c: PredictComponents, ctx: PredictContext, combined?: { p: Prob1X2; over25?: number }): Core {
  const wGoal = c.ew.goal;
  const wElo = c.ew.elo;
  const wMkt = c.ew.market;
  const sw = wGoal + wElo + wMkt;
  const goal = c.goal;
  const market = c.market;
  const v = ctx.variant;
  let ensemble: Prob1X2;
  let over25Override: number | undefined;
  if (combined) {
    ensemble = combined.p;
    over25Override = combined.over25;
  } else if (v?.combine) {
    const r = blendParts(v.combine.blend(componentRow(c, ctx)));
    ensemble = r.p;
    over25Override = r.over25;
  } else {
    ensemble = productionBlend(c);
  }
  // pesos publicados: con Elo→goles, la parte de goles se reporta dentro de Elo (ambas derivan del rating)
  const weights =
    goal.kind === 'dc'
      ? { dixonColes: wGoal / sw, elo: wElo / sw, market: wMkt / sw }
      : { dixonColes: 0, elo: (wGoal + wElo) / sw, market: wMkt / sw };

  // objetivo de Más de 2.5: mezcla modelo de goles / mercado
  const over25Target =
    over25Override !== undefined && Number.isFinite(over25Override)
      ? over25Override
      : market?.over25 !== undefined && wGoal + wMkt > 0
        ? (wGoal * goal.over25 + wMkt * market.over25) / (wGoal + wMkt)
        : goal.over25;

  const rho = goal.rho;
  let fitted = fitLambdas({ ...ensemble, over25: over25Target }, rho, { lambdaHome: goal.lambdaHome, lambdaAway: goal.lambdaAway });
  // total de goles: gancho de la variante o, en producción, contracción hacia la media de la competición sin línea de
  // goles del mercado (salvo copas)
  let f: number;
  if (v?.totals?.adjustTotal) {
    f = v.totals.adjustTotal({
      ctx: c.info!,
      match: c.pre!,
      features: c.features,
      lambdaHome: fitted.lambdaHome,
      lambdaAway: fitted.lambdaAway,
      ensemble,
      over25Target,
    });
    if (!(f > 0) || !Number.isFinite(f)) throw new Error(`Variante «${v.name}»: adjustTotal devolvió un factor no válido (${f}) en el partido ${c.match.id}`);
  } else {
    f = productionTotalFactor({
      hasMarketTotal: market?.over25 !== undefined,
      kind: ctx.comp.kind,
      compId: c.match.compId,
      before: ctx.history ? historyView(ctx.history, Date.parse(c.match.date)) : undefined,
      lambdaHome: fitted.lambdaHome,
      lambdaAway: fitted.lambdaAway,
    });
  }
  if (f !== 1) {
    const target = over25Of(scoreMatrix(fitted.lambdaHome * f, fitted.lambdaAway * f, rho, FULL_GOALS));
    fitted = fitLambdas({ ...ensemble, over25: target }, rho, fitted);
  }
  const matrix = scoreMatrix(fitted.lambdaHome, fitted.lambdaAway, rho, FULL_GOALS);
  return {
    homeId: c.homeId,
    awayId: c.awayId,
    neutral: c.neutral,
    eloHome: c.eloHome,
    eloAway: c.eloAway,
    diff: c.diff,
    probDiff: c.probDiff,
    probHomeAdv: c.probHomeAdv,
    eloP: c.eloP,
    goal,
    market,
    weights,
    ensemble,
    over25Target,
    minEloGames: c.minEloGames,
    rho,
    lambdaHome: fitted.lambdaHome,
    lambdaAway: fitted.lambdaAway,
    matrix,
  };
}

function core(match: MatchRecord, ctx: PredictContext): Core {
  return finish(predictComponents(match, ctx), ctx, ctx.precombined);
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
      `${c.neutral ? ', campo neutral' : `, ${fmtSigned(c.probDiff)} con el factor campo`}) → ${p1x2(c.eloP)}.`,
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
    // ventaja local de las probabilidades: depende del grupo de competiciones (MODEL.eloProbHomeAdv)
    const homeAdv = c.probHomeAdv;
    const withAdv = eloProbs(c.probDiff, ctx.drawParams).home;
    const without = eloProbs(c.probDiff - homeAdv, ctx.drawParams).home;
    let txt = `Factor campo: +${homeAdv} puntos Elo para ${H} (≈ ${fmtSigned((withAdv - without) * 100, 1)} pp de probabilidad de victoria)`;
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
    elo: { home: Math.round(c.eloHome), away: Math.round(c.eloAway), diff: Math.round(c.probDiff), probs: roundProbs(c.eloP) },
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
  return probsFromCore(core(match, ctx));
}

/**
 * predictProbsOnly a partir de componentes ya calculados (walk-forward con combinador de la variante): `combined` es
 * el ensamble del combinador (si se omite, ctx.precombined, el combinador de la variante o producción).
 */
export function predictProbsFromComponents(
  comps: PredictComponents,
  ctx: PredictContext,
  combined?: { p: Prob1X2; over25?: number },
): ProbsOnlyResult {
  return probsFromCore(finish(comps, ctx, combined ?? ctx.precombined));
}

function probsFromCore(c: Core): ProbsOnlyResult {
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
    minEloGames: c.minEloGames,
    over25Target: c.over25Target,
  };
}
