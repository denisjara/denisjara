/**
 * Marcadores en vivo: consulta el scoreboard público de ESPN (CORS abierto) cada 60 s para las
 * competiciones con partidos de hoy en ventana de juego, y devuelve marcador/estado por id de partido.
 * Tolerante a fallos: si ESPN no responde se conservan los últimos valores conocidos.
 *
 * Desactivado por defecto con VITE_DATA_DIR=mock-data (los ids falsos no existen en ESPN).
 * Forzar: VITE_LIVE=1 (activar) / VITE_LIVE=0 (desactivar).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MatchStatus, MatchSummary } from '../../types/data';
import { DATA_DIR, useMeta } from './data';
import { dayKey } from './format';

export const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
export const LIVE_POLL_MS = 60_000;

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

/** Ventana en la que un partido puede estar en juego: de 15 min antes a 3 h 15 después del inicio. */
function inPlayWindow(m: MatchSummary, now: number): boolean {
  const t = new Date(m.date).getTime();
  return now >= t - 15 * 60_000 && now <= t + 195 * 60_000;
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

interface EspnStatus {
  displayClock?: string;
  type?: { state?: string; name?: string; shortDetail?: string; detail?: string; completed?: boolean };
}
interface EspnEvent {
  id?: string;
  competitions?: { status?: EspnStatus; competitors?: { homeAway?: string; score?: string | number }[] }[];
  status?: EspnStatus;
}

function mapStatus(st: EspnStatus | undefined): { status: MatchStatus; detail?: string } {
  const state = st?.type?.state;
  const name = st?.type?.name ?? '';
  if (name.includes('POSTPONED')) return { status: 'postponed', detail: 'Aplazado' };
  if (name.includes('CANCELED') || name.includes('CANCELLED') || name.includes('ABANDONED')) return { status: 'cancelled', detail: 'Cancelado' };
  if (state === 'in') {
    if (name.includes('HALFTIME')) return { status: 'live', detail: 'Descanso' };
    const clock = st?.displayClock || st?.type?.shortDetail;
    return { status: 'live', detail: clock && clock !== "0'" ? clock : 'En juego' };
  }
  if (state === 'post') {
    if (name.includes('PEN')) return { status: 'finished', detail: 'Final (pen.)' };
    if (name.includes('AET')) return { status: 'finished', detail: 'Final (prór.)' };
    return { status: 'finished', detail: 'Final' };
  }
  return { status: 'scheduled' };
}

/** Parsea un scoreboard de ESPN → LiveScore por id de evento. */
export function parseEspnScoreboard(json: unknown, now = Date.now()): Record<string, LiveScore> {
  const out: Record<string, LiveScore> = {};
  const events = (json as { events?: EspnEvent[] })?.events;
  if (!Array.isArray(events)) return out;
  for (const ev of events) {
    const id = ev?.id;
    const comp = ev?.competitions?.[0];
    if (!id || !comp) continue;
    const { status, detail } = mapStatus(comp.status ?? ev.status);
    const comps = comp.competitors ?? [];
    const h = comps.find((c) => c.homeAway === 'home');
    const a = comps.find((c) => c.homeAway === 'away');
    const hs = Number(h?.score);
    const as = Number(a?.score);
    out[String(id)] = {
      matchId: String(id),
      status,
      statusDetail: detail,
      home: Number.isFinite(hs) ? hs : 0,
      away: Number.isFinite(as) ? as : 0,
      updatedAt: now,
    };
  }
  return out;
}

/**
 * Hook: marcadores en vivo para `matches` (los de hoy). Devuelve un mapa id → LiveScore solo con
 * los partidos encontrados en ESPN. Sondea cada 60 s mientras haya partidos de hoy sin terminar,
 * solo para los slugs con algún partido en ventana de juego y con la pestaña visible.
 */
export function useLiveScores(matches: MatchSummary[] | undefined, opts: { enabled?: boolean } = {}): Record<string, LiveScore> {
  const enabled = (opts.enabled ?? true) && LIVE_ENABLED;
  const { data: meta } = useMeta();
  const [scores, setScores] = useState<Record<string, LiveScore>>({});
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  const slugByComp = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of meta?.competitions ?? []) m.set(c.id, c.slug);
    return m;
  }, [meta]);

  // Firma estable de los partidos relevantes (hoy, no terminados) para no reiniciar el intervalo en cada render.
  const signature = useMemo(() => {
    const today = dayKey(new Date());
    return (matches ?? [])
      .filter((m) => dayKey(m.date) === today && !isFinal(m.status))
      .map((m) => `${m.id}:${m.compId}`)
      .sort()
      .join('|');
  }, [matches]);

  useEffect(() => {
    if (!enabled || !signature || slugByComp.size === 0) return;
    let alive = true;
    const ctrl = new AbortController();

    const tick = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const now = Date.now();
      const list = (matchesRef.current ?? []).filter((m) => !isFinal(m.status) && inPlayWindow(m, now));
      if (!list.length) return;
      const wanted = new Set(list.map((m) => m.id));
      // slug → fechas ESPN necesarias
      const requests = new Map<string, Set<string>>();
      for (const m of list) {
        const slug = slugByComp.get(m.compId);
        if (!slug) continue;
        if (!requests.has(slug)) requests.set(slug, new Set());
        requests.get(slug)!.add(espnDate(m.date));
      }
      const found: Record<string, LiveScore> = {};
      await Promise.all(
        [...requests].flatMap(([slug, dates]) =>
          [...dates].map(async (d) => {
            try {
              const res = await fetch(`${ESPN_SCOREBOARD}/${slug}/scoreboard?dates=${d}`, { signal: ctrl.signal });
              if (!res.ok) return;
              const parsed = parseEspnScoreboard(await res.json(), now);
              for (const [id, s] of Object.entries(parsed)) if (wanted.has(id)) found[id] = s;
            } catch {
              /* red caída o CORS: conservamos los valores previos */
            }
          }),
        ),
      );
      if (alive && Object.keys(found).length) setScores((prev) => ({ ...prev, ...found }));
    };

    void tick();
    const timer = window.setInterval(() => void tick(), LIVE_POLL_MS);
    const onVis = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      ctrl.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
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
