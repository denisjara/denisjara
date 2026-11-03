/**
 * Estadística de temporada por equipo (una competición): medias por partido con split casa/fuera,
 * porcentajes de mercados (over, ambos marcan, porterías a cero...), goles por tramos de 15 minutos,
 * forma, medias de liga, clasificación calculada desde los partidos (respaldo) y puntos esperados (xPts).
 *
 * Convenciones:
 *  - Solo se usan partidos terminados con marcador (deduplicados por id).
 *  - Cada media se calcula sobre los partidos donde la estadística existe (p. ej. córners solo si la fuente los da);
 *    si no hay ninguno, vale 0.
 *  - xG: proxy del modelo (λ pre-partido) desde el mapa `xg` (matchId → {home, away}).
 *  - Posesión en 0..100 (como en la fuente). Porcentajes de mercados en 0..1.
 */
import type {
  LeagueAverages,
  Outcome,
  SplitStat,
  StandingGroup,
  StandingRow,
  TeamRef,
  TeamSeasonStats,
} from '../../src/types/data';
import { clamp, ewma, mean, outcomeProbs, round, scoreMatrix } from '../../src/lib/models';
import type { MatchRecord, TeamMatchStats } from '../types';

export type XgMap = Map<string, { home: number; away: number }>;

/** Tramos de minutos para goles por periodo: [0-15, 16-30, 31-45+, 46-60, 61-75, 76-90+]. */
export const PERIOD_LABELS = ['0-15', '16-30', '31-45+', '46-60', '61-75', '76-90+'];

/** Índice de tramo (0..5) para un minuto. 45'+X cuenta en 31-45+, 90'+X y prórroga en 76-90+. */
export function periodIndex(minute: number): number {
  if (!Number.isFinite(minute) || minute <= 15) return 0;
  if (minute <= 30) return 1;
  if (minute <= 45) return 2;
  if (minute <= 60) return 3;
  if (minute <= 75) return 4;
  return 5;
}

// ---------------------------------------------------------------------------
// Vista de un partido desde la perspectiva de un equipo
// ---------------------------------------------------------------------------

export type FinishedRecord = MatchRecord & { score: NonNullable<MatchRecord['score']> };

export function isFinished(m: MatchRecord): m is FinishedRecord {
  return m.status === 'finished' && !!m.score && Number.isFinite(m.score.home) && Number.isFinite(m.score.away);
}

