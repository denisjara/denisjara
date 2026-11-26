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
  ConfidenceFile,
  ConfidencePick,
  DailyCategory,
  DailyCombo,
  DailyDay,
  DailyExpected,
  DailyFile,
  DailyMatch,
  DailyPick,
  FormMatch,
  HomeFile,
  LongshotBet,
  LongshotDay,
  LongshotFile,
  LongshotKind,
  LongshotLeg,
  LongshotRecord,
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
import { DAILY_CATEGORIES, DAILY_CATEGORY_LABEL, inferDailyCategory, isDailyCategory } from './daily';
import { LONGSHOT_DEFAULT_MIN_ODDS, LONGSHOT_KINDS, LONGSHOT_KIND_LABEL, isLongshotKind, oneIn } from './longshots';

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

/** solo se muestra el nivel oro: los picks 'plata' de ficheros antiguos (o con un nivel desconocido) se descartan */
const TIERS = new Set(['oro']);
const SOURCES = new Set(['mercado', 'estadistico']);
const RESULTS = new Set(['hit', 'miss', 'void']);
const prob01 = (x: unknown): number | undefined => {
  const v = fin(x);
  return v !== undefined && v >= 0 && v <= 1 ? v : undefined;
};
/** Acierto + n + intervalo de Wilson opcionales y coherentes (el intervalo debe contener el acierto). */
function oosRecord(rate: unknown, n: unknown, lo: unknown, hi: unknown): { rate?: number; n?: number; lo?: number; hi?: number } {
  const r = prob01(rate);
  const k = fin(n);
  if (r === undefined || k === undefined || k <= 0) return {};
  const l = prob01(lo);
  const h = prob01(hi);
  const ci = l !== undefined && h !== undefined && l <= r + 1e-9 && r <= h + 1e-9;
  return { rate: r, n: Math.round(k), lo: ci ? l : undefined, hi: ci ? h : undefined };
}

