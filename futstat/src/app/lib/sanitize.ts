/**
 * Normalización defensiva de los JSON publicados (contrato en src/types/data.ts).
 *
 * El pipeline valida los datos antes de publicarlos, pero la app no confía ciegamente en ellos:
 * cada archivo pasa por aquí antes de llegar a las páginas para que un campo ausente o con un tipo
 * inesperado no tumbe la interfaz.
 *
 *  - Listas ausentes o con otro tipo → [] (y se descartan los elementos que no son objetos válidos).
 *  - Partidos/equipos/jugadores sin identidad mínima (id + nombre) → se descartan.
 *  - Estados y enumerados desconocidos → valor neutro ('scheduled', '?', 'baja'...).
 *  - URLs de escudos/logos fuera del origen permitido → se eliminan (la UI muestra iniciales/bandera).
 *  - Colores que no son hex de 6 dígitos → se eliminan.
 *  - Números no finitos se dejan como undefined: los formateadores de lib/format.ts muestran "—".
 *
 * No se inventan cifras: un dato que falta se muestra como "—", nunca como 0 ni como "NaN".
 */
import type {
  BacktestSummary,
  CompetitionFile,
  CompetitionMeta,
  FormMatch,
  HomeFile,
  MatchFile,
  MatchStatus,
  MatchSummary,
  MetaFile,
  ModelFile,
  PlayerSeasonRow,
  PlayersFile,
  Prob1X2,
  SplitStat,
  StandingRow,
  TeamFile,
  TeamFormBlock,
  TeamRef,
  TeamSeasonStats,
  ValueFile,
  ValuePick,
} from '../../types/data';
import { safeImageUrl } from './safeUrl';

type Obj = Record<string, unknown>;

export const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const fin = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const str = (x: unknown, fallback = ''): string => (typeof x === 'string' ? x : typeof x === 'number' && Number.isFinite(x) ? String(x) : fallback);
const optStr = (x: unknown): string | undefined => {
  const s = str(x);
  return s ? s : undefined;
};
const bool = (x: unknown): boolean => x === true;
/** Copia de `o` con cada clave de `keys` convertida a número finito o undefined (Infinity, "NaN", objetos… → undefined). */
function finKeys(o: Obj, keys: readonly string[]): Obj {
  const out: Obj = { ...o };
  for (const k of keys) out[k] = fin(o[k]);
  return out;
}
/**
 * Mapa etiqueta → probabilidad sin prototipo (las claves vienen de los datos: "__proto__" o "constructor" no deben
 * resolver a Object.prototype) y solo con valores finitos.
 */
function probMap(x: unknown): Record<string, number> {
  const out = Object.create(null) as Record<string, number>;
  if (isObj(x)) for (const [k, v] of Object.entries(x)) if (fin(v) !== undefined) out[k] = v as number;
  return out;
}
/** Texto acotado (para campos que se pintan sin truncar: banderas, abreviaturas…). */
const short = (x: unknown, max: number): string => Array.from(str(x).trim()).slice(0, max).join('');