/** Partidos terminados, deduplicados por id y ordenados cronológicamente. */
export function finishedSorted(matches: MatchRecord[]): FinishedRecord[] {
  const seen = new Set<string>();
  const out: FinishedRecord[] = [];
  for (const m of matches) {
    if (!isFinished(m) || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

export interface TeamView {
  match: FinishedRecord;
  isHome: boolean;
  team: TeamRef;
  opponent: TeamRef;
  gf: number;
  ga: number;
  result: Outcome;
  pts: number;
  own?: TeamMatchStats;
  opp?: TeamMatchStats;
  xg?: number;
  xga?: number;
}

export function outcomeOf(gf: number, ga: number): Outcome {
  return gf > ga ? 'W' : gf === ga ? 'D' : 'L';
}

export function pointsOf(r: Outcome): number {
  return r === 'W' ? 3 : r === 'D' ? 1 : 0;
}

/** Partido terminado visto por `teamId`. null si el equipo no jugó o el partido no está terminado. */
export function teamView(m: MatchRecord, teamId: string, xg?: XgMap): TeamView | null {
  if (!isFinished(m)) return null;
  const isHome = m.home.id === teamId;
  if (!isHome && m.away.id !== teamId) return null;
  const gf = isHome ? m.score.home : m.score.away;
  const ga = isHome ? m.score.away : m.score.home;
  const result = outcomeOf(gf, ga);
  const v: TeamView = {
    match: m,
    isHome,
    team: isHome ? m.home : m.away,
    opponent: isHome ? m.away : m.home,
    gf,
    ga,
    result,
    pts: pointsOf(result),
  };
  if (m.stats) {
    v.own = isHome ? m.stats.home : m.stats.away;
    v.opp = isHome ? m.stats.away : m.stats.home;
  }
  const x = xg?.get(m.id);
  if (x && Number.isFinite(x.home) && Number.isFinite(x.away)) {
    v.xg = isHome ? x.home : x.away;
    v.xga = isHome ? x.away : x.home;
  }
  return v;
}

/** Tarjetas (amarillas + rojas) de una línea de estadísticas; undefined si la fuente no las da. */
export function cardsOf(s: TeamMatchStats | undefined): number | undefined {
  if (!s || (s.yellow === undefined && s.red === undefined)) return undefined;
  return (s.yellow ?? 0) + (s.red ?? 0);
}

// ---------------------------------------------------------------------------
// Índice de forma (compartido con form.ts)
// ---------------------------------------------------------------------------

export interface FormEntry {
  /** puntos obtenidos (3/1/0) */
  pts: number;
  /** diferencia de goles del partido */
  gd: number;
  /** diferencia xG (xG a favor − xG en contra) cuando existe */
  xgd?: number;
  /** Elo pre-partido del rival cuando existe */
  oppElo?: number;
}

/** Decaimiento EWMA del índice de forma (peso de un partido con antigüedad a: 0.75^a). */
export const FORM_ALPHA = 0.25;

/**
 * Índice de forma 0..100 a partir de los últimos partidos (cronológico, el más reciente al final):
 *  - 50 %: EWMA de puntos ajustados por la fuerza del rival: pts·clamp(1 + (Elo_rival − ref)/500, 0.7, 1.3),
 *          ref = opts.eloRef o la media del Elo de los rivales de la ventana; normalizado /3.
 *  - 25 %: EWMA de la diferencia de goles (recortada a ±3) → 0.5 + x/4.
 *  - 25 %: EWMA de la diferencia xG → 0.5 + x/3 (si al menos la mitad de los partidos tiene xG;
 *          si no, los pesos pasan a 60 % puntos / 40 % goles).
 * Sin partidos devuelve 50 (neutral).
 */
export function computeFormIndex(entries: FormEntry[], opts: { eloRef?: number; alpha?: number } = {}): number {
  if (entries.length === 0) return 50;
  const alpha = opts.alpha ?? FORM_ALPHA;
  const elos = entries.map((e) => e.oppElo).filter((x): x is number => x !== undefined && Number.isFinite(x));
  const ref = opts.eloRef ?? (elos.length ? mean(elos) : undefined);
  const adjPts = entries.map((e) => {
    if (ref === undefined || e.oppElo === undefined || !Number.isFinite(e.oppElo)) return e.pts;
    return e.pts * clamp(1 + (e.oppElo - ref) / 500, 0.7, 1.3);
  });
  const ptsScore = clamp(ewma(adjPts, alpha) / 3, 0, 1);
  const gdScore = clamp(0.5 + ewma(entries.map((e) => clamp(e.gd, -3, 3)), alpha) / 4, 0, 1);
  const xgds = entries.map((e) => e.xgd).filter((x): x is number => x !== undefined && Number.isFinite(x));
  let score: number;
  if (xgds.length > 0 && xgds.length * 2 >= entries.length) {
    const xgScore = clamp(0.5 + ewma(xgds, alpha) / 3, 0, 1);
    score = 0.5 * ptsScore + 0.25 * gdScore + 0.25 * xgScore;
  } else {
    score = 0.6 * ptsScore + 0.4 * gdScore;
  }
  return round(100 * score, 1);
}

// ---------------------------------------------------------------------------
// Estadística de temporada por equipo
// ---------------------------------------------------------------------------

function avgDefined(values: (number | undefined)[]): number {
  let s = 0;
  let n = 0;
  for (const v of values) {
    if (v === undefined || !Number.isFinite(v)) continue;
    s += v;
    n++;
  }
  return n > 0 ? s / n : 0;
}

function splitOf(views: TeamView[], f: (v: TeamView) => number | undefined, digits = 2): SplitStat {
  return {
    all: round(avgDefined(views.map(f)), digits),
    home: round(avgDefined(views.filter((v) => v.isHome).map(f)), digits),
    away: round(avgDefined(views.filter((v) => !v.isHome).map(f)), digits),
  };
}

function share(views: TeamView[], pred: (v: TeamView) => boolean): number {
  if (views.length === 0) return 0;
  let n = 0;
  for (const v of views) if (pred(v)) n++;
  return round(n / views.length, 4);
}

/** Vistas por equipo (cronológicas) de un conjunto de partidos terminados. */
export function viewsByTeam(matches: MatchRecord[], xg?: XgMap): Map<string, TeamView[]> {
  const by = new Map<string, TeamView[]>();
  for (const m of finishedSorted(matches)) {
    for (const id of [m.home.id, m.away.id]) {
      const v = teamView(m, id, xg);
      if (!v) continue;
      let arr = by.get(id);
      if (!arr) by.set(id, (arr = []));
      arr.push(v);
    }
  }
  return by;
}

/** Cadena de forma de los últimos n resultados (cronológica: el más reciente al final). */
export function formStringOf(views: TeamView[], n = 5): string {
  return views
    .slice(-n)
    .map((v) => v.result)
    .join('');
}

function goalPeriods(views: TeamView[], teamId: string): { scored: number[]; conceded: number[] } | undefined {
  const scored = [0, 0, 0, 0, 0, 0];
  const conceded = [0, 0, 0, 0, 0, 0];
  let any = false;
  for (const v of views) {
    const evs = v.match.events;
    if (!evs || evs.length === 0) continue;
    any = true;
    for (const e of evs) {
      if (e.type !== 'goal' && e.type !== 'penalty' && e.type !== 'own-goal') continue;
      // en la fuente, el teamId de un gol en propia puerta es el del equipo beneficiado
      const idx = periodIndex(e.minute);
      if (e.teamId === teamId) scored[idx]++;
      else if (e.teamId === v.opponent.id) conceded[idx]++;
    }
  }
  return any ? { scored, conceded } : undefined;
}

/**
 * Estadística de temporada de cada equipo a partir de los partidos terminados (de la temporada actual de una
 * competición). Ordenada por nombre de equipo.
 */
export function computeTeamSeasonStats(matches: MatchRecord[], opts: { xg?: XgMap } = {}): TeamSeasonStats[] {
  const by = viewsByTeam(matches, opts.xg);
  const out: TeamSeasonStats[] = [];
  for (const [teamId, views] of by) {
    const last = views[views.length - 1];
    const total = (v: TeamView) => v.gf + v.ga;
    const row: TeamSeasonStats = {
      team: last.team,
      played: {
        all: views.length,
        home: views.filter((v) => v.isHome).length,
        away: views.filter((v) => !v.isHome).length,
      },
      goalsFor: splitOf(views, (v) => v.gf),
      goalsAgainst: splitOf(views, (v) => v.ga),
      xgFor: splitOf(views, (v) => v.xg),
      xgAgainst: splitOf(views, (v) => v.xga),
      shots: splitOf(views, (v) => v.own?.shots),
      shotsAgainst: splitOf(views, (v) => v.opp?.shots),
      shotsOnTarget: splitOf(views, (v) => v.own?.shotsOnTarget),
      shotsOnTargetAgainst: splitOf(views, (v) => v.opp?.shotsOnTarget),
      corners: splitOf(views, (v) => v.own?.corners),
      cornersAgainst: splitOf(views, (v) => v.opp?.corners),
      cards: splitOf(views, (v) => cardsOf(v.own)),
      cardsAgainst: splitOf(views, (v) => cardsOf(v.opp)),
      fouls: splitOf(views, (v) => v.own?.fouls),
      possession: splitOf(views, (v) => v.own?.possession, 1),
      over15Pct: share(views, (v) => total(v) > 1.5),
      over25Pct: share(views, (v) => total(v) > 2.5),
      over35Pct: share(views, (v) => total(v) > 3.5),
      bttsPct: share(views, (v) => v.gf > 0 && v.ga > 0),
      cleanSheetPct: share(views, (v) => v.ga === 0),
      failedToScorePct: share(views, (v) => v.gf === 0),
      winPct: share(views, (v) => v.result === 'W'),
      drawPct: share(views, (v) => v.result === 'D'),
      lossPct: share(views, (v) => v.result === 'L'),
      formString: formStringOf(views, 5),
      formIndex: computeFormIndex(
        views.slice(-10).map((v) => ({
          pts: v.pts,
          gd: v.gf - v.ga,
          xgd: v.xg !== undefined && v.xga !== undefined ? v.xg - v.xga : undefined,
        })),
      ),
    };
    const periods = goalPeriods(views, teamId);
    if (periods) {
      row.goalsByPeriod = periods.scored;
      row.concededByPeriod = periods.conceded;
    }
    out.push(row);
  }
  return out.sort((a, b) => a.team.name.localeCompare(b.team.name, 'es'));
}

// ---------------------------------------------------------------------------
// Medias de liga
// ---------------------------------------------------------------------------

function pairTotal(m: FinishedRecord, f: (s: TeamMatchStats) => number | undefined): number | undefined {
  if (!m.stats) return undefined;
  const h = f(m.stats.home);
  const a = f(m.stats.away);
  if (h === undefined || a === undefined || !Number.isFinite(h) || !Number.isFinite(a)) return undefined;
  return h + a;
}

/** Medias por partido de la competición (totales de ambos equipos) y frecuencias 1X2 / over 2.5 / ambos marcan. */
export function computeLeagueAverages(matches: MatchRecord[]): LeagueAverages {
  const ms = finishedSorted(matches);
  const n = ms.length;
  if (n === 0) {
    return {
      goalsPerMatch: 0,
      homeGoals: 0,
      awayGoals: 0,
      homeWinPct: 0,
      drawPct: 0,
      awayWinPct: 0,
      over25Pct: 0,
      bttsPct: 0,
      cornersPerMatch: 0,
      cardsPerMatch: 0,
      shotsPerMatch: 0,
      shotsOnTargetPerMatch: 0,
      foulsPerMatch: 0,
    };
  }
  const frac = (pred: (m: FinishedRecord) => boolean) => round(ms.filter(pred).length / n, 4);
  return {
    goalsPerMatch: round(mean(ms.map((m) => m.score.home + m.score.away)), 3),
    homeGoals: round(mean(ms.map((m) => m.score.home)), 3),
    awayGoals: round(mean(ms.map((m) => m.score.away)), 3),
    homeWinPct: frac((m) => m.score.home > m.score.away),
    drawPct: frac((m) => m.score.home === m.score.away),
    awayWinPct: frac((m) => m.score.home < m.score.away),
    over25Pct: frac((m) => m.score.home + m.score.away > 2.5),
    bttsPct: frac((m) => m.score.home > 0 && m.score.away > 0),
    cornersPerMatch: round(avgDefined(ms.map((m) => pairTotal(m, (s) => s.corners))), 3),
    cardsPerMatch: round(avgDefined(ms.map((m) => pairTotal(m, (s) => cardsOf(s)))), 3),
    shotsPerMatch: round(avgDefined(ms.map((m) => pairTotal(m, (s) => s.shots))), 3),
    shotsOnTargetPerMatch: round(avgDefined(ms.map((m) => pairTotal(m, (s) => s.shotsOnTarget))), 3),
    foulsPerMatch: round(avgDefined(ms.map((m) => pairTotal(m, (s) => s.fouls))), 3),
  };
}

// ---------------------------------------------------------------------------
// Clasificación calculada y puntos esperados (xPts)
// ---------------------------------------------------------------------------

/** Puntos esperados de cada lado dados los λ del partido (matriz de marcadores Poisson / Dixon-Coles). */
export function expectedPoints(lambdaHome: number, lambdaAway: number, rho = 0): { home: number; away: number } {
  const p = outcomeProbs(scoreMatrix(Math.max(0.01, lambdaHome), Math.max(0.01, lambdaAway), rho, 10));
  return { home: 3 * p.home + p.draw, away: 3 * p.away + p.draw };
}

/**
 * xPts por equipo: suma, sobre los partidos terminados con xG en el mapa, de los puntos esperados según
 * Poisson(λ = xG de cada lado). Solo incluye equipos con al menos un partido con xG.
 */
export function computeXPts(matches: MatchRecord[], xg: XgMap, rho = 0): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of finishedSorted(matches)) {
    const x = xg.get(m.id);
    if (!x || !Number.isFinite(x.home) || !Number.isFinite(x.away)) continue;
    const e = expectedPoints(x.home, x.away, rho);
    out.set(m.home.id, (out.get(m.home.id) ?? 0) + e.home);
    out.set(m.away.id, (out.get(m.away.id) ?? 0) + e.away);
  }
  return out;
}

/** Copia de la clasificación con xPts (redondeado a 1 decimal) en las filas cuyo equipo aparece en `xpts`. */
export function attachXPts(group: StandingGroup, xpts: Map<string, number>): StandingGroup {
  return {
    name: group.name,
    rows: group.rows.map((r) => {
      const x = xpts.get(r.team.id);
      return x === undefined ? r : { ...r, xPts: round(x, 1) };
    }),
  };
}

/**
 * Clasificación calculada desde los partidos (respaldo cuando ESPN no publica tabla):
 * 3/1/0 puntos; desempate puntos > diferencia de goles > goles a favor > nombre.
 * Con `xg` añade xPts por equipo.
 */
export function computeStandingsFromMatches(
  matches: MatchRecord[],
  opts: { name?: string; xg?: XgMap; rho?: number } = {},
): StandingGroup {
  const by = viewsByTeam(matches);
  const xpts = opts.xg ? computeXPts(matches, opts.xg, opts.rho ?? 0) : undefined;
  const rows: StandingRow[] = [];
  for (const [teamId, views] of by) {
    const won = views.filter((v) => v.result === 'W').length;
    const drawn = views.filter((v) => v.result === 'D').length;
    const lost = views.length - won - drawn;
    const gf = views.reduce((s, v) => s + v.gf, 0);
    const ga = views.reduce((s, v) => s + v.ga, 0);
    const row: StandingRow = {
      rank: 0,
      team: views[views.length - 1].team,
      played: views.length,
      won,
      drawn,
      lost,
      gf,
      ga,
      gd: gf - ga,
      points: 3 * won + drawn,
      form: formStringOf(views, 5),
    };
    const x = xpts?.get(teamId);
    if (x !== undefined) row.xPts = round(x, 1);
    rows.push(row);
  }
  rows.sort(
    (a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf || a.team.name.localeCompare(b.team.name, 'es'),
  );
  rows.forEach((r, i) => (r.rank = i + 1));
  return { name: opts.name ?? 'Clasificación', rows };
}
