/**
 * Motor del apartado «CUOTA ALTA 6+» (public/data/longshots.json; publicación en publish/longshots.ts).
 *
 * Apuestas cuya cuota es >= MIN_ODDS (6): por definición aciertan como mucho 1 de cada 6 veces y SOLO se gana a la larga
 * si la probabilidad real supera la implícita en la cuota (valor esperado > 0). El motor no promete nada: da para cada
 * apuesta la probabilidad del modelo, la cuota justa (1/p), la cuota de la casa cuando ESPN la publica y el valor
 * esperado, y mide la MISMA regla fuera de muestra (walk-forward) con el resultado a 90'.
 *
 * SELECCIONES POR PARTIDO (matchSelections), todas con la probabilidad del modelo y su forma de resolverse:
 *   '1x2'       resultado final (local / empate / visitante): 1X2 del ensamble (el mismo que publica la ficha), cuota de
 *               la casa (DraftKings vía ESPN) si hay un trío con margen plausible
 *   'marcador'  marcadores exactos de la matriz de marcadores (λ finales), sin cuota de la casa
 *   'goleador'  «marca en cualquier momento» de los jugadores ELEGIBLES (eligibleProps: minutos esperados >= 60, jugó
 *               alguno de los 2 últimos partidos y >= 270' en la ventana), sin cuota de la casa
 *   'total'     más/menos de la línea principal de goles de la casa (solo medias líneas), con su cuota
 *   'handicap'  hándicap principal de la casa (solo medias líneas: sin devolución), con su cuota
 *   Sin cuotas, resultado y goles exigen >= 10 partidos Elo previos de cada equipo (como alta confianza).
 *
 * CANDIDATOS (cuota mínima 6, usando la de la casa si existe y si no la justa; máximo MAX_SINGLE_ODDS = 15 en simples):
 *   'sorpresa'  1X2 con cuota >= 6 (victoria del no favorito o empate)
 *   'marcador'  los 2 marcadores más probables del partido cuya cuota justa es >= 6
 *   'goleador'  jugadores con P(marcar) entre 0,10 y 1/6 (cuota justa 6–10) y >= 60' esperados
 *   'combinada' 2–4 patas de PARTIDOS DISTINTOS (independientes; nunca dos del mismo partido) con cuota de la casa
 *               (1X2, más/menos o hándicap principales), cuota de cada pata entre 1,30 y 3,50 y probabilidad >= 0,25,
 *               cuyo producto de cuotas queda entre 6 y 12. Por partido entra su pata de mayor valor esperado; de las 12
 *               mejores se prueban todas las combinaciones de 2–4 (partidos distintos) y se elige la de mayor puntuación;
 *               se quitan sus partidos y se repite (máx. 4). Probabilidad = producto (recalibrada donde haya calibración).
 *   'otro'      reservado en el contrato (descanso/final, margen): no se genera.
 *
 * PUNTUACIÓN 0..100 (longshotScore): 40 % probabilidad respecto a la de cuota 6 (min(1, 6·p)), 40 % valor esperado
 * (0,5 + EV, recortado a [0, 1]; sin cuota de la casa se asume EV = UNPRICED_EV = −20 %, el margen típico de los mercados
 * de marcador y goleador, que la casa no publica en ESPN) y 20 % prestigio de la competición (tier / 10).
 *
 * REGLA DIARIA (selectLongshotDay): por día local (HOME_TIMEZONE), por puntuación, como mucho 4 por tipo, sin repetir
 * partido dentro de un tipo, y 12 en total.
 *
 * RECALIBRACIÓN (opcional, `calibrate`): Platt (fitPlatt de alta confianza) por grupo de selección, ajustado SOLO con
 * selecciones resueltas de días anteriores (walk-forward: reajuste al empezar cada mes) y con >= CAL_MIN_ROWS filas.
 *
 * HISTORIAL (longshotWalkForward): la misma regla aplicada a cada día pasado con las predicciones walk-forward (solo
 * datos anteriores a cada partido; cuotas de cierre) y resuelta a 90'. Por tipo: apuestas, aciertos, % (Wilson 90 %),
 * probabilidad media del modelo, cuota media, ROI plano de 1 unidad contra las cuotas de CIERRE (solo apuestas con
 * cuota en todas sus patas) y racha de derrotas más larga. Calibración del modelo en la banda 0,05–0,25.
 */
import type { CalibrationBin, DailyCategory, LongshotKind, OddsSnapshot, PlayerProp, Prob1X2, TeamRef } from '../../src/types/data';
import { goalDiffDist, totalGoalsDist } from '../../src/lib/models';
import { isPlausibleMargin, overroundOf } from '../config';
import {
  DEFAULT_MIN_TEAM_GAMES,
  WILSON_Z90,
  fitPlatt,
  plattProb,
  settleCandidate,
  wilsonInterval,
  type CandidateResult,
  type ConfidenceSettle,
  type ExtraSettleData,
  type PlattFit,
} from './confidence';
import type { SettleData } from './settle';
import { localDay } from '../publish/util';

// ---------------------------------------------------------------------------
// Parámetros
// ---------------------------------------------------------------------------