/** Lista de objetos normalizados (descarta lo que no sea objeto o lo que `f` rechace devolviendo undefined). */
function list<T>(x: unknown, f: (v: Obj, i: number) => T | undefined, max = 5000): T[] {
  if (!Array.isArray(x)) return [];
  const out: T[] = [];
  for (let i = 0; i < x.length && out.length < max; i++) {
    const v = x[i];
    if (!isObj(v)) continue;
    try {
      const r = f(v, i);
      if (r !== undefined) out.push(r);
    } catch {
      /* elemento corrupto: se omite */
    }
  }
  return out;
}
const strList = (x: unknown, max = 500): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string').slice(0, max) : []);
const numList = (x: unknown, max = 2000): number[] => (Array.isArray(x) ? x.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).slice(0, max) : []);
const validDate = (x: unknown): string | undefined => (typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? x : undefined);
const hex6 = (x: unknown): string | undefined => {
  const s = typeof x === 'string' ? x.trim().replace(/^#/, '') : '';
  return /^[0-9a-fA-F]{6}$/.test(s) ? s : undefined;
};

// ---------------------------------------------------------------------------
// Primitivas del contrato
// ---------------------------------------------------------------------------
export function normTeamRef(t: unknown): TeamRef | undefined {
  if (!isObj(t)) return undefined;
  // longitudes acotadas: un texto de miles de caracteres sin espacios desbordaría el diseño
  const name = short(t.name, 100) || short(t.short, 100);
  const id = str(t.id).trim();
  if (!name) return undefined;
  return {
    ...(t as object),
    id,
    name,
    short: short(t.short, 40) || name,
    abbr: short(t.abbr, 8) || Array.from(name).slice(0, 3).join('').toUpperCase(),
    logo: safeImageUrl(t.logo),
    color: hex6(t.color),
  } as TeamRef;
}

function normProb(p: unknown): Prob1X2 | undefined {
  if (!isObj(p)) return undefined;
  const home = fin(p.home);
  const draw = fin(p.draw);
  const away = fin(p.away);
  if (home === undefined || draw === undefined || away === undefined) return undefined;
  if (home < 0 || draw < 0 || away < 0 || home + draw + away <= 0) return undefined;
  return { home, draw, away };
}

const CONFIDENCE = new Set(['alta', 'media', 'baja']);
export function normPick(p: unknown): ValuePick | undefined {
  if (!isObj(p)) return undefined;
  const prob = fin(p.prob);
  const odds = fin(p.odds);
  if (prob === undefined || odds === undefined || prob <= 0 || prob > 1 || odds <= 1) return undefined;
  const ev = fin(p.ev) ?? prob * odds - 1;
  return {
    ...(p as object),
    marketId: str(p.marketId, 'otro'),
    market: str(p.market, 'Mercado'),
    selection: str(p.selection, '—'),
    prob,
    odds,
    fairOdds: fin(p.fairOdds) ?? Math.min(1000, 1 / prob),
    ev,
    kelly: fin(p.kelly) ?? 0,
    edge: fin(p.edge) ?? prob - 1 / odds,
    confidence: CONFIDENCE.has(str(p.confidence)) ? (p.confidence as ValuePick['confidence']) : 'baja',
  } as ValuePick;
}

const STATUS = new Set<MatchStatus>(['scheduled', 'live', 'finished', 'postponed', 'cancelled']);
export function normMatch(m: unknown): MatchSummary | undefined {
  if (!isObj(m)) return undefined;
  const id = str(m.id).trim();
  const home = normTeamRef(m.home);
  const away = normTeamRef(m.away);
  const date = validDate(m.date);
  if (!id || !home || !away || !date) return undefined;
  const compId = str(m.compId);
  const status = STATUS.has(m.status as MatchStatus) ? (m.status as MatchStatus) : 'scheduled';
  const s = isObj(m.score) ? m.score : undefined;
  const score =
    s && fin(s.home) !== undefined && fin(s.away) !== undefined
      ? { ...finKeys(s, ['htHome', 'htAway', 'penHome', 'penAway']), home: s.home as number, away: s.away as number }
      : undefined;
  let prediction: MatchSummary['prediction'];
  if (isObj(m.prediction)) {
    const p = normProb(m.prediction.p);
    if (p) {
      prediction = {
        ...(m.prediction as object),
        p,
        market: normProb(m.prediction.market),
        pick: normPick(m.prediction.pick),
      } as MatchSummary['prediction'];
    }
  }
  return {
    ...(m as object),
    id,
    compId,
    compName: str(m.compName) || compId,
    date,
    status,
    statusDetail: short(m.statusDetail, 40) || undefined,
    round: optStr(m.round),
    home,
    away,
    score,
    prediction,
    odds: normOdds(m.odds),
    venue: optStr(m.venue),
    homeForm: optStr(m.homeForm),
    awayForm: optStr(m.awayForm),
    hasDetail: bool(m.hasDetail),
    predictionHit: typeof m.predictionHit === 'boolean' ? m.predictionHit : undefined,
  } as MatchSummary;
}

const ODDS_KEYS = ['home', 'draw', 'away', 'homeOpen', 'drawOpen', 'awayOpen', 'totalLine', 'over', 'under', 'overOpen', 'underOpen', 'spreadLine', 'spreadHome', 'spreadAway', 'margin'] as const;
function normOdds(o: unknown): MatchSummary['odds'] {
  if (!isObj(o)) return undefined;
  const out: Obj = { provider: str(o.provider) || 'Mercado', capturedAt: validDate(o.capturedAt) };
  for (const k of ODDS_KEYS) out[k] = fin(o[k]);
  return out as unknown as MatchSummary['odds'];
}

const OUTCOMES = new Set(['W', 'D', 'L']);
const FORM_NUM_KEYS = ['shots', 'shotsOnTarget', 'corners', 'cornersAgainst', 'cards', 'fouls', 'possession', 'xg', 'xga'] as const;
const EVENT_TYPES = new Set(['goal', 'own-goal', 'penalty', 'yellow', 'red', 'sub']);
export function normFormMatch(f: unknown): FormMatch | undefined {
  if (!isObj(f)) return undefined;
  const opponent = normTeamRef(f.opponent);
  const gf = fin(f.gf);
  const ga = fin(f.ga);
  const date = validDate(f.date);
  if (!opponent || gf === undefined || ga === undefined || !date) return undefined;
  const result = OUTCOMES.has(str(f.result)) ? (f.result as FormMatch['result']) : gf > ga ? 'W' : gf < ga ? 'L' : 'D';
  return { ...finKeys(f, FORM_NUM_KEYS), matchId: str(f.matchId), date, compId: str(f.compId), opponent, isHome: bool(f.isHome), gf, ga, result, hasDetail: bool(f.hasDetail) } as FormMatch;
}

const POSITIONS = new Set(['G', 'D', 'M', 'F', '?']);
const PLAYER_NUM_KEYS = ['apps', 'starts', 'minutes', 'goals', 'assists', 'shots', 'shotsOnTarget', 'yellow', 'red', 'foulsCommitted', 'foulsSuffered', 'offsides', 'saves', 'formIndex'] as const;
const PER90_KEYS = ['goals', 'assists', 'shots', 'shotsOnTarget', 'cards', 'foulsCommitted'] as const;
const LAST5_NUM_KEYS = ['minutes', 'goals', 'assists', 'shots', 'shotsOnTarget', 'cards', 'rating'] as const;
const PROP_NUM_KEYS = ['apps', 'minutes', 'goals', 'assists', 'expMinutes', 'formIndex', 'pGoal', 'pAssist', 'pGoalOrAssist', 'pShots1', 'pShots2', 'pSot1', 'pSot2', 'pCard', 'pFouls2'] as const;
const position = (x: unknown): PlayerSeasonRow['player']['position'] => {
  const p = str(x);
  return POSITIONS.has(p) ? (p as PlayerSeasonRow['player']['position']) : '?';
};
export function normPlayerRow(r: unknown): PlayerSeasonRow | undefined {
  if (!isObj(r) || !isObj(r.player)) return undefined;
  const team = normTeamRef(r.team);
  const name = str(r.player.name).trim();
  if (!team || !name) return undefined;
  return {
    ...finKeys(r, PLAYER_NUM_KEYS),
    player: { ...(r.player as object), id: str(r.player.id), name, short: str(r.player.short) || name, position: position(r.player.position), teamId: str(r.player.teamId) || team.id },
    team,
    compId: str(r.compId),
    per90: finKeys(isObj(r.per90) ? r.per90 : {}, PER90_KEYS),
    formTrend: numList(r.formTrend, 20),
    last5: list(r.last5, (g) => ({ ...finKeys(g, LAST5_NUM_KEYS), matchId: str(g.matchId), date: str(g.date), opponent: str(g.opponent) }), 10),
  } as PlayerSeasonRow;
}

const SPLIT_KEYS = [
  'played', 'goalsFor', 'goalsAgainst', 'xgFor', 'xgAgainst', 'shots', 'shotsAgainst', 'shotsOnTarget', 'shotsOnTargetAgainst',
  'corners', 'cornersAgainst', 'cards', 'cardsAgainst', 'fouls', 'possession',
] as const;
const split = (x: unknown): SplitStat => (isObj(x) ? ({ all: fin(x.all), home: fin(x.home), away: fin(x.away) } as unknown as SplitStat) : ({} as SplitStat));

export function normSeasonStats(s: unknown): TeamSeasonStats | undefined {
  if (!isObj(s)) return undefined;
  const team = normTeamRef(s.team);
  if (!team) return undefined;
  const out: Obj = { ...(s as object), team, formString: str(s.formString) };
  for (const k of SPLIT_KEYS) out[k] = split(s[k]);
  if (s.goalsByPeriod !== undefined) out.goalsByPeriod = numList(s.goalsByPeriod, 12);
  if (s.concededByPeriod !== undefined) out.concededByPeriod = numList(s.concededByPeriod, 12);
  return out as unknown as TeamSeasonStats;
}

const STANDING_NUM_KEYS = ['played', 'won', 'drawn', 'lost', 'gf', 'ga', 'gd', 'points', 'xPts', 'elo'] as const;
function normStanding(r: Obj, i: number): StandingRow | undefined {
  const team = normTeamRef(r.team);
  if (!team) return undefined;
  const note = isObj(r.note) && str(r.note.label) ? { label: str(r.note.label), color: str(r.note.color) } : undefined;
  return { ...finKeys(r, STANDING_NUM_KEYS), rank: fin(r.rank) ?? i + 1, team, form: optStr(r.form), note } as StandingRow;
}

export function normFormBlock(b: unknown, fallbackTeam?: TeamRef): TeamFormBlock {
  const o = isObj(b) ? b : {};
  const team = normTeamRef(o.team) ?? fallbackTeam ?? ({ id: '', name: 'Equipo', short: 'Equipo', abbr: '—' } as TeamRef);
  const vs = isObj(o.venueSplit) ? o.venueSplit : {};
  return {
    ...finKeys(o, ['ppg5', 'ppg10', 'gf5', 'ga5', 'formIndex', 'elo']),
    team,
    last: list(o.last, (f) => normFormMatch(f), 40),
    formString: str(o.formString),
    streaks: strList(o.streaks, 20),
    eloTrend: numList(o.eloTrend, 60),
    venueSplit: { played: fin(vs.played), ppg: fin(vs.ppg), gf: fin(vs.gf), ga: fin(vs.ga) },
  } as unknown as TeamFormBlock;
}

function normBacktest(b: unknown): BacktestSummary | undefined {
  if (!isObj(b)) return undefined;
  return {
    ...(b as object),
    model: isObj(b.model) ? b.model : {},
    baseline: isObj(b.baseline) ? b.baseline : {},
    elo: isObj(b.elo) ? b.elo : undefined,
    dixonColes: isObj(b.dixonColes) ? b.dixonColes : undefined,
    market: isObj(b.market) ? b.market : undefined,
    calibration: list(b.calibration, (c) => (fin(c.predicted) !== undefined && fin(c.observed) !== undefined ? c : undefined), 100),
    roi: isObj(b.roi) ? b.roi : undefined,
    over25: isObj(b.over25) ? b.over25 : undefined,
    btts: isObj(b.btts) ? b.btts : undefined,
  } as unknown as BacktestSummary;
}

const KINDS = new Set(['league', 'cup', 'continental']);
const COMP_ID = /^[a-z0-9-]{1,40}$/;
export function normCompetitionMeta(c: unknown, fallbackId?: string): CompetitionMeta | undefined {
  if (!isObj(c) && !fallbackId) return undefined;
  const o = isObj(c) ? c : {};
  // Un id con formato inválido ("LaLiga", "javascript:…") no debe dejar la competición sin metadatos:
  // si hay un id de reserva (el del nombre del archivo) se usa ese.
  const raw = str(o.id).trim();
  const id = COMP_ID.test(raw) ? raw : fallbackId ?? '';
  if (!COMP_ID.test(id)) return undefined;
  const name = short(o.name, 80) || short(o.shortName, 80) || id;
  return {
    ...(o as object),
    id,
    slug: str(o.slug),
    name,
    shortName: short(o.shortName, 40) || name,
    country: short(o.country, 40),
    // Bandera: un emoji o símbolo (a lo sumo unos pocos puntos de código); una cadena larga desbordaría la cabecera.
    flag: short(o.flag, 8) || '⚽',
    kind: KINDS.has(str(o.kind)) ? (o.kind as CompetitionMeta['kind']) : 'league',
    tier: fin(o.tier) ?? 1,
    logo: safeImageUrl(o.logo),
    logoDark: safeImageUrl(o.logoDark),
    seasonLabel: short(o.seasonLabel, 20) || undefined,
    hasTable: bool(o.hasTable),
    hasSimulation: bool(o.hasSimulation),
    simulationColumns: o.simulationColumns === undefined ? undefined : strList(o.simulationColumns, 20).map((c) => Array.from(c).slice(0, 40).join('')),
    upcomingCount: Math.max(0, fin(o.upcomingCount) ?? 0),
    nextMatchDate: validDate(o.nextMatchDate),
    finishedCount: Math.max(0, fin(o.finishedCount) ?? 0),
    color: hex6(o.color),
    dataUpdatedAt: validDate(o.dataUpdatedAt),
  } as CompetitionMeta;
}

/**
 * Tope de elementos de las listas de partidos que la UI pinta enteras (hoy, próximos, resultados). El pipeline publica
 * decenas; miles bloquearían el hilo principal varios segundos (cientos de miles de nodos DOM).
 */
const LIST_MAX = 300;

const valueItem = (b: Obj) => {
  const match = normMatch(b.match);
  const pick = normPick(b.pick);
  return match && pick ? { match, pick } : undefined;
};

// ---------------------------------------------------------------------------
// Archivos raíz
// ---------------------------------------------------------------------------
function normMeta(v: Obj): MetaFile {
  const counts = isObj(v.counts) ? v.counts : {};
  return {
    ...(v as object),
    version: short(v.version, 20),
    dataSource: short(v.dataSource, 60) || 'ESPN (API pública)',
    dataUpdatedAt: validDate(v.dataUpdatedAt),
    competitions: list(v.competitions, (c) => normCompetitionMeta(c), 200),
    counts: {
      matchesAnalyzed: fin(counts.matchesAnalyzed),
      upcomingMatches: fin(counts.upcomingMatches),
      teams: fin(counts.teams),
      players: fin(counts.players),
      valueBets: fin(counts.valueBets),
    },
    teams: list(
      v.teams,
      (t) => {
        const id = str(t.id).trim();
        const name = str(t.name).trim();
        if (!/^[0-9]{1,15}$/.test(id) || !name) return undefined;
        return { id, name: Array.from(name).slice(0, 100).join(''), abbr: short(t.abbr, 8), logo: safeImageUrl(t.logo), color: hex6(t.color), compId: str(t.compId) };
      },
      20000,
    ),
  } as unknown as MetaFile;
}

function normHome(v: Obj): HomeFile {
  const mh = isObj(v.modelHeadline) && fin(v.modelHeadline.accuracy) !== undefined ? v.modelHeadline : undefined;
  return {
    ...(v as object),
    popular: list(v.popular, normMatch, 60),
    today: list(v.today, normMatch, LIST_MAX),
    tomorrow: list(v.tomorrow, normMatch, LIST_MAX),
    recent: list(v.recent, normMatch, LIST_MAX),
    topValue: list(v.topValue, valueItem, 60),
    hotPlayers: list(v.hotPlayers, normPlayerRow, 60),
    highlights: strList(v.highlights, 50),
    modelHeadline: mh,
  } as unknown as HomeFile;
}

function normCompetition(v: Obj, compId: string): CompetitionFile {
  // La identidad la fija el nombre del archivo (ya validado por la ruta): meta siempre existe y su id es compId.
  const meta: CompetitionMeta = { ...(normCompetitionMeta(v.meta, compId) ?? normCompetitionMeta({}, compId)!), id: compId };
  const la = finKeys(isObj(v.leagueAverages) ? v.leagueAverages : {}, [
    'goalsPerMatch', 'homeGoals', 'awayGoals', 'homeWinPct', 'drawPct', 'awayWinPct', 'over25Pct', 'bttsPct',
    'cornersPerMatch', 'cardsPerMatch', 'shotsPerMatch', 'shotsOnTargetPerMatch', 'foulsPerMatch',
  ]);
  return {
    ...(v as object),
    meta,
    standings: list(v.standings, (g) => ({ ...(g as object), name: str(g.name) || meta.name, rows: list(g.rows, normStanding, 200) }), 50),
    upcoming: list(v.upcoming, normMatch, LIST_MAX),
    results: list(v.results, normMatch, LIST_MAX),
    live: list(v.live, normMatch, 100),
    teams: list(v.teams, normSeasonStats, 400),
    ratings: list(
      v.ratings,
      (r) => {
        const team = normTeamRef(r.team);
        return team
          ? { ...finKeys(r, ['elo', 'eloRank', 'globalEloRank', 'attack', 'defence']), team, eloHistory: list(r.eloHistory, (h) => (validDate(h.date) && fin(h.elo) !== undefined ? h : undefined), 400) }
          : undefined;
      },
      400,
    ),
    simulations: list(
      v.simulations,
      (s) => ({
        ...(s as object),
        group: str(s.group),
        columns: strList(s.columns, 20),
        rows: list(
          s.rows,
          (r) => {
            const team = normTeamRef(r.team);
            return team ? { ...finKeys(r, ['currentPoints', 'expectedPoints', 'expectedRank']), team, probs: probMap(r.probs), positionDist: numList(r.positionDist, 100) } : undefined;
          },
          60,
        ),
      }),
      20,
    ),
    players: list(v.players, normPlayerRow, 300),
    leagueAverages: la,
    backtest: normBacktest(v.backtest),
    insights: strList(v.insights, 50),
  } as unknown as CompetitionFile;
}

const MATRIX_MAX = 11;
const ACTUAL_NUM_KEYS = ['goals', 'shots', 'shotsOnTarget', 'corners', 'fouls', 'yellow', 'red', 'offsides', 'possession', 'saves', 'passes', 'passPct', 'tackles'] as const;
const DEVIG_METHODS = new Set(['shin', 'multiplicative', 'power']);
function normModelMarket(mk: unknown): MatchFile['model']['market'] {
  if (!isObj(mk)) return undefined;
  const probs = normProb(mk.probs);
  if (!probs) return undefined;
  return { ...(mk as object), probs, margin: fin(mk.margin) as number, method: DEVIG_METHODS.has(str(mk.method)) ? str(mk.method) : '' };
}

function normMatchFile(v: Obj): MatchFile {
  const match = normMatch(v.match);
  if (!match) throw new Error('Partido sin datos mínimos');
  const form = isObj(v.form) ? v.form : {};
  const players = isObj(v.players) ? v.players : {};
  const h2h = isObj(v.h2h) ? v.h2h : {};
  // Props de jugador: posición dentro del enumerado (se usa como clave de etiquetas) y cifras finitas.
  const prop = (p: Obj) =>
    isObj(p.player) && str(p.player.name).trim()
      ? { ...finKeys(p, PROP_NUM_KEYS), player: { ...(p.player as object), id: str(p.player.id), name: str(p.player.name).trim(), short: str(p.player.short) || str(p.player.name).trim(), position: position(p.player.position), teamId: str(p.player.teamId) } }
      : undefined;
  const table = isObj(v.table) ? { ...finKeys(v.table, ['homeRank', 'awayRank']), group: str(v.table.group), rows: list(v.table.rows, normStanding, 200) } : undefined;
  return {
    ...(v as object),
    match,
    model: isObj(v.model)
      ? {
          ...finKeys(v.model, ['lambdaHome', 'lambdaAway', 'rho', 'confidence']),
          // La UI solo muestra hasta ~10 goles por equipo: se recorta a 11×11 (un array enorme bloquearía el hilo principal).
          scoreMatrix: Array.isArray(v.model.scoreMatrix)
            ? v.model.scoreMatrix.filter(Array.isArray).slice(0, MATRIX_MAX).map((row: unknown[]) => row.slice(0, MATRIX_MAX).map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)))
            : [],
          market: normModelMarket(v.model.market),
          explanation: strList(v.model.explanation, 50),
          weights: finKeys(isObj(v.model.weights) ? v.model.weights : {}, ['dixonColes', 'elo', 'market']),
          elo: isObj(v.model.elo) ? { ...finKeys(v.model.elo, ['home', 'away', 'diff']), probs: normProb(v.model.elo.probs) } : {},
          dixonColes: isObj(v.model.dixonColes) && normProb(v.model.dixonColes.probs)
            ? { ...finKeys(v.model.dixonColes, ['lambdaHome', 'lambdaAway']), probs: normProb(v.model.dixonColes.probs) }
            : undefined,
          ensemble: normProb(v.model.ensemble) ?? match.prediction?.p,
        }
      : undefined,
    markets: list(
      v.markets,
      (mk) => ({
        ...finKeys(mk, ['line']),
        id: str(mk.id),
        name: str(mk.name),
        group: str(mk.group) || 'Principales',
        selections: list(mk.selections, (s) => (fin(s.prob) !== undefined ? { ...finKeys(s, ['prob', 'fairOdds', 'marketOdds', 'ev']), label: str(s.label), note: optStr(s.note) } : undefined), 200),
      }),
      400,
    ),
    projections: list(
      v.projections,
      (p) => ({
        ...finKeys(p, ['home', 'away', 'total', 'leagueAvg']),
        label: str(p.label),
        most: normProb(p.most),
        totalDist: numList(p.totalDist, 200),
        lines: list(p.lines, (l) => (fin(l.line) !== undefined ? finKeys(l, ['line', 'over', 'under']) : undefined), 60),
      }),
      20,
    ),
    form: { home: normFormBlock(form.home, match.home), away: normFormBlock(form.away, match.away) },
    h2h: { ...finKeys(h2h, ['homeWins', 'draws', 'awayWins', 'avgGoals', 'bttsPct', 'over25Pct']), matches: list(h2h.matches, normMatch, 100) },
    comparison: list(v.comparison, (c) => (str(c.label) ? finKeys(c, ['home', 'away', 'leagueAvg']) : undefined), 100),
    players: { home: list(players.home, prop, 60), away: list(players.away, prop, 60) },
    valueBets: list(v.valueBets, normPick, 50),
    table,
    events:
      v.events === undefined
        ? undefined
        : list(
            v.events,
            (e) =>
              EVENT_TYPES.has(str(e.type))
                ? { ...(e as object), minute: str(e.minute), teamId: str(e.teamId), player: optStr(e.player), playerId: optStr(e.playerId), detail: optStr(e.detail) }
                : undefined,
            200,
          ),
    actual: isObj(v.actual) && isObj(v.actual.home) && isObj(v.actual.away) && fin(v.actual.home.goals) !== undefined && fin(v.actual.away.goals) !== undefined
      ? { home: finKeys(v.actual.home, ACTUAL_NUM_KEYS), away: finKeys(v.actual.away, ACTUAL_NUM_KEYS) }
      : undefined,
  } as unknown as MatchFile;
}

