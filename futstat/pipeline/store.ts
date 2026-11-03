/**
 * Incremental persistence of normalized data: data-store/<compId>.json (compact JSON).
 *
 *  - loadStore / saveStore (synchronous). Writes are atomic (temp file + fsync + rename) and the previous valid
 *    file is kept as <compId>.json.bak. Loading never throws: a corrupt/unexpected file is recovered from the
 *    .bak (or an empty store is used) with a warning, and malformed records are dropped.
 *  - storeDirBytes / STORE_MAX_BYTES: disk guard (fetch stops downloading summaries above ~600 MB)
 *  - mergeMatches: upsert by id keeping summary-derived fields and pre-match odds history
 *  - upsertPlayerLines: upsert by (matchId, playerId)
 */
import fs from 'node:fs';
import path from 'node:path';
import { COMPETITION_BY_ID, COMPETITIONS, STORE_DIR } from './config';
import type { CompetitionStore, MatchRecord, PlayerLine, TeamMatchStats } from './types';
import type { OddsSnapshot } from '../src/types/data';
import { hasAnyPrice, stripImplausibleOdds } from './oddsGuard';

/** Matches (and player lines) older than this are dropped from the store. */
export const MAX_AGE_DAYS = 900;
/** Max pre-match odds snapshots kept per match. */
export const MAX_ODDS_HISTORY = 30;
/** Disk guard: above this total size of data-store/ the fetch stops downloading match summaries. */
export const STORE_MAX_BYTES = 600 * 1024 * 1024;

const DAY_MS = 86_400_000;

export function storePath(compId: string, dir: string = STORE_DIR): string {
  return path.join(dir, `${compId}.json`);
}

export function emptyStore(compId: string, slug?: string): CompetitionStore {
  return {
    compId,
    slug: slug ?? COMPETITION_BY_ID.get(compId)?.slug ?? '',
    updatedAt: new Date(0).toISOString(),
    matches: [],
    players: [],
    standings: [],
  };
}

export function backupPath(compId: string, dir: string = STORE_DIR): string {
  return `${storePath(compId, dir)}.bak`;
}

/** Where loadStore got the data from (for logs/tests). */
export type StoreSource = 'file' | 'backup' | 'empty';

export interface LoadStoreOptions {
  /** receives warnings (default console.warn) */
  warn?: (msg: string) => void;
}

/** Files known to hold a valid store (loaded fine or written by us): they may become the next .bak. */
const verifiedFiles = new Set<string>();
const lastSource = new Map<string, StoreSource>();

/** Source of the last loadStore of a competition. */
export function lastLoadSource(compId: string, dir: string = STORE_DIR): StoreSource | undefined {
  return lastSource.get(storePath(compId, dir));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Deep validation of stored records
// ---------------------------------------------------------------------------
// The store survives between runs (and between code versions, through the CI cache). A single malformed record
// (a number where a name should be, null stats, a string as events, "71" as goals, an unparsable date…) used to
// crash or block every later build. Every record is therefore checked field by field when loading: fixable fields
// are dropped (optional data) and records without their essentials are discarded with a warning.
const STATUSES = new Set<MatchRecord['status']>(['scheduled', 'live', 'finished', 'postponed', 'cancelled']);
const EVENT_TYPES = new Set<NonNullable<MatchRecord['events']>[number]['type']>(['goal', 'own-goal', 'penalty', 'yellow', 'red', 'sub']);
const POSITIONS = new Set<PlayerLine['position']>(['G', 'D', 'M', 'F', '?']);
const TEAM_STAT_KEYS: (keyof TeamMatchStats)[] = [
  'goals', 'shots', 'shotsOnTarget', 'corners', 'fouls', 'yellow', 'red', 'offsides', 'possession', 'saves', 'passes',
  'passPct', 'crosses', 'tackles', 'interceptions', 'clearances', 'blockedShots',
];
const LINE_COUNT_KEYS = ['minutes', 'goals', 'assists', 'shots', 'shotsOnTarget', 'yellow', 'red', 'foulsCommitted', 'foulsSuffered', 'offsides', 'ownGoals'] as const;
const ODDS_NUM_KEYS: (keyof OddsSnapshot)[] = [
  'home', 'draw', 'away', 'homeOpen', 'drawOpen', 'awayOpen', 'totalLine', 'over', 'under', 'overOpen', 'underOpen',
  'spreadLine', 'spreadHome', 'spreadAway', 'margin',
];

const nonEmpty = (x: unknown, max = 200): string | undefined => (typeof x === 'string' && x.trim() !== '' && x.length <= max ? x : undefined);
const optString = (x: unknown, max = 200): string | undefined => (typeof x === 'string' && x.length <= max ? x : undefined);
/** finite number in [lo, hi] */
const num = (x: unknown, lo: number, hi: number): number | undefined => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : undefined);
const validDate = (x: unknown): string | undefined => (typeof x === 'string' && x.length <= 40 && Number.isFinite(Date.parse(x)) ? x : undefined);

