/**
 * Pronósticos de ALTA CONFIANZA: selecciones MUY PROBABLES Y DE CUOTA BAJA cuyo acierto, medido walk-forward y sin fuga
 * de datos, supera el 80 %. No mejora el 1X2 (que acierta ~52 %, como el mercado) ni es una ventaja frente a la casa:
 * casi todo el acierto es estructural (una estrategia fija sin modelo —el visitante marca menos de 3 + más de 1,5
 * tarjetas— acierta ~88 % en los mismos partidos; ver fixedBaseline y el lift por familia). Cuota justa media ~1,12; con
 * cuotas de cierre el ROI es negativo.
 *
 * API (probabilidades en [0, 1], cuotas decimales, textos en español):
 *
 *   confidenceCandidates(input, opts) → ConfidenceCandidate[]
 *       Candidatos de un partido a partir de su predicción: 1X2 del ensamble (resultado, doble oportunidad, empate no
 *       apuesta), matriz de marcadores con los λ finales (goles, ambos marcan, goles por equipo, hándicap +1.5) y
 *       proyecciones binomial negativa (córners y tarjetas). Como mucho UNO por familia: el más probable dentro de
 *       [minProb = 0.5, maxProb = 0.93] (por encima, cuota justa < 1.075: trivial, la casa no lo ofrecería).
 *       Familias (ids estables, CONFIDENCE_FAMILIES): 1x2-fav, dc, dnb, ah+1.5, ou-1.5-over, ou-2.5-over, ou-2.5-under,
 *       ou-3.5-under, ou-4.5-under, btts-yes, btts-no, team-score, team-under-1.5, team-under-2.5, corners-over-6.5,
 *       corners-over-7.5, corners-over-8.5, corners-under-11.5, corners-under-12.5, cards-over-1.5, cards-over-2.5,
 *       cards-under-5.5, cards-under-6.5. No hay "ah+0.5"/"ah-0.5": con medias líneas son exactamente doble
 *       oportunidad y 1X2 (no aportan). cards-over-2.5 se genera pero está excluida de las reglas (EXCLUDED_RULES).
 *       segment: 'mercado' si la predicción usa el 1X2 sin margen de la casa (80 % del ensamble), 'estadistico' si no
 *       (Dixon-Coles + Elo): son modelos distintos y se calibran por separado.
 *       Historial suficiente: sin cuotas, resultado y goles exigen >= minTeamGames (10) partidos Elo previos de cada
 *       equipo; córners/tarjetas exigen >= minStatGames (5) partidos previos con el dato de cada equipo.
 *       marketOdds: precio de la casa (1X2, su línea de goles, su hándicap ±1.5) o sintético desde el 1X2 (doble
 *       oportunidad y empate no apuesta: reparto proporcional entre resultados, realizable). oddsKind dice cuál.
 *   baselineCandidates(input) → la selección natural de cada familia SIN umbral (tasa base de la familia).
 *   candidatesFromPrediction(match, prediction, projections, { history }) → candidatos (envoltorio para el build)
 *   upcomingCandidates(ctx, match) → candidatos de un partido PRÓXIMO con la predicción publicada (fullPrediction)
 *   settleCandidate(candidate, settleDataOf(match)) → 'hit' | 'miss' | 'void' | undefined (sin datos para resolver)
 *       Empate no apuesta: el empate es 'void' (se devuelve) y no cuenta ni como acierto ni como fallo.
 *       Prórroga o penaltis: goles a 90 minutos con los eventos de gol (si no cuadran con el marcador, el partido se
 *       excluye) y sin córners ni tarjetas. Un total de 0 tarjetas es un dato ausente.
 *
 *   walkForwardCandidates(ctx, match) → candidatos de un partido TERMINADO solo con información anterior a su
 *       inicio (ver la función). undefined si falta alguna pieza sin fuga (el partido no se evalúa).
 *   confidenceHistory(ctx) → ConfidenceHistoryItem[]  (partidos terminados de la temporada actual, resueltos, con la
 *       selección natural de cada familia para las tasas base)
 *
 *   confidenceRulesFrom(history, opts) → ConfidenceRules   (una regla por familia y fuente)
 *       Método 'platt' (por defecto): recalibración logística q = σ(a + b·logit(p)) ajustada con `history` (>= 150
 *       candidatos resueltos, pendiente >= 0.25). El umbral parte de la prob. del modelo cuya q llega a targetRate
 *       (0.82) y debe cumplir en la cola (prob >= umbral): acierto >= 0.82, n >= 80 y límite inferior de Wilson al
 *       90 % (z = 1.645) >= 0.78; si no, se sube por la rejilla 0.50–0.93. Umbral oro: q >= 0.87 y cola con acierto
 *       >= 0.87, n >= 60, Wilson >= 0.83. Lo que no cumple se descarta (rules.rejected, con el motivo).
 *   fitConfidenceProcedure(history, opts) → { rules, chosen, log }
 *       Procedimiento pre-registrado que elige la exigencia SOLO con `history`: validación interna con ventana
 *       creciente (último 40 % de `history` en 3 tramos por día; cada tramo con reglas ajustadas con todo lo anterior)
 *       sobre la escalera objetivo/Wilson 0.82/0.78 → 0.84/0.80 → 0.86/0.82 → 0.88/0.84. En cada nivel se quitan las
 *       reglas (familia|fuente) que en validación aciertan < 0.78 con n >= 30 y se acepta el primer nivel cuya
 *       validación conjunta acierta >= 0.82 con Wilson >= 0.78 (n >= 100). Después reajusta con todo `history`.
 *       EXCLUDED_RULES (cards-over-2.5) se excluye siempre (decisión documentada con el walk-forward).
 *   selectConfidencePicks(candidates, rules, opts) → ConfidencePick[]
 *       Candidatos que superan el umbral de su regla y cuya franja acierta >= GOLD_MIN_RATE (0,85) en el histórico
 *       de la regla (solo nivel 'oro'; 'plata' queda en el tipo por compatibilidad); como mucho maxPerMatch (2) por
 *       partido, de temas distintos (resultado / goles / córners / tarjetas), ordenados por probabilidad recalibrada.
 *   walkForwardConfidence(history) → walk-forward mensual de TODO el procedimiento (desde el primer mes con >= 1.000
 *       partidos anteriores) y validación por regla: ruleValidation + filterValidatedRules publican solo reglas con
 *       >= 30 picks y >= 80 % fuera de muestra acumulados en los tramos anteriores.
 *   fixedBaseline(items) / familyBaseRates(items) → líneas base sin umbral; confidenceReport añade el lift.
 *
 *   evaluateConfidence(ctx, opts) → ConfidenceEvaluation  (reutilizable por el build; ~15 s con los datos reales)
 *       1. Historial walk-forward (o opts.history).
 *       2. Corte temporal por día UTC: CALIBRACIÓN = 60 % más antiguo de los partidos; HOLDOUT = el resto, nunca usado
 *          para ajustar umbrales; tramo final = 15 % final del total (dentro del holdout).
 *       3. fitConfidenceProcedure(calibración), validadas con los tramos walk-forward ANTERIORES al holdout →
 *          calibrationRules; se miden en el holdout (picks, aciertos, %, Wilson, línea base sin modelo, tasa base y
 *          lift por familia, por fuente y competición, cobertura, cuota justa media y ROI plano con cuotas de cierre).
 *       4. Walk-forward mensual del procedimiento completo (reglas reajustadas cada mes y validadas con lo anterior).
 *       5. rules = fitConfidenceProcedure(TODO el historial) validadas con TODO el walk-forward: producción.
 *       6. recentSettled = picks publicados del walk-forward de los últimos 30 días, más recientes primero.
 *
 * Uso en el build: const ev = evaluateConfidence(ctx); para cada partido próximo m:
 *   selectConfidencePicks(upcomingCandidates(ctx, m), ev.rules).
 *
 * Datos de resolución: goles a 90'; córners = suma de ambos equipos; tarjetas = amarillas + rojas de ambos equipos (la
 * misma definición que las proyecciones). Sin esas estadísticas el candidato no se resuelve.
 */
import type { MatchRecord } from '../types';
import type { OddsSnapshot, Prob1X2, StatProjection } from '../../src/types/data';
import { bttsProb, fairOdds, goalDiffDist, marginals, overUnderFromDist, totalGoalsDist } from '../../src/lib/models';
import { isPlausibleMargin, overroundOf } from '../config';
import { eloGamesBefore, predictMatch, type PredictionResult } from './predict';
import { projectMatchStats, type StatContext } from './projections';
import { computeWalkForward, isFinishedRecord, statContext, wfContext, type BuildContext } from '../publish/context';
import { settleDataOf, wentBeyond90, type SettleData } from './settle';

export { score90FromEvents, settleDataOf, wentBeyond90, type SettleData } from './settle';
import { fullPrediction } from '../publish/matches';

const DAY_MS = 86_400_000;
const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Familias
// ---------------------------------------------------------------------------

export type ConfidenceTheme = 'resultado' | 'goles' | 'corners' | 'tarjetas';

export const CONFIDENCE_FAMILIES = [
  { id: '1x2-fav', theme: 'resultado', label: 'Gana el favorito' },
  { id: 'dc', theme: 'resultado', label: 'Doble oportunidad' },
  { id: 'dnb', theme: 'resultado', label: 'Empate no apuesta' },
  { id: 'ah+1.5', theme: 'resultado', label: 'Hándicap asiático +1.5' },
  { id: 'ou-1.5-over', theme: 'goles', label: 'Más de 1.5 goles' },
  { id: 'ou-2.5-over', theme: 'goles', label: 'Más de 2.5 goles' },
  { id: 'ou-2.5-under', theme: 'goles', label: 'Menos de 2.5 goles' },
  { id: 'ou-3.5-under', theme: 'goles', label: 'Menos de 3.5 goles' },
  { id: 'ou-4.5-under', theme: 'goles', label: 'Menos de 4.5 goles' },
  { id: 'btts-yes', theme: 'goles', label: 'Ambos marcan: sí' },
  { id: 'btts-no', theme: 'goles', label: 'Ambos marcan: no' },
  { id: 'team-score', theme: 'goles', label: 'Un equipo marca' },
  { id: 'team-under-1.5', theme: 'goles', label: 'Un equipo marca menos de 2' },
  { id: 'team-under-2.5', theme: 'goles', label: 'Un equipo marca menos de 3' },
  { id: 'corners-over-6.5', theme: 'corners', label: 'Más de 6.5 córners' },
  { id: 'corners-over-7.5', theme: 'corners', label: 'Más de 7.5 córners' },
  { id: 'corners-over-8.5', theme: 'corners', label: 'Más de 8.5 córners' },
  { id: 'corners-under-11.5', theme: 'corners', label: 'Menos de 11.5 córners' },
  { id: 'corners-under-12.5', theme: 'corners', label: 'Menos de 12.5 córners' },
  { id: 'cards-over-1.5', theme: 'tarjetas', label: 'Más de 1.5 tarjetas' },
  { id: 'cards-over-2.5', theme: 'tarjetas', label: 'Más de 2.5 tarjetas' },
  { id: 'cards-under-5.5', theme: 'tarjetas', label: 'Menos de 5.5 tarjetas' },
  { id: 'cards-under-6.5', theme: 'tarjetas', label: 'Menos de 6.5 tarjetas' },
] as const satisfies readonly { id: string; theme: ConfidenceTheme; label: string }[];

export type ConfidenceFamily = (typeof CONFIDENCE_FAMILIES)[number]['id'];
export const FAMILY_BY_ID: ReadonlyMap<ConfidenceFamily, (typeof CONFIDENCE_FAMILIES)[number]> = new Map(
  CONFIDENCE_FAMILIES.map((f) => [f.id, f]),
);

