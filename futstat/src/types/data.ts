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
 *  public/data/daily.json                    -> DailyFile        (best picks of the day, all markets, per match)
 *  public/data/longshots.json                -> LongshotFile     (high-odds bets >= 6: accumulators and singles)
 *  public/data/confidence.json               -> ConfidenceFile   (high-confidence picks + honest out-of-sample record)
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
  /**
   * best HIGH-CONFIDENCE pick of an upcoming match, if any (see ConfidencePick). Not related to `confidence` below:
   * a very likely, low-odds selection whose rule hit >= 80 % out of sample (no edge over the bookmaker, no profit
   * guarantee).
   */
  safe?: ConfidencePick;
  /** 0..1 — how sure the model is (agreement between sources × data volume) */
  confidence: number;
}

// ---------------------------------------------------------------------------
// High-confidence picks (pipeline/analytics/confidence.ts)
// ---------------------------------------------------------------------------

/** only 'oro' is published since 2026-11-18; 'plata' is kept for compatibility with older files and never shown */
export type ConfidenceTier = 'oro' | 'plata';
/** prediction source: 'mercado' = the ensemble used de-vigged bookmaker odds; 'estadistico' = Dixon-Coles + Elo only */
export type ConfidenceSource = 'mercado' | 'estadistico';
/** themes of ConfidenceFile picks; the daily section (DailyFile) adds 'tiros', 'faltas' and 'jugadores' via DailyCategory */
export type ConfidenceTheme = 'resultado' | 'goles' | 'corners' | 'tarjetas';

/**
 * A very likely, low-odds selection: its rule (market family + prediction source) passed the out-of-sample validation
 * (>= 30 picks and >= 80 % in the monthly walk-forward) and its probability band hit >= 85 % in the history used to fit
 * the rule. High hit rate ≠ edge over the bookmaker ≠ profit: most of it is structural (see track.baseline).
 */
export interface ConfidencePick {
  /** stable family id: 'dc', 'dnb', 'ah+1.5', 'ou-1.5-over', 'team-score', 'corners-over-6.5', 'cards-over-1.5'... */
  family: string;
  /** Market.id with the same scheme as the match files ('dc', 'ou-1.5', 'team-home-ou-0.5', 'cards-ou-1.5'...) */
  marketId: string;
  /** market name (Spanish) */
  market: string;
  /** selection (Spanish, with team names), e.g. "Más de 1.5 goles", "Betis o empate (1X)" */
  selection: string;
  /** model probability (draw no bet: conditional on no draw) */
  prob: number;
  /** 1 / prob */
  fairOdds: number;
  /** bookmaker decimal odds when available (double chance / draw no bet: synthetic from the 1X2 prices) */
  marketOdds?: number;
  /** 'directa' = published price; 'sintetica' = combination of 1X2 prices (realisable) */
  oddsKind?: 'directa' | 'sintetica';
  /** always 'oro' in new files (its band hit >= 85 % in the history used to fit the rule) */
  tier: ConfidenceTier;
  /** hit rate of its band (oro/plata) of its family in the history used to fit the rule (in-sample for that history) */
  historicalHitRate: number;
  /** resolved selections of that band in that history */
  historicalN: number;
  /** model-probability threshold of the band (prob >= threshold) */
  threshold?: number;
  /** probability recalibrated with the history (Platt) */
  calibratedProb?: number;
  source?: ConfidenceSource;
  /**
   * OUT-OF-SAMPLE validation of its rule (family|source): published picks of the monthly walk-forward (rules refitted
   * each month with all previous matches). Production only publishes rules with >= 30 resolved picks and >= 80 %.
   * The UI shows no own hit rate when validationN < 50 ("muestra pequeña").
   */
  validationHitRate?: number;
  validationN?: number;
  validationWilsonLow?: number;
  validationWilsonHigh?: number;
  /**
   * HOLDOUT record of its family (all sources; rules fitted on the calibration window): hit rate, resolved picks and
   * 90 % Wilson interval. Absent when the family has no holdout picks.
   */
  holdoutHitRate?: number;
  holdoutN?: number;
  holdoutWilsonLow?: number;
  holdoutWilsonHigh?: number;
  /** base rate of its family in the holdout: its natural selection with no threshold, in every match with data */
  baseRate?: number;
  /** settled result (finished matches only): 'void' = stake returned (draw no bet on a draw) */
  result?: 'hit' | 'miss' | 'void';
}

