/**
 * Banco de pruebas de modelos: contrato de una VARIANTE.
 *
 * Una variante es un objeto con ganchos opcionales que el núcleo (ratings, predict, projections, context) consulta.
 * TODOS los ganchos son opcionales y su ausencia equivale EXACTAMENTE a producción: la variante vacía
 * (`PRODUCTION_VARIANT`, «production») da las mismas predicciones y los mismos JSON publicados que el build.
 * `BASELINE_VARIANT` («baseline») es la versión ANTERIOR de producción (hasta el 22-nov-2026), expresada con ganchos
 * que desactivan lo que se integró ese día: es la referencia de comparación de eval-model.
 *
 * Reglas (ver pipeline/experiments/README.md):
 *  - Walk-forward estricto: cada gancho solo puede usar información con fecha ANTERIOR al inicio del partido que se
 *    predice. El núcleo solo le entrega vistas ya recortadas (HistoryView, PreMatch sin marcador ni estadísticas,
 *    filas de reajuste anteriores a la fecha de reajuste). No guardes estado global entre llamadas ni leas el
 *    data-store por tu cuenta: `eval-model` lo detecta envenenando el futuro (comprobación de fuga).
 *  - Los ganchos deben ser deterministas (nada de Math.random sin semilla).
 */
import type { DCModel } from '../../src/lib/models';
import type { CompetitionKind, Prob1X2 } from '../../src/types/data';
import type { CompetitionConfig, HomeAdvGroup } from '../config';
import type { MatchRecord } from '../types';

/** Rasgos numéricos de un partido (calculados solo con información anterior a su inicio). */
export type Features = Record<string, number>;

/** Partido a predecir tal y como se conocía ANTES de empezar: sin marcador, estadísticas, eventos ni forma de ESPN. */
export type PreMatch = Omit<
  MatchRecord,
  'score' | 'stats' | 'events' | 'statusDetail' | 'summaryFetched' | 'summaryAttempts' | 'summaryRetryAt' | 'downgradeSeen' | 'homeForm' | 'awayForm'
>;

/**
 * Vista del pasado de un partido: SOLO partidos terminados (con marcador) cuyo inicio es estrictamente anterior a
 * `cutoff` (el inicio del partido que se predice). Las listas son cronológicas (el más reciente al final).
 */
export interface HistoryView {
  /** instante de corte (ms): inicio del partido que se predice */
  readonly cutoff: number;
  /** mismo corte en ISO */
  readonly cutoffIso: string;
  /** partidos terminados del equipo en TODAS las competiciones, anteriores al corte */
  teamMatches(teamId: string): readonly MatchRecord[];
  /** partidos terminados de una competición (todas las temporadas), anteriores al corte */
  compMatches(compId: string): readonly MatchRecord[];
  /** rating Elo del equipo justo antes del corte (undefined si aún no había jugado ningún partido) */
  eloBefore(teamId: string): number | undefined;
}

/** Contexto no temporal que reciben los rasgos. */
export interface FeatureContext {
  comp: CompetitionConfig;
  configs: ReadonlyMap<string, CompetitionConfig>;
  /**
   * liga doméstica asignada a cada equipo. ÚNICA excepción documentada del núcleo: se calcula con el calendario
   * completo (solo decide qué modelo de goles se usa). No la uses como señal predictiva.
   */
  homeLeague: ReadonlyMap<string, string>;
}

/** Información pre-partido que reciben lambdaAdjust y totals (todo anterior al inicio del partido). */
export interface HookInfo extends FeatureContext {
  history: HistoryView;
  /** Elo pre-partido; diff incluye la ventaja local si no es campo neutral */
  elo: { home: number; away: number; diff: number; probs: Prob1X2 };
  /** origen de los goles esperados: Dixon-Coles de liga o modelo Elo→goles (cruces entre ligas) */
  goalKind: 'dc' | 'elo-goals';
  /** modelo Dixon-Coles usado (ajustado solo con partidos de días anteriores) */
  dcModel?: DCModel;
  dcCompId?: string;
  rho: number;
  /** mercado sin margen (cuotas de cierre en partidos terminados, previas en próximos) */
  market?: { probs: Prob1X2; over25?: number; margin: number };
  /** partidos Elo previos del equipo con menos historial */
  minEloGames: number;
  features: Features;
}

