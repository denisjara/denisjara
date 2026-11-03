/**
 * Incremental persistence of normalized data: data-store/<compId>.json (compact JSON).
 *
 *  - loadStore / saveStore (synchronous; atomic write via temp file + rename)
 *  - mergeMatches: upsert by id keeping summary-derived fields and pre-match odds history
 *  - upsertPlayerLines: upsert by (matchId, playerId)
 */
import fs from 'node:fs';
import path from 'node:path';
import { COMPETITION_BY_ID, COMPETITIONS, STORE_DIR } from './config';
import type { CompetitionStore, MatchRecord, PlayerLine, TeamMatchStats } from './types';
import type { OddsSnapshot } from '../src/types/data';

/** Matches (and player lines) older than this are dropped from the store. */
export const MAX_AGE_DAYS = 900;
/** Max pre-match odds snapshots kept per match. */
export const MAX_ODDS_HISTORY = 30;

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

/** Load data-store/<compId>.json; returns an empty store when the file does not exist. */
export function loadStore(compId: string, dir: string = STORE_DIR): CompetitionStore {
  const file = storePath(compId, dir);
  if (!fs.existsSync(file)) return emptyStore(compId);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CompetitionStore>;
  const base = emptyStore(compId, raw.slug);
  return {
    ...base,
    ...raw,
    compId,
    matches: Array.isArray(raw.matches) ? raw.matches : [],
    players: Array.isArray(raw.players) ? raw.players : [],
    standings: Array.isArray(raw.standings) ? raw.standings : [],
  };
}

/** Load every existing store of the configured competitions (missing files are skipped). */
export function loadAllStores(dir: string = STORE_DIR): CompetitionStore[] {
  return COMPETITIONS.filter((c) => fs.existsSync(storePath(c.id, dir))).map((c) => loadStore(c.id, dir));
}

/** Write the store as compact JSON (atomic). Sets `updatedAt` to now. */
export function saveStore(store: CompetitionStore, dir: string = STORE_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  store.updatedAt = new Date().toISOString();
  const file = storePath(store.compId, dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, file);
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

function mergeOne(prev: MatchRecord, inc: MatchRecord): MatchRecord {
  // scoreboard-owned fields come from the incoming record
  const m: MatchRecord = { ...inc };
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
    if (keepSummary && prev.events?.length) m.events = prev.events;
    else if (!m.events?.length && prev.events?.length) m.events = prev.events;
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
  if (inc.status === 'finished') m.summaryFetched = prev.summaryFetched === true;
  else delete m.summaryFetched;

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
      const t = Date.parse(m.date);
      return !Number.isFinite(t) || t >= cutoff;
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

/** Drop player lines older than `maxAgeDays` or whose match is no longer in the store. */
export function prunePlayerLines(players: PlayerLine[], matches: MatchRecord[], opts: MergeOptions = {}): PlayerLine[] {
  const now = (opts.now ?? new Date()).getTime();
  const cutoff = now - (opts.maxAgeDays ?? MAX_AGE_DAYS) * DAY_MS;
  const ids = new Set(matches.map((m) => m.id));
  return players.filter((p) => ids.has(p.matchId) && Date.parse(p.date) >= cutoff);
}
