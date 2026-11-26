/**
 * Motor del apartado «COMBINADA 6» (public/data/combo6.json; publicación en publish/combo6.ts).
 *
 * Qué es: una combinada de mercados MEZCLADOS (resultado de un partido, goles de otro, córners de otro, tiros a puerta
 * de otro…) cuya cuota total de la casa queda entre 6 y 8, elegida para que su probabilidad combinada sea la MÁXIMA
 * posible con las mismas probabilidades y calibraciones que «Pronósticos del día» (analytics/daily.ts). No es una
 * apuesta con ventaja: el margen de la casa se paga en CADA pata y se multiplica (valor esperado negativo).
 *
 * PATAS CANDIDATAS (matchLegs): por partido programado (sin empezar), los candidatos de alta confianza + los de las
 * familias del apartado diario (upcomingCandidates + upcomingExtraCandidates: un candidato por familia, el más probable
 * dentro de [0,50, 0,93], con los requisitos de datos de siempre: sin cuotas, >= 10 partidos Elo de cada equipo para
 * resultado y goles; >= 5 partidos con el dato para córners, tarjetas, tiros y faltas).
 *   - Solo familias|fuente con una regla VALIDADA fuera de muestra (las reglas publicadas del apartado diario: >= 30
 *     picks y >= 80 % en el walk-forward mensual); el resto se excluye.
 *   - Probabilidad = la recalibrada de esa regla (Platt por familia|fuente); sin Platt, la del modelo.
 *   - Se exige probabilidad en [LEG_MIN_PROB, LEG_MAX_PROB] = [0,70, 0,88]: por debajo la pata deja de ser «probable»;
 *     por encima su cuota (< 1,14 justa) casi no suma y cada pata paga el margen de la casa.
 *   - Categorías (categoryOf): ganador (1X2 del favorito, doble oportunidad, empate no apuesta, hándicap +1,5), goles
 *     (más/menos, ambos marcan, goles de un equipo), córners, tiros a puerta, tiros, tarjetas y faltas. Jugadores NO
 *     (PLAYERS_ENABLED = false): su única regla validada («1+ tiro») acierta MENOS que su tasa base fuera de muestra
 *     (86,8 % frente a 88,2 %, walk-forward 1 jun – 26 nov 2026), un 7,8 % se anulan porque el jugador no juega y
 *     dependen de una alineación que se publica una hora antes.
 *   - Una sola pata por (partido, categoría): la de mayor EFICIENCIA (menor −ln p / ln cuota: probabilidad que se
 *     pierde por cada unidad de cuota que se gana); a igualdad, la más probable.
 *
 * CUOTA DE CADA PATA: la de la casa si ESPN la publica (DraftKings: 1X2, línea principal de goles y hándicap ±1,5 con
 * margen plausible) → 'casa'; doble oportunidad y empate no apuesta DERIVADAS de su 1X2 (margen incluido) → 'derivada'
 * (estimada); si no hay precio, ESTIMADA = cuota justa / (1 + MARGIN_EST[categoría]) → 'estimada'. Toda cuota que no
 * es la de la casa se marca como estimada.
 *
 * REGLA DEL DÍA (searchCombo6): una pata por partido (partidos distintos ⇒ independientes), de MIN_LEGS a MAX_LEGS
 * (4–9) patas, al menos MIN_CATEGORIES (4) categorías distintas y como mucho MAX_PER_CATEGORY (2) por categoría, con el
 * producto de cuotas de la casa (reales o estimadas) en [TARGET_MIN, TARGET_MAX] = [6, 8]. Entre todas las que
 * cumplen, la de MAYOR probabilidad combinada (producto de las probabilidades recalibradas); a igualdad, mayor prestigio
 * de las competiciones (suma de tier), primer saque más temprano y, por último, el id.
 *   Búsqueda: ramificación y poda sobre las patas candidatas ordenadas por eficiencia, con tres cotas inferiores del
 *   coste (−ln probabilidad) de cualquier ampliación: (1) mochila fraccionaria (para sumar el ln(cuota) que falta hasta
 *   ln 6 hay que perder al menos falta × menor −ln p / ln cuota restante); (2) coste = Σ ln cuota + Σ π, con
 *   π = −ln(p·cuota) el margen que paga cada pata, así que cuesta al menos lo que falta + la suma de los r menores π
 *   restantes, con r las patas que aún hacen falta (por regla y para llegar a ln 6); (3) factibilidad (patas que
 *   quedan × mayor ln(cuota) restante). Se recorren las POOL_PER_CATEGORY (12) patas más eficientes de cada categoría
 *   (con 9 patas como mucho, en cada categoría siempre quedan 2 de esas 12 de partidos no usados) y se poda con una
 *   tolerancia SEARCH_TOLERANCE de 0,001 en ln(probabilidad) (como mucho un 0,1 % relativo peor que la óptima) y un
 *   límite de SEARCH_NODE_LIMIT nodos (exact = false si se alcanza). Con tolerancia 0, sin límite y todas las patas
 *   en el conjunto, la búsqueda es EXACTA (tests contra fuerza bruta). Comprobación con los datos reales (26-nov-2026,
 *   152 días del historial): frente a la búsqueda sin tolerancia ni límite de nodos, ningún día queda más de un 0,1 %
 *   por debajo; 1,9 s en total frente a 13 s.
 *   Además, una combinada por competición continental (CONTINENTAL_IDS) con >= COMPETITION_MIN_MATCHES (5) partidos
 *   con alguna pata ese día: la misma regla restringida a esa competición.
 *   Resultado de una combinada: alguna pata fallada ⇒ 'miss'; todas resueltas ⇒ 'hit' (las patas nulas se quitan,
 *   como hacen las casas) o 'void' si todas son nulas.
 *
 * HISTORIAL (combo6WalkForward): la MISMA regla en cada día pasado (desde el 1 de junio de la temporada) con los
 * candidatos walk-forward (solo datos anteriores a cada partido; cuotas de cierre) de confidenceHistory/dailyHistory y,
 * en cada tramo mensual, las reglas (y sus Platt) ajustadas SOLO con los meses anteriores y validadas con los tramos
 * anteriores (WalkForwardResult.foldRules[k].published de las familias existentes y de las adicionales); todo el día
 * local usa las reglas del tramo de su PRIMER partido (el día 1 de Madrid empieza antes del inicio UTC del tramo). Resuelto a 90'.
 * Se publica: días, combinadas, aciertos, % con Wilson al 90 %, probabilidad media prevista, acierto por categoría de
 * las patas frente a lo previsto, patas y cuotas medias, racha de fallos más larga y las últimas combinadas. SIN ROI:
 * la mayoría de las patas no tienen cuota real de la casa. Si el acierto queda muy por debajo de lo previsto
 * (Wilson alto < WARNING_RATIO × previsto con >= WARNING_MIN_N combinadas), aviso automático (combo6Warning).
 */
