/**
 * Motor del banco de pruebas: predicciones walk-forward de una variante para todos los partidos terminados de la
 * temporada actual (y de las temporadas pasadas desde WINDOWS.prev.from: ventana `prev`), métricas por ventana y
 * segmento frente a la línea base, intervalo bootstrap por día y comprobación de fuga por envenenamiento del futuro.
 * La CLI está en scripts/eval-model.ts.
 *
 * Todas las predicciones salen del mismo código que el build (createContext + walk-forward de publish/context.ts,
 * projectStatsFor y propsFor): una variante solo cambia lo que sus ganchos cambian.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DCModel } from '../../src/lib/models';
import { logLoss3, mulberry32, rps3, brier3 } from '../../src/lib/models';
import type { Prob1X2 } from '../../src/types/data';
import { ROOT_DIR, STORE_DIR, type CompetitionConfig } from '../config';
import type { CompetitionStore, MatchRecord, PlayerLine } from '../types';
import type { StatKey, TeamStatDists } from '../analytics/projections';
import { settleDataOf } from '../analytics/settle';
import { extraSettleDataOf, PLAYER_MIN_LINES_PER_TEAM } from '../analytics/daily';
import { teamGamesFromLines } from '../analytics/players';
import {
  createContext,
  fitWalkForwardModels,
  isPastSeasonTarget,
  predictWalkForward,
  projectStatsFor,
  type BuildContext,
} from '../publish/context';
import { propsFor } from '../publish/matches';
import type { ModelSuite } from '../analytics/ratings';
import { historyView } from './history';
import { BASELINE_VARIANT, isEmptyVariant, type ModelVariant } from './types';

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Ventanas (protocolo)
// ---------------------------------------------------------------------------

/**
 * Ventanas del protocolo (fechas de inicio del partido, UTC, ambos extremos incluidos). `season`: partidos de la
 * temporada actual de su competición ('current') o de una temporada pasada ('past', solo la ventana prev).
 */
export const WINDOWS = {
  /**
   * AUXILIAR (anterior al ajuste): temporada actual antes de junio. Casi todo SIN cuotas (ESPN solo da cuotas de cierre
   * en los resúmenes, que se descargan para los últimos 180 días) y solo competiciones de año natural (Brasileirão,
   * Argentina, MLS, Chile, Libertadores, Sudamericana…). Sirve para medir ideas del segmento sin cuotas; la decisión
   * sigue siendo T1 y T2.
   */
  pre: { from: '2026-01-01', to: '2026-05-31', label: 'auxiliar pre-ajuste (ene–may, casi sin cuotas)', season: 'current' },
  tuning: { from: '2026-06-01', to: '2026-09-15', label: 'ajuste (tuning)', season: 'current' },
  T1: { from: '2026-06-01', to: '2026-07-31', label: 'sub-ventana T1', season: 'current' },
  T2: { from: '2026-08-01', to: '2026-09-15', label: 'sub-ventana T2', season: 'current' },
  /**
   * CONFIRMATORIA (pre-registrada el 2026-11-26, ver README): partidos de temporadas PASADAS (currentSeason = false)
   * del 2026-01-01 al 2026-05-31: segundas vueltas de las ligas europeas 2025-26, eliminatorias de la UEFA, copas,
   * Saudí y la Clausura de la Liga MX. Nunca evaluada antes. Casi sin cuotas ni líneas de jugador (estas empiezan el
   * 2026-05-07).
   */
  prev: { from: '2026-01-01', to: '2026-05-31', label: 'confirmatoria temporadas pasadas (ene–may)', season: 'past' },
  /** unión de tuning y prev (criterio «conjunto» de la regla de decisión pre-registrada) */
  pooled: { from: '2026-01-01', to: '2026-09-15', label: 'conjunta tuning + prev', season: 'pooled' },
  holdout: { from: '2026-09-16', to: '2100-12-31', label: 'HOLDOUT', season: 'current' },
} as const;
export type WindowName = keyof typeof WINDOWS;
export const WINDOW_NAMES = Object.keys(WINDOWS) as WindowName[];

/** El banco predice también los partidos terminados de temporadas pasadas desde esta fecha (ventana prev). */
export const PAST_SEASONS_FROM = `${WINDOWS.prev.from}T00:00:00Z`;

/** El partido pertenece a la ventana (fechas y temporada actual/pasada). */
export function inWindow(i: Pick<MatchInfo, 't' | 'currentSeason'>, w: WindowName): boolean {
  if (WINDOWS[w].season === 'pooled') return inWindow(i, 'tuning') || inWindow(i, 'prev');
  const { from, to } = windowRange(w);
  return i.t >= from && i.t < to && i.currentSeason === (WINDOWS[w].season === 'current');
}

export function windowRange(w: WindowName): { from: number; to: number } {
  const def = WINDOWS[w];
  return { from: Date.parse(`${def.from}T00:00:00Z`), to: Date.parse(`${def.to}T00:00:00Z`) + DAY_MS };
}

/** Sub-ventanas de estabilidad de una ventana (para elegir los días de la comprobación de fuga). */
export function subWindows(w: WindowName): WindowName[] {
  return w === 'tuning' ? ['T1', 'T2'] : w === 'pooled' ? ['T1', 'T2', 'prev'] : [w];
}

/** Línea de corte top/resto: competiciones con tier >= TOP_TIER (top 5 ligas de Europa salvo… ver README). */
export const TOP_TIER = 8;
/** Líneas evaluadas de córners y tarjetas. */
export const CORNER_LINES = [8.5, 9.5, 10.5];
export const CARD_LINES = [3.5, 4.5];
/** Líneas evaluadas de faltas, tiros y tiros a puerta (totales del partido). */
export const FOUL_LINES = [20.5, 22.5, 24.5];
export const SHOT_LINES = [22.5, 24.5, 26.5];
export const SOT_LINES = [7.5, 8.5, 9.5];
/** Líneas por equipo: goles (Poisson de los λ finales), tarjetas y córners (binomial negativa de la proyección). */
export const TEAM_GOAL_LINES = [0.5, 1.5];
export const TEAM_CARD_LINES = [1.5, 2.5];
export const TEAM_CORNER_LINES = [3.5, 4.5, 5.5];
/** Estadísticas que proyecta el banco (las mismas proyecciones que publica la ficha para estas claves). */
export const BENCH_STAT_KEYS: StatKey[] = ['corners', 'cards', 'fouls', 'shots', 'shotsOnTarget'];
/** Segmento «árbitro conocido»: partidos anteriores dirigidos por el árbitro designado. */
export const REFEREE_KNOWN_MIN = 5;
/** Segmento «final de liga»: fracción de la fase regular ya jugada antes del partido. */
export const LATE_SEASON_FRACTION = 0.75;

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------

export interface EvalData {
  stores: CompetitionStore[];
  configs: CompetitionConfig[];
  /** fecha de referencia del build (derivada de los datos para que la caché sea determinista) */
  now: Date;
  /** huella de los datos (tamaño y fecha de cada data-store/*.json) */
  fingerprint: string;
}

/** Huella de los archivos del data-store (sin leerlos enteros). */
export function storeFingerprint(dir = STORE_DIR): string {
  const h = crypto.createHash('sha1');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const st = fs.statSync(path.join(dir, f));
    h.update(`${f}:${st.size}:${Math.round(st.mtimeMs)}\n`);
  }
  return h.digest('hex').slice(0, 16);
}

/** Fecha de referencia: la última descarga de los stores (o el último partido + 1 día). */
export function dataNow(stores: CompetitionStore[]): Date {
  let t = 0;
  for (const s of stores) {
    const x = Date.parse(s.fetchedAt ?? s.updatedAt ?? '');
    if (Number.isFinite(x)) t = Math.max(t, x);
  }
  if (!t) for (const s of stores) for (const m of s.matches) t = Math.max(t, (Date.parse(m.date) || 0) + DAY_MS);
  return new Date(t || Date.now());
}

