/**
 * ESPN JSON  ->  internal normalized records (pipeline/types.ts).
 *
 * Pure functions (no I/O). Raw ESPN payloads are typed loosely (`Raw*` interfaces below only
 * describe the fields we read). Everything user-visible produced here is Spanish.
 *
 * Defensive by design (the API is undocumented and can change or send garbage):
 *  - never throws for a bad record: every event / roster entry / standings row is normalized inside its own
 *    try/catch and discarded with a counted warning (`takeNormalizeWarnings()` summarises them per run);
 *  - text is sanitised (control/bidi characters, `<`/`>` and `javascript:` removed, trimmed, max 120 chars);
 *  - ids must be short url-safe tokens (they become file names in public/data/);
 *  - logo URLs are only kept when they are https on *.espncdn.com (http is upgraded, other hosts dropped);
 *  - numbers: NaN/Infinity → undefined, scores 0..30, percentages in range, counts bounded.
 */
import { overroundOf as rawOverround, type CompetitionConfig } from '../config';
import { stripImplausibleOdds } from '../oddsGuard';
import type { CompetitionStore, MatchEventRecord, MatchRecord, PlayerLine, TeamMatchStats } from '../types';
import type { MatchStatus, OddsSnapshot, StandingGroup, StandingRow, TeamRef } from '../../src/types/data';

// ---------------------------------------------------------------------------
// Raw ESPN shapes (partial)
// ---------------------------------------------------------------------------
interface RawLogo { href?: string; rel?: string[] }
interface RawTeam {
  id?: string;
  displayName?: string;
  shortDisplayName?: string;
  name?: string;
  abbreviation?: string;
  logo?: string;
  logos?: RawLogo[];
  color?: string;
}
interface RawStat { name?: string; value?: number | string; displayValue?: string }
interface RawCompetitor {
  homeAway?: string;
  score?: string | number;
  shootoutScore?: number | string;
  form?: string;
  team?: RawTeam;
  statistics?: RawStat[];
  linescores?: { value?: number; displayValue?: string }[];
}
interface RawClock { value?: number; displayValue?: string }
interface RawAthlete { id?: string; displayName?: string; shortName?: string }
interface RawDetail {
  type?: { id?: string; text?: string; type?: string };
  clock?: RawClock;
  team?: { id?: string };
  scoringPlay?: boolean;
  redCard?: boolean;
  yellowCard?: boolean;
  penaltyKick?: boolean;
  ownGoal?: boolean;
  shootout?: boolean;
  athletesInvolved?: RawAthlete[];
}
interface RawOddsLeg { open?: { odds?: string; line?: string }; close?: { odds?: string; line?: string } }
interface RawOdds {
  provider?: { name?: string; displayName?: string };
  overUnder?: number;
  spread?: number;
  overOdds?: number;
  underOdds?: number;
  homeTeamOdds?: { moneyLine?: number; spreadOdds?: number; value?: number; odds?: { value?: number } };
  awayTeamOdds?: { moneyLine?: number; spreadOdds?: number; value?: number; odds?: { value?: number } };
  drawOdds?: { moneyLine?: number; value?: number; odds?: { value?: number } };
  moneyline?: { home?: RawOddsLeg; away?: RawOddsLeg; draw?: RawOddsLeg };
  total?: { over?: RawOddsLeg; under?: RawOddsLeg };
  pointSpread?: { home?: RawOddsLeg; away?: RawOddsLeg };
}
interface RawStatusType { name?: string; state?: string; completed?: boolean; shortDetail?: string; detail?: string }
interface RawStatus { displayClock?: string; period?: number; type?: RawStatusType }
interface RawCompetition {
  status?: RawStatus;
  venue?: { fullName?: string };
  neutralSite?: boolean;
  competitors?: RawCompetitor[];
  details?: RawDetail[];
  odds?: (RawOdds | null)[];
  notes?: { headline?: string; text?: string }[];
  altGameNote?: string;
}
interface RawEvent {
  id?: string;
  date?: string;
  season?: { year?: number; slug?: string };
  status?: RawStatus;
  venue?: { displayName?: string };
  competitions?: RawCompetition[];
}
interface RawLeague {
  name?: string;
  logos?: RawLogo[];
  season?: { year?: number; displayName?: string; startDate?: string; endDate?: string };
}
interface RawScoreboard { leagues?: RawLeague[]; events?: RawEvent[] }

interface RawPlay { clock?: RawClock; substitution?: boolean; redCard?: boolean; yellowCard?: boolean }
interface RawRosterEntry {
  starter?: boolean;
  subbedIn?: boolean;
  subbedOut?: boolean;
  athlete?: RawAthlete;
  position?: { abbreviation?: string };
  stats?: RawStat[];
  plays?: RawPlay[];
}
interface RawKeyEvent {
  type?: { type?: string; text?: string };
  period?: { number?: number };
  clock?: RawClock;
  scoringPlay?: boolean;
  shootout?: boolean;
  team?: { id?: string };
  participants?: { athlete?: RawAthlete }[];
}
interface RawSummary {
  boxscore?: { teams?: { homeAway?: string; team?: RawTeam; statistics?: RawStat[] }[] };
  rosters?: { homeAway?: string; team?: RawTeam; roster?: RawRosterEntry[] }[];
  keyEvents?: RawKeyEvent[];
  pickcenter?: (RawOdds | null)[];
  odds?: (RawOdds | null)[];
  header?: { competitions?: { neutralSite?: boolean; status?: RawStatus; competitors?: RawCompetitor[] }[] };
}
interface RawStandingEntry { team?: RawTeam; stats?: RawStat[]; note?: { color?: string; description?: string } }
interface RawStandingsChild { name?: string; abbreviation?: string; standings?: { entries?: RawStandingEntry[] } }
interface RawStandings { name?: string; children?: RawStandingsChild[]; standings?: { entries?: RawStandingEntry[] } }

// ---------------------------------------------------------------------------
// Warnings (bad records are skipped, never thrown)
// ---------------------------------------------------------------------------
export interface NormalizeWarning {
  kind: string;
  count: number;
  /** first example seen (short) */
  example?: string;
}

const warnings = new Map<string, NormalizeWarning>();

/** Count a discarded/repaired record. `kind` is a short Spanish label. */
export function warnNormalize(kind: string, example?: string): void {
  const w = warnings.get(kind);
  if (w) w.count++;
  else warnings.set(kind, { kind, count: 1, example: example?.slice(0, 120) });
}