/** Cuota mínima del apartado. */
export const MIN_ODDS = 6;
/** Cuota máxima de una apuesta simple (más allá: menos de 1 de cada 15). */
export const MAX_SINGLE_ODDS = 15;
/** Combinadas: producto de cuotas entre MIN_ODDS y COMBO_MAX_ODDS, de 2 a 4 patas. */
export const COMBO_MAX_ODDS = 12;
export const COMBO_MIN_LEGS = 2;
export const COMBO_MAX_LEGS = 4;
/**
 * Patas candidatas entre las que se buscan las combinadas: las COMBO_POOL de mayor valor esperado, como mucho
 * COMBO_LEGS_PER_MATCH por partido. Una por partido: cuantas más opciones se exploran según el valor esperado del modelo,
 * más se seleccionan sus errores (las apuestas con EV > 0 del modelo pierden contra el cierre; ver eval-longshots).
 */
export const COMBO_POOL = 12;
export const COMBO_LEGS_PER_MATCH = 1;
/** Pata de combinada: cuota de la casa en [LEG_MIN_ODDS, LEG_MAX_ODDS] y probabilidad >= LEG_MIN_PROB. */
export const LEG_MIN_ODDS = 1.3;
export const LEG_MAX_ODDS = 3.5;
export const LEG_MIN_PROB = 0.25;
/** Goleador: P(marcar) mínima (la máxima es 1/MIN_ODDS) y minutos esperados mínimos. */
export const SCORER_MIN_PROB = 0.1;
export const SCORER_MIN_EXP_MINUTES = 60;
/** Marcadores exactos candidatos por partido (los más probables con cuota justa >= 6). */
export const SCORES_PER_MATCH = 2;
/** Celdas de la matriz que se guardan (marcadores con al menos esta probabilidad). */
export const SCORE_MIN_CELL = 0.01;
/** Regla diaria. */
export const MAX_PER_KIND = 4;
export const MAX_PER_DAY = 12;
/** Valor esperado asumido para puntuar una apuesta sin cuota de la casa (marcador, goleador). */
export const UNPRICED_EV = -0.2;
/** Recalibración de Platt: filas mínimas (resueltas, sin nulos) y aciertos mínimos por grupo. */
export const CAL_MIN_ROWS = 300;
export const CAL_MIN_HITS = 20;
/** Banda de la tabla de calibración (bins de 0,05). */
export const CAL_BAND: [number, number] = [0.05, 0.25];
export const CAL_BIN = 0.05;
/** Publicación de un tipo: muestra mínima fuera de muestra y calibración mínima (Wilson alto >= 70 % de lo prometido). */
export const GATE_MIN_N = 30;
export const GATE_MIN_RATIO = 0.7;

export const KIND_ORDER: LongshotKind[] = ['combinada', 'sorpresa', 'marcador', 'goleador', 'otro'];
export const KIND_LABEL: Record<LongshotKind, string> = {
  combinada: 'Combinadas',
  sorpresa: 'Sorpresas (1X2)',
  marcador: 'Marcador exacto',
  goleador: 'Goleador',
  otro: 'Otros mercados',
};
/** Tipos que el motor genera ('otro' está reservado en el contrato). */
export const GENERATED_KINDS: LongshotKind[] = ['combinada', 'sorpresa', 'marcador', 'goleador'];

const EPS = 1e-9;
const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Cómo se resuelve una selección: las de alta confianza (resultado, goles, hándicap, jugador) + marcador exacto. */
export type LongshotSettle = ConfidenceSettle | { kind: 'score'; home: number; away: number };

/** Grupo de una selección (y de su recalibración). */
export type LongshotGroup = '1x2' | 'marcador' | 'goleador' | 'total' | 'handicap';
export const LONGSHOT_GROUPS: LongshotGroup[] = ['1x2', 'marcador', 'goleador', 'total', 'handicap'];

export interface LongshotMatchInfo {
  matchId: string;
  compId: string;
  compName: string;
  /** ISO, inicio del partido */
  date: string;
  home: TeamRef;
  away: TeamRef;
  /** prestigio de la competición 1..10 */
  tier: number;
  /** goles esperados del modelo (para los textos) */
  xg?: { home: number; away: number };
}

export interface LongshotInput extends LongshotMatchInfo {
  /** 1X2 final del ensamble */
  p: Prob1X2;
  /** matriz de marcadores con los λ finales */
  matrix: number[][];
  /** cuotas (actuales en partidos próximos; de cierre en terminados) */
  odds?: OddsSnapshot;
  lambdaHome?: number;
  lambdaAway?: number;
  /** props de los jugadores ELEGIBLES (eligibleProps) */
  players?: { home: PlayerProp[]; away: PlayerProp[] };
  /** partidos Elo previos del equipo con menos historial (sin cuotas, resultado y goles exigen >= 10) */
  minEloGames?: number;
  /** la predicción usó el 1X2 sin margen de la casa */
  withMarket?: boolean;
}

export interface LongshotSelection {
  group: LongshotGroup;
  match: LongshotMatchInfo;
  /** clave única dentro del partido */
  key: string;
  market: string;
  selection: string;
  /** probabilidad del modelo sin recalibrar */
  rawProb: number;
  /** probabilidad publicada (recalibrada si hay calibración de su grupo) */
  prob: number;
  /** cuota de la casa (cierre en partidos terminados) */
  marketOdds?: number;
  category: DailyCategory;
  settle: LongshotSettle;
  player?: { id: string; name: string; short: string; teamId: string };
  /** marcadores: posición por probabilidad dentro del partido (1 = el más probable) */
  rank?: number;
  /** goleador: datos de la ventana anterior al partido (para el texto) */
  scorer?: { goals: number; minutes: number; apps: number; expMinutes: number; team: string };
  /** resultado (partidos terminados) */
  result?: CandidateResult;
}

