/**
 * Ratings de equipos a partir de los data-store:
 *  - Elo GLOBAL cronológico (todas las competiciones, dedup por id de partido) con valor inicial
 *    según el nivel (tier) de la liga doméstica del equipo, multiplicador de K por tipo de competición
 *    y calibración de los parámetros de empate (drawBase/drawScale) por máxima verosimilitud.
 *  - Modelos Dixon-Coles por liga (ventana MODEL.dcWindowDays, decaimiento MODEL.dcXi).
 *  - Modelo Elo→goles para partidos entre equipos de ligas distintas (copas/continentales):
 *      supremacía S = a·(diff/100)            (regresión por el origen; diff incluye la ventaja local)
 *      total     T = media de goles + c·(diff/100)²   (c >= 0: los partidos desiguales tienen algo más de goles)
 *      λh = (T+S)/2, λa = (T−S)/2 (mínimo 0.15)
 *  - Medias de goles por partido de cada competición.
 */
import { Elo, fitDixonColes, fitEloDrawParams, type DCMatch, type DCModel } from '../../src/lib/models';
import { MODEL, type CompetitionConfig } from '../config';
import type { CompetitionStore, MatchRecord } from '../types';

const DAY_MS = 86_400_000;
/** Días iniciales de datos excluidos de la calibración de empates y de Elo→goles (el Elo aún se está estabilizando). */
export const ELO_BURN_IN_DAYS = 60;
/** Partidos terminados mínimos (en la ventana DC) para ajustar un Dixon-Coles de liga. */
export const DC_MIN_MATCHES = 50;
/** λ mínimo del modelo Elo→goles. */
export const ELO_GOAL_MIN_LAMBDA = 0.15;
/** Media global de goles por partido si no hay datos. */
export const DEFAULT_AVG_GOALS = 2.6;
/**
 * Penalización (en tiers) del Elo inicial de un equipo que aparece en una liga que ya tenía historial (ascendido
 * desde una categoría no cubierta). En los datos reales estos equipos acaban ~40 puntos por debajo de la media de su
 * liga incluso tras 8+ partidos partiendo de la media.
 */
export const PROMOTED_TIER_PENALTY = 2;
/** Partidos ficticios de prior para el factor de calibración de goles totales por competición. */
const TOTAL_FACTOR_PRIOR_N = 80;

export type EloDrawParams = { drawBase: number; drawScale: number };

/** Muestra pre-partido del Elo (para calibraciones y backtest). */
export interface EloSample {
  matchId: string;
  compId: string;
  date: string;
  home: string;
  away: string;
  neutral: boolean;
  /** r_local + ventaja local (si no es neutral) − r_visitante, ANTES del partido */
  diff: number;
  hg: number;
  ag: number;
  /** 0 = local, 1 = empate, 2 = visitante */
  outcome: 0 | 1 | 2;
  /** true si el partido está fuera del periodo de estabilización inicial */
  calibrated: boolean;
}

export interface EloBuild {
  elo: Elo;
  /** ratings pre-partido por id de partido (solo partidos terminados) */
  preMatch: Map<string, { home: number; away: number }>;
  drawParams: EloDrawParams;
  /** teamId → compId de su liga doméstica (competición 'league' con más partidos) */
  homeLeague: Map<string, string>;
  /** muestras pre-partido en orden cronológico (todas; `calibrated` marca las usadas para calibrar) */
  samples: EloSample[];
  /** partidos procesados por equipo */
  gamesByTeam: Map<string, number>;
}

export interface EloGoalCoeffs {
  /** goles de supremacía por cada 100 puntos de diferencia Elo */
  a: number;
  /** goles extra de total por (diff/100)² */
  c: number;
  /** media global de goles por partido usada como respaldo */
  globalAvgGoals: number;
  /** partidos usados en el ajuste */
  n: number;
  /**
   * factor multiplicativo del total de goles por competición (copas/continentales: los cruces desiguales y el
   * formato eliminatorio cambian el nivel de goles respecto a las ligas domésticas). 1 si no hay datos.
   */
  totalFactor?: Record<string, number>;
}

/** Coeficientes por defecto (aprox. típicos del fútbol europeo) si no hay datos suficientes. */
export const DEFAULT_ELO_GOAL: EloGoalCoeffs = { a: 0.36, c: 0.02, globalAvgGoals: DEFAULT_AVG_GOALS, n: 0 };

