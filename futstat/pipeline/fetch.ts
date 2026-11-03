/**
 * CLI: download / refresh data-store/<compId>.json from ESPN.
 *
 *   npx tsx pipeline/fetch.ts [--only=laliga,premier] [--no-summaries] [--max-summaries=N] [--concurrency=N]
 *
 * Per competition: scoreboards for {year-1, year} (+ year+1 in December) -> normalize -> merge ->
 * standings -> summaries of finished matches not yet summarised within SUMMARY_LOOKBACK_DAYS
 * (most recent first; `--max-summaries` caps them per competition) -> save.
 * A failure in one competition is logged and the run continues.
 */
import { pathToFileURL } from 'node:url';
import { COMPETITIONS, COMPETITION_BY_ID, FETCH_CONCURRENCY, SUMMARY_LOOKBACK_DAYS, UPCOMING_DAYS } from './config';
import type { CompetitionConfig } from './config';
import { HttpError, getScoreboard, getStandings, getSummary, httpStats, setConcurrency } from './espn/client';
import { leagueInfo, normalizeScoreboard, normalizeStandings, normalizeSummary, summaryHasContent } from './espn/normalize';
import type { SummaryResult } from './espn/normalize';
import { inferUnknownPositions, loadStore, mergeMatches, prunePlayerLines, saveStore, upsertPlayerLines } from './store';
import type { CompetitionStore, MatchRecord, PlayerLine } from './types';
import type { StandingGroup, TeamRef } from '../src/types/data';

const DAY_MS = 86_400_000;
/** a finished match whose summary is still empty is retried for this many days */
const EMPTY_SUMMARY_RETRY_DAYS = 3;
const SAVE_EVERY = 50;

export interface FetchOptions {
  summaries: boolean;
  /** max summaries per competition (Infinity = no cap) */
  maxSummaries: number;
  now: Date;
}