/** Copy `src[k]` into `out[k]` only when it passes `check`. */
function setIf<T extends object>(out: T, k: keyof T, v: unknown): void {
  if (v !== undefined) (out as Obj)[k as string] = v;
}

function sanitizeTeam(t: unknown): MatchRecord['home'] | undefined {
  if (!isObj(t)) return undefined;
  const id = nonEmpty(t.id, 40);
  const name = nonEmpty(t.name);
  if (!id || !name) return undefined;
  const team: MatchRecord['home'] = { id, name, short: nonEmpty(t.short) ?? name, abbr: nonEmpty(t.abbr, 20) ?? name.slice(0, 3).toUpperCase() };
  setIf(team, 'logo', optString(t.logo, 500));
  setIf(team, 'color', optString(t.color, 20));
  return team;
}

function sanitizeTeamStats(x: unknown): TeamMatchStats | undefined {
  if (!isObj(x)) return undefined;
  const out = {} as TeamMatchStats;
  for (const k of TEAM_STAT_KEYS) setIf(out, k, num(x[k], 0, k === 'passes' ? 5000 : 1000));
  if (out.goals === undefined) return undefined;
  return out;
}

/** Odds snapshot: decimal prices in (1, 1000], finite lines; anything else is dropped. */
export function sanitizeOdds(x: unknown): OddsSnapshot | undefined {
  if (!isObj(x)) return undefined;
  const out: OddsSnapshot = { provider: nonEmpty(x.provider, 60) ?? 'Casa de apuestas' };
  for (const k of ODDS_NUM_KEYS) setIf(out, k, num(x[k], -1000, 1000));
  setIf(out, 'capturedAt', validDate(x.capturedAt));
  // prices saved before the plausibility guard existed (or by a buggy version): same rule as for fresh data
  stripImplausibleOdds(out);
  return hasAnyPrice(out) ? out : undefined;
}