function normTeamFile(v: Obj): TeamFile {
  const team = normTeamRef(v.team);
  if (!team) throw new Error('Equipo sin datos mínimos');
  const standing = isObj(v.standing) ? normStanding(v.standing, 0) : undefined;
  return {
    ...(v as object),
    team,
    competitions: strList(v.competitions, 30).filter((c) => /^[a-z0-9-]{1,40}$/.test(c)),
    primaryCompId: str(v.primaryCompId),
    eloHistory: list(v.eloHistory, (h) => (validDate(h.date) && fin(h.elo) !== undefined ? h : undefined), 1000),
    stats: normSeasonStats(v.stats) ?? normSeasonStats({ team }),
    form: normFormBlock(v.form, team),
    matches: list(v.matches, normFormMatch, 300),
    upcoming: list(v.upcoming, normMatch, 100),
    players: list(v.players, normPlayerRow, 200),
    standing,
  } as unknown as TeamFile;
}

function normPlayers(v: Obj): PlayersFile {
  return { ...(v as object), players: list(v.players, normPlayerRow, 1000) } as unknown as PlayersFile;
}

function normValue(v: Obj): ValueFile {
  return {
    ...(v as object),
    bets: list(v.bets, valueItem, 300),
    minEv: fin(v.minEv) ?? 0.05,
    kellyFraction: fin(v.kellyFraction) ?? 0.25,
    kellyCap: fin(v.kellyCap),
    minProb: fin(v.minProb),
    maxOdds: fin(v.maxOdds),
  } as ValueFile;
}