/** Hit record of a set of picks. */
export interface ConfidenceRecord {
  /** picks published in the period (voids included) */
  picks: number;
  /** resolved picks (hit or miss; voids excluded) */
  n: number;
  hits: number;
  /** hits / n (0 when n = 0) */
  hitRate: number;
  /** 90 % Wilson interval of hitRate */
  wilsonLow?: number;
  wilsonHigh?: number;
  /** void picks (stake returned) */
  voids?: number;
  /** first and last match of the period (ISO) */
  from: string;
  to: string;
  /** matches evaluated in the period */
  matches?: number;
}

/** Record of one market family. */
export interface ConfidenceFamilyRow {
  family: string;
  label: string;
  theme: ConfidenceTheme;
  /** true if the production rules publish this family (for at least one source) */
  active: boolean;
  /**
   * PUBLISHED production rules per prediction source (empty when not active), with their out-of-sample validation in
   * the monthly walk-forward
   */
  thresholds: { source: ConfidenceSource; threshold: number; goldThreshold?: number; validationN?: number; validationHits?: number; validationHitRate?: number }[];
  /** rules of the procedure NOT published: not validated out of sample (< 30 picks or < 80 % in the walk-forward) */
  unpublished?: { source: ConfidenceSource; n: number; hits: number; hitRate?: number }[];
  /** excluded beforehand (documented decision), with the reason (Spanish) */
  excluded?: string;
  /** lowest production threshold (undefined when not active) */
  threshold?: number;
  /** out-of-sample (holdout) picks of the family, published with rules fitted WITHOUT the holdout */
  picks: number;
  n: number;
  hits: number;
  /** hits / n — undefined when n = 0 */
  hitRate?: number;
  /** 90 % Wilson interval of hitRate */
  wilsonLow?: number;
  wilsonHigh?: number;
  /** mean fair odds of its holdout picks */
  avgFairOdds?: number;
  /** base rate of the family in the holdout (natural selection, no threshold, every match with data) and its n */
  baseRate?: number;
  baseN?: number;
  /** hitRate − baseRate (proportion points) */
  lift?: number;
  /** published picks of the family in the monthly walk-forward */
  walkForward?: { n: number; hits: number; hitRate: number; wilsonLow?: number; wilsonHigh?: number };
  /** why it is not published / caveat (Spanish) */
  note?: string;
}

/** Model-free baseline: the same fixed selections in every match. */
export interface ConfidenceBaseline {
  /** what it bets (Spanish) */
  label: string;
  picks: number;
  n: number;
  hits: number;
  hitRate: number;
  wilsonLow?: number;
  wilsonHigh?: number;
  matches?: number;
}

