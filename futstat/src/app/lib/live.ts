/**
 * Marcadores en vivo: consulta el scoreboard público de ESPN (CORS abierto) para las competiciones con
 * partidos de hoy en ventana de juego, y devuelve marcador/estado por id de partido.
 *
 * Diseñado para no molestar ni gastar batería/CPU:
 *  - Sondeo cada 60 s solo mientras hay partidos en ventana de juego; si no, se duerme hasta que empiece
 *    el próximo (como mucho 10 min entre comprobaciones locales, sin red).
 *  - PAUSA cuando la pestaña está oculta (document.visibilityState) o el equipo está sin conexión;
 *    se reanuda al volver.
 *  - Cada petición tiene timeout de 10 s (AbortController) y se cancela al desmontar.
 *  - Backoff exponencial ante fallos: 60 s → 2 → 4 → 8 min, con tope de 10 min.
 *  - Como mucho MAX_REQUESTS_PER_CYCLE peticiones por ciclo (rotando si hay más competiciones).
 *  - El payload de ESPN se valida campo a campo (tipos, números finitos, textos recortados).
 *  - Nunca lanza excepciones hacia React: si ESPN falla se conservan los últimos valores conocidos.
 *
 * Desactivado por defecto con VITE_DATA_DIR=mock-data (los ids falsos no existen en ESPN).
 * Forzar: VITE_LIVE=1 (activar) / VITE_LIVE=0 (desactivar).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MatchStatus, MatchSummary } from '../../types/data';
import { DATA_DIR, useMeta } from './data';
import { dayKey } from './format';
import { reportError } from './errors';

export const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
export const LIVE_POLL_MS = 60_000;
export const LIVE_MAX_BACKOFF_MS = 10 * 60_000;
export const LIVE_FETCH_TIMEOUT_MS = 10_000;
/** Peticiones (competición × día) como máximo por ciclo de sondeo. */
export const MAX_REQUESTS_PER_CYCLE = 6;
/** Tamaño máximo aceptado de la respuesta de ESPN (caracteres). */
const MAX_PAYLOAD_CHARS = 8_000_000;
const MAX_EVENTS = 400;

const envLive = import.meta.env.VITE_LIVE as string | undefined;
export const LIVE_ENABLED: boolean = envLive !== undefined && envLive !== '' ? envLive !== '0' : DATA_DIR !== 'mock-data';

export interface LiveScore {
  matchId: string;
  status: MatchStatus;
  /** "67'", "Descanso", "Final" ... */
  statusDetail?: string;
  home: number;
  away: number;
  /** epoch ms de la última lectura */
  updatedAt: number;
}

/** Retardo del siguiente sondeo tras `failures` ciclos fallidos seguidos: 60 s, 2, 4, 8 min, tope 10 min. */
export function liveBackoffMs(failures: number): number {
  if (!(failures > 0)) return LIVE_POLL_MS;
  return Math.min(LIVE_MAX_BACKOFF_MS, LIVE_POLL_MS * 2 ** Math.min(failures, 10));
}

const WINDOW_BEFORE_MS = 15 * 60_000;
const WINDOW_AFTER_MS = 195 * 60_000;

/** Ventana en la que un partido puede estar en juego: de 15 min antes a 3 h 15 después del inicio. */
function inPlayWindow(m: MatchSummary, now: number): boolean {
  const t = Date.parse(m.date);
  return Number.isFinite(t) && now >= t - WINDOW_BEFORE_MS && now <= t + WINDOW_AFTER_MS;
}

function isFinal(s: MatchStatus) {
  return s === 'finished' || s === 'cancelled' || s === 'postponed';
}

