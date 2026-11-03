/**
 * FutStat Lab — DATA CONTRACT
 * ---------------------------------------------------------------------------
 * Every JSON file the pipeline writes under `public/data/` conforms to one of
 * the root types at the bottom of this file. The React app reads ONLY these
 * types. The pipeline (Node) produces them. Change this file only with care:
 * both sides depend on it.
 *
 * Conventions
 *  - All probabilities are numbers in [0, 1] (never percentages).
 *  - All odds are DECIMAL odds (e.g. 2.10). American odds are converted in the pipeline.
 *  - All dates are ISO-8601 UTC strings (e.g. "2026-11-04T20:00:00Z").
 *  - Rates "per match" unless the field name says otherwise (`per90`).
 *  - IDs are ESPN ids as strings (team, player, match). Competition ids are our
 *    own url-safe ids (see pipeline/config.ts), e.g. "laliga", "champions".
 *  - Optional fields are omitted (not null) when unknown.
 *  - User-facing strings produced by the pipeline (labels, explanations) are Spanish.
 *
 * Files
 *  public/data/meta.json                     -> MetaFile
 *  public/data/home.json                     -> HomeFile
 *  public/data/competitions/<compId>.json    -> CompetitionFile
 *  public/data/matches/<matchId>.json        -> MatchFile        (upcoming + recent matches with full analysis)
 *  public/data/teams/<teamId>.json           -> TeamFile
 *  public/data/players.json                  -> PlayersFile      (global player form leaderboard)
 *  public/data/value.json                    -> ValueFile        (all value bets across competitions)
 *  public/data/model.json                    -> ModelFile        (methodology + global backtest)
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export type CompetitionKind = 'league' | 'cup' | 'continental';

export interface CompetitionMeta {
  /** our url-safe id, e.g. "laliga" */
  id: string;
  /** ESPN league slug, e.g. "esp.1" */
  slug: string;
  name: string; // "LaLiga"
  shortName: string; // "LaLiga"
  country: string; // "España" | "Europa" | "Sudamérica" ...
  /** emoji flag or symbol for compact display */
  flag: string;
  kind: CompetitionKind;
  /** prestige weight 1..10 used by the popularity ranking and ordering in menus */
  tier: number;
  logo?: string;
  logoDark?: string;
  seasonLabel?: string; // "2026-27"
  /** true when a league table exists (leagues and league-phase competitions) */
  hasTable: boolean;
  /** true when a season Monte-Carlo simulation is published */
  hasSimulation: boolean;
  /** labels of simulated outcome columns (e.g. ["Campeón","Top 4","Descenso"]) */
  simulationColumns?: string[];
  upcomingCount: number; // scheduled matches in the next 14 days
  /** ISO date of the next scheduled match (may be beyond the 14-day window) */
  nextMatchDate?: string;
  finishedCount: number; // finished matches this season in our dataset
  /** Primary accent color (hex, without #) — optional cosmetic hint */
  color?: string;
  /**
   * ISO instant of the last SUCCESSFUL download of this competition from ESPN (not the build time: when ESPN is down
   * the build still runs with the stored data, and this date shows how old that data really is).
   */
  dataUpdatedAt?: string;
}

export interface TeamRef {
  id: string;
  name: string; // "Real Madrid"
  short: string; // "R. Madrid" (short display name)
  abbr: string; // "RMA"
  logo?: string;
  color?: string; // hex without '#'
}

export interface PlayerRef {
  id: string;
  name: string; // "Kylian Mbappé"
  short: string; // "K. Mbappé"
  /** "G" | "D" | "M" | "F" (goalkeeper/defender/midfielder/forward) */
  position: 'G' | 'D' | 'M' | 'F' | '?';
  teamId: string;
}

export type MatchStatus = 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled';
export type Outcome = 'W' | 'D' | 'L';

export interface Score {
  home: number;
  away: number;
  htHome?: number;
  htAway?: number;
  /** penalties shoot-out score when it happened */
  penHome?: number;
  penAway?: number;
}

/** Odds snapshot from a bookmaker feed (decimal odds). */
export interface OddsSnapshot {
  provider: string; // "DraftKings"
  home?: number;
  draw?: number;
  away?: number;
  homeOpen?: number;
  drawOpen?: number;
  awayOpen?: number;
  totalLine?: number; // e.g. 2.5
  over?: number;
  under?: number;
  overOpen?: number;
  underOpen?: number;
  /** Asian handicap line applied to HOME team (e.g. -0.5) */
  spreadLine?: number;
  spreadHome?: number;
  spreadAway?: number;
  /** bookmaker margin (overround - 1) on the 1X2 market */
  margin?: number;
  capturedAt?: string;
}

