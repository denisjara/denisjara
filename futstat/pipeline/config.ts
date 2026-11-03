/**
 * Pipeline configuration: competitions covered, model parameters and paths.
 * Competition ids are url-safe and are used in routes (/#/c/<id>) and file names.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompetitionKind } from '../src/types/data';

export interface CompetitionConfig {
  id: string;
  slug: string; // ESPN league slug
  name: string;
  shortName: string;
  country: string;
  flag: string;
  kind: CompetitionKind;
  tier: number; // 1..10 prestige (popularity + menu ordering)
  /** calendar-year season (South America, MLS) instead of Aug→May */
  calendarYear?: boolean;
  /** run season Monte Carlo + publish simulation columns */
  simulate?: boolean;
  /** outcome columns for the simulation: label -> rank range [from,to] (1-based, inclusive). Negative = from bottom. */
  simulationZones?: { label: string; from: number; to: number }[];
  /** fetch per-match summaries (player stats, extended team stats). Default true. */
  summaries?: boolean;
  /**
   * Competition between national teams (Nations League, Euro, World Cup...). They are kept out of the club Elo
   * ranking. Default: detected from the ESPN slug (see NATIONAL_TEAM_SLUGS in pipeline/analytics/ratings.ts).
   */
  nationalTeams?: boolean;
  /**
   * Cups: tier used for the initial Elo of teams that only appear in this cup (no league of theirs in the dataset,
   * e.g. non-league clubs in the FA Cup). Default MODEL.cupOnlyTier.
   */
  cupOnlyTier?: number;
}

