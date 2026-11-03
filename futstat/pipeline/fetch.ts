/**
 * CLI: download / refresh data-store/<compId>.json from ESPN.
 *
 *   npx tsx pipeline/fetch.ts [--only=laliga,premier] [--no-summaries] [--max-summaries=N] [--concurrency=N] [--budget-minutes=N]
 *
 * Per competition: scoreboards for {year-1, year} (+ year+1 in December or when the current season ends next
 * year, e.g. Aug→May leagues) -> normalize -> merge -> standings -> summaries of finished matches not yet
 * summarised within SUMMARY_LOOKBACK_DAYS (most recent first; `--max-summaries` caps them per competition) -> save.
 *
 * Robustness: a failure in one competition is logged and the run continues; stores are written atomically with a
 * backup; incomplete ESPN answers never wipe stored fixtures/standings; summaries stop when the data-store exceeds
 * STORE_MAX_BYTES or the time budget is spent; if ESPN does not answer at all the run ends with a warning (exit 0
 * when a previous data-store exists) so the build can go on with the cached data.
 */
import { pathToFileURL } from 'node:url';
import { COMPETITIONS, COMPETITION_BY_ID, FETCH_CONCURRENCY, STORE_DIR, SUMMARY_LOOKBACK_DAYS, UPCOMING_DAYS } from './config';
import { LockedError, acquireLock } from './publish/util';
import type { CompetitionConfig } from './config';
import { CircuitOpenError, DeadlineError, HttpError, getConcurrency, getScoreboard, getStandings, getSummary, httpStats, isCircuitOpen, setConcurrency } from './espn/client';
import { leagueInfo, normalizeScoreboard, normalizeStandings, normalizeSummary, summaryHasContent, takeNormalizeWarnings } from './espn/normalize';
import type { SummaryResult } from './espn/normalize';
import {
  STORE_MAX_BYTES,
  cleanStaleTmp,
  inferUnknownPositions,
  loadAllStores,
  loadStore,
  mergeMatches,
  prunePlayerLines,
  saveStore,
  storeDirBytes,
  upsertPlayerLines,
} from './store';
import type { CompetitionStore, MatchRecord, PlayerLine } from './types';
import type { StandingGroup, TeamRef } from '../src/types/data';

const DAY_MS = 86_400_000;
/** a finished match whose summary is still empty (or 404) is retried at least for this many days… */
const EMPTY_SUMMARY_RETRY_DAYS = 3;
/**
 * …and at least this many times, in DIFFERENT runs spaced by a growing wait (2 h, 4 h, 8 h… max 24 h). One run in
 * which ESPN answers `{}` (maintenance, degraded API) can therefore never mark summaries as fetched for good.
 */
export const EMPTY_SUMMARY_MAX_ATTEMPTS = 6;
const EMPTY_SUMMARY_WAIT_H = 2;
const EMPTY_SUMMARY_WAIT_MAX_H = 24;
const SAVE_EVERY = 50;
/** default time budget for the whole run (the CI step times out at 35 min): no new summaries after it */
export const DEFAULT_BUDGET_MINUTES = 30;
/**
 * Vanished fixtures (not finished, no longer in ESPN's answer) are only removed when they are a small part of the
 * pending ones: a much larger drop looks like an incomplete answer and is ignored.
 */
const MAX_VANISHED_SHARE = 0.3;
const MAX_VANISHED_ABS = 20;