import type { Combo6Category, Combo6OddsSource } from '../../src/types/data';
import {
  WILSON_Z90,
  plattProb,
  ruleFor,
  wilsonInterval,
  type CandidatePlayer,
  type CandidateResult,
  type ConfidenceCandidate,
  type ConfidenceFamily,
  type ConfidenceRules,
  type ConfidenceSegment,
  type ConfidenceSettle,
  type WalkForwardResult,
} from './confidence';
import { mergeRules } from './daily';
import { localDay } from '../publish/util';

// ---------------------------------------------------------------------------
// Parámetros
// ---------------------------------------------------------------------------

/** Banda de probabilidad (recalibrada) de cada pata. */
export const LEG_MIN_PROB = 0.7;
export const LEG_MAX_PROB = 0.88;
/** Producto de las cuotas de la casa (reales o estimadas) de la combinada. */
export const TARGET_MIN = 6;
export const TARGET_MAX = 8;
/** Patas (una por partido) y categorías. */
export const MIN_LEGS = 4;
export const MAX_LEGS = 9;
export const MIN_CATEGORIES = 4;
export const MAX_PER_CATEGORY = 2;
/** Patas más eficientes de cada categoría entre las que se busca. */
export const POOL_PER_CATEGORY = 12;
/**
 * Nodos máximos de la búsqueda por combinada (seguridad: con los datos reales, solo los sábados y domingos con 60+
 * partidos llegan; se publica la mejor encontrada, que la búsqueda recorre primero por eficiencia).
 */
export const SEARCH_NODE_LIMIT = 500_000;
/**
 * Tolerancia de la búsqueda en ln(probabilidad): 0,001 ⇒ la combinada elegida tiene, como mucho, un 0,1 % (relativo)
 * menos de probabilidad que la óptima del conjunto (p. ej. 11,99 % frente a 12,00 %). Con cuotas estimadas hay muchísimas
 * combinadas casi empatadas (coste = ln cuota + margen de cada pata) y sin tolerancia la búsqueda no termina en días con
 * 60 partidos.
 */
export const SEARCH_TOLERANCE = 1e-3;
/** Combinadas por competición: continentales con al menos estos partidos con alguna pata ese día. */
export const CONTINENTAL_IDS: readonly string[] = ['champions', 'europa', 'conference', 'libertadores', 'sudamericana'];
export const COMPETITION_MIN_MATCHES = 5;
/** Props de jugador: fuera (ver cabecera). */
export const PLAYERS_ENABLED = false;
/**
 * Margen típico de la casa por categoría para ESTIMAR la cuota de una pata sin precio: cuota = justa / (1 + margen).
 * Líneas de goles y resultado ~5 % (mercados principales); córners, tarjetas, tiros, tiros a puerta y faltas ~7 %
 * (mercados secundarios); goles de un equipo 7 % (MARGIN_TEAM_GOALS); props de jugador ~10 %.
 */