/** Warnings accumulated since the last call (and reset). */
export function takeNormalizeWarnings(): NormalizeWarning[] {
  const out = [...warnings.values()].sort((a, b) => b.count - a.count);
  warnings.clear();
  return out;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Sanitisers
// ---------------------------------------------------------------------------
/** Maximum length of any text taken from ESPN. */
export const MAX_TEXT = 120;
// C0/C1 controls, zero-width and bidi override characters (used for spoofing)
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;
const SCRIPT_SCHEME = /(?:java|vb)script\s*:/gi;
const HAS_SCRIPT_SCHEME = /(?:java|vb)script\s*:/i;

/**
 * Safe display text: strings/numbers only, unsafe characters and `<`/`>` removed, `javascript:` neutralised,
 * whitespace collapsed, trimmed and cut to `max` characters. Empty → undefined.
 */
export function cleanText(x: unknown, max = MAX_TEXT): string | undefined {
  if (typeof x !== 'string' && typeof x !== 'number') return undefined;
  if (typeof x === 'number' && !Number.isFinite(x)) return undefined;
  let s = String(x).replace(UNSAFE_CHARS, ' ').replace(/[<>]/g, '');
  // until stable: one pass can be bypassed by nesting ("javajavascript:script:" → "javascript:")
  for (let i = 0; i < 20 && HAS_SCRIPT_SCHEME.test(s); i++) s = s.replace(SCRIPT_SCHEME, '');
  s = s.replace(SCRIPT_SCHEME, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('').trim() : s;
}

/** ESPN ids (team, event, athlete): short url-safe tokens. They end up in file names, so anything else is rejected. */
export function cleanId(x: unknown): string | undefined {
  if (typeof x !== 'string' && typeof x !== 'number') return undefined;
  const s = String(x).trim();
  return /^[A-Za-z0-9_-]{1,32}$/.test(s) ? s : undefined;
}

/** Hosts allowed for images (ESPN's CDN). */
const LOGO_HOST = /(^|\.)espncdn\.com$/i;

/**
 * Logo URL policy: only https on *.espncdn.com. `http://` on espncdn is upgraded to https (mixed content);
 * any other scheme/host, credentials or absurdly long URLs → undefined.
 */
export function safeLogoUrl(u: unknown): string | undefined {
  if (typeof u !== 'string') return undefined;
  const s = u.trim();
  if (!s || s.length > 500) return undefined;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return undefined;
  }
  if (url.username || url.password || !LOGO_HOST.test(url.hostname)) return undefined;
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') return undefined;
  return url.href;
}

function num(x: unknown): number | undefined {
  if (x === null || x === undefined || x === '' || typeof x === 'boolean' || typeof x === 'object') return undefined;
  const n = typeof x === 'number' ? x : Number(String(x).trim().replace(/%$/, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** Number within [lo, hi] (else undefined). */
function inRange(x: unknown, lo: number, hi: number): number | undefined {
  const n = num(x);
  return n !== undefined && n >= lo && n <= hi ? n : undefined;
}

/** Match score / goals: integer 0..30. */
export const MAX_SCORE = 30;
function scoreNum(x: unknown): number | undefined {
  const n = inRange(x, 0, MAX_SCORE);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

/** Bounds of the per-team match statistics we keep (values outside are treated as unknown). */
const TEAM_STAT_MAX: Record<string, number> = {
  totalShots: 80,
  shotsOnTarget: 50,
  wonCorners: 40,
  foulsCommitted: 60,
  yellowCards: 15,
  redCards: 6,
  offsides: 30,
  saves: 40,
  totalPasses: 1500,
  accuratePasses: 1500,
  totalCrosses: 120,
  totalTackles: 120,
  interceptions: 100,
  totalClearance: 150,
  blockedShots: 50,
};

/** Bounds of the per-player match statistics (absurd values → 0). */
const PLAYER_STAT_MAX: Record<string, number> = {
  totalGoals: 10,
  goalAssists: 10,
  totalShots: 30,
  shotsOnTarget: 20,
  yellowCards: 2,
  redCards: 1,
  foulsCommitted: 20,
  foulsSuffered: 20,
  offsides: 15,
  ownGoals: 5,
  saves: 30,
  goalsConceded: MAX_SCORE,
};

function r(x: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** ESPN dates are "2026-11-04T20:00Z" -> "2026-11-04T20:00:00Z". Unparseable → '' (callers drop the record). */
export function isoDate(d: unknown): string {
  if (typeof d !== 'string' || !d) return '';
  const t = Date.parse(d);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Latest minute accepted (extra time + long stoppage). */
const MAX_MINUTE = 150;

/** "45'+2'" -> 45 ; "90'" -> 90 ; "" -> derived from clock seconds. Always in 0..150. */
export function parseMinute(display: unknown, clockSeconds?: unknown): number {
  const m = /^\s*(\d+)/.exec(typeof display === 'string' ? display : '');
  if (m) return Math.min(MAX_MINUTE, Number(m[1]));
  const secs = num(clockSeconds);
  if (secs !== undefined) return Math.min(MAX_MINUTE, Math.max(0, Math.ceil(secs / 60)));
  return 0;
}

function statMap(stats: unknown): Map<string, number> {
  const m = new Map<string, number>();
  if (!Array.isArray(stats)) return m;
  for (const s of stats as RawStat[]) {
    if (!s || typeof s !== 'object' || typeof s.name !== 'string') continue;
    const v = num(s.value ?? s.displayValue);
    if (v !== undefined) m.set(s.name, v);
  }
  return m;
}

function cleanHex(c: unknown): string | undefined {
  if (typeof c !== 'string') return undefined;
  const h = c.replace(/^#+/, '').trim();
  return /^[0-9a-fA-F]{6}$/.test(h) ? h.toLowerCase() : undefined;
}

/** @deprecated use safeLogoUrl. Kept for compatibility: https upgrade + host policy. */
export function httpsUrl(u: string | undefined): string | undefined {
  return safeLogoUrl(u);
}

function pickLogo(t: RawTeam): string | undefined {
  const direct = safeLogoUrl(t.logo);
  if (direct) return direct;
  const logos = Array.isArray(t.logos) ? t.logos.filter((l) => l && typeof l === 'object') : [];
  const def = logos.find((l) => Array.isArray(l.rel) && l.rel.includes('default')) ?? logos[0];
  return safeLogoUrl(def?.href);
}

/** TeamRef with sanitised text, logo policy and hex colour. `id` is '' when ESPN's id is missing or unsafe. */
export function teamRef(t: RawTeam | undefined): TeamRef {
  const team: RawTeam = t && typeof t === 'object' ? t : {};
  const name = cleanText(team.displayName) ?? cleanText(team.name) ?? cleanText(team.shortDisplayName) ?? '';
  const ref: TeamRef = {
    id: cleanId(team.id) ?? '',
    name,
    short: cleanText(team.shortDisplayName, 40) ?? name,
    abbr: cleanText(team.abbreviation, 8) ?? name.slice(0, 3).toUpperCase(),
  };
  const logo = pickLogo(team);
  if (logo) ref.logo = logo;
  const color = cleanHex(team.color);
  if (color) ref.color = color;
  return ref;
}

/** Copy only defined values (so optional fields stay omitted rather than `undefined`). */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
export function mapStatus(st: RawStatus | undefined): { status: MatchStatus; detail?: string } {
  const type: RawStatusType = st?.type && typeof st.type === 'object' ? st.type : {};
  const name = (typeof type.name === 'string' ? type.name : '').toUpperCase();
  const state = typeof type.state === 'string' ? type.state : 'pre';
  if (name.includes('POSTPONED')) return { status: 'postponed', detail: 'Aplazado' };
  if (name.includes('CANCELED') || name.includes('CANCELLED')) return { status: 'cancelled', detail: 'Cancelado' };
  if (name.includes('ABANDONED')) return { status: 'cancelled', detail: 'Suspendido' };
  if (state === 'in') {
    if (name.includes('HALFTIME')) return { status: 'live', detail: 'Descanso' };
    if (name.includes('SHOOTOUT')) return { status: 'live', detail: 'Penaltis' };
    return { status: 'live', detail: cleanText(st?.displayClock, 20) || cleanText(type.shortDetail, 40) || 'En juego' };
  }
  if (state === 'post') {
    if (type.completed === false) {
      if (name.includes('SUSPENDED') || name.includes('DELAYED')) return { status: 'postponed', detail: 'Suspendido' };
      return { status: 'cancelled', detail: cleanText(type.shortDetail, 40) || 'Sin resultado' };
    }
    if (name.includes('PEN')) return { status: 'finished', detail: 'Final (penaltis)' };
    if (name.includes('AET') || name.includes('EXTRA')) return { status: 'finished', detail: 'Final (prórroga)' };
    return { status: 'finished', detail: 'Final' };
  }
  if (name.includes('DELAYED')) return { status: 'scheduled', detail: 'Retrasado' };
  return { status: 'scheduled' };
}

// ---------------------------------------------------------------------------
// Round labels (Spanish)
// ---------------------------------------------------------------------------
const ROUND_TOKENS: Record<string, string> = {
  'preliminary-round': 'Ronda preliminar',
  'qualifying-round': 'Ronda previa',
  'first-round': 'Primera ronda',
  'second-round': 'Segunda ronda',
  'third-round': 'Tercera ronda',
  'fourth-round': 'Cuarta ronda',
  'fifth-round': 'Quinta ronda',
  'sixth-round': 'Sexta ronda',
  'first-stage': 'Primera fase',
  'second-stage': 'Segunda fase',
  'third-stage': 'Tercera fase',
  'group-stage': 'Fase de grupos',
  'league-phase': 'Fase de liga',
  'knockout-round-playoffs': 'Playoff de eliminatorias',
  'knockout-round': 'Eliminatorias',
  'round-of-64': 'Treintaidosavos de final',
  'round-of-32': 'Dieciseisavos de final',
  'round-of-16': 'Octavos de final',
  quarterfinals: 'Cuartos de final',
  semifinals: 'Semifinales',
  final: 'Final',
  finals: 'Final',
  '3rd-place-match': 'Tercer puesto',
  'third-place': 'Tercer puesto',
  'relegation-playoffs': 'Playoff de descenso',
  'relegation-playoff': 'Playoff de descenso',
  'promotion-playoffs': 'Playoff de ascenso',
  'promotion-semifinals': 'Playoff de ascenso · Semifinales',
  'promotion-final': 'Playoff de ascenso · Final',
  'promotion-finals': 'Playoff de ascenso · Final',
  'torneo-apertura': 'Apertura',
  'torneo-clausura': 'Clausura',
  apertura: 'Apertura',
  clausura: 'Clausura',
  'round-one': 'Primera ronda',
  'wild-card': 'Comodín',
  'eastern-conference-playoffs': 'Playoffs Conferencia Este',
  'western-conference-playoffs': 'Playoffs Conferencia Oeste',
  'mls-cup': 'Final MLS Cup',
  'conference-league-playoffs': 'Playoff Conference League',
  'europa-conference-playoffs': 'Playoff Conference League',
  '7th-place-vs-8th-place': 'Play-in 7.º vs 8.º',
  '9th-place-vs-10th-place': 'Play-in 9.º vs 10.º',
  '7th-seed-game': 'Play-in 7.º puesto',
  '8th-seed-game': 'Play-in 8.º puesto',
};

function translateRoundToken(tok: string): string | undefined {
  if (!tok) return undefined;
  if (ROUND_TOKENS[tok]) return ROUND_TOKENS[tok];
  const m = /^(apertura|clausura)-(\d{4})$/.exec(tok);
  if (m) return `${ROUND_TOKENS[m[1]]} ${m[2]}`;
  // regular season / season names: no round label
  if (tok === 'regular-season' || /^\d{4}/.test(tok)) return undefined;
  const words = cleanText(tok.replace(/-+/g, ' '), 60);
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : undefined;
}

function translateLegNote(note: unknown): string | undefined {
  if (typeof note !== 'string' || !note) return undefined;
  if (/^1st Leg/i.test(note)) return 'Ida';
  if (/^2nd Leg/i.test(note)) return 'Vuelta';
  return undefined;
}

/**
 * ESPN's `neutralSite` is practically never true, even for finals. Single-match finals of cups and
 * continental competitions (and single-match league/promotion finals such as the Championship
 * play-off at Wembley or Argentina's Apertura/Clausura finals) are played at neutral venues.
 * Two-legged ties carry "Ida"/"Vuelta" in the label and are never matched here.
 */
export function isNeutralRound(round: string | undefined, comp: Pick<CompetitionConfig, 'kind'>): boolean {
  if (!round) return false;
  if (comp.kind !== 'league' && (round === 'Final' || round === 'Tercer puesto')) return true;
  if (round === 'Playoff de ascenso · Final') return true;
  return comp.kind === 'league' && /^(Apertura|Clausura)( \d{4})? · Final$/.test(round);
}

export function roundLabel(seasonSlug: string | undefined, comp: RawCompetition | undefined): string | undefined {
  const parts: string[] = [];
  for (const tok of (typeof seasonSlug === 'string' ? seasonSlug : '').slice(0, 300).split('---')) {
    const t = translateRoundToken(tok.trim());
    if (t && !parts.includes(t)) parts.push(t);
  }
  // "Copa Chile, Group F" / "UEFA Nations League, Group A1"
  const group = /Group\s+([A-Z0-9]{1,3})\b/.exec(typeof comp?.altGameNote === 'string' ? comp.altGameNote : '');
  if (group) parts.push(`Grupo ${group[1]}`);
  const note0 = Array.isArray(comp?.notes) ? comp.notes[0] : undefined;
  const leg = translateLegNote(note0?.headline ?? note0?.text);
  if (leg) parts.push(leg);
  return parts.length ? cleanText(parts.join(' · ')) : undefined;
}

// ---------------------------------------------------------------------------
// Odds (American -> decimal; private implementation on purpose)
// ---------------------------------------------------------------------------
/** Decimal odds accepted (1.001 .. 1000). */
const MAX_DECIMAL_ODDS = 1000;

function americanToDecimalPrivate(ml: unknown): number | undefined {
  if (ml === null || ml === undefined || (typeof ml !== 'string' && typeof ml !== 'number')) return undefined;
  const s = String(ml).trim().toUpperCase();
  if (s === 'EVEN' || s === 'EV') return 2;
  const v = Number(s.replace(/^\+/, ''));
  if (!Number.isFinite(v) || Math.abs(v) < 100) return undefined;
  const dec = v > 0 ? 1 + v / 100 : 1 + 100 / Math.abs(v);
  return dec > 1 && dec <= MAX_DECIMAL_ODDS ? r(dec, 3) : undefined;
}

/** "o2.5" / "+1.5" → number, within ±20 (goal lines and handicaps). */
function parseLine(line: unknown): number | undefined {
  if (typeof line !== 'string' || !line) return undefined;
  const m = /([+-]?\d+(?:\.\d+)?)/.exec(line.replace(/^[ou]/i, ''));
  const v = m ? Number(m[1]) : undefined;
  return v !== undefined && Number.isFinite(v) && Math.abs(v) <= 20 ? v : undefined;
}

function providerName(o: RawOdds, fallback: string): string {
  const p = o.provider && typeof o.provider === 'object' ? o.provider : undefined;
  return cleanText(p?.displayName, 40) ?? cleanText(p?.name, 40) ?? fallback;
}

function overroundOf(h?: number, d?: number, a?: number): number | undefined {
  const m = rawOverround(h, d, a);
  return m === undefined ? undefined : r(m, 4);
}

/** Drop price sets whose overround is implausible (feed errors), keeping the other markets; counted as warnings. */
function dropImplausiblePrices(s: OddsSnapshot): void {
  for (const g of stripImplausibleOdds(s)) warnNormalize(`cuotas con margen imposible descartadas (${g})`);
}

function isUsableOdds(s: OddsSnapshot): boolean {
  return s.home !== undefined || s.away !== undefined || s.over !== undefined || s.spreadHome !== undefined;
}

/** DraftKings-style entry (moneyline/total/pointSpread with open+close, or pickcenter flat fields). */
function snapshotFromAmerican(o: RawOdds, capturedAt: string): OddsSnapshot | undefined {
  const ml = o.moneyline;
  const s: OddsSnapshot = {
    provider: providerName(o, 'DraftKings'),
    home: americanToDecimalPrivate(ml?.home?.close?.odds) ?? americanToDecimalPrivate(o.homeTeamOdds?.moneyLine),
    draw: americanToDecimalPrivate(ml?.draw?.close?.odds) ?? americanToDecimalPrivate(o.drawOdds?.moneyLine),
    away: americanToDecimalPrivate(ml?.away?.close?.odds) ?? americanToDecimalPrivate(o.awayTeamOdds?.moneyLine),
    homeOpen: americanToDecimalPrivate(ml?.home?.open?.odds),
    drawOpen: americanToDecimalPrivate(ml?.draw?.open?.odds),
    awayOpen: americanToDecimalPrivate(ml?.away?.open?.odds),
  };
  const overClose = o.total?.over?.close;
  const underClose = o.total?.under?.close;
  s.totalLine = parseLine(overClose?.line) ?? parseLine(underClose?.line) ?? inRange(o.overUnder, 0, 20);
  s.over = americanToDecimalPrivate(overClose?.odds) ?? americanToDecimalPrivate(o.overOdds);
  s.under = americanToDecimalPrivate(underClose?.odds) ?? americanToDecimalPrivate(o.underOdds);
  // opening total odds only when the opening line is the same line
  const overOpen = o.total?.over?.open;
  const underOpen = o.total?.under?.open;
  if (s.totalLine !== undefined && parseLine(overOpen?.line) === s.totalLine) s.overOpen = americanToDecimalPrivate(overOpen?.odds);
  if (s.totalLine !== undefined && parseLine(underOpen?.line) === s.totalLine) s.underOpen = americanToDecimalPrivate(underOpen?.odds);
  if (s.over === undefined && s.under === undefined) delete s.totalLine;

  const spHome = o.pointSpread?.home?.close;
  const spAway = o.pointSpread?.away?.close;
  s.spreadLine = parseLine(spHome?.line) ?? (spAway?.line !== undefined ? negate(parseLine(spAway.line)) : inRange(o.spread, -20, 20));
  s.spreadHome = americanToDecimalPrivate(spHome?.odds) ?? americanToDecimalPrivate(o.homeTeamOdds?.spreadOdds);
  s.spreadAway = americanToDecimalPrivate(spAway?.odds) ?? americanToDecimalPrivate(o.awayTeamOdds?.spreadOdds);
  if (s.spreadHome === undefined && s.spreadAway === undefined) delete s.spreadLine;

  dropImplausiblePrices(s);
  s.margin = overroundOf(s.home, s.draw, s.away);
  s.capturedAt = capturedAt;
  compact(s);
  return isUsableOdds(s) ? s : undefined;
}

function negate(x: number | undefined): number | undefined {
  return x === undefined ? undefined : x === 0 ? 0 : -x;
}

/** Bet365-style entry: decimal `value` per side (1X2 only). */
function snapshotFromDecimal(o: RawOdds, capturedAt: string): OddsSnapshot | undefined {
  const dec = (x: { value?: number; odds?: { value?: number } } | undefined) => {
    const v = num(x?.value ?? x?.odds?.value);
    return v !== undefined && v > 1 && v <= MAX_DECIMAL_ODDS ? r(v, 3) : undefined;
  };
  const s: OddsSnapshot = {
    provider: providerName(o, 'Bet 365'),
    home: dec(o.homeTeamOdds),
    draw: dec(o.drawOdds),
    away: dec(o.awayTeamOdds),
  };
  if (s.home === undefined || s.draw === undefined || s.away === undefined) return undefined;
  dropImplausiblePrices(s);
  if (s.home === undefined) return undefined;
  s.margin = overroundOf(s.home, s.draw, s.away);
  s.capturedAt = capturedAt;
  return compact(s);
}

function hasAmerican(o: RawOdds): boolean {
  return !!(o.moneyline || o.total || o.pointSpread || o.homeTeamOdds?.moneyLine !== undefined || o.drawOdds?.moneyLine !== undefined);
}

/** Pre-match odds from the scoreboard: DraftKings first, Bet 365 (1X2 only) as fallback. Bad entries are skipped. */
export function oddsFromScoreboard(list: (RawOdds | null)[] | undefined, capturedAt: string): OddsSnapshot | undefined {
  const entries = (Array.isArray(list) ? list : []).filter((o): o is RawOdds => !!o && typeof o === 'object');
  try {
    for (const o of entries) {
      if (!hasAmerican(o)) continue;
      const s = snapshotFromAmerican(o, capturedAt);
      if (s) return s;
    }
    for (const o of entries) {
      const s = snapshotFromDecimal(o, capturedAt);
      if (s) return s;
    }
  } catch (e) {
    warnNormalize('cuotas descartadas', errMsg(e));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Scoreboard
// ---------------------------------------------------------------------------
export interface NormalizeScoreboardOptions {
  /** Override of the competition's current season year (default: leagues[0].season.year of this payload). */
  currentSeasonYear?: number;
  /** "now" used as odds capture time. */
  now?: Date;
}

export function leagueInfo(raw: unknown): CompetitionStore['league'] {
  try {
    const leagues = (raw as RawScoreboard)?.leagues;
    const lg = Array.isArray(leagues) ? leagues[0] : undefined;
    if (!lg || typeof lg !== 'object') return undefined;
    const logos = (Array.isArray(lg.logos) ? lg.logos : []).filter((l) => l && typeof l === 'object');
    const rel = (l: RawLogo) => (Array.isArray(l.rel) ? l.rel : []);
    const logo = logos.find((l) => rel(l).includes('default') && !rel(l).includes('dark')) ?? logos.find((l) => !rel(l).includes('dark'));
    const logoDark = logos.find((l) => rel(l).includes('dark'));
    const season = lg.season && typeof lg.season === 'object' ? lg.season : undefined;
    const seasonName = typeof season?.displayName === 'string' ? season.displayName : '';
    let seasonLabel: string | undefined;
    const sm = /(\d{4})(?:\s*[-/]\s*(\d{2,4}))?/.exec(seasonName);
    if (sm) seasonLabel = sm[2] ? `${sm[1]}-${sm[2].slice(-2)}` : sm[1];
    const year = inRange(season?.year, 1990, 2100);
    return compact({
      name: cleanText(lg.name),
      logo: safeLogoUrl(logo?.href),
      logoDark: safeLogoUrl(logoDark?.href),
      seasonYear: year !== undefined && Number.isInteger(year) ? year : undefined,
      seasonLabel,
      seasonStart: isoDate(season?.startDate) || undefined,
      seasonEnd: isoDate(season?.endDate) || undefined,
    });
  } catch (e) {
    warnNormalize('información de liga ilegible', errMsg(e));
    return undefined;
  }
}

function scoreboardTeamStats(c: RawCompetitor): Omit<TeamMatchStats, 'goals'> & { covered: boolean } {
  const st = statMap(c.statistics);
  const poss = inRange(st.get('possessionPct'), 0, 100);
  const shots = inRange(st.get('totalShots'), 0, TEAM_STAT_MAX.totalShots);
  const covered = (poss ?? 0) > 0 || (shots ?? 0) > 0;
  return {
    covered,
    shots,
    shotsOnTarget: inRange(st.get('shotsOnTarget'), 0, TEAM_STAT_MAX.shotsOnTarget),
    corners: inRange(st.get('wonCorners'), 0, TEAM_STAT_MAX.wonCorners),
    fouls: inRange(st.get('foulsCommitted'), 0, TEAM_STAT_MAX.foulsCommitted),
    possession: poss,
  };
}

function eventFromDetail(d: RawDetail): MatchEventRecord | undefined {
  if (!d || typeof d !== 'object' || d.shootout) return undefined;
  let type: MatchEventRecord['type'];
  if (d.scoringPlay) type = d.ownGoal ? 'own-goal' : d.penaltyKick ? 'penalty' : 'goal';
  else if (d.redCard) type = 'red';
  else if (d.yellowCard) type = 'yellow';
  else return undefined;
  const ath = Array.isArray(d.athletesInvolved) ? d.athletesInvolved[0] : undefined;
  return compact({
    minute: parseMinute(d.clock?.displayValue, d.clock?.value),
    clock: cleanText(d.clock?.displayValue, 16) || `${parseMinute(undefined, d.clock?.value)}'`,
    type,
    teamId: cleanId(d.team?.id) ?? '',
    playerId: cleanId(ath?.id),
    player: cleanText(ath?.displayName),
  });
}

/** Events of a list, each one isolated (a bad entry is skipped with a warning). */
function safeEvents<T>(list: unknown, fn: (x: T) => MatchEventRecord | undefined, label: string): MatchEventRecord[] {
  const out: MatchEventRecord[] = [];
  if (!Array.isArray(list)) return out;
  for (const x of list as T[]) {
    try {
      const e = fn(x);
      if (e) out.push(e);
    } catch (err) {
      warnNormalize(label, errMsg(err));
    }
  }
  return out;
}

const isGoal = (e: MatchEventRecord) => e.type === 'goal' || e.type === 'own-goal' || e.type === 'penalty';

/** ESPN `form` is most-recent FIRST; our contract is chronological (most recent LAST). */
function chronologicalForm(f: unknown): string | undefined {
  const s = (typeof f === 'string' ? f : '').toUpperCase().replace(/[^WDL]/g, '').slice(0, 10);
  return s ? s.split('').reverse().join('') : undefined;
}

/** Reason why a scoreboard event is discarded (counted in the warnings), or a record. */
function normalizeEvent(ev: RawEvent, comp: CompetitionConfig, currentSeasonYear: number | undefined, capturedAt: string): MatchRecord | string {
  if (!ev || typeof ev !== 'object') return 'evento no es un objeto';
  const c = Array.isArray(ev.competitions) ? ev.competitions[0] : undefined;
  const id = cleanId(ev.id);
  if (!id || !c || typeof c !== 'object') return 'evento sin id válido o sin competición';
  const seasonSlug = typeof ev.season?.slug === 'string' ? ev.season.slug : '';
  if (seasonSlug === 'all-star-game') return '';
  const competitors = (Array.isArray(c.competitors) ? c.competitors : []).filter((x) => x && typeof x === 'object');
  const homeC = competitors.find((x) => x.homeAway === 'home') ?? competitors[0];
  const awayC = competitors.find((x) => x.homeAway === 'away') ?? competitors[1];
  if (!homeC || !awayC || homeC === awayC) return 'evento sin dos equipos';
  const date = isoDate(ev.date);
  if (!date) return 'evento sin fecha válida';

  const { status, detail } = mapStatus(c.status ?? ev.status);
  const home = teamRef(homeC.team);
  const away = teamRef(awayC.team);
  if (!home.id || !away.id || home.id === away.id) return 'equipo sin id válido';
  if (!home.name || !away.name) return 'equipo sin nombre';
  const yearRaw = inRange(ev.season?.year, 1990, 2100);
  const season = (yearRaw !== undefined && Number.isInteger(yearRaw) ? yearRaw : undefined) ?? currentSeasonYear ?? 0;

  const m: MatchRecord = {
    id,
    compId: comp.id,
    season,
    currentSeason: currentSeasonYear !== undefined && season === currentSeasonYear,
    date,
    status,
    home,
    away,
  };
  if (detail) m.statusDetail = detail;
  const round = roundLabel(seasonSlug, c);
  if (round) m.round = round;
  if (c.neutralSite === true || isNeutralRound(round, comp)) m.neutral = true;
  const venue = cleanText(c.venue?.fullName) ?? cleanText(ev.venue?.displayName);
  if (venue) m.venue = venue;

  const played = status === 'finished' || status === 'live';
  if (played) {
    // a missing/empty score counts as 0 (kick-off just happened); anything else must be an integer 0..30
    const rawHs = homeC.score;
    const rawAs = awayC.score;
    const blank = (x: unknown) => x === undefined || x === null || x === '';
    const hs = blank(rawHs) ? 0 : scoreNum(rawHs);
    const as = blank(rawAs) ? 0 : scoreNum(rawAs);
    if (hs === undefined || as === undefined) return `marcador fuera de rango (${String(rawHs).slice(0, 10)}-${String(rawAs).slice(0, 10)})`;
    const score: NonNullable<MatchRecord['score']> = { home: hs, away: as };
    const ph = scoreNum(homeC.shootoutScore);
    const pa = scoreNum(awayC.shootoutScore);
    if (ph !== undefined && pa !== undefined) {
      score.penHome = ph;
      score.penAway = pa;
    }

    // events (goals & cards) from details
    const details = Array.isArray(c.details) ? c.details : [];
    const events = safeEvents<RawDetail>(details, eventFromDetail, 'evento de partido descartado');
    if (events.length) m.events = events;

    // HT score: derived from goal events when they are consistent with the final score
    const period = (c.status ?? ev.status)?.period ?? 0;
    const goals = events.filter(isGoal);
    const gHome = goals.filter((g) => g.teamId === home.id);
    const gAway = goals.filter((g) => g.teamId === away.id);
    const consistent = gHome.length === hs && gAway.length === as;
    if (consistent && (status === 'finished' || period >= 2)) {
      score.htHome = gHome.filter((g) => g.minute <= 45).length;
      score.htAway = gAway.filter((g) => g.minute <= 45).length;
    }
    m.score = score;

    // team stats
    const sh = scoreboardTeamStats(homeC);
    const sa = scoreboardTeamStats(awayC);
    const covered = sh.covered || sa.covered;
    const cardsKnown = details.length > 0 || (covered && hs + as === 0);
    const cards = (teamId: string, kind: 'yellow' | 'red') =>
      cardsKnown ? events.filter((e) => e.type === kind && e.teamId === teamId).length : undefined;
    const build = (s: typeof sh, goalsFor: number, teamId: string): TeamMatchStats =>
      compact({
        goals: goalsFor,
        shots: covered ? s.shots : undefined,
        shotsOnTarget: covered ? s.shotsOnTarget : undefined,
        corners: covered ? s.corners : undefined,
        fouls: covered ? s.fouls : undefined,
        possession: covered ? s.possession : undefined,
        yellow: cards(teamId, 'yellow'),
        red: cards(teamId, 'red'),
      });
    if (covered || cardsKnown) m.stats = { home: build(sh, hs, home.id), away: build(sa, as, away.id) };
  }

  if (status !== 'finished') {
    const hf = chronologicalForm(homeC.form);
    const af = chronologicalForm(awayC.form);
    if (hf) m.homeForm = hf;
    if (af) m.awayForm = af;
  }

  if (status === 'scheduled') {
    const odds = oddsFromScoreboard(c.odds, capturedAt);
    if (odds) m.odds = odds;
  }
  return m;
}

/** Records only once per payload: duplicates are dropped silently, discarded events are counted. */
function normalizeEventSafe(ev: RawEvent, comp: CompetitionConfig, currentSeasonYear: number | undefined, capturedAt: string): MatchRecord | undefined {
  try {
    const r = normalizeEvent(ev, comp, currentSeasonYear, capturedAt);
    if (typeof r === 'string') {
      if (r) warnNormalize(`partido descartado: ${r}`, `${comp.id} ${String((ev as RawEvent | undefined)?.id ?? '?').slice(0, 20)}`);
      return undefined;
    }
    return r;
  } catch (e) {
    warnNormalize('partido descartado: error inesperado', `${comp.id}: ${errMsg(e)}`);
    return undefined;
  }
}

/**
 * Normalize a scoreboard payload (one `dates=` request) of a competition.
 * `currentSeason` = event season year equals `opts.currentSeasonYear` (default leagues[0].season.year).
 */
export function normalizeScoreboard(
  raw: unknown,
  comp: CompetitionConfig,
  opts: NormalizeScoreboardOptions = {},
): { league: CompetitionStore['league']; matches: MatchRecord[] } {
  const sb = (raw && typeof raw === 'object' ? raw : {}) as RawScoreboard;
  const league = leagueInfo(sb);
  const currentSeasonYear = opts.currentSeasonYear ?? league?.seasonYear;
  const capturedAt = isoDate((opts.now ?? new Date()).toISOString());
  const seen = new Set<string>();
  const matches: MatchRecord[] = [];
  if (sb.events !== undefined && !Array.isArray(sb.events)) warnNormalize('scoreboard con events no válido', comp.id);
  for (const ev of Array.isArray(sb.events) ? sb.events : []) {
    const m = normalizeEventSafe(ev, comp, currentSeasonYear, capturedAt);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    matches.push(m);
  }
  matches.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return { league, matches };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
export interface SummaryResult {
  /** extended boxscore team stats (goals from the match score) */
  stats?: { home: TeamMatchStats; away: TeamMatchStats };
  /** key events: goals, cards and substitutions */
  events?: MatchEventRecord[];
  /** closing odds (DraftKings pickcenter) */
  closingOdds?: OddsSnapshot;
  /** half-time score from the header linescores */
  ht?: { home: number; away: number };
  /** penalty shoot-out score from the header */
  pens?: { home: number; away: number };
  /** neutral venue flag from the header */
  neutral?: boolean;
  /** true when the match went to extra time (players' full time = 120) */
  extraTime: boolean;
  players: PlayerLine[];
}

export function mapPosition(abbr: string | undefined): PlayerLine['position'] {
  const a = (abbr ?? '').toUpperCase().trim();
  if (!a || a === 'SUB') return '?';
  if (a === 'G' || a === 'GK' || a === 'POR') return 'G';
  const base = a.split('-')[0];
  if (['D', 'CD', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'WB', 'SW', 'DF', 'DEF'].includes(base)) return 'D';
  if (['M', 'CM', 'DM', 'AM', 'LM', 'RM', 'MF', 'MID', 'CDM', 'CAM'].includes(base)) return 'M';
  if (['F', 'CF', 'LF', 'RF', 'ST', 'FW', 'LW', 'RW', 'W', 'S', 'FWD'].includes(base)) return 'F';
  return '?';
}

function boxscoreTeamStats(stats: RawStat[] | undefined, goals: number): TeamMatchStats | undefined {
  const st = statMap(stats);
  if (st.size === 0) return undefined;
  // bounded counts (absurd values are treated as unknown); possession 0..100; pass accuracy 0..1
  const g = (k: string) => {
    if (k === 'possessionPct') return inRange(st.get(k), 0, 100);
    const max = TEAM_STAT_MAX[k];
    return max === undefined ? undefined : inRange(st.get(k), 0, max);
  };
  const passes = g('totalPasses');
  const accurate = g('accuratePasses');
  let passPct: number | undefined;
  const rawPct = inRange(st.get('passPct'), 0, 100);
  if (passes && accurate !== undefined && passes > 0 && accurate <= passes) passPct = r(accurate / passes, 3);
  else if (rawPct !== undefined) passPct = rawPct > 1 ? r(rawPct / 100, 3) : rawPct;
  return compact({
    goals,
    shots: g('totalShots'),
    shotsOnTarget: g('shotsOnTarget'),
    corners: g('wonCorners'),
    fouls: g('foulsCommitted'),
    yellow: g('yellowCards'),
    red: g('redCards'),
    offsides: g('offsides'),
    possession: g('possessionPct'),
    saves: g('saves'),
    passes,
    passPct,
    crosses: g('totalCrosses'),
    tackles: g('totalTackles'),
    interceptions: g('interceptions'),
    clearances: g('totalClearance'),
    blockedShots: g('blockedShots'),
  });
}

function boxscoreCovered(s: TeamMatchStats | undefined): boolean {
  if (!s) return false;
  return (s.possession ?? 0) > 0 || (s.shots ?? 0) > 0 || (s.passes ?? 0) > 0;
}

function keyEventToRecord(k: RawKeyEvent): MatchEventRecord | undefined {
  if (!k || typeof k !== 'object' || k.shootout) return undefined;
  const t = (typeof k.type?.type === 'string' ? k.type.type : '').toLowerCase();
  const text = (typeof k.type?.text === 'string' ? k.type.text : '').toLowerCase();
  let type: MatchEventRecord['type'] | undefined;
  if (t === 'own-goal' || text === 'own goal') type = 'own-goal';
  else if (t.startsWith('penalty---scored') || text === 'penalty - scored') type = 'penalty';
  else if (k.scoringPlay || t === 'goal' || t.startsWith('goal---')) type = 'goal';
  else if (t === 'yellow-card' || text === 'yellow card') type = 'yellow';
  else if (t === 'red-card' || t === 'yellow-red-card' || text === 'red card') type = 'red';
  else if (t === 'substitution') type = 'sub';
  if (!type) return undefined;
  const parts = Array.isArray(k.participants) ? k.participants : [];
  const p0 = parts[0]?.athlete;
  const p1 = parts[1]?.athlete;
  return compact({
    minute: parseMinute(k.clock?.displayValue, k.clock?.value),
    clock: cleanText(k.clock?.displayValue, 16) || `${parseMinute(undefined, k.clock?.value)}'`,
    type,
    teamId: cleanId(k.team?.id) ?? '',
    playerId: cleanId(p0?.id),
    player: cleanText(p0?.displayName),
    playerOutId: type === 'sub' ? cleanId(p1?.id) : undefined,
  });
}

function detectExtraTime(raw: RawSummary, keyEvents: RawKeyEvent[]): boolean {
  const comps = Array.isArray(raw.header?.competitions) ? raw.header.competitions : [];
  const rawName = comps[0]?.status?.type?.name;
  const name = (typeof rawName === 'string' ? rawName : '').toUpperCase();
  if (name.includes('AET') || name.includes('EXTRA')) return true;
  const etSignal = keyEvents.some((k) => {
    if (!k || typeof k !== 'object') return false;
    if (k.shootout || k.period?.number === 5) return false;
    if (k.period?.number === 3 || k.period?.number === 4) return true;
    if (typeof k.type?.type === 'string' && k.type.type.includes('extra-time')) return true;
    // a goal / card / substitution after minute 90 (stoppage time "90'+x'" parses as 90)
    return !!keyEventToRecord(k) && parseMinute(k.clock?.displayValue, undefined) > 90;
  });
  if (etSignal) return true;
  // shoot-out without key events: assume extra time was played (most cup formats)
  if (name.includes('PEN')) return keyEvents.length === 0;
  return false;
}

/**
 * Normalize a match summary. `match` gives home/away ids, date and competition.
 * Player minutes: starter = minute subbed off / sent off, else 90 (120 with extra time);
 * substitute = full time - minute on (min 1); a sub later subbed off/sent off uses that minute.
 */
export function normalizeSummary(raw: unknown, match: MatchRecord): SummaryResult {
  const s = (raw && typeof raw === 'object' ? raw : {}) as RawSummary;
  const homeId = match.home.id;
  const awayId = match.away.id;
  const keyEvents = (Array.isArray(s.keyEvents) ? s.keyEvents : []).filter((k) => k && typeof k === 'object');
  let extraTime = false;
  try {
    extraTime = detectExtraTime(s, keyEvents);
  } catch (e) {
    warnNormalize('resumen: prórroga indeterminada', errMsg(e));
  }
  const fullTime = extraTime ? 120 : 90;
  const out: SummaryResult = { extraTime, players: [] };

  // header: HT score, penalties, neutral
  try {
    const hcs = Array.isArray(s.header?.competitions) ? s.header.competitions : [];
    const hc = hcs[0];
    if (hc && typeof hc === 'object') {
      if (typeof hc.neutralSite === 'boolean') out.neutral = hc.neutralSite;
      const comps = (Array.isArray(hc.competitors) ? hc.competitors : []).filter((c) => c && typeof c === 'object');
      const ch = comps.find((c) => String(c.team?.id) === homeId) ?? comps.find((c) => c.homeAway === 'home');
      const ca = comps.find((c) => String(c.team?.id) === awayId) ?? comps.find((c) => c.homeAway === 'away');
      const ls = (c: RawCompetitor | undefined) => (Array.isArray(c?.linescores) ? c.linescores[0] : undefined);
      const hHt = scoreNum(ls(ch)?.displayValue ?? ls(ch)?.value);
      const aHt = scoreNum(ls(ca)?.displayValue ?? ls(ca)?.value);
      if (hHt !== undefined && aHt !== undefined) out.ht = { home: hHt, away: aHt };
      const hp = scoreNum(ch?.shootoutScore);
      const ap = scoreNum(ca?.shootoutScore);
      if (hp !== undefined && ap !== undefined) out.pens = { home: hp, away: ap };
    }
  } catch (e) {
    warnNormalize('resumen: cabecera ilegible', errMsg(e));
  }

  // boxscore team stats
  try {
    const teams = (Array.isArray(s.boxscore?.teams) ? s.boxscore.teams : []).filter((t) => t && typeof t === 'object');
    const bh = teams.find((t) => String(t.team?.id) === homeId) ?? teams.find((t) => t.homeAway === 'home');
    const ba = teams.find((t) => String(t.team?.id) === awayId) ?? teams.find((t) => t.homeAway === 'away');
    const sh = boxscoreTeamStats(bh?.statistics, match.score?.home ?? 0);
    const sa = boxscoreTeamStats(ba?.statistics, match.score?.away ?? 0);
    if (sh && sa && (boxscoreCovered(sh) || boxscoreCovered(sa))) out.stats = { home: sh, away: sa };
  } catch (e) {
    warnNormalize('resumen: estadísticas de equipo ilegibles', errMsg(e));
  }

  // key events
  const events = safeEvents<RawKeyEvent>(keyEvents, keyEventToRecord, 'evento clave descartado');
  if (events.length) out.events = events;

  // closing odds: pickcenter / odds entries with American prices (Bet 365 entries in a finished
  // match summary are in-play/settled prices and are ignored)
  const capturedAt = match.date || isoDate(new Date().toISOString());
  const oddsList = [...(Array.isArray(s.pickcenter) ? s.pickcenter : []), ...(Array.isArray(s.odds) ? s.odds : [])];
  for (const o of oddsList) {
    if (!o || typeof o !== 'object' || !hasAmerican(o)) continue;
    try {
      const snap = snapshotFromAmerican(o, capturedAt);
      if (snap && (snap.home !== undefined || snap.over !== undefined)) {
        out.closingOdds = snap;
        break;
      }
    } catch (e) {
      warnNormalize('cuotas de cierre descartadas', errMsg(e));
    }
  }

  // substitution minutes from key events (fallback when roster plays are missing)
  const subOn = new Map<string, number>();
  const subOff = new Map<string, number>();
  for (const e of events) {
    if (e.type !== 'sub') continue;
    if (e.playerId && !subOn.has(e.playerId)) subOn.set(e.playerId, e.minute);
    if (e.playerOutId && !subOff.has(e.playerOutId)) subOff.set(e.playerOutId, e.minute);
  }

  // players (each roster entry isolated: a bad one is skipped with a warning)
  const rosters = (Array.isArray(s.rosters) ? s.rosters : []).filter((t) => t && typeof t === 'object');
  for (const team of rosters) {
    const teamId = cleanId(team.team?.id) ?? '';
    const isHome = teamId === homeId || (teamId !== awayId && team.homeAway === 'home');
    const opponentId = isHome ? awayId : homeId;
    const roster = Array.isArray(team.roster) ? team.roster : [];
    for (const p of roster) {
      try {
        const line = playerLineOf(p, { match, teamId: teamId || (isHome ? homeId : awayId), opponentId, isHome, fullTime, subOn, subOff });
        if (line) out.players.push(line);
      } catch (e) {
        warnNormalize('jugador descartado: error inesperado', errMsg(e));
      }
    }
  }
  return out;
}

interface PlayerLineCtx {
  match: MatchRecord;
  teamId: string;
  opponentId: string;
  isHome: boolean;
  fullTime: number;
  subOn: Map<string, number>;
  subOff: Map<string, number>;
}

/** Player stat clamped to a plausible range (absurd → 0). */
function playerStat(st: Map<string, number>, k: string): number {
  const v = inRange(st.get(k), 0, PLAYER_STAT_MAX[k] ?? 50);
  return v !== undefined ? Math.round(v) : 0;
}

function playerLineOf(p: RawRosterEntry, c: PlayerLineCtx): PlayerLine | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const { match, teamId, opponentId, isHome, fullTime, subOn, subOff } = c;
  if (p.athlete?.id === undefined || p.athlete?.id === null || p.athlete?.id === '') return undefined;
  const pid = cleanId(p.athlete.id);
  if (!pid) {
    warnNormalize('jugador descartado: id no válido', String(p.athlete.id).slice(0, 40));
    return undefined;
  }
  const starter = p.starter === true;
  if (!starter && p.subbedIn !== true) return undefined; // unused substitute
  const st = statMap(p.stats);
  const plays = (Array.isArray(p.plays) ? p.plays : []).filter((x) => x && typeof x === 'object');
  const subMinutes = plays.filter((x) => x.substitution).map((x) => parseMinute(x.clock?.displayValue, x.clock?.value));
  const redPlay = plays.find((x) => x.redCard);
  const redMinute = redPlay ? parseMinute(redPlay.clock?.displayValue, redPlay.clock?.value) : undefined;

  let start = 0;
  let end = fullTime;
  if (starter) {
    if (p.subbedOut) end = subMinutes[0] ?? subOff.get(String(pid)) ?? fullTime;
  } else {
    start = subMinutes[0] ?? subOn.get(String(pid)) ?? fullTime;
    if (p.subbedOut) end = subMinutes[1] ?? subOff.get(String(pid)) ?? fullTime;
  }
  if (redMinute !== undefined && redMinute >= start && redMinute < end) end = redMinute;
  end = Math.min(end, fullTime);
  const minutes = Math.max(1, Math.round(end - start));

  let position = mapPosition(typeof p.position?.abbreviation === 'string' ? p.position.abbreviation : undefined);
  const isKeeper = position === 'G' || (position === '?' && st.has('saves'));
  if (isKeeper) position = 'G';

  // a player without a usable name (e.g. displayName "<>" that sanitises to nothing) keeps his stats under a neutral
  // label instead of being published with an empty name
  let name = cleanText(p.athlete?.displayName) ?? cleanText(p.athlete?.shortName) ?? '';
  if (!name) {
    warnNormalize('jugador sin nombre (se publica como "Jugador <id>")', pid);
    name = `Jugador ${pid}`;
  }
  const line: PlayerLine = {
    matchId: match.id,
    compId: match.compId,
    date: match.date,
    teamId,
    opponentId,
    isHome,
    playerId: pid,
    name,
    short: cleanText(p.athlete?.shortName, 60) ?? name,
    position,
    starter,
    minutes,
    goals: playerStat(st, 'totalGoals'),
    assists: playerStat(st, 'goalAssists'),
    shots: playerStat(st, 'totalShots'),
    shotsOnTarget: playerStat(st, 'shotsOnTarget'),
    yellow: playerStat(st, 'yellowCards'),
    red: playerStat(st, 'redCards'),
    foulsCommitted: playerStat(st, 'foulsCommitted'),
    foulsSuffered: playerStat(st, 'foulsSuffered'),
    offsides: playerStat(st, 'offsides'),
    ownGoals: playerStat(st, 'ownGoals'),
  };
  if (line.shotsOnTarget > line.shots) line.shots = line.shotsOnTarget;
  if (isKeeper) {
    if (st.has('saves')) line.saves = playerStat(st, 'saves');
    if (st.has('goalsConceded')) line.goalsConceded = playerStat(st, 'goalsConceded');
  }
  return line;
}

/** true when a summary carried something worth persisting (players or extended stats). */
export function summaryHasContent(res: SummaryResult): boolean {
  return res.players.length > 0 || !!res.stats;
}

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------
const NOTE_PHRASES: [RegExp, string][] = [
  [/Qualifies for MLS Cup Playoffs - Round One Best-of-3 series/i, 'Playoffs MLS (primera ronda)'],
  [/Qualifies for MLS Cup Playoffs - Wild Card Matches/i, 'Playoffs MLS (comodín)'],
  [/Knockout phase playoffs - seeded/i, 'Playoff eliminatorio (cabeza de serie)'],
  [/Knockout phase playoffs - unseeded/i, 'Playoff eliminatorio (sin cabeza de serie)'],
  [/Qualifies for Sudamericana KO Playoffs/i, 'Playoff de la Sudamericana'],
  [/Qualifies for KO Playoffs/i, 'Playoff eliminatorio'],
  [/Qualifies for round of 16/i, 'Octavos de final'],
  [/Qualifies for QFs/i, 'Cuartos de final'],
  [/Champions League qualifying/i, 'Previa de Champions League'],
  [/Europa League qualifying/i, 'Previa de Europa League'],
  [/Conference League qualifying/i, 'Previa de Conference League'],
  [/Relegation or playoffs/i, 'Descenso o playoff'],
  [/Relegation playoffs?/i, 'Playoff de descenso'],
  [/Promotion playoffs?/i, 'Playoff de ascenso'],
  [/Relegated/i, 'Descendido'],
  [/Relegation/i, 'Descenso'],
  [/Promoted/i, 'Ascendido'],
  [/Promotion/i, 'Ascenso'],
  [/Eliminated/i, 'Eliminado'],
  [/Libertadores qualifying/i, 'Previa de Libertadores'],
  [/Champion/i, 'Campeón'],
];

export function translateNote(desc: string): string {
  let out = cleanText(desc) ?? '';
  for (const [re, es] of NOTE_PHRASES) {
    // "Champions League" contains "Champion": only translate "Champion" when it is the whole label
    if (es === 'Campeón' && !/^Champions?$/i.test(out.trim())) continue;
    out = out.replace(new RegExp(re.source, 'gi'), es);
  }
  return cleanText(out) ?? '';
}

function normalizeNoteColor(c: string | undefined): string | undefined {
  const h = cleanHex(c);
  return h ? `#${h}` : undefined;
}

export function translateGroupName(name: string | undefined, groupCount: number, compName?: string): string {
  const n = cleanText(name, 60) ?? '';
  let m = /^Group\s+(.+)$/i.exec(n);
  if (m) return `Grupo ${m[1]}`;
  if (/^League Phase$/i.test(n)) return 'Fase de liga';
  m = /^(Eastern|Western)\s+Conference$/i.exec(n);
  if (m) return m[1].toLowerCase() === 'eastern' ? 'Conferencia Este' : 'Conferencia Oeste';
  m = /^(\d{4})\s+Torneo\s+(Apertura|Clausura)$/i.exec(n);
  if (m) return `${m[2].charAt(0).toUpperCase()}${m[2].slice(1).toLowerCase()} ${m[1]}`;
  if (groupCount <= 1) return compName ?? (n || 'Clasificación');
  return n || 'Clasificación';
}

/** Integer stat of a standings row within [lo, hi]; absurd values → fallback. */
function tableInt(st: Map<string, number>, k: string, lo: number, hi: number, fallback = 0): number {
  const v = inRange(st.get(k), lo, hi);
  return v !== undefined ? Math.round(v) : fallback;
}

/** Standings row, or a reason string when the entry must be discarded. */
function standingRow(e: RawStandingEntry, idx: number): StandingRow | string {
  if (!e || typeof e !== 'object') return 'fila no es un objeto';
  const team = teamRef(e.team);
  if (!team.id || !team.name) return 'equipo sin id o nombre válido';
  const st = statMap(e.stats);
  const gf = tableInt(st, 'pointsFor', 0, 500);
  const ga = tableInt(st, 'pointsAgainst', 0, 500);
  const row: StandingRow = {
    rank: tableInt(st, 'rank', 1, 500, idx + 1),
    team,
    played: tableInt(st, 'gamesPlayed', 0, 200),
    won: tableInt(st, 'wins', 0, 200),
    drawn: tableInt(st, 'ties', 0, 200),
    lost: tableInt(st, 'losses', 0, 200),
    gf,
    ga,
    gd: tableInt(st, 'pointDifferential', -500, 500, gf - ga),
    points: tableInt(st, 'points', -100, 600),
  };
  const note = e.note && typeof e.note === 'object' ? e.note : undefined;
  const label = typeof note?.description === 'string' ? translateNote(note.description) : '';
  if (label) row.note = { label, color: normalizeNoteColor(note?.color) ?? '#94a3b8' };
  return row;
}

/**
 * Normalize the standings payload: one group per `children[]` (or the root `standings` when there
 * are no children), rows sorted by rank. `compName` names single-table leagues.
 */
export function normalizeStandings(raw: unknown, compName?: string): StandingGroup[] {
  const s = (raw && typeof raw === 'object' ? raw : {}) as RawStandings;
  const rootEntries = Array.isArray(s.standings?.entries) ? s.standings.entries : [];
  const children: RawStandingsChild[] = (Array.isArray(s.children) && s.children.length
    ? s.children
    : rootEntries.length
      ? [{ name: s.name, standings: s.standings }]
      : []
  ).filter((ch) => ch && typeof ch === 'object');
  const groups: StandingGroup[] = [];
  for (const ch of children) {
    const entries = Array.isArray(ch.standings?.entries) ? ch.standings.entries : [];
    if (!entries.length) continue;
    const parsed: { row: StandingRow; i: number }[] = [];
    entries.forEach((e, i) => {
      try {
        const r = standingRow(e, i);
        if (typeof r === 'string') warnNormalize(`fila de clasificación descartada: ${r}`);
        else parsed.push({ row: r, i });
      } catch (err) {
        warnNormalize('fila de clasificación descartada: error inesperado', errMsg(err));
      }
    });
    if (!parsed.length) continue;
    const rows = parsed.sort((a, b) => a.row.rank - b.row.rank || a.i - b.i).map((x) => x.row);
    groups.push({ name: translateGroupName(ch.name ?? ch.abbreviation, children.length, compName), rows });
  }
  return groups;
}
