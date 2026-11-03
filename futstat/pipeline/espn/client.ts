/**
 * Minimal, defensive HTTP client for ESPN's public JSON API.
 *
 *  - native fetch (Node >= 18), 30 s timeout per attempt (covers headers AND body)
 *  - retries (FETCH_RETRIES) with exponential backoff + jitter on 429 / 5xx / network errors / timeouts and on
 *    transient bad payloads (HTML error page, truncated JSON) — honours `Retry-After` when present
 *  - global concurrency limiter shared by every request of the process (FETCH_CONCURRENCY by default)
 *  - response hardening: only https URLs on *.espn.com (also after redirects), body capped at MAX_RESPONSE_BYTES
 *    (checked against `content-length` AND while streaming, so a huge/endless body is cut off), JSON content-type,
 *    parse errors and non-object payloads reported as a typed `InvalidResponseError`
 *  - circuit breakers PER ENDPOINT KIND ('core' = scoreboard/standings, 'summary' = match summaries): after
 *    CIRCUIT_THRESHOLD consecutive requests of that kind that exhausted their retries with transient errors, every
 *    further request of that kind fails fast with `CircuitOpenError`. A /summary outage (429, maintenance) therefore
 *    only postpones summaries: scoreboards and standings of the remaining competitions are still refreshed. With the
 *    network fully down the 'core' circuit opens too and the run ends quickly with the existing data-store.
 *  - the circuit and an optional `deadline` are checked again right before EVERY attempt (also after waiting in the
 *    concurrency queue and before each retry), so queued requests never outlive a broken endpoint or the time budget.
 */
import { ESPN_SITE_API, ESPN_STANDINGS_API, FETCH_CONCURRENCY, FETCH_RETRIES } from '../config';

const USER_AGENT = 'FutStatLab/1.0';
const TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Largest response accepted (the biggest real scoreboard, MLS by year, is ~6 MB). */
export const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
/** Consecutive failed requests (after retries, transient errors only) that open the circuit breaker. */
export const CIRCUIT_THRESHOLD = 6;
/** Hosts the client is allowed to talk to (suffix match on the hostname). */
const ALLOWED_HOST_SUFFIX = '.espn.com';

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

export type InvalidResponseReason = 'too-large' | 'content-type' | 'parse' | 'shape' | 'host';

/** The server answered 2xx but the payload is unusable (too big, not JSON, not an object, wrong host...). */
export class InvalidResponseError extends Error {
  readonly reason: InvalidResponseReason;
  readonly url: string;
  /** transient problems (HTML error page, truncated body) are retried; the rest fail at once */
  readonly retryable: boolean;
  constructor(reason: InvalidResponseReason, url: string, message: string) {
    super(message);
    this.name = 'InvalidResponseError';
    this.reason = reason;
    this.url = url;
    this.retryable = reason === 'content-type' || reason === 'parse';
  }
}

/** Raised without touching the network while the circuit breaker is open. */
export class CircuitOpenError extends Error {
  readonly kind: CircuitKind;
  constructor(url: string, kind: CircuitKind = 'core') {
    super(`ESPN no responde (circuito '${kind}' abierto tras ${CIRCUIT_THRESHOLD} fallos seguidos): se omite ${url}`);
    this.name = 'CircuitOpenError';
    this.kind = kind;
  }
}

/** Raised (without touching the network) when the caller's deadline has passed before an attempt. */
export class DeadlineError extends Error {
  constructor(url: string) {
    super(`Tiempo agotado: se aplaza ${url}`);
    this.name = 'DeadlineError';
  }
}

/** Counters for the progress log / final report. */
export const httpStats = { requests: 0, retries: 0, failures: 0, invalid: 0 };

// ---------------------------------------------------------------------------
// Circuit breakers (one per endpoint kind)
// ---------------------------------------------------------------------------
/** 'core' = scoreboard + standings (what keeps fixtures and tables fresh); 'summary' = per-match summaries. */
export type CircuitKind = 'core' | 'summary';
const circuits: Record<CircuitKind, { failures: number; open: boolean }> = {
  core: { failures: 0, open: false },
  summary: { failures: 0, open: false },
};