export const MARGIN_EST: Record<Combo6Category, number> = {
  ganador: 0.05,
  goles: 0.05,
  corners: 0.07,
  'tiros-puerta': 0.07,
  tiros: 0.07,
  tarjetas: 0.07,
  faltas: 0.07,
  jugadores: 0.1,
};
export const MARGIN_TEAM_GOALS = 0.07;
/** Aviso automático del historial: con >= WARNING_MIN_N combinadas resueltas, si Wilson alto < WARNING_RATIO × previsto. */
export const WARNING_MIN_N = 20;
export const WARNING_RATIO = 0.7;
/** Últimas combinadas resueltas que se publican. */
export const RECENT_COMBOS = 14;

export const COMBO6_CATEGORIES: { id: Combo6Category; label: string }[] = [
  { id: 'ganador', label: 'Ganador' },
  { id: 'goles', label: 'Goles' },
  { id: 'corners', label: 'Córners' },
  { id: 'tiros-puerta', label: 'Tiros a puerta' },
  { id: 'tiros', label: 'Tiros' },
  { id: 'tarjetas', label: 'Tarjetas' },
  { id: 'faltas', label: 'Faltas' },
  { id: 'jugadores', label: 'Jugadores' },
];
export const CATEGORY_LABEL: Record<Combo6Category, string> = Object.fromEntries(COMBO6_CATEGORIES.map((c) => [c.id, c.label])) as Record<Combo6Category, string>;

export interface Combo6Rule {
  targetMin: number;
  targetMax: number;
  minLegs: number;
  maxLegs: number;
  minCategories: number;
  maxPerCategory: number;
  /** patas más eficientes por categoría en la búsqueda (Infinity = todas: búsqueda exacta) */
  poolPerCategory: number;
  nodeLimit: number;
  /**
   * tolerancia de la poda en ln(probabilidad): se descartan las ramas que no pueden mejorar la mejor combinada en más de
   * esto (0 = exacta, con empates resueltos por cmpCombos)
   */
  tolerance: number;
}

export const DEFAULT_RULE: Combo6Rule = {
  targetMin: TARGET_MIN,
  targetMax: TARGET_MAX,
  minLegs: MIN_LEGS,
  maxLegs: MAX_LEGS,
  minCategories: MIN_CATEGORIES,
  maxPerCategory: MAX_PER_CATEGORY,
  poolPerCategory: POOL_PER_CATEGORY,
  nodeLimit: SEARCH_NODE_LIMIT,
  tolerance: SEARCH_TOLERANCE,
};

const EPS = 1e-9;
/** Tolerancia de empate en ln(probabilidad). */
const TIE = 1e-12;
const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface Combo6Match {
  matchId: string;
  compId: string;
  /** ISO, inicio del partido */
  date: string;
  /** prestigio de la competición 1..10 */
  tier: number;
}

export interface Combo6EngineLeg {
  match: Combo6Match;
  category: Combo6Category;
  family: ConfidenceFamily;
  marketId: string;
  market: string;
  selection: string;
  settle: ConfidenceSettle;
  segment: ConfidenceSegment;
  player?: CandidatePlayer;
  /** probabilidad del modelo y recalibrada (la que se usa) */
  rawProb: number;
  prob: number;
  fairOdds: number;
  /** cuota de la casa (real) o estimada */
  bookOdds: number;
  oddsSource: Combo6OddsSource;
  estimated: boolean;
  /** resultado a 90' (historial y partidos ya terminados) */
  result?: CandidateResult;
}

export interface Combo6EngineCombo {
  legs: Combo6EngineLeg[];
  prob: number;
  fairOdds: number;
  bookOdds: number;
  estimatedLegs: number;
  ev: number;
  categories: number;
  tierSum: number;
  result?: CandidateResult;
}

export interface Combo6Search {
  combo?: Combo6EngineCombo;
  /** motivo (español) cuando no hay combinada */
  reason?: string;
  /** nodos explorados, patas del conjunto de búsqueda y si la búsqueda terminó (no llegó al límite) */
  nodes: number;
  pool: number;
  exact: boolean;
}

// ---------------------------------------------------------------------------
// Patas
// ---------------------------------------------------------------------------

/** Categoría de una familia (undefined: familia sin categoría en la combinada). */
export function categoryOf(c: Pick<ConfidenceCandidate, 'family' | 'theme'>): Combo6Category | undefined {
  switch (c.theme) {
    case 'resultado':
      return 'ganador';
    case 'goles':
      return 'goles';
    case 'corners':
      return 'corners';
    case 'tarjetas':
      return 'tarjetas';
    case 'faltas':
      return 'faltas';
    case 'jugadores':
      return 'jugadores';
    case 'tiros':
      return c.family.startsWith('sot-') ? 'tiros-puerta' : c.family.startsWith('shots-') ? 'tiros' : undefined;
  }
  return undefined;
}

