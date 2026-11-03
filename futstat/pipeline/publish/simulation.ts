/**
 * Simulación Monte Carlo de temporada para la publicación.
 *
 * Partidos pendientes de un grupo de clasificación:
 *  - Los partidos reales de la temporada actual (programados, aplazados o en juego) entre equipos del grupo.
 *  - Calendarios incompletos: ESPN solo devuelve los partidos del año natural consultado, así que en noviembre faltan
 *    los partidos de enero a mayo de las ligas europeas. Se completan según el formato de la competición:
 *      · liga a doble vuelta: cada par ordenado (local, visitante) que no tiene partido se añade como pendiente
 *        (con tope por equipo: jugados + pendientes <= 2·(n−1));
 *      · fase de liga UEFA (N partidos por equipo): emparejamientos sintéticos sembrados (sin repetir rival y evitando
 *        equipos de la misma liga doméstica cuando es posible), equilibrando partidos en casa y fuera.
 *  - λ de cada cruce: la predicción completa cuando el partido está en la ventana publicada; si no, el ensamble
 *    rápido (predictProbsOnly) con los modelos actuales. Cacheado por par.
 */
import type { SeasonSimulation, StandingGroup } from '../../src/types/data';
import { mulberry32 } from '../../src/lib/models';
import { MODEL, type CompetitionConfig } from '../config';
import type { MatchRecord } from '../types';
import { predictProbsOnly } from '../analytics/predict';
import { simulateSeason } from '../analytics/simulation';
import { baseContext, currentMatches, isFinishedRecord, teamRef, type BuildContext } from './context';
import { hash32 } from './util';

export type SeasonFormat = { kind: 'double-rr' } | { kind: 'league-phase'; matchesPerTeam: number };

/**
 * Formato de calendario de las competiciones simuladas (para completar los partidos que la fuente aún no publica).
 * Las competiciones sin entrada solo simulan los partidos conocidos.
 */
export const SEASON_FORMATS: Record<string, SeasonFormat> = {
  laliga: { kind: 'double-rr' },
  premier: { kind: 'double-rr' },
  seriea: { kind: 'double-rr' },
  bundesliga: { kind: 'double-rr' },
  ligue1: { kind: 'double-rr' },
  eredivisie: { kind: 'double-rr' },
  primeira: { kind: 'double-rr' },
  superlig: { kind: 'double-rr' },
  laliga2: { kind: 'double-rr' },
  championship: { kind: 'double-rr' },
  saudi: { kind: 'double-rr' },
  brasileirao: { kind: 'double-rr' },
  chile: { kind: 'double-rr' },
  champions: { kind: 'league-phase', matchesPerTeam: 8 },
  europa: { kind: 'league-phase', matchesPerTeam: 8 },
  conference: { kind: 'league-phase', matchesPerTeam: 6 },
};

export interface Fixture {
  home: string;
  away: string;
  neutral?: boolean;
  /** partido real (si existe) */
  match?: MatchRecord;
}

export interface RemainingResult {
  fixtures: Fixture[];
  /** partidos añadidos para completar el calendario */
  synthetic: number;
}

const PENDING = new Set(['scheduled', 'postponed', 'live']);

/**
 * Partidos pendientes del grupo. `matches` = partidos de la temporada actual de la competición.
 * `homeLeague` (opcional) se usa para evitar cruces de la misma liga en la fase de liga.
 */