/** true once that kind of ESPN endpoint looks unreachable (many consecutive requests failed even after retries). */
export function isCircuitOpen(kind: CircuitKind = 'core'): boolean {
  return circuits[kind].open;
}

/** Reset the breakers (tests, or a new run in the same process). */
export function resetCircuit(): void {
  for (const c of Object.values(circuits)) {
    c.failures = 0;
    c.open = false;
  }
}

function noteSuccess(kind: CircuitKind): void {
  circuits[kind].failures = 0;
}

function noteTransientFailure(kind: CircuitKind): void {
  const c = circuits[kind];
  c.failures++;
  if (c.failures >= CIRCUIT_THRESHOLD) c.open = true;
}

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

// ---------------------------------------------------------------------------
// Response hardening
// ---------------------------------------------------------------------------

/** true for https URLs whose host is espn.com or a subdomain. */
export function isAllowedUrl(u: string): boolean {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'espn.com' || host.endsWith(ALLOWED_HOST_SUFFIX));
  } catch {
    return false;
  }
}

/** JSON media types (`application/json`, `text/json`, `application/x+json`). A missing header is tolerated. */
export function isJsonContentType(ct: string | null): boolean {
  if (!ct) return true;
  const type = ct.split(';')[0].trim().toLowerCase();
  return type === 'application/json' || type === 'text/json' || type.endsWith('+json');
}