/** Huella del código del núcleo (pipeline/ salvo las variantes, src/lib/models y la CLI). */
export function codeFingerprint(): string {
  const h = crypto.createHash('sha1');
  const reserved = new Set(['types.ts', 'history.ts', 'load.ts', 'bench.ts']);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) files.push(p);
    }
  };
  walk(path.join(ROOT_DIR, 'pipeline'));
  walk(path.join(ROOT_DIR, 'src', 'lib', 'models'));
  const cli = path.join(ROOT_DIR, 'scripts', 'eval-model.ts');
  if (fs.existsSync(cli)) files.push(cli);
  for (const f of files.sort()) {
    const rel = path.relative(ROOT_DIR, f);
    if (rel.startsWith(`pipeline${path.sep}experiments${path.sep}`) && !reserved.has(path.basename(f))) continue;
    h.update(rel);
    h.update(fs.readFileSync(f));
  }
  return h.digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Resultado real y segmentos
// ---------------------------------------------------------------------------

/** Resultado de las props de un jugador (no jugó = todo 0: las probabilidades publicadas incluyen no jugar). */
export interface PlayerOutcome {
  /** marcó (gol, sin autogoles) */
  g: 0 | 1;
  /** >= 1 tiro a puerta */
  s1: 0 | 1;
  /** >= 2 tiros */
  sh2: 0 | 1;
  /** >= 1 tarjeta (amarilla o roja) */
  c: 0 | 1;
}

/** Segmentos definidos SOLO con información previa al partido (walk-forward). */
export interface SegmentFlags {
  /** árbitro designado con >= REFEREE_KNOWN_MIN partidos anteriores dirigidos (todas las competiciones) */
  refereeKnown: boolean;
  /** vuelta de una eliminatoria a doble partido («· Vuelta» en la ronda) */
  secondLeg: boolean;
  /** partido de liga (fase regular) con >= LATE_SEASON_FRACTION de su fase ya jugada antes del inicio */
  lateSeason: boolean;
  /** algún equipo tiene un habitual (>= 60 % de los minutos en sus 5 últimos partidos) que no jugó el último */
  missingRegular: boolean;
}

export interface MatchInfo {
  id: string;
  date: string;
  t: number;
  /** día UTC (YYYY-MM-DD), unidad del bootstrap */
  day: string;
  compId: string;
  kind: CompetitionConfig['kind'];
  tier: number;
  /** temporada actual de su competición (false: temporada pasada, solo ventana prev) */
  currentSeason: boolean;
  outcome: 0 | 1 | 2;
  /** marcador a 90' (prórrogas reconstruidas con los eventos de gol) */
  hg: number;
  ag: number;
  /** córners/tarjetas totales (nunca con prórroga; 0 tarjetas = ausente) y por equipo [local, visitante] */
  corners?: number;
  cards?: number;
  teamCorners?: [number, number];
  teamCards?: [number, number];
  /** faltas, tiros y tiros a puerta totales (mismos criterios que los pronósticos del día: extraSettleDataOf) */
  fouls?: number;
  shots?: number;
  sot?: number;
  /**
   * resultado de las props por jugador (solo partidos con líneas de jugador válidas; sin prórroga), con clave
   * playerKey(id, lado): un jugador puede tener props en los DOS equipos (líneas previas con ambos tras un traspaso)
   */
  players?: Map<string, PlayerOutcome>;
  seg: SegmentFlags;
}

/** Clave de un jugador en un partido: id y lado ('h' local, 'a' visitante). */
export function playerKey(id: string, side: 'h' | 'a'): string {
  return `${id}|${side}`;
}

/** Fase regular de liga de un partido (clave) o undefined (copa, continental, eliminatoria o playoff). */
function leaguePhase(m: MatchRecord, comp: CompetitionConfig): string | undefined {
  if (comp.kind !== 'league') return undefined;
  const r = m.round ?? '';
  if (r.includes(' · ')) return undefined; // «Apertura · Final», «Playoff de ascenso · …»
  if (/playoff|play-in|final/i.test(r)) return undefined;
  return `${m.compId}|${m.season}|${m.currentSeason ? 'a' : 'p'}|${r}`;
}

/** ¿Algún habitual del equipo (>= 60 % de los minutos en sus 5 últimos partidos) no jugó su último partido? */
function missingRegularOf(lines: readonly PlayerLine[], teamId: string): boolean {
  const games = (teamGamesFromLines([...lines]).get(teamId) ?? []).slice(-5);
  if (games.length < 5) return false;
  const ids = new Set(games.map((g) => g.matchId));
  const last = games[games.length - 1].matchId;
  const minutes = new Map<string, number>();
  const playedLast = new Set<string>();
  for (const l of lines) {
    if (!ids.has(l.matchId) || !(l.minutes > 0)) continue;
    minutes.set(l.playerId, (minutes.get(l.playerId) ?? 0) + Math.min(l.minutes, 90));
    if (l.matchId === last) playedLast.add(l.playerId);
  }
  for (const [pid, min] of minutes) if (min >= 0.6 * 90 * games.length && !playedLast.has(pid)) return true;
  return false;
}

/**
 * Resultado real de los partidos terminados que predice el banco: temporada actual y, si el contexto las incluye
 * (pastSeasonsFrom), temporadas pasadas desde esa fecha. A 90'; sin resolver ⇒ excluido. Los segmentos se calculan
 * solo con información anterior al inicio de cada partido.
 */