export interface CompetitionReport {
  compId: string;
  ok: boolean;
  error?: string;
  matches: number;
  finishedCurrent: number;
  upcoming14: number;
  withStats: number;
  withSummary: number;
  playerLines: number;
  standingRows: number;
  summariesFetched: number;
  summariesFailed: number;
  seconds: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(compId: string, msg: string): void {
  console.log(`[${compId}] ${msg}`);
}

export function yearsToFetch(now: Date): number[] {
  const y = now.getUTCFullYear();
  const years = [y - 1, y];
  if (now.getUTCMonth() === 11) years.push(y + 1);
  return years;
}

/** Latest season (by ESPN's league info) that has already started; falls back to the latest one. */
export function pickCurrentLeague(leagues: NonNullable<CompetitionStore['league']>[], now: Date): CompetitionStore['league'] {
  const withYear = leagues.filter((l) => typeof l.seasonYear === 'number');
  if (!withYear.length) return leagues[leagues.length - 1];
  const started = withYear.filter((l) => !l.seasonStart || Date.parse(l.seasonStart) <= now.getTime());
  const pool = started.length ? started : withYear;
  return pool.reduce((best, l) => ((l.seasonYear ?? 0) > (best.seasonYear ?? 0) ? l : best), pool[0]);
}

function applySummary(m: MatchRecord, res: SummaryResult): void {
  if (res.stats) {
    m.stats = {
      home: { ...m.stats?.home, ...res.stats.home, goals: m.score?.home ?? res.stats.home.goals },
      away: { ...m.stats?.away, ...res.stats.away, goals: m.score?.away ?? res.stats.away.goals },
    };
  }
  if (res.events?.length) m.events = res.events;
  if (res.closingOdds) m.odds = res.closingOdds;
  if (m.score) {
    if (res.ht) {
      m.score.htHome = res.ht.home;
      m.score.htAway = res.ht.away;
    }
    if (res.pens) {
      m.score.penHome = res.pens.home;
      m.score.penAway = res.pens.away;
    }
  }
  if (res.neutral === true) m.neutral = true;
  else if (res.neutral === false) delete m.neutral;
}

/** Add cosmetic fields (colour, logo, short name) from the scoreboard team refs to standings rows. */
function enrichStandings(groups: StandingGroup[], matches: MatchRecord[]): StandingGroup[] {
  const teams = new Map<string, TeamRef>();
  for (const m of matches) {
    teams.set(m.home.id, m.home);
    teams.set(m.away.id, m.away);
  }
  for (const g of groups) {
    for (const row of g.rows) {
      const t = teams.get(row.team.id);
      if (!t) continue;
      if (!row.team.color && t.color) row.team.color = t.color;
      if (!row.team.logo && t.logo) row.team.logo = t.logo;
      if ((!row.team.short || row.team.short === row.team.name) && t.short) row.team.short = t.short;
    }
  }
  return groups;
}

export function reportFor(store: CompetitionStore, now: Date): Omit<CompetitionReport, 'ok' | 'error' | 'summariesFetched' | 'summariesFailed' | 'seconds'> {
  const t0 = now.getTime();
  const t1 = t0 + UPCOMING_DAYS * DAY_MS;
  return {
    compId: store.compId,
    matches: store.matches.length,
    finishedCurrent: store.matches.filter((m) => m.status === 'finished' && m.currentSeason).length,
    upcoming14: store.matches.filter((m) => {
      const t = Date.parse(m.date);
      return m.status === 'scheduled' && t >= t0 && t <= t1;
    }).length,
    withStats: store.matches.filter((m) => m.stats?.home.shots !== undefined).length,
    withSummary: store.matches.filter((m) => m.summaryFetched === true).length,
    playerLines: store.players.length,
    standingRows: store.standings.reduce((n, g) => n + g.rows.length, 0),
  };
}

// ---------------------------------------------------------------------------
// One competition
// ---------------------------------------------------------------------------
export async function updateCompetition(comp: CompetitionConfig, opts: FetchOptions): Promise<CompetitionReport> {
  const started = Date.now();
  const now = opts.now;
  const store = loadStore(comp.id);
  store.slug = comp.slug;
  const before = store.matches.length;

  // 1) scoreboards
  const years = yearsToFetch(now);
  const settled = await Promise.allSettled(years.map((y) => getScoreboard(comp.slug, y)));
  const okRaw: unknown[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') okRaw.push(s.value);
    else log(comp.id, `aviso: scoreboard ${years[i]} falló: ${(s.reason as Error)?.message ?? s.reason}`);
  });
  if (!okRaw.length) throw new Error('no se pudo descargar ningún scoreboard');

  const leagues = okRaw.map((raw) => leagueInfo(raw)).filter((l): l is NonNullable<typeof l> => !!l);
  const league = pickCurrentLeague(leagues, now);
  const currentSeasonYear = league?.seasonYear;
  const incomingById = new Map<string, MatchRecord>();
  for (const raw of okRaw) {
    for (const m of normalizeScoreboard(raw, comp, { currentSeasonYear, now }).matches) incomingById.set(m.id, m);
  }
  const incoming = [...incomingById.values()];
  if (league) store.league = league;

  let matches = mergeMatches(store.matches, incoming, { now });
  // the season may have rolled over since the record was stored
  if (currentSeasonYear !== undefined) for (const m of matches) m.currentSeason = m.season === currentSeasonYear;
  // drop fixtures that vanished from ESPN (rescheduled with a new id, removed) when every year was fetched
  if (okRaw.length === years.length) {
    const yearSet = new Set(years);
    const inYears = (iso: string) => {
      const t = Date.parse(iso);
      return yearSet.has(new Date(t - DAY_MS).getUTCFullYear()) && yearSet.has(new Date(t + DAY_MS).getUTCFullYear());
    };
    const removed = matches.filter((m) => !incomingById.has(m.id) && m.status !== 'finished' && inYears(m.date));
    if (removed.length) {
      const ids = new Set(removed.map((m) => m.id));
      matches = matches.filter((m) => !ids.has(m.id));
      log(comp.id, `${removed.length} partidos no finalizados ya no aparecen en ESPN: eliminados`);
    }
  }
  store.matches = matches;
  store.players = prunePlayerLines(store.players, store.matches, { now });
  log(
    comp.id,
    `scoreboard ${years.join(',')}: ${incoming.length} partidos recibidos · ${store.matches.length} en el store (${store.matches.length - before >= 0 ? '+' : ''}${store.matches.length - before}) · temporada ${league?.seasonLabel ?? currentSeasonYear ?? '?'}`,
  );