/** Cómo se resuelve una selección con el resultado real. */
export type ConfidenceSettle =
  | { kind: 'outcome'; win: ('home' | 'draw' | 'away')[] }
  | { kind: 'dnb'; side: 'home' | 'away' }
  | { kind: 'handicap'; side: 'home' | 'away'; line: number }
  | { kind: 'total'; stat: 'goals' | 'corners' | 'cards'; side: 'over' | 'under'; line: number }
  | { kind: 'team-total'; team: 'home' | 'away'; side: 'over' | 'under'; line: number }
  | { kind: 'btts'; yes: boolean };

export interface ConfidenceCandidate {
  family: ConfidenceFamily;
  theme: ConfidenceTheme;
  /** id de mercado con el mismo esquema que las fichas de partido ('1x2', 'dc', 'ou-2.5', 'team-home-ou-0.5', 'corners-ou-7.5'...) */
  marketId: string;
  /** nombre del mercado en español */
  market: string;
  /** selección en español, con nombres de equipos */
  selection: string;
  /** probabilidad del modelo (empate no apuesta: condicionada a que no haya empate) */
  prob: number;
  fairOdds: number;
  /** cuota de la casa (cierre en partidos terminados) */
  marketOdds?: number;
  /** 'directa' = precio publicado; 'sintetica' = combinación de precios 1X2 (reparto proporcional), realizable */
  oddsKind?: 'directa' | 'sintetica';
  settle: ConfidenceSettle;
  /**
   * fuente de la predicción: 'mercado' = el ensamble incluye el 1X2 sin margen de la casa (80 % de peso);
   * 'estadistico' = sin cuotas (Dixon-Coles + Elo). Son modelos distintos y se calibran por separado.
   */
  segment: ConfidenceSegment;
}

export type ConfidenceSegment = 'mercado' | 'estadistico';

export interface CandidateInput {
  homeName: string;
  awayName: string;
  /** 1X2 final del ensamble */
  p: Prob1X2;
  /** matriz de marcadores con los λ finales ([i][j] = P(local i, visitante j)) */
  matrix: number[][];
  /** proyecciones NB (se usan 'corners' y 'cards') */
  projections?: StatProjection[];
  /** cuotas (cierre en partidos terminados; actuales en próximos) */
  odds?: OddsSnapshot;
  /** si la predicción usó el mercado (por defecto: hay un trío 1X2 válido en `odds`) */
  withMarket?: boolean;
  /** partidos Elo previos del equipo con menos historial (undefined = no se comprueba) */
  minEloGames?: number;
  /** partidos previos con córners / tarjetas del equipo con menos historial (undefined = no se comprueba) */
  statGames?: { corners?: number; cards?: number };
}

export interface CandidateOptions {
  /** por encima: selección trivial (cuota justa < 1/maxProb), se descarta. Default 0.93 */
  maxProb?: number;
  /** por debajo: no es de alta confianza. Default 0.5 */
  minProb?: number;
  /**
   * sin cuotas, resultado y goles exigen que ambos equipos tengan al menos estos partidos Elo previos (equipos de copa
   * de categorías no cubiertas, recién llegados: el modelo apenas los conoce). Default 10 (= MODEL.lowDataGames)
   */
  minTeamGames?: number;
  /** córners y tarjetas exigen al menos estos partidos previos con la estadística de cada equipo. Default 5 */
  minStatGames?: number;
}

export const DEFAULT_MAX_PROB = 0.93;
export const DEFAULT_MIN_PROB = 0.5;
export const DEFAULT_MIN_TEAM_GAMES = 10;
export const DEFAULT_MIN_STAT_GAMES = 5;

function validPrice(o: number | undefined): o is number {
  return typeof o === 'number' && Number.isFinite(o) && o > 1 && o < 1000;
}

function sameLine(a: number | undefined, b: number): boolean {
  return typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) < 1e-6;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
}

/** Trío 1X2 válido (precios > 1 y margen plausible). */
function trio(odds: OddsSnapshot | undefined): { home: number; draw: number; away: number } | undefined {
  if (!odds || !validPrice(odds.home) || !validPrice(odds.draw) || !validPrice(odds.away)) return undefined;
  if (!isPlausibleMargin(overroundOf(odds.home, odds.draw, odds.away))) return undefined;
  return { home: odds.home, draw: odds.draw, away: odds.away };
}

/** Par más/menos válido de la casa en una línea. */
function ouPair(odds: OddsSnapshot | undefined, line: number): { over: number; under: number } | undefined {
  if (!odds || !sameLine(odds.totalLine, line) || !validPrice(odds.over) || !validPrice(odds.under)) return undefined;
  if (!isPlausibleMargin(overroundOf(odds.over, odds.under))) return undefined;
  return { over: odds.over, under: odds.under };
}

/** Cuota sintética de dos resultados 1X2 (reparto proporcional a 1/cuota): 1 / (1/a + 1/b). */
export function syntheticDoubleOdds(a: number, b: number): number {
  return 1 / (1 / a + 1 / b);
}

/** Cuota sintética de empate no apuesta: apostar 1 − 1/cuotaEmpate al equipo y 1/cuotaEmpate al empate. */
export function syntheticDnbOdds(team: number, draw: number): number {
  return team * (1 - 1 / draw);
}

function candRaw(
  segment: ConfidenceSegment,
  family: ConfidenceFamily,
  marketId: string,
  market: string,
  selection: string,
  prob: number,
  settle: ConfidenceSettle,
  price?: { odds: number | undefined; kind: 'directa' | 'sintetica' },
): ConfidenceCandidate {
  const p = clamp01(prob);
  const c: ConfidenceCandidate = {
    family,
    theme: FAMILY_BY_ID.get(family)!.theme,
    marketId,
    market,
    selection,
    prob: p,
    fairOdds: fairOdds(p),
    settle,
    segment,
  };
  if (price && validPrice(price.odds)) {
    c.marketOdds = Math.round(price.odds * 1000) / 1000;
    c.oddsKind = price.kind;
  }
  return c;
}

function tailFrom(dist: number[], k: number): number {
  let s = 0;
  for (let i = k; i < dist.length; i++) s += dist[i];
  return s;
}

function sumTo(dist: number[], k: number): number {
  let s = 0;
  for (let i = 0; i <= k && i < dist.length; i++) s += dist[i];
  return s;
}

/**
 * Candidatos de un partido (como mucho uno por familia: el más probable no trivial). Probabilidades del 1X2 del
 * ensamble para resultado/doble oportunidad/empate no apuesta; de la matriz para goles y hándicap; de las
 * proyecciones NB para córners y tarjetas.
 */
export function confidenceCandidates(input: CandidateInput, opts: CandidateOptions = {}): ConfidenceCandidate[] {
  const maxProb = opts.maxProb ?? DEFAULT_MAX_PROB;
  const minProb = opts.minProb ?? DEFAULT_MIN_PROB;
  const H = input.homeName?.trim() || 'Local';
  const A = input.awayName?.trim() || 'Visitante';
  const all: ConfidenceCandidate[] = [];
  const p = input.p;
  const okP = [p?.home, p?.draw, p?.away].every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0);
  const sumP = okP ? p.home + p.draw + p.away : 0;
  const odds = input.odds;
  const t3 = trio(odds);
  const segment: ConfidenceSegment = (input.withMarket ?? !!t3) ? 'mercado' : 'estadistico';
  // historial suficiente: sin mercado, el resultado y los goles dependen solo de lo que el modelo sabe de los equipos
  const minTeam = opts.minTeamGames ?? DEFAULT_MIN_TEAM_GAMES;
  const goalsOk = segment === 'mercado' || input.minEloGames === undefined || input.minEloGames >= minTeam;
  const minStat = opts.minStatGames ?? DEFAULT_MIN_STAT_GAMES;
  const statOk = (k: 'corners' | 'cards') => {
    const n = input.statGames?.[k];
    return input.statGames === undefined || (n !== undefined && n >= minStat);
  };
  const cand = (...args: Parameters<typeof candRaw> extends [ConfidenceSegment, ...infer R] ? R : never) => candRaw(segment, ...args);

  // ---- resultado
  if (goalsOk && okP && sumP > 0) {
    const ph = p.home / sumP;
    const pd = p.draw / sumP;
    const pa = p.away / sumP;
    const favHome = ph >= pa;
    const fav = favHome ? H : A;
    all.push(
      cand('1x2-fav', '1x2', 'Resultado final (1X2)', `Gana ${fav}`, favHome ? ph : pa, { kind: 'outcome', win: [favHome ? 'home' : 'away'] }, {
        odds: t3 ? (favHome ? t3.home : t3.away) : undefined,
        kind: 'directa',
      }),
    );
    const dcOdds = (a: number | undefined, b: number | undefined) => (t3 && a && b ? syntheticDoubleOdds(a, b) : undefined);
    all.push(
      cand('dc', 'dc', 'Doble oportunidad', `${H} o empate (1X)`, ph + pd, { kind: 'outcome', win: ['home', 'draw'] }, { odds: dcOdds(t3?.home, t3?.draw), kind: 'sintetica' }),
      cand('dc', 'dc', 'Doble oportunidad', `${H} o ${A} (12)`, ph + pa, { kind: 'outcome', win: ['home', 'away'] }, { odds: dcOdds(t3?.home, t3?.away), kind: 'sintetica' }),
      cand('dc', 'dc', 'Doble oportunidad', `Empate o ${A} (X2)`, pd + pa, { kind: 'outcome', win: ['draw', 'away'] }, { odds: dcOdds(t3?.draw, t3?.away), kind: 'sintetica' }),
    );
    const nd = ph + pa;
    if (nd > 0) {
      for (const side of ['home', 'away'] as const) {
        const name = side === 'home' ? H : A;
        const prob = (side === 'home' ? ph : pa) / nd;
        all.push(
          cand('dnb', 'dnb', 'Empate no apuesta', `${name} (si empatan, se devuelve)`, prob, { kind: 'dnb', side }, {
            odds: t3 ? syntheticDnbOdds(side === 'home' ? t3.home : t3.away, t3.draw) : undefined,
            kind: 'sintetica',
          }),
        );
      }
    }
  }

  // ---- goles (matriz)
  const m = input.matrix;
  const okM = goalsOk && Array.isArray(m) && m.length > 1 && m.every((r) => Array.isArray(r) && r.every((v) => Number.isFinite(v) && v >= 0));
  if (okM) {
    const total = totalGoalsDist(m);
    const diff = goalDiffDist(m);
    const pDiff = (pred: (d: number) => boolean) => diff.p.reduce((s, v, k) => (pred(diff.min + k) ? s + v : s), 0);
    // hándicap +1.5: el equipo no pierde por 2 o más
    const homePlus = pDiff((d) => d >= -1);
    const awayPlus = pDiff((d) => d <= 1);
    // la casa da el hándicap del local: spreadLine −1.5 ⇒ visitante +1.5 (spreadAway); +1.5 ⇒ local +1.5 (spreadHome)
    all.push(
      cand('ah+1.5', 'ah-home-1.5', `Hándicap asiático ${H} +1.5`, `${H} +1.5`, homePlus, { kind: 'handicap', side: 'home', line: 1.5 }, {
        odds: sameLine(odds?.spreadLine, 1.5) ? odds?.spreadHome : undefined,
        kind: 'directa',
      }),
      cand('ah+1.5', 'ah-home--1.5', `Hándicap asiático ${H} -1.5`, `${A} +1.5`, awayPlus, { kind: 'handicap', side: 'away', line: 1.5 }, {
        odds: sameLine(odds?.spreadLine, -1.5) ? odds?.spreadAway : undefined,
        kind: 'directa',
      }),
    );
    const ou = (family: ConfidenceFamily, line: number, side: 'over' | 'under') => {
      const k = Math.floor(line);
      const prob = side === 'over' ? tailFrom(total, k + 1) : sumTo(total, k);
      const pair = ouPair(odds, line);
      return cand(
        family,
        `ou-${line}`,
        `Más/Menos ${line} goles`,
        `${side === 'over' ? 'Más' : 'Menos'} de ${line} goles`,
        prob,
        { kind: 'total', stat: 'goals', side, line },
        { odds: pair ? pair[side] : undefined, kind: 'directa' },
      );
    };
    all.push(
      ou('ou-1.5-over', 1.5, 'over'),
      ou('ou-2.5-over', 2.5, 'over'),
      ou('ou-2.5-under', 2.5, 'under'),
      ou('ou-3.5-under', 3.5, 'under'),
      ou('ou-4.5-under', 4.5, 'under'),
    );
    const mg = marginals(m);
    const btts = bttsProb(m);
    all.push(
      cand('btts-yes', 'btts', 'Ambos equipos marcan', 'Ambos marcan: sí', btts, { kind: 'btts', yes: true }),
      cand('btts-no', 'btts', 'Ambos equipos marcan', 'Ambos marcan: no', 1 - btts, { kind: 'btts', yes: false }),
    );
    for (const team of ['home', 'away'] as const) {
      const name = team === 'home' ? H : A;
      const dist = team === 'home' ? mg.home : mg.away;
      all.push(
        cand('team-score', `team-${team}-ou-0.5`, `Goles de ${name}: más/menos 0.5`, `${name} marca al menos un gol`, 1 - (dist[0] ?? 0), {
          kind: 'team-total',
          team,
          side: 'over',
          line: 0.5,
        }),
        cand('team-under-1.5', `team-${team}-ou-1.5`, `Goles de ${name}: más/menos 1.5`, `${name} marca menos de 2 goles`, sumTo(dist, 1), {
          kind: 'team-total',
          team,
          side: 'under',
          line: 1.5,
        }),
        cand('team-under-2.5', `team-${team}-ou-2.5`, `Goles de ${name}: más/menos 2.5`, `${name} marca menos de 3 goles`, sumTo(dist, 2), {
          kind: 'team-total',
          team,
          side: 'under',
          line: 2.5,
        }),
      );
    }
  }

  // ---- córners y tarjetas (proyecciones NB)
  for (const proj of input.projections ?? []) {
    if (proj.key !== 'corners' && proj.key !== 'cards') continue;
    if (!statOk(proj.key)) continue;
    const dist = proj.totalDist;
    if (!Array.isArray(dist) || dist.length < 2 || !dist.every((v) => Number.isFinite(v) && v >= 0)) continue;
    const stat = proj.key;
    const word = stat === 'corners' ? 'córners' : 'tarjetas';
    const label = stat === 'corners' ? 'Córners' : 'Tarjetas';
    const lines: [ConfidenceFamily, number, 'over' | 'under'][] =
      stat === 'corners'
        ? [
            ['corners-over-6.5', 6.5, 'over'],
            ['corners-over-7.5', 7.5, 'over'],
            ['corners-over-8.5', 8.5, 'over'],
            ['corners-under-11.5', 11.5, 'under'],
            ['corners-under-12.5', 12.5, 'under'],
          ]
        : [
            ['cards-over-1.5', 1.5, 'over'],
            ['cards-over-2.5', 2.5, 'over'],
            ['cards-under-5.5', 5.5, 'under'],
            ['cards-under-6.5', 6.5, 'under'],
          ];
    for (const [family, line, side] of lines) {
      const r = overUnderFromDist(dist, line);
      all.push(
        cand(family, `${stat}-ou-${line}`, `${label}: más/menos ${line}`, `${side === 'over' ? 'Más' : 'Menos'} de ${line} ${word}`, r[side], {
          kind: 'total',
          stat,
          side,
          line,
        }),
      );
    }
  }

  // ---- uno por familia: el más probable dentro de [minProb, maxProb]
  const best = new Map<ConfidenceFamily, ConfidenceCandidate>();
  for (const c of all) {
    if (!(c.prob >= minProb - EPS) || c.prob > maxProb + EPS) continue;
    const prev = best.get(c.family);
    if (!prev || c.prob > prev.prob) best.set(c.family, c);
  }
  const order = new Map(CONFIDENCE_FAMILIES.map((f, i) => [f.id as ConfidenceFamily, i]));
  return [...best.values()].sort((a, b) => order.get(a.family)! - order.get(b.family)!);
}