function normModel(v: Obj): ModelFile {
  return {
    ...(v as object),
    sections: list(v.sections, (s) => ({ title: str(s.title), body: strList(s.body, 100) }), 50),
    backtest: normBacktest(v.backtest) ?? normBacktest({}),
    perCompetition: list(v.perCompetition, (p) => {
      const backtest = normBacktest(p.backtest);
      return backtest ? { ...(p as object), compId: str(p.compId), compName: str(p.compName) || str(p.compId), backtest } : undefined;
    }, 100),
    parameters: isObj(v.parameters) ? v.parameters : {},
  } as unknown as ModelFile;
}

/**
 * Normaliza el JSON de `path` (ruta relativa al directorio de datos, ya validada).
 * Lanza Error si el archivo no tiene la forma mínima (objeto con `generatedAt`).
 */
export function normalizeDataFile(path: string, value: unknown): unknown {
  if (!isObj(value)) throw new Error('El archivo no es un objeto JSON');
  if (typeof value.generatedAt !== 'string' || !value.generatedAt) throw new Error('El archivo no tiene generatedAt');
  if (path === 'meta.json') return normMeta(value);
  if (path === 'home.json') return normHome(value);
  if (path === 'players.json') return normPlayers(value);
  if (path === 'value.json') return normValue(value);
  if (path === 'model.json') return normModel(value);
  let m = /^competitions\/([a-z0-9-]{1,40})\.json$/.exec(path);
  if (m) return normCompetition(value, m[1]);
  m = /^matches\/[0-9]+\.json$/.exec(path);
  if (m) return normMatchFile(value);
  m = /^teams\/[0-9]+\.json$/.exec(path);
  if (m) return normTeamFile(value);
  return value;
}