/** Fecha YYYYMMDD en hora del Este de EE. UU. (ESPN agrupa el scoreboard por ese día). */
function espnDate(iso: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
    return parts.replace(/-/g, '');
  } catch {
    return dayKey(iso).replace(/-/g, '');
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const DATE_RE = /^\d{8}$/;
const ID_RE = /^[0-9]{1,15}$/;

// ---------------------------------------------------------------------------
// Validación del payload de ESPN
// ---------------------------------------------------------------------------
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
/** Texto corto y limpio (sin caracteres de control) o undefined. */
function shortText(x: unknown, max = 24): string | undefined {
  if (typeof x !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const s = x.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s ? s.slice(0, max) : undefined;
}
/** Goles: entero finito entre 0 y 99. */
function goals(x: unknown): number | undefined {
  const n = typeof x === 'number' ? x : typeof x === 'string' && /^\s*\d{1,2}\s*$/.test(x) ? Number(x) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : undefined;
}

function mapStatus(st: unknown): { status: MatchStatus; detail?: string } {
  const s = isObj(st) ? st : {};
  const type = isObj(s.type) ? s.type : {};
  const state = typeof type.state === 'string' ? type.state : '';
  const name = typeof type.name === 'string' ? type.name.toUpperCase() : '';
  if (name.includes('POSTPONED')) return { status: 'postponed', detail: 'Aplazado' };
  if (name.includes('CANCELED') || name.includes('CANCELLED') || name.includes('ABANDONED')) return { status: 'cancelled', detail: 'Cancelado' };
  if (state === 'in') {
    if (name.includes('HALFTIME')) return { status: 'live', detail: 'Descanso' };
    const clock = shortText(s.displayClock, 12) ?? shortText(type.shortDetail, 16);
    return { status: 'live', detail: clock && clock !== "0'" ? clock : 'En juego' };
  }
  if (state === 'post') {
    if (name.includes('PEN')) return { status: 'finished', detail: 'Final (pen.)' };
    if (name.includes('AET')) return { status: 'finished', detail: 'Final (prór.)' };
    return { status: 'finished', detail: 'Final' };
  }
  return { status: 'scheduled' };
}

/** Parsea (y valida) un scoreboard de ESPN → LiveScore por id de evento. Nunca lanza. */
export function parseEspnScoreboard(json: unknown, now = Date.now()): Record<string, LiveScore> {
  const out: Record<string, LiveScore> = {};
  try {
    const events = isObj(json) ? json.events : undefined;
    if (!Array.isArray(events)) return out;
    for (const ev of events.slice(0, MAX_EVENTS)) {
      if (!isObj(ev)) continue;
      const id = typeof ev.id === 'string' || typeof ev.id === 'number' ? String(ev.id) : '';
      if (!ID_RE.test(id)) continue;
      const comps = Array.isArray(ev.competitions) ? ev.competitions : [];
      const comp = isObj(comps[0]) ? comps[0] : undefined;
      if (!comp) continue;
      const { status, detail } = mapStatus(comp.status ?? ev.status);
      const competitors = Array.isArray(comp.competitors) ? comp.competitors.filter(isObj) : [];
      const h = competitors.find((c) => c.homeAway === 'home');
      const a = competitors.find((c) => c.homeAway === 'away');
      const hs = goals(h?.score);
      const as = goals(a?.score);
      // Un partido en juego o terminado sin marcador legible no se aplica (mejor el último valor conocido).
      if (status !== 'scheduled' && (hs === undefined || as === undefined)) continue;
      out[id] = { matchId: id, status, statusDetail: detail, home: hs ?? 0, away: as ?? 0, updatedAt: now };
    }
  } catch {
    /* payload inesperado: sin datos */
  }
  return out;
}

/** Descarga un scoreboard con timeout. Devuelve null si falla (red, timeout, HTTP, JSON). */
async function fetchScoreboard(slug: string, date: string, outer: AbortSignal): Promise<unknown | null> {
  if (!SLUG_RE.test(slug) || !DATE_RE.test(date) || outer.aborted) return null;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  outer.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ctrl.abort(), LIVE_FETCH_TIMEOUT_MS);
  try {
    const url = `${ESPN_SCOREBOARD}/${encodeURIComponent(slug)}/scoreboard?dates=${date}`;
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_PAYLOAD_CHARS) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', onAbort);
  }
}

const pageVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/**
 * Hook: marcadores en vivo para `matches` (los de hoy). Devuelve un mapa id → LiveScore solo con
 * los partidos encontrados en ESPN. Nunca lanza; si algo falla devuelve el último estado conocido.
 */