export const COMPETITIONS: CompetitionConfig[] = [
  // ---- Ligas top Europa
  { id: 'laliga', slug: 'esp.1', name: 'LaLiga', shortName: 'LaLiga', country: 'España', flag: '🇪🇸', kind: 'league', tier: 10, simulate: true,
    simulationZones: [{ label: 'Campeón', from: 1, to: 1 }, { label: 'Champions', from: 1, to: 4 }, { label: 'Europa', from: 5, to: 6 }, { label: 'Descenso', from: -3, to: -1 }] },
  { id: 'premier', slug: 'eng.1', name: 'Premier League', shortName: 'Premier', country: 'Inglaterra', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', kind: 'league', tier: 10, simulate: true,
    simulationZones: [{ label: 'Campeón', from: 1, to: 1 }, { label: 'Champions', from: 1, to: 4 }, { label: 'Europa', from: 5, to: 6 }, { label: 'Descenso', from: -3, to: -1 }] },
  { id: 'seriea', slug: 'ita.1', name: 'Serie A', shortName: 'Serie A', country: 'Italia', flag: '🇮🇹', kind: 'league', tier: 9, simulate: true,
    simulationZones: [{ label: 'Campeón', from: 1, to: 1 }, { label: 'Champions', from: 1, to: 4 }, { label: 'Europa', from: 5, to: 6 }, { label: 'Descenso', from: -3, to: -1 }] },
  { id: 'bundesliga', slug: 'ger.1', name: 'Bundesliga', shortName: 'Bundesliga', country: 'Alemania', flag: '🇩🇪', kind: 'league', tier: 9, simulate: true,
    simulationZones: [{ label: 'Campeón', from: 1, to: 1 }, { label: 'Champions', from: 1, to: 4 }, { label: 'Europa', from: 5, to: 6 }, { label: 'Descenso', from: -2, to: -1 }] },
  { id: 'ligue1', slug: 'fra.1', name: 'Ligue 1', shortName: 'Ligue 1', country: 'Francia', flag: '🇫🇷', kind: 'league', tier: 8, simulate: true,
    simulationZones: [{ label: 'Campeón', from: 1, to: 1 }, { label: 'Champions', from: 1, to: 3 }, { label: 'Europa', from: 4, to: 5 }, { label: 'Descenso', from: -2, to: -1 }] },
  { id: 'eredivisie', slug: 'ned.1', name: 'Eredivisie', shortName: 'Eredivisie', country: 'Países Bajos', flag: '🇳🇱', kind: 'league', tier: 6, simulate: true,
    simulationZones: [{ label: 'Campeón', from: 1, to: 1 }, { label: 'Top 2', from: 1, to: 2 }, { label: 'Descenso', from: -2, to: -1 }] },
  { id: 'primeira', slug: 'por.1', name: 'Primeira Liga', shortName: 'Primeira', country: 'Portugal', flag: '🇵🇹', kind: 'league', tier: 6, simulate: true,
    simulationZones: [{ label: 'Campeón', from: 1, to: 1 }, { label: 'Top 2', from: 1, to: 2 }, { label: 'Descenso', from: -2, to: -1 }] },
  { id: 'superlig', slug: 'tur.1', name: 'Süper Lig', shortName: 'Süper Lig', country: 'Turquía', flag: '🇹🇷', kind: 'league', tier: 5, simulate: true,
    simulationZones: [{ label: 'Campeón', from: 1, to: 1 }, { label: 'Top 2', from: 1, to: 2 }, { label: 'Descenso', from: -4, to: -1 }] },
  { id: 'laliga2', slug: 'esp.2', name: 'LaLiga Hypermotion', shortName: 'LaLiga 2', country: 'España', flag: '🇪🇸', kind: 'league', tier: 4, simulate: true,
    simulationZones: [{ label: 'Ascenso directo', from: 1, to: 2 }, { label: 'Playoff', from: 3, to: 6 }, { label: 'Descenso', from: -4, to: -1 }] },
  { id: 'championship', slug: 'eng.2', name: 'Championship', shortName: 'Championship', country: 'Inglaterra', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', kind: 'league', tier: 4, simulate: true,
    simulationZones: [{ label: 'Ascenso directo', from: 1, to: 2 }, { label: 'Playoff', from: 3, to: 6 }, { label: 'Descenso', from: -3, to: -1 }] },
  { id: 'saudi', slug: 'ksa.1', name: 'Saudi Pro League', shortName: 'Saudi PL', country: 'Arabia Saudí', flag: '🇸🇦', kind: 'league', tier: 4, simulate: true,
    simulationZones: [{ label: 'Campeón', from: 1, to: 1 }, { label: 'Descenso', from: -3, to: -1 }] },
  // ---- América
  { id: 'brasileirao', slug: 'bra.1', name: 'Brasileirão Série A', shortName: 'Brasileirão', country: 'Brasil', flag: '🇧🇷', kind: 'league', tier: 7, calendarYear: true, simulate: true,
    simulationZones: [{ label: 'Campeón', from: 1, to: 1 }, { label: 'Libertadores', from: 1, to: 6 }, { label: 'Descenso', from: -4, to: -1 }] },
  { id: 'argentina', slug: 'arg.1', name: 'Liga Profesional Argentina', shortName: 'Argentina', country: 'Argentina', flag: '🇦🇷', kind: 'league', tier: 6, calendarYear: true, simulate: false },
  { id: 'ligamx', slug: 'mex.1', name: 'Liga MX', shortName: 'Liga MX', country: 'México', flag: '🇲🇽', kind: 'league', tier: 6, simulate: true,
    simulationZones: [{ label: 'Líder', from: 1, to: 1 }, { label: 'Liguilla directa', from: 1, to: 6 }, { label: 'Play-in', from: 7, to: 10 }] },
  { id: 'mls', slug: 'usa.1', name: 'MLS', shortName: 'MLS', country: 'EE. UU.', flag: '🇺🇸', kind: 'league', tier: 5, calendarYear: true, simulate: false },
  { id: 'chile', slug: 'chi.1', name: 'Primera División de Chile', shortName: 'Chile', country: 'Chile', flag: '🇨🇱', kind: 'league', tier: 5, calendarYear: true, simulate: true,
    simulationZones: [{ label: 'Campeón', from: 1, to: 1 }, { label: 'Libertadores', from: 1, to: 3 }, { label: 'Descenso', from: -2, to: -1 }] },
  // ---- Competiciones continentales
  { id: 'champions', slug: 'uefa.champions', name: 'UEFA Champions League', shortName: 'Champions', country: 'Europa', flag: '🇪🇺', kind: 'continental', tier: 10, simulate: true,
    simulationZones: [{ label: 'Top 8', from: 1, to: 8 }, { label: 'Playoff', from: 9, to: 24 }, { label: 'Eliminado', from: -12, to: -1 }] },
  { id: 'europa', slug: 'uefa.europa', name: 'UEFA Europa League', shortName: 'Europa League', country: 'Europa', flag: '🇪🇺', kind: 'continental', tier: 8, simulate: true,
    simulationZones: [{ label: 'Top 8', from: 1, to: 8 }, { label: 'Playoff', from: 9, to: 24 }, { label: 'Eliminado', from: -12, to: -1 }] },
  { id: 'conference', slug: 'uefa.europa.conf', name: 'UEFA Conference League', shortName: 'Conference', country: 'Europa', flag: '🇪🇺', kind: 'continental', tier: 6, simulate: true,
    simulationZones: [{ label: 'Top 8', from: 1, to: 8 }, { label: 'Playoff', from: 9, to: 24 }, { label: 'Eliminado', from: -12, to: -1 }] },
  { id: 'libertadores', slug: 'conmebol.libertadores', name: 'CONMEBOL Libertadores', shortName: 'Libertadores', country: 'Sudamérica', flag: '🌎', kind: 'continental', tier: 8, calendarYear: true },
  { id: 'sudamericana', slug: 'conmebol.sudamericana', name: 'CONMEBOL Sudamericana', shortName: 'Sudamericana', country: 'Sudamérica', flag: '🌎', kind: 'continental', tier: 6, calendarYear: true },
  { id: 'nations', slug: 'uefa.nations', name: 'UEFA Nations League', shortName: 'Nations League', country: 'Europa', flag: '🇪🇺', kind: 'continental', tier: 7, summaries: false },
  // ---- Copas nacionales
  { id: 'copadelrey', slug: 'esp.copa_del_rey', name: 'Copa del Rey', shortName: 'Copa del Rey', country: 'España', flag: '🇪🇸', kind: 'cup', tier: 6 },
  { id: 'facup', slug: 'eng.fa', name: 'FA Cup', shortName: 'FA Cup', country: 'Inglaterra', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', kind: 'cup', tier: 6 },
  { id: 'carabao', slug: 'eng.league_cup', name: 'Carabao Cup', shortName: 'Carabao', country: 'Inglaterra', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', kind: 'cup', tier: 5 },
  { id: 'coppaitalia', slug: 'ita.coppa_italia', name: 'Coppa Italia', shortName: 'Coppa Italia', country: 'Italia', flag: '🇮🇹', kind: 'cup', tier: 5 },
  { id: 'dfbpokal', slug: 'ger.dfb_pokal', name: 'DFB-Pokal', shortName: 'DFB-Pokal', country: 'Alemania', flag: '🇩🇪', kind: 'cup', tier: 5 },
  { id: 'copachile', slug: 'chi.copa_chi', name: 'Copa Chile', shortName: 'Copa Chile', country: 'Chile', flag: '🇨🇱', kind: 'cup', tier: 4, calendarYear: true },
];

export const COMPETITION_BY_ID = new Map(COMPETITIONS.map((c) => [c.id, c]));
export const COMPETITION_BY_SLUG = new Map(COMPETITIONS.map((c) => [c.slug, c]));

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..');
/** Incremental cache of fetched/normalized data (kept between daily runs via CI cache). */
export const STORE_DIR = path.join(ROOT_DIR, 'data-store');
/** Published JSON consumed by the web app. */
export const OUTPUT_DIR = path.join(ROOT_DIR, 'public', 'data');

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
export const ESPN_SITE_API = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
export const ESPN_STANDINGS_API = 'https://site.api.espn.com/apis/v2/sports/soccer';
export const FETCH_CONCURRENCY = 6;
export const FETCH_RETRIES = 4;
/** Only fetch per-match summaries for finished matches newer than this many days. */
export const SUMMARY_LOOKBACK_DAYS = 180;
/** Upcoming window published (days). */
export const UPCOMING_DAYS = 14;
/** Recent results window published (days). */
export const RESULTS_DAYS = 30;

/**
 * Plausible bookmaker overround (margin = Σ 1/odds − 1) of a 1X2 or over/under market. Real books sit around 2-12 %;
 * outside this range the trio is a feed error (e.g. moneyline "-10000"/"+100"/"+100" → margin 0.99, or three "+400"
 * → −0.4). Such prices are dropped (the rest of the snapshot is kept) instead of feeding the ensemble with weight 0.8
 * and making the validator reject the WHOLE publication.
 */
export const ODDS_MARGIN_MIN = -0.02;
export const ODDS_MARGIN_MAX = 0.3;
export function isPlausibleMargin(m: number | undefined): m is number {
  return typeof m === 'number' && Number.isFinite(m) && m >= ODDS_MARGIN_MIN && m <= ODDS_MARGIN_MAX;
}
/** Overround of a set of decimal prices (undefined when any price is missing or ≤ 1). */
export function overroundOf(...prices: (number | undefined)[]): number | undefined {
  if (!prices.every((p) => typeof p === 'number' && Number.isFinite(p) && p > 1)) return undefined;
  return (prices as number[]).reduce((s, p) => s + 1 / p, 0) - 1;
}

// ---------------------------------------------------------------------------
// Model parameters (documented in the methodology page)
// ---------------------------------------------------------------------------
export const MODEL = {
  /** Dixon-Coles time-decay per day (half-life ≈ ln2/xi ≈ 365 days for 0.0019) */
  dcXi: 0.0019,
  /** matches used for Dixon-Coles fit: last N days */
  dcWindowDays: 540,
  /** Elo */
  eloK: 20,
  eloHomeAdv: 65,
  eloInit: 1500,
  /** initial Elo offset by competition tier when a team is first seen: init + (tier-5)*tierOffset */
  eloTierOffset: 30,
  /**
   * tier of the initial Elo of teams that only appear in cups (no league in the dataset: lower divisions) → 1440 - 120
   * = 1380 Elo. Was 3; backtest (Elo RPS on cup matches with a cup-only team, 611 matches): tier 3 0.2129, 2 0.2069,
   * 1 0.2024. Cups with amateur rounds go lower via CUP_ONLY_TIER (pipeline/analytics/ratings.ts).
   */
  cupOnlyTier: 1,
  /**
   * Ensemble weights, chosen with a walk-forward backtest grid (build of 3 Nov 2026: 3,666 finished matches of the
   * current seasons, 2,629 with closing odds; leak-free pre-season draw/Elo→goals parameters). RPS (lower = better):
   *  - with odds (n=2629): 0.2/0.2/0.6 → 0.19915 · 0.15/0.15/0.7 → 0.19837 · 0.1/0.1/0.8 → 0.19775 ·
   *    0.05/0.15/0.8 → 0.19773 (best of the grid) · market only → 0.19695. The grid caps wMarket at 0.8: the
   *    backtest uses CLOSING odds (the sharpest price) while upcoming matches use earlier pre-match odds, so the
   *    backtest overstates the market; a pure market copy would also leave no independent model signal.
   *  - without odds (n=1037): 0.7/0.3 → 0.21833 · 0.6/0.4 → 0.21826 · 0.5/0.5 → 0.21824 (best).
   *  - all matches: 0.5/0.2/0.3 (one pair for both cases) 0.20628 · 0.2/0.2/0.6 + 0.7/0.3 0.20416 ·
   *    these values 0.20338 (Brier 0.5925 → 0.5908).
   */
  wDixonColes: 0.05,
  wElo: 0.15,
  wMarket: 0.8,
  /** ensemble weights when there are no odds (see above) */
  wDixonColesNoMarket: 0.5,
  wEloNoMarket: 0.5,
  /**
   * weight factor of the goals part when it comes from Elo→goals instead of Dixon-Coles (cross-league ties).
   * Grid (all matches): 0.2 → 0.20338 · 0.5 → 0.20338 · 1 → 0.20340.
   */
  eloGoalWeightFactor: 0.2,
  /**
   * below this many Elo games (team with fewer), the statistical weights shrink linearly in favour of the market
   * (with odds only). On the 404 matches with odds and a team with < 10 Elo games: RPS 0.17725 without the boost →
   * 0.17671 (floor 0.5) → 0.17625 (floor 0).
   */
  lowDataGames: 10,
  /** factor of the statistical weights with 0 Elo games (grows linearly to 1 at lowDataGames): 0 = market only */
  lowDataFloor: 0,
  /** value bets */
  minEv: 0.05,
  minProb: 0.12,
  maxOdds: 8,
  kellyFraction: 0.25,
  kellyCap: 0.05,
  /** Monte Carlo iterations for season simulation */
  simIterations: 10000,
  /** score matrix size (0..maxGoals) */
  maxGoals: 7,
} as const;

/** Time zone used for "today"/"tomorrow" buckets in the home page. */
export const HOME_TIMEZONE = 'Europe/Madrid';