/** Candidatos a partir de la predicción completa del build (predictMatch) y sus proyecciones. */
export function candidatesFromPrediction(
  match: Pick<MatchRecord, 'home' | 'away' | 'odds'>,
  prediction: Pick<PredictionResult, 'quick' | 'matrix' | 'model'>,
  projections: StatProjection[] | undefined,
  opts: CandidateOptions & { history?: Pick<CandidateInput, 'minEloGames' | 'statGames'> } = {},
): ConfidenceCandidate[] {
  return confidenceCandidates(
    {
      homeName: match.home.name,
      awayName: match.away.name,
      p: prediction.quick.p,
      matrix: prediction.matrix,
      projections,
      odds: match.odds,
      withMarket: !!prediction.model.market,
      ...(opts.history ?? {}),
    },
    opts,
  );
}

/** Historial previo de los equipos de un partido (para los requisitos de datos suficientes). */
export function teamHistoryBefore(ctx: BuildContext, m: MatchRecord, sc: StatContext, before: number): Pick<CandidateInput, 'minEloGames' | 'statGames'> {
  const elo = ctx.suite.eloBuild.elo;
  const games = (k: 'corners' | 'cards') =>
    Math.min(sc.teams.get(m.home.id)?.[k]?.n ?? 0, sc.teams.get(m.away.id)?.[k]?.n ?? 0);
  return {
    minEloGames: Math.min(eloGamesBefore(elo, m.home.id, before), eloGamesBefore(elo, m.away.id, before)),
    statGames: { corners: games('corners'), cards: games('cards') },
  };
}

/**
 * Candidatos de un partido PRÓXIMO (o en juego) con los modelos actuales del build: misma predicción que publica la
 * ficha (fullPrediction) y el mismo requisito de historial. Para partidos terminados usa walkForwardCandidates.
 */
export function upcomingCandidates(ctx: BuildContext, m: MatchRecord, opts: CandidateOptions = {}): ConfidenceCandidate[] {
  const fp = fullPrediction(ctx, m, true);
  const sc = statContext(ctx, m.compId);
  const t = Date.parse(m.date);
  return candidatesFromPrediction(m, fp.result, fp.projections, { ...opts, history: teamHistoryBefore(ctx, m, sc, Number.isFinite(t) ? t : ctx.now) });
}

// ---------------------------------------------------------------------------
// Resolución
// ---------------------------------------------------------------------------

export type CandidateResult = 'hit' | 'miss' | 'void';

function overUnderResult(value: number, side: 'over' | 'under', line: number): CandidateResult {
  if (Math.abs(value - line) < EPS) return 'void';
  const over = value > line;
  return (side === 'over') === over ? 'hit' : 'miss';
}

/** Resultado de una selección; undefined si el partido no tiene el dato necesario (córners/tarjetas). */
export function settleCandidate(c: Pick<ConfidenceCandidate, 'settle'>, d: SettleData): CandidateResult | undefined {
  const s = c.settle;
  const outcome = d.hg > d.ag ? 'home' : d.hg === d.ag ? 'draw' : 'away';
  switch (s.kind) {
    case 'outcome':
      return s.win.includes(outcome) ? 'hit' : 'miss';
    case 'dnb':
      return outcome === 'draw' ? 'void' : outcome === s.side ? 'hit' : 'miss';
    case 'handicap': {
      const margin = (s.side === 'home' ? d.hg - d.ag : d.ag - d.hg) + s.line;
      return Math.abs(margin) < EPS ? 'void' : margin > 0 ? 'hit' : 'miss';
    }
    case 'total': {
      const v = s.stat === 'goals' ? d.hg + d.ag : s.stat === 'corners' ? d.corners : d.cards;
      return v === undefined ? undefined : overUnderResult(v, s.side, s.line);
    }
    case 'team-total':
      return overUnderResult(s.team === 'home' ? d.hg : d.ag, s.side, s.line);
    case 'btts': {
      const yes = d.hg > 0 && d.ag > 0;
      return yes === s.yes ? 'hit' : 'miss';
    }
  }
}

// ---------------------------------------------------------------------------
// Walk-forward (sin fuga)
// ---------------------------------------------------------------------------

export interface SettledCandidate extends ConfidenceCandidate {
  result: CandidateResult;
}

export interface ConfidenceHistoryItem {
  matchId: string;
  compId: string;
  /** ISO, inicio del partido */
  date: string;
  home: string;
  away: string;
  /** marcador a los 90 minutos (el que usan las casas para liquidar) */
  score: { home: number; away: number };
  corners?: number;
  cards?: number;
  /** hubo prórroga o penaltis (goles a 90' reconstruidos con los eventos; córners y tarjetas excluidos) */
  extraTime?: boolean;
  /** candidatos generados antes del partido y ya resueltos */
  candidates: SettledCandidate[];
  /** resultado de la selección natural de cada familia sin umbral (baselineCandidates): tasas base por familia */
  base?: Partial<Record<ConfidenceFamily, CandidateResult>>;
}

/**
 * Candidatos de un partido TERMINADO con información estrictamente anterior a su inicio:
 *  - Elo pre-partido (obligatorio: si falta, ratingsFor usaría el Elo actual ⇒ fuga ⇒ undefined),
 *  - Dixon-Coles walk-forward (ajustado con partidos de días anteriores) de la liga y de las ligas domésticas,
 *  - parámetros de pretemporada (empates del Elo, Elo→goles, medias de goles) ajustados antes del inicio de la
 *    temporada (obligatorios: sin ellos wfContext usaría los actuales ⇒ undefined),
 *  - proyecciones de córners/tarjetas con partidos de días anteriores (medias de liga y dispersión NB incluidas),
 *  - cuotas de cierre (pre-partido).
 * Lo único posterior es la liga doméstica asignada a cada equipo, que solo decide qué modelo de goles se usa.
 */
export function walkForwardCandidates(ctx: BuildContext, m: MatchRecord, opts: CandidateOptions = {}): ConfidenceCandidate[] | undefined {
  const input = walkForwardInput(ctx, m);
  return input ? confidenceCandidates(input, opts) : undefined;
}

/** Entrada de confidenceCandidates de un partido TERMINADO, sin fuga (ver walkForwardCandidates). */
export function walkForwardInput(ctx: BuildContext, m: MatchRecord): CandidateInput | undefined {
  if (!isFinishedRecord(m) || !m.currentSeason) return undefined;
  const comp = ctx.configById.get(m.compId);
  if (!comp) return undefined;
  const t = Date.parse(m.date);
  if (!Number.isFinite(t)) return undefined;
  if (!ctx.suite.eloBuild.preMatch.has(m.id)) return undefined;
  const pre = ctx.preSeason.get(m.compId);
  if (!pre || t < pre.cutoff) return undefined;
  const pctx = wfContext(ctx, m);
  const sc = statContext(ctx, comp.id, t);
  const projections = projectMatchStats(m.home.id, m.away.id, sc);
  // la forma de ESPN solo afecta al texto explicativo, no a las probabilidades
  const pred = predictMatch(m, pctx, { projections });
  if (![pred.quick.p.home, pred.quick.p.draw, pred.quick.p.away, pred.lambdaHome, pred.lambdaAway].every(Number.isFinite)) return undefined;
  return {
    homeName: m.home.name,
    awayName: m.away.name,
    p: pred.quick.p,
    matrix: pred.matrix,
    projections,
    odds: m.odds,
    withMarket: !!pred.model.market,
    ...teamHistoryBefore(ctx, m, sc, t),
  };
}

/**
 * Selección «natural» de cada familia SIN umbral de probabilidad (su lado más probable, cualquier probabilidad): la
 * tasa base de la familia en partidos comparables. En familias de una sola selección (más de 1,5 tarjetas, ambos
 * marcan…) es apostar siempre lo mismo; en las de dos lados, el lado que el modelo ve más probable (el favorito).
 */