export interface FetchOptions {
  summaries: boolean;
  /** max summaries per competition (Infinity = no cap) */
  maxSummaries: number;
  now: Date;
  /** no new summary downloads after this instant (ms epoch). Default: no limit */
  deadline?: number;
  /** data-store size limit for downloading summaries (default STORE_MAX_BYTES) */
  maxStoreBytes?: number;
  /** data-store directory (tests) */
  storeDir?: string;
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
  /** summaries left for a later run (disk guard, time budget or ESPN down) */
  summariesSkipped?: number;
  seconds: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(compId: string, msg: string): void {
  console.log(`[${compId}] ${msg}`);
}

/** true when an ISO season end falls in a later calendar year than `year` (a 2-day margin absorbs ESPN's time zones). */
export function seasonEndsAfterYear(seasonEnd: string | undefined, year: number): boolean {
  const t = seasonEnd ? Date.parse(seasonEnd) : NaN;
  if (!Number.isFinite(t)) return false;
  return new Date(t - 2 * DAY_MS).getUTCFullYear() > year;
}

/**
 * Calendar years of scoreboards to download: previous + current, and next year in December or when the current
 * season ends next year (Aug→May leagues and the UEFA league phase: January–May fixtures are published under
 * `dates=<year+1>`).
 */
export function yearsToFetch(now: Date, seasonEnd?: string): number[] {
  const y = now.getUTCFullYear();
  const years = [y - 1, y];
  if (now.getUTCMonth() === 11 || seasonEndsAfterYear(seasonEnd, y)) years.push(y + 1);
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

/**
 * Record an empty / missing summary: one more attempt and a growing wait before the next one. The match is only
 * marked as fetched (given up) once it is older than EMPTY_SUMMARY_RETRY_DAYS AND it failed EMPTY_SUMMARY_MAX_ATTEMPTS
 * times in different runs.
 */
export function noteEmptySummary(m: MatchRecord, ageDays: number, nowMs: number): void {
  const attempts = (m.summaryAttempts ?? 0) + 1;
  m.summaryAttempts = attempts;
  if (ageDays > EMPTY_SUMMARY_RETRY_DAYS && attempts >= EMPTY_SUMMARY_MAX_ATTEMPTS) {
    m.summaryFetched = true;
    delete m.summaryRetryAt;
    return;
  }
  const waitH = Math.min(EMPTY_SUMMARY_WAIT_MAX_H, EMPTY_SUMMARY_WAIT_H * 2 ** (attempts - 1));
  m.summaryRetryAt = new Date(nowMs + waitH * 3_600_000).toISOString();
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
  // ESPN reports neutralSite=false even for finals: only trust a positive flag
  if (res.neutral === true) m.neutral = true;
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
  const dir = opts.storeDir;
  const store = loadStore(comp.id, dir);
  store.slug = comp.slug;
  const before = store.matches.length;

  // 1) scoreboards (the stored season end tells whether next year's fixtures belong to the current season)
  const years = yearsToFetch(now, store.league?.seasonEnd);
  const settled = await Promise.allSettled(years.map((y) => getScoreboard(comp.slug, y)));
  const okRaw: unknown[] = [];
  const okYears: number[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      okRaw.push(s.value);
      okYears.push(years[i]);
    } else log(comp.id, `aviso: scoreboard ${years[i]} falló: ${(s.reason as Error)?.message ?? s.reason}`);
  });
  if (!okRaw.length) throw new Error('no se pudo descargar ningún scoreboard');

  const leagues = okRaw.map((raw) => leagueInfo(raw)).filter((l): l is NonNullable<typeof l> => !!l);
  let league = pickCurrentLeague(leagues, now);
  // first run (no stored season): the season just discovered may end next year → fetch it as well
  const nextYear = now.getUTCFullYear() + 1;
  if (!years.includes(nextYear) && seasonEndsAfterYear(league?.seasonEnd, now.getUTCFullYear())) {
    years.push(nextYear);
    try {
      const raw = await getScoreboard(comp.slug, nextYear);
      okRaw.push(raw);
      okYears.push(nextYear);
      const l = leagueInfo(raw);
      if (l) leagues.push(l);
      league = pickCurrentLeague(leagues, now);
    } catch (e) {
      log(comp.id, `aviso: scoreboard ${nextYear} falló: ${(e as Error)?.message ?? e}`);
    }
  }
  const currentSeasonYear = league?.seasonYear;
  const incomingById = new Map<string, MatchRecord>();
  const incomingYears = new Map<number, number>();
  okRaw.forEach((raw, i) => {
    const got = normalizeScoreboard(raw, comp, { currentSeasonYear, now }).matches;
    incomingYears.set(okYears[i], got.length);
    for (const m of got) incomingById.set(m.id, m);
  });
  const incoming = [...incomingById.values()];
  if (league) store.league = league;
  // data freshness: only a download that actually brought fixtures counts (an empty answer is not "fresh data")
  if (incoming.length > 0) store.fetchedAt = now.toISOString();

