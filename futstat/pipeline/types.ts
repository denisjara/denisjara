/**
 * Internal (pipeline-only) normalized records. These are the output of
 * pipeline/espn/normalize.ts and the input of the analytics layer.
 * They are persisted in data-store/ between runs. Not consumed by the web app.
 */
import type { MatchStatus, OddsSnapshot, StandingGroup, TeamRef } from '../src/types/data';

export interface TeamMatchStats {
  goals: number;
  shots?: number;
  shotsOnTarget?: number;
  corners?: number;
  fouls?: number;
  yellow?: number;
  red?: number;
  offsides?: number;
  possession?: number; // 0..100
  saves?: number;
  passes?: number;
  passPct?: number; // 0..1
  crosses?: number;
  tackles?: number;
  interceptions?: number;
  clearances?: number;
  blockedShots?: number;
}

export interface MatchEventRecord {
  /** minute as number (e.g. 45 for 45'+2') for bucketing */
  minute: number;
  /** display string as given by source, e.g. "45'+2'" */
  clock: string;
  type: 'goal' | 'own-goal' | 'penalty' | 'yellow' | 'red' | 'sub';
  teamId: string;
  playerId?: string;
  player?: string;
  /** for substitutions: player going off */
  playerOutId?: string;
}

export interface MatchRecord {
  id: string;
  compId: string;
  /** ESPN season year of the event (e.g. 2026 for 2026-27) */
  season: number;
  /** true when the event belongs to the competition's current season */
  currentSeason: boolean;
  date: string; // ISO
  status: MatchStatus;
  statusDetail?: string;
  round?: string;
  neutral?: boolean;
  venue?: string;
  home: TeamRef;
  away: TeamRef;
  /** present when finished or live */
  score?: { home: number; away: number; htHome?: number; htAway?: number; penHome?: number; penAway?: number };
  /** team stats when available (scoreboard gives shots/SOT/corners/fouls/possession; summary adds the rest) */
  stats?: { home: TeamMatchStats; away: TeamMatchStats };
  events?: MatchEventRecord[];
  /** "WWDLW" recent form string reported by source (chronological, most recent last) */
  homeForm?: string;
  awayForm?: string;
  /** latest odds snapshot (pre-match: live feed; finished: closing odds from summary when available) */
  odds?: OddsSnapshot;
  /** history of pre-match odds snapshots captured on each daily run (for line movement) */
  oddsHistory?: OddsSnapshot[];
  /** true once the per-match summary (player lines, extended stats, closing odds) has been fetched & merged */
  summaryFetched?: boolean;
  /** empty / 404 summary answers so far (each in a different run); reset when a summary with content arrives */
  summaryAttempts?: number;
  /** ISO: do not retry an empty summary before this instant (growing wait between attempts) */
  summaryRetryAt?: string;
  /**
   * consecutive runs in which ESPN reported this FINISHED match (with a score) as not played (scheduled, postponed…).
   * The downgrade is only accepted after several runs in a row (store.ts mergeOne): a one-off glitch must not wipe
   * the score, stats, events and summary of a match.
   */
  downgradeSeen?: number;
}

export interface PlayerLine {
  matchId: string;
  compId: string;
  date: string;
  teamId: string;
  opponentId: string;
  isHome: boolean;
  playerId: string;
  name: string;
  short: string;
  position: 'G' | 'D' | 'M' | 'F' | '?';
  starter: boolean;
  /** minutes played, derived from substitution timing (starter: 0→off minute or 90; sub: on minute→90) */
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
  ownGoals: number;
  saves?: number;
  goalsConceded?: number;
}

/** data-store/<compId>.json */
export interface CompetitionStore {
  compId: string;
  slug: string;
  /** last time the file was written */
  updatedAt: string;
  /** last successful scoreboard download WITH events (data freshness published as dataUpdatedAt) */
  fetchedAt?: string;
  /** league info from the latest scoreboard response */
  league?: { name?: string; logo?: string; logoDark?: string; seasonYear?: number; seasonLabel?: string; seasonStart?: string; seasonEnd?: string };
  matches: MatchRecord[];
  players: PlayerLine[];
  standings: StandingGroup[];
}