export function useLiveScores(matches: MatchSummary[] | undefined, opts: { enabled?: boolean } = {}): Record<string, LiveScore> {
  const enabled = (opts.enabled ?? true) && LIVE_ENABLED;
  const { data: meta } = useMeta();
  const [scores, setScores] = useState<Record<string, LiveScore>>({});
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  const slugByComp = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of meta?.competitions ?? []) if (typeof c.slug === 'string' && SLUG_RE.test(c.slug)) m.set(c.id, c.slug);
    return m;
  }, [meta]);

  // Firma estable de los partidos relevantes (hoy, no terminados) para no reiniciar el ciclo en cada render.
  const signature = useMemo(() => {
    try {
      const today = dayKey(new Date());
      return (matches ?? [])
        .filter((m) => m && typeof m.date === 'string' && dayKey(m.date) === today && !isFinal(m.status))
        .map((m) => `${m.id}:${m.compId}`)
        .sort()
        .join('|');
    } catch {
      return '';
    }
  }, [matches]);

  useEffect(() => {
    if (!enabled || !signature || slugByComp.size === 0) return;
    let alive = true;
    let timer: number | undefined;
    let failures = 0;
    let rotation = 0;
    let running = false;
    let lastRun = 0;
    const ctrl = new AbortController();
    const finalIds = new Set<string>();

    const schedule = (ms: number) => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = alive ? window.setTimeout(() => void cycle(), Math.max(1_000, ms)) : undefined;
    };

    /** Partidos a vigilar ahora y espera hasta el próximo que entre en ventana. */
    const plan = (now: number) => {
      const list: MatchSummary[] = [];
      let nextStart = Infinity;
      for (const m of matchesRef.current ?? []) {
        if (!m || isFinal(m.status) || finalIds.has(m.id) || !slugByComp.has(m.compId)) continue;
        if (inPlayWindow(m, now)) list.push(m);
        else {
          const t = Date.parse(m.date) - WINDOW_BEFORE_MS;
          if (Number.isFinite(t) && t > now) nextStart = Math.min(nextStart, t);
        }
      }
      return { list, wait: Number.isFinite(nextStart) ? nextStart - now : Infinity };
    };

    const cycle = async () => {
      timer = undefined;
      if (!alive || running) return;
      // Pausa: pestaña oculta o sin conexión → no se programa nada (se reanuda con los eventos).
      if (!pageVisible() || !online()) return;
      running = true;
      try {
        const now = Date.now();
        lastRun = now;
        const { list, wait } = plan(now);
        if (!list.length) {
          // Nada en juego: dormir hasta el próximo inicio (máx. 10 min, sin red).
          if (Number.isFinite(wait)) schedule(Math.min(wait, LIVE_MAX_BACKOFF_MS));
          return;
        }
        const wanted = new Set(list.map((m) => m.id));
        const pairs: [string, string][] = [];
        const seen = new Set<string>();
        for (const m of list) {
          const slug = slugByComp.get(m.compId)!;
          const d = espnDate(m.date);
          const k = `${slug}|${d}`;
          if (!seen.has(k)) {
            seen.add(k);
            pairs.push([slug, d]);
          }
        }
        // Límite por ciclo, rotando el punto de inicio para cubrir todas las competiciones con el tiempo.
        const start = pairs.length > MAX_REQUESTS_PER_CYCLE ? rotation % pairs.length : 0;
        const batch = pairs.length > MAX_REQUESTS_PER_CYCLE ? [...pairs.slice(start), ...pairs.slice(0, start)].slice(0, MAX_REQUESTS_PER_CYCLE) : pairs;
        rotation += batch.length;

        let ok = 0;
        const found: Record<string, LiveScore> = {};
        const results = await Promise.all(batch.map(([slug, d]) => fetchScoreboard(slug, d, ctrl.signal)));
        if (!alive) return;
        for (const json of results) {
          if (json === null) continue;
          ok++;
          const parsed = parseEspnScoreboard(json, now);
          for (const [id, s] of Object.entries(parsed)) {
            if (!wanted.has(id)) continue;
            found[id] = s;
            if (isFinal(s.status)) finalIds.add(id);
          }
        }
        failures = ok === 0 ? failures + 1 : 0;
        if (Object.keys(found).length) setScores((prev) => ({ ...prev, ...found }));
        schedule(liveBackoffMs(failures));
      } catch (e) {
        failures++;
        reportError('Marcadores en vivo', e);
        schedule(liveBackoffMs(failures));
      } finally {
        running = false;
      }
    };

    const resume = () => {
      if (!alive || !pageVisible() || !online()) return;
      if (timer !== undefined || running) return;
      // Al volver: si ha pasado al menos el intervalo normal (o el de backoff), consulta ya.
      const due = lastRun + liveBackoffMs(failures) - Date.now();
      if (due <= 0) void cycle();
      else schedule(due);
    };
    const onVisibility = () => {
      if (pageVisible()) resume();
      else if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };
    const onOffline = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };

    void cycle();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', resume);
    window.addEventListener('offline', onOffline);
    return () => {
      alive = false;
      ctrl.abort();
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', onOffline);
    };
  }, [enabled, signature, slugByComp]);

  return scores;
}

/** Fusiona un LiveScore en un MatchSummary (estado, detalle y marcador). */
export function applyLive(match: MatchSummary, live: LiveScore | undefined): MatchSummary {
  if (!live) return match;
  if (live.status === 'scheduled' && match.status === 'scheduled') return match;
  return {
    ...match,
    status: live.status,
    statusDetail: live.statusDetail ?? match.statusDetail,
    score: live.status === 'scheduled' ? match.score : { ...(match.score ?? {}), home: live.home, away: live.away },
  };
}

/** Atajo: aplica los marcadores en vivo a una lista. */
export function withLive(matches: MatchSummary[], scores: Record<string, LiveScore>): MatchSummary[] {
  if (!Object.keys(scores).length) return matches;
  return matches.map((m) => applyLive(m, scores[m.id]));
}