export interface LongshotEngineBet {
  id: string;
  kind: LongshotKind;
  label: string;
  legs: LongshotSelection[];
  prob: number;
  fairOdds: number;
  marketOdds?: number;
  displayOdds: number;
  ev?: number;
  oneIn: number;
  score: number;
  /** fecha (ISO) de la primera pata */
  date: string;
  /** todas las patas resueltas: 'hit' / alguna 'miss' / alguna nula (y ninguna fallada) 'void' */
  result?: CandidateResult;
}

/** Platt por clave de calibración (calibrationKey). */
export type LongshotCalibrator = Partial<Record<string, PlattFit>>;

// ---------------------------------------------------------------------------
// Cuotas de la casa
// ---------------------------------------------------------------------------

const validPrice = (o: number | undefined): o is number => typeof o === 'number' && Number.isFinite(o) && o > 1 && o < 1000;
const isHalfLine = (x: number | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && Math.abs(Math.abs(x % 1) - 0.5) < 1e-6;

function trio(odds: OddsSnapshot | undefined): { home: number; draw: number; away: number } | undefined {
  if (!odds || !validPrice(odds.home) || !validPrice(odds.draw) || !validPrice(odds.away)) return undefined;
  if (!isPlausibleMargin(overroundOf(odds.home, odds.draw, odds.away))) return undefined;
  return { home: odds.home, draw: odds.draw, away: odds.away };
}

function pair(a: number | undefined, b: number | undefined): [number, number] | undefined {
  if (!validPrice(a) || !validPrice(b)) return undefined;
  if (!isPlausibleMargin(overroundOf(a, b))) return undefined;
  return [a, b];
}

const signed = (x: number) => `${x > 0 ? '+' : x < 0 ? '-' : ''}${Math.abs(x)}`;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------------------
// Selecciones de un partido
// ---------------------------------------------------------------------------

function sel(match: LongshotMatchInfo, s: Omit<LongshotSelection, 'match' | 'prob'> & { prob?: number }): LongshotSelection {
  const raw = clamp01(s.rawProb);
  const out: LongshotSelection = { ...s, match, rawProb: raw, prob: raw };
  if (s.marketOdds === undefined || !validPrice(s.marketOdds)) delete out.marketOdds;
  else out.marketOdds = r3(s.marketOdds);
  return out;
}

/**
 * Todas las selecciones de un partido (sin el filtro de cuota): 1X2, marcadores (celdas >= SCORE_MIN_CELL), goleadores
 * elegibles, más/menos y hándicap principales de la casa. Probabilidades sin recalibrar (prob = rawProb).
 */
export function matchSelections(input: LongshotInput): LongshotSelection[] {
  const info: LongshotMatchInfo = {
    matchId: input.matchId,
    compId: input.compId,
    compName: input.compName,
    date: input.date,
    home: input.home,
    away: input.away,
    tier: input.tier,
  };
  if (Number.isFinite(input.lambdaHome) && Number.isFinite(input.lambdaAway)) info.xg = { home: input.lambdaHome!, away: input.lambdaAway! };
  const H = input.home.name?.trim() || 'Local';
  const A = input.away.name?.trim() || 'Visitante';
  const out: LongshotSelection[] = [];
  const t3 = trio(input.odds);
  const withMarket = input.withMarket ?? !!t3;
  // sin mercado, el modelo apenas conoce a equipos con poco historial: ni resultado ni goles
  const goalsOk = withMarket || input.minEloGames === undefined || input.minEloGames >= DEFAULT_MIN_TEAM_GAMES;
  if (!goalsOk) return out;

  // ---- 1X2
  const p = input.p;
  const okP = [p?.home, p?.draw, p?.away].every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0);
  const sumP = okP ? p.home + p.draw + p.away : 0;
  if (sumP > 0) {
    for (const side of ['home', 'draw', 'away'] as const) {
      out.push(
        sel(info, {
          group: '1x2',
          key: `1x2-${side}`,
          market: 'Resultado final (1X2)',
          selection: side === 'draw' ? 'Empate' : `Gana ${side === 'home' ? H : A}`,
          rawProb: p[side] / sumP,
          marketOdds: t3?.[side],
          category: 'resultado',
          settle: { kind: 'outcome', win: [side] },
        }),
      );
    }
  }

  // ---- matriz: marcadores, más/menos y hándicap
  const m = input.matrix;
  const okM = Array.isArray(m) && m.length > 1 && m.every((r) => Array.isArray(r) && r.every((v) => Number.isFinite(v) && v >= 0));
  if (okM) {
    let total = 0;
    for (const row of m) for (const v of row) total += v;
    if (total > 0) {
      const cells: { i: number; j: number; prob: number }[] = [];
      for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) if (m[i][j] / total >= SCORE_MIN_CELL) cells.push({ i, j, prob: m[i][j] / total });
      cells.sort((a, b) => b.prob - a.prob || a.i - b.i || a.j - b.j);
      cells.forEach((c, k) =>
        out.push(
          sel(info, {
            group: 'marcador',
            key: `score-${c.i}-${c.j}`,
            market: 'Marcador exacto',
            selection: `${H} ${c.i}-${c.j} ${A}`,
            rawProb: c.prob,
            category: 'goles',
            settle: { kind: 'score', home: c.i, away: c.j },
            rank: k + 1,
          }),
        ),
      );
      const odds = input.odds;
      const line = odds?.totalLine;
      const ou = pair(odds?.over, odds?.under);
      if (ou && isHalfLine(line) && line > 0) {
        const dist = totalGoalsDist(m);
        const k = Math.floor(line);
        let under = 0;
        for (let g = 0; g <= k && g < dist.length; g++) under += dist[g];
        for (const side of ['over', 'under'] as const) {
          out.push(
            sel(info, {
              group: 'total',
              key: `ou-${line}-${side}`,
              market: `Más/Menos ${line} goles`,
              selection: `${side === 'over' ? 'Más' : 'Menos'} de ${line} goles`,
              rawProb: side === 'over' ? 1 - under : under,
              marketOdds: side === 'over' ? ou[0] : ou[1],
              category: 'goles',
              settle: { kind: 'total', stat: 'goals', side, line },
            }),
          );
        }
      }
      const sl = odds?.spreadLine;
      const ah = pair(odds?.spreadHome, odds?.spreadAway);
      if (ah && isHalfLine(sl)) {
        const diff = goalDiffDist(m);
        // local con la línea de la casa (sl): gana si (gl − gv) + sl > 0; visitante con −sl: si (gv − gl) − sl > 0
        let homeWin = 0;
        diff.p.forEach((v, idx) => {
          if (diff.min + idx + sl > 0) homeWin += v;
        });
        out.push(
          sel(info, {
            group: 'handicap',
            key: `ah-home-${sl}`,
            market: `Hándicap ${H} ${signed(sl)}`,
            selection: `${H} ${signed(sl)}`,
            rawProb: homeWin,
            marketOdds: ah[0],
            category: 'resultado',
            settle: { kind: 'handicap', side: 'home', line: sl },
          }),
          sel(info, {
            group: 'handicap',
            key: `ah-away-${-sl}`,
            market: `Hándicap ${H} ${signed(sl)}`,
            selection: `${A} ${signed(-sl)}`,
            rawProb: 1 - homeWin,
            marketOdds: ah[1],
            category: 'resultado',
            settle: { kind: 'handicap', side: 'away', line: -sl },
          }),
        );
      }
    }
  }

  // ---- goleadores (jugadores elegibles)
  for (const side of ['home', 'away'] as const) {
    const team = side === 'home' ? H : A;
    for (const pr of input.players?.[side] ?? []) {
      const pl = pr.player;
      if (!pl?.id || !(pr.pGoal > 0) || !(pr.expMinutes >= SCORER_MIN_EXP_MINUTES)) continue;
      out.push(
        sel(info, {
          group: 'goleador',
          key: `scorer-${pl.id}`,
          market: 'Goleador (en cualquier momento)',
          selection: `${pl.name} (${team}) marca`,
          rawProb: pr.pGoal,
          category: 'jugadores',
          settle: { kind: 'player', playerId: pl.id, stat: 'goals', min: 1 },
          player: { id: pl.id, name: pl.name, short: pl.short || pl.name, teamId: pl.teamId },
          scorer: { goals: pr.goals, minutes: pr.minutes, apps: pr.apps, expMinutes: pr.expMinutes, team },
        }),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolución
// ---------------------------------------------------------------------------

/** Resultado de una selección a 90' (undefined si falta el dato: el partido no la resuelve). */
export function settleLongshot(s: LongshotSettle, d: SettleData & ExtraSettleData): CandidateResult | undefined {
  if (s.kind === 'score') return d.hg === s.home && d.ag === s.away ? 'hit' : 'miss';
  return settleCandidate({ settle: s }, d);
}

/** Resultado de una apuesta: alguna pata fallada ⇒ 'miss'; todas resueltas ⇒ 'void' si alguna es nula, si no 'hit'. */
export function betResult(results: (CandidateResult | undefined)[]): CandidateResult | undefined {
  if (results.some((r) => r === 'miss')) return 'miss';
  if (results.some((r) => r === undefined)) return undefined;
  return results.some((r) => r === 'void') ? 'void' : 'hit';
}

// ---------------------------------------------------------------------------
// Recalibración (Platt por grupo)
// ---------------------------------------------------------------------------

/**
 * Clave de calibración: el grupo, y en el 1X2 la cola baja aparte (prob < CAL_1X2_LOW: sorpresas y patas de no
 * favorito). Un Platt de dos parámetros ajustado con TODO el 1X2 queda casi en la identidad porque el grueso está bien
 * calibrado, y no corrige la cola, que es justo donde viven las sorpresas.
 */
export const CAL_1X2_LOW = 0.35;
export function calibrationKey(s: Pick<LongshotSelection, 'group' | 'rawProb'>): string {
  return s.group === '1x2' && s.rawProb < CAL_1X2_LOW ? '1x2-bajo' : s.group;
}

/** Ajusta un Platt por clave con selecciones resueltas (sin nulos); sin filas suficientes, la clave queda sin recalibrar. */
export function fitLongshotCalibrator(sels: Iterable<LongshotSelection>): LongshotCalibrator {
  const rows = new Map<string, { prob: number; hit: boolean }[]>();
  for (const s of sels) {
    if (s.result !== 'hit' && s.result !== 'miss') continue;
    const key = calibrationKey(s);
    const arr = rows.get(key);
    const row = { prob: s.rawProb, hit: s.result === 'hit' };
    if (arr) arr.push(row);
    else rows.set(key, [row]);
  }
  const out: LongshotCalibrator = {};
  for (const [g, list] of rows) {
    const hits = list.filter((r) => r.hit).length;
    if (list.length < CAL_MIN_ROWS || hits < CAL_MIN_HITS) continue;
    const f = fitPlatt(list);
    if (f && f.b > 0) out[g] = f;
  }
  return out;
}

/** Copia de la selección con la probabilidad publicada según el calibrador. */
export function calibrated(s: LongshotSelection, cal: LongshotCalibrator | undefined): LongshotSelection {
  const f = cal?.[calibrationKey(s)];
  const prob = f ? clamp01(plattProb(f, s.rawProb)) : s.rawProb;
  return prob === s.prob ? s : { ...s, prob };
}

// ---------------------------------------------------------------------------
// Apuestas
// ---------------------------------------------------------------------------

/** Puntuación 0..100: 40 % probabilidad respecto a la de cuota 6, 40 % valor esperado, 20 % prestigio. */
export function longshotScore(prob: number, ev: number | undefined, tier: number): number {
  const pNorm = clamp01(prob * MIN_ODDS);
  const v = clamp01(0.5 + (ev ?? UNPRICED_EV));
  const t = clamp01(tier / 10);
  return Math.round(1000 * (0.4 * pNorm + 0.4 * v + 0.2 * t)) / 10;
}

const pctInt = (x: number) => `${Math.round(clamp01(x) * 100)} %`;

/** Apuesta a partir de sus patas: probabilidad = producto, cuota de la casa = producto si todas la tienen. */
export function makeBet(kind: LongshotKind, legs: LongshotSelection[]): LongshotEngineBet {
  const sorted = legs.slice().sort((a, b) => Date.parse(a.match.date) - Date.parse(b.match.date) || a.match.matchId.localeCompare(b.match.matchId));
  let prob = 1;
  let market = 1;
  let priced = true;
  let tier = 0;
  for (const l of sorted) {
    prob *= l.prob;
    if (l.marketOdds !== undefined) market *= l.marketOdds;
    else priced = false;
    tier += l.match.tier;
  }
  prob = Math.max(prob, 1e-6);
  const fair = 1 / prob;
  const marketOdds = priced ? market : undefined;
  const ev = marketOdds !== undefined ? prob * marketOdds - 1 : undefined;
  const first = sorted[0];
  const label =
    kind === 'combinada'
      ? `Combinada de ${sorted.length} partidos`
      : kind === 'sorpresa'
        ? `Sorpresa: ${first.selection === 'Empate' ? 'empate' : first.selection.replace(/^Gana /, 'gana ')}`
        : kind === 'marcador'
          ? `Marcador exacto ${first.key.replace(/^score-/, '')}`
          : kind === 'goleador'
            ? `Goleador: ${first.player?.short || first.player?.name || first.selection}`
            : first.selection;
  const id =
    kind === 'combinada'
      ? `combinada-${sorted.map((l) => `${l.match.matchId}.${l.key}`).join('-')}`
      : `${kind}-${first.match.matchId}-${first.key}`;
  const out: LongshotEngineBet = {
    id,
    kind,
    label,
    legs: sorted,
    prob,
    fairOdds: fair,
    displayOdds: marketOdds ?? fair,
    oneIn: Math.max(1, Math.round(fair)),
    score: longshotScore(prob, ev, tier / sorted.length),
    date: first.match.date,
  };
  if (marketOdds !== undefined) out.marketOdds = marketOdds;
  if (ev !== undefined) out.ev = ev;
  const res = betResult(sorted.map((l) => l.result));
  if (res) out.result = res;
  return out;
}

/** Apuestas simples de un partido (selecciones ya recalibradas): sorpresas, marcadores y goleadores con cuota >= 6. */
export function singleBets(sels: LongshotSelection[]): LongshotEngineBet[] {
  const out: LongshotEngineBet[] = [];
  const inRange = (o: number) => o >= MIN_ODDS - EPS && o <= MAX_SINGLE_ODDS + EPS;
  for (const s of sels) {
    if (s.group !== '1x2' || !(s.prob > 0)) continue;
    if (inRange(s.marketOdds ?? 1 / s.prob)) out.push(makeBet('sorpresa', [s]));
  }
  const scores = sels.filter((s) => s.group === 'marcador' && s.prob > 0 && inRange(1 / s.prob)).sort((a, b) => b.prob - a.prob || (a.rank ?? 0) - (b.rank ?? 0));
  for (const s of scores.slice(0, SCORES_PER_MATCH)) out.push(makeBet('marcador', [s]));
  for (const s of sels) {
    if (s.group !== 'goleador' || !(s.prob >= SCORER_MIN_PROB - EPS) || !(s.prob <= 1 / MIN_ODDS + EPS)) continue;
    if ((s.scorer?.expMinutes ?? 0) < SCORER_MIN_EXP_MINUTES) continue;
    out.push(makeBet('goleador', [s]));
  }
  return out;
}

/** Pata válida para combinadas: cuota de la casa en rango y probabilidad mínima. */
export function isComboLeg(s: LongshotSelection): boolean {
  return (
    (s.group === '1x2' || s.group === 'total' || s.group === 'handicap') &&
    s.marketOdds !== undefined &&
    s.marketOdds >= LEG_MIN_ODDS - EPS &&
    s.marketOdds <= LEG_MAX_ODDS + EPS &&
    s.prob >= LEG_MIN_PROB - EPS
  );
}

const legEv = (s: LongshotSelection) => s.prob * (s.marketOdds ?? 0) - 1;

export const cmpBet = (a: LongshotEngineBet, b: LongshotEngineBet) => b.score - a.score || b.prob - a.prob || a.id.localeCompare(b.id);

/**
 * Combinadas de un día: las patas válidas ordenadas por valor esperado (como mucho COMBO_LEGS_PER_MATCH de cada
 * partido: su mejor pata); entre las COMBO_POOL primeras, todas las combinaciones de 2–4 patas de PARTIDOS DISTINTOS
 * (nunca dos del mismo partido: están correlacionadas) con producto de cuotas en [6, 12]; la de mayor puntuación (a
 * igualdad, la de menos patas); se quitan sus partidos y se repite (máx. `max`).
 */
export function buildLongshotCombos(sels: LongshotSelection[], max = MAX_PER_KIND): LongshotEngineBet[] {
  const better = (a: LongshotSelection, b: LongshotSelection) => legEv(a) - legEv(b) || a.prob - b.prob || b.key.localeCompare(a.key);
  const sorted = sels.filter(isComboLeg).sort((a, b) => -better(a, b) || a.match.matchId.localeCompare(b.match.matchId));
  const perMatch = new Map<string, number>();
  let available: LongshotSelection[] = [];
  for (const s of sorted) {
    const n = perMatch.get(s.match.matchId) ?? 0;
    if (n >= COMBO_LEGS_PER_MATCH) continue;
    perMatch.set(s.match.matchId, n + 1);
    available.push(s);
  }
  const out: LongshotEngineBet[] = [];
  while (out.length < max && new Set(available.map((s) => s.match.matchId)).size >= COMBO_MIN_LEGS) {
    const pool = available.slice(0, COMBO_POOL);
    let chosen: LongshotEngineBet | undefined;
    const pick: LongshotSelection[] = [];
    const inPick = new Set<string>();
    const rec = (start: number, odds: number) => {
      if (pick.length >= COMBO_MIN_LEGS && odds >= MIN_ODDS - EPS && odds <= COMBO_MAX_ODDS + EPS) {
        const b = makeBet('combinada', pick);
        if (!chosen || cmpBet(b, chosen) < 0 || (b.score === chosen.score && b.legs.length < chosen.legs.length)) chosen = b;
      }
      if (pick.length >= COMBO_MAX_LEGS) return;
      for (let i = start; i < pool.length; i++) {
        const id = pool[i].match.matchId;
        if (inPick.has(id)) continue;
        const o = odds * (pool[i].marketOdds ?? 1);
        if (o > COMBO_MAX_ODDS + EPS) continue;
        pick.push(pool[i]);
        inPick.add(id);
        rec(i + 1, o);
        inPick.delete(id);
        pick.pop();
      }
    };
    rec(0, 1);
    if (!chosen) break;
    out.push(chosen);
    const used = new Set(chosen.legs.map((l) => l.match.matchId));
    available = available.filter((s) => !used.has(s.match.matchId));
  }
  return out;
}

/**
 * Regla diaria: por puntuación, como mucho `maxPerKind` por tipo (sin repetir partido dentro de un tipo) y `maxPerDay` en
 * total. `kinds`: tipos publicables (por defecto todos).
 */
export function selectLongshotDay(
  bets: LongshotEngineBet[],
  opts: { maxPerKind?: number; maxPerDay?: number; kinds?: ReadonlySet<LongshotKind> } = {},
): LongshotEngineBet[] {
  const maxPerKind = opts.maxPerKind ?? MAX_PER_KIND;
  const maxPerDay = opts.maxPerDay ?? MAX_PER_DAY;
  const count = new Map<LongshotKind, number>();
  const used = new Map<LongshotKind, Set<string>>();
  const out: LongshotEngineBet[] = [];
  for (const b of bets.slice().sort(cmpBet)) {
    if (out.length >= maxPerDay) break;
    if (opts.kinds && !opts.kinds.has(b.kind)) continue;
    if ((count.get(b.kind) ?? 0) >= maxPerKind) continue;
    const u = used.get(b.kind) ?? new Set<string>();
    if (b.legs.some((l) => u.has(l.match.matchId))) continue;
    for (const l of b.legs) u.add(l.match.matchId);
    used.set(b.kind, u);
    count.set(b.kind, (count.get(b.kind) ?? 0) + 1);
    out.push(b);
  }
  return out;
}

/** Candidatos de un día (selecciones de todos sus partidos, ya recalibradas) → apuestas seleccionadas. */
export function dayBets(selsByMatch: LongshotSelection[][], opts: { kinds?: ReadonlySet<LongshotKind> } = {}): LongshotEngineBet[] {
  const singles = selsByMatch.flatMap((s) => singleBets(s));
  const combos = opts.kinds && !opts.kinds.has('combinada') ? [] : buildLongshotCombos(selsByMatch.flat());
  return selectLongshotDay([...singles, ...combos], { kinds: opts.kinds });
}

// ---------------------------------------------------------------------------
// Historial walk-forward
// ---------------------------------------------------------------------------

/** Partido terminado con sus selecciones generadas ANTES del partido y ya resueltas a 90'. */
export interface LongshotHistoryItem {
  match: LongshotMatchInfo;
  selections: LongshotSelection[];
}

/** Selecciones de un partido terminado resueltas con su resultado (las que no se pueden resolver se descartan). */
export function historyItem(input: LongshotInput, d: SettleData & ExtraSettleData): LongshotHistoryItem {
  const selections: LongshotSelection[] = [];
  for (const s of matchSelections(input)) {
    const r = settleLongshot(s.settle, d);
    if (r) selections.push({ ...s, result: r });
  }
  const match = selections[0]?.match ?? { matchId: input.matchId, compId: input.compId, compName: input.compName, date: input.date, home: input.home, away: input.away, tier: input.tier };
  return { match, selections };
}

export interface KindRecord {
  kind: LongshotKind;
  bets: number;
  /** resueltas con acierto o fallo (sin nulos) */
  n: number;
  hits: number;
  voids: number;
  hitRate: number;
  wilsonLow: number;
  wilsonHigh: number;
  /** probabilidad media publicada de las resueltas */
  expectedHitRate: number;
  /** cuota media (displayOdds) */
  avgOdds: number;
  /** ROI plano (1 unidad) contra cuotas de cierre, solo apuestas con cuota en todas las patas (sin nulos) */
  roi?: { bets: number; staked: number; profit: number; roi: number };
  longestLosingStreak: number;
}

export interface LongshotWalkForward {
  /** primer y último día evaluados (YYYY-MM-DD) */
  from: string;
  to: string;
  days: number;
  /** apuestas seleccionadas y resueltas, cronológicas */
  bets: LongshotEngineBet[];
  byKind: KindRecord[];
  overall: Omit<KindRecord, 'kind'>;
  /** calibración del modelo en la banda 0,05–0,25 (todas las selecciones de tipo simple de los días evaluados) */
  calibration: CalibrationBin[];
  /** calibración por grupo de selección (diagnóstico) */
  calibrationByGroup: Partial<Record<LongshotGroup, CalibrationBin[]>>;
  /** apuestas con cuota de la casa que el modelo veía con valor esperado POSITIVO (resueltas, sin nulos) */
  evPositive: { bets: number; hits: number; profit: number; roi: number };
  /** calibrador ajustado con TODO el historial (producción) o undefined sin recalibración */
  calibrator?: LongshotCalibrator;
}

export interface LongshotWfOptions {
  timeZone: string;
  /** primer día evaluado (YYYY-MM-DD, incluido); los anteriores solo entrenan la recalibración */
  from?: string;
  /** primer día NO evaluado (YYYY-MM-DD; normalmente hoy) */
  to?: string;
  /** recalibración de Platt walk-forward (reajuste mensual con días anteriores) */
  calibrate?: boolean;
  /** tipos de la regla diaria (por defecto todos los generados) */
  kinds?: ReadonlySet<LongshotKind>;
}

function recordOf(bets: LongshotEngineBet[]): Omit<KindRecord, 'kind'> {
  let n = 0;
  let hits = 0;
  let voids = 0;
  let sp = 0;
  let so = 0;
  let streak = 0;
  let longest = 0;
  let roiBets = 0;
  let profit = 0;
  for (const b of bets) {
    so += b.displayOdds;
    if (b.result === 'void') {
      voids++;
      continue;
    }
    if (b.result !== 'hit' && b.result !== 'miss') continue;
    n++;
    sp += b.prob;
    if (b.result === 'hit') {
      hits++;
      streak = 0;
    } else longest = Math.max(longest, ++streak);
    if (b.marketOdds !== undefined) {
      roiBets++;
      profit += b.result === 'hit' ? b.marketOdds - 1 : -1;
    }
  }
  const [lo, hi] = wilsonInterval(hits, n, WILSON_Z90);
  const out: Omit<KindRecord, 'kind'> = {
    bets: bets.length,
    n,
    hits,
    voids,
    hitRate: n ? hits / n : 0,
    wilsonLow: lo,
    wilsonHigh: hi,
    expectedHitRate: n ? sp / n : 0,
    avgOdds: bets.length ? so / bets.length : 0,
    longestLosingStreak: longest,
  };
  if (roiBets > 0) out.roi = { bets: roiBets, staked: roiBets, profit, roi: profit / roiBets };
  return out;
}

/** Tabla de calibración en [lo, hi) con bins de `bin`. */
export function bandCalibration(rows: { p: number; y: 0 | 1 }[], lo = CAL_BAND[0], hi = CAL_BAND[1], bin = CAL_BIN): CalibrationBin[] {
  const nb = Math.round((hi - lo) / bin);
  const sp = new Array<number>(nb).fill(0);
  const sy = new Array<number>(nb).fill(0);
  const n = new Array<number>(nb).fill(0);
  for (const r of rows) {
    if (!(r.p >= lo - EPS) || !(r.p < hi - EPS)) continue;
    const b = Math.min(nb - 1, Math.floor((r.p - lo) / bin + EPS));
    sp[b] += r.p;
    sy[b] += r.y;
    n[b]++;
  }
  const out: CalibrationBin[] = [];
  for (let b = 0; b < nb; b++) {
    if (!n[b]) continue;
    out.push({ from: Math.round((lo + b * bin) * 100) / 100, to: Math.round((lo + (b + 1) * bin) * 100) / 100, predicted: sp[b] / n[b], observed: sy[b] / n[b], n: n[b] });
  }
  return out;
}

/** Filas de calibración de un partido: 1X2 completo, los 3 marcadores más probables y todos los goleadores elegibles. */
function calibrationRows(sels: LongshotSelection[]): { group: LongshotGroup; p: number; y: 0 | 1 }[] {
  const out: { group: LongshotGroup; p: number; y: 0 | 1 }[] = [];
  for (const s of sels) {
    if (s.result !== 'hit' && s.result !== 'miss') continue;
    if (s.group === 'marcador' && (s.rank ?? 99) > 3) continue;
    if (s.group !== '1x2' && s.group !== 'marcador' && s.group !== 'goleador') continue;
    out.push({ group: s.group, p: s.prob, y: s.result === 'hit' ? 1 : 0 });
  }
  return out;
}

const monthOf = (day: string) => day.slice(0, 7);

/**
 * La regla diaria aplicada a cada día pasado [from, to) con las selecciones walk-forward (generadas antes de cada partido)
 * y resuelta con el resultado a 90'. Con `calibrate`, cada día usa el Platt ajustado al empezar su mes con las
 * selecciones resueltas de días ANTERIORES (nunca con el propio día ni posteriores).
 */
export function longshotWalkForward(items: LongshotHistoryItem[], opts: LongshotWfOptions): LongshotWalkForward {
  const byDay = new Map<string, LongshotHistoryItem[]>();
  for (const it of items) {
    const t = Date.parse(it.match.date);
    if (!Number.isFinite(t)) continue;
    const day = localDay(t, opts.timeZone);
    const arr = byDay.get(day);
    if (arr) arr.push(it);
    else byDay.set(day, [it]);
  }
  const days = [...byDay.keys()].sort();
  const kinds = opts.kinds ?? new Set(GENERATED_KINDS);
  const bets: LongshotEngineBet[] = [];
  const calRows: { group: LongshotGroup; p: number; y: 0 | 1 }[] = [];
  let cal: LongshotCalibrator | undefined;
  let calMonth = '';
  const past: LongshotSelection[] = [];
  let evaluated = 0;
  let first = '';
  let last = '';
  for (const day of days) {
    const list = byDay.get(day)!.slice().sort((a, b) => Date.parse(a.match.date) - Date.parse(b.match.date) || a.match.matchId.localeCompare(b.match.matchId));
    const inRange = (!opts.from || day >= opts.from) && (!opts.to || day < opts.to);
    if (opts.calibrate && monthOf(day) !== calMonth) {
      cal = fitLongshotCalibrator(past);
      calMonth = monthOf(day);
    }
    if (inRange) {
      const sels = list.map((it) => it.selections.map((s) => calibrated(s, cal)));
      for (const s of sels) calRows.push(...calibrationRows(s));
      bets.push(...dayBets(sels, { kinds }));
      evaluated++;
      if (!first) first = day;
      last = day;
    }
    if (opts.calibrate) for (const it of list) past.push(...it.selections);
  }
  const byKind: KindRecord[] = [];
  for (const k of KIND_ORDER) {
    if (!kinds.has(k)) continue;
    byKind.push({ kind: k, ...recordOf(bets.filter((b) => b.kind === k)) });
  }
  const calibrationByGroup: LongshotWalkForward['calibrationByGroup'] = {};
  for (const g of ['1x2', 'marcador', 'goleador'] as const) calibrationByGroup[g] = bandCalibration(calRows.filter((r) => r.group === g));
  const evPos = { bets: 0, hits: 0, profit: 0, roi: 0 };
  for (const b of bets) {
    if (b.marketOdds === undefined || !(b.ev !== undefined && b.ev > 0) || (b.result !== 'hit' && b.result !== 'miss')) continue;
    evPos.bets++;
    if (b.result === 'hit') evPos.hits++;
    evPos.profit += b.result === 'hit' ? b.marketOdds - 1 : -1;
  }
  evPos.roi = evPos.bets ? evPos.profit / evPos.bets : 0;
  const out: LongshotWalkForward = {
    evPositive: evPos,
    from: first,
    to: last,
    days: evaluated,
    bets,
    byKind,
    overall: recordOf(bets),
    calibration: bandCalibration(calRows),
    calibrationByGroup,
  };
  if (opts.calibrate) {
    // producción: con TODO el historial anterior a `to`
    const all: LongshotSelection[] = [];
    for (const day of days) if (!opts.to || day < opts.to) for (const it of byDay.get(day)!) all.push(...it.selections);
    out.calibrator = fitLongshotCalibrator(all);
  }
  return out;
}

/**
 * ¿Se publica el tipo como recomendación? Motivo (español) si NO: sin muestra fuera de muestra suficiente o muy mal
 * calibrado (el límite superior de Wilson del acierto real no llega al 70 % de lo que prometía el modelo).
 */
export function kindExclusion(r: Pick<KindRecord, 'n' | 'hits' | 'hitRate' | 'wilsonHigh' | 'expectedHitRate'>): string | undefined {
  if (r.n < GATE_MIN_N) return `sin historial suficiente (${r.n} apuestas resueltas fuera de muestra; se exigen ${GATE_MIN_N})`;
  if (r.expectedHitRate > 0 && r.wilsonHigh < GATE_MIN_RATIO * r.expectedHitRate) {
    return `mal calibrado: el modelo prometía acertar un ${pctInt(r.expectedHitRate)} y acertó un ${pctInt(r.hitRate)} (${r.hits} de ${r.n})`;
  }
  return undefined;
}