export function remainingFixtures(
  group: StandingGroup,
  matches: MatchRecord[],
  format: SeasonFormat | undefined,
  opts: { seed?: number; homeLeague?: Map<string, string> } = {},
): RemainingResult {
  const teams = group.rows.map((r) => r.team.id);
  const inGroup = new Set(teams);
  const n = teams.length;
  const played = new Map(group.rows.map((r) => [r.team.id, r.played]));
  const relevant = matches.filter((m) => inGroup.has(m.home.id) && inGroup.has(m.away.id) && m.home.id !== m.away.id && m.status !== 'cancelled');
  const finishedPairs = new Set<string>();
  const facedPairs = new Set<string>();
  const homeGames = new Map<string, number>();
  const pendingById = new Map<string, MatchRecord>();
  const pair = (h: string, a: string) => `${h}>${a}`;
  const upair = (h: string, a: string) => (h < a ? `${h}|${a}` : `${a}|${h}`);
  for (const m of relevant) {
    facedPairs.add(upair(m.home.id, m.away.id));
    homeGames.set(m.home.id, (homeGames.get(m.home.id) ?? 0) + 1);
    if (isFinishedRecord(m)) finishedPairs.add(pair(m.home.id, m.away.id));
    else if (PENDING.has(m.status)) pendingById.set(m.id, m);
  }

  const fixtures: Fixture[] = [];
  const pendingCount = new Map<string, number>();
  const addFixture = (f: Fixture) => {
    fixtures.push(f);
    pendingCount.set(f.home, (pendingCount.get(f.home) ?? 0) + 1);
    pendingCount.set(f.away, (pendingCount.get(f.away) ?? 0) + 1);
  };

  if (format?.kind === 'double-rr') {
    // un partido por par ordenado; los pendientes de pares ya jugados (duplicados de aplazados) se descartan
    const byPair = new Map<string, MatchRecord>();
    for (const m of pendingById.values()) {
      const k = pair(m.home.id, m.away.id);
      if (finishedPairs.has(k)) continue;
      const prev = byPair.get(k);
      if (!prev || (prev.status !== 'scheduled' && m.status === 'scheduled')) byPair.set(k, m);
    }
    for (const m of byPair.values()) addFixture({ home: m.home.id, away: m.away.id, neutral: !!m.neutral, match: m });
    const cap = 2 * (n - 1);
    let synthetic = 0;
    for (const h of teams) {
      for (const a of teams) {
        if (h === a) continue;
        const k = pair(h, a);
        if (finishedPairs.has(k) || byPair.has(k)) continue;
        const total = (t: string) => (played.get(t) ?? 0) + (pendingCount.get(t) ?? 0);
        if (total(h) >= cap || total(a) >= cap) continue;
        addFixture({ home: h, away: a });
        synthetic++;
      }
    }
    return { fixtures, synthetic };
  }

  for (const m of pendingById.values()) addFixture({ home: m.home.id, away: m.away.id, neutral: !!m.neutral, match: m });
  if (format?.kind !== 'league-phase') return { fixtures, synthetic: 0 };

  // ---- fase de liga: completar hasta matchesPerTeam partidos por equipo
  const need = new Map<string, number>();
  for (const t of teams) need.set(t, Math.max(0, format.matchesPerTeam - (played.get(t) ?? 0) - (pendingCount.get(t) ?? 0)));
  const totalNeed = [...need.values()].reduce((s, x) => s + x, 0);
  if (totalNeed === 0) return { fixtures, synthetic: 0 };
  const rng = mulberry32((opts.seed ?? 1) >>> 0);
  let best: Fixture[] = [];
  for (let attempt = 0; attempt < 40 && best.length * 2 < totalNeed; attempt++) {
    const left = new Map(need);
    const faced = new Set(facedPairs);
    const homes = new Map(homeGames);
    const order = teams.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const out: Fixture[] = [];
    for (;;) {
      let t: string | undefined;
      for (const x of order) if ((left.get(x) ?? 0) > 0 && (!t || (left.get(x) ?? 0) > (left.get(t) ?? 0))) t = x;
      if (!t) break;
      const cands = order.filter((x) => x !== t && (left.get(x) ?? 0) > 0 && !faced.has(upair(t!, x)));
      const lg = opts.homeLeague?.get(t);
      const pref = lg ? cands.filter((x) => opts.homeLeague?.get(x) !== lg) : cands;
      const pool = pref.length ? pref : cands;
      if (!pool.length) {
        left.set(t, 0);
        continue;
      }
      const o = pool[Math.floor(rng() * pool.length)];
      const tHome = (homes.get(t) ?? 0) <= (homes.get(o) ?? 0);
      const f: Fixture = tHome ? { home: t, away: o } : { home: o, away: t };
      homes.set(f.home, (homes.get(f.home) ?? 0) + 1);
      faced.add(upair(t, o));
      left.set(t, (left.get(t) ?? 0) - 1);
      left.set(o, (left.get(o) ?? 0) - 1);
      out.push(f);
    }
    if (out.length > best.length) best = out;
  }
  for (const f of best) addFixture(f);
  return { fixtures, synthetic: best.length };
}