export function matchInfos(ctx: BuildContext): Map<string, MatchInfo> {
  const out = new Map<string, MatchInfo>();
  // fixtures de cada fase regular de liga (calendario conocido antes de la temporada) y partidos terminados por fase
  const phaseTotal = new Map<string, number>();
  const phaseDone = new Map<string, number[]>();
  for (const m of ctx.allMatches) {
    const comp = ctx.configById.get(m.compId);
    const ph = comp && m.status !== 'cancelled' ? leaguePhase(m, comp) : undefined;
    if (!ph) continue;
    phaseTotal.set(ph, (phaseTotal.get(ph) ?? 0) + 1);
    if (m.status === 'finished' && m.score) (phaseDone.get(ph) ?? phaseDone.set(ph, []).get(ph)!).push(Date.parse(m.date));
  }
  for (const m of ctx.allMatches) {
    if (!m.currentSeason && !isPastSeasonTarget(ctx, m)) continue;
    const comp = ctx.configById.get(m.compId);
    if (!comp) continue;
    const d = settleDataOf(m);
    if (!d) continue;
    const t = Date.parse(m.date);
    const view = historyView(ctx.history, t);
    const ph = leaguePhase(m, comp);
    const total = ph ? (phaseTotal.get(ph) ?? 0) : 0;
    const done = ph ? (phaseDone.get(ph) ?? []).filter((x) => x < t).length : 0;
    const info: MatchInfo = {
      id: m.id,
      date: m.date,
      t,
      day: new Date(t).toISOString().slice(0, 10),
      compId: m.compId,
      kind: comp.kind,
      tier: comp.tier,
      currentSeason: m.currentSeason,
      outcome: d.hg > d.ag ? 0 : d.hg === d.ag ? 1 : 2,
      hg: d.hg,
      ag: d.ag,
      seg: {
        refereeKnown: !!m.referee?.id && view.refereeMatches(m.referee.id).length >= REFEREE_KNOWN_MIN,
        secondLeg: /·\s*Vuelta\b/.test(m.round ?? ''),
        lateSeason: total > 0 && done / total >= LATE_SEASON_FRACTION,
        missingRegular: missingRegularOf(view.playerLines(m.home.id), m.home.id) || missingRegularOf(view.playerLines(m.away.id), m.away.id),
      },
    };
    const sh = m.stats?.home;
    const sa = m.stats?.away;
    if (d.corners !== undefined) {
      info.corners = d.corners;
      info.teamCorners = [sh!.corners!, sa!.corners!];
    }
    if (d.cards !== undefined) {
      info.cards = d.cards;
      info.teamCards = [sh!.yellow! + (sh!.red ?? 0), sa!.yellow! + (sa!.red ?? 0)];
    }
    const ed = extraSettleDataOf(ctx, m, d);
    if (ed.fouls) info.fouls = ed.fouls.home + ed.fouls.away;
    if (ed.shots) info.shots = ed.shots.home + ed.shots.away;
    if (ed.shotsOnTarget) info.sot = ed.shotsOnTarget.home + ed.shotsOnTarget.away;
    // props: mismas condiciones que los pronósticos del día (sin prórroga, >= 7 jugadores por equipo, algún tiro)
    if (ed.players) {
      const players = new Map<string, PlayerOutcome>();
      for (const l of ctx.linesByMatch.get(m.id) ?? []) {
        if (!(l.minutes > 0) || (l.teamId !== m.home.id && l.teamId !== m.away.id)) continue;
        players.set(playerKey(l.playerId, l.teamId === m.home.id ? 'h' : 'a'), { g: l.goals > 0 ? 1 : 0, s1: l.shotsOnTarget > 0 ? 1 : 0, sh2: l.shots >= 2 ? 1 : 0, c: l.yellow + l.red > 0 ? 1 : 0 });
      }
      if (players.size >= 2 * PLAYER_MIN_LINES_PER_TEAM) info.players = players;
    }
    out.set(m.id, info);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Predicciones de una variante
// ---------------------------------------------------------------------------

export interface StatPred {
  /** total esperado */
  exp: number;
  /** P(más de la línea) en las líneas del total (CORNER_LINES, CARD_LINES, FOUL_LINES…) */
  over: number[];
  /** distribución del total (5 decimales, cola plegada) */
  dist: number[];
  /** P(más de la línea) de cada equipo en las líneas por equipo (córners y tarjetas) */
  home?: number[];
  away?: number[];
}

/** Props publicadas de un jugador (las que daría propsFor: ficha del partido y pronósticos del día). */
export interface PlayerPred {
  id: string;
  /** lado del equipo para el que se publica ('h' local, 'a' visitante) */
  s: 'h' | 'a';
  /** P(marca) */
  g: number;
  /** P(>= 1 tiro a puerta) */
  s1: number;
  /** P(>= 2 tiros) */
  sh2: number;
  /** P(>= 1 tarjeta) */
  c: number;
}

export interface PredRow {
  id: string;
  p: [number, number, number];
  over25: number;
  btts: number;
  lh: number;
  la: number;
  /** la predicción usó mercado (cuotas 1X2 válidas) */
  mk: boolean;
  /** fuentes: Elo solo, fuente de goles sola (DC o Elo→goles) y mercado sin margen (si hay cuotas) */
  ep: [number, number, number];
  gp: [number, number, number];
  mp?: [number, number, number];
  corners?: StatPred;
  cards?: StatPred;
  fouls?: StatPred;
  shots?: StatPred;
  sot?: StatPred;
  /** props de los jugadores de ambos equipos (solo partidos con líneas de jugador válidas) */
  pl?: PlayerPred[];
}

const tri = (p: Prob1X2): [number, number, number] => [p.home, p.draw, p.away];

/** DC walk-forward serializable (caché); `past`: el adicional de temporadas pasadas (BuildContext.wfPast). */
interface DcCache {
  leagues: DcLeagues;
  past?: { before: number; leagues: DcLeagues };
}
type DcLeagues = { id: string; models: DCModel[]; byMatch: [string, number][]; timeline: [number, number][] }[];

export interface VariantRun {
  variant: ModelVariant;
  rows: Map<string, PredRow>;
  ctx?: BuildContext;
  dc?: DcCache;
  seconds: number;
  fromCache?: boolean;
}

function serializeDc(ctx: BuildContext): DcCache {
  const out: DcCache = { leagues: serializeLeagues(ctx.wfModels, ctx.wfTimeline) };
  if (ctx.wfPast) out.past = { before: ctx.wfPast.before, leagues: serializeLeagues(ctx.wfPast.models, ctx.wfPast.timeline) };
  return out;
}

function serializeLeagues(wfModels: BuildContext['wfModels'], wfTimeline: BuildContext['wfTimeline']): DcLeagues {
  const leagues: DcLeagues = [];
  for (const [id, byMatch] of wfModels) {
    const idx = new Map<DCModel, number>();
    const models: DCModel[] = [];
    const add = (m: DCModel) => {
      let i = idx.get(m);
      if (i === undefined) {
        i = models.length;
        models.push(m);
        idx.set(m, i);
      }
      return i;
    };
    const pairs: [string, number][] = [...byMatch].map(([mid, m]) => [mid, add(m)]);
    const timeline: [number, number][] = (wfTimeline.get(id) ?? []).map((e) => [e.t, add(e.model)]);
    leagues.push({ id, models, byMatch: pairs, timeline });
  }
  return leagues;
}

function restoreDc(ctx: BuildContext, c: DcCache): void {
  for (const l of c.leagues) {
    ctx.wfModels.set(l.id, new Map(l.byMatch.map(([mid, i]) => [mid, l.models[i]])));
    ctx.wfTimeline.set(l.id, l.timeline.map(([t, i]) => ({ t, model: l.models[i] })));
  }
  if (c.past) {
    const past: NonNullable<BuildContext['wfPast']> = { before: c.past.before, models: new Map(), timeline: new Map() };
    for (const l of c.past.leagues) {
      past.models.set(l.id, new Map(l.byMatch.map(([mid, i]) => [mid, l.models[i]])));
      past.timeline.set(l.id, l.timeline.map(([t, i]) => ({ t, model: l.models[i] })));
    }
    ctx.wfPast = past;
  }
}

/** P(X > línea) de una distribución discreta (masa en 0..n). */
function overOf(dist: readonly number[], line: number): number {
  let s = 0;
  for (let k = Math.floor(line) + 1; k < dist.length; k++) s += dist[k];
  return Math.min(1, Math.max(0, s));
}

function statPred(
  p: { total: number; totalDist: number[]; lines: { line: number; over: number }[] } | undefined,
  lines: number[],
  team?: { dists: { home: number[]; away: number[] } | undefined; lines: number[] },
): StatPred | undefined {
  if (!p) return undefined;
  // líneas publicadas de la proyección (exactas); si la línea no se publica, de la distribución del total
  const over = lines.map((l) => p.lines.find((x) => Math.abs(x.line - l) < 1e-9)?.over ?? overOf(p.totalDist, l));
  if (!over.every(Number.isFinite)) return undefined;
  const out: StatPred = { exp: p.total, over, dist: p.totalDist };
  if (team?.dists) {
    out.home = team.lines.map((l) => round6(overOf(team.dists!.home, l)));
    out.away = team.lines.map((l) => round6(overOf(team.dists!.away, l)));
  }
  return out;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export interface RunOptions {
  /**
   * ejecución de la línea base con LOS MISMOS datos: reutiliza los modelos actuales (si la variante tiene los mismos
   * ganchos elo/dc que ella), el DC walk-forward (mismos ganchos dc) y las proyecciones de córners/tarjetas (mismos
   * ganchos stats)
   */
  reuse?: VariantRun;
  /** DC walk-forward ya ajustado con los mismos datos de liga y los mismos ganchos dc (se restaura en vez de ajustar) */
  dc?: DcCache;
  /** solo estos partidos (comprobación de fuga) */
  onlyIds?: Set<string>;
  /** resultado real de los partidos (córners/tarjetas solo se proyectan si el partido tiene el dato); por defecto se
   *  calcula con el contexto de la propia ejecución */
  infos?: Map<string, MatchInfo>;
  log?: (msg: string) => void;
}

/**
 * Mismos ganchos de estadísticas. Los valores simples se comparan por contenido; con una función (stats.adjust) solo
 * el MISMO objeto cuenta como igual (JSON.stringify omite las funciones: una variante con adjust reutilizaría las
 * proyecciones de la base).
 */
function sameStats(a: ModelVariant['stats'], b: ModelVariant['stats']): boolean {
  if (a?.adjust || b?.adjust) return a === b;
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

/** Predicciones walk-forward de una variante (mismo código que el build). */
export function runVariant(variant: ModelVariant, data: EvalData, opts: RunOptions = {}): VariantRun {
  const t0 = performance.now();
  const empty = isEmptyVariant(variant);
  const reuse = opts.reuse;
  // los ganchos elo/dc pueden ser funciones: solo se reutiliza con los MISMOS objetos (o sin ganchos en ambas)
  const sameRatings = !!reuse && variant.elo === reuse.variant.elo && variant.dc === reuse.variant.dc;
  const reuseSuite: ModelSuite | undefined = sameRatings ? reuse?.ctx?.suite : undefined;
  const ctx = createContext({
    stores: data.stores,
    configs: data.configs,
    now: data.now,
    variant: empty ? undefined : variant,
    suite: reuseSuite,
    pastSeasonsFrom: PAST_SEASONS_FROM,
  });
  const dc = opts.dc ?? (reuse && variant.dc === reuse.variant.dc ? reuse.dc : undefined);
  if (dc) restoreDc(ctx, dc);
  else fitWalkForwardModels(ctx);
  predictWalkForward(ctx);

  const rows = new Map<string, PredRow>();
  for (const [id, wf] of ctx.wf) {
    if (opts.onlyIds && !opts.onlyIds.has(id)) continue;
    rows.set(id, {
      id,
      p: [wf.p.home, wf.p.draw, wf.p.away],
      over25: wf.over25,
      btts: wf.btts,
      lh: wf.lambdaHome,
      la: wf.lambdaAway,
      mk: !!wf.sources.market,
      ep: [wf.sources.elo.home, wf.sources.elo.draw, wf.sources.elo.away],
      gp: tri((wf.sources.dc ?? wf.sources.eloGoals)!),
      ...(wf.sources.market ? { mp: tri(wf.sources.market) } : {}),
    });
  }
  // estadísticas: solo dependen de los ganchos `stats`; props de jugadores: de `stats`, `players` y los λ finales.
  // Solo partidos con el dato real (o con líneas de jugador).
  const infos = opts.infos ?? matchInfos(ctx);
  const reuseStats = !!reuse && sameStats(variant.stats, reuse.variant.stats);
  const reusePlayers = reuseStats && variant.players === reuse!.variant.players;
  for (const row of rows.values()) {
    const info = infos.get(row.id);
    if (!info) continue;
    const b = reuse?.rows.get(row.id);
    if (reuseStats) {
      for (const k of ['corners', 'cards', 'fouls', 'shots', 'sot'] as const) if (b?.[k]) row[k] = b[k];
    }
    const wantPlayers = !!info.players;
    const playersDone = wantPlayers && reusePlayers && !!b && b.lh === row.lh && b.la === row.la;
    if (playersDone && b.pl) row.pl = b.pl;
    const wantStats = !reuseStats && [info.corners, info.cards, info.fouls, info.shots, info.sot].some((x) => x !== undefined);
    if (!wantStats && (!wantPlayers || playersDone)) continue;
    const m = ctx.matchById.get(row.id)!;
    const t = Date.parse(m.date);
    const dists: TeamStatDists = new Map();
    const projs = projectStatsFor(ctx, m, t, { keys: BENCH_STAT_KEYS, teamDists: dists });
    if (wantStats) {
      const get = (k: StatKey) => projs.find((p) => p.key === k);
      const c = statPred(get('corners'), CORNER_LINES, { dists: dists.get('corners'), lines: TEAM_CORNER_LINES });
      const k = statPred(get('cards'), CARD_LINES, { dists: dists.get('cards'), lines: TEAM_CARD_LINES });
      const f = statPred(get('fouls'), FOUL_LINES);
      const sh = statPred(get('shots'), SHOT_LINES);
      const so = statPred(get('shotsOnTarget'), SOT_LINES);
      if (c && info.corners !== undefined) row.corners = c;
      if (k && info.cards !== undefined) row.cards = k;
      if (f && info.fouls !== undefined) row.fouls = f;
      if (sh && info.shots !== undefined) row.shots = sh;
      if (so && info.sot !== undefined) row.sot = so;
    }
    if (wantPlayers && !playersDone) {
      // el mismo camino que la ficha del partido (propsFor con el gancho `players` de la variante)
      const pl: PlayerPred[] = [];
      for (const [team, opp, side, lambda] of [
        [m.home.id, m.away.id, 'home', row.lh],
        [m.away.id, m.home.id, 'away', row.la],
      ] as const) {
        for (const p of propsFor(ctx, team, opp, side, lambda, projs, t, m)) pl.push({ id: p.player.id, s: side === 'home' ? 'h' : 'a', g: p.pGoal, s1: p.pSot1, sh2: p.pShots2, c: p.pCard });
      }
      if (pl.length) row.pl = pl;
    }
  }
  return { variant, rows, ctx, dc: dc ?? serializeDc(ctx), seconds: (performance.now() - t0) / 1000 };
}

// ---------------------------------------------------------------------------
// Caché en disco de la línea base
// ---------------------------------------------------------------------------

export const CACHE_DIR = path.join(ROOT_DIR, '.cache', 'eval');

interface BaselineCacheFile {
  /** 4: ventana prev (temporadas pasadas), faltas/tiros/tiros a puerta, líneas por equipo y props de jugadores */
  version: 4;
  key: string;
  rows: PredRow[];
  dc: DcCache;
}

export function baselineCachePath(data: EvalData, code = codeFingerprint()): string {
  return path.join(CACHE_DIR, 'cache', `baseline-${data.fingerprint}-${code}.json`);
}

/**
 * Línea base (BASELINE_VARIANT: la versión ANTERIOR de producción, ver types.ts) con caché en disco por huella de datos
 * y de código.
 */
export function runBaseline(data: EvalData, opts: { infos?: Map<string, MatchInfo>; noCache?: boolean; log?: (m: string) => void } = {}): VariantRun {
  const file = baselineCachePath(data);
  const variant: ModelVariant = BASELINE_VARIANT;
  if (!opts.noCache && fs.existsSync(file)) {
    const t0 = performance.now();
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8')) as BaselineCacheFile;
      if (c.version === 4) {
        // contexto ligero (índices y modelos actuales) para reutilizar en las variantes
        const ctx = createContext({ stores: data.stores, configs: data.configs, now: data.now, pastSeasonsFrom: PAST_SEASONS_FROM });
        return { variant, rows: new Map(c.rows.map((r) => [r.id, r])), ctx, dc: c.dc, seconds: (performance.now() - t0) / 1000, fromCache: true };
      }
    } catch {
      // caché corrupta: se recalcula
    }
  }
  const run = runVariant(variant, data, { infos: opts.infos, log: opts.log });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // las cachés viejas de la línea base se borran (cambian con cada descarga o cambio del núcleo)
    for (const f of fs.readdirSync(path.dirname(file))) if (f.startsWith('baseline-') && path.join(path.dirname(file), f) !== file) fs.rmSync(path.join(path.dirname(file), f), { force: true });
    const out: BaselineCacheFile = { version: 4, key: path.basename(file), rows: [...run.rows.values()], dc: run.dc! };
    fs.writeFileSync(file, JSON.stringify(out));
  } catch {
    // sin caché en disco: no es un error
  }
  return run;
}

// ---------------------------------------------------------------------------
// Métricas
// ---------------------------------------------------------------------------

const EPS = 1e-12;
const probOf = (p: [number, number, number]): Prob1X2 => ({ home: p[0], draw: p[1], away: p[2] });

export interface StatLoss {
  brier: number[];
  brierMean: number;
  ae: number;
  nll: number;
}

/** Brier por equipo: media de local y visitante en cada línea. */
export interface TeamLoss {
  brier: number[];
  brierMean: number;
}

export interface Losses {
  rps: number;
  logLoss: number;
  brier: number;
  hit: number;
  ouBrier: number;
  ouLogLoss: number;
  ouHit: number;
  bttsBrier: number;
  bttsLogLoss: number;
  bttsHit: number;
  /** deviance Poisson media de los dos equipos */
  deviance: number;
  corners?: StatLoss;
  cards?: StatLoss;
  fouls?: StatLoss;
  shots?: StatLoss;
  sot?: StatLoss;
  /** goles por equipo más de 0,5/1,5: Poisson con los λ finales (ignora la corrección τ de Dixon-Coles) */
  teamGoals: TeamLoss;
  teamCards?: TeamLoss;
  teamCorners?: TeamLoss;
}

function binLoss(p: number, y: 0 | 1): { brier: number; logLoss: number; hit: number } {
  const q = Math.min(1 - EPS, Math.max(EPS, p));
  return { brier: (p - y) ** 2, logLoss: -(y ? Math.log(q) : Math.log(1 - q)), hit: (p >= 0.5 ? 1 : 0) === y ? 1 : 0 };
}

function poissonDeviance(y: number, mu: number): number {
  const m = Math.max(mu, 1e-9);
  return 2 * ((y > 0 ? y * Math.log(y / m) : 0) - (y - m));
}

function statLoss(pred: StatPred | undefined, actual: number | undefined, lines: number[]): StatLoss | undefined {
  if (!pred || actual === undefined) return undefined;
  const brier = lines.map((l, i) => (pred.over[i] - (actual > l ? 1 : 0)) ** 2);
  const k = Math.min(actual, pred.dist.length - 1);
  const pk = actual > pred.dist.length - 1 ? pred.dist[pred.dist.length - 1] : pred.dist[k];
  return { brier, brierMean: brier.reduce((s, x) => s + x, 0) / brier.length, ae: Math.abs(pred.exp - actual), nll: -Math.log(Math.max(1e-6, pk)) };
}

function teamLoss(home: number[] | undefined, away: number[] | undefined, actual: [number, number] | undefined, lines: number[]): TeamLoss | undefined {
  if (!home || !away || !actual) return undefined;
  const brier = lines.map((l, i) => ((home[i] - (actual[0] > l ? 1 : 0)) ** 2 + (away[i] - (actual[1] > l ? 1 : 0)) ** 2) / 2);
  return { brier, brierMean: brier.reduce((s, x) => s + x, 0) / brier.length };
}

/** P(Poisson(λ) > línea). */
function poissonOver(lambda: number, line: number): number {
  const l = Math.max(lambda, 1e-9);
  let term = Math.exp(-l);
  let cdf = term;
  for (let k = 1; k <= Math.floor(line); k++) {
    term *= l / k;
    cdf += term;
  }
  return Math.min(1, Math.max(0, 1 - cdf));
}

/** Pérdidas por partido de una predicción frente al resultado real. */
export function lossesOf(r: PredRow, info: MatchInfo): Losses {
  const p = probOf(r.p);
  const o = info.outcome;
  const ou = binLoss(r.over25, info.hg + info.ag > 2.5 ? 1 : 0);
  const bt = binLoss(r.btts, info.hg > 0 && info.ag > 0 ? 1 : 0);
  const best = r.p[0] >= r.p[1] && r.p[0] >= r.p[2] ? 0 : r.p[1] >= r.p[2] ? 1 : 2;
  return {
    rps: rps3(p, o),
    logLoss: logLoss3(p, o),
    brier: brier3(p, o),
    hit: best === o ? 1 : 0,
    ouBrier: ou.brier,
    ouLogLoss: ou.logLoss,
    ouHit: ou.hit,
    bttsBrier: bt.brier,
    bttsLogLoss: bt.logLoss,
    bttsHit: bt.hit,
    deviance: (poissonDeviance(info.hg, r.lh) + poissonDeviance(info.ag, r.la)) / 2,
    corners: statLoss(r.corners, info.corners, CORNER_LINES),
    cards: statLoss(r.cards, info.cards, CARD_LINES),
    fouls: statLoss(r.fouls, info.fouls, FOUL_LINES),
    shots: statLoss(r.shots, info.shots, SHOT_LINES),
    sot: statLoss(r.sot, info.sot, SOT_LINES),
    teamGoals: teamLoss(
      TEAM_GOAL_LINES.map((l) => poissonOver(r.lh, l)),
      TEAM_GOAL_LINES.map((l) => poissonOver(r.la, l)),
      [info.hg, info.ag],
      TEAM_GOAL_LINES,
    )!,
    teamCards: teamLoss(r.cards?.home, r.cards?.away, info.teamCards, TEAM_CARD_LINES),
    teamCorners: teamLoss(r.corners?.home, r.corners?.away, info.teamCorners, TEAM_CORNER_LINES),
  };
}

export interface StatMetrics {
  n: number;
  /** Brier por línea (CORNER_LINES / CARD_LINES…) */
  brier: number[];
  brierMean: number;
  mae: number;
  /** log-verosimilitud negativa media del total exacto */
  nll: number;
}

export interface TeamMetrics {
  n: number;
  /** Brier por línea (media de local y visitante) */
  brier: number[];
  brierMean: number;
}

export interface Metrics {
  n: number;
  x12: { rps: number; logLoss: number; brier: number; accuracy: number };
  ou25: { brier: number; logLoss: number; accuracy: number };
  btts: { brier: number; logLoss: number; accuracy: number };
  goalsDeviance: number;
  corners?: StatMetrics;
  cards?: StatMetrics;
  fouls?: StatMetrics;
  shots?: StatMetrics;
  sot?: StatMetrics;
  teamGoals?: TeamMetrics;
  teamCards?: TeamMetrics;
  teamCorners?: TeamMetrics;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
}

function statMetrics(ls: (StatLoss | undefined)[]): StatMetrics | undefined {
  const xs = ls.filter((x): x is StatLoss => !!x);
  if (!xs.length) return undefined;
  const k = xs[0].brier.length;
  return {
    n: xs.length,
    brier: Array.from({ length: k }, (_, i) => mean(xs.map((x) => x.brier[i]))),
    brierMean: mean(xs.map((x) => x.brierMean)),
    mae: mean(xs.map((x) => x.ae)),
    nll: mean(xs.map((x) => x.nll)),
  };
}

function teamMetrics(ls: (TeamLoss | undefined)[]): TeamMetrics | undefined {
  const xs = ls.filter((x): x is TeamLoss => !!x);
  if (!xs.length) return undefined;
  const k = xs[0].brier.length;
  return { n: xs.length, brier: Array.from({ length: k }, (_, i) => mean(xs.map((x) => x.brier[i]))), brierMean: mean(xs.map((x) => x.brierMean)) };
}

export function metricsOf(ls: Losses[]): Metrics {
  return {
    n: ls.length,
    x12: { rps: mean(ls.map((l) => l.rps)), logLoss: mean(ls.map((l) => l.logLoss)), brier: mean(ls.map((l) => l.brier)), accuracy: mean(ls.map((l) => l.hit)) },
    ou25: { brier: mean(ls.map((l) => l.ouBrier)), logLoss: mean(ls.map((l) => l.ouLogLoss)), accuracy: mean(ls.map((l) => l.ouHit)) },
    btts: { brier: mean(ls.map((l) => l.bttsBrier)), logLoss: mean(ls.map((l) => l.bttsLogLoss)), accuracy: mean(ls.map((l) => l.bttsHit)) },
    goalsDeviance: mean(ls.map((l) => l.deviance)),
    corners: statMetrics(ls.map((l) => l.corners)),
    cards: statMetrics(ls.map((l) => l.cards)),
    fouls: statMetrics(ls.map((l) => l.fouls)),
    shots: statMetrics(ls.map((l) => l.shots)),
    sot: statMetrics(ls.map((l) => l.sot)),
    teamGoals: teamMetrics(ls.map((l) => l.teamGoals)),
    teamCards: teamMetrics(ls.map((l) => l.teamCards)),
    teamCorners: teamMetrics(ls.map((l) => l.teamCorners)),
  };
}

/** Pérdidas de una prop de jugador: Brier y log-loss (probabilidad recortada a [0,001; 0,999]). */
function propLoss(p: number, y: 0 | 1): { brier: number; logLoss: number } {
  const q = Math.min(0.999, Math.max(0.001, p));
  return { brier: (p - y) ** 2, logLoss: -(y ? Math.log(q) : Math.log(1 - q)) };
}

/** Métricas principales: las del informe, por ventana y por segmento, con IC bootstrap por día de la diferencia. */
export const MAIN_METRICS = [
  { key: 'rps', label: '1X2 RPS', get: (l: Losses) => l.rps },
  { key: 'logLoss', label: '1X2 log-loss', get: (l: Losses) => l.logLoss },
  { key: 'brier', label: '1X2 Brier', get: (l: Losses) => l.brier },
  { key: 'ouBrier', label: 'Más/menos 2,5 Brier', get: (l: Losses) => l.ouBrier },
  { key: 'bttsBrier', label: 'Ambos marcan Brier', get: (l: Losses) => l.bttsBrier },
  { key: 'deviance', label: 'Goles deviance', get: (l: Losses) => l.deviance },
  { key: 'teamGoals', label: 'Goles equipo Brier (0,5/1,5)', get: (l: Losses) => l.teamGoals.brierMean },
  { key: 'corners', label: 'Córners Brier', get: (l: Losses) => l.corners?.brierMean },
  { key: 'teamCorners', label: 'Córners equipo Brier', get: (l: Losses) => l.teamCorners?.brierMean },
  { key: 'cards', label: 'Tarjetas Brier', get: (l: Losses) => l.cards?.brierMean },
  { key: 'teamCards', label: 'Tarjetas equipo Brier', get: (l: Losses) => l.teamCards?.brierMean },
  { key: 'fouls', label: 'Faltas Brier', get: (l: Losses) => l.fouls?.brierMean },
  { key: 'shots', label: 'Tiros Brier', get: (l: Losses) => l.shots?.brierMean },
  { key: 'sot', label: 'Tiros a puerta Brier', get: (l: Losses) => l.sot?.brierMean },
] as const;

/** Props de jugadores (pares partido-jugador publicados por la base y la variante). */
export const PLAYER_METRICS = [
  { key: 'pScorer', label: 'Goleador Brier', field: 'g', loss: 'brier' },
  { key: 'pScorerLL', label: 'Goleador log-loss', field: 'g', loss: 'logLoss' },
  { key: 'pSot1', label: '>= 1 tiro a puerta Brier', field: 's1', loss: 'brier' },
  { key: 'pSot1LL', label: '>= 1 tiro a puerta log-loss', field: 's1', loss: 'logLoss' },
  { key: 'pShots2', label: '>= 2 tiros Brier', field: 'sh2', loss: 'brier' },
  { key: 'pShots2LL', label: '>= 2 tiros log-loss', field: 'sh2', loss: 'logLoss' },
  { key: 'pCard', label: 'Tarjeta Brier', field: 'c', loss: 'brier' },
  { key: 'pCardLL', label: 'Tarjeta log-loss', field: 'c', loss: 'logLoss' },
] as const;

export type MainKey = (typeof MAIN_METRICS)[number]['key'] | (typeof PLAYER_METRICS)[number]['key'];

export interface MainMetric {
  key: MainKey;
  label: string;
  /** partidos (o pares partido-jugador en las props) con el dato en ambas */
  n: number;
  baseline: number;
  variant: number;
  ci: DiffCI;
}

// ---------------------------------------------------------------------------
// Bootstrap por día
// ---------------------------------------------------------------------------

export interface DiffCI {
  /** media de (variante − base); negativo = la variante pierde menos */
  diff: number;
  lo: number;
  hi: number;
  /** fracción de réplicas con diferencia < 0 */
  pBetter: number;
  n: number;
  days: number;
}

/** Intervalo bootstrap (percentiles 2,5–97,5) de la diferencia media remuestreando DÍAS completos. */
export function bootstrapByDay(items: { day: string; diff: number }[], reps = 1000, seed = 20261121): DiffCI {
  const byDay = new Map<string, { s: number; n: number }>();
  for (const it of items) {
    const e = byDay.get(it.day) ?? { s: 0, n: 0 };
    e.s += it.diff;
    e.n++;
    byDay.set(it.day, e);
  }
  const days = [...byDay.keys()].sort().map((d) => byDay.get(d)!);
  const total = items.reduce((s, x) => s + x.diff, 0);
  const n = items.length;
  if (!days.length) return { diff: NaN, lo: NaN, hi: NaN, pBetter: NaN, n: 0, days: 0 };
  const rng = mulberry32(seed);
  const res: number[] = [];
  for (let r = 0; r < reps; r++) {
    let s = 0;
    let c = 0;
    for (let i = 0; i < days.length; i++) {
      const d = days[Math.floor(rng() * days.length)];
      s += d.s;
      c += d.n;
    }
    res.push(c ? s / c : 0);
  }
  res.sort((a, b) => a - b);
  const q = (p: number) => res[Math.min(res.length - 1, Math.max(0, Math.floor(p * (res.length - 1))))];
  return { diff: total / n, lo: q(0.025), hi: q(0.975), pBetter: res.filter((x) => x < 0).length / res.length, n, days: days.length };
}

// ---------------------------------------------------------------------------
// Informe
// ---------------------------------------------------------------------------

export const SEGMENTS: { id: string; label: string; test: (i: MatchInfo, b: PredRow) => boolean }[] = [
  { id: 'con-cuotas', label: 'Con cuotas', test: (_, b) => b.mk },
  { id: 'sin-cuotas', label: 'Sin cuotas', test: (_, b) => !b.mk },
  { id: 'ligas', label: 'Ligas', test: (i) => i.kind === 'league' },
  { id: 'copas', label: 'Copas', test: (i) => i.kind === 'cup' },
  { id: 'continentales', label: 'Continentales', test: (i) => i.kind === 'continental' },
  { id: 'top', label: `Top (tier >= ${TOP_TIER})`, test: (i) => i.tier >= TOP_TIER },
  { id: 'resto', label: 'Resto', test: (i) => i.tier < TOP_TIER },
  // definidos SOLO con información previa al partido (ver SegmentFlags)
  { id: 'arbitro-conocido', label: `Árbitro >= ${REFEREE_KNOWN_MIN} previos`, test: (i) => i.seg.refereeKnown },
  { id: 'vuelta', label: 'Vuelta de eliminatoria', test: (i) => i.seg.secondLeg },
  { id: 'final-de-liga', label: 'Liga: último 25 %', test: (i) => i.seg.lateSeason },
  { id: 'falta-habitual', label: 'Falta un habitual', test: (i) => i.seg.missingRegular },
];

export interface SegmentReport {
  id: string;
  label: string;
  n: number;
  baseline: Metrics['x12'];
  variant: Metrics['x12'];
  rps: DiffCI;
  /** métricas principales del segmento (las que tienen dato), con su n */
  main: MainMetric[];
}

/** RPS/log-loss/Brier/acierto de cada fuente sola (contexto: cuánto aporta cada pieza). */
export interface References {
  elo: Metrics['x12'];
  goal: Metrics['x12'];
  /** partidos con cuotas: mercado sin margen frente al ensamble en los mismos partidos */
  market?: { n: number; market: Metrics['x12']; ensemble: Metrics['x12'] };
}

function x12Of(items: { p: [number, number, number]; o: 0 | 1 | 2 }[]): Metrics['x12'] {
  const ls = items.map(({ p, o }) => {
    const q = probOf(p);
    const best = p[0] >= p[1] && p[0] >= p[2] ? 0 : p[1] >= p[2] ? 1 : 2;
    return { rps: rps3(q, o), logLoss: logLoss3(q, o), brier: brier3(q, o), hit: best === o ? 1 : 0 };
  });
  return { rps: mean(ls.map((l) => l.rps)), logLoss: mean(ls.map((l) => l.logLoss)), brier: mean(ls.map((l) => l.brier)), accuracy: mean(ls.map((l) => l.hit)) };
}

function referencesOf(pairs: { i: MatchInfo; r: PredRow }[]): References {
  const withMk = pairs.filter((x) => x.r.mp);
  const out: References = {
    elo: x12Of(pairs.map((x) => ({ p: x.r.ep, o: x.i.outcome }))),
    goal: x12Of(pairs.map((x) => ({ p: x.r.gp, o: x.i.outcome }))),
  };
  if (withMk.length) {
    out.market = {
      n: withMk.length,
      market: x12Of(withMk.map((x) => ({ p: x.r.mp!, o: x.i.outcome }))),
      ensemble: x12Of(withMk.map((x) => ({ p: x.r.p, o: x.i.outcome }))),
    };
  }
  return out;
}

/** Conjuntos de props comparados: pares publicados por ambas y por solo una (con cuántos de esos jugadores jugaron). */
export interface PlayerSets {
  /** partidos con líneas de jugador válidas */
  matches: number;
  common: number;
  onlyBaseline: number;
  onlyBaselinePlayed: number;
  onlyVariant: number;
  onlyVariantPlayed: number;
}

export interface EvalReport {
  variant: string;
  description: string;
  window: WindowName;
  from: string;
  to: string;
  generatedAt: string;
  data: { fingerprint: string; now: string };
  /** partidos de la ventana con resultado y predicción de ambas */
  n: number;
  days: number;
  /** partidos de la ventana sin predicción de la variante (la base sí) */
  missing: number;
  /** partidos por competición */
  composition: Record<string, number>;
  baseline: Metrics;
  model: Metrics;
  ci: { rps: DiffCI; logLoss: DiffCI; brier: DiffCI; ouBrier: DiffCI; bttsBrier: DiffCI; deviance: DiffCI } & Partial<Record<MainKey, DiffCI>>;
  /** todas las métricas principales con dato (incluidas las props de jugadores) */
  main: MainMetric[];
  /** props de jugadores: pares (partido, jugador) publicados por ambas; si el jugador no jugó, todo 0 */
  playerSets?: PlayerSets;
  segments: SegmentReport[];
  /** cada fuente sola, en la base y en la variante (mismos partidos) */
  references: { baseline: References; variant: References };
  leak?: LeakReport;
  seconds: { baseline: number; variant: number; leak?: number };
}

interface PlayerPair {
  y: PlayerOutcome;
  b: PlayerPred;
  v: PlayerPred;
}

interface Pair {
  i: MatchInfo;
  b: PredRow;
  v: PredRow;
  lb: Losses;
  lv: Losses;
  /** props publicadas por ambas (solo partidos con líneas de jugador válidas) */
  pl: PlayerPair[];
}

const NO_PLAY: PlayerOutcome = { g: 0, s1: 0, sh2: 0, c: 0 };

/** Métricas principales de un conjunto de pares (sin las que no tienen dato). */
function mainMetricsOf(pairs: Pair[]): MainMetric[] {
  const out: MainMetric[] = [];
  const push = (key: MainKey, label: string, items: { day: string; b: number; v: number }[]) => {
    if (!items.length) return;
    out.push({
      key,
      label,
      n: items.length,
      baseline: mean(items.map((x) => x.b)),
      variant: mean(items.map((x) => x.v)),
      ci: bootstrapByDay(items.map((x) => ({ day: x.day, diff: x.v - x.b }))),
    });
  };
  for (const d of MAIN_METRICS) {
    push(
      d.key,
      d.label,
      pairs.flatMap((x) => {
        const b = d.get(x.lb);
        const v = d.get(x.lv);
        return b === undefined || v === undefined ? [] : [{ day: x.i.day, b, v }];
      }),
    );
  }
  for (const d of PLAYER_METRICS) {
    push(
      d.key,
      d.label,
      pairs.flatMap((x) => x.pl.map((p) => ({ day: x.i.day, b: propLoss(p.b[d.field], p.y[d.field])[d.loss], v: propLoss(p.v[d.field], p.y[d.field])[d.loss] }))),
    );
  }
  return out;
}

/** Compara una variante con la base en una ventana. */
export function compare(
  base: VariantRun,
  run: VariantRun,
  infos: Map<string, MatchInfo>,
  window: WindowName,
  data: EvalData,
): EvalReport {
  const pairs: Pair[] = [];
  const sets: PlayerSets = { matches: 0, common: 0, onlyBaseline: 0, onlyBaselinePlayed: 0, onlyVariant: 0, onlyVariantPlayed: 0 };
  let missing = 0;
  for (const i of [...infos.values()].sort((a, b) => a.t - b.t || a.id.localeCompare(b.id))) {
    if (!inWindow(i, window)) continue;
    const b = base.rows.get(i.id);
    if (!b) continue;
    const v = run.rows.get(i.id);
    if (!v) {
      missing++;
      continue;
    }
    const pl: PlayerPair[] = [];
    if (i.players && (b.pl || v.pl)) {
      sets.matches++;
      const key = (p: PlayerPred) => playerKey(p.id, p.s);
      const vm = new Map((v.pl ?? []).map((p) => [key(p), p]));
      const bm = new Map((b.pl ?? []).map((p) => [key(p), p]));
      for (const pb of b.pl ?? []) {
        const pv = vm.get(key(pb));
        if (pv) pl.push({ y: i.players.get(key(pb)) ?? NO_PLAY, b: pb, v: pv });
        else {
          sets.onlyBaseline++;
          if (i.players.has(key(pb))) sets.onlyBaselinePlayed++;
        }
      }
      for (const pv of v.pl ?? []) {
        if (bm.has(key(pv))) continue;
        sets.onlyVariant++;
        if (i.players.has(key(pv))) sets.onlyVariantPlayed++;
      }
      sets.common += pl.length;
    }
    pairs.push({ i, b, v, lb: lossesOf(b, i), lv: lossesOf(v, i), pl });
  }
  const main = mainMetricsOf(pairs);
  const ciOf = (k: MainKey) => main.find((x) => x.key === k)?.ci ?? bootstrapByDay([]);
  const segments: SegmentReport[] = SEGMENTS.map((s) => {
    const sel = pairs.filter((x) => s.test(x.i, x.b));
    return {
      id: s.id,
      label: s.label,
      n: sel.length,
      baseline: metricsOf(sel.map((x) => x.lb)).x12,
      variant: metricsOf(sel.map((x) => x.lv)).x12,
      rps: bootstrapByDay(sel.map((x) => ({ day: x.i.day, diff: x.lv.rps - x.lb.rps }))),
      main: mainMetricsOf(sel),
    };
  });
  const composition: Record<string, number> = {};
  for (const x of pairs) composition[x.i.compId] = (composition[x.i.compId] ?? 0) + 1;
  const ci: EvalReport['ci'] = {
    rps: ciOf('rps'),
    logLoss: ciOf('logLoss'),
    brier: ciOf('brier'),
    ouBrier: ciOf('ouBrier'),
    bttsBrier: ciOf('bttsBrier'),
    deviance: ciOf('deviance'),
  };
  for (const m of main) ci[m.key] = m.ci;
  const report: EvalReport = {
    variant: run.variant.name,
    description: run.variant.description,
    window,
    from: WINDOWS[window].from,
    to: WINDOWS[window].to,
    generatedAt: new Date().toISOString(),
    data: { fingerprint: data.fingerprint, now: data.now.toISOString() },
    n: pairs.length,
    days: new Set(pairs.map((x) => x.i.day)).size,
    missing,
    composition: Object.fromEntries(Object.entries(composition).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    baseline: metricsOf(pairs.map((x) => x.lb)),
    model: metricsOf(pairs.map((x) => x.lv)),
    ci,
    main,
    segments,
    references: { baseline: referencesOf(pairs.map((x) => ({ i: x.i, r: x.b }))), variant: referencesOf(pairs.map((x) => ({ i: x.i, r: x.v }))) },
    seconds: { baseline: base.seconds, variant: run.seconds },
  };
  if (sets.matches) report.playerSets = sets;
  return report;
}

// ---------------------------------------------------------------------------
// Comprobación de fuga (envenenamiento del futuro)
// ---------------------------------------------------------------------------

export interface LeakDay {
  day: string;
  /** partidos comparados (inicio ese día, antes del veneno) */
  matches: number;
  /** máxima diferencia absoluta en cualquier salida (1X2, más de 2,5, ambos marcan, λ, córners, tarjetas) */
  maxDiff: number;
  /** partido y campo con la máxima diferencia */
  worst?: string;
}

export interface LeakReport {
  ok: boolean;
  tolerance: number;
  days: LeakDay[];
}

export const LEAK_COMP: CompetitionConfig = {
  id: '__leakcheck',
  slug: 'leak.check',
  name: 'Comprobación de fuga',
  shortName: 'Fuga',
  country: '—',
  flag: '🧪',
  kind: 'cup',
  tier: 5,
};

/** Día (UTC) con más partidos de una ventana (determinista; a igualdad, el más antiguo). */
export function busiestDay(infos: Map<string, MatchInfo>, w: WindowName, rows?: Map<string, PredRow>): string | undefined {
  const count = new Map<string, number>();
  for (const i of infos.values()) {
    if (!inWindow(i, w) || (rows && !rows.has(i.id))) continue;
    count.set(i.day, (count.get(i.day) ?? 0) + 1);
  }
  let best: string | undefined;
  let bn = -1;
  for (const [d, n] of [...count].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (n > bn) {
      best = d;
      bn = n;
    }
  }
  return best;
}

/**
 * Partidos "del futuro" envenenados: para cada partido del día `day`, un partido terminado entre los mismos equipos
 * al día siguiente (01:00 UTC) en una copa ficticia, con marcador y estadísticas extremos, cuotas, el MISMO árbitro y
 * líneas de jugador extremas de los jugadores del último partido de cada equipo (`lines`: líneas por equipo), para
 * que una fuga por HistoryView.refereeMatches/playerLines o por las props también se detecte.
 */
export function poisonStores(
  stores: CompetitionStore[],
  targets: MatchRecord[],
  day: string,
  lines?: ReadonlyMap<string, readonly PlayerLine[]>,
): CompetitionStore[] {
  const t0 = Date.parse(`${day}T00:00:00Z`) + DAY_MS + 3_600_000;
  const players: PlayerLine[] = [];
  const matches: MatchRecord[] = targets.map((m, k) => {
    const flip = k % 2 === 1;
    const id = `L${m.id}`.slice(0, 32);
    const date = new Date(t0 + k * 60_000).toISOString();
    for (const [team, opp, isHome] of [
      [m.home.id, m.away.id, true],
      [m.away.id, m.home.id, false],
    ] as const) {
      const own = (lines?.get(team) ?? []).filter((l) => Date.parse(l.date) < t0);
      const lastMatch = own[own.length - 1]?.matchId;
      for (const l of own.filter((x) => x.matchId === lastMatch)) {
        const big = (isHome ? !flip : flip) ? 1 : 0;
        players.push({
          ...l,
          matchId: id,
          compId: LEAK_COMP.id,
          date,
          teamId: team,
          opponentId: opp,
          isHome,
          starter: true,
          minutes: 90,
          goals: 3 * big,
          assists: 2 * big,
          shots: 9 * big,
          shotsOnTarget: 6 * big,
          yellow: 1 - big,
          red: 1 - big,
          foulsCommitted: 6,
          foulsSuffered: 0,
          offsides: 0,
          ownGoals: 0,
        });
      }
    }
    return {
      id,
      compId: LEAK_COMP.id,
      season: m.season,
      // misma temporada actual/pasada que el objetivo: el inicio del walk-forward (y su calendario de reajustes) no cambia
      currentSeason: m.currentSeason,
      date,
      ...(m.referee ? { referee: m.referee } : {}),
      status: 'finished',
      home: m.home,
      away: m.away,
      score: flip ? { home: 0, away: 9 } : { home: 9, away: 0 },
      stats: {
        home: { goals: flip ? 0 : 9, corners: flip ? 0 : 30, yellow: flip ? 9 : 0, red: flip ? 2 : 0, shots: flip ? 0 : 45, shotsOnTarget: flip ? 0 : 20, fouls: 40 },
        away: { goals: flip ? 9 : 0, corners: flip ? 30 : 0, yellow: flip ? 0 : 9, red: flip ? 0 : 2, shots: flip ? 45 : 0, shotsOnTarget: flip ? 20 : 0, fouls: 40 },
      },
      odds: { provider: 'Veneno', home: 1.05, draw: 15, away: 30, totalLine: 2.5, over: 1.1, under: 7 },
    };
  });
  return [...stores, { compId: LEAK_COMP.id, slug: LEAK_COMP.slug, updatedAt: new Date(t0).toISOString(), matches, players, standings: [] }];
}

function rowDiff(a: PredRow, b: PredRow): { d: number; field: string } {
  let d = 0;
  let field = '';
  const cmp = (x: number | undefined, y: number | undefined, f: string) => {
    if (x === undefined && y === undefined) return;
    const e = x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y) ? Infinity : Math.abs(x - y);
    if (e > d) {
      d = e;
      field = f;
    }
  };
  a.p.forEach((x, i) => cmp(x, b.p[i], `p[${i}]`));
  cmp(a.over25, b.over25, 'over25');
  cmp(a.btts, b.btts, 'btts');
  cmp(a.lh, b.lh, 'lambdaHome');
  cmp(a.la, b.la, 'lambdaAway');
  cmp(a.corners?.exp, b.corners?.exp, 'corners.exp');
  a.corners?.over.forEach((x, i) => cmp(x, b.corners?.over[i], `corners.over[${i}]`));
  cmp(a.cards?.exp, b.cards?.exp, 'cards.exp');
  a.cards?.over.forEach((x, i) => cmp(x, b.cards?.over[i], `cards.over[${i}]`));
  for (const k of ['corners', 'cards'] as const) {
    a[k]?.home?.forEach((x, i) => cmp(x, b[k]?.home?.[i], `${k}.home[${i}]`));
    a[k]?.away?.forEach((x, i) => cmp(x, b[k]?.away?.[i], `${k}.away[${i}]`));
  }
  for (const k of ['fouls', 'shots', 'sot'] as const) {
    cmp(a[k]?.exp, b[k]?.exp, `${k}.exp`);
    a[k]?.over.forEach((x, i) => cmp(x, b[k]?.over[i], `${k}.over[${i}]`));
  }
  // props: mismos jugadores con las mismas probabilidades
  const bp = new Map((b.pl ?? []).map((p) => [playerKey(p.id, p.s), p]));
  if ((a.pl?.length ?? 0) !== (b.pl?.length ?? 0)) cmp(a.pl?.length ?? 0, b.pl?.length ?? 0, 'pl.length');
  for (const p of a.pl ?? []) {
    const q = bp.get(playerKey(p.id, p.s));
    for (const f of ['g', 's1', 'sh2', 'c'] as const) cmp(p[f], q?.[f], `pl[${p.id}|${p.s}].${f}`);
  }
  return { d, field };
}

/**
 * Comprobación de fuga: vuelve a predecir los partidos de cada día de `days` con datos envenenados (partidos
 * terminados de los mismos equipos justo DESPUÉS) y exige predicciones idénticas a las de la ejecución normal `run`.
 * Cualquier diferencia = algún gancho (o el núcleo) mira el futuro.
 */
export function leakCheck(variant: ModelVariant, data: EvalData, run: VariantRun, days: string[], tolerance = 1e-9): LeakReport {
  const out: LeakReport = { ok: true, tolerance, days: [] };
  for (const day of days) {
    const ctx = run.ctx!;
    const targets = [...run.rows.keys()]
      .map((id) => ctx.matchById.get(id))
      .filter((m): m is MatchRecord => !!m && new Date(Date.parse(m.date)).toISOString().slice(0, 10) === day);
    if (!targets.length) continue;
    const poisoned: EvalData = { ...data, stores: poisonStores(data.stores, targets, day, ctx.linesByTeam), configs: [...data.configs, LEAK_COMP] };
    const ids = new Set(targets.map((m) => m.id));
    // el veneno está en una copa ficticia: el DC de liga no cambia y se reutiliza salvo con ganchos dc con funciones
    // (podrían leer estado externo); Elo, parámetros, rasgos, combinador y córners/tarjetas se recalculan siempre
    const dcFns = !!(variant.dc?.fitGoals || variant.dc?.weight);
    const pr = runVariant(variant, poisoned, { onlyIds: ids, dc: dcFns ? undefined : run.dc });
    let maxDiff = 0;
    let worst: string | undefined;
    for (const id of ids) {
      const a = run.rows.get(id)!;
      const b = pr.rows.get(id);
      if (!b) {
        maxDiff = Infinity;
        worst = `${id}: sin predicción con datos envenenados`;
        continue;
      }
      const bb: PredRow = { ...b };
      for (const k of ['corners', 'cards', 'fouls', 'shots', 'sot', 'pl'] as const) if (!a[k]) delete bb[k];
      const r = rowDiff(a, bb);
      if (r.d > maxDiff) {
        maxDiff = r.d;
        worst = `${id} (${r.field})`;
      }
    }
    out.days.push({ day, matches: ids.size, maxDiff, worst });
    if (!(maxDiff <= tolerance)) out.ok = false;
  }
  return out;
}