/** Margen típico asumido para estimar la cuota de una pata sin precio. */
export function estimatedMargin(c: Pick<ConfidenceCandidate, 'settle'>, category: Combo6Category): number {
  return c.settle.kind === 'team-total' ? MARGIN_TEAM_GOALS : MARGIN_EST[category];
}

const validPrice = (o: number | undefined): o is number => typeof o === 'number' && Number.isFinite(o) && o > 1 + 1e-6 && o < 1000;

export interface LegOptions {
  /** incluir props de jugador (por defecto PLAYERS_ENABLED) */
  players?: boolean;
  minProb?: number;
  maxProb?: number;
}

/**
 * Pata a partir de un candidato (con su resultado si lo tiene): solo con regla validada de su familia|fuente,
 * probabilidad recalibrada dentro de la banda y cuota de la casa real, derivada o estimada.
 */
export function toLeg(c: ConfidenceCandidate & { result?: CandidateResult }, rules: ConfidenceRules, match: Combo6Match, opts: LegOptions = {}): Combo6EngineLeg | undefined {
  const category = categoryOf(c);
  if (!category || (category === 'jugadores' && !(opts.players ?? PLAYERS_ENABLED))) return undefined;
  const rule = ruleFor(rules, c);
  if (!rule) return undefined;
  const prob = clamp01(rule.platt ? plattProb(rule.platt, c.prob) : c.prob);
  if (!(prob >= (opts.minProb ?? LEG_MIN_PROB) - EPS && prob <= (opts.maxProb ?? LEG_MAX_PROB) + EPS)) return undefined;
  const fairOdds = 1 / prob;
  let bookOdds: number;
  let oddsSource: Combo6OddsSource;
  if (validPrice(c.marketOdds)) {
    bookOdds = c.marketOdds;
    oddsSource = c.oddsKind === 'sintetica' ? 'derivada' : 'casa';
  } else {
    bookOdds = fairOdds / (1 + estimatedMargin(c, category));
    oddsSource = 'estimada';
  }
  if (!validPrice(bookOdds)) return undefined;
  const leg: Combo6EngineLeg = {
    match,
    category,
    family: c.family,
    marketId: c.marketId,
    market: c.market,
    selection: c.selection,
    settle: c.settle,
    segment: c.segment,
    rawProb: c.prob,
    prob,
    fairOdds,
    bookOdds,
    oddsSource,
    estimated: oddsSource !== 'casa',
  };
  if (c.player) leg.player = c.player;
  if (c.result) leg.result = c.result;
  return leg;
}

/** −ln p / ln cuota: probabilidad que se pierde por unidad de cuota ganada (menor = más eficiente). */
export function legRatio(l: Pick<Combo6EngineLeg, 'prob' | 'bookOdds'>): number {
  return -Math.log(Math.max(l.prob, 1e-12)) / Math.log(l.bookOdds);
}

const legKey = (l: Combo6EngineLeg) => `${l.match.matchId}.${l.marketId}.${l.family}.${l.selection}`;

/** Orden de eficiencia: menor ratio; a igualdad, más probable, antes, partido y mercado. */
const cmpEfficiency = (a: Combo6EngineLeg, b: Combo6EngineLeg) =>
  legRatio(a) - legRatio(b) ||
  b.prob - a.prob ||
  Date.parse(a.match.date) - Date.parse(b.match.date) ||
  a.match.matchId.localeCompare(b.match.matchId) ||
  legKey(a).localeCompare(legKey(b));

/** Patas de UN partido: las de cada candidato válido y, por categoría, solo la más eficiente. */
export function matchLegs(cands: (ConfidenceCandidate & { result?: CandidateResult })[], rules: ConfidenceRules, match: Combo6Match, opts: LegOptions = {}): Combo6EngineLeg[] {
  const best = new Map<Combo6Category, Combo6EngineLeg>();
  for (const c of cands) {
    const l = toLeg(c, rules, match, opts);
    if (!l) continue;
    const prev = best.get(l.category);
    if (!prev || cmpEfficiency(l, prev) < 0) best.set(l.category, l);
  }
  const order = new Map(COMBO6_CATEGORIES.map((c, i) => [c.id, i]));
  return [...best.values()].sort((a, b) => order.get(a.category)! - order.get(b.category)!);
}

// ---------------------------------------------------------------------------
// Combinadas
// ---------------------------------------------------------------------------

/** Resultado de una combinada: pata fallada ⇒ 'miss'; todas resueltas ⇒ 'hit' (nulas fuera) o 'void' si todas nulas. */
export function comboResult(results: (CandidateResult | undefined)[]): CandidateResult | undefined {
  if (results.some((r) => r === 'miss')) return 'miss';
  if (!results.length || results.some((r) => r === undefined)) return undefined;
  return results.every((r) => r === 'void') ? 'void' : 'hit';
}