/** Read the body as UTF-8 text, aborting as soon as it exceeds `maxBytes`. */
export async function readTextCapped(res: Response, maxBytes: number, url: string): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new InvalidResponseError('too-large', url, `Respuesta demasiado grande (${declared} bytes > ${maxBytes}) en ${url}`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new InvalidResponseError('too-large', url, `Respuesta demasiado grande (> ${maxBytes} bytes) en ${url}: lectura cortada`);
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

/** Parse a body and require a plain JSON object (ESPN never answers with arrays or primitives). */
export function parseJsonObject(text: string, url: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new InvalidResponseError('parse', url, `JSON inválido en ${url}: ${(e as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new InvalidResponseError('shape', url, `Respuesta inesperada en ${url}: se esperaba un objeto JSON`);
  }
  return data as Record<string, unknown>;
}

export interface FetchJsonOptions {
  /** number of retries after the first attempt (default FETCH_RETRIES) */
  retries?: number;
  timeoutMs?: number;
  /** body size limit in bytes (default MAX_RESPONSE_BYTES) */
  maxBytes?: number;
  /** fetch implementation (tests) */
  fetchImpl?: typeof fetch;
  /** base delay multiplier for backoff (tests use 0 to avoid waiting) */
  backoffScale?: number;
  /** circuit breaker this request counts against (default 'core') */
  circuit?: CircuitKind;
  /** ms epoch: no new attempt starts after it (DeadlineError) */
  deadline?: number;
}

/**
 * GET a URL and parse a JSON object. Throws HttpError for non-retryable HTTP errors (e.g. 404),
 * InvalidResponseError for unusable payloads, CircuitOpenError when ESPN is considered down,
 * or the last error once retries are exhausted.
 */
export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  if (!isAllowedUrl(url)) throw new InvalidResponseError('host', url, `URL no permitida: ${url}`);
  const kind: CircuitKind = opts.circuit ?? 'core';
  const deadline = opts.deadline;
  /** checked before every attempt: the circuit may have opened (or the budget run out) while this one waited */
  const gate = () => {
    if (circuits[kind].open) throw new CircuitOpenError(url, kind);
    if (deadline !== undefined && Date.now() > deadline) throw new DeadlineError(url);
  };
  gate();
  const retries = opts.retries ?? FETCH_RETRIES;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  const doFetch = opts.fetchImpl ?? fetch;
  const scale = opts.backoffScale ?? 1;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let retryAfter: string | null = null;
    await acquire();
    try {
      gate();
    } catch (e) {
      release();
      throw e;
    }
    try {
      httpStats.requests++;
      const res = await doFetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.url && !isAllowedUrl(res.url)) {
        await res.body?.cancel().catch(() => undefined);
        throw new InvalidResponseError('host', url, `Redirección a un host no permitido (${res.url}) desde ${url}`);
      }
      if (res.ok) {
        if (!isJsonContentType(res.headers.get('content-type'))) {
          await res.body?.cancel().catch(() => undefined);
          throw new InvalidResponseError('content-type', url, `Tipo de contenido no JSON (${res.headers.get('content-type')}) en ${url}`);
        }
        const text = await readTextCapped(res, maxBytes, url);
        const data = parseJsonObject(text, url);
        noteSuccess(kind);
        return data as T;
      }
      // drain the body so the socket can be reused
      await res.body?.cancel().catch(() => undefined);
      const err = new HttpError(res.status, url);
      if (!isRetryableStatus(res.status)) {
        httpStats.failures++;
        noteSuccess(kind); // the server answered: it is not down
        throw err;
      }
      lastError = err;
      retryAfter = res.headers.get('retry-after');
    } catch (e) {
      if (e instanceof HttpError && !isRetryableStatus(e.status)) throw e;
      if (e instanceof InvalidResponseError) {
        httpStats.invalid++;
        if (!e.retryable) {
          httpStats.failures++;
          noteSuccess(kind); // the server answered (badly), it is not down
          throw e;
        }
      }
      // AbortError/TimeoutError, network errors, transient bad payloads -> retry
      lastError = e;
    } finally {
      release();
    }
    if (attempt < retries) {
      httpStats.retries++;
      await sleep(backoffMs(attempt, retryAfter) * scale);
      gate(); // do not retry into an open circuit or past the deadline
    }
  }
  httpStats.failures++;
  noteTransientFailure(kind);
  if (lastError instanceof Error) throw lastError;
  throw new Error(`Fallo al descargar ${url}: ${String(lastError)}`);
}

// ---------------------------------------------------------------------------
// ESPN endpoints
// ---------------------------------------------------------------------------

const SAFE_SLUG = /^[a-z0-9._-]+$/i;

function safeSlug(slug: string): string {
  if (!SAFE_SLUG.test(slug)) throw new Error(`Slug de competición no válido: ${slug}`);
  return slug;
}

/** Scoreboard for a league and a `dates` value (YYYY, YYYYMM or YYYYMMDD). Ranges are NOT supported by ESPN. */
export function scoreboardUrl(slug: string, dates: string | number): string {
  const d = String(dates);
  if (!/^\d{4}(\d{2}){0,2}$/.test(d)) throw new Error(`Parámetro dates no válido: ${d}`);
  return `${ESPN_SITE_API}/${safeSlug(slug)}/scoreboard?dates=${d}&limit=1000`;
}

export function summaryUrl(slug: string, eventId: string): string {
  return `${ESPN_SITE_API}/${safeSlug(slug)}/summary?event=${encodeURIComponent(eventId)}`;
}

export function standingsUrl(slug: string): string {
  return `${ESPN_STANDINGS_API}/${safeSlug(slug)}/standings`;
}

export function getScoreboard(slug: string, dates: string | number): Promise<unknown> {
  return fetchJson(scoreboardUrl(slug, dates), { circuit: 'core' });
}

/** Match summary. Counts against its own circuit ('summary'); `deadline` stops queued attempts/retries in time. */
export function getSummary(slug: string, eventId: string, opts: { deadline?: number } = {}): Promise<unknown> {
  return fetchJson(summaryUrl(slug, eventId), { circuit: 'summary', deadline: opts.deadline });
}

export function getStandings(slug: string): Promise<unknown> {
  return fetchJson(standingsUrl(slug), { circuit: 'core' });
}