/** Pronóstico de alta confianza: sin probabilidad válida (0,5–1), sin acierto histórico o de nivel plata se descarta. */
export function normConfidencePick(p: unknown): ConfidencePick | undefined {
  if (!isObj(p)) return undefined;
  const prob = prob01(p.prob);
  const hist = prob01(p.historicalHitRate);
  const selection = short(p.selection, 120);
  if (prob === undefined || prob < 0.5 || hist === undefined || !selection || !TIERS.has(str(p.tier))) return undefined;
  const marketOdds = fin(p.marketOdds);
  const ho = oosRecord(p.holdoutHitRate, p.holdoutN, p.holdoutWilsonLow, p.holdoutWilsonHigh);
  const va = oosRecord(p.validationHitRate, p.validationN, p.validationWilsonLow, p.validationWilsonHigh);
  return {
    family: short(p.family, 40) || 'otro',
    marketId: str(p.marketId, 'otro'),
    market: short(p.market, 120) || 'Mercado',
    selection,
    prob,
    fairOdds: fin(p.fairOdds) ?? Math.min(1000, 1 / prob),
    marketOdds: marketOdds !== undefined && marketOdds > 1 ? marketOdds : undefined,
    oddsKind: p.oddsKind === 'directa' || p.oddsKind === 'sintetica' ? p.oddsKind : undefined,
    tier: 'oro',
    historicalHitRate: hist,
    historicalN: Math.max(0, fin(p.historicalN) ?? 0),
    threshold: prob01(p.threshold),
    calibratedProb: prob01(p.calibratedProb),
    source: SOURCES.has(str(p.source)) ? (p.source as ConfidencePick['source']) : undefined,
    validationHitRate: va.rate,
    validationN: va.n,
    validationWilsonLow: va.lo,
    validationWilsonHigh: va.hi,
    holdoutHitRate: ho.rate,
    holdoutN: ho.n,
    holdoutWilsonLow: ho.lo,
    holdoutWilsonHigh: ho.hi,
    baseRate: prob01(p.baseRate),
    result: RESULTS.has(str(p.result)) ? (p.result as ConfidencePick['result']) : undefined,
  };
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
        safe: normConfidencePick(m.prediction.safe),
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

const confidenceItem = (b: Obj) => {
  const match = normMatch(b.match);
  const pick = normConfidencePick(b.pick);
  return match && pick ? { match, pick } : undefined;
};

/** Cifra de cabecera de alta confianza: solo si el acierto y el número de picks son válidos. */
function normConfidenceHeadline(x: unknown): HomeFile['confidenceHeadline'] {
  if (!isObj(x)) return undefined;
  const hitRate = prob01(x.hitRate);
  const picks = fin(x.picks);
  if (hitRate === undefined || picks === undefined || picks <= 0) return undefined;
  const lo = prob01(x.wilsonLow);
  const hi = prob01(x.wilsonHigh);
  const ci = lo !== undefined && hi !== undefined && lo <= hitRate + 1e-9 && hitRate <= hi + 1e-9;
  const fair = fin(x.avgFairOdds);
  return {
    hitRate,
    picks,
    hits: fin(x.hits) ?? Math.round(hitRate * picks),
    wilsonLow: ci ? lo : undefined,
    wilsonHigh: ci ? hi : undefined,
    baselineRate: prob01(x.baselineRate),
    avgFairOdds: fair !== undefined && fair >= 1 ? fair : undefined,
    from: validDate(x.from) ?? '',
    to: validDate(x.to) ?? '',
    upcoming: fin(x.upcoming),
  };
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
    topConfidence: list(v.topConfidence, confidenceItem, 20),
    confidenceHeadline: normConfidenceHeadline(v.confidenceHeadline),
    daily: normHomeDaily(v.daily),
    longshot: normHomeLongshot(v.longshot),
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
    confidence: list(v.confidence, normConfidencePick, 4),
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

/** Registro de acierto: n, aciertos y acierto coherentes (si no, undefined → la UI muestra "—"). */
function normRecord<T extends Obj>(x: unknown, extra: (o: Obj) => T | undefined = () => ({}) as T): (T & { picks: number; n: number; hits: number; hitRate: number; wilsonLow?: number; wilsonHigh?: number; voids?: number; from: string; to: string; matches?: number }) | undefined {
  if (!isObj(x)) return undefined;
  const n = fin(x.n);
  const hits = fin(x.hits);
  const hitRate = prob01(x.hitRate);
  if (n === undefined || hits === undefined || hitRate === undefined || n < 0 || hits < 0 || hits > n) return undefined;
  const e = extra(x);
  if (!e) return undefined;
  return {
    ...e,
    picks: Math.max(n, fin(x.picks) ?? n),
    n,
    hits,
    hitRate,
    wilsonLow: prob01(x.wilsonLow),
    wilsonHigh: prob01(x.wilsonHigh),
    voids: fin(x.voids),
    from: validDate(x.from) ?? '',
    to: validDate(x.to) ?? '',
    matches: fin(x.matches),
  };
}

const THEMES = new Set(['resultado', 'goles', 'corners', 'tarjetas']);
function normConfidence(v: Obj): ConfidenceFile {
  const t = isObj(v.track) ? v.track : {};
  const cov = isObj(t.coverage) ? t.coverage : {};
  const rules = isObj(v.rules) ? v.rules : {};
  const roi = isObj(t.roi) && fin(t.roi.bets) !== undefined && fin(t.roi.roi) !== undefined ? finKeys(t.roi, ['bets', 'roi', 'profit', 'hitRate', 'avgOdds', 'synthetic']) : undefined;
  const cal = isObj(t.calibration) && validDate(t.calibration.from) && validDate(t.calibration.to) ? { from: str(t.calibration.from), to: str(t.calibration.to), matches: fin(t.calibration.matches) ?? 0 } : undefined;
  return {
    ...(v as object),
    picks: list(v.picks, confidenceItem, 3000),
    recent: list(
      v.recent,
      (b) => {
        const it = confidenceItem(b);
        return it ? { ...it, hit: b.hit === true && it.pick.result !== 'void' && it.pick.result !== 'miss' } : undefined;
      },
      3000,
    ),
    track: {
      holdout: normRecord(t.holdout) ?? { picks: 0, n: 0, hits: 0, hitRate: 0, from: '', to: '' },
      virgin: normRecord(t.virgin),
      calibration: cal,
      byTier: list(t.byTier, (x) => normRecord(x, (o) => (TIERS.has(str(o.tier)) ? { tier: o.tier as ConfidencePick['tier'] } : undefined)), 1),
      bySource: list(t.bySource, (x) => normRecord(x, (o) => (SOURCES.has(str(o.source)) ? { source: o.source as NonNullable<ConfidencePick['source']> } : undefined)), 2),
      byFamily: list(
        t.byFamily,
        (f) => {
          const family = short(f.family, 40);
          if (!family) return undefined;
          const n = Math.max(0, fin(f.n) ?? 0);
          const hits = Math.min(n, Math.max(0, fin(f.hits) ?? 0));
          return {
            family,
            label: short(f.label, 80) || family,
            theme: THEMES.has(str(f.theme)) ? (f.theme as ConfidenceFile['track']['byFamily'][number]['theme']) : 'goles',
            active: bool(f.active),
            thresholds: list(
              f.thresholds,
              (x) => {
                const threshold = prob01(x.threshold);
                const vn = fin(x.validationN);
                return threshold !== undefined && SOURCES.has(str(x.source))
                  ? {
                      source: x.source as NonNullable<ConfidencePick['source']>,
                      threshold,
                      goldThreshold: prob01(x.goldThreshold),
                      validationN: vn,
                      validationHits: fin(x.validationHits),
                      validationHitRate: vn !== undefined && vn > 0 ? prob01(x.validationHitRate) : undefined,
                    }
                  : undefined;
              },
              2,
            ),
            unpublished: list(
              f.unpublished,
              (x) => (SOURCES.has(str(x.source)) ? { source: x.source as NonNullable<ConfidencePick['source']>, n: Math.max(0, fin(x.n) ?? 0), hits: Math.max(0, fin(x.hits) ?? 0), hitRate: prob01(x.hitRate) } : undefined),
              2,
            ),
            excluded: optStr(f.excluded),
            threshold: prob01(f.threshold),
            picks: Math.max(n, fin(f.picks) ?? n),
            n,
            hits,
            hitRate: n > 0 ? prob01(f.hitRate) : undefined,
            wilsonLow: n > 0 ? prob01(f.wilsonLow) : undefined,
            wilsonHigh: n > 0 ? prob01(f.wilsonHigh) : undefined,
            avgFairOdds: (fin(f.avgFairOdds) ?? 0) >= 1 ? fin(f.avgFairOdds) : undefined,
            baseRate: prob01(f.baseRate),
            baseN: fin(f.baseN),
            lift: fin(f.lift) !== undefined && Math.abs(fin(f.lift)!) <= 1 ? fin(f.lift) : undefined,
            walkForward: isObj(f.walkForward) ? normRecord({ ...f.walkForward, from: '', to: '' }) : undefined,
            note: optStr(f.note),
          };
        },
        60,
      ),
      coverage: { picksPerDay: fin(cov.picksPerDay) ?? 0, picksPerMatchDay: fin(cov.picksPerMatchDay), matches: fin(cov.matches), matchesWithPick: fin(cov.matchesWithPick) },
      avgFairOdds: fin(t.avgFairOdds) ?? 0,
      avgProb: prob01(t.avgProb),
      roi,
      baseline: isObj(t.baseline) && optStr(t.baseline.label) ? (() => {
        const r = normRecord({ ...t.baseline, from: '', to: '' });
        return r ? { label: short(t.baseline.label, 200), picks: r.picks, n: r.n, hits: r.hits, hitRate: r.hitRate, wilsonLow: r.wilsonLow, wilsonHigh: r.wilsonHigh, matches: r.matches } : undefined;
      })() : undefined,
      expectedBaseRate: prob01(t.expectedBaseRate),
      lift: fin(t.lift) !== undefined && Math.abs(fin(t.lift)!) <= 1 ? fin(t.lift) : undefined,
      walkForward: isObj(t.walkForward) ? (() => {
        const w = t.walkForward as Obj;
        const r = normRecord(w);
        if (!r) return undefined;
        const wroi = isObj(w.roi) && fin(w.roi.bets) !== undefined && fin(w.roi.roi) !== undefined ? finKeys(w.roi, ['bets', 'roi', 'profit', 'hitRate', 'avgOdds', 'synthetic']) : undefined;
        return {
          ...r,
          folds: list(
            w.folds,
            (f) => {
              const fr = normRecord({ ...f, from: f.start, to: f.end });
              return fr && validDate(f.start) ? { start: str(f.start), end: validDate(f.end) ?? '', matches: fin(f.matches) ?? 0, picks: fr.picks, n: fr.n, hits: fr.hits, hitRate: fr.hitRate } : undefined;
            },
            24,
          ),
          roi: wroi,
        };
      })() : undefined,
      excluded: list(t.excluded, (x) => (optStr(x.family) && optStr(x.reason) ? { family: short(x.family, 60), label: short(x.label, 80) || short(x.family, 60), reason: short(x.reason, 600) } : undefined), 10),
    },
    rules: {
      ...finKeys(rules, ['level', 'targetRate', 'matches', 'active', 'unvalidated', 'maxPerMatch', 'minHitRate']),
      validation: isObj(rules.validation) && fin(rules.validation.minN) !== undefined ? { minN: fin(rules.validation.minN)!, minRate: prob01(rules.validation.minRate) ?? 0.8 } : undefined,
      from: validDate(rules.from) ?? '',
      to: validDate(rules.to) ?? '',
    },
    note: short(v.note, 1200),
  } as unknown as ConfidenceFile;
}

// ---------------------------------------------------------------------------
// Pronósticos del día (daily.json y HomeFile.daily)
// ---------------------------------------------------------------------------
const DAY_KEY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const dayKeyStr = (x: unknown): string | undefined => (typeof x === 'string' && DAY_KEY.test(x) && !Number.isNaN(Date.parse(`${x}T12:00:00Z`)) ? x : undefined);
/** Texto de una línea acotado (frases del análisis): sin saltos de línea ni espacios repetidos. */
const sentence = (x: unknown, max: number): string => short(typeof x === 'string' ? x.replace(/\s+/g, ' ') : x, max);

/**
 * Pick del apartado «Pronósticos del día». Más tolerante que normConfidencePick con los campos del histórico (las
 * categorías nuevas —tiros, faltas, jugadores— pueden no traerlos), pero igual de estricto con lo que se enseña:
 * probabilidad válida, selección con texto, categoría de la lista blanca y nunca el nivel 'plata'.
 */
export function normDailyPick(p: unknown): DailyPick | undefined {
  if (!isObj(p)) return undefined;
  const prob = prob01(p.prob);
  const selection = sentence(p.selection, 120);
  if (prob === undefined || prob <= 0 || !selection) return undefined;
  if (p.tier !== undefined && !TIERS.has(str(p.tier))) return undefined;
  const pl = isObj(p.player) && short(p.player.name, 80) ? p.player : undefined;
  const family = short(p.family, 40) || 'otro';
  const marketId = short(p.marketId, 60) || 'otro';
  const category: DailyCategory | undefined = isDailyCategory(p.category) ? p.category : inferDailyCategory(family, marketId, !!pl);
  if (!category) return undefined;
  const marketOdds = fin(p.marketOdds);
  const fair = fin(p.fairOdds);
  const hist = prob01(p.historicalHitRate);
  const ho = oosRecord(p.holdoutHitRate, p.holdoutN, p.holdoutWilsonLow, p.holdoutWilsonHigh);
  const va = oosRecord(p.validationHitRate, p.validationN, p.validationWilsonLow, p.validationWilsonHigh);
  const score = fin(p.score);
  const lift = fin(p.lift);
  const expMinutes = pl ? fin(pl.expMinutes) : undefined;
  return {
    family,
    marketId,
    market: sentence(p.market, 120) || 'Mercado',
    selection,
    prob,
    fairOdds: fair !== undefined && fair >= 1 ? fair : Math.min(1000, 1 / prob),
    marketOdds: marketOdds !== undefined && marketOdds > 1 ? marketOdds : undefined,
    oddsKind: p.oddsKind === 'directa' || p.oddsKind === 'sintetica' ? p.oddsKind : undefined,
    tier: 'oro',
    // sin histórico de ajuste no se inventa: 0 casos (la página solo enseña el récord fuera de muestra, con su n)
    historicalHitRate: hist ?? 0,
    historicalN: hist !== undefined ? Math.max(0, fin(p.historicalN) ?? 0) : 0,
    threshold: prob01(p.threshold),
    calibratedProb: prob01(p.calibratedProb),
    source: SOURCES.has(str(p.source)) ? (p.source as DailyPick['source']) : undefined,
    validationHitRate: va.rate,
    validationN: va.n,
    validationWilsonLow: va.lo,
    validationWilsonHigh: va.hi,
    holdoutHitRate: ho.rate,
    holdoutN: ho.n,
    holdoutWilsonLow: ho.lo,
    holdoutWilsonHigh: ho.hi,
    baseRate: prob01(p.baseRate),
    result: RESULTS.has(str(p.result)) ? (p.result as DailyPick['result']) : undefined,
    category,
    reason: sentence(p.reason, 280) || undefined,
    player: pl
      ? {
          id: short(pl.id, 20),
          name: short(pl.name, 80),
          short: short(pl.short, 40) || short(pl.name, 40),
          teamId: short(pl.teamId, 20),
          position: POSITIONS.has(str(pl.position)) ? str(pl.position) : undefined,
          expMinutes: expMinutes !== undefined && expMinutes >= 0 && expMinutes <= 130 ? expMinutes : undefined,
        }
      : undefined,
    score: score !== undefined ? Math.max(0, Math.min(100, score)) : undefined,
    // mejora sobre la tasa base: solo con validación propia (sin ella no hay de qué restar)
    lift: lift !== undefined && Math.abs(lift) <= 1 && va.rate !== undefined ? lift : undefined,
  };
}

/** Terna local / visitante / total de un valor esperado: finita y no negativa (el total se deriva si falta). */
function expectedTriple(x: unknown): { home: number; away: number; total: number } | undefined {
  if (!isObj(x)) return undefined;
  const home = fin(x.home);
  const away = fin(x.away);
  if (home === undefined || away === undefined || home < 0 || away < 0 || home > 200 || away > 200) return undefined;
  const total = fin(x.total);
  return { home, away, total: total !== undefined && total >= 0 && total <= 400 ? total : home + away };
}

const DAILY_MAX_PICKS = 8;
const DAILY_MAX_PER_CATEGORY = 2;

function normDailyMatch(v: Obj): DailyMatch | undefined {
  const match = normMatch(v.match);
  if (!match) return undefined;
  // como mucho 2 por categoría y 8 en total (lo que promete el contrato), sin selecciones repetidas
  const perCat = new Map<DailyCategory, number>();
  const seen = new Set<string>();
  const picks = list(v.picks, (p) => normDailyPick(p), 60).filter((p) => {
    const key = `${p.family}|${p.selection}`;
    const k = perCat.get(p.category) ?? 0;
    if (seen.has(key) || k >= DAILY_MAX_PER_CATEGORY) return false;
    seen.add(key);
    perCat.set(p.category, k + 1);
    return true;
  }).slice(0, DAILY_MAX_PICKS);
  if (!picks.length) return undefined;
  const e = isObj(v.expected) ? v.expected : {};
  const pr = match.prediction;
  const goals = expectedTriple(e.goals) ?? (pr && fin(pr.xgHome) !== undefined && fin(pr.xgAway) !== undefined ? expectedTriple({ home: pr.xgHome, away: pr.xgAway }) : undefined);
  const expected = {
    goals,
    shotsOnTarget: expectedTriple(e.shotsOnTarget),
    shots: expectedTriple(e.shots),
    corners: expectedTriple(e.corners),
    cards: expectedTriple(e.cards),
    fouls: expectedTriple(e.fouls),
  } as DailyExpected;
  return { match, picks, expected, analysis: strList(v.analysis, 40).map((s) => sentence(s, 320)).filter(Boolean).slice(0, 5) };
}

/** Combinada: todas sus patas deben ser válidas (si falla una, la probabilidad combinada ya no describe lo que se ve). */
function normDailyCombo(c: Obj, i: number): DailyCombo | undefined {
  const prob = prob01(c.prob);
  if (prob === undefined || prob <= 0 || !Array.isArray(c.legs) || c.legs.length < 2 || c.legs.length > 12) return undefined;
  const legs: DailyCombo['legs'] = [];
  const matches = new Set<string>();
  for (const l of c.legs as unknown[]) {
    if (!isObj(l)) return undefined;
    const pick = normDailyPick(l.pick);
    const matchId = short(l.matchId, 20);
    const home = short(l.home, 60);
    const away = short(l.away, 60);
    // patas de partidos DISTINTOS: dos selecciones del mismo partido no son independientes
    if (!pick || !matchId || !home || !away || matches.has(matchId)) return undefined;
    matches.add(matchId);
    legs.push({ matchId, home, away, compName: short(l.compName, 60), pick });
  }
  // el producto de probabilidades nunca supera a la de su pata menos probable
  const cap = Math.min(...legs.map((l) => Math.max(l.pick.prob, l.pick.calibratedProb ?? 0)));
  if (prob > cap + 0.005) return undefined;
  const fair = fin(c.fairOdds);
  const marketOdds = fin(c.marketOdds);
  const id = short(c.id, 24) || `combo-${i + 1}`;
  return {
    id,
    label: sentence(c.label, 60) || `Combinada ${id}`,
    legs,
    prob,
    fairOdds: fair !== undefined && fair >= 1 ? fair : Math.min(1000, 1 / prob),
    marketOdds: marketOdds !== undefined && marketOdds > 1 && legs.every((l) => l.pick.marketOdds !== undefined) ? marketOdds : undefined,
  };
}

function normDailyDay(d: Obj): DailyDay | undefined {
  const date = dayKeyStr(d.date);
  if (!date) return undefined;
  const ids = new Set<string>();
  const matches = list(d.matches, normDailyMatch, 200).filter((m) => (ids.has(m.match.id) ? false : (ids.add(m.match.id), true)));
  const inTop = new Set<string>();
  const top = list(
    d.top,
    (t) => {
      const matchId = str(t.matchId).trim();
      const pick = normDailyPick(t.pick);
      // uno por partido y solo de partidos del día (la fila necesita el partido para pintarse)
      if (!pick || !ids.has(matchId) || inTop.has(matchId)) return undefined;
      inTop.add(matchId);
      return { matchId, pick };
    },
    60,
  ).slice(0, 10);
  const c = isObj(d.counts) ? d.counts : {};
  const picks = matches.reduce((s, m) => s + m.picks.length, 0);
  return {
    date,
    matches,
    top,
    combos: list(d.combos, normDailyCombo, 12).slice(0, 3),
    // partidos y picks se cuentan sobre lo que realmente se muestra
    counts: { matches: matches.length, picks, matchesAnalyzed: Math.max(matches.length, Math.round(fin(c.matchesAnalyzed) ?? 0)) },
  };
}

function normDaily(v: Obj): DailyFile {
  const t = isObj(v.track) ? v.track : {};
  const dates = new Set<string>();
  const cats = new Set<DailyCategory>();
  const days = list(v.days, normDailyDay, 14)
    .filter((d) => (dates.has(d.date) ? false : (dates.add(d.date), true)))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 7);
  const categories = list(v.categories, (c) => (isDailyCategory(c.id) && !cats.has(c.id) ? (cats.add(c.id), { id: c.id, label: short(c.label, 24) || DAILY_CATEGORY_LABEL[c.id] }) : undefined), 20);
  const byCat = new Set<DailyCategory>();
  return {
    ...(v as object),
    days,
    categories: categories.length ? categories : DAILY_CATEGORIES.map((id) => ({ id, label: DAILY_CATEGORY_LABEL[id] })),
    track: {
      overall: normRecord(t.overall) ?? { picks: 0, n: 0, hits: 0, hitRate: 0, from: '', to: '' },
      byCategory: list(
        t.byCategory,
        (x) => {
          if (!isDailyCategory(x.category) || byCat.has(x.category)) return undefined;
          const r = normRecord({ ...x, from: '', to: '' });
          if (!r) return undefined;
          byCat.add(x.category);
          return { category: x.category, label: short(x.label, 24) || DAILY_CATEGORY_LABEL[x.category], baseRate: prob01(x.baseRate), picks: r.picks, n: r.n, hits: r.hits, hitRate: r.hitRate, wilsonLow: r.wilsonLow, wilsonHigh: r.wilsonHigh, voids: r.voids };
        },
        20,
      ),
      combos: list(
        t.combos,
        (x) => {
          const id = short(x.id, 24);
          const daysN = fin(x.days);
          const hits = fin(x.hits);
          if (!id || daysN === undefined || hits === undefined || daysN <= 0 || hits < 0 || hits > daysN) return undefined;
          const avgFair = fin(x.avgFairOdds);
          const avgLegs = fin(x.avgLegs);
          return {
            id,
            label: short(x.label, 60) || id,
            days: Math.round(daysN),
            hits: Math.round(hits),
            // el acierto es siempre aciertos / días (no se confía en una cifra que no cuadre con sus cuentas)
            hitRate: hits / daysN,
            avgLegs: avgLegs !== undefined && avgLegs >= 1 ? avgLegs : undefined,
            avgFairOdds: avgFair !== undefined && avgFair >= 1 ? avgFair : undefined,
          };
        },
        6,
      ),
      baseline: isObj(t.baseline) && optStr(t.baseline.label) ? (() => {
        const r = normRecord({ ...t.baseline, from: '', to: '' });
        return r && r.n > 0 ? { label: short(t.baseline.label, 200), picks: r.picks, n: r.n, hits: r.hits, hitRate: r.hitRate, wilsonLow: r.wilsonLow, wilsonHigh: r.wilsonHigh, matches: r.matches } : undefined;
      })() : undefined,
    },
    note: short(v.note, 1200),
  } as unknown as DailyFile;
}

/** Bloque «Pronósticos del día» de la portada: sin fecha válida o sin picks válidos, no se muestra. */
function normHomeDaily(x: unknown): HomeFile['daily'] {
  if (!isObj(x)) return undefined;
  const date = dayKeyStr(x.date);
  const seen = new Set<string>();
  const top = list(
    x.top,
    (b) => {
      const match = normMatch(b.match);
      const pick = normDailyPick(b.pick);
      if (!match || !pick || seen.has(match.id)) return undefined;
      seen.add(match.id);
      return { match, pick };
    },
    8,
  );
  if (!date || !top.length) return undefined;
  return { date, matches: Math.max(top.length, Math.round(fin(x.matches) ?? 0)), picks: Math.max(top.length, Math.round(fin(x.picks) ?? 0)), top };
}

// ---------------------------------------------------------------------------
// Cuota alta 6+ (longshots.json y HomeFile.longshot)
// ---------------------------------------------------------------------------
/** Cuota decimal válida (> 1) y acotada a 10.000: un valor absurdo no llega a la pantalla. */
const oddsVal = (x: unknown): number | undefined => {
  const v = fin(x);
  return v !== undefined && v > 1 && v <= 10_000 ? v : undefined;
};
const LONGSHOT_MAX_LEGS = 6;
const LONGSHOT_MAX_BETS_PER_DAY = 24;
const LONGSHOT_MAX_PER_KIND = 8;

/** Pata de una apuesta de cuota alta: partido identificable, equipos, selección con texto y probabilidad en (0, 1). */
export function normLongshotLeg(l: unknown): LongshotLeg | undefined {
  if (!isObj(l)) return undefined;
  const matchId = short(l.matchId, 20);
  const home = normTeamRef(l.home);
  const away = normTeamRef(l.away);
  const selection = sentence(l.selection, 120);
  const prob = prob01(l.prob);
  if (!matchId || !home || !away || !selection || prob === undefined || prob <= 0 || prob >= 1) return undefined;
  const fair = fin(l.fairOdds);
  const compId = str(l.compId).trim();
  const pl = isObj(l.player) && short(l.player.name, 80) ? l.player : undefined;
  return {
    matchId,
    compId: COMP_ID.test(compId) ? compId : '',
    compName: sentence(l.compName, 60),
    date: validDate(l.date) ?? '',
    home,
    away,
    market: sentence(l.market, 120) || 'Mercado',
    selection,
    prob,
    // la cuota justa es 1 / probabilidad: si la publicada no cuadra (±2 %), se recalcula
    fairOdds: fair !== undefined && fair >= 1 && Math.abs(fair * prob - 1) <= 0.02 ? fair : Math.min(10_000, 1 / prob),
    marketOdds: oddsVal(l.marketOdds),
    category: isDailyCategory(l.category) ? l.category : undefined,
    player: pl ? { id: short(pl.id, 20), name: short(pl.name, 80), short: short(pl.short, 40) || short(pl.name, 40), teamId: short(pl.teamId, 20) } : undefined,
    result: RESULTS.has(str(l.result)) ? (l.result as LongshotLeg['result']) : undefined,
  };
}

/**
 * Apuesta de cuota alta. Se descarta entera si alguna pata no es válida, si una combinada repite partido (sus patas
 * no serían independientes), si el número de patas no corresponde al tipo o si su probabilidad supera la de su pata
 * menos probable. Las cifras derivadas (cuota justa, cuota mostrada, valor esperado, «1 de cada N») se recalculan si
 * no cuadran con la probabilidad y la cuota de la casa: lo que se ve siempre es coherente.
 */
export function normLongshotBet(b: unknown, i = 0): LongshotBet | undefined {
  if (!isObj(b) || !Array.isArray(b.legs) || b.legs.length < 1 || b.legs.length > LONGSHOT_MAX_LEGS) return undefined;
  const legs: LongshotLeg[] = [];
  const matches = new Set<string>();
  for (const raw of b.legs as unknown[]) {
    const leg = normLongshotLeg(raw);
    if (!leg || matches.has(leg.matchId)) return undefined;
    matches.add(leg.matchId);
    legs.push(leg);
  }
  // tipo de la lista blanca; uno desconocido se deduce del número de patas (nunca se inventa «sorpresa» o «goleador»)
  const kind: LongshotKind = isLongshotKind(b.kind) ? b.kind : legs.length > 1 ? 'combinada' : 'otro';
  if (kind === 'combinada' ? legs.length < 2 : legs.length !== 1) return undefined;
  const prob = prob01(b.prob);
  if (prob === undefined || prob <= 0 || prob >= 1) return undefined;
  if (prob > Math.min(...legs.map((l) => l.prob)) + 0.005) return undefined;
  const fair = fin(b.fairOdds);
  const fairOdds = fair !== undefined && fair >= 1 && Math.abs(fair * prob - 1) <= 0.02 ? fair : Math.min(10_000, 1 / prob);
  // cuota de la casa de la apuesta entera solo si TODAS las patas tienen la suya
  const marketOdds = legs.every((l) => l.marketOdds !== undefined) ? oddsVal(b.marketOdds) : undefined;
  const shown = fin(b.displayOdds);
  const expectedShown = marketOdds ?? fairOdds;
  const displayOdds = shown !== undefined && shown > 1 && Math.abs(shown / expectedShown - 1) <= 0.01 ? shown : expectedShown;
  const evRaw = fin(b.ev);
  const evCalc = marketOdds !== undefined ? prob * marketOdds - 1 : undefined;
  const ev = evCalc === undefined ? undefined : evRaw !== undefined && Math.abs(evRaw - evCalc) <= 0.01 ? evRaw : evCalc;
  const score = fin(b.score);
  const id = short(b.id, 60) || `${kind}-${i + 1}`;
  return {
    id,
    kind,
    label: sentence(b.label, 90) || (kind === 'combinada' ? `Combinada de ${legs.length} partidos` : LONGSHOT_KIND_LABEL[kind]),
    legs,
    prob,
    fairOdds,
    marketOdds,
    displayOdds,
    ev,
    oneIn: oneIn(prob),
    score: score !== undefined ? Math.max(0, Math.min(100, score)) : 0,
    reason: sentence(b.reason, 320),
    result: RESULTS.has(str(b.result)) ? (b.result as LongshotBet['result']) : undefined,
  };
}

function normLongshotDay(d: Obj, minOdds: number): LongshotDay | undefined {
  const date = dayKeyStr(d.date);
  if (!date) return undefined;
  const ids = new Set<string>();
  const perKind = new Map<LongshotKind, number>();
  const bets = list(d.bets, (b, i) => normLongshotBet(b, i), 200)
    .filter((b) => {
      // el apartado es de cuota mínima `minOdds`: lo que no llega no se enseña bajo ese título
      if (b.displayOdds < minOdds - 0.005 || ids.has(b.id)) return false;
      const k = perKind.get(b.kind) ?? 0;
      if (k >= LONGSHOT_MAX_PER_KIND) return false;
      ids.add(b.id);
      perKind.set(b.kind, k + 1);
      return true;
    })
    .slice(0, LONGSHOT_MAX_BETS_PER_DAY);
  return { date, bets };
}

/** Historial fuera de muestra de un tipo: cuentas coherentes (aciertos ≤ apuestas), acierto en [0, 1] y ROI cuadrado. */
export function normLongshotRecord(x: unknown): LongshotRecord | undefined {
  if (!isObj(x) || !isLongshotKind(x.kind)) return undefined;
  const bets = fin(x.bets);
  const hits = fin(x.hits);
  if (bets === undefined || hits === undefined || bets < 0 || hits < 0 || hits > bets || bets > 1e7) return undefined;
  const nBets = Math.round(bets);
  const nHits = Math.round(hits);
  // nulas (el jugador no juega): no cuentan en el acierto; resueltas = apuestas − nulas ≥ aciertos
  const v = fin(x.voids);
  const voids = v !== undefined && v >= 0 && nBets - Math.round(v) >= nHits ? Math.round(v) : undefined;
  // acierto = aciertos / resueltas. Con nulas conocidas se calcula siempre así; sin ellas, el publicado se acepta si es
  // ≥ aciertos / apuestas (si no cuadra, aciertos / apuestas)
  const rate = prob01(x.hitRate);
  const floor = nBets > 0 ? nHits / nBets : 0;
  const settled = voids !== undefined ? nBets - voids : undefined;
  const hitRate =
    settled !== undefined ? (settled > 0 ? nHits / settled : 0) : rate !== undefined && rate + 1e-9 >= floor && (nHits === 0 ? rate === 0 : true) ? rate : floor;
  const lo = prob01(x.wilsonLow);
  const hi = prob01(x.wilsonHigh);
  const ci = lo !== undefined && hi !== undefined && lo <= hitRate + 1e-9 && hitRate <= hi + 1e-9;
  const avg = fin(x.avgOdds);
  const roiObj = isObj(x.roi) ? x.roi : undefined;
  let roi: LongshotRecord['roi'];
  if (roiObj) {
    const rb = fin(roiObj.bets);
    const staked = fin(roiObj.staked);
    const profit = fin(roiObj.profit);
    // no se puede perder más de lo apostado; el ROI es siempre beneficio / apostado (no se confía en otra cifra)
    if (rb !== undefined && staked !== undefined && profit !== undefined && rb >= 1 && rb <= nBets && staked > 0 && profit >= -staked - 1e-6 && profit <= staked * 10_000) {
      roi = { bets: Math.round(rb), staked, profit, roi: profit / staked };
    }
  }
  const streak = fin(x.longestLosingStreak);
  return {
    kind: x.kind,
    label: sentence(x.label, 40) || LONGSHOT_KIND_LABEL[x.kind],
    bets: nBets,
    hits: nHits,
    hitRate,
    wilsonLow: ci ? lo : undefined,
    wilsonHigh: ci ? hi : undefined,
    expectedHitRate: prob01(x.expectedHitRate) as number,
    avgOdds: avg !== undefined && avg > 1 && avg <= 10_000 ? avg : (undefined as unknown as number),
    roi,
    longestLosingStreak: streak !== undefined && streak >= 0 && streak <= nBets ? Math.round(streak) : undefined,
    voids,
    excluded: sentence(x.excluded, 240) || undefined,
  };
}

/** Tramo de calibración válido (probabilidades en [0, 1], from < to, n ≥ 0). */
function normCalibrationBin(x: Obj) {
  const from = prob01(x.from);
  const to = prob01(x.to);
  const predicted = prob01(x.predicted);
  const observed = prob01(x.observed);
  const n = fin(x.n);
  if (from === undefined || to === undefined || predicted === undefined || observed === undefined || n === undefined || from >= to || n < 0) return undefined;
  return { from, to, predicted, observed, n: Math.round(n) };
}

function normLongshots(v: Obj): LongshotFile {
  const mo = fin(v.minOdds);
  const minOdds = mo !== undefined && mo >= 1.5 && mo <= 1000 ? mo : LONGSHOT_DEFAULT_MIN_ODDS;
  const t = isObj(v.track) ? v.track : {};
  const dates = new Set<string>();
  const days = list(v.days, (d) => normLongshotDay(d, minOdds), 14)
    .filter((d) => (dates.has(d.date) ? false : (dates.add(d.date), true)))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 7);
  const kinds = new Set<LongshotKind>();
  const byKind = list(t.byKind, (x) => {
    const r = normLongshotRecord(x);
    if (!r || kinds.has(r.kind)) return undefined;
    kinds.add(r.kind);
    return r;
  }, 20).sort((a, b) => LONGSHOT_KINDS.indexOf(a.kind) - LONGSHOT_KINDS.indexOf(b.kind));
  return {
    ...(v as object),
    minOdds,
    days,
    track: {
      from: validDate(t.from) ?? '',
      to: validDate(t.to) ?? '',
      byKind,
      calibration: list(t.calibration, normCalibrationBin, 40).sort((a, b) => a.from - b.from),
    },
    note: short(v.note, 1200),
  } as unknown as LongshotFile;
}

/** Bloque «Cuota alta 6+» de la portada: sin fecha válida o sin una apuesta válida que enseñar, no se muestra. */
function normHomeLongshot(x: unknown): HomeFile['longshot'] {
  if (!isObj(x)) return undefined;
  const date = dayKeyStr(x.date);
  const best = normLongshotBet(x.best);
  if (!date || !best) return undefined;
  const bets = fin(x.bets);
  return { date, bets: Math.max(1, Math.round(bets !== undefined && bets >= 0 && bets <= 1000 ? bets : 1)), best };
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
  if (path === 'confidence.json') return normConfidence(value);
  if (path === 'daily.json') return normDaily(value);
  if (path === 'longshots.json') return normLongshots(value);
  let m = /^competitions\/([a-z0-9-]{1,40})\.json$/.exec(path);
  if (m) return normCompetition(value, m[1]);
  m = /^matches\/[0-9]+\.json$/.exec(path);
  if (m) return normMatchFile(value);
  m = /^teams\/[0-9]+\.json$/.exec(path);
  if (m) return normTeamFile(value);
  return value;
}