export function makeCombo(legs: Combo6EngineLeg[]): Combo6EngineCombo {
  const sorted = legs.slice().sort((a, b) => Date.parse(a.match.date) - Date.parse(b.match.date) || a.match.matchId.localeCompare(b.match.matchId));
  let prob = 1;
  let book = 1;
  let est = 0;
  let tier = 0;
  for (const l of sorted) {
    prob *= l.prob;
    book *= l.bookOdds;
    if (l.estimated) est++;
    tier += l.match.tier;
  }
  const out: Combo6EngineCombo = {
    legs: sorted,
    prob,
    fairOdds: 1 / Math.max(prob, 1e-12),
    bookOdds: book,
    estimatedLegs: est,
    ev: prob * book - 1,
    categories: new Set(sorted.map((l) => l.category)).size,
    tierSum: tier,
  };
  const r = comboResult(sorted.map((l) => l.result));
  if (r) out.result = r;
  return out;
}

/** ¿Cumple la regla? (partidos distintos, patas, categorías, tope por categoría y ventana de cuota). */
export function satisfiesRule(legs: Combo6EngineLeg[], rule: Combo6Rule = DEFAULT_RULE): boolean {
  if (legs.length < rule.minLegs || legs.length > rule.maxLegs) return false;
  if (new Set(legs.map((l) => l.match.matchId)).size !== legs.length) return false;
  const per = new Map<Combo6Category, number>();
  for (const l of legs) per.set(l.category, (per.get(l.category) ?? 0) + 1);
  if (per.size < rule.minCategories || [...per.values()].some((n) => n > rule.maxPerCategory)) return false;
  const lnOdds = legs.reduce((s, l) => s + Math.log(l.bookOdds), 0);
  return lnOdds >= Math.log(rule.targetMin) - EPS && lnOdds <= Math.log(rule.targetMax) + EPS;
}

const firstKick = (legs: Combo6EngineLeg[]) => Math.min(...legs.map((l) => Date.parse(l.match.date)));
const comboKey = (legs: Combo6EngineLeg[]) => legs.map(legKey).sort().join('|');

/**
 * Orden entre dos combinadas válidas: mayor probabilidad (ln, con tolerancia), mayor suma de prestigio, primer saque
 * más temprano y clave. < 0 si `a` es mejor.
 */
export function cmpCombos(a: Combo6EngineLeg[], b: Combo6EngineLeg[]): number {
  const la = a.reduce((s, l) => s + Math.log(l.prob), 0);
  const lb = b.reduce((s, l) => s + Math.log(l.prob), 0);
  if (Math.abs(la - lb) > TIE) return lb - la;
  const ta = a.reduce((s, l) => s + l.match.tier, 0);
  const tb = b.reduce((s, l) => s + l.match.tier, 0);
  if (ta !== tb) return tb - ta;
  return firstKick(a) - firstKick(b) || comboKey(a).localeCompare(comboKey(b));
}

/** Conjunto de búsqueda: las `perCategory` patas más eficientes de cada categoría, por eficiencia. */
export function searchPool(legs: Combo6EngineLeg[], perCategory = POOL_PER_CATEGORY): Combo6EngineLeg[] {
  const byCat = new Map<Combo6Category, Combo6EngineLeg[]>();
  for (const l of legs) {
    const arr = byCat.get(l.category);
    if (arr) arr.push(l);
    else byCat.set(l.category, [l]);
  }
  const out: Combo6EngineLeg[] = [];
  for (const arr of byCat.values()) out.push(...arr.sort(cmpEfficiency).slice(0, perCategory));
  return out.sort(cmpEfficiency);
}

function noComboReason(legs: Combo6EngineLeg[], rule: Combo6Rule): string {
  const matches = new Set(legs.map((l) => l.match.matchId)).size;
  const cats = new Set(legs.map((l) => l.category)).size;
  const band = `entre el ${Math.round(LEG_MIN_PROB * 100)} % y el ${Math.round(LEG_MAX_PROB * 100)} %`;
  if (matches < rule.minLegs) {
    return matches === 0
      ? `Ningún partido tiene una selección validada con probabilidad ${band}.`
      : `Solo ${matches} ${matches === 1 ? 'partido tiene' : 'partidos tienen'} alguna selección validada con probabilidad ${band}; hacen falta al menos ${rule.minLegs}.`;
  }
  if (cats < rule.minCategories) return `Las selecciones disponibles (${matches} partidos) son de ${cats} ${cats === 1 ? 'categoría' : 'categorías'} y hacen falta ${rule.minCategories} distintas.`;
  return `Ninguna combinación de ${rule.minLegs} a ${rule.maxLegs} patas (una por partido, ${rule.minCategories} categorías o más y como mucho ${rule.maxPerCategory} por categoría) da una cuota entre ${rule.targetMin} y ${rule.targetMax}.`;
}

/**
 * La combinada de MAYOR probabilidad que cumple la regla (ramificación y poda; ver la cabecera). `legs`: patas
 * candidatas de varios partidos (como mucho una por partido y categoría, matchLegs).
 */