/** A stored match with every field checked (undefined = record unusable: discard it). */
export function sanitizeMatchRecord(x: unknown, compId: string): MatchRecord | undefined {
  if (!isObj(x)) return undefined;
  const id = nonEmpty(x.id, 40);
  const date = validDate(x.date);
  const status = typeof x.status === 'string' && STATUSES.has(x.status as MatchRecord['status']) ? (x.status as MatchRecord['status']) : undefined;
  const home = sanitizeTeam(x.home);
  const away = sanitizeTeam(x.away);
  if (!id || !date || !status || !home || !away) return undefined;
  const season = num(x.season, 1900, 3000) ?? new Date(Date.parse(date)).getUTCFullYear();
  const m: MatchRecord = { id, compId: nonEmpty(x.compId, 40) ?? compId, season, currentSeason: x.currentSeason === true, date, status, home, away };
  setIf(m, 'statusDetail', optString(x.statusDetail, 80));
  setIf(m, 'round', optString(x.round, 120));
  setIf(m, 'venue', optString(x.venue, 200));
  if (typeof x.neutral === 'boolean') m.neutral = x.neutral;
  if (isObj(x.score)) {
    const sh = num(x.score.home, 0, 99);
    const sa = num(x.score.away, 0, 99);
    if (sh !== undefined && sa !== undefined) {
      const score: NonNullable<MatchRecord['score']> = { home: sh, away: sa };
      for (const k of ['htHome', 'htAway', 'penHome', 'penAway'] as const) setIf(score, k, num(x.score[k], 0, 99));
      m.score = score;
    }
  }
  // a finished/live match without a valid score is not usable by the models: discard it
  if ((status === 'finished' || status === 'live') && !m.score) return undefined;
  if (isObj(x.stats)) {
    const h = sanitizeTeamStats(x.stats.home);
    const a = sanitizeTeamStats(x.stats.away);
    if (h && a) m.stats = { home: h, away: a };
  }
  if (Array.isArray(x.events)) {
    const events = x.events.flatMap((e): NonNullable<MatchRecord['events']> => {
      if (!isObj(e) || !EVENT_TYPES.has(e.type as never) || !nonEmpty(e.teamId, 40)) return [];
      const minute = num(e.minute, 0, 200);
      if (minute === undefined) return [];
      const ev: NonNullable<MatchRecord['events']>[number] = { minute, clock: optString(e.clock, 20) ?? `${minute}'`, type: e.type as never, teamId: e.teamId as string };
      setIf(ev, 'playerId', nonEmpty(e.playerId, 40));
      setIf(ev, 'player', nonEmpty(e.player));
      setIf(ev, 'playerOutId', nonEmpty(e.playerOutId, 40));
      return [ev];
    });
    if (events.length) m.events = events;
  }
  for (const k of ['homeForm', 'awayForm'] as const) if (typeof x[k] === 'string' && /^[WDL]{0,10}$/.test(x[k] as string)) m[k] = x[k] as string;
  setIf(m, 'odds', sanitizeOdds(x.odds));
  if (Array.isArray(x.oddsHistory)) {
    const h = x.oddsHistory.map(sanitizeOdds).filter((o): o is OddsSnapshot => !!o).slice(-MAX_ODDS_HISTORY);
    if (h.length) m.oddsHistory = h;
  }
  if (typeof x.summaryFetched === 'boolean') m.summaryFetched = x.summaryFetched;
  setIf(m, 'summaryAttempts', num(x.summaryAttempts, 0, 1000));
  setIf(m, 'summaryRetryAt', validDate(x.summaryRetryAt));
  setIf(m, 'downgradeSeen', num(x.downgradeSeen, 0, 1000));
  return m;
}

/** A stored player line with every field checked (undefined = discard). Missing counters (older schema) count as 0. */
export function sanitizePlayerLine(x: unknown): PlayerLine | undefined {
  if (!isObj(x)) return undefined;
  const matchId = nonEmpty(x.matchId, 40);
  const playerId = nonEmpty(x.playerId, 40);
  const teamId = nonEmpty(x.teamId, 40);
  const date = validDate(x.date);
  const name = nonEmpty(x.name);
  if (!matchId || !playerId || !teamId || !date || !name) return undefined;
  const counts = {} as Record<(typeof LINE_COUNT_KEYS)[number], number>;
  for (const k of LINE_COUNT_KEYS) {
    if (x[k] === undefined) counts[k] = 0;
    else {
      const v = num(x[k], 0, k === 'minutes' ? 200 : 99);
      if (v === undefined) return undefined; // "71", -100, NaN…: the line is corrupt
      counts[k] = v;
    }
  }
  const line: PlayerLine = {
    matchId,
    compId: typeof x.compId === 'string' ? x.compId : '',
    date,
    teamId,
    opponentId: typeof x.opponentId === 'string' ? x.opponentId : '',
    isHome: x.isHome === true,
    playerId,
    name,
    short: nonEmpty(x.short) ?? name,
    position: POSITIONS.has(x.position as PlayerLine['position']) ? (x.position as PlayerLine['position']) : '?',
    starter: x.starter === true,
    ...counts,
  };
  setIf(line, 'saves', num(x.saves, 0, 99));
  setIf(line, 'goalsConceded', num(x.goalsConceded, 0, 99));
  return line;
}

