/**
 * Motor del banco de pruebas: predicciones walk-forward de una variante para todos los partidos terminados de la
 * temporada actual, métricas por ventana y segmento frente a la línea base (producción), intervalo bootstrap por día y
 * comprobación de fuga por envenenamiento del futuro. La CLI está en scripts/eval-model.ts.
 *
 * Todas las predicciones salen del mismo código que el build (createContext + walk-forward de publish/context.ts y
 * projectMatchStats): una variante solo cambia lo que sus ganchos cambian.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DCModel } from '../../src/lib/models';
import { logLoss3, mulberry32, rps3, brier3 } from '../../src/lib/models';
import type { Prob1X2 } from '../../src/types/data';
import { ROOT_DIR, STORE_DIR, type CompetitionConfig } from '../config';
import type { CompetitionStore, MatchRecord } from '../types';
import { projectMatchStats } from '../analytics/projections';
import { settleDataOf } from '../analytics/settle';
import { createContext, fitWalkForwardModels, predictWalkForward, statContext, type BuildContext } from '../publish/context';
import type { ModelSuite } from '../analytics/ratings';
import { BASELINE_VARIANT, isEmptyVariant, type ModelVariant } from './types';

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Ventanas (protocolo)
// ---------------------------------------------------------------------------

/** Ventanas del protocolo (fechas de inicio del partido, UTC, ambos extremos incluidos). */
export const WINDOWS = {
  /**
   * AUXILIAR (anterior al ajuste): temporada actual antes de junio. Casi todo SIN cuotas (ESPN solo da cuotas de cierre
   * en los resúmenes, que se descargan para los últimos 180 días) y solo competiciones de año natural (Brasileirão,
   * Argentina, MLS, Chile, Libertadores, Sudamericana…). Sirve para medir ideas del segmento sin cuotas; la decisión
   * sigue siendo T1 y T2.
   */
  pre: { from: '2026-01-01', to: '2026-05-31', label: 'auxiliar pre-ajuste (ene–may, casi sin cuotas)' },
  tuning: { from: '2026-06-01', to: '2026-09-15', label: 'ajuste (tuning)' },
  T1: { from: '2026-06-01', to: '2026-07-31', label: 'sub-ventana T1' },
  T2: { from: '2026-08-01', to: '2026-09-15', label: 'sub-ventana T2' },
  holdout: { from: '2026-09-16', to: '2100-12-31', label: 'HOLDOUT' },
} as const;
export type WindowName = keyof typeof WINDOWS;
export const WINDOW_NAMES = Object.keys(WINDOWS) as WindowName[];

export function windowRange(w: WindowName): { from: number; to: number } {
  const def = WINDOWS[w];
  return { from: Date.parse(`${def.from}T00:00:00Z`), to: Date.parse(`${def.to}T00:00:00Z`) + DAY_MS };
}

/** Sub-ventanas de estabilidad de una ventana (para elegir los días de la comprobación de fuga). */
export function subWindows(w: WindowName): WindowName[] {
  return w === 'tuning' ? ['T1', 'T2'] : [w];
}

/** Línea de corte top/resto: competiciones con tier >= TOP_TIER (top 5 ligas de Europa salvo… ver README). */
export const TOP_TIER = 8;
/** Líneas evaluadas de córners y tarjetas. */
export const CORNER_LINES = [8.5, 9.5, 10.5];
export const CARD_LINES = [3.5, 4.5];

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

export interface MatchInfo {
  id: string;
  date: string;
  t: number;
  /** día UTC (YYYY-MM-DD), unidad del bootstrap */
  day: string;
  compId: string;
  kind: CompetitionConfig['kind'];
  tier: number;
  outcome: 0 | 1 | 2;
  /** marcador a 90' (prórrogas reconstruidas con los eventos de gol) */
  hg: number;
  ag: number;
  /** córners/tarjetas totales (nunca con prórroga; 0 tarjetas = ausente) */
  corners?: number;
  cards?: number;
}