export function searchCombo6(legs: Combo6EngineLeg[], rule: Combo6Rule = DEFAULT_RULE): Combo6Search {
  const pool = searchPool(legs, rule.poolPerCategory);
  const n = pool.length;
  const g = pool.map((l) => Math.log(l.bookOdds));
  const c = pool.map((l) => -Math.log(Math.max(l.prob, 1e-12)));
  const ratio = c.map((ci, i) => ci / g[i]);
  // π = −ln(p·cuota) = coste − ln(cuota): el «margen» que paga cada pata (constante por categoría si la cuota es estimada)
  const pi = c.map((ci, i) => ci - g[i]);
  const R = rule.maxLegs;
  const sufMaxG = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) sufMaxG[i] = Math.max(g[i], sufMaxG[i + 1]);
  // minPi[j][r]: suma de los r menores π entre las patas j..n−1 (Infinity si no hay r)
  const minPi: Float64Array[] = [];
  for (let j = 0; j <= n; j++) {
    const sorted = pi.slice(j).sort((a, b) => a - b);
    const arr = new Float64Array(R + 1).fill(Infinity);
    arr[0] = 0;
    for (let r = 1, s = 0; r <= R && r <= sorted.length; r++) arr[r] = s += sorted[r - 1];
    minPi.push(arr);
  }
  const L = Math.log(rule.targetMin) - EPS;
  const U = Math.log(rule.targetMax) + EPS;
  const slack = TIE - Math.max(0, rule.tolerance);

  let best: Combo6EngineLeg[] | undefined;
  let bestCost = Infinity;
  let nodes = 0;
  let aborted = false;
  const pick: number[] = [];
  const usedMatch = new Set<string>();
  const perCat = new Map<Combo6Category, number>();

  const consider = (cost: number) => {
    const legsNow = pick.map((i) => pool[i]);
    if (!best || cost < bestCost - TIE || (Math.abs(cost - bestCost) <= TIE && cmpCombos(legsNow, best) < 0)) {
      best = legsNow;
      bestCost = Math.min(bestCost, cost);
    }
  };

  const rec = (start: number, cost: number, gain: number) => {
    if (++nodes > rule.nodeLimit) {
      aborted = true;
      return;
    }
    const k = pick.length;
    const distinct = perCat.size;
    if (k >= rule.minLegs && distinct >= rule.minCategories && gain >= L && gain <= U) consider(cost);
    if (k >= rule.maxLegs) return;
    const slots = rule.maxLegs - k;
    if (slots < rule.minCategories - distinct) return;
    const need = L - gain;
    const rBase = Math.max(1, rule.minLegs - k, rule.minCategories - distinct);
    for (let j = start; j < n; j++) {
      if (aborted) return;
      // cotas inferiores del coste de cualquier ampliación con patas de j en adelante (no decrecen con j ⇒ break):
      //  - patas necesarias: las mínimas por regla y las que hacen falta para llegar a ln 6 con la mayor ln(cuota) restante
      //  - coste añadido = Σ ln(cuota) + Σ π >= lo que falta + la suma de los r menores π restantes
      //  - mochila fraccionaria: lo que falta × el menor −ln p / ln cuota restante
      const rMin = need > 0 ? Math.max(rBase, Math.ceil(need / sufMaxG[j] - 1e-9)) : rBase;
      if (rMin > slots) break;
      let addPi = Infinity;
      for (let r = rMin; r <= slots; r++) if (minPi[j][r] < addPi) addPi = minPi[j][r];
      if (cost + Math.max(need, 0) + addPi > bestCost + slack) break;
      if (need > 0 && cost + need * ratio[j] > bestCost + slack) break;
      if (need <= 0 && cost + c[j] > bestCost + slack) continue;
      if (gain + g[j] > U) continue;
      const l = pool[j];
      if (usedMatch.has(l.match.matchId)) continue;
      const cc = perCat.get(l.category) ?? 0;
      if (cc >= rule.maxPerCategory) continue;
      // si no suma categoría nueva, después deben quedar huecos para las que faltan
      if (cc > 0 && slots - 1 < rule.minCategories - distinct) continue;
      pick.push(j);
      usedMatch.add(l.match.matchId);
      perCat.set(l.category, cc + 1);
      rec(j + 1, cost + c[j], gain + g[j]);
      pick.pop();
      usedMatch.delete(l.match.matchId);
      if (cc === 0) perCat.delete(l.category);
      else perCat.set(l.category, cc);
    }
  };
  rec(0, 0, 0);
  const out: Combo6Search = { nodes, pool: n, exact: !aborted };
  if (best) out.combo = makeCombo(best);
  else out.reason = noComboReason(legs, rule);
  return out;
}

export interface DayCombos {
  main: Combo6Search;
  /** competiciones continentales con >= COMPETITION_MIN_MATCHES partidos con alguna pata */
  byCompetition: { compId: string; search: Combo6Search }[];
}