/** Componentes de la predicción de un partido (entrada de un combinador). */
export interface ComponentRow {
  matchId: string;
  /** ISO, inicio del partido */
  date: string;
  compId: string;
  kind: CompetitionKind;
  tier: number;
  neutral: boolean;
  hasMarket: boolean;
  goalKind: 'dc' | 'elo-goals';
  /** 1X2 de la fuente de goles (Dixon-Coles o Elo→goles), ya con lambdaAdjust */
  goal: Prob1X2;
  dc?: Prob1X2;
  eloGoals?: Prob1X2;
  elo: Prob1X2;
  market?: Prob1X2;
  /** P(más de 2,5) del mercado (traducida a la línea 2,5 si la casa ofrece otra) */
  marketOver25?: number;
  /** P(más de 2,5) de la fuente de goles */
  goalOver25: number;
  /** λ de la fuente de goles (tras lambdaAdjust) */
  lambdaHome: number;
  lambdaAway: number;
  rho: number;
  eloDiff: number;
  minEloGames: number;
  features: Features;
  /** ensamble de producción (pool lineal con los pesos de MODEL) */
  production: Prob1X2;
  /** pesos efectivos de producción sin normalizar (goles, Elo, mercado) */
  weights: { goal: number; elo: number; market: number };
}

/** Fila de reajuste de un combinador: componentes pre-partido + resultado (marcador a 90' cuando se puede reconstruir). */
export interface WalkForwardRow extends ComponentRow {
  outcome: 0 | 1 | 2;
  hg: number;
  ag: number;
  /** hubo prórroga o penaltis y el marcador a 90' no se pudo reconstruir (hg/ag son los finales) */
  extraTimeUnresolved?: boolean;
}

export type BlendResult = Prob1X2 | { p: Prob1X2; over25?: number };

export interface DcHooks {
  /** decaimiento temporal por día (producción MODEL.dcXi) */
  xi?: number;
  /** ventana de partidos del ajuste en días (producción MODEL.dcWindowDays) */
  windowDays?: number;
  /** peso del prior hacia la media en partidos equivalentes (producción 2) */
  priorWeight?: number;
  /**
   * goles "ajustados" de un partido HISTÓRICO para el ajuste (p. ej. mezcla con xG por tiros). Solo puede usar datos
   * del propio partido `m` (que es anterior al partido predicho). La corrección τ de Dixon-Coles sigue usando el
   * marcador real. Debe devolver valores finitos >= 0.
   */
  fitGoals?(m: MatchRecord): { hg: number; ag: number };
  /** peso extra (>= 0) de un partido histórico en el ajuste (se multiplica por el decaimiento temporal) */
  weight?(m: MatchRecord): number;
}

export interface EloHooks {
  /** K (producción MODEL.eloK) */
  k?: number;
  /** ventaja local en puntos (producción MODEL.eloHomeAdv) */
  homeAdv?: number;
  /** puntos por tier del Elo inicial (producción MODEL.eloTierOffset) */
  tierOffset?: number;
  /** multiplicador de K por partido (producción: 1,2 continental, 0,9 copa, 1 liga) */
  kMultiplier?(m: MatchRecord, comp: CompetitionConfig | undefined): number;
  /** multiplicador por diferencia de goles (producción goalMultiplier de src/lib/models/elo.ts) */
  goalMultiplier?(goalDiff: number): number;
}

export interface EloProbHooks {
  /**
   * ventaja local (puntos Elo) de la conversión diferencia Elo → 1X2 por grupo de competiciones (región × tipo, ver
   * homeAdvGroup en config.ts). Producción: MODEL.eloProbHomeAdv. Un grupo ausente usa la ventaja de los ratings
   * (elo.homeAdv o MODEL.eloHomeAdv); `{}` = la de los ratings en todos (versión anterior de producción).
   */
  homeAdv?: Readonly<Partial<Record<HomeAdvGroup, number>>>;
}

export interface LambdaAdjustInput {
  ctx: HookInfo;
  match: PreMatch;
  lambdaHome: number;
  lambdaAway: number;
  features: Features;
}

export interface CombineHooks {
  /** cada cuánto se reajusta: 'monthly' (por defecto, el día 1 de cada mes UTC) o cada N días desde el primer partido */
  refitEvery?: 'monthly' | number;
  /**
   * reajuste del combinador con filas de partidos terminados ESTRICTAMENTE anteriores a `asOf` (ISO). Se llama en
   * cada fecha de reajuste del walk-forward y, al final del build, con todas las filas (predicciones de próximos).
   * Las filas solo existen para la temporada actual (el walk-forward empieza en su primer partido).
   */
  prepare?(rows: readonly WalkForwardRow[], asOf: string): void;
  /** probabilidades 1X2 finales (y, opcionalmente, P(más de 2,5) objetivo) a partir de los componentes */
  blend(row: ComponentRow): BlendResult;
}

export interface TotalsInput {
  ctx: HookInfo;
  match: PreMatch;
  features: Features;
  /** λ finales recalibrados al ensamble (antes del ajuste de totales) */
  lambdaHome: number;
  lambdaAway: number;
  ensemble: Prob1X2;
  over25Target: number;
}