/** λ de un cruce para la simulación (cacheado por par y campo neutral). */
function lambdaFn(ctx: BuildContext, comp: CompetitionConfig) {
  const cache = new Map<string, { lambdaHome: number; lambdaAway: number }>();
  const pctx = baseContext(ctx, comp);
  return (f: Fixture): { lambdaHome: number; lambdaAway: number } => {
    if (f.match) {
      const fp = ctx.predictions.get(f.match.id);
      if (fp) return { lambdaHome: fp.result.lambdaHome, lambdaAway: fp.result.lambdaAway };
    }
    const key = `${f.home}|${f.away}|${f.neutral ? 1 : 0}`;
    let l = cache.get(key);
    if (!l) {
      const rec: MatchRecord = f.match ?? {
        id: `sim-${comp.id}-${f.home}-${f.away}`,
        compId: comp.id,
        season: 0,
        currentSeason: true,
        date: new Date(ctx.now).toISOString(),
        status: 'scheduled',
        neutral: f.neutral || undefined,
        home: teamRef(ctx, f.home),
        away: teamRef(ctx, f.away),
      };
      const r = predictProbsOnly(rec, pctx);
      l = { lambdaHome: r.lambdaHome, lambdaAway: r.lambdaAway };
      cache.set(key, l);
    }
    return l;
  };
}

/** Simulaciones de temporada de una competición (una por grupo con partidos pendientes). */
export function simulateCompetition(
  ctx: BuildContext,
  comp: CompetitionConfig,
  groups: StandingGroup[],
): { simulations: SeasonSimulation[]; synthetic: number; fixtures: number } {
  const zones = comp.simulationZones ?? [];
  if (!comp.simulate || !zones.length || !groups.length) return { simulations: [], synthetic: 0, fixtures: 0 };
  const matches = currentMatches(ctx, comp.id);
  const lam = lambdaFn(ctx, comp);
  const iterations = ctx.fast ? Math.min(2000, MODEL.simIterations) : MODEL.simIterations;
  const out: SeasonSimulation[] = [];
  let synthetic = 0;
  let total = 0;
  for (const g of groups) {
    if (g.rows.length < 2) continue;
    const seed = hash32(`${comp.id}|${g.name}`);
    const rem = remainingFixtures(g, matches, SEASON_FORMATS[comp.id], { seed, homeLeague: ctx.suite.eloBuild.homeLeague });
    if (!rem.fixtures.length) continue;
    const lambdas = new Map<string, { lambdaHome: number; lambdaAway: number }>();
    for (const f of rem.fixtures) lambdas.set(`${f.home}|${f.away}`, lam(f));
    const sim = simulateSeason({
      group: g,
      remaining: rem.fixtures.map((f) => ({ home: f.home, away: f.away, neutral: f.neutral })),
      // los partidos repetidos del mismo par (raros) comparten λ
      lambdas: (h, a) => lambdas.get(`${h}|${a}`) ?? { lambdaHome: 1.3, lambdaAway: 1.1 },
      zones,
      iterations,
      seed,
    });
    out.push(sim);
    synthetic += rem.synthetic;
    total += rem.fixtures.length;
  }
  return { simulations: out, synthetic, fixtures: total };
}