/** Combinada del día (todas las competiciones) y por competición continental. */
export function dayCombos(
  legs: Combo6EngineLeg[],
  opts: { rule?: Combo6Rule; continental?: readonly string[]; minCompMatches?: number; withCompetitions?: boolean } = {},
): DayCombos {
  const rule = opts.rule ?? DEFAULT_RULE;
  const out: DayCombos = { main: searchCombo6(legs, rule), byCompetition: [] };
  if (opts.withCompetitions === false) return out;
  for (const compId of opts.continental ?? CONTINENTAL_IDS) {
    const own = legs.filter((l) => l.match.compId === compId);
    if (new Set(own.map((l) => l.match.matchId)).size < (opts.minCompMatches ?? COMPETITION_MIN_MATCHES)) continue;
    out.byCompetition.push({ compId, search: searchCombo6(own, rule) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Historial walk-forward
// ---------------------------------------------------------------------------

export interface Combo6WfDay {
  /** día local YYYY-MM-DD */
  date: string;
  /** partidos evaluados ese día y con alguna pata */
  matches: number;
  eligibleMatches: number;
  legs: Combo6EngineLeg[];
  search: Combo6Search;
}

export interface Combo6CategoryStats {
  category: Combo6Category;
  legs: number;
  hits: number;
  voids: number;
  hitRate: number;
  expectedHitRate: number;
}

export interface Combo6Record {
  days: number;
  combos: number;
  settled: number;
  hits: number;
  voids: number;
  hitRate: number;
  wilsonLow: number;
  wilsonHigh: number;
  expectedHitRate: number;
  avgLegs: number;
  avgBookOdds: number;
  avgFairOdds: number;
  longestLosingStreak: number;
  byCategory: Combo6CategoryStats[];
}

export interface Combo6WalkForward {
  from: string;
  to: string;
  /** días evaluados en [from, to), cronológicos */
  days: Combo6WfDay[];
  /** patas walk-forward de TODOS los partidos de los tramos (también los de hoy, ya terminados) */
  legsByMatch: Map<string, Combo6EngineLeg[]>;
  record: Combo6Record;
}

export interface Combo6WfOptions {
  timeZone: string;
  /** primer día evaluado (YYYY-MM-DD, incluido) y primer día NO evaluado (normalmente hoy) */
  from?: string;
  to?: string;
  /** prestigio de una competición (por defecto 5) */
  tierOf?: (compId: string) => number;
  rule?: Combo6Rule;
  legs?: LegOptions;
}

/** Récord de unas combinadas (cronológicas): aciertos, Wilson, previsto, medias, racha y acierto por categoría. */
export function combo6Record(combos: Combo6EngineCombo[], days: number): Combo6Record {
  let settled = 0;
  let hits = 0;
  let voids = 0;
  let sp = 0;
  let sl = 0;
  let sb = 0;
  let sf = 0;
  let streak = 0;
  let longest = 0;
  const cat = new Map<Combo6Category, { legs: number; hits: number; voids: number; sp: number }>();
  for (const co of combos) {
    sl += co.legs.length;
    sb += co.bookOdds;
    sf += co.fairOdds;
    for (const l of co.legs) {
      const a = cat.get(l.category) ?? { legs: 0, hits: 0, voids: 0, sp: 0 };
      if (l.result === 'void') a.voids++;
      else if (l.result === 'hit' || l.result === 'miss') {
        a.legs++;
        a.sp += l.prob;
        if (l.result === 'hit') a.hits++;
      }
      cat.set(l.category, a);
    }
    if (co.result === 'void') {
      voids++;
      continue;
    }
    if (co.result !== 'hit' && co.result !== 'miss') continue;
    settled++;
    sp += co.prob;
    if (co.result === 'hit') {
      hits++;
      streak = 0;
    } else longest = Math.max(longest, ++streak);
  }
  const [lo, hi] = wilsonInterval(hits, settled, WILSON_Z90);
  const byCategory: Combo6CategoryStats[] = [];
  for (const { id } of COMBO6_CATEGORIES) {
    const a = cat.get(id);
    if (!a || !(a.legs + a.voids > 0)) continue;
    byCategory.push({ category: id, legs: a.legs, hits: a.hits, voids: a.voids, hitRate: a.legs ? a.hits / a.legs : 0, expectedHitRate: a.legs ? a.sp / a.legs : 0 });
  }
  const nc = combos.length;
  return {
    days,
    combos: nc,
    settled,
    hits,
    voids,
    hitRate: settled ? hits / settled : 0,
    wilsonLow: lo,
    wilsonHigh: hi,
    expectedHitRate: settled ? sp / settled : 0,
    avgLegs: nc ? sl / nc : 0,
    avgBookOdds: nc ? sb / nc : 0,
    avgFairOdds: nc ? sf / nc : 0,
    longestLosingStreak: longest,
    byCategory,
  };
}

/**
 * La regla del día aplicada a cada día pasado [from, to) con los candidatos walk-forward de los tramos mensuales:
 * en el tramo k, las reglas publicadas de ese tramo (existentes `base.foldRules[k].published` + adicionales del tramo
 * con el mismo inicio), ajustadas con los meses anteriores y validadas con los tramos anteriores. Cada día local usa
 * las reglas del tramo de su PRIMER partido (un día puede cruzar el inicio UTC de un tramo). Nunca usa resultados del
 * propio día ni posteriores para elegir.
 */
export function combo6WalkForward(base: WalkForwardResult, extra: WalkForwardResult | undefined, opts: Combo6WfOptions): Combo6WalkForward {
  const rule = opts.rule ?? DEFAULT_RULE;
  const tierOf = opts.tierOf ?? (() => 5);
  const extraById = new Map((extra?.items ?? []).map((it) => [it.matchId, it]));
  const extraFoldByStart = new Map((extra?.folds ?? []).map((f, k) => [f.start, k]));
  const starts = base.folds.map((f) => Date.parse(f.start));
  const rulesCache = new Map<number, ConfidenceRules>();
  const rulesOf = (k: number) => {
    let r = rulesCache.get(k);
    if (!r) {
      const ek = extraFoldByStart.get(base.folds[k].start);
      const baseRules = base.foldRules[k].published;
      r = ek !== undefined && extra ? mergeRules(baseRules, extra.foldRules[ek].published) : baseRules;
      rulesCache.set(k, r);
    }
    return r;
  };
  // partidos por día local, con el tramo de cada uno
  const byDayItems = new Map<string, { it: WalkForwardResult['items'][number]; k: number; t: number }[]>();
  for (let k = 0; k < base.folds.length; k++) {
    const start = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : Infinity;
    for (const it of base.items) {
      const t = Date.parse(it.date);
      if (!(t >= start && t < end)) continue;
      const day = localDay(t, opts.timeZone);
      const arr = byDayItems.get(day);
      if (arr) arr.push({ it, k, t });
      else byDayItems.set(day, [{ it, k, t }]);
    }
  }
  // Un día local puede cruzar el inicio (UTC) de un tramo: en Europe/Madrid, el día 1 empieza a las 22:00/23:00 UTC
  // del día anterior y las reglas del tramo nuevo se ajustan CON esos partidos del mismo día. La combinada se decide
  // antes del primer partido, así que TODO el día usa las reglas del tramo de su primer partido (sin fuga del propio día).
  const legsByMatch = new Map<string, Combo6EngineLeg[]>();
  const byDay = new Map<string, { matches: number; legs: Combo6EngineLeg[] }>();
  for (const [day, arr] of byDayItems) {
    const rules = rulesOf(Math.min(...arr.map((x) => x.k)));
    const d = { matches: 0, legs: [] as Combo6EngineLeg[] };
    for (const { it } of arr.sort((a, b) => a.t - b.t || a.it.matchId.localeCompare(b.it.matchId))) {
      const cands = [...it.candidates, ...(extraById.get(it.matchId)?.candidates ?? [])];
      const legs = matchLegs(cands, rules, { matchId: it.matchId, compId: it.compId, date: it.date, tier: tierOf(it.compId) }, opts.legs);
      legsByMatch.set(it.matchId, legs);
      d.matches++;
      d.legs.push(...legs);
    }
    byDay.set(day, d);
  }
  const days: Combo6WfDay[] = [];
  for (const date of [...byDay.keys()].sort()) {
    if ((opts.from && date < opts.from) || (opts.to && date >= opts.to)) continue;
    const d = byDay.get(date)!;
    days.push({ date, matches: d.matches, eligibleMatches: new Set(d.legs.map((l) => l.match.matchId)).size, legs: d.legs, search: searchCombo6(d.legs, rule) });
  }
  const combos = days.flatMap((d) => (d.search.combo ? [d.search.combo] : []));
  return { from: days[0]?.date ?? '', to: days[days.length - 1]?.date ?? '', days, legsByMatch, record: combo6Record(combos, days.length) };
}

/** Aviso automático (español) si el historial acierta muy por debajo de lo previsto; undefined si no. */
export function combo6Warning(r: Pick<Combo6Record, 'settled' | 'hits' | 'hitRate' | 'wilsonHigh' | 'expectedHitRate'>): string | undefined {
  if (r.settled < WARNING_MIN_N || !(r.expectedHitRate > 0)) return undefined;
  if (r.wilsonHigh >= WARNING_RATIO * r.expectedHitRate) return undefined;
  const pct = (x: number) => `${(Math.round(x * 1000) / 10).toLocaleString('es-ES')} %`;
  return `Aviso: en el historial la combinada acertó ${r.hits} de ${r.settled} (${pct(r.hitRate)}) cuando el modelo esperaba un ${pct(r.expectedHitRate)}: las probabilidades de las patas son optimistas en combinada y el «1 de cada N» se queda corto.`;
}