  // 2) standings
  try {
    const raw = await getStandings(comp.slug);
    store.standings = enrichStandings(normalizeStandings(raw, comp.name), store.matches);
  } catch (e) {
    log(comp.id, `aviso: clasificación no disponible (${(e as Error).message}); se conserva la anterior`);
  }

  // 3) summaries
  let fetched = 0;
  let failed = 0;
  if (opts.summaries && comp.summaries !== false) {
    const t0 = now.getTime();
    const minT = t0 - SUMMARY_LOOKBACK_DAYS * DAY_MS;
    const candidates = store.matches
      .filter((m) => {
        const t = Date.parse(m.date);
        return m.status === 'finished' && m.summaryFetched !== true && t >= minT && t <= t0;
      })
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, Number.isFinite(opts.maxSummaries) ? opts.maxSummaries : undefined);

    if (candidates.length) {
      log(comp.id, `resúmenes pendientes: ${candidates.length}`);
      let pending: PlayerLine[] = [];
      let done = 0;
      const flush = () => {
        if (pending.length) store.players = upsertPlayerLines(store.players, pending);
        pending = [];
        saveStore(store);
      };
      await Promise.all(
        candidates.map(async (m) => {
          const ageDays = (t0 - Date.parse(m.date)) / DAY_MS;
          try {
            const raw = await getSummary(comp.slug, m.id);
            const res = normalizeSummary(raw, m);
            applySummary(m, res);
            pending.push(...res.players);
            if (summaryHasContent(res) || ageDays > EMPTY_SUMMARY_RETRY_DAYS) m.summaryFetched = true;
            fetched++;
          } catch (e) {
            failed++;
            if (e instanceof HttpError && e.status === 404 && ageDays > EMPTY_SUMMARY_RETRY_DAYS) m.summaryFetched = true;
            if (failed <= 3) log(comp.id, `aviso: resumen ${m.id} falló: ${(e as Error).message}`);
          }
          done++;
          if (done % SAVE_EVERY === 0) {
            flush();
            log(comp.id, `resúmenes ${done}/${candidates.length}`);
          }
        }),
      );
      if (pending.length) store.players = upsertPlayerLines(store.players, pending);
      log(comp.id, `resúmenes: ${fetched} descargados, ${failed} fallidos`);
    }
  }

  inferUnknownPositions(store.players);
  saveStore(store);
  return {
    ...reportFor(store, now),
    ok: true,
    summariesFetched: fetched,
    summariesFailed: failed,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
export function parseArgs(argv: string[]): { only?: string[]; summaries: boolean; maxSummaries: number; concurrency: number; help: boolean } {
  const out = { only: undefined as string[] | undefined, summaries: true, maxSummaries: Infinity, concurrency: FETCH_CONCURRENCY, help: false };
  for (const a of argv) {
    const [k, v] = a.split('=', 2);
    if (k === '--only') out.only = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--no-summaries') out.summaries = false;
    else if (k === '--max-summaries') out.maxSummaries = Math.max(0, Number(v));
    else if (k === '--concurrency') out.concurrency = Math.max(1, Number(v));
    else if (k === '--help' || k === '-h') out.help = true;
    else throw new Error(`Argumento desconocido: ${a}`);
  }
  if (!Number.isFinite(out.concurrency)) throw new Error('--concurrency debe ser un número');
  if (Number.isNaN(out.maxSummaries)) throw new Error('--max-summaries debe ser un número');
  return out;
}

function printTable(reports: CompetitionReport[]): void {
  const head = ['Competición', 'Partidos', 'Term. temp.', 'Próx. 14d', 'Con stats', 'Con resumen', 'Líneas jug.', 'Filas clasif.', 'Res. nuevos', 'Seg.', 'Estado'];
  const rows = reports.map((r) => [
    r.compId,
    String(r.matches),
    String(r.finishedCurrent),
    String(r.upcoming14),
    String(r.withStats),
    String(r.withSummary),
    String(r.playerLines),
    String(r.standingRows),
    r.summariesFailed ? `${r.summariesFetched} (${r.summariesFailed} err)` : String(r.summariesFetched),
    String(r.seconds),
    r.ok ? 'ok' : `ERROR: ${r.error ?? ''}`.slice(0, 60),
  ]);
  const total = (k: keyof CompetitionReport) => String(reports.reduce((n, r) => n + (Number(r[k]) || 0), 0));
  rows.push(['TOTAL', total('matches'), total('finishedCurrent'), total('upcoming14'), total('withStats'), total('withSummary'), total('playerLines'), total('standingRows'), total('summariesFetched'), total('seconds'), '']);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cells: string[]) => cells.map((c, i) => (i === 0 || i === cells.length - 1 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  console.log('');
  console.log(fmt(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  rows.forEach((r, i) => {
    if (i === rows.length - 1) console.log(widths.map((w) => '-'.repeat(w)).join('  '));
    console.log(fmt(r));
  });
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Uso: npx tsx pipeline/fetch.ts [--only=laliga,premier] [--no-summaries] [--max-summaries=N] [--concurrency=N]');
    return 0;
  }
  let comps = COMPETITIONS;
  if (args.only?.length) {
    const unknown = args.only.filter((id) => !COMPETITION_BY_ID.has(id));
    if (unknown.length) throw new Error(`Competiciones desconocidas: ${unknown.join(', ')}`);
    comps = args.only.map((id) => COMPETITION_BY_ID.get(id)!);
  }
  setConcurrency(args.concurrency);
  const now = new Date();
  const opts: FetchOptions = { summaries: args.summaries, maxSummaries: args.maxSummaries, now };
  console.log(
    `FutStat Lab · descarga ESPN · ${now.toISOString()} · ${comps.length} competiciones · concurrencia ${args.concurrency}` +
      (args.summaries ? (Number.isFinite(args.maxSummaries) ? ` · máx. ${args.maxSummaries} resúmenes/competición` : '') : ' · sin resúmenes'),
  );

  const reports: CompetitionReport[] = [];
  for (const comp of comps) {
    const t = Date.now();
    try {
      reports.push(await updateCompetition(comp, opts));
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      log(comp.id, `ERROR: ${msg}`);
      let base: ReturnType<typeof reportFor>;
      try {
        base = reportFor(loadStore(comp.id), now);
      } catch {
        base = { compId: comp.id, matches: 0, finishedCurrent: 0, upcoming14: 0, withStats: 0, withSummary: 0, playerLines: 0, standingRows: 0 };
      }
      reports.push({ ...base, ok: false, error: msg, summariesFetched: 0, summariesFailed: 0, seconds: Math.round((Date.now() - t) / 100) / 10 });
    }
  }
  printTable(reports);
  console.log(`\nPeticiones HTTP: ${httpStats.requests} · reintentos: ${httpStats.retries} · fallos: ${httpStats.failures}`);
  const failedComps = reports.filter((r) => !r.ok);
  if (failedComps.length) console.log(`Competiciones con error: ${failedComps.map((r) => r.compId).join(', ')}`);
  return failedComps.length === reports.length && reports.length > 0 ? 1 : 0;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    });
}
