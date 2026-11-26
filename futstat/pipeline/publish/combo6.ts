/**
 * «COMBINADA 6» en el build (motor: pipeline/analytics/combo6.ts) → public/data/combo6.json (Combo6File) y
 * HomeFile.combo6.
 *
 *  1. prepareCombo6(ctx, confidence, daily): historial walk-forward de la regla (1 de junio de la temporada → ayer) con
 *     los tramos mensuales ya calculados por alta confianza (confidence.ev.wf) y por el apartado diario
 *     (daily.extras.wf): mismos candidatos sin fuga, mismas reglas y calibraciones de cada tramo. No predice nada nuevo.
 *  2. buildCombo6File(ctx, state, daily): hoy y los días siguientes con partidos (máx. 4, zona HOME_TIMEZONE). Por día,
 *     las patas de los partidos PROGRAMADOS que aún no han empezado (la predicción publicada en su ficha y las reglas de
 *     producción validadas del apartado diario) → combinada del día y una por competición continental con >= 5
 *     partidos con patas. Hoy solo cuentan los partidos que aún no han empezado: en cada actualización (cada 3 horas)
 *     la combinada de hoy se recalcula con los que quedan. Sin combinada posible, el día se publica con el motivo.
 *  3. homeCombo6(file, now): la combinada del primer día cuyo primer partido aún no ha empezado.
 *
 * Si algo falla, el build NO se rechaza: combo6.json se publica sin combinadas y con una nota (degradar, no rechazar).
 */
import type { Combo6Category, Combo6Combo, Combo6Day, Combo6File, Combo6History, Combo6Leg, HomeFile, Prob1X2, StatProjection } from '../../src/types/data';
import { HOME_TIMEZONE } from '../config';
import type { MatchRecord } from '../types';
import {
  CATEGORY_LABEL,
  COMBO6_CATEGORIES,
  CONTINENTAL_IDS,
  LEG_MAX_PROB,
  LEG_MIN_PROB,
  MARGIN_EST,
  MARGIN_TEAM_GOALS,
  MAX_LEGS,
  MAX_PER_CATEGORY,
  MIN_CATEGORIES,
  MIN_LEGS,
  PLAYERS_ENABLED,
  RECENT_COMBOS,
  TARGET_MAX,
  TARGET_MIN,
  combo6Warning,
  combo6WalkForward,
  comboResult,
  dayCombos,
  matchLegs,
  type Combo6EngineCombo,
  type Combo6EngineLeg,
  type Combo6WalkForward,
} from '../analytics/combo6';
import { upcomingCandidates, type ConfidenceRules } from '../analytics/confidence';
import { upcomingExtraCandidates } from '../analytics/daily';
import type { BuildContext } from './context';
import type { ConfidenceState } from './confidence';
import type { DailyState } from './daily';
import { seasonFrom } from './longshots';
import { fullPrediction } from './matches';
import { localDay } from './util';

/** Días publicados: hoy y los siguientes con partidos. */
export const COMBO6_MAX_DAYS = 4;
/** Etiqueta del ámbito «todas las competiciones». */
export const SCOPE_ALL = 'todas';

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export interface Combo6State {
  error?: string;
  today: string;
  /** primer día del historial (1 de junio de la temporada) */
  from: string;
  wf?: Combo6WalkForward;
  /** reglas de producción validadas (existentes + adicionales) del apartado diario */
  rules?: ConfidenceRules;
  seconds: number;
}

/** Historial walk-forward y reglas de producción. Sin evaluación del apartado diario no hay combinadas. */
export function prepareCombo6(ctx: BuildContext, confidence: ConfidenceState, daily: DailyState): Combo6State {
  const t0 = performance.now();
  const today = localDay(ctx.now, HOME_TIMEZONE);
  const state: Combo6State = { today, from: seasonFrom(today), seconds: 0 };
  try {
    const ev = confidence.ev;
    if (!ev || !daily.rules) {
      state.error = daily.error ?? confidence.error ?? 'Sin pronósticos del día en esta actualización: no hay combinada.';
    } else {
      state.rules = daily.rules;
      state.wf = combo6WalkForward(ev.wf, daily.extras?.wf, {
        timeZone: HOME_TIMEZONE,
        from: state.from,
        to: today,
        tierOf: (id) => ctx.configById.get(id)?.tier ?? 5,
      });
    }
  } catch (e) {
    state.wf = undefined;
    state.error = 'El cálculo del historial de la combinada ha fallado en esta actualización.';
    ctx.log(`  aviso: combinada 6 sin historial (${(e as Error)?.message ?? e})`);
  }
  state.seconds = (performance.now() - t0) / 1000;
  return state;
}