function sanitizeStandingGroup(g: unknown): CompetitionStore['standings'][number] | undefined {
  if (!isObj(g) || !Array.isArray(g.rows)) return undefined;
  const rows = g.rows.flatMap((r): CompetitionStore['standings'][number]['rows'] => {
    if (!isObj(r)) return [];
    const team = sanitizeTeam(r.team);
    if (!team) return [];
    const n = (k: string, lo = 0, hi = 1000) => num(r[k], lo, hi);
    const vals = { rank: n('rank', 0, 1000), played: n('played'), won: n('won'), drawn: n('drawn'), lost: n('lost'), gf: n('gf'), ga: n('ga'), gd: n('gd', -1000, 1000), points: n('points', -100, 1000) };
    if (Object.values(vals).some((v) => v === undefined)) return [];
    const row = { ...(vals as Record<keyof typeof vals, number>), team } as CompetitionStore['standings'][number]['rows'][number];
    if (typeof r.form === 'string' && /^[WDL]{0,10}$/.test(r.form)) row.form = r.form;
    if (isObj(r.note) && nonEmpty(r.note.label) && typeof r.note.color === 'string') row.note = { label: r.note.label as string, color: r.note.color };
    return [row];
  });
  return rows.length ? { name: nonEmpty(g.name) ?? '', rows } : undefined;
}

/**
 * Parse and validate a store file. Returns undefined when the file is unreadable, not JSON or not a store
 * (object with an array of matches). Malformed records are dropped (counted in `dropped`).
 */
export function readStoreFile(file: string, compId: string): { store: CompetitionStore; dropped: number } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isObj(raw) || !Array.isArray(raw.matches)) return undefined;
  if (typeof raw.compId === 'string' && raw.compId !== compId) return undefined;
  const r = raw as Partial<CompetitionStore>;
  const matches = (r.matches ?? []).map((m) => sanitizeMatchRecord(m, compId)).filter((m): m is MatchRecord => !!m);
  const players = Array.isArray(r.players) ? r.players.map(sanitizePlayerLine).filter((p): p is PlayerLine => !!p) : [];
  const standings = Array.isArray(r.standings) ? r.standings.map(sanitizeStandingGroup).filter((g): g is CompetitionStore['standings'][number] => !!g) : [];
  const dropped =
    (r.matches?.length ?? 0) - matches.length + (Array.isArray(r.players) ? r.players.length - players.length : 0) +
    (Array.isArray(r.standings) ? r.standings.length - standings.length : 0);
  const base = emptyStore(compId, typeof r.slug === 'string' ? r.slug : undefined);
  const store: CompetitionStore = {
    ...base,
    compId,
    slug: typeof r.slug === 'string' && r.slug ? r.slug : base.slug,
    updatedAt: validDate(r.updatedAt) ?? base.updatedAt,
    matches,
    players,
    standings,
  };
  setIf(store, 'fetchedAt', validDate(r.fetchedAt));
  if (isObj(r.league)) {
    const l = r.league;
    const league: NonNullable<CompetitionStore['league']> = {};
    setIf(league, 'name', optString(l.name));
    setIf(league, 'logo', optString(l.logo, 500));
    setIf(league, 'logoDark', optString(l.logoDark, 500));
    setIf(league, 'seasonYear', num(l.seasonYear, 1900, 3000));
    setIf(league, 'seasonLabel', optString(l.seasonLabel, 40));
    setIf(league, 'seasonStart', validDate(l.seasonStart));
    setIf(league, 'seasonEnd', validDate(l.seasonEnd));
    store.league = league;
  }
  return { store, dropped };
}

/**
 * Load data-store/<compId>.json. Never throws:
 *  - missing file → empty store (or the .bak if only the backup exists, e.g. after a crash);
 *  - corrupt/unexpected file → the .bak copy (last valid store) with a warning; if that fails too, empty store.
 */