// ---------------------------------------------------------------------------
// Predictions
// ---------------------------------------------------------------------------

export interface Prob1X2 {
  home: number;
  draw: number;
  away: number;
}

/** Compact prediction shown in match lists/cards. */
export interface QuickPrediction {
  p: Prob1X2; // final ensemble probabilities
  /** expected goals used by the model for each side (λ) */
  xgHome: number;
  xgAway: number;
  over25: number;
  btts: number;
  /** most likely exact score, e.g. "1-1" */
  likelyScore: string;
  likelyScoreProb: number;
  expCorners?: number; // expected total corners
  expCards?: number; // expected total cards (yellow + red)
  /** de-vigged bookmaker probabilities when odds exist */
  market?: Prob1X2;
  /** best value selection for this match, if any (EV > threshold) */
  pick?: ValuePick;
  /** 0..1 — how sure the model is (agreement between sources × data volume) */
  confidence: number;
}

export interface ValuePick {
  marketId: string; // Market.id of the source market: "1x2", "ou-2.5", "btts", "ah-home--0.5", "corners-ou-9.5" ...
  market: string; // "Resultado final"
  selection: string; // "Local", "Más de 2.5", ...
  prob: number; // model probability
  odds: number; // bookmaker decimal odds
  fairOdds: number; // 1 / prob
  ev: number; // expected value per unit staked: prob*odds - 1
  kelly: number; // recommended stake fraction (fractional Kelly, already scaled), 0..1
  edge: number; // prob - impliedProb (raw implied 1/odds)
  confidence: 'alta' | 'media' | 'baja';
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

export interface MatchSummary {
  id: string;
  compId: string;
  compName: string;
  date: string;
  status: MatchStatus;
  /** live clock or status detail, e.g. "67'" | "FT" | "HT" */
  statusDetail?: string;
  round?: string; // matchday / stage label when known
  home: TeamRef;
  away: TeamRef;
  score?: Score;
  venue?: string;
  /** recent form strings "WWDLW" (most recent LAST) */
  homeForm?: string;
  awayForm?: string;
  prediction?: QuickPrediction;
  odds?: OddsSnapshot;
  /** 0..100 popularity score (used by "Partidos populares") */
  popularity?: number;
  /** true when public/data/matches/<id>.json exists */
  hasDetail: boolean;
  /** for finished matches that had a pre-match prediction: was the model's top pick right? */
  predictionHit?: boolean;
}

export interface MarketSelection {
  label: string; // "Local", "Empate", "Más de 2.5", "2-1" ...
  prob: number;
  fairOdds: number; // 1 / prob (capped at 1000)
  marketOdds?: number; // bookmaker decimal odds when available
  /** expected value per unit staked. For Asian lines with push/half outcomes this is the exact EV
   * (not prob*marketOdds-1, since `prob` there is the effective probability 1/fairOdds). */
  ev?: number;
  /** extra hint, e.g. line for handicap "(-0.5)" */
  note?: string;
}

export type MarketGroup =
  | 'Principales'
  | 'Goles'
  | 'Hándicap'
  | 'Marcador'
  | 'Mitades'
  | 'Equipos'
  | 'Córners'
  | 'Tarjetas'
  | 'Tiros'
  | 'Faltas';

export interface Market {
  id: string; // stable id: "1x2", "dc", "dnb", "ou-2.5", "btts", "ah-home--0.5", "cs", "htft", "corners-ou-9.5", ...
  group: MarketGroup;
  name: string; // "Resultado final (1X2)"
  selections: MarketSelection[];
  line?: number;
}

/** Projection for a countable match statistic (corners, cards, shots...). */
export interface StatProjection {
  key: 'corners' | 'cards' | 'shots' | 'shotsOnTarget' | 'fouls' | 'offsides';
  label: string; // "Córners"
  home: number; // expected value for home team
  away: number;
  total: number;
  /** distribution of the total, P(total = k), k = 0..maxK */
  totalDist: number[];
  /** over/under ladder for the total */
  lines: { line: number; over: number; under: number }[];
  /** P(home > away), P(equal), P(away > home) */
  most?: Prob1X2;
  /** league average total for context */
  leagueAvg?: number;
}

export interface FormMatch {
  matchId: string;
  date: string;
  compId: string;
  opponent: TeamRef;
  isHome: boolean;
  gf: number;
  ga: number;
  result: Outcome;
  shots?: number;
  shotsOnTarget?: number;
  corners?: number;
  cornersAgainst?: number;
  cards?: number; // yellow + red received
  fouls?: number;
  /** possession on a 0..100 scale */
  possession?: number;
  /** model λ (xG proxy) for this team in that match, when available */
  xg?: number;
  xga?: number;
  /** true when public/data/matches/<matchId>.json exists */
  hasDetail?: boolean;
}

export interface TeamFormBlock {
  team: TeamRef;
  /** most recent FIRST, up to 10 */
  last: FormMatch[];
  /** "WWDLW" — most recent LAST (left→right chronological) for the last 5 */
  formString: string;
  ppg5: number;
  ppg10: number;
  gf5: number; // avg goals for, last 5
  ga5: number;
  /** 0..100 composite form index (see methodology) */
  formIndex: number;
  /** human readable streaks: "3 victorias seguidas", "5 partidos marcando" */
  streaks: string[];
  elo: number;
  /** last ~15 Elo values, chronological */
  eloTrend: number[];
  /** venue-specific split for this match (home team -> home games, away team -> away games) */
  venueSplit: { played: number; ppg: number; gf: number; ga: number };
}

export interface ComparisonRow {
  key: string;
  label: string; // "Goles a favor / partido"
  home: number;
  away: number;
  /** which direction is better for the team: 'high' | 'low' */
  better: 'high' | 'low';
  leagueAvg?: number;
  /** formatting hint. 'pct' values are shares in [0,1] (e.g. possession 0.55) */
  format?: 'int' | 'dec1' | 'dec2' | 'pct';
}

export interface PlayerProp {
  player: PlayerRef;
  apps: number;
  minutes: number;
  goals: number;
  assists: number;
  /** expected minutes in this match */
  expMinutes: number;
  formIndex: number; // 0..100
  pGoal: number; // anytime scorer
  pAssist: number;
  pGoalOrAssist: number;
  pShots1: number; // P(>=1 shot)
  pShots2: number; // P(>=2 shots)
  pSot1: number; // P(>=1 shot on target)
  pSot2: number; // P(>=2 shots on target)
  pCard: number; // P(booked)
  pFouls2?: number; // P(>=2 fouls committed)
}

export interface ModelBreakdown {
  lambdaHome: number;
  lambdaAway: number;
  rho: number;
  elo: { home: number; away: number; diff: number; probs: Prob1X2 };
  dixonColes?: { probs: Prob1X2; lambdaHome: number; lambdaAway: number };
  market?: { probs: Prob1X2; margin: number; method: string };
  ensemble: Prob1X2;
  weights: { dixonColes: number; elo: number; market: number };
  /** P(home goals = i, away goals = j), i,j in 0..maxGoals (inclusive). Typically 8x8 (0..7). */
  scoreMatrix: number[][];
  /** Spanish bullet points explaining the key factors */
  explanation: string[];
  /** data-volume based confidence 0..1 */
  confidence: number;
}

export interface H2HSummary {
  matches: MatchSummary[]; // most recent first (from our dataset; may be empty)
  homeWins: number;
  draws: number;
  awayWins: number;
  avgGoals: number;
  bttsPct: number;
  over25Pct: number;
}

export interface MatchFile {
  generatedAt: string;
  match: MatchSummary;
  model: ModelBreakdown;
  markets: Market[];
  projections: StatProjection[];
  form: { home: TeamFormBlock; away: TeamFormBlock };
  h2h: H2HSummary;
  comparison: ComparisonRow[];
  players: { home: PlayerProp[]; away: PlayerProp[] };
  valueBets: ValuePick[];
  /** standings context when the competition has a table */
  table?: { group: string; homeRank?: number; awayRank?: number; rows: StandingRow[] };
  /** For finished matches: actual stats per team */
  actual?: { home: TeamMatchStatsPublic; away: TeamMatchStatsPublic };
  /** key events (goals, cards) for finished/live matches */
  events?: MatchEventPublic[];
}

export interface TeamMatchStatsPublic {
  goals: number;
  shots?: number;
  shotsOnTarget?: number;
  corners?: number;
  fouls?: number;
  yellow?: number;
  red?: number;
  offsides?: number;
  /** possession on a 0..100 scale */
  possession?: number;
  saves?: number;
  passes?: number;
  passPct?: number;
  tackles?: number;
}

export interface MatchEventPublic {
  minute: string; // "45'+2'"
  type: 'goal' | 'own-goal' | 'penalty' | 'yellow' | 'red' | 'sub';
  teamId: string;
  player?: string;
  playerId?: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Competitions
// ---------------------------------------------------------------------------

export interface StandingRow {
  rank: number;
  team: TeamRef;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
  /** last 5 results, chronological "WWDLW" */
  form?: string;
  /** qualification/relegation zone note from the source */
  note?: { label: string; color: string };
  /** expected points from model λs over played matches (xPts) */
  xPts?: number;
  elo?: number;
}

export interface StandingGroup {
  name: string; // "LaLiga" or "Grupo A" / "Conferencia Este"
  rows: StandingRow[];
}

export interface SplitStat {
  all: number;
  home: number;
  away: number;
}

export interface TeamSeasonStats {
  team: TeamRef;
  played: SplitStat;
  /** per-match averages */
  goalsFor: SplitStat;
  goalsAgainst: SplitStat;
  xgFor: SplitStat; // model-based expected goals proxy
  xgAgainst: SplitStat;
  shots: SplitStat;
  shotsAgainst: SplitStat;
  shotsOnTarget: SplitStat;
  shotsOnTargetAgainst: SplitStat;
  corners: SplitStat;
  cornersAgainst: SplitStat;
  cards: SplitStat; // yellow + red received
  cardsAgainst: SplitStat; // cards received by opponents
  fouls: SplitStat;
  /** possession on a 0..100 scale */
  possession: SplitStat;
  /** shares 0..1 */
  over15Pct: number;
  over25Pct: number;
  over35Pct: number;
  bttsPct: number;
  cleanSheetPct: number;
  failedToScorePct: number;
  winPct: number;
  drawPct: number;
  lossPct: number;
  /** goals scored by minute buckets [0-15,16-30,31-45+,46-60,61-75,76-90+] (counts) */
  goalsByPeriod?: number[];
  concededByPeriod?: number[];
  formString: string;
  formIndex: number;
}

export interface TeamRating {
  team: TeamRef;
  elo: number;
  eloRank: number; // rank within competition
  globalEloRank?: number;
  /** Dixon-Coles attack/defence multipliers (1 = league average). Defence < 1 = better */
  attack?: number;
  defence?: number;
  /** chronological recent Elo values (up to 30) */
  eloHistory: { date: string; elo: number }[];
}

export interface SeasonSimulationRow {
  team: TeamRef;
  currentPoints: number;
  expectedPoints: number;
  expectedRank: number;
  /** keyed by MetaFile/CompetitionMeta.simulationColumns label */
  probs: Record<string, number>;
  /** positionDist[i] = P(final rank = i+1) */
  positionDist: number[];
}

export interface SeasonSimulation {
  iterations: number;
  group: string;
  columns: string[];
  rows: SeasonSimulationRow[];
  remainingMatches: number;
}

export interface PlayerSeasonRow {
  player: PlayerRef;
  team: TeamRef;
  compId: string;
  apps: number;
  starts: number;
  minutes: number;
  goals: number;
  assists: number;
  shots: number;
  shotsOnTarget: number;
  yellow: number;
  red: number;
  foulsCommitted: number;
  foulsSuffered: number;
  offsides: number;
  saves?: number;
  per90: {
    goals: number;
    assists: number;
    shots: number;
    shotsOnTarget: number;
    cards: number;
    foulsCommitted: number;
  };
  /** 0..100 composite form (recency weighted) */
  formIndex: number;
  /** last 5 match ratings 0..10, chronological */
  formTrend: number[];
  /** last 5 matches, most recent FIRST */
  last5: {
    matchId: string;
    date: string;
    opponent: string;
    minutes: number;
    goals: number;
    assists: number;
    shots: number;
    shotsOnTarget: number;
    cards: number;
    rating: number;
  }[];
}

export interface LeagueAverages {
  goalsPerMatch: number;
  homeGoals: number;
  awayGoals: number;
  homeWinPct: number;
  drawPct: number;
  awayWinPct: number;
  over25Pct: number;
  bttsPct: number;
  cornersPerMatch: number;
  cardsPerMatch: number;
  shotsPerMatch: number;
  shotsOnTargetPerMatch: number;
  foulsPerMatch: number;
}

export interface CalibrationBin {
  /** bin lower bound (e.g. 0.3 for 30-40%) */
  from: number;
  to: number;
  predicted: number; // mean predicted prob in bin
  observed: number; // observed frequency
  n: number;
}

export interface ScoreSet {
  brier: number; // multi-class Brier (sum over 3 outcomes), lower is better
  logLoss: number;
  rps: number; // ranked probability score, lower is better
  accuracy: number; // argmax hit rate
}

export interface BacktestSummary {
  matches: number;
  from: string;
  to: string;
  model: ScoreSet;
  elo?: ScoreSet;
  dixonColes?: ScoreSet;
  market?: ScoreSet; // only on matches with closing odds
  baseline: ScoreSet; // league base rates
  marketMatches?: number;
  calibration: CalibrationBin[];
  /** flat-stake simulation of value picks vs available odds */
  roi?: { bets: number; staked: number; profit: number; roi: number; hitRate: number; avgOdds: number };
  over25?: { brier: number; accuracy: number; n: number };
  btts?: { brier: number; accuracy: number; n: number };
}

export interface CompetitionFile {
  generatedAt: string;
  meta: CompetitionMeta;
  standings: StandingGroup[];
  /** scheduled matches (next 14 days), chronological */
  upcoming: MatchSummary[];
  /** finished matches (last 30 days), most recent FIRST */
  results: MatchSummary[];
  /** live right now at generation time */
  live: MatchSummary[];
  teams: TeamSeasonStats[];
  ratings: TeamRating[];
  simulations: SeasonSimulation[]; // one per standings group simulated (may be empty)
  /** top players of the competition (max ~150), sorted by formIndex desc */
  players: PlayerSeasonRow[];
  leagueAverages: LeagueAverages;
  backtest?: BacktestSummary;
  /** competition-level insights in Spanish ("El 58% de los partidos terminan con más de 2.5 goles") */
  insights: string[];
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export interface TeamFile {
  generatedAt: string;
  team: TeamRef;
  /** competitions the team appears in (our ids) */
  competitions: string[];
  primaryCompId: string;
  elo: number;
  globalEloRank: number;
  eloHistory: { date: string; elo: number }[];
  stats: TeamSeasonStats; // primary (domestic league) competition
  form: TeamFormBlock;
  /** every match of the season in our dataset, most recent FIRST */
  matches: FormMatch[];
  upcoming: MatchSummary[];
  players: PlayerSeasonRow[];
  standing?: StandingRow;
}

// ---------------------------------------------------------------------------
// Root files
// ---------------------------------------------------------------------------

export interface MetaFile {
  /** build time of the JSON files */
  generatedAt: string;
  /**
   * ISO instant of the most recent successful download from ESPN across competitions. The UI freshness indicator uses
   * it (falls back to generatedAt): a build made while ESPN was down must not look "updated a few minutes ago".
   */
  dataUpdatedAt?: string;
  version: string;
  dataSource: string; // "ESPN (API pública)"
  competitions: CompetitionMeta[];
  counts: {
    matchesAnalyzed: number; // finished matches in the dataset used for modelling
    upcomingMatches: number;
    teams: number;
    players: number;
    valueBets: number;
  };
  /** team search index */
  teams: { id: string; name: string; abbr: string; logo?: string; color?: string; compId: string }[];
}

export interface HomeFile {
  generatedAt: string;
  /** top matches next 72h by popularity (max 24) */
  popular: MatchSummary[];
  /** every match today (local Europe/Madrid day of generation) across competitions */
  today: MatchSummary[];
  /** every match tomorrow */
  tomorrow: MatchSummary[];
  /** recent finished matches (last 48h) incl. predictionHit when available */
  recent: MatchSummary[];
  /** best value picks next 72h (max 12), with the match they belong to */
  topValue: { match: MatchSummary; pick: ValuePick }[];
  /** best players in form across all competitions (max 12) */
  hotPlayers: PlayerSeasonRow[];
  /** short Spanish highlights for the day */
  highlights: string[];
  /** quick model accuracy headline across competitions */
  modelHeadline?: { matches: number; accuracy: number; rps: number; marketRps?: number };
}

export interface PlayersFile {
  generatedAt: string;
  /** up to ~600 players across all competitions, sorted by formIndex desc */
  players: PlayerSeasonRow[];
}

export interface ValueFile {
  generatedAt: string;
  bets: { match: MatchSummary; pick: ValuePick }[];
  /** settings used */
  minEv: number;
  kellyFraction: number;
  /** maximum stake fraction per bet */
  kellyCap?: number;
  minProb?: number;
  maxOdds?: number;
}

export interface ModelFile {
  generatedAt: string;
  /** Spanish markdown-ish sections explaining the methodology */
  sections: { title: string; body: string[] }[];
  backtest: BacktestSummary; // aggregated across competitions
  perCompetition: { compId: string; compName: string; backtest: BacktestSummary }[];
  parameters: Record<string, number | string>;
}
