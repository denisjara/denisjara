/**
 * Minimal HTTP client for ESPN's public JSON API.
 *
 *  - native fetch (Node >= 18), 30 s timeout per attempt
 *  - retries (FETCH_RETRIES) with exponential backoff + jitter on 429 / 5xx / network errors / timeouts
 *    (honours `Retry-After` when present)
 *  - global concurrency limiter shared by every request of the process (FETCH_CONCURRENCY by default)
 */
import { ESPN_SITE_API, ESPN_STANDINGS_API, FETCH_CONCURRENCY, FETCH_RETRIES } from '../config';

const USER_AGENT = 'FutStatLab/1.0';
const TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(status: number, url: string, message?: string) {
    super(message ?? `HTTP ${status} en ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/** Counters for the progress log / final report. */
export const httpStats = { requests: 0, retries: 0, failures: 0 };

// ---------------------------------------------------------------------------
// Global concurrency limiter
// ---------------------------------------------------------------------------
let maxConcurrency = Math.max(1, FETCH_CONCURRENCY);
let active = 0;
const waiting: (() => void)[] = [];

/** Change the global number of simultaneous requests (>= 1). */
export function setConcurrency(n: number): void {
  if (!Number.isFinite(n) || n < 1) throw new Error(`Concurrencia no válida: ${n}`);
  maxConcurrency = Math.floor(n);
  drain();
}

export function getConcurrency(): number {
  return maxConcurrency;
}

function drain(): void {
  while (active < maxConcurrency && waiting.length > 0) {
    active++;
    const next = waiting.shift()!;
    next();
  }
}

function acquire(): Promise<void> {
  if (active < maxConcurrency) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  active = Math.max(0, active - 1);
  drain();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function backoffMs(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(BACKOFF_MAX_MS, secs * 1000 + Math.random() * 250);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.min(BACKOFF_MAX_MS, Math.max(0, at - Date.now()) + Math.random() * 250);
  }
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return exp / 2 + Math.random() * (exp / 2); // "equal jitter"
}

export interface FetchJsonOptions {
  /** number of retries after the first attempt (default FETCH_RETRIES) */
  retries?: number;
  timeoutMs?: number;
}

/**
 * GET a URL and parse JSON. Throws HttpError for non-retryable HTTP errors (e.g. 404)
 * or the last error once retries are exhausted.
 */
export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const retries = opts.retries ?? FETCH_RETRIES;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let retryAfter: string | null = null;
    await acquire();
    try {
      httpStats.requests++;
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const text = await res.text();
        return JSON.parse(text) as T;
      }
      // drain the body so the socket can be reused
      await res.arrayBuffer().catch(() => undefined);
      const err = new HttpError(res.status, url);
      if (!isRetryableStatus(res.status)) {
        httpStats.failures++;
        throw err;
      }
      lastError = err;
      retryAfter = res.headers.get('retry-after');
    } catch (e) {
      if (e instanceof HttpError && !isRetryableStatus(e.status)) throw e;
      // SyntaxError (truncated body), AbortError/TimeoutError, network errors -> retry
      lastError = e;
    } finally {
      release();
    }
    if (attempt < retries) {
      httpStats.retries++;
      await sleep(backoffMs(attempt, retryAfter));
    }
  }
  httpStats.failures++;
  if (lastError instanceof Error) throw lastError;
  throw new Error(`Fallo al descargar ${url}: ${String(lastError)}`);
}

// ---------------------------------------------------------------------------
// ESPN endpoints
// ---------------------------------------------------------------------------

/** Scoreboard for a league and a `dates` value (YYYY, YYYYMM or YYYYMMDD). Ranges are NOT supported by ESPN. */
export function scoreboardUrl(slug: string, dates: string | number): string {
  return `${ESPN_SITE_API}/${slug}/scoreboard?dates=${dates}&limit=1000`;
}

export function summaryUrl(slug: string, eventId: string): string {
  return `${ESPN_SITE_API}/${slug}/summary?event=${encodeURIComponent(eventId)}`;
}

export function standingsUrl(slug: string): string {
  return `${ESPN_STANDINGS_API}/${slug}/standings`;
}

export function getScoreboard(slug: string, dates: string | number): Promise<unknown> {
  return fetchJson(scoreboardUrl(slug, dates));
}

export function getSummary(slug: string, eventId: string): Promise<unknown> {
  return fetchJson(summaryUrl(slug, eventId));
}

export function getStandings(slug: string): Promise<unknown> {
  return fetchJson(standingsUrl(slug));
}