export interface TotalsHooks {
  /**
   * factor multiplicativo del total de goles esperado (1 = sin cambio). Se aplica manteniendo el 1X2: se recalcula
   * el objetivo de más de 2,5 con λ·factor y se vuelven a recalibrar los λ con fitLambdas. SUSTITUYE al factor de
   * producción (contracción hacia la media de la competición sin línea de goles del mercado, salvo copas:
   * productionTotalFactor en pipeline/analytics/totals.ts); `() => 1` = versión anterior de producción.
   */
  adjustTotal?(input: TotalsInput): number;
}

/**
 * Dispersión de la binomial negativa de córners/tarjetas/tiros…:
 *  - 'pooled' (producción): una por estadística, método de momentos sobre los residuos de la competición (o de todo si
 *    tiene < 30 partidos);
 *  - 'global': igual pero siempre con todos los partidos del contexto;
 *  - 'team': por equipo (sus propios residuos) contraída hacia la 'pooled' con 20 observaciones ficticias;
 *  - 'poisson': sin sobredispersión;
 *  - número: dispersión fija r (var = μ + μ²/r).
 */
export type DispersionMode = 'pooled' | 'global' | 'team' | 'poisson' | number;

export interface StatHooks {
  /** partidos ficticios de la contracción de las tasas de equipo (producción 40; hasta el 22-nov-2026, 6) */
  priorN?: number;
  /** vida media (días) de la ponderación temporal (producción 150) */
  halfLifeDays?: number;
  dispersion?: DispersionMode;
  /** partidos ficticios de la media de la competición hacia los valores por defecto (producción 20) */
  leaguePriorN?: number;
}

/** Variante de modelo: ganchos opcionales; sin ganchos = producción. */
export interface ModelVariant {
  /** identificador (igual que el nombre del archivo pipeline/experiments/<name>.ts) */
  name: string;
  /** qué cambia y por qué (español) */
  description: string;
  dc?: DcHooks;
  elo?: EloHooks;
  /** conversión diferencia Elo → probabilidades (no cambia los ratings) */
  eloProbs?: EloProbHooks;
  /** rasgos pre-partido (días de descanso, partidos en 14 días…) calculados SOLO con `before` */
  features?(ctx: FeatureContext, match: PreMatch, before: HistoryView): Features;
  /** ajuste contextual de los λ de la fuente de goles ANTES del ensamble */
  lambdaAdjust?(input: LambdaAdjustInput): { lambdaHome: number; lambdaAway: number };
  combine?: CombineHooks;
  totals?: TotalsHooks;
  stats?: StatHooks;
}

/** La variante de producción (vacía: ningún gancho). */
export const PRODUCTION_VARIANT: ModelVariant = {
  name: 'production',
  description: 'Producción actual (variante vacía: ningún gancho)',
};

/**
 * Versión ANTERIOR de producción (hasta el 22-nov-2026), referencia de comparación del banco: sin ventaja local por
 * grupo en las probabilidades del Elo (65 en todos), sin contracción del total de goles sin línea del mercado y con 6
 * partidos ficticios en la contracción de córners/tarjetas. Da exactamente las predicciones de entonces.
 */
export const BASELINE_VARIANT: ModelVariant = {
  name: 'baseline',
  description: 'Producción anterior (hasta el 22-nov-2026): ventaja local 65 en todos, sin contracción del total, priorN 6',
  eloProbs: { homeAdv: {} },
  totals: { adjustTotal: () => 1 },
  stats: { priorN: 6 },
};

/** true si la variante no tiene ningún gancho (se comporta exactamente como producción). */
export function isEmptyVariant(v: ModelVariant | undefined): boolean {
  if (!v) return true;
  return !v.dc && !v.elo && !v.eloProbs && !v.features && !v.lambdaAdjust && !v.combine && !v.totals && !v.stats;
}

/** Vista pre-partido de un registro: sin resultado, estadísticas, eventos ni forma (status 'scheduled'). */
export function preMatchView(m: MatchRecord): PreMatch {
  const {
    score: _s,
    stats: _st,
    events: _e,
    statusDetail: _sd,
    summaryFetched: _sf,
    summaryAttempts: _sa,
    summaryRetryAt: _sr,
    downgradeSeen: _dg,
    homeForm: _hf,
    awayForm: _af,
    ...rest
  } = m;
  return { ...rest, status: 'scheduled' };
}

/** Normaliza el resultado de un combinador. */
export function blendParts(r: BlendResult): { p: Prob1X2; over25?: number } {
  return 'p' in r && typeof r.p === 'object' ? r : { p: r as Prob1X2 };
}
