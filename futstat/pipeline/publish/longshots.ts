/**
 * «CUOTA ALTA 6+» en el build (motor: pipeline/analytics/longshots.ts) → public/data/longshots.json (LongshotFile) y
 * HomeFile.longshot.
 *
 *  1. longshotCollector(ctx): gancho de dailyHistory (visitExtra) que guarda, para cada partido terminado de la temporada
 *     actual, sus selecciones generadas con la predicción walk-forward (solo datos anteriores al partido, cuotas de
 *     cierre) y los props de sus jugadores elegibles, ya resueltas a 90'. No vuelve a predecir nada.
 *  2. prepareLongshots(ctx, items): historial fuera de muestra de la regla diaria (1-jun → ayer), recalibración y qué
 *     tipos se pueden publicar como recomendación (muestra suficiente y calibración aceptable).
 *  3. buildLongshotFile(ctx, state): hoy y los días siguientes con partidos (máx. 4, zona HOME_TIMEZONE). Por día, la
 *     regla diaria sobre todos sus partidos: los programados con la predicción publicada (fullPrediction), los EN JUEGO
 *     con la información anterior al saque (preMatchRecord) y, hoy, los ya terminados con sus selecciones walk-forward
 *     y su resultado (las apuestas de hoy ya resueltas se publican con ✓/✗: la mayoría falla, y se ve).
 *  4. homeLongshot(file): la mejor apuesta aún abierta de hoy (o del siguiente día con partidos) y nº de apuestas.
 *
 * Si algo falla, el build NO se rechaza: longshots.json se publica sin apuestas y con una nota (degradar, no rechazar).
 */
import type { HomeFile, LongshotBet, LongshotDay, LongshotFile, LongshotKind, LongshotLeg, LongshotRecord } from '../../src/types/data';
import { HOME_TIMEZONE } from '../config';
import type { MatchRecord } from '../types';
import {
  GENERATED_KINDS,
  KIND_LABEL,
  KIND_ORDER,
  MAX_PER_DAY,
  MIN_ODDS,
  calibrated,
  dayBets,
  historyItem,
  kindExclusion,
  longshotWalkForward,
  matchSelections,
  type LongshotCalibrator,
  type LongshotEngineBet,
  type LongshotHistoryItem,
  type LongshotInput,
  type LongshotMatchInfo,
  type LongshotSelection,
  type LongshotWalkForward,
} from '../analytics/longshots';
import { eloGamesBefore, predictMatch } from '../analytics/predict';
import { eligibleProps, preMatchRecord, type DailyHistoryOptions } from '../analytics/daily';
import { baseContext, isFinishedRecord, projectStatsFor, type BuildContext } from './context';
import { cleanOdds, fullPrediction } from './matches';
import { lcFirst, localDay } from './util';


/** Días publicados: hoy y los siguientes con partidos. */
export const LONGSHOT_MAX_DAYS = 4;
/**
 * Recalibración de Platt walk-forward de las probabilidades (scripts/eval-longshots.ts, 26-nov-2026, 1-jun → 25-nov):
 * la probabilidad de marcar de los goleadores estaba inflada (banda 0,10–0,15: el modelo decía 12,3 % y pasó un 9,5 %,
 * n = 3.859); con Platt ajustado solo con días anteriores queda en 11,1 %. En el resto de grupos el ajuste es casi la
 * identidad. Decisión tomada mirando este mismo periodo (no es una validación independiente): mejora poco el récord
 * (acierto 12,6 % → 12,7 %, ROI con cierre −23,6 % → −19,8 %), que sigue siendo claramente negativo.
 */
export const LONGSHOT_CALIBRATE = true;

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r2 = (x: number) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------
// Historial (gancho de dailyHistory)
// ---------------------------------------------------------------------------

export interface LongshotCollector {
  items: LongshotHistoryItem[];
  visit: NonNullable<DailyHistoryOptions['visitExtra']>;
}