// ---------------------------------------------------------------------------
// Textos (español, con los números esperados del modelo)
// ---------------------------------------------------------------------------

const nf = new Map<number, Intl.NumberFormat>();
const es = (x: number, d = 1) => {
  if (!Number.isFinite(x)) return '—';
  let f = nf.get(d);
  if (!f) nf.set(d, (f = new Intl.NumberFormat('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false })));
  return f.format(x);
};
const pct = (x: number) => `${Math.round(Math.min(1, Math.max(0, x)) * 100)} %`;

interface LegTexts {
  H: string;
  A: string;
  p?: Prob1X2;
  lh?: number;
  la?: number;
  proj: Map<StatProjection['key'], StatProjection>;
}

function textsOf(ctx: BuildContext, m: MatchRecord): LegTexts {
  const fp = fullPrediction(ctx, m, true);
  return {
    H: m.home.name,
    A: m.away.name,
    p: fp.result.quick.p,
    lh: fp.result.lambdaHome,
    la: fp.result.lambdaAway,
    proj: new Map(fp.projections.map((x) => [x.key, x])),
  };
}

/** Una frase corta con lo que espera el modelo (p. ej. «Se esperan 10,5 córners (5,8 + 4,7)»). */
export function legReason(l: Pick<Combo6EngineLeg, 'settle' | 'prob'>, x: LegTexts): string | undefined {
  const s = l.settle;
  const goals = x.lh !== undefined && x.la !== undefined && Number.isFinite(x.lh) && Number.isFinite(x.la);
  const p = x.p;
  switch (s.kind) {
    case 'outcome':
      if (!p) return undefined;
      if (s.win.length === 1) {
        const home = s.win[0] === 'home';
        return `El modelo le da un ${pct(home ? p.home : p.away)} de ganar (empate ${pct(p.draw)}, ${home ? x.A : x.H} ${pct(home ? p.away : p.home)}).`;
      }
      return `Probabilidades del modelo: ${x.H} ${pct(p.home)}, empate ${pct(p.draw)}, ${x.A} ${pct(p.away)}.`;
    case 'dnb':
      return p ? `Sin contar el empate (${pct(p.draw)}, se devuelve): ${pct(s.side === 'home' ? p.home : p.away)} frente a ${pct(s.side === 'home' ? p.away : p.home)}.` : undefined;
    case 'handicap':
      return goals ? `Solo falla si pierde por 2 o más goles; goles esperados ${es(x.lh!, 2)}–${es(x.la!, 2)}.` : undefined;
    case 'total': {
      if (s.stat === 'goals') return goals ? `Se esperan ${es(x.lh! + x.la!, 2)} goles (${es(x.lh!, 2)} + ${es(x.la!, 2)}).` : undefined;
      const proj = x.proj.get(s.stat);
      return proj ? `Se esperan ${es(proj.total)} ${s.stat === 'corners' ? 'córners' : 'tarjetas'} (${es(proj.home)} + ${es(proj.away)}).` : undefined;
    }
    case 'team-total': {
      if (!goals) return undefined;
      const home = s.team === 'home';
      return `${home ? x.H : x.A} tiene ${es(home ? x.lh! : x.la!, 2)} goles esperados.`;
    }
    case 'btts':
      return goals ? `Goles esperados: ${x.H} ${es(x.lh!, 2)} y ${x.A} ${es(x.la!, 2)}.` : undefined;
    case 'stat': {
      const proj = x.proj.get(s.stat);
      if (!proj) return undefined;
      const word = s.stat === 'shotsOnTarget' ? 'tiros a puerta' : s.stat === 'shots' ? 'tiros' : 'faltas';
      if (s.team) return `Se esperan ${es(s.team === 'home' ? proj.home : proj.away)} ${word} de ${s.team === 'home' ? x.H : x.A}.`;
      return `Se esperan ${es(proj.total)} ${word} (${es(proj.home)} + ${es(proj.away)}).`;
    }
    case 'player':
      return `El modelo le da un ${pct(l.prob)} si juega (si no juega, la casa suele anular la apuesta).`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Combinadas públicas
// ---------------------------------------------------------------------------

function publicLeg(ctx: BuildContext, l: Combo6EngineLeg, reason?: string): Combo6Leg | undefined {
  const m = ctx.matchById.get(l.match.matchId);
  if (!m) return undefined;
  const prob = r4(l.prob);
  const out: Combo6Leg = {
    matchId: l.match.matchId,
    compId: l.match.compId,
    compName: ctx.compNames.get(l.match.compId) ?? l.match.compId,
    kickoff: l.match.date,
    home: m.home,
    away: m.away,
    category: l.category,
    marketId: l.marketId,
    market: l.market,
    selection: l.selection,
    prob,
    fairOdds: r3(1 / prob),
    bookOdds: r3(l.bookOdds),
    bookOddsEstimated: l.estimated,
    oddsSource: l.oddsSource,
  };
  if (reason) out.reason = reason;
  if (l.result) out.result = l.result;
  return out;
}

/** Combinada pública: probabilidad y cuotas a partir de las patas publicadas (redondeadas), para que el producto cuadre. */
export function publicCombo(ctx: BuildContext, c: Combo6EngineCombo, date: string, scope: string, reasons?: (l: Combo6EngineLeg) => string | undefined): Combo6Combo | undefined {
  const legs: Combo6Leg[] = [];
  for (const l of c.legs) {
    const pl = publicLeg(ctx, l, reasons?.(l));
    if (!pl) return undefined;
    legs.push(pl);
  }
  const prob = legs.reduce((p, l) => p * l.prob, 1);
  const book = legs.reduce((o, l) => o * l.bookOdds, 1);
  const kicks = legs.map((l) => l.kickoff).sort();
  const compName = scope === SCOPE_ALL ? undefined : (ctx.configById.get(scope)?.shortName ?? ctx.compNames.get(scope) ?? scope);
  const out: Combo6Combo = {
    id: `c6-${scope}-${date}-${legs.map((l) => l.matchId).join('-')}`,
    date,
    scope,
    label: compName ? `Combinada 6 · ${compName}` : 'Combinada 6 del día',
    legs,
    prob: r6(prob),
    fairOdds: r3(1 / prob),
    bookOdds: r3(book),
    estimatedLegs: legs.filter((l) => l.bookOddsEstimated).length,
    oneIn: Math.max(1, Math.round(1 / prob)),
    ev: r6(prob * book - 1),
    categories: new Set(legs.map((l) => l.category)).size,
    firstKickoff: kicks[0],
    lastKickoff: kicks[kicks.length - 1],
  };
  const res = comboResult(legs.map((l) => l.result));
  if (res) out.result = res;
  return out;
}

// ---------------------------------------------------------------------------
// combo6.json
// ---------------------------------------------------------------------------

function ruleOut(): Combo6File['rule'] {
  const margins: Partial<Record<Combo6Category, number>> = {};
  for (const c of COMBO6_CATEGORIES) if (c.id !== 'jugadores' || PLAYERS_ENABLED) margins[c.id] = MARGIN_EST[c.id];
  return {
    targetMin: TARGET_MIN,
    targetMax: TARGET_MAX,
    legMinProb: LEG_MIN_PROB,
    legMaxProb: LEG_MAX_PROB,
    minLegs: MIN_LEGS,
    maxLegs: MAX_LEGS,
    minCategories: MIN_CATEGORIES,
    maxPerCategory: MAX_PER_CATEGORY,
    margins,
  };
}

const fmtDay = (day: string) => {
  const t = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : day;
};
const pct1 = (x: number) => `${es(Math.min(1, Math.max(0, x)) * 100, 1)} %`;

function historyOut(ctx: BuildContext, state: Combo6State): Combo6History {
  const wf = state.wf;
  const empty: Combo6History = {
    from: state.from,
    to: state.today,
    days: 0,
    combos: 0,
    settled: 0,
    hits: 0,
    hitRate: 0,
    expectedHitRate: 0,
    avgLegs: 0,
    avgBookOdds: 0,
    avgFairOdds: 0,
    longestLosingStreak: 0,
    byCategory: [],
    recent: [],
  };
  if (!wf || !wf.days.length) return empty;
  const r = wf.record;
  const out: Combo6History = {
    from: wf.from,
    to: wf.to,
    days: r.days,
    combos: r.combos,
    settled: r.settled,
    hits: r.hits,
    hitRate: r.hitRate,
    expectedHitRate: r4(r.expectedHitRate),
    avgLegs: r2(r.avgLegs),
    avgBookOdds: r2(r.avgBookOdds),
    avgFairOdds: r2(r.avgFairOdds),
    longestLosingStreak: r.longestLosingStreak,
    byCategory: r.byCategory.map((c) => {
      const row: Combo6History['byCategory'][number] = { category: c.category, label: CATEGORY_LABEL[c.category], legs: c.legs, hits: c.hits, hitRate: c.hitRate, expectedHitRate: r4(c.expectedHitRate) };
      if (c.voids) row.voids = c.voids;
      return row;
    }),
    recent: [],
  };
  if (r.voids) out.voids = r.voids;
  if (r.settled > 0) {
    out.wilsonLow = r4(Math.min(r.wilsonLow, r.hitRate));
    out.wilsonHigh = r4(Math.max(r.wilsonHigh, r.hitRate));
  }
  const settled = wf.days.filter((d) => d.search.combo && (d.search.combo.result === 'hit' || d.search.combo.result === 'miss' || d.search.combo.result === 'void'));
  for (const d of settled.slice(-RECENT_COMBOS).reverse()) {
    const pc = publicCombo(ctx, d.search.combo!, d.date, SCOPE_ALL);
    if (pc) out.recent.push(pc);
  }
  const warning = combo6Warning(r);
  if (warning) out.warning = warning;
  return out;
}

function noteFor(state: Combo6State, h: Combo6History): string {
  const parts = [
    `Combinada de mercados mezclados (una pata por partido, al menos ${MIN_CATEGORIES} categorías) con cuota total entre ${TARGET_MIN} y ${TARGET_MAX} y la MAYOR probabilidad posible según el modelo; cada pata tiene entre un ${Math.round(LEG_MIN_PROB * 100)} % y un ${Math.round(LEG_MAX_PROB * 100)} %.`,
    'No es una apuesta con ventaja: cada pata paga el margen de la casa y el margen se multiplica, así que el valor esperado es negativo y la mayoría de los días se pierde.',
    `La mayoría de las patas (córners, tiros, tarjetas, faltas, goles de un equipo, doble oportunidad…) no tienen cuota real de la casa en nuestros datos: su cuota es ESTIMADA (la justa menos un margen típico del ${Math.round(MARGIN_EST.goles * 100)}–${Math.round(MARGIN_TEAM_GOALS * 100)} %). Compara con tu casa: si la cuota total no llega a ${TARGET_MIN}, no es esta combinada.`,
  ];
  if (h.settled > 0) {
    const oneIn = h.hits > 0 ? `, 1 de cada ${Math.round(h.settled / h.hits)}` : '';
    parts.push(
      `Fuera de muestra (${fmtDay(h.from)} – ${fmtDay(h.to)}), la misma regla habría acertado ${h.hits} de ${h.settled} combinadas (${pct1(h.hitRate)}${oneIn}); el modelo esperaba un ${pct1(h.expectedHitRate)}. Hubo rachas de hasta ${h.longestLosingStreak} días seguidos sin acertar.`,
    );
  } else {
    parts.push(`${(state.error ?? 'Todavía no hay historial suficiente para medir la combinada fuera de muestra').replace(/\.\s*$/, '')}.`);
  }
  parts.push('No se calcula rentabilidad (ROI): sin precios reales de la mayoría de las patas no se puede medir honestamente.');
  if (h.warning) parts.push(h.warning);
  parts.push('Juega solo lo que puedas permitirte perder. Solo mayores de 18 años (+18).');
  return parts.join(' ');
}

/** combo6.json. Si algo falla, se publica sin combinadas ni historial y con la nota (degradar, no rechazar el build). */
export function buildCombo6File(ctx: BuildContext, state: Combo6State): Combo6File {
  try {
    return buildCombo6FileUnsafe(ctx, state);
  } catch (e) {
    ctx.log(`  aviso: combinada 6 no disponible (${(e as Error)?.message ?? e}); se publica sin combinadas`);
    const failed: Combo6State = { ...state, wf: undefined, error: 'El cálculo de la combinada ha fallado en esta actualización.' };
    const history = historyOut(ctx, failed);
    return { generatedAt: ctx.refDate, rule: ruleOut(), days: [], history, note: noteFor(failed, history) };
  }
}

function buildCombo6FileUnsafe(ctx: BuildContext, state: Combo6State): Combo6File {
  const published = new Set(ctx.publish.map((c) => c.id));
  const tierOf = (id: string) => ctx.configById.get(id)?.tier ?? 5;
  // partidos programados que aún no han empezado, por día local
  const byDay = new Map<string, MatchRecord[]>();
  for (const id of ctx.upcomingIds) {
    const m = ctx.matchById.get(id);
    if (!m || m.status !== 'scheduled' || !published.has(m.compId)) continue;
    const t = Date.parse(m.date);
    if (!(t > ctx.now)) continue;
    const day = localDay(t, HOME_TIMEZONE);
    if (day < state.today) continue;
    const arr = byDay.get(day);
    if (arr) arr.push(m);
    else byDay.set(day, [m]);
  }
  const dates = [...byDay.keys()].sort().slice(0, COMBO6_MAX_DAYS);
  const continental = CONTINENTAL_IDS.filter((id) => published.has(id));
  const texts = new Map<string, LegTexts>();
  const reasons = (l: Combo6EngineLeg) => {
    const m = ctx.matchById.get(l.match.matchId);
    if (!m) return undefined;
    try {
      let x = texts.get(m.id);
      if (!x) texts.set(m.id, (x = textsOf(ctx, m)));
      return legReason(l, x);
    } catch {
      return undefined;
    }
  };
  let broken = 0;
  const days: Combo6Day[] = dates.map((date) => {
    const matches = byDay.get(date)!.slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id));
    const legs: Combo6EngineLeg[] = [];
    if (state.rules) {
      for (const m of matches) {
        try {
          const cands = [...upcomingCandidates(ctx, m), ...upcomingExtraCandidates(ctx, m)];
          legs.push(...matchLegs(cands, state.rules, { matchId: m.id, compId: m.compId, date: m.date, tier: tierOf(m.compId) }));
        } catch {
          broken++;
        }
      }
    }
    const eligible = new Set(legs.map((l) => l.match.matchId)).size;
    const day: Combo6Day = { date, byCompetition: [], counts: { matches: matches.length, eligibleMatches: eligible, candidateLegs: legs.length } };
    if (!state.rules) {
      day.reason = state.error ?? 'Sin reglas validadas en esta actualización: no hay combinada.';
      return day;
    }
    const dc = dayCombos(legs, { continental });
    const main = dc.main.combo ? publicCombo(ctx, dc.main.combo, date, SCOPE_ALL, reasons) : undefined;
    if (main) day.main = main;
    else day.reason = dc.main.reason ?? 'No hay ninguna combinada que cumpla la regla.';
    for (const x of dc.byCompetition) {
      if (!x.search.combo) continue;
      const pc = publicCombo(ctx, x.search.combo, date, x.compId, reasons);
      if (pc) day.byCompetition.push(pc);
    }
    return day;
  });
  if (broken) ctx.log(`  aviso: ${broken} partidos sin patas de la combinada 6 por datos anómalos`);
  const history = historyOut(ctx, state);
  return { generatedAt: ctx.refDate, rule: ruleOut(), days, history, note: noteFor(state, history) };
}

/** Portada: la combinada del primer día cuyo primer partido aún no ha empezado. */
export function homeCombo6(file: Combo6File, now: number): HomeFile['combo6'] | undefined {
  for (const d of file.days) {
    const c = d.main;
    if (c && c.result === undefined && Date.parse(c.firstKickoff) > now) return { date: d.date, combo: c };
  }
  return undefined;
}

/** Resumen de una línea para el registro del build. */
export function combo6SummaryLine(state: Combo6State, file?: Combo6File): string {
  const r = state.wf?.record;
  if (!r) return state.error ?? 'sin historial';
  const day = file?.days.find((d) => d.main);
  const head = `${r.combos} combinadas en ${r.days} días · aciertos ${r.hits}/${r.settled} = ${r.settled ? (r.hitRate * 100).toFixed(1) : '—'} % (esperado ${(r.expectedHitRate * 100).toFixed(1)} %)`;
  return `${head}${day?.main ? ` · ${day.date}: ${day.main.legs.length} patas, cuota ${day.main.bookOdds.toFixed(2)}, prob ${(day.main.prob * 100).toFixed(1)} %` : ''}`;
}
