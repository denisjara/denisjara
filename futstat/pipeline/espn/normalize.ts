/**
 * ESPN JSON  ->  internal normalized records (pipeline/types.ts).
 *
 * Pure functions (no I/O). Raw ESPN payloads are typed loosely (`Raw*` interfaces below only
 * describe the fields we read). Everything user-visible produced here is Spanish.
 */
import type { CompetitionConfig } from '../config';
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
// Small helpers
// ---------------------------------------------------------------------------
function num(x: unknown): number | undefined {
  if (x === null || x === undefined || x === '') return undefined;
  const n = typeof x === 'number' ? x : Number(String(x).trim().replace(/%$/, ''));
  return Number.isFinite(n) ? n : undefined;
}

function r(x: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** ESPN dates are "2026-11-04T20:00Z" -> "2026-11-04T20:00:00Z". */
export function isoDate(d: string | undefined): string {
  if (!d) return '';
  const t = Date.parse(d);
  if (!Number.isFinite(t)) return d;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** "45'+2'" -> 45 ; "90'" -> 90 ; "" -> derived from clock seconds. */
export function parseMinute(display: string | undefined, clockSeconds?: number): number {
  const m = /^\s*(\d+)/.exec(display ?? '');
  if (m) return Number(m[1]);
  if (clockSeconds !== undefined && Number.isFinite(clockSeconds)) return Math.max(0, Math.ceil(clockSeconds / 60));
  return 0;
}

function statMap(stats: RawStat[] | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of stats ?? []) {
    if (!s?.name) continue;
    const v = num(s.value ?? s.displayValue);
    if (v !== undefined) m.set(s.name, v);
  }
  return m;
}

function cleanHex(c: string | undefined): string | undefined {
  if (!c) return undefined;
  const h = c.replace(/^#+/, '').trim();
  return /^[0-9a-fA-F]{6}$/.test(h) ? h.toLowerCase() : undefined;
}

function pickLogo(t: RawTeam): string | undefined {
  if (t.logo) return t.logo;
  const logos = t.logos ?? [];
  const def = logos.find((l) => l.rel?.includes('default')) ?? logos[0];
  return def?.href;
}

export function teamRef(t: RawTeam | undefined): TeamRef {
  const team = t ?? {};
  const name = team.displayName ?? team.name ?? team.shortDisplayName ?? '';
  const ref: TeamRef = {
    id: String(team.id ?? ''),
    name,
    short: team.shortDisplayName ?? name,
    abbr: team.abbreviation ?? name.slice(0, 3).toUpperCase(),
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
  const type = st?.type ?? {};
  const name = (type.name ?? '').toUpperCase();
  const state = type.state ?? 'pre';
  if (name.includes('POSTPONED')) return { status: 'postponed', detail: 'Aplazado' };
  if (name.includes('CANCELED') || name.includes('CANCELLED')) return { status: 'cancelled', detail: 'Cancelado' };
  if (name.includes('ABANDONED')) return { status: 'cancelled', detail: 'Suspendido' };
  if (state === 'in') {
    if (name.includes('HALFTIME')) return { status: 'live', detail: 'Descanso' };
    if (name.includes('SHOOTOUT')) return { status: 'live', detail: 'Penaltis' };
    return { status: 'live', detail: st?.displayClock || type.shortDetail || 'En juego' };
  }
  if (state === 'post') {
    if (type.completed === false) {
      if (name.includes('SUSPENDED') || name.includes('DELAYED')) return { status: 'postponed', detail: 'Suspendido' };
      return { status: 'cancelled', detail: type.shortDetail || 'Sin resultado' };
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
  const words = tok.replace(/-+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : undefined;
}

function translateLegNote(note: string | undefined): string | undefined {
  if (!note) return undefined;
  if (/^1st Leg/i.test(note)) return 'Ida';
  if (/^2nd Leg/i.test(note)) return 'Vuelta';
  return undefined;
}

export function roundLabel(seasonSlug: string | undefined, comp: RawCompetition | undefined): string | undefined {
  const parts: string[] = [];
  for (const tok of (seasonSlug ?? '').split('---')) {
    const t = translateRoundToken(tok.trim());
    if (t && !parts.includes(t)) parts.push(t);
  }
  // "Copa Chile, Group F" / "UEFA Nations League, Group A1"
  const group = /Group\s+([A-Z0-9]{1,3})\b/.exec(comp?.altGameNote ?? '');
  if (group) parts.push(`Grupo ${group[1]}`);
  const leg = translateLegNote(comp?.notes?.[0]?.headline ?? comp?.notes?.[0]?.text);
  if (leg) parts.push(leg);
  return parts.length ? parts.join(' · ') : undefined;
}

// ---------------------------------------------------------------------------
// Odds (American -> decimal; private implementation on purpose)
// ---------------------------------------------------------------------------
function americanToDecimalPrivate(ml: unknown): number | undefined {
  if (ml === null || ml === undefined) return undefined;
  const s = String(ml).trim().toUpperCase();
  if (s === 'EVEN' || s === 'EV') return 2;
  const v = Number(s.replace(/^\+/, ''));
  if (!Number.isFinite(v) || Math.abs(v) < 100) return undefined;
  const dec = v > 0 ? 1 + v / 100 : 1 + 100 / Math.abs(v);
  return r(dec, 3);
}

function parseLine(line: string | undefined): number | undefined {
  if (!line) return undefined;
  const m = /([+-]?\d+(?:\.\d+)?)/.exec(line.replace(/^[ou]/i, ''));
  return m ? Number(m[1]) : undefined;
}

function overroundOf(h?: number, d?: number, a?: number): number | undefined {
  if (!h || !d || !a) return undefined;
  return r(1 / h + 1 / d + 1 / a - 1, 4);
}

function isUsableOdds(s: OddsSnapshot): boolean {
  return s.home !== undefined || s.away !== undefined || s.over !== undefined || s.spreadHome !== undefined;
}

/** DraftKings-style entry (moneyline/total/pointSpread with open+close, or pickcenter flat fields). */
function snapshotFromAmerican(o: RawOdds, capturedAt: string): OddsSnapshot | undefined {
  const ml = o.moneyline;
  const s: OddsSnapshot = {
    provider: o.provider?.displayName ?? o.provider?.name ?? 'DraftKings',
    home: americanToDecimalPrivate(ml?.home?.close?.odds) ?? americanToDecimalPrivate(o.homeTeamOdds?.moneyLine),
    draw: americanToDecimalPrivate(ml?.draw?.close?.odds) ?? americanToDecimalPrivate(o.drawOdds?.moneyLine),
    away: americanToDecimalPrivate(ml?.away?.close?.odds) ?? americanToDecimalPrivate(o.awayTeamOdds?.moneyLine),
    homeOpen: americanToDecimalPrivate(ml?.home?.open?.odds),
    drawOpen: americanToDecimalPrivate(ml?.draw?.open?.odds),
    awayOpen: americanToDecimalPrivate(ml?.away?.open?.odds),
  };
  const overClose = o.total?.over?.close;
  const underClose = o.total?.under?.close;
  s.totalLine = parseLine(overClose?.line) ?? parseLine(underClose?.line) ?? num(o.overUnder);
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
  s.spreadLine = parseLine(spHome?.line) ?? (spAway?.line !== undefined ? negate(parseLine(spAway.line)) : num(o.spread));
  s.spreadHome = americanToDecimalPrivate(spHome?.odds) ?? americanToDecimalPrivate(o.homeTeamOdds?.spreadOdds);
  s.spreadAway = americanToDecimalPrivate(spAway?.odds) ?? americanToDecimalPrivate(o.awayTeamOdds?.spreadOdds);
  if (s.spreadHome === undefined && s.spreadAway === undefined) delete s.spreadLine;

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
    return v !== undefined && v > 1 ? r(v, 3) : undefined;
  };
  const s: OddsSnapshot = {
    provider: o.provider?.displayName ?? o.provider?.name ?? 'Bet 365',
    home: dec(o.homeTeamOdds),
    draw: dec(o.drawOdds),
    away: dec(o.awayTeamOdds),
  };
  if (s.home === undefined || s.draw === undefined || s.away === undefined) return undefined;
  s.margin = overroundOf(s.home, s.draw, s.away);
  s.capturedAt = capturedAt;
  return compact(s);
}

function hasAmerican(o: RawOdds): boolean {
  return !!(o.moneyline || o.total || o.pointSpread || o.homeTeamOdds?.moneyLine !== undefined || o.drawOdds?.moneyLine !== undefined);
}

/** Pre-match odds from the scoreboard: DraftKings first, Bet 365 (1X2 only) as fallback. */
export function oddsFromScoreboard(list: (RawOdds | null)[] | undefined, capturedAt: string): OddsSnapshot | undefined {
  const entries = (list ?? []).filter((o): o is RawOdds => !!o);
  for (const o of entries) {
    if (!hasAmerican(o)) continue;
    const s = snapshotFromAmerican(o, capturedAt);
    if (s) return s;
  }
  for (const o of entries) {
    const s = snapshotFromDecimal(o, capturedAt);
    if (s) return s;
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
  const lg = (raw as RawScoreboard)?.leagues?.[0];
  if (!lg) return undefined;
  const logos = lg.logos ?? [];
  const logo = logos.find((l) => l.rel?.includes('default') && !l.rel?.includes('dark')) ?? logos.find((l) => !l.rel?.includes('dark'));
  const logoDark = logos.find((l) => l.rel?.includes('dark'));
  const seasonName = lg.season?.displayName ?? '';
  let seasonLabel: string | undefined;
  const sm = /(\d{4})(?:\s*[-/]\s*(\d{2,4}))?/.exec(seasonName);
  if (sm) seasonLabel = sm[2] ? `${sm[1]}-${sm[2].slice(-2)}` : sm[1];
  return compact({
    name: lg.name,
    logo: logo?.href,
    logoDark: logoDark?.href,
    seasonYear: lg.season?.year,
    seasonLabel,
    seasonStart: lg.season?.startDate ? isoDate(lg.season.startDate) : undefined,
    seasonEnd: lg.season?.endDate ? isoDate(lg.season.endDate) : undefined,
  });
}

function scoreboardTeamStats(c: RawCompetitor): Omit<TeamMatchStats, 'goals'> & { covered: boolean } {
  const st = statMap(c.statistics);
  const poss = st.get('possessionPct');
  const shots = st.get('totalShots');
  const covered = (poss ?? 0) > 0 || (shots ?? 0) > 0;
  return {
    covered,
    shots,
    shotsOnTarget: st.get('shotsOnTarget'),
    corners: st.get('wonCorners'),
    fouls: st.get('foulsCommitted'),
    possession: poss,
  };
}

function eventFromDetail(d: RawDetail): MatchEventRecord | undefined {
  if (d.shootout) return undefined;
  let type: MatchEventRecord['type'];
  if (d.scoringPlay) type = d.ownGoal ? 'own-goal' : d.penaltyKick ? 'penalty' : 'goal';
  else if (d.redCard) type = 'red';
  else if (d.yellowCard) type = 'yellow';
  else return undefined;
  const ath = d.athletesInvolved?.[0];
  return compact({
    minute: parseMinute(d.clock?.displayValue, d.clock?.value),
    clock: d.clock?.displayValue || `${parseMinute(undefined, d.clock?.value)}'`,
    type,
    teamId: String(d.team?.id ?? ''),
    playerId: ath?.id ? String(ath.id) : undefined,
    player: ath?.displayName,
  });
}

const isGoal = (e: MatchEventRecord) => e.type === 'goal' || e.type === 'own-goal' || e.type === 'penalty';

/** ESPN `form` is most-recent FIRST; our contract is chronological (most recent LAST). */
function chronologicalForm(f: string | undefined): string | undefined {
  const s = (f ?? '').toUpperCase().replace(/[^WDL]/g, '');
  return s ? s.split('').reverse().join('') : undefined;
}

function normalizeEvent(ev: RawEvent, comp: CompetitionConfig, currentSeasonYear: number | undefined, capturedAt: string): MatchRecord | undefined {
  const c = ev.competitions?.[0];
  if (!ev.id || !c) return undefined;
  const seasonSlug = ev.season?.slug ?? '';
  if (seasonSlug === 'all-star-game') return undefined;
  const competitors = c.competitors ?? [];
  const homeC = competitors.find((x) => x.homeAway === 'home') ?? competitors[0];
  const awayC = competitors.find((x) => x.homeAway === 'away') ?? competitors[1];
  if (!homeC?.team?.id || !awayC?.team?.id || homeC === awayC) return undefined;

  const { status, detail } = mapStatus(c.status ?? ev.status);
  const home = teamRef(homeC.team);
  const away = teamRef(awayC.team);
  const season = ev.season?.year ?? currentSeasonYear ?? 0;

  const m: MatchRecord = {
    id: String(ev.id),
    compId: comp.id,
    season,
    currentSeason: currentSeasonYear !== undefined && season === currentSeasonYear,
    date: isoDate(ev.date),
    status,
    home,
    away,
  };
  if (detail) m.statusDetail = detail;
  const round = roundLabel(seasonSlug, c);
  if (round) m.round = round;
  if (c.neutralSite === true) m.neutral = true;
  const venue = c.venue?.fullName ?? ev.venue?.displayName;
  if (venue) m.venue = venue;

  const played = status === 'finished' || status === 'live';
  if (played) {
    const hs = num(homeC.score) ?? 0;
    const as = num(awayC.score) ?? 0;
    const score: NonNullable<MatchRecord['score']> = { home: hs, away: as };
    const ph = num(homeC.shootoutScore);
    const pa = num(awayC.shootoutScore);
    if (ph !== undefined && pa !== undefined) {
      score.penHome = ph;
      score.penAway = pa;
    }

    // events (goals & cards) from details
    const details = c.details ?? [];
    const events = details.map(eventFromDetail).filter((e): e is MatchEventRecord => !!e);
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

/**
 * Normalize a scoreboard payload (one `dates=` request) of a competition.
 * `currentSeason` = event season year equals `opts.currentSeasonYear` (default leagues[0].season.year).
 */
export function normalizeScoreboard(
  raw: unknown,
  comp: CompetitionConfig,
  opts: NormalizeScoreboardOptions = {},
): { league: CompetitionStore['league']; matches: MatchRecord[] } {
  const sb = (raw ?? {}) as RawScoreboard;
  const league = leagueInfo(sb);
  const currentSeasonYear = opts.currentSeasonYear ?? league?.seasonYear;
  const capturedAt = isoDate((opts.now ?? new Date()).toISOString());
  const seen = new Set<string>();
  const matches: MatchRecord[] = [];
  for (const ev of sb.events ?? []) {
    const m = normalizeEvent(ev, comp, currentSeasonYear, capturedAt);
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
  const g = (k: string) => st.get(k);
  const passes = g('totalPasses');
  const accurate = g('accuratePasses');
  let passPct: number | undefined;
  if (passes && accurate !== undefined && passes > 0) passPct = r(accurate / passes, 3);
  else if (g('passPct') !== undefined) passPct = g('passPct')! > 1 ? r(g('passPct')! / 100, 3) : g('passPct');
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
  if (k.shootout) return undefined;
  const t = (k.type?.type ?? '').toLowerCase();
  const text = (k.type?.text ?? '').toLowerCase();
  let type: MatchEventRecord['type'] | undefined;
  if (t === 'own-goal' || text === 'own goal') type = 'own-goal';
  else if (t.startsWith('penalty---scored') || text === 'penalty - scored') type = 'penalty';
  else if (k.scoringPlay || t === 'goal' || t.startsWith('goal---')) type = 'goal';
  else if (t === 'yellow-card' || text === 'yellow card') type = 'yellow';
  else if (t === 'red-card' || t === 'yellow-red-card' || text === 'red card') type = 'red';
  else if (t === 'substitution') type = 'sub';
  if (!type) return undefined;
  const p0 = k.participants?.[0]?.athlete;
  const p1 = k.participants?.[1]?.athlete;
  return compact({
    minute: parseMinute(k.clock?.displayValue, k.clock?.value),
    clock: k.clock?.displayValue || `${parseMinute(undefined, k.clock?.value)}'`,
    type,
    teamId: String(k.team?.id ?? ''),
    playerId: p0?.id ? String(p0.id) : undefined,
    player: p0?.displayName,
    playerOutId: type === 'sub' && p1?.id ? String(p1.id) : undefined,
  });
}

function detectExtraTime(raw: RawSummary, keyEvents: RawKeyEvent[]): boolean {
  const name = (raw.header?.competitions?.[0]?.status?.type?.name ?? '').toUpperCase();
  if (name.includes('AET') || name.includes('EXTRA')) return true;
  const etSignal = keyEvents.some((k) => {
    if (k.shootout || k.period?.number === 5) return false;
    if (k.period?.number === 3 || k.period?.number === 4) return true;
    if ((k.type?.type ?? '').includes('extra-time')) return true;
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
  const s = (raw ?? {}) as RawSummary;
  const homeId = match.home.id;
  const awayId = match.away.id;
  const keyEvents = s.keyEvents ?? [];
  const extraTime = detectExtraTime(s, keyEvents);
  const fullTime = extraTime ? 120 : 90;
  const out: SummaryResult = { extraTime, players: [] };

  // header: HT score, penalties, neutral
  const hc = s.header?.competitions?.[0];
  if (hc) {
    if (typeof hc.neutralSite === 'boolean') out.neutral = hc.neutralSite;
    const ch = hc.competitors?.find((c) => String(c.team?.id) === homeId) ?? hc.competitors?.find((c) => c.homeAway === 'home');
    const ca = hc.competitors?.find((c) => String(c.team?.id) === awayId) ?? hc.competitors?.find((c) => c.homeAway === 'away');
    const hHt = num(ch?.linescores?.[0]?.displayValue ?? ch?.linescores?.[0]?.value);
    const aHt = num(ca?.linescores?.[0]?.displayValue ?? ca?.linescores?.[0]?.value);
    if (hHt !== undefined && aHt !== undefined) out.ht = { home: hHt, away: aHt };
    const hp = num(ch?.shootoutScore);
    const ap = num(ca?.shootoutScore);
    if (hp !== undefined && ap !== undefined) out.pens = { home: hp, away: ap };
  }

  // boxscore team stats
  const teams = s.boxscore?.teams ?? [];
  const bh = teams.find((t) => String(t.team?.id) === homeId) ?? teams.find((t) => t.homeAway === 'home');
  const ba = teams.find((t) => String(t.team?.id) === awayId) ?? teams.find((t) => t.homeAway === 'away');
  const sh = boxscoreTeamStats(bh?.statistics, match.score?.home ?? 0);
  const sa = boxscoreTeamStats(ba?.statistics, match.score?.away ?? 0);
  if (sh && sa && (boxscoreCovered(sh) || boxscoreCovered(sa))) out.stats = { home: sh, away: sa };

  // key events
  const events = keyEvents.map(keyEventToRecord).filter((e): e is MatchEventRecord => !!e);
  if (events.length) out.events = events;

  // closing odds: pickcenter / odds entries with American prices (Bet 365 entries in a finished
  // match summary are in-play/settled prices and are ignored)
  const capturedAt = match.date || isoDate(new Date().toISOString());
  for (const o of [...(s.pickcenter ?? []), ...(s.odds ?? [])]) {
    if (!o || !hasAmerican(o)) continue;
    const snap = snapshotFromAmerican(o, capturedAt);
    if (snap && (snap.home !== undefined || snap.over !== undefined)) {
      out.closingOdds = snap;
      break;
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

  // players
  for (const team of s.rosters ?? []) {
    const teamId = String(team.team?.id ?? '');
    const isHome = teamId === homeId || (teamId !== awayId && team.homeAway === 'home');
    const opponentId = isHome ? awayId : homeId;
    for (const p of team.roster ?? []) {
      const pid = p.athlete?.id;
      if (!pid) continue;
      const starter = p.starter === true;
      if (!starter && p.subbedIn !== true) continue; // unused substitute
      const st = statMap(p.stats);
      const plays = p.plays ?? [];
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

      let position = mapPosition(p.position?.abbreviation);
      const isKeeper = position === 'G' || (position === '?' && st.has('saves'));
      if (isKeeper) position = 'G';

      const line: PlayerLine = {
        matchId: match.id,
        compId: match.compId,
        date: match.date,
        teamId,
        opponentId,
        isHome,
        playerId: String(pid),
        name: p.athlete?.displayName ?? '',
        short: p.athlete?.shortName ?? p.athlete?.displayName ?? '',
        position,
        starter,
        minutes,
        goals: st.get('totalGoals') ?? 0,
        assists: st.get('goalAssists') ?? 0,
        shots: st.get('totalShots') ?? 0,
        shotsOnTarget: st.get('shotsOnTarget') ?? 0,
        yellow: st.get('yellowCards') ?? 0,
        red: st.get('redCards') ?? 0,
        foulsCommitted: st.get('foulsCommitted') ?? 0,
        foulsSuffered: st.get('foulsSuffered') ?? 0,
        offsides: st.get('offsides') ?? 0,
        ownGoals: st.get('ownGoals') ?? 0,
      };
      if (isKeeper) {
        if (st.has('saves')) line.saves = st.get('saves');
        if (st.has('goalsConceded')) line.goalsConceded = st.get('goalsConceded');
      }
      out.players.push(line);
    }
  }
  return out;
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
  let out = desc;
  for (const [re, es] of NOTE_PHRASES) {
    // "Champions League" contains "Champion": only translate "Champion" when it is the whole label
    if (es === 'Campeón' && !/^Champions?$/i.test(out.trim())) continue;
    out = out.replace(new RegExp(re.source, 'gi'), es);
  }
  return out;
}

function normalizeNoteColor(c: string | undefined): string | undefined {
  const h = cleanHex(c);
  return h ? `#${h}` : undefined;
}

export function translateGroupName(name: string | undefined, groupCount: number, compName?: string): string {
  const n = (name ?? '').trim();
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

function standingRow(e: RawStandingEntry, idx: number): StandingRow {
  const st = statMap(e.stats);
  const g = (k: string) => st.get(k) ?? 0;
  const row: StandingRow = {
    rank: st.get('rank') || idx + 1,
    team: teamRef(e.team),
    played: g('gamesPlayed'),
    won: g('wins'),
    drawn: g('ties'),
    lost: g('losses'),
    gf: g('pointsFor'),
    ga: g('pointsAgainst'),
    gd: st.get('pointDifferential') ?? g('pointsFor') - g('pointsAgainst'),
    points: g('points'),
  };
  if (e.note?.description) {
    row.note = { label: translateNote(e.note.description), color: normalizeNoteColor(e.note.color) ?? '#94a3b8' };
  }
  return row;
}

/**
 * Normalize the standings payload: one group per `children[]` (or the root `standings` when there
 * are no children), rows sorted by rank. `compName` names single-table leagues.
 */
export function normalizeStandings(raw: unknown, compName?: string): StandingGroup[] {
  const s = (raw ?? {}) as RawStandings;
  const children: RawStandingsChild[] = s.children?.length
    ? s.children
    : s.standings?.entries?.length
      ? [{ name: s.name, standings: s.standings }]
      : [];
  const groups: StandingGroup[] = [];
  for (const ch of children) {
    const entries = ch.standings?.entries ?? [];
    if (!entries.length) continue;
    const rows = entries
      .map((e, i) => ({ row: standingRow(e, i), i }))
      .sort((a, b) => a.row.rank - b.row.rank || a.i - b.i)
      .map((x) => x.row);
    groups.push({ name: translateGroupName(ch.name ?? ch.abbreviation, children.length, compName), rows });
  }
  return groups;
}