export function matchInfo(ctx: BuildContext, m: MatchRecord): LongshotMatchInfo {
  return {
    matchId: m.id,
    compId: m.compId,
    compName: ctx.compNames.get(m.compId) ?? m.compId,
    date: m.date,
    home: m.home,
    away: m.away,
    tier: ctx.configById.get(m.compId)?.tier ?? 5,
  };
}

/** Recoge las selecciones walk-forward (ya resueltas) de cada partido del historial de dailyHistory. */
export function longshotCollector(ctx: BuildContext): LongshotCollector {
  const items: LongshotHistoryItem[] = [];
  const visit: LongshotCollector['visit'] = (m, input, extra, d) => {
    const li: LongshotInput = {
      ...matchInfo(ctx, m),
      p: input.p,
      matrix: input.matrix,
      odds: input.odds,
      withMarket: input.withMarket,
      minEloGames: input.minEloGames,
      lambdaHome: input.lambdaHome,
      lambdaAway: input.lambdaAway,
    };
    if (extra.players) li.players = extra.players;
    items.push(historyItem(li, d));
  };
  return { items, visit };
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

export interface LongshotState {
  error?: string;
  today: string;
  /** primer día del historial publicado (1 de junio de la temporada) */
  from: string;
  items: LongshotHistoryItem[];
  wf?: LongshotWalkForward;
  calibrator?: LongshotCalibrator;
  /** tipos que NO se publican como recomendación, con el motivo */
  excluded: Map<LongshotKind, string>;
  seconds: number;
}

/** 1 de junio de la temporada en curso (el del año actual desde junio; si no, el del anterior). */
export function seasonFrom(today: string): string {
  const y = Number(today.slice(0, 4));
  const mo = Number(today.slice(5, 7));
  return `${mo >= 6 ? y : y - 1}-06-01`;
}

/** Historial fuera de muestra y tipos publicables. Sin historial, ningún tipo se publica como recomendación. */
export function prepareLongshots(ctx: BuildContext, items: LongshotHistoryItem[] | undefined): LongshotState {
  const t0 = performance.now();
  const today = localDay(ctx.now, HOME_TIMEZONE);
  const state: LongshotState = { today, from: seasonFrom(today), items: items ?? [], excluded: new Map(), seconds: 0 };
  try {
    if (!items?.length) {
      state.error = 'Todavía no hay historial suficiente para medir estas apuestas fuera de muestra.';
    } else {
      const wf = longshotWalkForward(items, { timeZone: HOME_TIMEZONE, from: state.from, to: today, calibrate: LONGSHOT_CALIBRATE });
      state.wf = wf;
      state.calibrator = wf.calibrator;
    }
  } catch (e) {
    state.error = 'El cálculo del historial de cuota alta ha fallado en esta actualización.';
    ctx.log(`  aviso: cuota alta 6+ sin historial (${(e as Error)?.message ?? e}); no se publican recomendaciones`);
  }
  for (const k of GENERATED_KINDS) {
    const r = state.wf?.byKind.find((x) => x.kind === k);
    const why = r ? kindExclusion(r) : 'sin historial fuera de muestra';
    if (why) state.excluded.set(k, why);
  }
  state.seconds = (performance.now() - t0) / 1000;
  return state;
}

// ---------------------------------------------------------------------------
// Entradas de partidos por jugar / en juego
// ---------------------------------------------------------------------------

function minElo(ctx: BuildContext, m: MatchRecord, before: number): number {
  const elo = ctx.suite.eloBuild.elo;
  return Math.min(eloGamesBefore(elo, m.home.id, before), eloGamesBefore(elo, m.away.id, before));
}

/** Partido PROGRAMADO: la predicción publicada en su ficha y los props de sus jugadores elegibles. */
export function upcomingLongshotInput(ctx: BuildContext, m: MatchRecord): LongshotInput {
  const fp = fullPrediction(ctx, m, true);
  const t = Date.parse(m.date);
  const before = Number.isFinite(t) ? t : ctx.now;
  return {
    ...matchInfo(ctx, m),
    p: fp.result.quick.p,
    matrix: fp.result.matrix,
    odds: cleanOdds(m.odds),
    withMarket: !!fp.result.model.market,
    minEloGames: minElo(ctx, m, before),
    lambdaHome: fp.result.lambdaHome,
    lambdaAway: fp.result.lambdaAway,
    players: {
      home: eligibleProps(ctx, m, 'home', fp.result.lambdaHome, fp.projections, before),
      away: eligibleProps(ctx, m, 'away', fp.result.lambdaAway, fp.projections, before),
    },
  };
}

/** Partido EN JUEGO visto como antes del saque: modelos del build y la última cuota previa (sin marcador ni estadísticas). */
export function liveLongshotInput(ctx: BuildContext, m: MatchRecord): LongshotInput {
  const rec = preMatchRecord(m);
  const comp = ctx.configById.get(rec.compId)!;
  const projections = projectStatsFor(ctx, rec);
  const result = predictMatch(rec, baseContext(ctx, comp), { projections });
  const t = Date.parse(rec.date);
  const before = Number.isFinite(t) ? t : ctx.now;
  return {
    ...matchInfo(ctx, rec),
    p: result.quick.p,
    matrix: result.matrix,
    odds: cleanOdds(rec.odds),
    withMarket: !!result.model.market,
    minEloGames: minElo(ctx, rec, before),
    lambdaHome: result.lambdaHome,
    lambdaAway: result.lambdaAway,
    players: {
      home: eligibleProps(ctx, rec, 'home', result.lambdaHome, projections, before),
      away: eligibleProps(ctx, rec, 'away', result.lambdaAway, projections, before),
    },
  };
}

// ---------------------------------------------------------------------------
// Textos (español, con cifras)
// ---------------------------------------------------------------------------

// mismo redondeo que la interfaz (Intl, sobre la representación decimal): con toFixed, 3,15 salía «3,1» y la tarjeta «3,2»
const nfCache = new Map<number, Intl.NumberFormat>();
const es = (x: number, d = 2) => {
  if (!Number.isFinite(x)) return '—';
  let f = nfCache.get(d);
  if (!f) nfCache.set(d, (f = new Intl.NumberFormat('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false })));
  return f.format(x);
};
const pct = (x: number) => {
  const v = Math.min(1, Math.max(0, x)) * 100;
  return `${v < 10 && Math.round(v) !== v ? es(v, 1) : String(Math.round(v))} %`;
};
const pctSigned = (x: number) => {
  const v = Math.abs(x) * 100;
  return `${x >= 0 ? '+' : '−'}${v < 10 ? es(v, 1) : String(Math.round(v))} %`;
};
const oddsTxt = (o: number) => es(o, o >= 10 ? 1 : 2);

const fmtDay = (day: string) => {
  const t = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : day;
};

function legTeam(l: LongshotSelection, side: 'home' | 'away'): string {
  return (side === 'home' ? l.match.home.name : l.match.away.name) || (side === 'home' ? 'el local' : 'el visitante');
}

/** Una o dos frases con los números que sostienen la apuesta. */
export function longshotReason(b: LongshotEngineBet): string {
  const l = b.legs[0];
  const one = `1 de cada ${b.oneIn}`;
  const fair = oddsTxt(b.fairOdds);
  const priced = (what: string) =>
    b.marketOdds !== undefined && b.ev !== undefined
      ? `${what}; la casa paga ${oddsTxt(b.marketOdds)} → valor esperado ${pctSigned(b.ev)}. ${
          b.ev >= 0 ? `Aun así solo acierta ${one}: habrá rachas largas sin acertar.` : `Con esta cuota se pierde a la larga: harían falta al menos ${fair}.`
        }`
      : `${what}. Sin cuota de la casa: compárala; necesitas al menos ${fair} para no perder a la larga.`;
  switch (b.kind) {
    case 'sorpresa': {
      const s = l.settle;
      const side = s.kind === 'outcome' ? s.win[0] : 'draw';
      return priced(side === 'draw' ? `El modelo da un ${pct(b.prob)} al empate (${one})` : `El modelo da a ${legTeam(l, side)} un ${pct(b.prob)} de ganar (${one})`);
    }
    case 'marcador': {
      const s = l.settle;
      const score = s.kind === 'score' ? `${s.home}-${s.away}` : l.selection;
      const rank = l.rank === 1 ? 'el marcador más probable' : `el ${l.rank ?? 2}.º marcador más probable`;
      const xg = l.match.xg ? ` (goles esperados ${es(l.match.xg.home)}–${es(l.match.xg.away)})` : '';
      return `El ${score} es ${rank} para el modelo${xg}: ${pct(b.prob)} (${one}). Sin cuota de la casa: necesitas al menos ${fair} para no perder a la larga, y este mercado suele llevar mucho margen.`;
    }
    case 'goleador': {
      const sc = l.scorer;
      const name = l.player?.name ?? 'El jugador';
      const hist =
        sc && sc.minutes > 0
          ? `${name} suma ${sc.goals} ${sc.goals === 1 ? 'gol' : 'goles'} en ${sc.minutes.toLocaleString('es-ES')}' (${es((sc.goals * 90) / sc.minutes)} por 90') y se esperan unos ${Math.round(sc.expMinutes)}' de juego`
          : `${name} tiene unos ${Math.round(sc?.expMinutes ?? 0)}' de juego esperados`;
      // ritmo goleador que implica la probabilidad (Poisson): si el real es muy inferior, el modelo se apoya en el prior
      const implied = sc && sc.expMinutes > 0 && b.prob < 1 ? (-Math.log(1 - b.prob) * 90) / sc.expMinutes : 0;
      const prior = sc && sc.minutes > 0 && (sc.goals * 90) / sc.minutes < 0.6 * implied ? ' (con tan pocos goles, el modelo se apoya sobre todo en sus tiros y en lo que marca un jugador de su puesto)' : '';
      return `${hist}: el modelo le da un ${pct(b.prob)} de marcar (${one})${prior}. Sin cuota de la casa: necesitas al menos ${fair}; si no juega, la casa suele anular la apuesta.`;
    }
    case 'combinada': {
      const parts = b.legs.map((x) => pct(x.prob)).join(' × ');
      const head = `${b.legs.length} patas de partidos distintos: ${parts} = ${pct(b.prob)} (${one})`;
      if (b.marketOdds !== undefined && b.ev !== undefined) {
        return `${head}; la casa paga ${oddsTxt(b.marketOdds)} → valor esperado ${pctSigned(b.ev)}. El margen de la casa se multiplica en cada pata${b.ev < 0 ? `: harían falta al menos ${fair} para no perder a la larga` : ''}.`;
      }
      return `${head}. Alguna pata no tiene cuota de la casa: compara; necesitas al menos ${fair} para no perder a la larga.`;
    }
    default:
      return priced(`El modelo da un ${pct(b.prob)} (${one})`);
  }
}

// ---------------------------------------------------------------------------
// Apuestas públicas
// ---------------------------------------------------------------------------

function publicLeg(l: LongshotSelection): LongshotLeg {
  const out: LongshotLeg = {
    matchId: l.match.matchId,
    compId: l.match.compId,
    compName: l.match.compName,
    date: l.match.date,
    home: l.match.home,
    away: l.match.away,
    market: l.market,
    selection: l.selection,
    prob: r4(l.prob),
    // de la probabilidad PUBLICADA: en una simple, la cuota justa de la pata y la de la apuesta coinciden (6,43 vs 6,44)
    fairOdds: r2(1 / Math.max(r4(l.prob), 1e-6)),
    category: l.category,
  };
  if (l.marketOdds !== undefined) out.marketOdds = r3(l.marketOdds);
  if (l.player) out.player = { id: l.player.id, name: l.player.name, short: l.player.short, teamId: l.player.teamId };
  if (l.result) out.result = l.result;
  return out;
}

export function publicBet(b: LongshotEngineBet): LongshotBet {
  const legs = b.legs.map(publicLeg);
  // probabilidad y cuotas a partir de las patas publicadas (redondeadas), para que el producto cuadre
  const prob = legs.reduce((p, l) => p * l.prob, 1);
  const priced = legs.every((l) => l.marketOdds !== undefined);
  const marketOdds = priced ? legs.reduce((o, l) => o * l.marketOdds!, 1) : undefined;
  const fairOdds = 1 / prob;
  const oneIn = Math.max(1, Math.round(fairOdds));
  const ev = marketOdds !== undefined ? prob * marketOdds - 1 : undefined;
  // la frase se escribe con las MISMAS cifras que se publican (patas redondeadas) y el valor esperado se publica con 6
  // decimales: con 4, p. ej. −0,03148 → −0,0315, la tarjeta decía «−3,2 %» y la frase «−3,1 %»
  const shown: LongshotEngineBet = { ...b, prob, fairOdds, oneIn, marketOdds, ev };
  if (marketOdds === undefined) delete shown.marketOdds;
  if (ev === undefined) delete shown.ev;
  const out: LongshotBet = {
    id: b.id,
    kind: b.kind,
    label: b.label,
    legs,
    prob: r4(prob),
    fairOdds: r2(fairOdds),
    displayOdds: r2(marketOdds ?? fairOdds),
    oneIn,
    score: b.score,
    reason: longshotReason(shown),
  };
  if (marketOdds !== undefined && ev !== undefined) {
    out.marketOdds = r2(marketOdds);
    out.ev = r6(ev);
  }
  if (b.result) out.result = b.result;
  return out;
}

// ---------------------------------------------------------------------------
// longshots.json
// ---------------------------------------------------------------------------

function recordOut(r: LongshotWalkForward['byKind'][number], excluded: string | undefined): LongshotRecord {
  const out: LongshotRecord = {
    kind: r.kind,
    label: KIND_LABEL[r.kind],
    bets: r.bets,
    hits: r.hits,
    hitRate: r4(r.hitRate),
    expectedHitRate: r4(r.expectedHitRate),
    avgOdds: r2(r.avgOdds),
    longestLosingStreak: r.longestLosingStreak,
  };
  if (r.n > 0) {
    out.wilsonLow = r4(Math.min(r.wilsonLow, r.hitRate));
    out.wilsonHigh = r4(Math.max(r.wilsonHigh, r.hitRate));
  }
  if (r.voids) out.voids = r.voids;
  if (r.roi) out.roi = { bets: r.roi.bets, staked: r.roi.staked, profit: r2(r.roi.profit), roi: r4(r.roi.roi) };
  if (excluded) out.excluded = excluded;
  return out;
}

function noteFor(state: LongshotState): string {
  const wf = state.wf;
  const tail = 'Juega solo lo que puedas permitirte perder. Solo mayores de 18 años (+18).';
  const base = `Apuestas de cuota ${MIN_ODDS} o más: la mayoría PIERDEN. Con cuota ${MIN_ODDS} se acierta, como mucho, 1 de cada ${MIN_ODDS} veces, y solo se gana a la larga si la probabilidad real supera la implícita en la cuota (valor esperado positivo).`;
  if (!wf || !(wf.overall.n > 0)) {
    const why = (state.error ?? 'Todavía no hay historial suficiente para medir estas apuestas fuera de muestra').replace(/\.\s*$/, '');
    return `${base} ${why}: no se publica ninguna recomendación. En las combinadas el margen de la casa se multiplica en cada pata. ${tail}`;
  }
  const o = wf.overall;
  const parts = [base];
  const oneIn = o.hits > 0 ? `, 1 de cada ${Math.round(o.n / o.hits)}` : '';
  let s = `Fuera de muestra (${fmtDay(wf.from)} – ${fmtDay(wf.to)}), la misma regla diaria acertó ${o.hits} de ${o.n} apuestas (${pct(o.hitRate)}${oneIn}; el modelo esperaba ${pct(o.expectedHitRate)})`;
  if (o.roi) s += ` y, apostando 1 unidad a cada una de las ${o.roi.bets} con cuota de cierre de la casa, el resultado fue ${o.roi.profit >= 0 ? '+' : '−'}${es(Math.abs(o.roi.profit), 1)} unidades (ROI ${pctSigned(o.roi.roi)})`;
  parts.push(`${s}.`);
  if (o.expectedHitRate > o.hitRate) parts.push(`El modelo es optimista con estas apuestas: su «1 de cada N» se queda corto.`);
  const ep = wf.evPositive;
  if (ep.bets > 0) {
    parts.push(
      ep.roi < 0
        ? `Ni siquiera las que el modelo veía con valor esperado positivo ganaron: ${ep.hits} aciertos en ${ep.bets} (ROI ${pctSigned(ep.roi)} con la cuota de cierre); la casa suele tener razón.`
        : `Las que el modelo veía con valor esperado positivo dieron un ROI de ${pctSigned(ep.roi)} (${ep.hits} aciertos en ${ep.bets}): una muestra pequeña que no garantiza nada.`,
    );
  }
  if (o.longestLosingStreak > 0) parts.push(`Hubo rachas de hasta ${o.longestLosingStreak} apuestas seguidas sin acertar (contando todas las del apartado).`);
  parts.push('En las combinadas el margen de la casa se multiplica en cada pata.');
  const ex = KIND_ORDER.filter((k) => state.excluded.has(k));
  if (ex.length) parts.push(`No se publican como recomendación: ${ex.map((k) => `${lcFirst(KIND_LABEL[k])} (${state.excluded.get(k)})`).join('; ')}.`);
  parts.push(tail);
  return parts.join(' ');
}

interface DayGroups {
  /** selecciones de cada partido del día (recalibradas) */
  groups: LongshotSelection[][];
}

/** longshots.json. Si algo falla, se publica sin apuestas ni historial y con la nota (degradar, no rechazar el build). */
export function buildLongshotFile(ctx: BuildContext, state: LongshotState): LongshotFile {
  try {
    return buildLongshotFileUnsafe(ctx, state);
  } catch (e) {
    ctx.log(`  aviso: cuota alta 6+ no disponible (${(e as Error)?.message ?? e}); se publica sin apuestas`);
    const failed: LongshotState = { ...state, wf: undefined, error: 'El cálculo de las apuestas de cuota alta ha fallado en esta actualización.' };
    return { generatedAt: ctx.refDate, minOdds: MIN_ODDS, days: [], track: { from: state.from, to: state.today, byKind: [], calibration: [] }, note: noteFor(failed) };
  }
}

function buildLongshotFileUnsafe(ctx: BuildContext, state: LongshotState): LongshotFile {
  const today = state.today;
  const published = new Set(ctx.publish.map((c) => c.id));
  const cal = state.calibrator;
  const allowed = new Set(GENERATED_KINDS.filter((k) => !state.excluded.has(k)));
  const byDay = new Map<string, DayGroups>();
  const add = (day: string, sels: LongshotSelection[]) => {
    if (!sels.length) return;
    const g = byDay.get(day);
    const s = sels.map((x) => calibrated(x, cal));
    if (g) g.groups.push(s);
    else byDay.set(day, { groups: [s] });
  };
  let broken = 0;
  // programados (próximos) y en juego (hoy)
  const scheduled: MatchRecord[] = [];
  for (const id of ctx.upcomingIds) {
    const m = ctx.matchById.get(id);
    if (!m || m.status !== 'scheduled' || !published.has(m.compId)) continue;
    if (localDay(Date.parse(m.date), HOME_TIMEZONE) < today) continue;
    scheduled.push(m);
  }
  scheduled.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id));
  const dayKeys = [...new Set(scheduled.map((m) => localDay(Date.parse(m.date), HOME_TIMEZONE)))];
  // hoy, ya terminados: sus selecciones walk-forward (generadas antes del partido) ya resueltas
  const todayFinished = state.items.filter((it) => {
    const m = ctx.matchById.get(it.match.matchId);
    return !!m && isFinishedRecord(m) && published.has(it.match.compId) && localDay(Date.parse(it.match.date), HOME_TIMEZONE) === today;
  });
  const live: MatchRecord[] = [];
  for (const id of ctx.liveIds) {
    const m = ctx.matchById.get(id);
    if (m && m.status === 'live' && published.has(m.compId) && localDay(Date.parse(m.date), HOME_TIMEZONE) === today) live.push(m);
  }
  if (todayFinished.length || live.length) dayKeys.push(today);
  const days = [...new Set(dayKeys)].sort().slice(0, LONGSHOT_MAX_DAYS);
  const keep = new Set(days);

  if (allowed.size) {
    for (const m of scheduled) {
      const day = localDay(Date.parse(m.date), HOME_TIMEZONE);
      if (!keep.has(day)) continue;
      try {
        add(day, matchSelections(upcomingLongshotInput(ctx, m)));
      } catch {
        broken++;
      }
    }
    if (keep.has(today)) {
      for (const m of live) {
        try {
          add(today, matchSelections(liveLongshotInput(ctx, m)));
        } catch {
          broken++;
        }
      }
      for (const it of todayFinished) add(today, it.selections);
    }
  }
  if (broken) ctx.log(`  aviso: ${broken} partidos sin apuestas de cuota alta por datos anómalos`);

  const outDays: LongshotDay[] = days.map((date) => {
    const g = byDay.get(date);
    const bets = g && allowed.size ? dayBets(g.groups, { kinds: allowed }).slice(0, MAX_PER_DAY) : [];
    return { date, bets: bets.map(publicBet) };
  });

  const track: LongshotFile['track'] = { from: state.from, to: today, byKind: [], calibration: [] };
  const wf = state.wf;
  if (wf && wf.days > 0) {
    track.from = wf.from;
    track.to = wf.to;
    track.byKind = wf.byKind.map((r) => recordOut(r, state.excluded.get(r.kind)));
    track.calibration = wf.calibration.map((b) => ({ from: b.from, to: b.to, predicted: r4(b.predicted), observed: r4(b.observed), n: b.n }));
  }
  return { generatedAt: ctx.refDate, minOdds: MIN_ODDS, days: outDays, track, note: noteFor(state) };
}

/** Portada: la mejor apuesta aún abierta (sin empezar) del primer día que la tenga y el nº de apuestas de ese día. */
export function homeLongshot(file: LongshotFile, now: number): HomeFile['longshot'] | undefined {
  for (const d of file.days) {
    const open = d.bets.filter((b) => b.result === undefined && b.legs.every((l) => l.result === undefined && Date.parse(l.date) > now));
    if (open.length) return { date: d.date, bets: d.bets.length, best: open[0] };
  }
  return undefined;
}

/** Resumen de una línea para el registro del build. */
export function longshotSummaryLine(state: LongshotState, file?: LongshotFile): string {
  const o = state.wf?.overall;
  if (!o) return state.error ?? 'sin historial';
  const day = file?.days[0];
  const roi = o.roi ? ` · ROI ${(o.roi.roi * 100).toFixed(1)} % (n = ${o.roi.bets})` : '';
  const ex = state.excluded.size ? ` · sin publicar: ${[...state.excluded.keys()].join(', ')}` : '';
  return `fuera de muestra ${o.hits}/${o.n} = ${o.n ? (o.hitRate * 100).toFixed(1) : '—'} % (esperado ${(o.expectedHitRate * 100).toFixed(1)} %)${roi}${ex}${day ? ` · ${day.date}: ${day.bets.length} apuestas` : ''}`;
}