  let matches = mergeMatches(store.matches, incoming, { now });
  // the season may have rolled over since the record was stored
  if (currentSeasonYear !== undefined) for (const m of matches) m.currentSeason = m.season === currentSeasonYear;
  // drop fixtures that vanished from ESPN (rescheduled with a new id, removed) in the years fetched correctly.
  // A year that came back empty while the store had matches in it, or a drop of many fixtures at once, looks like
  // an incomplete answer: nothing is removed then.
  const storedByYear = new Map<number, number>();
  for (const m of store.matches) {
    const y = new Date(Date.parse(m.date)).getUTCFullYear();
    storedByYear.set(y, (storedByYear.get(y) ?? 0) + 1);
  }
  const trustedYears = new Set(okYears.filter((y) => (incomingYears.get(y) ?? 0) > 0 || (storedByYear.get(y) ?? 0) < 10));
  for (const y of okYears) if (!trustedYears.has(y)) log(comp.id, `aviso: el scoreboard ${y} llegó vacío pero el almacén tiene ${storedByYear.get(y)} partidos de ese año: se conservan`);
  if (trustedYears.size) {
    const inYears = (iso: string) => {
      const t = Date.parse(iso);
      return trustedYears.has(new Date(t - DAY_MS).getUTCFullYear()) && trustedYears.has(new Date(t + DAY_MS).getUTCFullYear());
    };
    const removed = matches.filter((m) => !incomingById.has(m.id) && m.status !== 'finished' && inYears(m.date));
    const pending = matches.filter((m) => m.status !== 'finished' && inYears(m.date)).length;
    if (removed.length > Math.max(MAX_VANISHED_ABS, MAX_VANISHED_SHARE * pending)) {
      log(comp.id, `aviso: ${removed.length} de ${pending} partidos pendientes no aparecen en ESPN (¿respuesta incompleta?): se conservan`);
    } else if (removed.length) {
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

  // 2) standings (an empty answer never wipes a stored table)
  try {
    const raw = await getStandings(comp.slug);
    const groups = normalizeStandings(raw, comp.name);
    if (groups.length || !store.standings.length) store.standings = enrichStandings(groups, store.matches);
    else log(comp.id, 'aviso: la clasificación llegó vacía; se conserva la anterior');
  } catch (e) {
    log(comp.id, `aviso: clasificación no disponible (${(e as Error).message}); se conserva la anterior`);
  }

  // 3) summaries (skipped when the data-store is too big, the time budget is spent or ESPN is down)
  let fetched = 0;
  let failed = 0;
  let skipped = 0;
  const maxBytes = opts.maxStoreBytes ?? STORE_MAX_BYTES;
  const storeBytes = storeDirBytes(dir);
  const wantSummaries = opts.summaries && comp.summaries !== false;
  if (wantSummaries && storeBytes > maxBytes) {
    log(comp.id, `AVISO: data-store ocupa ${(storeBytes / 1048576).toFixed(0)} MB (> ${(maxBytes / 1048576).toFixed(0)} MB): no se descargan resúmenes`);
  }
  if (wantSummaries && storeBytes <= maxBytes) {
    const t0 = now.getTime();
    const minT = t0 - SUMMARY_LOOKBACK_DAYS * DAY_MS;
    const wallNow = Date.now();
    const candidates = store.matches
      .filter((m) => {
        const t = Date.parse(m.date);
        if (m.status !== 'finished' || m.summaryFetched === true || !(t >= minT && t <= t0)) return false;
        // empty/404 summaries wait a growing time between attempts (see noteEmptySummary)
        const retryAt = m.summaryRetryAt ? Date.parse(m.summaryRetryAt) : NaN;
        return !(retryAt > wallNow);
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
        saveStore(store, dir);
      };
      // Pool of workers that take candidates one by one and check the time budget and the circuits BEFORE each
      // request (a Promise.all over every candidate would queue them all at once: queued requests would ignore a
      // budget spent or an endpoint that went down meanwhile). What is left counts as postponed (`summariesSkipped`).
      const queue = [...candidates];
      const stop = () => (opts.deadline !== undefined && Date.now() > opts.deadline) || isCircuitOpen('summary') || isCircuitOpen('core');
      const worker = async () => {
        for (let m = queue.shift(); m; m = queue.shift()) {
          if (stop()) {
            skipped++;
            continue;
          }
          const ageDays = (t0 - Date.parse(m.date)) / DAY_MS;
          try {
            const raw = await getSummary(comp.slug, m.id, { deadline: opts.deadline });
            const res = normalizeSummary(raw, m);
            applySummary(m, res);
            pending.push(...res.players);
            if (summaryHasContent(res)) {
              m.summaryFetched = true;
              delete m.summaryAttempts;
              delete m.summaryRetryAt;
            } else noteEmptySummary(m, ageDays, Date.now());
            fetched++;
          } catch (e) {
            if (e instanceof CircuitOpenError || e instanceof DeadlineError) {
              skipped++;
              continue;
            }
            failed++;
            if (e instanceof HttpError && e.status === 404) noteEmptySummary(m, ageDays, Date.now());
            if (failed <= 3) log(comp.id, `aviso: resumen ${m.id} falló: ${(e as Error).message}`);
          }
          done++;
          if (done % SAVE_EVERY === 0) {
            flush();
            log(comp.id, `resúmenes ${done}/${candidates.length}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(getConcurrency(), queue.length)) }, worker));
      if (pending.length) store.players = upsertPlayerLines(store.players, pending);
      log(comp.id, `resúmenes: ${fetched} descargados, ${failed} fallidos${skipped ? `, ${skipped} aplazados (tiempo agotado o ESPN sin respuesta)` : ''}`);
    }
  }

  inferUnknownPositions(store.players);
  saveStore(store, dir);
  const report: CompetitionReport = {
    ...reportFor(store, now),
    ok: true,
    summariesFetched: fetched,
    summariesFailed: failed,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
  if (skipped) report.summariesSkipped = skipped;
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
export interface FetchArgs {
  only?: string[];
  summaries: boolean;
  maxSummaries: number;
  concurrency: number;
  /** soft time budget in minutes (no new summaries after it) */
  budgetMinutes?: number;
  help: boolean;
}

export function parseArgs(argv: string[]): FetchArgs {
  const out: FetchArgs = { only: undefined, summaries: true, maxSummaries: Infinity, concurrency: FETCH_CONCURRENCY, help: false };
  for (const a of argv) {
    const [k, v] = a.split('=', 2);
    if (k === '--only') out.only = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--no-summaries') out.summaries = false;
    else if (k === '--max-summaries') out.maxSummaries = Math.max(0, Number(v));
    else if (k === '--concurrency') out.concurrency = Math.max(1, Math.min(16, Number(v)));
    else if (k === '--budget-minutes') out.budgetMinutes = Number(v);
    else if (k === '--help' || k === '-h') out.help = true;
    else throw new Error(`Argumento desconocido: ${a}`);
  }
  if (!Number.isFinite(out.concurrency)) throw new Error('--concurrency debe ser un número');
  if (Number.isNaN(out.maxSummaries)) throw new Error('--max-summaries debe ser un número');
  if (out.budgetMinutes !== undefined && !(out.budgetMinutes > 0)) throw new Error('--budget-minutes debe ser un número positivo');
  if (out.budgetMinutes === undefined) delete out.budgetMinutes;
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
    `${r.summariesFetched}${r.summariesFailed ? ` (${r.summariesFailed} err)` : ''}${r.summariesSkipped ? ` (+${r.summariesSkipped} pend.)` : ''}`,
    String(r.seconds),
    r.ok ? 'ok' : `ERROR: ${r.error ?? ''}`.slice(0, 60),
  ]);
  const total = (k: keyof CompetitionReport) => String(Math.round(reports.reduce((n, r) => n + (Number(r[k]) || 0), 0) * 10) / 10);
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

/** GitHub Actions annotation (visible in the run summary) + plain log line elsewhere. */
function ciWarning(title: string, msg: string): void {
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning title=${title}::${msg.replace(/\r?\n/g, ' ')}`);
  else console.warn(`AVISO: ${title}. ${msg}`);
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Uso: npx tsx pipeline/fetch.ts [--only=laliga,premier] [--no-summaries] [--max-summaries=N] [--concurrency=N] [--budget-minutes=N]');
    return 0;
  }
  let comps = COMPETITIONS;
  if (args.only?.length) {
    const unknown = args.only.filter((id) => !COMPETITION_BY_ID.has(id));
    if (unknown.length) throw new Error(`Competiciones desconocidas: ${unknown.join(', ')}`);
    comps = args.only.map((id) => COMPETITION_BY_ID.get(id)!);
  }
  setConcurrency(args.concurrency);
  // one fetch at a time per data-store (two runs would interleave saves of the same files)
  let releaseLock: () => void;
  try {
    releaseLock = acquireLock('fetch', STORE_DIR, `El almacén ${STORE_DIR}`);
  } catch (e) {
    if (e instanceof LockedError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
  try {
    return await runFetch(comps, args);
  } finally {
    releaseLock();
  }
}

async function runFetch(comps: CompetitionConfig[], args: FetchArgs): Promise<number> {
  const stale = cleanStaleTmp(STORE_DIR);
  if (stale.length) console.log(`Temporales huérfanos eliminados de data-store/: ${stale.join(', ')}`);
  const now = new Date();
  const budget = args.budgetMinutes ?? DEFAULT_BUDGET_MINUTES;
  const opts: FetchOptions = { summaries: args.summaries, maxSummaries: args.maxSummaries, now, deadline: now.getTime() + budget * 60_000 };
  console.log(
    `FutStat Lab · descarga ESPN · ${now.toISOString()} · ${comps.length} competiciones · concurrencia ${args.concurrency}` +
      (args.summaries ? (Number.isFinite(args.maxSummaries) ? ` · máx. ${args.maxSummaries} resúmenes/competición` : '') : ' · sin resúmenes'),
  );

  const reports: CompetitionReport[] = [];
  for (const comp of comps) {
    const t = Date.now();
    try {
      // ESPN scoreboards/standings considered down: do not wait for every competition to time out, keep the stored
      // data. (A /summary-only outage opens just the 'summary' circuit: the remaining competitions are still refreshed.)
      if (isCircuitOpen('core')) throw new Error('ESPN no responde: se conserva el almacén anterior');
      reports.push(await updateCompetition(comp, opts));
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      log(comp.id, `ERROR: ${msg}`);
      let base: ReturnType<typeof reportFor>;
      try {
        base = reportFor(loadStore(comp.id, undefined, { warn: () => {} }), now);
      } catch {
        base = { compId: comp.id, matches: 0, finishedCurrent: 0, upcoming14: 0, withStats: 0, withSummary: 0, playerLines: 0, standingRows: 0 };
      }
      reports.push({ ...base, ok: false, error: msg, summariesFetched: 0, summariesFailed: 0, seconds: Math.round((Date.now() - t) / 100) / 10 });
    }
  }
  printTable(reports);
  console.log(`\nPeticiones HTTP: ${httpStats.requests} · reintentos: ${httpStats.retries} · fallos: ${httpStats.failures} · respuestas no válidas: ${httpStats.invalid}`);
  const warnings = takeNormalizeWarnings();
  if (warnings.length) {
    const total = warnings.reduce((n, w) => n + w.count, 0);
    console.log(`Registros de ESPN descartados o corregidos al normalizar: ${total}`);
    for (const w of warnings.slice(0, 15)) console.log(`  - ${w.kind}: ${w.count}${w.example ? ` (p. ej. ${w.example})` : ''}`);
  }
  const failedComps = reports.filter((r) => !r.ok);
  if (failedComps.length) console.log(`Competiciones con error: ${failedComps.map((r) => r.compId).join(', ')}`);
  if (failedComps.length === reports.length && reports.length > 0) {
    // ESPN unreachable: keep the data-store as it is. With a previous store the build can still run (exit 0).
    const cached = loadAllStores(undefined, { warn: () => {} }).length;
    if (cached > 0) {
      ciWarning(
        'Descarga de ESPN fallida',
        `No se pudo descargar ninguna competición. Se conserva el almacén anterior (${cached} competiciones) y el build usará esos datos; la validación decide si se publican.`,
      );
      return 0;
    }
    ciWarning('Descarga de ESPN fallida', 'No se pudo descargar ninguna competición y no hay almacén previo: no hay datos con los que compilar.');
    return 1;
  }
  return 0;
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