export function loadStore(compId: string, dir: string = STORE_DIR, opts: LoadStoreOptions = {}): CompetitionStore {
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));
  const file = storePath(compId, dir);
  const bak = backupPath(compId, dir);
  const hasFile = fs.existsSync(file);
  if (hasFile) {
    const r = readStoreFile(file, compId);
    if (r) {
      if (r.dropped) warn(`[${compId}] aviso: ${r.dropped} registros mal formados descartados al cargar el almacén`);
      verifiedFiles.add(file);
      lastSource.set(file, 'file');
      return r.store;
    }
    verifiedFiles.delete(file);
  }
  if (fs.existsSync(bak)) {
    const r = readStoreFile(bak, compId);
    if (r) {
      if (hasFile) warn(`[${compId}] AVISO: ${path.basename(file)} está dañado o tiene una forma inesperada; se recupera la copia de seguridad ${path.basename(bak)}`);
      lastSource.set(file, 'backup');
      return r.store;
    }
    warn(`[${compId}] AVISO: la copia de seguridad ${path.basename(bak)} también está dañada`);
  }
  if (hasFile) warn(`[${compId}] AVISO: ${path.basename(file)} está dañado y no hay copia válida; se parte de un almacén vacío`);
  lastSource.set(file, 'empty');
  return emptyStore(compId);
}

/** Load every existing store of the configured competitions (missing files are skipped). Never throws. */
export function loadAllStores(dir: string = STORE_DIR, opts: LoadStoreOptions = {}): CompetitionStore[] {
  return COMPETITIONS.filter((c) => fs.existsSync(storePath(c.id, dir)) || fs.existsSync(backupPath(c.id, dir)))
    .map((c) => loadStore(c.id, dir, opts))
    .filter((s) => s.matches.length > 0 || s.standings.length > 0);
}

/**
 * Write the store as compact JSON (atomic: temp file + fsync + rename). Before replacing the file, the current
 * one is kept as <compId>.json.bak when it is a valid store (never a corrupt one). Sets `updatedAt` to now.
 * On any error the temp file is removed and the previous files stay untouched.
 */
export function saveStore(store: CompetitionStore, dir: string = STORE_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  store.updatedAt = new Date().toISOString();
  const file = storePath(store.compId, dir);
  const bak = backupPath(store.compId, dir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const body = JSON.stringify(store);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(file) && (verifiedFiles.has(file) || readStoreFile(file, store.compId))) {
      const bakTmp = `${bak}.${process.pid}.tmp`;
      fs.copyFileSync(file, bakTmp);
      fs.renameSync(bakTmp, bak);
    }
    fs.renameSync(tmp, file);
    verifiedFiles.add(file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Remove temp files left by an interrupted save (`<compId>.json.<pid>.tmp`, `<compId>.json.bak.<pid>.tmp`) older than
 * `maxAgeMs` (default 1 h: never the file another process is writing right now). They would otherwise stay forever,
 * count in storeDirBytes and travel in the CI cache. Returns the names removed.
 */
export function cleanStaleTmp(dir: string = STORE_DIR, maxAgeMs = 3_600_000, nowMs = Date.now()): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const f of names) {
    if (!/\.json(\.bak)?\.\d+\.tmp$/.test(f)) continue;
    const file = path.join(dir, f);
    try {
      const st = fs.lstatSync(file);
      if (st.isFile() && nowMs - st.mtimeMs > maxAgeMs) {
        fs.rmSync(file, { force: true });
        removed.push(f);
      }
    } catch {
      // removed meanwhile
    }
  }
  return removed;
}