/** Factor de calibración del total de goles del modelo Elo→goles para una competición. */
export function eloGoalTotalFactor(coeffs: EloGoalCoeffs, compId: string): number {
  const f = coeffs.totalFactor?.[compId];
  return f !== undefined && Number.isFinite(f) && f > 0 ? f : 1;
}

export interface ModelSuite {
  eloBuild: EloBuild;
  dcModels: Map<string, DCModel>;
  eloGoal: EloGoalCoeffs;
  leagueAvgGoals: Map<string, number>;
  /** fecha de referencia del ajuste */
  refDate: string;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/** Partido terminado con marcador válido. */
export type FinishedMatch = MatchRecord & { score: NonNullable<MatchRecord['score']> };

function isFinishedWithScore(m: MatchRecord): m is FinishedMatch {
  return (
    m.status === 'finished' &&
    !!m.score &&
    Number.isInteger(m.score.home) &&
    Number.isInteger(m.score.away) &&
    m.score.home >= 0 &&
    m.score.away >= 0 &&
    !!m.home?.id &&
    !!m.away?.id &&
    m.home.id !== m.away.id
  );
}

/** Partidos terminados (con marcador) de todos los stores, sin duplicados por id, en orden cronológico. */
export function finishedMatches(stores: CompetitionStore[], before?: string): FinishedMatch[] {
  const limit = before ? Date.parse(before) : Infinity;
  const byId = new Map<string, FinishedMatch>();
  for (const s of stores) {
    for (const m of s.matches ?? []) {
      if (!isFinishedWithScore(m)) continue;
      const t = Date.parse(m.date);
      if (!Number.isFinite(t) || t >= limit) continue;
      const prev = byId.get(m.id);
      // si aparece en dos stores nos quedamos con el que tenga más información
      if (!prev || (!prev.stats && m.stats) || (!prev.summaryFetched && m.summaryFetched)) byId.set(m.id, m);
    }
  }
  return [...byId.values()].sort((x, y) => Date.parse(x.date) - Date.parse(y.date) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/** Multiplicador de K del Elo según el tipo de competición. */
export function kMultiplierFor(kind: CompetitionConfig['kind'] | undefined): number {
  if (kind === 'continental') return 1.2;
  if (kind === 'cup') return 0.9;
  return 1;
}

/** Slugs de ESPN de competiciones de selecciones nacionales (sin `nationalTeams` explícito en la configuración). */
export const NATIONAL_TEAM_SLUGS = new Set([
  'uefa.nations',
  'uefa.euro',
  'uefa.euroq',
  'fifa.world',
  'fifa.worldq.uefa',
  'fifa.worldq.conmebol',
  'fifa.friendly',
  'conmebol.america',
  'concacaf.nations.league',
  'concacaf.gold',
]);

/** true si la competición enfrenta a selecciones nacionales (no clubes). */
export function isNationalTeamComp(comp: CompetitionConfig | undefined): boolean {
  if (!comp) return false;
  return comp.nationalTeams ?? NATIONAL_TEAM_SLUGS.has(comp.slug);
}

/**
 * Tier del Elo inicial de los equipos que solo aparecen en una copa concreta (categorías no cubiertas), cuando la
 * copa no lo fija con `cupOnlyTier`. Backtest del Elo (3 nov 2026; RPS de los 611 partidos de copa con algún equipo
 * sin liga en el dataset): con tier 3 para todas 0,2129; con MODEL.cupOnlyTier = 1 para todas 0,2024; con estas
 * excepciones 0,1952 (Copa del Rey 0,2237 → 0,1778 y DFB-Pokal 0,1935 → 0,1691: sus primeras rondas enfrentan a
 * clubes amateurs/regionales con los de primera). FA Cup, Carabao, Coppa Italia y Copa Chile tienen su mínimo cerca
 * de 1 (bajar la Carabao empeora la FA Cup: sus equipos de League One/Two juegan ambas).
 */
export const CUP_ONLY_TIER: Record<string, number> = { copadelrey: -2, dfbpokal: -2 };

/**
 * Tier "efectivo" de un equipo sin liga doméstica conocida, según la competición donde aparece. En copas son
 * equipos de categorías inferiores no cubiertas (en la FA Cup incluso amateurs): `cupOnlyTier` de la copa,
 * CUP_ONLY_TIER o MODEL.cupOnlyTier.
 */
export function fallbackTier(comp: CompetitionConfig | undefined): number {
  if (!comp) return 4;
  if (comp.kind === 'cup') return comp.cupOnlyTier ?? CUP_ONLY_TIER[comp.id] ?? MODEL.cupOnlyTier;
  if (comp.kind === 'continental') return Math.min(6, Math.max(2, comp.tier - 4));
  return comp.tier;
}

/**
 * Rating Elo inicial de un equipo nuevo: eloInit + (tier − 5)·eloTierOffset, con el tier de su liga doméstica
 * (o el de respaldo de la competición donde aparece). `promoted` resta PROMOTED_TIER_PENALTY tiers.
 */
export function initialElo(
  teamId: string,
  homeLeague: Map<string, string>,
  configsById: Map<string, CompetitionConfig>,
  fallbackComp?: CompetitionConfig,
  promoted = false,
): number {
  const league = homeLeague.get(teamId);
  const cfg = league ? configsById.get(league) : undefined;
  const tier = (cfg ? cfg.tier : fallbackTier(fallbackComp)) - (promoted ? PROMOTED_TIER_PENALTY : 0);
  return MODEL.eloInit + (tier - 5) * MODEL.eloTierOffset;
}

/**
 * Liga doméstica de cada equipo: competición 'league' donde tiene más partidos. Se priorizan los partidos de
 * la temporada actual (para ascendidos/descendidos) y, a igualdad, el total de partidos y el tier.
 */
export function computeHomeLeague(stores: CompetitionStore[], configs: CompetitionConfig[]): Map<string, string> {
  const cfg = new Map(configs.map((c) => [c.id, c]));
  const counts = new Map<string, Map<string, { cur: number; all: number }>>();
  for (const s of stores) {
    const c = cfg.get(s.compId);
    if (!c || c.kind !== 'league') continue;
    const seen = new Set<string>();
    for (const m of s.matches ?? []) {
      if (!m?.id || seen.has(m.id) || m.status === 'cancelled') continue;
      seen.add(m.id);
      for (const t of [m.home?.id, m.away?.id]) {
        if (!t) continue;
        let byComp = counts.get(t);
        if (!byComp) {
          byComp = new Map();
          counts.set(t, byComp);
        }
        const e = byComp.get(s.compId) ?? { cur: 0, all: 0 };
        e.all++;
        if (m.currentSeason) e.cur++;
        byComp.set(s.compId, e);
      }
    }
  }
  const out = new Map<string, string>();
  for (const [team, byComp] of counts) {
    let best: string | undefined;
    let bestKey: [number, number, number] = [-1, -1, -1];
    for (const [compId, e] of byComp) {
      const key: [number, number, number] = [e.cur, e.all, cfg.get(compId)?.tier ?? 0];
      if (key[0] > bestKey[0] || (key[0] === bestKey[0] && (key[1] > bestKey[1] || (key[1] === bestKey[1] && key[2] > bestKey[2])))) {
        best = compId;
        bestKey = key;
      }
    }
    if (best) out.set(team, best);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Elo global
// ---------------------------------------------------------------------------

/**
 * Elo global cronológico con todos los partidos terminados de todas las competiciones.
 * Calibra drawParams con fitEloDrawParams sobre las diferencias pre-partido (sin los primeros ELO_BURN_IN_DAYS días).
 */
export function buildElo(
  stores: CompetitionStore[],
  configs: CompetitionConfig[],
  opts: { before?: string } = {},
): EloBuild {
  const configsById = new Map(configs.map((c) => [c.id, c]));
  const homeLeague = computeHomeLeague(stores, configs);
  const elo = new Elo({ k: MODEL.eloK, homeAdv: MODEL.eloHomeAdv, init: MODEL.eloInit });
  const preMatch = new Map<string, { home: number; away: number }>();
  const samples: EloSample[] = [];
  const gamesByTeam = new Map<string, number>();
  const matches = finishedMatches(stores, opts.before);
  const firstT = matches.length ? Date.parse(matches[0].date) : 0;
  const calibFrom = firstT + ELO_BURN_IN_DAYS * DAY_MS;
  // inicio de los datos de cada competición (para detectar equipos ascendidos)
  const compStart = new Map<string, number>();
  for (const m of matches) if (!compStart.has(m.compId)) compStart.set(m.compId, Date.parse(m.date));

  for (const m of matches) {
    const comp = configsById.get(m.compId);
    const h = m.home.id;
    const a = m.away.id;
    const t = Date.parse(m.date);
    // equipo nuevo en una liga que ya tenía ELO_BURN_IN_DAYS de historial ⇒ ascendido de una categoría no cubierta
    const promoted = comp?.kind === 'league' && t > (compStart.get(m.compId) ?? t) + ELO_BURN_IN_DAYS * DAY_MS;
    if (!elo.has(h)) elo.set(h, initialElo(h, homeLeague, configsById, comp, promoted && homeLeague.get(h) === m.compId));
    if (!elo.has(a)) elo.set(a, initialElo(a, homeLeague, configsById, comp, promoted && homeLeague.get(a) === m.compId));
    const neutral = !!m.neutral;
    const diff = elo.diff(h, a, neutral);
    const hg = m.score.home;
    const ag = m.score.away;
    const r = elo.update({
      id: m.id,
      date: m.date,
      home: h,
      away: a,
      hg,
      ag,
      neutral,
      kMultiplier: kMultiplierFor(comp?.kind),
    });
    preMatch.set(m.id, { home: r.preHome, away: r.preAway });
    gamesByTeam.set(h, (gamesByTeam.get(h) ?? 0) + 1);
    gamesByTeam.set(a, (gamesByTeam.get(a) ?? 0) + 1);
    samples.push({
      matchId: m.id,
      compId: m.compId,
      date: m.date,
      home: h,
      away: a,
      neutral,
      diff,
      hg,
      ag,
      outcome: hg > ag ? 0 : hg === ag ? 1 : 2,
      calibrated: Date.parse(m.date) >= calibFrom,
    });
  }
  const calib = samples.filter((s) => s.calibrated);
  const drawParams = fitEloDrawParams((calib.length >= 200 ? calib : samples).map((s) => ({ diff: s.diff, outcome: s.outcome })));
  return { elo, preMatch, drawParams, homeLeague, samples, gamesByTeam };
}

// ---------------------------------------------------------------------------
// Dixon-Coles por liga
// ---------------------------------------------------------------------------

/** DCMatch de los partidos terminados de un store dentro de la ventana [refDate − windowDays, refDate). */
export function dcMatchesFor(store: CompetitionStore, refDate: string, windowDays = MODEL.dcWindowDays): DCMatch[] {
  const ref = Date.parse(refDate);
  const from = ref - windowDays * DAY_MS;
  const seen = new Set<string>();
  const out: DCMatch[] = [];
  for (const m of store.matches ?? []) {
    if (!isFinishedWithScore(m) || seen.has(m.id)) continue;
    const t = Date.parse(m.date);
    if (!Number.isFinite(t) || t >= ref || t < from) continue;
    seen.add(m.id);
    out.push({ home: m.home.id, away: m.away.id, hg: m.score.home, ag: m.score.away, date: m.date, neutral: !!m.neutral });
  }
  return out;
}

/**
 * Modelos Dixon-Coles para las competiciones 'league' con >= DC_MIN_MATCHES partidos terminados en la ventana
 * MODEL.dcWindowDays anterior a refDate (decaimiento MODEL.dcXi).
 */
export function fitLeagueModels(
  stores: CompetitionStore[],
  configs: CompetitionConfig[],
  refDate: string,
): Map<string, DCModel> {
  const cfg = new Map(configs.map((c) => [c.id, c]));
  const out = new Map<string, DCModel>();
  for (const s of stores) {
    const c = cfg.get(s.compId);
    if (!c || c.kind !== 'league') continue;
    const ms = dcMatchesFor(s, refDate);
    if (ms.length < DC_MIN_MATCHES) continue;
    out.set(s.compId, fitDixonColes(ms, { refDate, xi: MODEL.dcXi }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Medias de goles y modelo Elo→goles
// ---------------------------------------------------------------------------

/**
 * Goles medios por partido de cada competición (partidos terminados en la ventana anterior a refDate; >= 10 partidos).
 * Si refDate se omite se usan todos los partidos.
 */
export function leagueAverageGoals(
  stores: CompetitionStore[],
  refDate?: string,
  windowDays = MODEL.dcWindowDays,
): Map<string, number> {
  const ref = refDate ? Date.parse(refDate) : Infinity;
  const from = refDate ? ref - windowDays * DAY_MS : -Infinity;
  const out = new Map<string, number>();
  for (const s of stores) {
    const seen = new Set<string>();
    let goals = 0;
    let n = 0;
    for (const m of s.matches ?? []) {
      if (!isFinishedWithScore(m) || seen.has(m.id)) continue;
      const t = Date.parse(m.date);
      if (!(t < ref) || t < from) continue;
      seen.add(m.id);
      goals += m.score.home + m.score.away;
      n++;
    }
    if (n >= 10) out.set(s.compId, goals / n);
  }
  return out;
}

/** Media de goles de referencia de un partido: media de las ligas domésticas de ambos equipos (o de la competición, o global). */
export function expectedTotalGoals(
  homeId: string,
  awayId: string,
  compId: string,
  homeLeague: Map<string, string>,
  leagueAvgGoals: Map<string, number>,
  globalAvg: number,
): number {
  const vals: number[] = [];
  for (const t of [homeId, awayId]) {
    const lg = homeLeague.get(t);
    const v = lg ? leagueAvgGoals.get(lg) : undefined;
    if (v !== undefined && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length) return vals.reduce((x, y) => x + y, 0) / vals.length;
  const c = leagueAvgGoals.get(compId);
  if (c !== undefined && Number.isFinite(c)) return c;
  return Number.isFinite(globalAvg) && globalAvg > 0 ? globalAvg : DEFAULT_AVG_GOALS;
}

/**
 * "Apertura" de un equipo en su liga doméstica según Dixon-Coles, √(ataque·defensa): > 1 ⇒ sus partidos tienen
 * más goles que la media de su liga. undefined si no hay modelo.
 */
export function teamOpenness(team: string, homeLeague: Map<string, string>, dcModels?: Map<string, DCModel>): number | undefined {
  const lg = homeLeague.get(team);
  const m = lg ? dcModels?.get(lg) : undefined;
  if (!m || m.attack[team] === undefined || m.defence[team] === undefined) return undefined;
  return Math.sqrt(m.attack[team] * m.defence[team]);
}

/**
 * Total de goles de referencia para el modelo Elo→goles: media de las ligas domésticas × apertura de ambos equipos
 * (recortada a [0.8, 1.25]) × factor de la competición.
 */
export function eloGoalBaseTotal(
  homeId: string,
  awayId: string,
  compId: string,
  homeLeague: Map<string, string>,
  leagueAvgGoals: Map<string, number>,
  coeffs: EloGoalCoeffs,
  dcModels?: Map<string, DCModel>,
): number {
  let total = expectedTotalGoals(homeId, awayId, compId, homeLeague, leagueAvgGoals, coeffs.globalAvgGoals || DEFAULT_AVG_GOALS);
  const oh = teamOpenness(homeId, homeLeague, dcModels);
  const oa = teamOpenness(awayId, homeLeague, dcModels);
  if (oh !== undefined || oa !== undefined) total *= Math.min(1.25, Math.max(0.8, Math.sqrt((oh ?? 1) * (oa ?? 1))));
  return total * eloGoalTotalFactor(coeffs, compId);
}

/**
 * Ajusta el modelo Elo→goles sobre muestras pre-partido:
 *   a = Σx·gd / Σx²  (x = diff/100, gd = goles local − visitante)  — regresión por el origen
 *   c = Σx²·(total − T0) / Σx⁴, recortado a [0, 0.15]  (T0 = media de goles de referencia del partido)
 *   totalFactor[comp] = (Σ goles reales + k·T̄) / (Σ goles predichos + k·T̄) en los cruces entre ligas distintas
 *   de cada competición (contraído hacia 1 con k = TOTAL_FACTOR_PRIOR_N partidos)
 */
export function fitEloGoalModel(
  samples: EloSample[],
  homeLeague: Map<string, string>,
  leagueAvgGoals: Map<string, number>,
  dcModels?: Map<string, DCModel>,
): EloGoalCoeffs {
  const use = samples.filter((s) => s.calibrated);
  const data = use.length >= 200 ? use : samples;
  if (data.length < 30) {
    return { ...DEFAULT_ELO_GOAL, globalAvgGoals: data.length ? data.reduce((t, s) => t + s.hg + s.ag, 0) / data.length : DEFAULT_AVG_GOALS };
  }
  const globalAvg = data.reduce((t, s) => t + s.hg + s.ag, 0) / data.length;
  let sxy = 0;
  let sxx = 0;
  let sx2r = 0;
  let sx4 = 0;
  for (const s of data) {
    const x = s.diff / 100;
    if (!Number.isFinite(x)) continue;
    sxy += x * (s.hg - s.ag);
    sxx += x * x;
    const t0 = expectedTotalGoals(s.home, s.away, s.compId, homeLeague, leagueAvgGoals, globalAvg);
    sx2r += x * x * (s.hg + s.ag - t0);
    sx4 += x ** 4;
  }
  const a = sxx > 0 ? Math.min(1, Math.max(0.05, sxy / sxx)) : DEFAULT_ELO_GOAL.a;
  const c = sx4 > 0 ? Math.min(0.15, Math.max(0, sx2r / sx4)) : DEFAULT_ELO_GOAL.c;
  const coeffs: EloGoalCoeffs = { a, c, globalAvgGoals: globalAvg, n: data.length };
  // calibración del total por competición en los partidos que usarían Elo→goles (equipos de ligas distintas)
  const acc = new Map<string, { act: number; pred: number; n: number }>();
  for (const s of data) {
    const lh = homeLeague.get(s.home);
    if (lh && lh === homeLeague.get(s.away)) continue;
    const pred = eloGoalModel(s.diff, eloGoalBaseTotal(s.home, s.away, s.compId, homeLeague, leagueAvgGoals, coeffs, dcModels), coeffs);
    const e = acc.get(s.compId) ?? { act: 0, pred: 0, n: 0 };
    e.act += s.hg + s.ag;
    e.pred += pred.lambdaHome + pred.lambdaAway;
    e.n++;
    acc.set(s.compId, e);
  }
  const totalFactor: Record<string, number> = {};
  for (const [compId, e] of acc) {
    if (e.n < 10 || !(e.pred > 0)) continue;
    const tbar = e.pred / e.n;
    const f = (e.act + TOTAL_FACTOR_PRIOR_N * tbar) / (e.pred + TOTAL_FACTOR_PRIOR_N * tbar);
    totalFactor[compId] = Math.min(1.3, Math.max(0.77, f));
  }
  coeffs.totalFactor = totalFactor;
  return coeffs;
}

/** λ esperados desde la diferencia Elo (con la ventaja local ya incluida) y el total de goles de referencia. */
export function eloGoalModel(
  diff: number,
  totalGoals: number,
  coeffs: EloGoalCoeffs = DEFAULT_ELO_GOAL,
): { lambdaHome: number; lambdaAway: number; supremacy: number; total: number } {
  const x = Number.isFinite(diff) ? diff / 100 : 0;
  const base = Number.isFinite(totalGoals) && totalGoals > 0 ? totalGoals : coeffs.globalAvgGoals || DEFAULT_AVG_GOALS;
  const S = coeffs.a * x;
  const T = base + coeffs.c * x * x;
  return {
    lambdaHome: Math.max(ELO_GOAL_MIN_LAMBDA, (T + S) / 2),
    lambdaAway: Math.max(ELO_GOAL_MIN_LAMBDA, (T - S) / 2),
    supremacy: S,
    total: T,
  };
}

// ---------------------------------------------------------------------------
// Todo junto
// ---------------------------------------------------------------------------

/**
 * Ajusta todos los modelos de ratings a una fecha de referencia: Elo global (partidos anteriores a refDate),
 * Dixon-Coles por liga, medias de goles y modelo Elo→goles.
 */
export function buildModelSuite(stores: CompetitionStore[], configs: CompetitionConfig[], refDate: string): ModelSuite {
  const eloBuild = buildElo(stores, configs, { before: refDate });
  const dcModels = fitLeagueModels(stores, configs, refDate);
  const leagueAvgGoals = leagueAverageGoals(stores, refDate);
  const eloGoal = fitEloGoalModel(eloBuild.samples, eloBuild.homeLeague, leagueAvgGoals, dcModels);
  return { eloBuild, dcModels, eloGoal, leagueAvgGoals, refDate };
}