/** Resultado real de los partidos terminados de la temporada actual (a 90'; sin resolver ⇒ excluido). */
export function matchInfos(ctx: BuildContext): Map<string, MatchInfo> {
  const out = new Map<string, MatchInfo>();
  for (const m of ctx.allMatches) {
    if (!m.currentSeason) continue;
    const comp = ctx.configById.get(m.compId);
    if (!comp) continue;
    const d = settleDataOf(m);
    if (!d) continue;
    const t = Date.parse(m.date);
    const info: MatchInfo = {
      id: m.id,
      date: m.date,
      t,
      day: new Date(t).toISOString().slice(0, 10),
      compId: m.compId,
      kind: comp.kind,
      tier: comp.tier,
      outcome: d.hg > d.ag ? 0 : d.hg === d.ag ? 1 : 2,
      hg: d.hg,
      ag: d.ag,
    };
    if (d.corners !== undefined) info.corners = d.corners;
    if (d.cards !== undefined) info.cards = d.cards;
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
  /** P(más de la línea) en CORNER_LINES / CARD_LINES */
  over: number[];
  /** distribución del total (5 decimales, cola plegada) */
  dist: number[];
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
}

const tri = (p: Prob1X2): [number, number, number] => [p.home, p.draw, p.away];

/** DC walk-forward serializable (caché). */
interface DcCache {
  leagues: { id: string; models: DCModel[]; byMatch: [string, number][]; timeline: [number, number][] }[];
}

export interface VariantRun {
  variant: ModelVariant;
  rows: Map<string, PredRow>;
  ctx?: BuildContext;
  dc?: DcCache;
  seconds: number;
  fromCache?: boolean;
}

function serializeDc(ctx: BuildContext): DcCache {
  const leagues: DcCache['leagues'] = [];
  for (const [id, byMatch] of ctx.wfModels) {
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
    const timeline: [number, number][] = (ctx.wfTimeline.get(id) ?? []).map((e) => [e.t, add(e.model)]);
    leagues.push({ id, models, byMatch: pairs, timeline });
  }
  return { leagues };
}

function restoreDc(ctx: BuildContext, c: DcCache): void {
  for (const l of c.leagues) {
    ctx.wfModels.set(l.id, new Map(l.byMatch.map(([mid, i]) => [mid, l.models[i]])));
    ctx.wfTimeline.set(l.id, l.timeline.map(([t, i]) => ({ t, model: l.models[i] })));
  }
}

function statPred(p: { total: number; totalDist: number[]; lines: { line: number; over: number }[] } | undefined, lines: number[]): StatPred | undefined {
  if (!p) return undefined;
  const over = lines.map((l) => p.lines.find((x) => Math.abs(x.line - l) < 1e-9)?.over ?? NaN);
  if (!over.every(Number.isFinite)) return undefined;
  return { exp: p.total, over, dist: p.totalDist };
}

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

/** Mismos ganchos de estadísticas (valores simples: comparación por contenido). */
function sameStats(a: ModelVariant['stats'], b: ModelVariant['stats']): boolean {
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
  // córners y tarjetas: solo dependen de los ganchos `stats`; solo partidos con el dato real
  const infos = opts.infos ?? matchInfos(ctx);
  const reuseStats = !!reuse && sameStats(variant.stats, reuse.variant.stats);
  for (const row of rows.values()) {
    if (reuseStats) {
      const b = reuse!.rows.get(row.id);
      if (b?.corners) row.corners = b.corners;
      if (b?.cards) row.cards = b.cards;
      continue;
    }
    const info = infos.get(row.id);
    if (!info || (info.corners === undefined && info.cards === undefined)) continue;
    const m = ctx.matchById.get(row.id)!;
    const sc = statContext(ctx, m.compId, Date.parse(m.date), { keys: ['corners', 'cards'] });
    const projs = projectMatchStats(m.home.id, m.away.id, sc);
    const c = statPred(projs.find((p) => p.key === 'corners'), CORNER_LINES);
    const k = statPred(projs.find((p) => p.key === 'cards'), CARD_LINES);
    if (c) row.corners = c;
    if (k) row.cards = k;
  }
  return { variant, rows, ctx, dc: dc ?? serializeDc(ctx), seconds: (performance.now() - t0) / 1000 };
}

// ---------------------------------------------------------------------------
// Caché en disco de la línea base
// ---------------------------------------------------------------------------

export const CACHE_DIR = path.join(ROOT_DIR, '.cache', 'eval');

interface BaselineCacheFile {
  version: 3;
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
      if (c.version === 3) {
        // contexto ligero (índices y modelos actuales) para reutilizar en las variantes
        const ctx = createContext({ stores: data.stores, configs: data.configs, now: data.now });
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
    const out: BaselineCacheFile = { version: 3, key: path.basename(file), rows: [...run.rows.values()], dc: run.dc! };
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
  corners?: { brier: number[]; brierMean: number; ae: number; nll: number };
  cards?: { brier: number[]; brierMean: number; ae: number; nll: number };
}

function binLoss(p: number, y: 0 | 1): { brier: number; logLoss: number; hit: number } {
  const q = Math.min(1 - EPS, Math.max(EPS, p));
  return { brier: (p - y) ** 2, logLoss: -(y ? Math.log(q) : Math.log(1 - q)), hit: (p >= 0.5 ? 1 : 0) === y ? 1 : 0 };
}

function poissonDeviance(y: number, mu: number): number {
  const m = Math.max(mu, 1e-9);
  return 2 * ((y > 0 ? y * Math.log(y / m) : 0) - (y - m));
}

function statLoss(pred: StatPred | undefined, actual: number | undefined, lines: number[]): Losses['corners'] {
  if (!pred || actual === undefined) return undefined;
  const brier = lines.map((l, i) => (pred.over[i] - (actual > l ? 1 : 0)) ** 2);
  const k = Math.min(actual, pred.dist.length - 1);
  const pk = actual > pred.dist.length - 1 ? pred.dist[pred.dist.length - 1] : pred.dist[k];
  return { brier, brierMean: brier.reduce((s, x) => s + x, 0) / brier.length, ae: Math.abs(pred.exp - actual), nll: -Math.log(Math.max(1e-6, pk)) };
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
  };
}

export interface StatMetrics {
  n: number;
  /** Brier por línea (CORNER_LINES / CARD_LINES) */
  brier: number[];
  brierMean: number;
  mae: number;
  /** log-verosimilitud negativa media del total exacto */
  nll: number;
}

export interface Metrics {
  n: number;
  x12: { rps: number; logLoss: number; brier: number; accuracy: number };
  ou25: { brier: number; logLoss: number; accuracy: number };
  btts: { brier: number; logLoss: number; accuracy: number };
  goalsDeviance: number;
  corners?: StatMetrics;
  cards?: StatMetrics;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
}

function statMetrics(ls: (Losses['corners'] | undefined)[]): StatMetrics | undefined {
  const xs = ls.filter((x): x is NonNullable<Losses['corners']> => !!x);
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

export function metricsOf(ls: Losses[]): Metrics {
  return {
    n: ls.length,
    x12: { rps: mean(ls.map((l) => l.rps)), logLoss: mean(ls.map((l) => l.logLoss)), brier: mean(ls.map((l) => l.brier)), accuracy: mean(ls.map((l) => l.hit)) },
    ou25: { brier: mean(ls.map((l) => l.ouBrier)), logLoss: mean(ls.map((l) => l.ouLogLoss)), accuracy: mean(ls.map((l) => l.ouHit)) },
    btts: { brier: mean(ls.map((l) => l.bttsBrier)), logLoss: mean(ls.map((l) => l.bttsLogLoss)), accuracy: mean(ls.map((l) => l.bttsHit)) },
    goalsDeviance: mean(ls.map((l) => l.deviance)),
    corners: statMetrics(ls.map((l) => l.corners)),
    cards: statMetrics(ls.map((l) => l.cards)),
  };
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
];

export interface SegmentReport {
  id: string;
  label: string;
  n: number;
  baseline: Metrics['x12'];
  variant: Metrics['x12'];
  rps: DiffCI;
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
  baseline: Metrics;
  model: Metrics;
  ci: {
    rps: DiffCI;
    logLoss: DiffCI;
    brier: DiffCI;
    ouBrier: DiffCI;
    bttsBrier: DiffCI;
    deviance: DiffCI;
    corners?: DiffCI;
    cards?: DiffCI;
  };
  segments: SegmentReport[];
  /** cada fuente sola, en la base y en la variante (mismos partidos) */
  references: { baseline: References; variant: References };
  leak?: LeakReport;
  seconds: { baseline: number; variant: number; leak?: number };
}

/** Compara una variante con la base en una ventana. */
export function compare(
  base: VariantRun,
  run: VariantRun,
  infos: Map<string, MatchInfo>,
  window: WindowName,
  data: EvalData,
): EvalReport {
  const { from, to } = windowRange(window);
  const pairs: { i: MatchInfo; b: PredRow; v: PredRow; lb: Losses; lv: Losses }[] = [];
  let missing = 0;
  for (const i of [...infos.values()].sort((a, b) => a.t - b.t || a.id.localeCompare(b.id))) {
    if (i.t < from || i.t >= to) continue;
    const b = base.rows.get(i.id);
    if (!b) continue;
    const v = run.rows.get(i.id);
    if (!v) {
      missing++;
      continue;
    }
    pairs.push({ i, b, v, lb: lossesOf(b, i), lv: lossesOf(v, i) });
  }
  const ci = (get: (l: Losses) => number | undefined) =>
    bootstrapByDay(
      pairs.flatMap((x) => {
        const a = get(x.lv);
        const c = get(x.lb);
        return a === undefined || c === undefined ? [] : [{ day: x.i.day, diff: a - c }];
      }),
    );
  const segments: SegmentReport[] = SEGMENTS.map((s) => {
    const sel = pairs.filter((x) => s.test(x.i, x.b));
    return {
      id: s.id,
      label: s.label,
      n: sel.length,
      baseline: metricsOf(sel.map((x) => x.lb)).x12,
      variant: metricsOf(sel.map((x) => x.lv)).x12,
      rps: bootstrapByDay(sel.map((x) => ({ day: x.i.day, diff: x.lv.rps - x.lb.rps }))),
    };
  });
  const hasCorners = pairs.some((x) => x.lb.corners && x.lv.corners);
  const hasCards = pairs.some((x) => x.lb.cards && x.lv.cards);
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
    baseline: metricsOf(pairs.map((x) => x.lb)),
    model: metricsOf(pairs.map((x) => x.lv)),
    ci: {
      rps: ci((l) => l.rps),
      logLoss: ci((l) => l.logLoss),
      brier: ci((l) => l.brier),
      ouBrier: ci((l) => l.ouBrier),
      bttsBrier: ci((l) => l.bttsBrier),
      deviance: ci((l) => l.deviance),
    },
    segments,
    references: { baseline: referencesOf(pairs.map((x) => ({ i: x.i, r: x.b }))), variant: referencesOf(pairs.map((x) => ({ i: x.i, r: x.v }))) },
    seconds: { baseline: base.seconds, variant: run.seconds },
  };
  if (hasCorners) report.ci.corners = ci((l) => l.corners?.brierMean);
  if (hasCards) report.ci.cards = ci((l) => l.cards?.brierMean);
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
  const { from, to } = windowRange(w);
  const count = new Map<string, number>();
  for (const i of infos.values()) {
    if (i.t < from || i.t >= to || (rows && !rows.has(i.id))) continue;
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
 * al día siguiente (01:00 UTC) en una copa ficticia, con marcador y estadísticas extremos y cuotas.
 */
export function poisonStores(stores: CompetitionStore[], targets: MatchRecord[], day: string): CompetitionStore[] {
  const t0 = Date.parse(`${day}T00:00:00Z`) + DAY_MS + 3_600_000;
  const matches: MatchRecord[] = targets.map((m, k) => {
    const flip = k % 2 === 1;
    return {
      id: `L${m.id}`.slice(0, 32),
      compId: LEAK_COMP.id,
      season: m.season,
      currentSeason: true,
      date: new Date(t0 + k * 60_000).toISOString(),
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
  return [...stores, { compId: LEAK_COMP.id, slug: LEAK_COMP.slug, updatedAt: new Date(t0).toISOString(), matches, players: [], standings: [] }];
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
    const poisoned: EvalData = { ...data, stores: poisonStores(data.stores, targets, day), configs: [...data.configs, LEAK_COMP] };
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
      if (!a.corners) delete bb.corners;
      if (!a.cards) delete bb.cards;
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