export interface ConfidenceFile {
  generatedAt: string;
  /** upcoming picks (next 14 days), chronological; at most 2 per match, of different themes */
  picks: { match: MatchSummary; pick: ConfidencePick }[];
  /**
   * settled picks of the last 14 days, most recent first: walk-forward reconstruction (prediction with data prior to
   * each match, closing odds, rules fitted without these matches). `hit` is false for voids (pick.result = 'void').
   */
  recent: { match: MatchSummary; pick: ConfidencePick; hit: boolean }[];
  /** honest out-of-sample record */
  track: {
    /** HOLDOUT: matches never used to choose anything (rules fitted on the older calibration window) */
    holdout: ConfidenceRecord;
    /** final part of the holdout, seen for the first time with the published figure */
    virgin?: ConfidenceRecord;
    /** calibration window (used to fit the rules that are measured on the holdout) */
    calibration?: { from: string; to: string; matches: number };
    /** holdout by tier (only 'oro' in new files) */
    byTier: ({ tier: ConfidenceTier } & Omit<ConfidenceRecord, 'from' | 'to' | 'matches'>)[];
    /** holdout by prediction source */
    bySource?: ({ source: ConfidenceSource } & Omit<ConfidenceRecord, 'from' | 'to' | 'matches'>)[];
    byFamily: ConfidenceFamilyRow[];
    coverage: {
      /** picks per calendar day of the holdout */
      picksPerDay: number;
      /** picks per day with matches */
      picksPerMatchDay?: number;
      matches?: number;
      matchesWithPick?: number;
    };
    /** mean fair odds of the holdout picks */
    avgFairOdds: number;
    /** mean model probability of the holdout picks */
    avgProb?: number;
    /** flat 1-unit stake with closing odds, only where a price exists */
    roi?: { bets: number; roi: number; profit?: number; hitRate?: number; avgOdds?: number; synthetic?: number };
    /** model-free baseline in the same holdout matches */
    baseline?: ConfidenceBaseline;
    /** hit rate if every pick hit like its family's base rate (weighted by resolved picks), and hitRate − that */
    expectedBaseRate?: number;
    lift?: number;
    /** monthly walk-forward of the whole procedure (published picks; rules refitted each month and validated) */
    walkForward?: ConfidenceRecord & {
      folds: { start: string; end: string; matches: number; picks: number; n: number; hits: number; hitRate: number }[];
      /** flat 1-unit stake with closing odds over the walk-forward picks that have a price */
      roi?: { bets: number; roi: number; profit?: number; hitRate?: number; avgOdds?: number; synthetic?: number };
    };
    /** rules excluded beforehand */
    excluded?: { family: string; label: string; reason: string }[];
  };
  /** production rules (same procedure fitted with ALL the history) */
  rules: {
    /** level of the pre-registered ladder (0 = 0.82 target) */
    level: number;
    targetRate: number;
    /** history used */
    from: string;
    to: string;
    matches: number;
    /** active (published) family|source rules */
    active: number;
    /** rules of the procedure not published for lack of out-of-sample validation */
    unvalidated?: number;
    /** out-of-sample validation required to publish a rule (walk-forward) */
    validation?: { minN: number; minRate: number };
    maxPerMatch: number;
    /** minimum in-history hit rate of a published band (0.85: only 'oro') */
    minHitRate: number;
  };
  /** short Spanish caveat for the UI */
  note: string;
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
  /**
   * high-confidence picks of the match (at most 2). Upcoming: production rules. Finished: walk-forward reconstruction
   * with `result` (rules fitted without the match).
   */
  confidence?: ConfidencePick[];
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
  /** best high-confidence picks of the next 72 h (max 8, one per match, chronological) */
  topConfidence?: { match: MatchSummary; pick: ConfidencePick }[];
  /** out-of-sample (holdout) record of the high-confidence picks */
  /** "Pronósticos del día" teaser: best picks of today (or of the next day with matches), from daily.json */
  daily?: { date: string; matches: number; picks: number; top: { match: MatchSummary; pick: DailyPick }[] };
  /** "Cuota alta 6+" teaser: best high-odds bet of today (or next day with matches), from longshots.json */
  longshot?: { date: string; bets: number; best?: LongshotBet };
  confidenceHeadline?: {
    hitRate: number;
    /** resolved holdout picks */
    picks: number;
    hits: number;
    /** 90 % Wilson interval */
    wilsonLow?: number;
    wilsonHigh?: number;
    /** model-free baseline hit rate in the same matches and mean fair odds of the picks */
    baselineRate?: number;
    avgFairOdds?: number;
    from: string;
    to: string;
    /** upcoming picks published (next 14 days) */
    upcoming?: number;
  };
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

// ---------------------------------------------------------------------------
// Daily best picks — "Pronósticos del día" (public/data/daily.json)
// ---------------------------------------------------------------------------

/** Market category of a daily pick. 'jugadores' = player props (shots on target, shots, goal). */
export type DailyCategory = 'resultado' | 'goles' | 'tiros' | 'corners' | 'tarjetas' | 'faltas' | 'jugadores';

/**
 * A pick of the daily section: a validated high-confidence selection (same rules as ConfidencePick: its family passed
 * the out-of-sample validation) plus what the page needs to explain it.
 */
export interface DailyPick extends ConfidencePick {
  category: DailyCategory;
  /** one short Spanish sentence with the numbers behind the pick ("El Madrid promedia 6,7 tiros a puerta en casa…") */
  reason?: string;
  /** player props only. If the player does not take part, bookmakers usually void the bet. */
  player?: { id: string; name: string; short: string; teamId: string; position?: string; expMinutes?: number };
  /** 0..100 ranking score (calibrated probability, out-of-sample record of its family, lift over its base rate) */
  score?: number;
  /**
   * validationHitRate − baseRate, in proportion points (unsettled picks only). In daily picks `baseRate` is the base rate
   * of the family in the walk-forward matches (its natural selection with no threshold). <= 0: purely structural hit rate.
   */
  lift?: number;
}

/** Expected numbers of the match (model projections), for context next to the picks. */
export interface DailyExpected {
  goals: { home: number; away: number; total: number };
  shotsOnTarget?: { home: number; away: number; total: number };
  shots?: { home: number; away: number; total: number };
  corners?: { home: number; away: number; total: number };
  cards?: { home: number; away: number; total: number };
  fouls?: { home: number; away: number; total: number };
}

export interface DailyMatch {
  match: MatchSummary;
  /** validated picks of this match, best first (at most 2 per category and 8 in total) */
  picks: DailyPick[];
  expected: DailyExpected;
  /** 2–5 short Spanish bullets: the reading of the match across markets (goals, shots, corners, cards, players) */
  analysis: string[];
}

/** Suggested accumulator: legs from DIFFERENT matches (independent), with the combined probability. */
export interface DailyCombo {
  id: string; // 'segura' | 'equilibrada' | 'atrevida'
  label: string; // "Combinada segura"
  legs: { matchId: string; home: string; away: string; compName: string; pick: DailyPick }[];
  /** product of the calibrated probabilities of the legs */
  prob: number;
  fairOdds: number;
  /** product of bookmaker odds when every leg has one */
  marketOdds?: number;
}

export interface DailyDay {
  /** local date YYYY-MM-DD in the home time zone (Europe/Madrid) */
  date: string;
  /** matches of the day with at least one pick: competition prestige first, then kick-off */
  matches: DailyMatch[];
  /** best picks of the day (max 10), best first; at most one per match */
  top: { matchId: string; pick: DailyPick }[];
  /** 0–3 suggested accumulators */
  combos: DailyCombo[];
  counts: { matches: number; picks: number; matchesAnalyzed: number };
}

export interface DailyFile {
  generatedAt: string;
  /** today and the next days with matches (at most 4 days), chronological */
  days: DailyDay[];
  /** categories in display order with their Spanish label */
  categories: { id: DailyCategory; label: string }[];
  /**
   * OUT-OF-SAMPLE record of the daily selection rule itself (every validated pick, up to 2 per category and 8 per
   * match), from the monthly walk-forward: overall, by category, and for the accumulators.
   */
  track: {
    overall: ConfidenceRecord;
    byCategory: ({ category: DailyCategory; label: string; baseRate?: number } & Omit<ConfidenceRecord, 'from' | 'to' | 'matches'>)[];
    /** how often each kind of accumulator would have hit (all legs), walk-forward */
    combos?: { id: string; label: string; days: number; hits: number; hitRate: number; avgLegs: number; avgFairOdds: number }[];
    /** model-free baseline for context (same idea as ConfidenceFile.track.baseline) */
    baseline?: ConfidenceBaseline;
  };
  /** Spanish caveat shown on the page (high hit rate ≠ edge over the bookmaker; +18; lineups) */
  note: string;
}

// ---------------------------------------------------------------------------
// High-odds bets — "Cuota alta 6+" (public/data/longshots.json)
// ---------------------------------------------------------------------------

/**
 * Kind of high-odds bet:
 *  - 'combinada'   accumulator of 2–4 legs from DIFFERENT matches whose combined odds reach the minimum
 *  - 'sorpresa'    single 1X2 selection with odds >= minimum (an underdog win, sometimes a draw)
 *  - 'marcador'    single exact score
 *  - 'goleador'    single player to score
 *  - 'otro'        any other single market (e.g. half-time/full-time, winning margin)
 */
export type LongshotKind = 'combinada' | 'sorpresa' | 'marcador' | 'goleador' | 'otro';

export interface LongshotLeg {
  matchId: string;
  compId: string;
  compName: string;
  date: string;
  home: TeamRef;
  away: TeamRef;
  market: string; // Spanish, e.g. "Resultado final (1X2)"
  selection: string; // Spanish, e.g. "Gana Lille"
  /** model probability of this leg (calibrated where a calibration exists) */
  prob: number;
  fairOdds: number;
  /** bookmaker decimal odds when ESPN publishes the market (1X2, totals, spread); otherwise absent */
  marketOdds?: number;
  category?: DailyCategory;
  /** player of a goalscorer leg (if he does not play, bookmakers usually void the bet) */
  player?: { id: string; name: string; short: string; teamId: string };
}

export interface LongshotBet {
  id: string;
  kind: LongshotKind;
  /** Spanish title, e.g. "Combinada de 3 partidos", "Sorpresa: gana Lille", "Marcador exacto 2-1" */
  label: string;
  legs: LongshotLeg[]; // 1 for singles
  /** probability of the whole bet (product of the legs for accumulators) */
  prob: number;
  /** 1 / prob */
  fairOdds: number;
  /** bookmaker odds of the whole bet when every leg has one (product for accumulators) */
  marketOdds?: number;
  /** odds used for the >= minimum rule and for display: marketOdds when known, else fairOdds */
  displayOdds: number;
  /** expected value per unit staked at marketOdds: prob·marketOdds − 1 (only when marketOdds) */
  ev?: number;
  /** "1 de cada N" helper: round(1 / prob) */
  oneIn: number;
  /** 0..100 ranking score */
  score: number;
  /** one or two Spanish sentences with the numbers behind the bet */
  reason: string;
  /** settled result for finished matches: all legs hit / any leg missed / void legs make it 'void' */
  result?: 'hit' | 'miss' | 'void';
}

export interface LongshotDay {
  /** local date YYYY-MM-DD (Europe/Madrid) */
  date: string;
  /** best bets of the day, best first (max ~12; at most 4 per kind) */
  bets: LongshotBet[];
}

/** Out-of-sample record of one kind (walk-forward: the same daily rule applied to past days with data prior to each match). */
export interface LongshotRecord {
  kind: LongshotKind;
  label: string;
  bets: number;
  hits: number;
  /** hits / settled bets */
  hitRate: number;
  wilsonLow?: number;
  wilsonHigh?: number;
  /** mean model probability of those bets: compare with hitRate (calibration) */
  expectedHitRate: number;
  /** mean odds used (displayOdds) */
  avgOdds: number;
  /** flat 1-unit staking against bookmaker CLOSING odds, only on bets where every leg had a price */
  roi?: { bets: number; staked: number; profit: number; roi: number };
  /** longest losing streak observed (bets) — to set expectations */
  longestLosingStreak?: number;
}

export interface LongshotFile {
  generatedAt: string;
  /** minimum odds of the section (6) */
  minOdds: number;
  /** today and the next days with matches (max 4), chronological */
  days: LongshotDay[];
  track: {
    from: string;
    to: string;
    byKind: LongshotRecord[];
    /** calibration of the model in the low-probability band (predicted vs observed), all kinds pooled */
    calibration: CalibrationBin[];
  };
  /** Spanish warning shown prominently (+18, most of these bets lose, margin compounds in accumulators) */
  note: string;
}