export function baselineCandidates(input: CandidateInput, opts: CandidateOptions = {}): ConfidenceCandidate[] {
  return confidenceCandidates(input, { ...opts, minProb: 0, maxProb: 1 });
}

export interface HistoryOptions extends CandidateOptions {
  /** competiciones a evaluar (por defecto todas) */
  compIds?: string[];
  log?: (msg: string) => void;
}

/** Historial walk-forward: todos los partidos terminados de la temporada actual que se pueden predecir sin fuga. */
export function confidenceHistory(ctx: BuildContext, opts: HistoryOptions = {}): ConfidenceHistoryItem[] {
  if (ctx.wf.size === 0 && ctx.wfTimeline.size === 0) computeWalkForward(ctx);
  const only = opts.compIds?.length ? new Set(opts.compIds) : undefined;
  const out: ConfidenceHistoryItem[] = [];
  let skipped = 0;
  let et90 = 0;
  let etOut = 0;
  for (const m of ctx.allMatches) {
    if (!m.currentSeason || !isFinishedRecord(m)) continue;
    if (only && !only.has(m.compId)) continue;
    if (!ctx.configById.has(m.compId)) continue;
    const d = settleDataOf(m);
    if (!d) {
      if (wentBeyond90(m)) etOut++;
      else skipped++;
      continue;
    }
    const input = walkForwardInput(ctx, m);
    if (!input) {
      skipped++;
      continue;
    }
    const cands = confidenceCandidates(input, opts);
    const settled: SettledCandidate[] = [];
    for (const c of cands) {
      const r = settleCandidate(c, d);
      if (r) settled.push({ ...c, result: r });
    }
    const base: Partial<Record<ConfidenceFamily, CandidateResult>> = {};
    for (const c of baselineCandidates(input, opts)) {
      const r = settleCandidate(c, d);
      if (r) base[c.family] = r;
    }
    const item: ConfidenceHistoryItem = {
      matchId: m.id,
      compId: m.compId,
      date: m.date,
      home: m.home.name,
      away: m.away.name,
      score: { home: d.hg, away: d.ag },
      candidates: settled,
      base,
    };
    if (d.corners !== undefined) item.corners = d.corners;
    if (d.cards !== undefined) item.cards = d.cards;
    if (d.extraTime) {
      item.extraTime = true;
      et90++;
    }
    out.push(item);
  }
  out.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.matchId.localeCompare(b.matchId));
  if (skipped) opts.log?.(`  confianza: ${skipped} partidos sin predicción walk-forward completa (no se evalúan)`);
  if (et90 || etOut) {
    opts.log?.(`  confianza: ${et90} partidos con prórroga o penaltis resueltos a 90' (sin córners ni tarjetas); ${etOut} excluidos (eventos de gol incompletos)`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Estadística
// ---------------------------------------------------------------------------

/** z del intervalo de Wilson al 90 % (bilateral). */
export const WILSON_Z90 = 1.6449;

/** Intervalo de Wilson de una proporción. n = 0 ⇒ [0, 1]. */
export function wilsonInterval(hits: number, n: number, z = WILSON_Z90): [number, number] {
  if (!(n > 0)) return [0, 1];
  const p = hits / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export interface HitStats {
  /** resueltas con acierto o fallo (sin nulos) */
  n: number;
  hits: number;
  /** nulos (empate en empate no apuesta) */
  voids: number;
  hitRate: number;
  wilsonLow: number;
  wilsonHigh: number;
  avgProb: number;
}

function statsOf(rows: { prob: number; result: CandidateResult }[], z = WILSON_Z90): HitStats {
  let n = 0;
  let hits = 0;
  let voids = 0;
  let sp = 0;
  for (const r of rows) {
    if (r.result === 'void') {
      voids++;
      continue;
    }
    n++;
    sp += r.prob;
    if (r.result === 'hit') hits++;
  }
  const [lo, hi] = wilsonInterval(hits, n, z);
  return { n, hits, voids, hitRate: n ? hits / n : 0, wilsonLow: lo, wilsonHigh: hi, avgProb: n ? sp / n : 0 };
}

// ---------------------------------------------------------------------------
// Recalibración de Platt por familia
// ---------------------------------------------------------------------------

/** Recalibración logística: q = σ(a + b·logit(p)). */
export interface PlattFit {
  a: number;
  b: number;
  /** candidatos resueltos usados en el ajuste */
  n: number;
}

const logit = (p: number) => {
  const x = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(x / (1 - x));
};
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/**
 * Ajuste de Platt por máxima verosimilitud (Newton) con una penalización suave hacia la identidad (a = 0, b = 1)
 * equivalente a unos pocos partidos ficticios. undefined si no hay al menos 2 clases o el ajuste no converge.
 */
export function fitPlatt(rows: { prob: number; hit: boolean }[], ridge = 2): PlattFit | undefined {
  const xs = rows.map((r) => logit(r.prob));
  const ys = rows.map((r) => (r.hit ? 1 : 0));
  const pos = ys.reduce((s: number, y) => s + y, 0);
  if (!rows.length || pos === 0 || pos === rows.length) return undefined;
  let a = 0;
  let b = 1;
  for (let it = 0; it < 100; it++) {
    // gradiente y hessiana de la log-verosimilitud penalizada (a² + (b−1)²)·ridge/2
    let ga = -ridge * a;
    let gb = -ridge * (b - 1);
    let haa = -ridge;
    let hab = 0;
    let hbb = -ridge;
    for (let i = 0; i < xs.length; i++) {
      const q = sigmoid(a + b * xs[i]);
      const r = ys[i] - q;
      const w = q * (1 - q);
      ga += r;
      gb += r * xs[i];
      haa -= w;
      hab -= w * xs[i];
      hbb -= w * xs[i] * xs[i];
    }
    const det = haa * hbb - hab * hab;
    if (!(Math.abs(det) > 1e-12)) return undefined;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a -= da;
    b -= db;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { a, b, n: rows.length };
}

/** Probabilidad recalibrada. */
export function plattProb(f: PlattFit, p: number): number {
  return sigmoid(f.a + f.b * logit(p));
}

/** Probabilidad del modelo a partir de la cual la recalibrada llega a q (b > 0). */
export function plattInverse(f: PlattFit, q: number): number {
  return sigmoid((logit(q) - f.a) / f.b);
}

// ---------------------------------------------------------------------------
// Reglas
// ---------------------------------------------------------------------------

/**
 * 'platt' (por defecto): el umbral parte de la probabilidad del modelo cuya recalibración de Platt (ajustada con el
 *   histórico) llega a minCalibrated, y luego exige los criterios observados de la cola. Así el pick más marginal
 *   también acierta ~minCalibrated, no solo la media de la cola.
 * 'cola': umbral mínimo de la rejilla cuya cola cumple los criterios (sin recalibrar). Riesgo conocido: si la cola
 *   está dominada por candidatos muy probables, admite picks marginales que aciertan bastante menos que la etiqueta.
 */
export type RuleMethod = 'platt' | 'cola';

export interface ConfidenceRuleOptions {
  method?: RuleMethod;
  /** acierto mínimo de la cola (prob >= umbral) en el histórico. Default 0.82 (margen sobre 0.80) */
  targetRate?: number;
  /** muestra mínima de la cola. Default 80 */
  minN?: number;
  /** límite inferior de Wilson mínimo. Default 0.78 */
  minLower?: number;
  /** z de Wilson. Default 1.6449 (90 % bilateral) */
  z?: number;
  /** Platt: probabilidad recalibrada mínima para publicar (default = targetRate) y para oro (default 0.87) */
  minCalibrated?: number;
  goldCalibrated?: number;
  /** Platt: candidatos resueltos mínimos para ajustar la recalibración y pendiente mínima. Default 150 / 0.25 */
  minFit?: number;
  minSlope?: number;
  /** umbral oro: acierto mínimo de su cola, muestra y Wilson. Default 0.87 / 60 / 0.83 */
  goldRate?: number;
  goldMinN?: number;
  goldLower?: number;
  /** acierto mínimo de la franja plata [umbral, umbral oro). Default 0.80 */
  bandMinRate?: number;
  /** rejilla de umbrales. Default 0.50..0.93 cada 0.01 */
  gridFrom?: number;
  gridTo?: number;
  gridStep?: number;
  /** reglas separadas por fuente de la predicción (con mercado / estadística). Default true */
  segmented?: boolean;
  /** familias permitidas (por defecto todas) */
  families?: ConfidenceFamily[];
  /** reglas excluidas (claves de ruleKey: 'familia' o 'familia|fuente') */
  exclude?: string[];
}

type ResolvedRuleOptions = Required<Omit<ConfidenceRuleOptions, 'families' | 'minCalibrated' | 'exclude'>> & {
  minCalibrated?: number;
  families?: ConfidenceFamily[];
  exclude?: string[];
};

export const DEFAULT_RULE_OPTIONS: Required<Omit<ConfidenceRuleOptions, 'families' | 'minCalibrated' | 'exclude'>> = {
  method: 'platt',
  segmented: true,
  targetRate: 0.82,
  minN: 80,
  minLower: 0.78,
  z: WILSON_Z90,
  goldCalibrated: 0.87,
  minFit: 150,
  minSlope: 0.25,
  goldRate: 0.87,
  goldMinN: 60,
  goldLower: 0.83,
  bandMinRate: 0.8,
  gridFrom: 0.5,
  gridTo: 0.93,
  gridStep: 0.01,
};

export interface ConfidenceRule {
  family: ConfidenceFamily;
  theme: ConfidenceTheme;
  /** fuente de la predicción a la que se aplica (undefined = todas) */
  segment?: ConfidenceSegment;
  /** umbral mínimo publicable (prob del modelo >= threshold) */
  threshold: number;
  /** umbral oro (>= threshold); undefined si ninguna cola cumple el criterio oro */
  goldThreshold?: number;
  /** cola completa (prob >= threshold) */
  tail: HitStats;
  /** franja plata [threshold, goldThreshold) (undefined si vacía) */
  plata?: HitStats;
  /** franja oro (prob >= goldThreshold) */
  oro?: HitStats;
  /** recalibración (método 'platt') */
  platt?: PlattFit;
  /** candidatos de la familia en el histórico (cualquier prob) */
  candidates: number;
}

export interface RejectedFamily {
  family: ConfidenceFamily;
  segment?: ConfidenceSegment;
  candidates: number;
  reason: string;
  /** mejor cola encontrada (mayor acierto con n >= minN), si hay */
  best?: { threshold: number } & HitStats;
}

export interface ConfidenceRules {
  /** periodo del histórico usado */
  from: string;
  to: string;
  matches: number;
  options: ResolvedRuleOptions;
  rules: ConfidenceRule[];
  rejected: RejectedFamily[];
}

function grid(o: ResolvedRuleOptions): number[] {
  const out: number[] = [];
  const steps = Math.round((o.gridTo - o.gridFrom) / o.gridStep);
  for (let k = 0; k <= steps; k++) out.push(Math.round((o.gridFrom + k * o.gridStep) * 1e6) / 1e6);
  return out;
}

const pct1 = (x: number) => `${(x * 100).toFixed(1)} %`;

/** Ajusta las reglas por familia con un histórico ya resuelto. */
export function confidenceRulesFrom(history: ConfidenceHistoryItem[], opts: ConfidenceRuleOptions = {}): ConfidenceRules {
  const o: ResolvedRuleOptions = { ...DEFAULT_RULE_OPTIONS, ...stripUndefined(opts) };
  if (opts.families) o.families = opts.families.slice();
  if (opts.exclude?.length) o.exclude = opts.exclude.slice();
  const excluded = new Set(opts.exclude ?? []);
  const minCal = o.minCalibrated ?? o.targetRate;
  const allowed = opts.families ? new Set(opts.families) : undefined;
  const segments: (ConfidenceSegment | undefined)[] = o.segmented ? ['mercado', 'estadistico'] : [undefined];
  const byKey = new Map<string, { prob: number; result: CandidateResult }[]>();
  for (const it of history) {
    for (const c of it.candidates) {
      if (allowed && !allowed.has(c.family)) continue;
      const k = ruleKey(c.family, o.segmented ? c.segment : undefined);
      let arr = byKey.get(k);
      if (!arr) {
        arr = [];
        byKey.set(k, arr);
      }
      arr.push({ prob: c.prob, result: c.result });
    }
  }
  const thresholds = grid(o);
  const snapUp = (x: number) => thresholds.find((t) => t >= x - 1e-9);
  const rules: ConfidenceRule[] = [];
  const rejected: RejectedFamily[] = [];
  for (const f of CONFIDENCE_FAMILIES) {
    if (allowed && !allowed.has(f.id)) continue;
    for (const segment of segments) {
      if (excluded.has(ruleKey(f.id, segment)) || excluded.has(f.id)) continue;
      const rows = byKey.get(ruleKey(f.id, segment)) ?? [];
      const tailAt = (t: number) => statsOf(rows.filter((r) => r.prob >= t - EPS), o.z);
      const band = (lo: number, hi: number) => statsOf(rows.filter((r) => r.prob >= lo - EPS && r.prob < hi - EPS), o.z);
      const tails = thresholds.map((t) => ({ t, s: tailAt(t) }));
      const passes = (s: HitStats) => s.n >= o.minN && s.hitRate >= o.targetRate - EPS && s.wilsonLow >= o.minLower - EPS;
      const goldPasses = (s: HitStats) => s.n >= o.goldMinN && s.hitRate >= o.goldRate - EPS && s.wilsonLow >= o.goldLower - EPS;
      const reject = (reason: string) => {
        const withN = tails.filter((x) => x.s.n >= o.minN);
        const best = withN.length ? withN.reduce((a, b) => (b.s.hitRate > a.s.hitRate ? b : a)) : undefined;
        const rj: RejectedFamily = { family: f.id, candidates: rows.length, reason };
        if (segment) rj.segment = segment;
        if (best) rj.best = { threshold: best.t, ...best.s };
        rejected.push(rj);
      };

      let start = o.gridFrom;
      let goldStartRaw = o.gridFrom;
      let platt: PlattFit | undefined;
      if (o.method === 'platt') {
        const settled = rows.filter((r) => r.result !== 'void').map((r) => ({ prob: r.prob, hit: r.result === 'hit' }));
        if (settled.length < o.minFit) {
          reject(`muestra insuficiente para recalibrar (${settled.length} < ${o.minFit} candidatos resueltos)`);
          continue;
        }
        platt = fitPlatt(settled);
        if (!platt || !(platt.b >= o.minSlope)) {
          reject(`la probabilidad del modelo apenas discrimina en esta familia (pendiente de Platt ${platt ? platt.b.toFixed(2) : '—'})`);
          continue;
        }
        const s0 = snapUp(Math.max(o.gridFrom, plattInverse(platt, minCal)));
        if (s0 === undefined) {
          reject(`ningún candidato llega a una probabilidad recalibrada de ${pct1(minCal)} (haría falta prob. del modelo > ${o.gridTo})`);
          continue;
        }
        start = s0;
        goldStartRaw = plattInverse(platt, o.goldCalibrated);
      }
      const base = tails.find((x) => x.t >= start - EPS && passes(x.s));
      if (!base) {
        const s = tailAt(start);
        reject(
          o.method === 'platt'
            ? `desde el umbral recalibrado (${start.toFixed(2)}) ninguna cola cumple acierto >= ${o.targetRate}, n >= ${o.minN} y Wilson >= ${o.minLower} (en ${start.toFixed(2)}: ${pct1(s.hitRate)}, n = ${s.n})`
            : `ningún umbral alcanza acierto >= ${o.targetRate} con n >= ${o.minN} y Wilson >= ${o.minLower}`,
        );
        continue;
      }
      const goldStart = Math.max(base.t, snapUp(Math.max(o.gridFrom, goldStartRaw)) ?? Infinity);
      const gold = Number.isFinite(goldStart) ? tails.find((x) => x.t >= goldStart - EPS && goldPasses(x.s)) : undefined;
      let threshold = base.t;
      if (gold && gold.t > base.t + EPS) {
        // la franja plata debe acertar >= bandMinRate por sí sola (si no, se sube el umbral; como mucho hasta el oro)
        const ok = tails.find((x) => {
          if (x.t < base.t - EPS || x.t >= gold.t - EPS || !passes(x.s)) return false;
          const b = band(x.t, gold.t);
          return b.n > 0 && b.hitRate >= o.bandMinRate - EPS;
        });
        threshold = ok ? ok.t : gold.t;
      }
      const rule: ConfidenceRule = {
        family: f.id,
        theme: f.theme,
        threshold,
        tail: tailAt(threshold),
        candidates: rows.length,
      };
      if (segment) rule.segment = segment;
      if (platt) rule.platt = platt;
      if (gold) {
        rule.goldThreshold = Math.max(gold.t, threshold);
        rule.oro = tailAt(rule.goldThreshold);
        if (rule.goldThreshold > threshold + EPS) rule.plata = band(threshold, rule.goldThreshold);
      } else {
        rule.plata = rule.tail;
      }
      rules.push(rule);
    }
  }
  const dates = history.map((h) => h.date).sort();
  return {
    from: dates[0] ?? '',
    to: dates[dates.length - 1] ?? '',
    matches: history.length,
    options: o,
    rules,
    rejected,
  };
}

/** Clave de regla: familia (y fuente de la predicción si las reglas están segmentadas). */
export function ruleKey(family: ConfidenceFamily, segment?: ConfidenceSegment): string {
  return segment ? `${family}|${segment}` : family;
}

/** Regla aplicable a un candidato (undefined si su familia/fuente no tiene regla). */
export function ruleFor(rules: ConfidenceRules, c: Pick<ConfidenceCandidate, 'family' | 'segment'>): ConfidenceRule | undefined {
  const seg = rules.options.segmented ? c.segment : undefined;
  return rules.rules.find((r) => r.family === c.family && r.segment === seg);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && k !== 'families' && k !== 'exclude') (out as Record<string, unknown>)[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
// Selección
// ---------------------------------------------------------------------------

export type ConfidenceTier = 'oro' | 'plata';

export interface ConfidencePick extends ConfidenceCandidate {
  tier: ConfidenceTier;
  /** acierto histórico de la franja (oro/plata) de su familia */
  historicalHitRate: number;
  /** selecciones resueltas en esa franja */
  historicalN: number;
  /** umbral de probabilidad (del modelo) de la franja */
  threshold: number;
  /** probabilidad recalibrada con el histórico (Platt); = prob si la regla no recalibra */
  calibratedProb: number;
}

export interface SelectOptions {
  /** picks como mucho por partido (de temas distintos). Default 2 */
  maxPerMatch?: number;
  /**
   * acierto histórico mínimo de la franja para publicar. Default 0.85 (GOLD_MIN_RATE: solo se publica el nivel oro;
   * la franja plata [0,80, 0,85) acertó 79,9 % fuera de muestra en la revisión y ya no se publica)
   */
  minHitRate?: number;
}

/** Acierto mínimo de la franja (en el histórico con el que se ajusta la regla) del nivel oro, el único que se publica. */
export const GOLD_MIN_RATE = 0.85;

const r4 = (x: number) => Math.round(x * 10000) / 10000;

/** Picks publicables de UN partido: superan el umbral de su familia, como mucho maxPerMatch de temas distintos. */
export function selectConfidencePicks(candidates: ConfidenceCandidate[], rules: ConfidenceRules, opts: SelectOptions = {}): ConfidencePick[] {
  const maxPerMatch = opts.maxPerMatch ?? 2;
  const minHitRate = opts.minHitRate ?? GOLD_MIN_RATE;
  const byKey = new Map(rules.rules.map((r) => [ruleKey(r.family, r.segment), r]));
  const eligible: (ConfidencePick & { rank: number })[] = [];
  for (const c of candidates) {
    const r = byKey.get(ruleKey(c.family, rules.options.segmented ? c.segment : undefined));
    if (!r || !(c.prob >= r.threshold - EPS)) continue;
    const isGold = r.goldThreshold !== undefined && !!r.oro && c.prob >= r.goldThreshold - EPS;
    const s = isGold ? r.oro! : (r.plata ?? r.tail);
    if (!(s.n > 0) || s.hitRate < minHitRate - EPS) continue;
    const calibratedProb = r.platt ? plattProb(r.platt, c.prob) : c.prob;
    eligible.push({
      ...c,
      tier: s.hitRate >= GOLD_MIN_RATE - EPS ? 'oro' : 'plata',
      historicalHitRate: r4(s.hitRate),
      historicalN: s.n,
      threshold: isGold ? r.goldThreshold! : r.threshold,
      calibratedProb: r4(calibratedProb),
      // orden: probabilidad recalibrada (local) si la hay; si no, acierto histórico de la franja
      rank: r.platt ? calibratedProb : s.hitRate,
    });
  }
  eligible.sort((a, b) => b.rank - a.rank || b.prob - a.prob || a.family.localeCompare(b.family));
  const out: ConfidencePick[] = [];
  const themes = new Set<ConfidenceTheme>();
  const families = new Set<ConfidenceFamily>();
  for (const e of eligible) {
    if (out.length >= maxPerMatch) break;
    if (themes.has(e.theme) || families.has(e.family)) continue;
    themes.add(e.theme);
    families.add(e.family);
    const { rank: _rank, ...pick } = e;
    void _rank;
    out.push(pick);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Informes
// ---------------------------------------------------------------------------

export interface SettledPick extends ConfidencePick {
  matchId: string;
  compId: string;
  date: string;
  home: string;
  away: string;
  score: { home: number; away: number };
  corners?: number;
  cards?: number;
  result: CandidateResult;
}

export interface RoiStats {
  /** picks con cuota (de cierre) */
  bets: number;
  /** de ellos, con cuota sintética (doble oportunidad / empate no apuesta desde el 1X2) */
  synthetic: number;
  profit: number;
  roi: number;
  hitRate: number;
  avgOdds: number;
}

export interface GroupReport extends HitStats {
  picks: number;
  avgFairOdds: number;
  roi?: RoiStats;
  /**
   * solo por familia: tasa base de la familia en los partidos del tramo (su selección natural sin umbral, ver
   * baselineCandidates), resueltas y lift = acierto de los picks − tasa base (en puntos de proporción)
   */
  baseRate?: number;
  baseN?: number;
  lift?: number;
}

/** Línea base SIN modelo: 2 selecciones fijas por partido, iguales en todos (ver FIXED_BASELINE_LABEL). */
export interface BaselineStats extends HitStats {
  /** selecciones (con nulos) */
  picks: number;
  matches: number;
}

export const FIXED_BASELINE_LABEL = 'el visitante marca menos de 3 goles + más de 1,5 tarjetas (cuando hay dato), en todos los partidos';

export interface ConfidenceReport extends GroupReport {
  from: string;
  to: string;
  /** días naturales del periodo */
  days: number;
  /** días con algún partido evaluado */
  matchDays: number;
  /** partidos evaluados */
  matches: number;
  matchesWithPick: number;
  /** picks por día con partidos y por día natural */
  picksPerMatchDay: number;
  picksPerDay: number;
  byFamily: Partial<Record<ConfidenceFamily, GroupReport>>;
  byTier: Partial<Record<ConfidenceTier, GroupReport>>;
  /** por fuente de la predicción (con mercado / estadística) */
  bySegment: Partial<Record<ConfidenceSegment, GroupReport>>;
  byComp: Record<string, GroupReport>;
  /** línea base sin modelo en los mismos partidos (FIXED_BASELINE_LABEL) */
  fixedBaseline: BaselineStats;
  /**
   * acierto esperado si cada pick acertara como la tasa base de su familia en estos partidos (media ponderada por los
   * picks resueltos de cada familia) y lift = hitRate − expectedBaseRate
   */
  expectedBaseRate?: number;
  lift?: number;
}

function roiOf(picks: SettledPick[]): RoiStats | undefined {
  const priced = picks.filter((p) => validPrice(p.marketOdds));
  if (!priced.length) return undefined;
  let profit = 0;
  let wins = 0;
  let settled = 0;
  let sumOdds = 0;
  for (const p of priced) {
    sumOdds += p.marketOdds!;
    if (p.result === 'void') continue;
    settled++;
    if (p.result === 'hit') {
      wins++;
      profit += p.marketOdds! - 1;
    } else profit -= 1;
  }
  return {
    bets: priced.length,
    synthetic: priced.filter((p) => p.oddsKind === 'sintetica').length,
    profit: Math.round(profit * 1000) / 1000,
    roi: Math.round((profit / priced.length) * 10000) / 10000,
    hitRate: settled ? Math.round((wins / settled) * 10000) / 10000 : 0,
    avgOdds: Math.round((sumOdds / priced.length) * 1000) / 1000,
  };
}

function groupReport(picks: SettledPick[], z = WILSON_Z90): GroupReport {
  const s = statsOf(picks, z);
  const settled = picks.filter((p) => p.result !== 'void');
  const g: GroupReport = {
    ...s,
    picks: picks.length,
    avgFairOdds: settled.length ? settled.reduce((t, p) => t + p.fairOdds, 0) / settled.length : 0,
  };
  const roi = roiOf(picks);
  if (roi) g.roi = roi;
  return g;
}

/** Selecciona y resuelve los picks de un tramo del histórico con unas reglas. */
export function settlePicks(items: ConfidenceHistoryItem[], rules: ConfidenceRules, opts: SelectOptions = {}): SettledPick[] {
  const out: SettledPick[] = [];
  for (const it of items) {
    const picks = selectConfidencePicks(it.candidates, rules, opts);
    for (const p of picks) {
      const src = it.candidates.find((c) => c.family === p.family && c.selection === p.selection) as SettledCandidate | undefined;
      if (!src) continue;
      const sp: SettledPick = {
        ...p,
        matchId: it.matchId,
        compId: it.compId,
        date: it.date,
        home: it.home,
        away: it.away,
        score: it.score,
        result: src.result,
      };
      if (it.corners !== undefined) sp.corners = it.corners;
      if (it.cards !== undefined) sp.cards = it.cards;
      out.push(sp);
    }
  }
  return out;
}

/** Línea base sin modelo (FIXED_BASELINE_LABEL) en unos partidos: no usa ninguna probabilidad. */
export function fixedBaseline(items: ConfidenceHistoryItem[], z = WILSON_Z90): BaselineStats {
  const rows: { prob: number; result: CandidateResult }[] = [];
  for (const it of items) {
    rows.push({ prob: 0, result: overUnderResult(it.score.away, 'under', 2.5) });
    if (it.cards !== undefined) rows.push({ prob: 0, result: overUnderResult(it.cards, 'over', 1.5) });
  }
  return { ...statsOf(rows, z), picks: rows.length, matches: items.length };
}

/** Tasa base de cada familia en unos partidos: su selección natural sin umbral (ConfidenceHistoryItem.base). */
export function familyBaseRates(items: ConfidenceHistoryItem[], z = WILSON_Z90): Partial<Record<ConfidenceFamily, HitStats>> {
  const rows = new Map<ConfidenceFamily, { prob: number; result: CandidateResult }[]>();
  for (const it of items) {
    for (const [f, r] of Object.entries(it.base ?? {}) as [ConfidenceFamily, CandidateResult][]) {
      const arr = rows.get(f) ?? [];
      arr.push({ prob: 0, result: r });
      rows.set(f, arr);
    }
  }
  const out: Partial<Record<ConfidenceFamily, HitStats>> = {};
  for (const [f, arr] of rows) out[f] = statsOf(arr, z);
  return out;
}

/** Informe de un tramo: picks, acierto, Wilson, cobertura, cuota justa media, ROI, por familia/nivel/competición. */
export function confidenceReport(items: ConfidenceHistoryItem[], picks: SettledPick[], z = WILSON_Z90): ConfidenceReport {
  const g = groupReport(picks, z);
  const dates = items.map((i) => Date.parse(i.date)).filter(Number.isFinite);
  const from = dates.length ? Math.min(...dates) : NaN;
  const to = dates.length ? Math.max(...dates) : NaN;
  const days = Number.isFinite(from) ? Math.floor(to / DAY_MS) - Math.floor(from / DAY_MS) + 1 : 0;
  const matchDays = new Set(dates.map((t) => Math.floor(t / DAY_MS))).size;
  const groupBy = <K extends string>(key: (p: SettledPick) => K): Record<K, GroupReport> => {
    const map = new Map<K, SettledPick[]>();
    for (const p of picks) {
      const k = key(p);
      const arr = map.get(k) ?? [];
      arr.push(p);
      map.set(k, arr);
    }
    const out = {} as Record<K, GroupReport>;
    for (const [k, arr] of map) out[k] = groupReport(arr, z);
    return out;
  };
  const byFamily = groupBy((p) => p.family) as Partial<Record<ConfidenceFamily, GroupReport>>;
  const base = familyBaseRates(items, z);
  let expHits = 0;
  let expN = 0;
  for (const [f, gr] of Object.entries(byFamily) as [ConfidenceFamily, GroupReport][]) {
    const b = base[f];
    if (!b || !(b.n > 0)) continue;
    gr.baseRate = b.hitRate;
    gr.baseN = b.n;
    if (gr.n > 0) {
      gr.lift = gr.hitRate - b.hitRate;
      expHits += gr.n * b.hitRate;
      expN += gr.n;
    }
  }
  const out: ConfidenceReport = {
    ...g,
    from: Number.isFinite(from) ? new Date(from).toISOString() : '',
    to: Number.isFinite(to) ? new Date(to).toISOString() : '',
    days,
    matchDays,
    matches: items.length,
    matchesWithPick: new Set(picks.map((p) => p.matchId)).size,
    picksPerMatchDay: matchDays ? picks.length / matchDays : 0,
    picksPerDay: days ? picks.length / days : 0,
    byFamily,
    byTier: groupBy((p) => p.tier),
    bySegment: groupBy((p) => p.segment),
    byComp: groupBy((p) => p.compId),
    fixedBaseline: fixedBaseline(items, z),
  };
  if (expN > 0) {
    out.expectedBaseRate = expHits / expN;
    if (g.n > 0) out.lift = g.hitRate - out.expectedBaseRate;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Procedimiento pre-registrado (elección de la exigencia solo con el histórico dado)
// ---------------------------------------------------------------------------

/**
 * Reglas excluidas de antemano por decisión documentada (no por el procedimiento automático). Se aplican en la
 * calibración, en el walk-forward y en producción.
 */
export const EXCLUDED_RULES: { key: string; reason: string }[] = [
  {
    key: 'cards-over-2.5',
    reason:
      'en las dos fuentes, por decisión tomada con el walk-forward mensual de la revisión del 18 nov 2026: 93/125 = 74,4 % fuera de muestra (con cuotas 78/105, sin cuotas 15/20) y 27/38 = 71,1 % en el holdout; la validación interna no la detectaba (pocos picks en sus tramos). Se revalidará con datos futuros',
  },
];

/** Escalera de exigencia (de menos a más conservadora). */
export const RULE_LADDER: ConfidenceRuleOptions[] = [
  { targetRate: 0.82, minLower: 0.78 },
  { targetRate: 0.84, minLower: 0.8 },
  { targetRate: 0.86, minLower: 0.82 },
  { targetRate: 0.88, minLower: 0.84 },
];

export interface ProcedureOptions {
  /** fracción final del histórico usada como validación interna (ventana creciente). Default 0.4 */
  innerFraction?: number;
  /** tramos de la validación interna. Default 3 */
  innerFolds?: number;
  /** acierto conjunto mínimo de la validación interna para aceptar un nivel. Default 0.82 */
  acceptRate?: number;
  /** límite inferior de Wilson mínimo de la validación conjunta. Default 0.78 */
  acceptLower?: number;
  /** familias con acierto de validación por debajo (con n >= familyMinN) se quitan. Default 0.78 / 30 */
  familyFloor?: number;
  familyMinN?: number;
  /** picks mínimos en validación para aceptar un nivel. Default 100 */
  minPicks?: number;
  ladder?: ConfidenceRuleOptions[];
  /** opciones de regla comunes a todos los niveles (método, segmentación…) */
  rule?: ConfidenceRuleOptions;
  /** reglas excluidas de antemano (claves de ruleKey). Default: EXCLUDED_RULES */
  fixedExclude?: string[];
  /** familias permitidas de partida (por defecto todas) */
  families?: ConfidenceFamily[];
  select?: SelectOptions;
}

export interface ProcedureLevelLog {
  level: number;
  options: ConfidenceRuleOptions;
  /** reglas (familia o familia|fuente) quitadas por su acierto en la validación interna */
  dropped: { key: string; n: number; hitRate: number }[];
  validation: { picks: number; n: number; hits: number; hitRate: number; wilsonLow: number; from: string; to: string };
  accepted: boolean;
}

export interface ProcedureResult {
  rules: ConfidenceRules;
  /** nivel elegido de la escalera y reglas excluidas */
  chosen: { level: number; options: ConfidenceRuleOptions; exclude: string[] };
  log: ProcedureLevelLog[];
}

/** Corte por día UTC: índice del primer partido del día que contiene el cuantil `q` (por número de partidos). */
export function dayCut(items: { date: string }[], q: number): number {
  if (!items.length) return 0;
  const idx = Math.min(items.length - 1, Math.max(0, Math.floor(items.length * q)));
  const day = Math.floor(Date.parse(items[idx].date) / DAY_MS) * DAY_MS;
  const k = items.findIndex((it) => Date.parse(it.date) >= day);
  return k < 0 ? items.length : k;
}

/**
 * Validación interna con ventana creciente: el último `innerFraction` de `history` se parte en `innerFolds` tramos
 * (por día) y cada tramo se selecciona con reglas ajustadas con TODO lo anterior a él.
 */
export function innerValidation(
  history: ConfidenceHistoryItem[],
  rule: ConfidenceRuleOptions,
  o: { innerFraction: number; innerFolds: number },
  select: SelectOptions = {},
): SettledPick[] {
  const start = dayCut(history, 1 - o.innerFraction);
  const picks: SettledPick[] = [];
  const valid = history.slice(start);
  for (let k = 0; k < o.innerFolds; k++) {
    const a = start + dayCut(valid, k / o.innerFolds);
    const b = k === o.innerFolds - 1 ? history.length : start + dayCut(valid, (k + 1) / o.innerFolds);
    if (b <= a) continue;
    const rules = confidenceRulesFrom(history.slice(0, a), rule);
    picks.push(...settlePicks(history.slice(a, b), rules, select));
  }
  return picks;
}

/**
 * Elige la exigencia y las reglas con validación temporal interna de `history` (ventana creciente) y devuelve las
 * reglas reajustadas con todo `history`. No mira nada fuera de `history`.
 */
export function fitConfidenceProcedure(history: ConfidenceHistoryItem[], opts: ProcedureOptions = {}): ProcedureResult {
  const o = {
    innerFraction: opts.innerFraction ?? 0.4,
    innerFolds: opts.innerFolds ?? 3,
    acceptRate: opts.acceptRate ?? 0.82,
    acceptLower: opts.acceptLower ?? 0.78,
    familyFloor: opts.familyFloor ?? 0.78,
    familyMinN: opts.familyMinN ?? 30,
    minPicks: opts.minPicks ?? 100,
  };
  const ladder = opts.ladder ?? RULE_LADDER;
  const select = opts.select ?? {};
  const base: ConfidenceRuleOptions = { ...(opts.rule ?? {}) };
  if (opts.families) base.families = opts.families;
  const fixed = opts.fixedExclude ?? EXCLUDED_RULES.map((r) => r.key);
  if (fixed.length || base.exclude?.length) base.exclude = [...new Set([...fixed, ...(base.exclude ?? [])])];
  const log: ProcedureLevelLog[] = [];
  let chosen: { level: number; exclude: string[] } | undefined;
  for (let level = 0; level < ladder.length; level++) {
    const exclude: string[] = [...(base.exclude ?? [])];
    const dropped: ProcedureLevelLog['dropped'] = [];
    let picks: SettledPick[] = [];
    for (let round = 0; round < 6; round++) {
      const ruleOpts = { ...base, ...ladder[level], exclude };
      const segmented = ruleOpts.segmented ?? DEFAULT_RULE_OPTIONS.segmented;
      picks = innerValidation(history, ruleOpts, o, select);
      const groups = new Map<string, SettledPick[]>();
      for (const p of picks) {
        const k = ruleKey(p.family, segmented ? p.segment : undefined);
        const arr = groups.get(k) ?? [];
        arr.push(p);
        groups.set(k, arr);
      }
      const bad: ProcedureLevelLog['dropped'] = [];
      for (const [k, arr] of groups) {
        const st = statsOf(arr);
        if (st.n >= o.familyMinN && st.hitRate < o.familyFloor) bad.push({ key: k, n: st.n, hitRate: st.hitRate });
      }
      if (!bad.length) break;
      dropped.push(...bad);
      exclude.push(...bad.map((b) => b.key));
    }
    const st = statsOf(picks);
    const dates = picks.map((p) => p.date).sort();
    const entry: ProcedureLevelLog = {
      level,
      options: ladder[level],
      dropped,
      validation: { picks: picks.length, n: st.n, hits: st.hits, hitRate: st.hitRate, wilsonLow: st.wilsonLow, from: dates[0] ?? '', to: dates[dates.length - 1] ?? '' },
      accepted: st.n >= o.minPicks && st.hitRate >= o.acceptRate - EPS && st.wilsonLow >= o.acceptLower - EPS,
    };
    log.push(entry);
    chosen = { level, exclude };
    if (entry.accepted) break;
    // ningún nivel cumple ⇒ se queda el más exigente (el informe lo dirá; la cifra del holdout será la que sea)
  }
  const level = chosen?.level ?? 0;
  const exclude = chosen?.exclude ?? [];
  const rules = confidenceRulesFrom(history, { ...base, ...ladder[level], exclude });
  return { rules, chosen: { level, options: { ...base, ...ladder[level] }, exclude }, log };
}

// ---------------------------------------------------------------------------
// Validación fuera de muestra por regla (walk-forward mensual)
// ---------------------------------------------------------------------------

/** Una regla (familia|fuente) solo se publica con >= VALIDATION_MIN_N picks y acierto >= VALIDATION_MIN_RATE fuera de muestra. */
export const VALIDATION_MIN_N = 30;
export const VALIDATION_MIN_RATE = 0.8;
/**
 * El walk-forward empieza el primer día 1 de mes con al menos estos partidos anteriores para ajustar las reglas (con
 * los datos de 2026: junio, como el walk-forward mensual de la revisión del 18 nov).
 */
export const WALK_FORWARD_MIN_TRAIN = 1000;

export interface ValidationOptions {
  minN?: number;
  minRate?: number;
}

export interface RuleValidation extends HitStats {
  key: string;
  family: ConfidenceFamily;
  segment?: ConfidenceSegment;
  picks: number;
  validated: boolean;
}

/** Acierto fuera de muestra acumulado por regla (familia|fuente) de unos picks y si cumple la validación. */
export function ruleValidation(picks: SettledPick[], segmented = true, o: ValidationOptions = {}): Map<string, RuleValidation> {
  const minN = o.minN ?? VALIDATION_MIN_N;
  const minRate = o.minRate ?? VALIDATION_MIN_RATE;
  const groups = new Map<string, SettledPick[]>();
  for (const p of picks) {
    const k = ruleKey(p.family, segmented ? p.segment : undefined);
    const arr = groups.get(k) ?? [];
    arr.push(p);
    groups.set(k, arr);
  }
  const out = new Map<string, RuleValidation>();
  for (const [key, arr] of groups) {
    const st = statsOf(arr);
    const v: RuleValidation = { ...st, key, family: arr[0].family, picks: arr.length, validated: st.n >= minN && st.hitRate >= minRate - EPS };
    if (segmented) v.segment = arr[0].segment;
    out.set(key, v);
  }
  return out;
}

export interface UnvalidatedRule {
  key: string;
  family: ConfidenceFamily;
  segment?: ConfidenceSegment;
  /** picks resueltos fuera de muestra y acierto (0 si no hay) */
  n: number;
  hits: number;
  hitRate: number;
}

/** Reglas que superan la validación fuera de muestra; el resto se devuelven aparte (no se publican). */
export function filterValidatedRules(
  rules: ConfidenceRules,
  validation: Map<string, RuleValidation>,
  o: ValidationOptions = {},
): { rules: ConfidenceRules; unvalidated: UnvalidatedRule[] } {
  const minN = o.minN ?? VALIDATION_MIN_N;
  const minRate = o.minRate ?? VALIDATION_MIN_RATE;
  const keep: ConfidenceRule[] = [];
  const unvalidated: UnvalidatedRule[] = [];
  for (const r of rules.rules) {
    const key = ruleKey(r.family, rules.options.segmented ? r.segment : undefined);
    const v = validation.get(key);
    if (v && v.n >= minN && v.hitRate >= minRate - EPS) keep.push(r);
    else {
      const u: UnvalidatedRule = { key, family: r.family, n: v?.n ?? 0, hits: v?.hits ?? 0, hitRate: v?.hitRate ?? 0 };
      if (r.segment) u.segment = r.segment;
      unvalidated.push(u);
    }
  }
  return { rules: { ...rules, rules: keep }, unvalidated };
}

export interface WalkForwardOptions {
  /** partidos anteriores mínimos para el primer tramo. Default WALK_FORWARD_MIN_TRAIN */
  minTrain?: number;
  procedure?: ProcedureOptions;
  select?: SelectOptions;
  validation?: ValidationOptions;
}

export interface WalkForwardFold {
  /** inicio (día 1 del mes, UTC) y fin (exclusivo) del tramo */
  start: string;
  end: string;
  /** partidos usados para ajustar las reglas del tramo (todos anteriores a `start`) */
  trainMatches: number;
  matches: number;
  /** nivel de la escalera elegido y reglas del procedimiento / publicadas tras la validación */
  level: number;
  rules: number;
  publishedRules: number;
  /** picks de todas las reglas del procedimiento (para validar) y picks publicados (reglas validadas) */
  all: HitStats & { picks: number };
  published: HitStats & { picks: number };
}

export interface WalkForwardResult {
  folds: WalkForwardFold[];
  /** picks de TODAS las reglas del procedimiento en cada tramo (fuera de muestra): acumulan la validación por regla */
  candidatePicks: SettledPick[];
  /** picks publicados: en cada tramo, solo reglas validadas con los tramos anteriores */
  published: SettledPick[];
  /** partidos de los tramos */
  items: ConfidenceHistoryItem[];
}

/** Inicios de mes (UTC) entre dos instantes. */
function monthStarts(fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  const d = new Date(fromMs);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  for (;;) {
    const t = Date.UTC(y, m, 1);
    if (t > toMs) break;
    if (t >= fromMs) out.push(t);
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  return out;
}

/**
 * Walk-forward mensual de TODO el procedimiento: desde el primer día 1 de mes con >= minTrain partidos anteriores,
 * cada mes se predice con fitConfidenceProcedure(todo lo anterior a ese día). Dos conjuntos de picks por tramo:
 *  - candidatePicks: con todas las reglas del procedimiento; acumulan el acierto fuera de muestra de cada regla;
 *  - published: solo con las reglas validadas por los tramos ANTERIORES (>= 30 picks y >= 80 %), como en producción.
 */
export function walkForwardConfidence(history: ConfidenceHistoryItem[], opts: WalkForwardOptions = {}): WalkForwardResult {
  const minTrain = opts.minTrain ?? WALK_FORWARD_MIN_TRAIN;
  const select = opts.select ?? {};
  const out: WalkForwardResult = { folds: [], candidatePicks: [], published: [], items: [] };
  if (history.length <= minTrain) return out;
  const times = history.map((h) => Date.parse(h.date));
  const firstIdx = (t: number) => {
    const k = times.findIndex((x) => x >= t);
    return k < 0 ? history.length : k;
  };
  const starts = monthStarts(Math.floor(times[minTrain - 1] / DAY_MS) * DAY_MS + 1, times[times.length - 1]);
  for (let k = 0; k < starts.length; k++) {
    const a = firstIdx(starts[k]);
    if (a < minTrain) continue;
    const endT = k + 1 < starts.length ? starts[k + 1] : Infinity;
    const b = endT === Infinity ? history.length : firstIdx(endT);
    if (b <= a) continue;
    const proc = fitConfidenceProcedure(history.slice(0, a), { ...opts.procedure, select });
    const items = history.slice(a, b);
    const all = settlePicks(items, proc.rules, select);
    const validation = ruleValidation(out.candidatePicks, proc.rules.options.segmented, opts.validation);
    const filtered = filterValidatedRules(proc.rules, validation, opts.validation);
    const published = settlePicks(items, filtered.rules, select);
    out.candidatePicks.push(...all);
    out.published.push(...published);
    out.items.push(...items);
    out.folds.push({
      start: new Date(starts[k]).toISOString(),
      end: endT === Infinity ? history[history.length - 1].date : new Date(endT).toISOString(),
      trainMatches: a,
      matches: items.length,
      level: proc.chosen.level,
      rules: proc.rules.rules.length,
      publishedRules: filtered.rules.rules.length,
      all: { ...statsOf(all), picks: all.length },
      published: { ...statsOf(published), picks: published.length },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluación completa (build y script)
// ---------------------------------------------------------------------------

export interface EvaluateOptions extends HistoryOptions {
  /** fracción más antigua (por partidos) usada para calibrar. Default 0.6 */
  calibrationFraction?: number;
  /** fracción final del TOTAL reservada como tramo final dentro del holdout. Default 0.15 */
  virginFraction?: number;
  /** días de picks resueltos recientes (walk-forward publicado). Default 30 */
  recentDays?: number;
  procedure?: ProcedureOptions;
  select?: SelectOptions;
  walkForward?: Omit<WalkForwardOptions, 'procedure' | 'select'>;
  /** historial ya calculado (para no repetir el walk-forward) */
  history?: ConfidenceHistoryItem[];
}

export interface FamilySegmentRow {
  /** fuente de la predicción (undefined = reglas sin segmentar) */
  segment?: ConfidenceSegment;
  /** umbral elegido en calibración (undefined = descartada o sin validar) */
  threshold?: number;
  goldThreshold?: number;
  /** cola en calibración (o mejor cola encontrada si se descartó) */
  calibration: { candidates: number; n: number; hitRate: number; wilsonLow: number };
  rejectedReason?: string;
  /** validación fuera de muestra de la regla con los tramos walk-forward anteriores al holdout */
  calibrationValidation?: { n: number; hits: number; hitRate: number; validated: boolean };
  /** umbral y cola con TODO el histórico (reglas del procedimiento en producción) */
  production?: { threshold: number; goldThreshold?: number; n: number; hitRate: number };
  /** validación fuera de muestra de la regla con TODO el walk-forward y si se publica en producción */
  productionValidation?: { n: number; hits: number; hitRate: number; validated: boolean };
  /** excluida de antemano (EXCLUDED_RULES) */
  excluded?: string;
}

export interface FamilyRow {
  family: ConfidenceFamily;
  label: string;
  theme: ConfidenceTheme;
  segments: FamilySegmentRow[];
  /** picks publicados de la familia en el holdout (todas las fuentes), con tasa base y lift */
  holdout?: GroupReport;
  /** tasa base de la familia en el holdout (su selección natural sin umbral en todos los partidos con dato) */
  holdoutBase?: HitStats;
  /** picks publicados de la familia en el walk-forward mensual */
  walkForward?: GroupReport;
}

export interface ConfidenceEvaluation {
  generatedAt: string;
  split: {
    calibrationFraction: number;
    /** inicio (día UTC) del holdout */
    cutoff: string;
    calibration: { from: string; to: string; matches: number };
    holdout: { from: string; to: string; matches: number };
    /** inicio (día UTC) del tramo final del holdout */
    virginCutoff: string;
    virgin: { from: string; to: string; matches: number };
  };
  /** descripción del procedimiento (pre-registrado) */
  procedure: string[];
  /** reglas de PRODUCCIÓN: procedimiento con TODO el histórico, solo las validadas fuera de muestra (F4) */
  rules: ConfidenceRules;
  /** reglas del procedimiento en producción que no superan la validación (no se publican) */
  unvalidated: UnvalidatedRule[];
  /** validación por regla con todo el walk-forward */
  validation: RuleValidation[];
  productionChoice: ProcedureResult['chosen'];
  productionLog: ProcedureLevelLog[];
  /** reglas ajustadas solo con calibración y validadas con los tramos walk-forward anteriores al holdout */
  calibrationRules: ConfidenceRules;
  calibrationUnvalidated: UnvalidatedRule[];
  calibrationChoice: ProcedureResult['chosen'];
  calibrationLog: ProcedureLevelLog[];
  /** picks de calibración con sus propias reglas (dentro de muestra: optimista) */
  calibration: ConfidenceReport;
  holdout: ConfidenceReport;
  /** picks resueltos del holdout (reglas de calibración validadas) */
  holdoutPicks: SettledPick[];
  /** holdout antes del tramo final y tramo final */
  holdoutEarly: ConfidenceReport;
  virgin: ConfidenceReport;
  /** walk-forward mensual de todo el procedimiento (picks publicados: reglas validadas con los tramos anteriores) */
  walkForward: ConfidenceReport & { folds: WalkForwardFold[] };
  byFamily: FamilyRow[];
  /** reglas excluidas de antemano */
  excluded: { key: string; reason: string }[];
  /** picks publicados del walk-forward de los últimos `recentDays` días (fuera de muestra), más recientes primero */
  recentSettled: SettledPick[];
}

export const PROCEDURE_TEXT = [
  'Historial walk-forward: cada partido terminado de la temporada actual se predice solo con datos anteriores a su inicio (Elo pre-partido, Dixon-Coles re-ajustado con partidos anteriores, parámetros de pretemporada, proyecciones NB con partidos de días anteriores y cuotas de cierre). Partidos con prórroga o penaltis: goles a 90 minutos con los eventos de gol (si no cuadran, se excluyen) y sin córners ni tarjetas. Un total de 0 tarjetas cuenta como dato ausente.',
  'Corte temporal: calibración = 60 % más antiguo de los partidos (cortando por día UTC); holdout = el resto, que nunca se usa para ajustar umbrales. El 15 % final del total es el tramo final del holdout.',
  'Por familia y fuente (con cuotas / sin cuotas): recalibración de Platt; umbral mínimo de probabilidad (rejilla 0,50–0,93) cuya cola acierta >= objetivo con n >= 80 y límite inferior de Wilson (90 %) >= mínimo; umbral oro con acierto >= 0,87; lo que no cumple se descarta.',
  'Exigencia elegida solo con la calibración: validación interna con ventana creciente (último 40 % de la calibración en 3 tramos) sobre la escalera 0,82/0,78 → 0,84/0,80 → 0,86/0,82 → 0,88/0,84 (objetivo/Wilson). Se quitan reglas con acierto < 0,78 (n >= 30) en validación y se acepta el primer nivel con acierto conjunto >= 0,82 y Wilson >= 0,78.',
  'Excluida de antemano: «más de 2,5 tarjetas» (las dos fuentes), por su acierto fuera de muestra en el walk-forward (74,4 %).',
  'Validación por regla (familia|fuente): walk-forward mensual del procedimiento (cada mes, reglas ajustadas con todo lo anterior). Solo se publican reglas con >= 30 picks y acierto >= 80 % acumulados fuera de muestra en los tramos anteriores; el resto quedan como no publicadas.',
  'Publicación: solo el nivel oro (franjas que aciertan >= 85 % en el histórico con el que se ajustó su regla); como mucho 2 picks por partido, de temas distintos (resultado, goles, córners, tarjetas), por probabilidad recalibrada.',
  'Producción: el mismo procedimiento aplicado a TODO el historial, validado con TODO el walk-forward.',
];

/** Evaluación honesta (calibración → holdout), walk-forward mensual y reglas de producción. */
export function evaluateConfidence(ctx: BuildContext, opts: EvaluateOptions = {}): ConfidenceEvaluation {
  const history = opts.history ?? confidenceHistory(ctx, opts);
  const calFrac = opts.calibrationFraction ?? 0.6;
  const virginFrac = opts.virginFraction ?? 0.15;
  const recentDays = opts.recentDays ?? 30;
  const select = opts.select ?? {};
  const cut = dayCut(history, calFrac);
  const vcut = Math.max(cut, dayCut(history, 1 - virginFrac));
  const calib = history.slice(0, cut);
  const hold = history.slice(cut);
  const early = history.slice(cut, vcut);
  const virgin = history.slice(vcut);
  const dayStart = (xs: ConfidenceHistoryItem[]) => (xs[0] ? Math.floor(Date.parse(xs[0].date) / DAY_MS) * DAY_MS : Infinity);
  const cutoffT = dayStart(hold);

  const calProc = fitConfidenceProcedure(calib, { ...opts.procedure, select });
  const prodProc = fitConfidenceProcedure(history, { ...opts.procedure, select });
  const wf = walkForwardConfidence(history, { ...opts.walkForward, procedure: opts.procedure, select });
  const segmented = prodProc.rules.options.segmented;
  // validación de las reglas de calibración: solo tramos walk-forward anteriores al holdout (sin mirar el holdout)
  const calValidation = ruleValidation(
    wf.candidatePicks.filter((p) => Date.parse(p.date) < cutoffT),
    calProc.rules.options.segmented,
    opts.walkForward?.validation,
  );
  const calFiltered = filterValidatedRules(calProc.rules, calValidation, opts.walkForward?.validation);
  const prodValidation = ruleValidation(wf.candidatePicks, segmented, opts.walkForward?.validation);
  const prodFiltered = filterValidatedRules(prodProc.rules, prodValidation, opts.walkForward?.validation);

  const calPicks = settlePicks(calib, calFiltered.rules, select);
  const holdPicks = settlePicks(hold, calFiltered.rules, select);
  const earlyIds = new Set(early.map((i) => i.matchId));
  const span = (xs: ConfidenceHistoryItem[]) => ({ from: xs[0]?.date ?? '', to: xs[xs.length - 1]?.date ?? '', matches: xs.length });
  const dayIso = (xs: ConfidenceHistoryItem[]) => (xs[0] ? new Date(dayStart(xs)).toISOString() : '');

  const holdout = confidenceReport(hold, holdPicks);
  const wfReport = confidenceReport(wf.items, wf.published);
  const holdBase = familyBaseRates(hold);
  const segs: (ConfidenceSegment | undefined)[] = segmented ? ['mercado', 'estadistico'] : [undefined];
  const fixedKeys = new Map((opts.procedure?.fixedExclude ? opts.procedure.fixedExclude.map((key) => ({ key, reason: '' })) : EXCLUDED_RULES).map((r) => [r.key, r.reason]));
  const vrow = (v: RuleValidation | undefined) => (v ? { n: v.n, hits: v.hits, hitRate: v.hitRate, validated: v.validated } : undefined);
  const byFamily: FamilyRow[] = CONFIDENCE_FAMILIES.map((f) => {
    const segments = segs.map((segment): FamilySegmentRow => {
      const key = ruleKey(f.id, segment);
      const r = calProc.rules.rules.find((x) => x.family === f.id && x.segment === segment);
      const rValidated = calFiltered.rules.rules.includes(r as ConfidenceRule);
      const rej = calProc.rules.rejected.find((x) => x.family === f.id && x.segment === segment);
      const pr = prodProc.rules.rules.find((x) => x.family === f.id && x.segment === segment);
      const row: FamilySegmentRow = {
        calibration: r
          ? { candidates: r.candidates, n: r.tail.n, hitRate: r.tail.hitRate, wilsonLow: r.tail.wilsonLow }
          : { candidates: rej?.candidates ?? 0, n: rej?.best?.n ?? 0, hitRate: rej?.best?.hitRate ?? 0, wilsonLow: rej?.best?.wilsonLow ?? 0 },
      };
      if (segment) row.segment = segment;
      const excluded = fixedKeys.get(key) ?? fixedKeys.get(f.id);
      if (excluded !== undefined) row.excluded = excluded || 'excluida de antemano';
      const cv = vrow(calValidation.get(key));
      if (cv) row.calibrationValidation = cv;
      if (r && rValidated) {
        row.threshold = r.threshold;
        if (r.goldThreshold !== undefined) row.goldThreshold = r.goldThreshold;
      } else if (r) {
        row.rejectedReason = `sin validar fuera de muestra antes del holdout (${cv ? `${cv.hits}/${cv.n} = ${pct1(cv.hitRate)}` : 'sin picks'}; se exigen >= ${VALIDATION_MIN_N} y >= ${pct1(VALIDATION_MIN_RATE)})`;
      } else {
        row.rejectedReason = excluded !== undefined ? 'excluida de antemano' : (rej?.reason ?? 'quitada en la validación interna de la calibración (acierto < 78 %)');
      }
      if (pr) row.production = { threshold: pr.threshold, goldThreshold: pr.goldThreshold, n: pr.tail.n, hitRate: pr.tail.hitRate };
      const pv = vrow(prodValidation.get(key));
      if (pv) row.productionValidation = pv;
      return row;
    });
    const row: FamilyRow = { family: f.id, label: f.label, theme: f.theme, segments };
    const h = holdout.byFamily[f.id];
    if (h) row.holdout = h;
    const b = holdBase[f.id];
    if (b) row.holdoutBase = b;
    const w = wfReport.byFamily[f.id];
    if (w) row.walkForward = w;
    return row;
  });

  const lastT = history.length ? Date.parse(history[history.length - 1].date) : 0;
  const recentSettled = wf.published
    .filter((p) => Date.parse(p.date) > lastT - recentDays * DAY_MS)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || a.matchId.localeCompare(b.matchId));

  return {
    generatedAt: new Date(ctx.now).toISOString(),
    split: {
      calibrationFraction: calFrac,
      cutoff: dayIso(hold),
      calibration: span(calib),
      holdout: span(hold),
      virginCutoff: dayIso(virgin),
      virgin: span(virgin),
    },
    procedure: PROCEDURE_TEXT,
    rules: prodFiltered.rules,
    unvalidated: prodFiltered.unvalidated,
    validation: [...prodValidation.values()].sort((a, b) => a.key.localeCompare(b.key)),
    productionChoice: prodProc.chosen,
    productionLog: prodProc.log,
    calibrationRules: calFiltered.rules,
    calibrationUnvalidated: calFiltered.unvalidated,
    calibrationChoice: calProc.chosen,
    calibrationLog: calProc.log,
    calibration: confidenceReport(calib, calPicks),
    holdout,
    holdoutPicks: holdPicks,
    holdoutEarly: confidenceReport(
      early,
      holdPicks.filter((p) => earlyIds.has(p.matchId)),
    ),
    virgin: confidenceReport(
      virgin,
      holdPicks.filter((p) => !earlyIds.has(p.matchId)),
    ),
    walkForward: { ...wfReport, folds: wf.folds },
    byFamily,
    excluded: [...fixedKeys].map(([key, reason]) => ({ key, reason })),
    recentSettled,
  };
}