/** Total bytes of the store directory (files only, non-recursive). 0 if it does not exist. */
export function storeDirBytes(dir: string = STORE_DIR): number {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, f));
        if (st.isFile()) total += st.size;
      } catch {
        // file removed meanwhile
      }
    }
  } catch {
    return 0;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Odds history
// ---------------------------------------------------------------------------
const ODDS_KEYS: (keyof OddsSnapshot)[] = [
  'provider', 'home', 'draw', 'away', 'totalLine', 'over', 'under', 'spreadLine', 'spreadHome', 'spreadAway',
];

/** true when any price/line differs (capture time and opening prices are ignored). */
export function oddsChanged(a: OddsSnapshot | undefined, b: OddsSnapshot | undefined): boolean {
  if (!a || !b) return a !== b;
  return ODDS_KEYS.some((k) => a[k] !== b[k]);
}

function appendOddsHistory(history: OddsSnapshot[] | undefined, snap: OddsSnapshot): OddsSnapshot[] {
  const h = history ? [...history] : [];
  if (h.length === 0 || oddsChanged(h[h.length - 1], snap)) h.push(snap);
  return h.length > MAX_ODDS_HISTORY ? h.slice(h.length - MAX_ODDS_HISTORY) : h;
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------
function mergeTeamStats(prev: TeamMatchStats | undefined, inc: TeamMatchStats | undefined): TeamMatchStats | undefined {
  if (!prev) return inc;
  if (!inc) return prev;
  const out: TeamMatchStats = { ...prev };
  for (const [k, v] of Object.entries(inc) as [keyof TeamMatchStats, number | undefined][]) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Runs in a row in which ESPN must report a finished match (with a score) as not played before the store accepts it.
 * A one-off scoreboard glitch (finished → "pre") would otherwise wipe score, stats, events and the summary flag, and
 * matches older than SUMMARY_LOOKBACK_DAYS would never get their summary back.
 */
export const DOWNGRADE_CONFIRMATIONS = 3;

function mergeOne(prev: MatchRecord, inc: MatchRecord): MatchRecord {
  if (prev.status === 'finished' && prev.score && (inc.status === 'scheduled' || inc.status === 'postponed' || inc.status === 'cancelled')) {
    const seen = (prev.downgradeSeen ?? 0) + 1;
    if (seen < DOWNGRADE_CONFIRMATIONS) return { ...prev, downgradeSeen: seen };
    // confirmed by several consecutive runs: ESPN really reopened / cancelled it → accept the new state below
  }
  // scoreboard-owned fields come from the incoming record
  const m: MatchRecord = { ...inc };
  delete m.downgradeSeen;
  const played = inc.status === 'finished' || inc.status === 'live';
  const keepSummary = prev.summaryFetched === true && inc.status === 'finished';

  if (m.neutral === undefined && prev.neutral !== undefined) m.neutral = prev.neutral;

  // HT / penalties from a previous summary when the final score did not change
  if (m.score && prev.score && m.score.home === prev.score.home && m.score.away === prev.score.away) {
    const s = { ...m.score };
    if (s.htHome === undefined && prev.score.htHome !== undefined) s.htHome = prev.score.htHome;
    if (s.htAway === undefined && prev.score.htAway !== undefined) s.htAway = prev.score.htAway;
    if (s.penHome === undefined && prev.score.penHome !== undefined) s.penHome = prev.score.penHome;
    if (s.penAway === undefined && prev.score.penAway !== undefined) s.penAway = prev.score.penAway;
    m.score = s;
  }

  // team stats: keep extended (summary) fields, refresh the scoreboard ones
  if (played) {
    const home = mergeTeamStats(prev.stats?.home, inc.stats?.home);
    const away = mergeTeamStats(prev.stats?.away, inc.stats?.away);
    if (home && away) {
      if (m.score) {
        home.goals = m.score.home;
        away.goals = m.score.away;
      }
      m.stats = { home, away };
    }
    // events: summary events (with substitutions) are richer than the scoreboard ones
    const prevEvents = Array.isArray(prev.events) && prev.events.length ? prev.events : undefined;
    if (keepSummary && prevEvents) m.events = prevEvents;
    else if (!m.events?.length && prevEvents) m.events = prevEvents;
  }

  // odds
  if (inc.status === 'scheduled') {
    m.odds = inc.odds ?? prev.odds;
    if (inc.odds) m.oddsHistory = appendOddsHistory(prev.oddsHistory, inc.odds);
    else if (prev.oddsHistory) m.oddsHistory = prev.oddsHistory;
  } else {
    // finished with summary: prev.odds are the closing odds; otherwise the last pre-match snapshot
    m.odds = keepSummary && prev.odds ? prev.odds : (inc.odds ?? prev.odds);
    if (prev.oddsHistory) m.oddsHistory = prev.oddsHistory;
  }
  if (!m.odds) delete m.odds;
  if (!m.oddsHistory?.length) delete m.oddsHistory;

  // summary flag: a finished match without summary (or newly finished) will be (re)fetched
  if (inc.status === 'finished') {
    m.summaryFetched = prev.summaryFetched === true;
    if (prev.summaryAttempts !== undefined) m.summaryAttempts = prev.summaryAttempts;
    if (prev.summaryRetryAt !== undefined) m.summaryRetryAt = prev.summaryRetryAt;
  } else {
    delete m.summaryFetched;
    delete m.summaryAttempts;
    delete m.summaryRetryAt;
  }

  return m;
}

export interface MergeOptions {
  now?: Date;
  /** drop matches older than this many days (default MAX_AGE_DAYS) */
  maxAgeDays?: number;
}

/**
 * Upsert `incoming` (fresh scoreboard records) into `existing` (stored records) by id.
 * Keeps summary-derived fields (extended stats, key events, closing odds, summaryFetched) when the
 * incoming record lacks them, appends pre-match odds snapshots to `oddsHistory` when prices change
 * (max 30), and drops matches older than 900 days. Result sorted by date.
 */
export function mergeMatches(existing: MatchRecord[], incoming: MatchRecord[], opts: MergeOptions = {}): MatchRecord[] {
  const now = (opts.now ?? new Date()).getTime();
  const cutoff = now - (opts.maxAgeDays ?? MAX_AGE_DAYS) * DAY_MS;
  const byId = new Map<string, MatchRecord>();
  for (const m of existing) byId.set(m.id, m);
  for (const inc of incoming) {
    const prev = byId.get(inc.id);
    if (prev) {
      byId.set(inc.id, mergeOne(prev, inc));
    } else {
      const m: MatchRecord = { ...inc };
      if (inc.status === 'scheduled' && inc.odds) m.oddsHistory = [inc.odds];
      if (inc.status === 'finished') m.summaryFetched = inc.summaryFetched === true;
      byId.set(inc.id, m);
    }
  }
  return [...byId.values()]
    .filter((m) => {
      // an unparsable date can never be aged out (it would stay forever): drop it
      const t = Date.parse(m.date);
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Player lines
// ---------------------------------------------------------------------------
const lineKey = (p: PlayerLine) => `${p.matchId}:${p.playerId}`;

/** Upsert by (matchId, playerId); result sorted by date, match and player. */
export function upsertPlayerLines(existing: PlayerLine[], incoming: PlayerLine[]): PlayerLine[] {
  const map = new Map<string, PlayerLine>();
  for (const p of existing) map.set(lineKey(p), p);
  for (const p of incoming) map.set(lineKey(p), p);
  return [...map.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.matchId.localeCompare(b.matchId) || (a.isHome === b.isHome ? 0 : a.isHome ? -1 : 1),
  );
}

/**
 * Substitutes come with position "SUB" in ESPN rosters ('?' after normalization). Fill them with the
 * player's most frequent known position in the given lines (e.g. from the matches he started).
 * Returns the number of lines updated. Mutates the lines in place.
 */
export function inferUnknownPositions(players: PlayerLine[]): number {
  const counts = new Map<string, Map<PlayerLine['position'], number>>();
  for (const p of players) {
    if (p.position === '?') continue;
    let c = counts.get(p.playerId);
    if (!c) counts.set(p.playerId, (c = new Map()));
    c.set(p.position, (c.get(p.position) ?? 0) + 1);
  }
  let updated = 0;
  for (const p of players) {
    if (p.position !== '?') continue;
    const c = counts.get(p.playerId);
    if (!c) continue;
    let best: PlayerLine['position'] = '?';
    let bestN = 0;
    for (const [pos, n] of c) if (n > bestN) [best, bestN] = [pos, n];
    if (best !== '?') {
      p.position = best;
      updated++;
    }
  }
  return updated;
}

/** Drop player lines older than `maxAgeDays` or whose match is no longer in the store. */
export function prunePlayerLines(players: PlayerLine[], matches: MatchRecord[], opts: MergeOptions = {}): PlayerLine[] {
  const now = (opts.now ?? new Date()).getTime();
  const cutoff = now - (opts.maxAgeDays ?? MAX_AGE_DAYS) * DAY_MS;
  const ids = new Set(matches.map((m) => m.id));
  return players.filter((p) => ids.has(p.matchId) && Date.parse(p.date) >= cutoff);
}
