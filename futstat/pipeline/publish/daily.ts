/**
 * «PRONÓSTICOS DEL DÍA» en el build (motor: pipeline/analytics/daily.ts) → public/data/daily.json (DailyFile) y
 * HomeFile.daily.
 *
 *  1. prepareDaily(ctx, confidence, history): reglas de las familias adicionales (tiros, faltas, jugadores) con el mismo
 *     procedimiento y validación fuera de muestra que las existentes, y récord walk-forward de la regla de selección
 *     diaria (hasta 2 por categoría y 8 por partido). No toca confidence.json: usa las reglas ya validadas de
 *     prepareConfidence (ev.rules) para resultado / goles / córners / tarjetas.
 *  2. buildDailyFile(ctx, state, confidence): hoy y los días siguientes con partidos (máx. 4, zona HOME_TIMEZONE). Por
 *     partido PROGRAMADO con algún pick validado: picks (mejor primero), números esperados, análisis en viñetas y una
 *     frase por pick con las cifras que lo sostienen. Los partidos de HOY ya terminados aparecen con sus picks
 *     reconstruidos walk-forward (reglas ajustadas sin ese partido) y ya resueltos; los que están EN JUEGO, con los
 *     picks calculados solo con información anterior al saque (última cuota previa), sin resultado todavía. top (máx.
 *     10, uno por partido) y combinadas solo con partidos que aún no han empezado.
 *  3. homeDaily(file): resumen para la portada (fecha, nº de partidos y picks y los 4 mejores).
 *
 * Honestidad: todas las cifras de acierto son fuera de muestra; el alto acierto de estas selecciones (cuota baja) no es
 * una ventaja frente a la casa (track.baseline: una estrategia fija sin modelo acierta casi lo mismo); los props de
 * jugador dependen de la alineación (si el jugador no juega, la casa suele anular la apuesta).
 *
 * Si el motor falla, el build NO se rechaza: se publica daily.json sin picks con una nota (degradar, no rechazar).
 */
import type {
  ConfidenceBaseline,
  ConfidenceRecord,
  DailyCategory,
  DailyCombo,
  DailyDay,
  DailyExpected,
  DailyFile,
  DailyMatch,
  DailyPick,
  HomeFile,
  PlayerProp,
  StatProjection,
  TeamSeasonStats,
} from '../../src/types/data';
import { HOME_TIMEZONE } from '../config';
import type { MatchRecord } from '../types';
import {
  DAILY_EXTRA_FAMILIES,
  FIXED_BASELINE_LABEL,
  GOLD_MIN_RATE,
  VALIDATION_MIN_N,
  VALIDATION_MIN_RATE,
  familyBaseRates,
  fixedBaseline,
  upcomingCandidates,
  type ConfidenceFamily,
  type ConfidenceHistoryItem,
  type ConfidenceRules,
  type HitStats,
} from '../analytics/confidence';
import {
  DAILY_MAX_PER_CATEGORY,
  DAILY_MAX_PER_MATCH,
  bestPerMatch,
  buildCombos,
  dailyWalkForward,
  evaluateExtras,
  mergeRules,
  preMatchCandidates,
  selectDailyPicks,
  upcomingExtraCandidates,
  type DailyEnginePick,
  type DailyHistory,
  type DailySettledPick,
  type DailyWalkForward,
  type ExtraEvaluation,
  type OosRecord,
  type ScoreContext,
} from '../analytics/daily';
import { TEAM_WINDOW_DAYS, isFinishedRecord, type BuildContext, type FullPrediction } from './context';
import { publicPick, slimSummary, type ConfidenceState, type HoldoutByFamily, type ValidationByRule } from './confidence';
import { compTeamStats, fullPrediction, matchSummary, propsFor } from './matches';
import type { DailyFamiliesSummary } from './methodology';
import { DAY_MS, localDay } from './util';

/** Días publicados: hoy y los siguientes con partidos. */
export const DAILY_MAX_DAYS = 4;
/** Mejores picks del día (uno por partido) y como mucho estos de la misma familia de mercado (variedad). */
export const DAILY_TOP = 10;
export const DAILY_TOP_PER_FAMILY = 3;
/** Portada: mejores picks del día. */
export const HOME_DAILY_TOP = 4;

export const DAILY_CATEGORIES: { id: DailyCategory; label: string }[] = [
  { id: 'resultado', label: 'Resultado' },
  { id: 'goles', label: 'Goles' },
  { id: 'tiros', label: 'Tiros y tiros a puerta' },
  { id: 'corners', label: 'Córners' },
  { id: 'tarjetas', label: 'Tarjetas' },
  { id: 'faltas', label: 'Faltas' },
  { id: 'jugadores', label: 'Jugadores' },
];
const CATEGORY_LABEL = new Map(DAILY_CATEGORIES.map((c) => [c.id, c.label]));

export interface DailyState {
  /** motivo por el que no hay pronósticos del día */
  error?: string;
  extras?: ExtraEvaluation;
  wf?: DailyWalkForward;
  /** reglas de producción validadas: existentes (confidence) + adicionales */
  rules?: ConfidenceRules;
  score?: ScoreContext;
  validation?: ValidationByRule;
  /** partidos de los tramos walk-forward (línea base sin modelo) */
  wfItems?: ConfidenceHistoryItem[];
  seconds: number;
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Historial «adicional» vacío (mismos partidos, sin candidatos): el apartado diario solo con las familias existentes. */
export function emptyExtraHistory(base: ConfidenceHistoryItem[]): ConfidenceHistoryItem[] {
  return base.map((it) => ({ ...it, candidates: [], base: {} }));
}

/**
 * Reglas de las familias adicionales y récord fuera de muestra de la regla diaria. Después de prepareConfidence (usa su
 * evaluación) y con el historial de dailyHistory(ctx) (si falta `history.extra`, solo familias existentes).
 */
export function prepareDaily(ctx: BuildContext, confidence: ConfidenceState, history?: Partial<DailyHistory>): DailyState {
  const t0 = performance.now();
  const state: DailyState = { seconds: 0 };
  const ev = confidence.ev;
  if (!ev) {
    state.error = confidence.error ?? 'Pronósticos del día no disponibles en esta actualización.';
    return state;
  }
  try {
    const base = ev.history;
    const extra = history?.extra && history.extra.length === base.length ? history.extra : emptyExtraHistory(base);
    const extras = evaluateExtras(extra);
    const wf = dailyWalkForward(ev.wf, extras.wf, base, extra, HOME_TIMEZONE);
    const oos = new Map<string, OosRecord>();
    const validation: ValidationByRule = { ...(confidence.validation ?? {}) };
    for (const v of ev.validation) if (v.n > 0) oos.set(v.key, { n: v.n, hits: v.hits, hitRate: v.hitRate });
    for (const [key, v] of extras.validation) {
      if (!(v.n > 0)) continue;
      oos.set(key, { n: v.n, hits: v.hits, hitRate: v.hitRate });
      validation[key] = { hitRate: v.hitRate, n: v.n, wilsonLow: r4(v.wilsonLow), wilsonHigh: r4(v.wilsonHigh) };
    }
    const ids = new Set(ev.wf.items.map((it) => it.matchId));
    state.extras = extras;
    state.wf = wf;
    state.rules = mergeRules(ev.rules, extras.rules);
    state.score = { validation: oos, baseRates: { ...familyBaseRates(ev.wf.items), ...familyBaseRates(extra.filter((it) => ids.has(it.matchId))) } };
    state.validation = validation;
    state.wfItems = ev.wf.items;
  } catch (e) {
    state.error = 'El cálculo de los pronósticos del día ha fallado en esta actualización.';
    ctx.log(`  aviso: pronósticos del día no disponibles (${(e as Error)?.message ?? e}); se publica sin picks`);
  }
  state.seconds = (performance.now() - t0) / 1000;
  return state;
}

// ---------------------------------------------------------------------------
// Textos (español, con cifras)
// ---------------------------------------------------------------------------

const es = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d).replace('.', ',') : '—');
const pct = (x: number) => `${Math.round(Math.min(1, Math.max(0, x)) * 100)} %`;

interface SeasonRef {
  stats: TeamSeasonStats;
  /** de dónde salen las medias ("en la liga", "en su liga", "esta temporada") */
  where: string;
}

/** Medias de temporada de un equipo (su liga si la hay; si no, esta competición) con al menos 3 partidos. */
function seasonRef(ctx: BuildContext, teamId: string, compId: string): SeasonRef | undefined {
  const comp = ctx.configById.get(compId);
  const pick = (id: string | undefined, where: string): SeasonRef | undefined => {
    if (!id || !ctx.configById.has(id)) return undefined;
    const s = compTeamStats(ctx, id).get(teamId);
    return s && s.played.all >= 3 ? { stats: s, where } : undefined;
  };
  return (
    (comp?.kind === 'league' ? pick(comp.id, 'en la liga') : undefined) ??
    pick(ctx.suite.eloBuild.homeLeague.get(teamId), 'en su liga') ??
    pick(compId, 'en esta competición')
  );
}

interface MatchTexts {
  m: MatchRecord;
  fp: FullPrediction;
  proj: Map<StatProjection['key'], StatProjection>;
  home?: SeasonRef;
  away?: SeasonRef;
  props: { home: PlayerProp[]; away: PlayerProp[] };
  before: number;
}

function matchTexts(ctx: BuildContext, m: MatchRecord, withSeason: boolean, prediction?: FullPrediction): MatchTexts {
  const fp = prediction ?? fullPrediction(ctx, m, true);
  const t = Date.parse(m.date);
  const before = Number.isFinite(t) ? t : ctx.now;
  const out: MatchTexts = {
    m,
    fp,
    proj: new Map(fp.projections.map((p) => [p.key, p])),
    props: {
      home: propsFor(ctx, m.home.id, m.away.id, 'home', fp.result.lambdaHome, fp.projections, before),
      away: propsFor(ctx, m.away.id, m.home.id, 'away', fp.result.lambdaAway, fp.projections, before),
    },
    before,
  };
  // medias de temporada solo en partidos por jugar (en uno ya jugado incluirían el propio partido)
  if (withSeason) {
    out.home = seasonRef(ctx, m.home.id, m.compId);
    out.away = seasonRef(ctx, m.away.id, m.compId);
  }
  return out;
}

function expectedOf(x: MatchTexts): DailyExpected {
  const lh = x.fp.result.lambdaHome;
  const la = x.fp.result.lambdaAway;
  const out: DailyExpected = { goals: { home: r2(lh), away: r2(la), total: r2(lh + la) } };
  const set = (key: StatProjection['key'], field: 'shotsOnTarget' | 'shots' | 'corners' | 'cards' | 'fouls') => {
    const p = x.proj.get(key);
    if (p && [p.home, p.away, p.total].every((v) => Number.isFinite(v) && v >= 0)) out[field] = { home: r2(p.home), away: r2(p.away), total: r2(p.total) };
  };
  set('shotsOnTarget', 'shotsOnTarget');
  set('shots', 'shots');
  set('corners', 'corners');
  set('cards', 'cards');
  set('fouls', 'fouls');
  return out;
}

/** 2–5 viñetas con la lectura del partido: goles y favorito, tiros, córners, tarjetas/faltas y jugador más peligroso. */
function analysisOf(x: MatchTexts): string[] {
  const { m, fp } = x;
  const H = m.home.name;
  const A = m.away.name;
  const p = fp.result.quick.p;
  const lh = fp.result.lambdaHome;
  const la = fp.result.lambdaAway;
  const out: string[] = [];
  const favHome = p.home >= p.away;
  const pf = Math.max(p.home, p.away);
  const goals = `Goles esperados: ${H} ${es(lh, 2)} – ${es(la, 2)} ${A} (${es(lh + la, 2)} en total); más de 2,5 goles ${pct(fp.result.quick.over25)} y ambos marcan ${pct(fp.result.quick.btts)}.`;
  out.push(
    pf >= 0.45
      ? `${favHome ? H : A} es favorito: ${pct(pf)} de ganar (empate ${pct(p.draw)}, ${favHome ? A : H} ${pct(favHome ? p.away : p.home)}). ${goals}`
      : `Partido igualado: ${H} ${pct(p.home)}, empate ${pct(p.draw)}, ${A} ${pct(p.away)}. ${goals}`,
  );
  const sot = x.proj.get('shotsOnTarget');
  const shots = x.proj.get('shots');
  if (sot) {
    let s = `Tiros a puerta esperados: ${H} ${es(sot.home)} y ${A} ${es(sot.away)} (${es(sot.total)} en total)${shots ? `; tiros totales ${es(shots.total)} (${es(shots.home)} + ${es(shots.away)})` : ''}.`;
    if (x.home && x.away) {
      const hs = x.home.stats;
      const as = x.away.stats;
      s += ` ${H} promedia ${es(hs.shotsOnTarget.all)} a puerta ${x.home.where} y ${A} concede ${es(as.shotsOnTargetAgainst.all)}; ${A} promedia ${es(as.shotsOnTarget.all)} y ${H} concede ${es(hs.shotsOnTargetAgainst.all)}.`;
    }
    out.push(s);
  }
  const corners = x.proj.get('corners');
  if (corners) {
    out.push(
      `Córners esperados: ${es(corners.total)} (${H} ${es(corners.home)}, ${A} ${es(corners.away)})${corners.leagueAvg ? `; la media de la competición es ${es(corners.leagueAvg)}` : ''}.`,
    );
  }
  const cards = x.proj.get('cards');
  const fouls = x.proj.get('fouls');
  if (cards || fouls) {
    const parts: string[] = [];
    if (cards) parts.push(`Tarjetas esperadas: ${es(cards.total)} (${H} ${es(cards.home)}, ${A} ${es(cards.away)})`);
    if (fouls) parts.push(`${cards ? 'faltas' : 'Faltas esperadas'}: ${es(fouls.total)} (${es(fouls.home)} + ${es(fouls.away)})`);
    out.push(`${parts.join('; ')}.`);
  }
  let best: { p: PlayerProp; team: string } | undefined;
  for (const [side, team] of [
    ['home', H],
    ['away', A],
  ] as const) {
    for (const pr of x.props[side]) {
      if (pr.expMinutes < 45) continue;
      if (!best || pr.pGoal > best.p.pGoal) best = { p: pr, team };
    }
  }
  if (best && best.p.pGoal > 0) {
    out.push(
      `Jugador más peligroso: ${best.p.player.name} (${best.team}), ${pct(best.p.pGoal)} de marcar y ${pct(best.p.pSot1)} de tirar a puerta (unos ${best.p.expMinutes}' esperados).`,
    );
  }
  if (out.length < 2) out.push('Sin estadísticas suficientes de tiros, córners o tarjetas de estos equipos: el análisis se limita al resultado y los goles.');
  return out.slice(0, 5);
}

/** Tiros / tiros a puerta / minutos de un jugador en la ventana anterior al partido (la misma de sus props). */
function playerTotals(ctx: BuildContext, teamId: string, playerId: string, before: number): { minutes: number; shots: number; sot: number; goals: number; apps: number } {
  const from = before - TEAM_WINDOW_DAYS * DAY_MS;
  const out = { minutes: 0, shots: 0, sot: 0, goals: 0, apps: 0 };
  for (const l of ctx.linesByTeam.get(teamId) ?? []) {
    if (l.playerId !== playerId || !(l.minutes > 0)) continue;
    const t = Date.parse(l.date);
    if (!(t < before && t >= from)) continue;
    out.minutes += l.minutes;
    out.shots += l.shots;
    out.sot += l.shotsOnTarget;
    out.goals += l.goals;
    out.apps++;
  }
  return out;
}

/** Una frase con los números que sostienen el pick. */
function reasonOf(ctx: BuildContext, x: MatchTexts, pick: DailyEnginePick): string | undefined {
  const { m, fp } = x;
  const H = m.home.name;
  const A = m.away.name;
  const p = fp.result.quick.p;
  const lh = fp.result.lambdaHome;
  const la = fp.result.lambdaAway;
  const s = pick.settle;
  const pp = pct(pick.prob);
  switch (s.kind) {
    case 'outcome':
      if (s.win.length === 1) {
        const home = s.win[0] === 'home';
        return `El modelo da a ${home ? H : A} un ${pct(home ? p.home : p.away)} de ganar (empate ${pct(p.draw)}, ${home ? A : H} ${pct(home ? p.away : p.home)}).`;
      }
      return `Probabilidades del modelo: ${H} ${pct(p.home)}, empate ${pct(p.draw)} y ${A} ${pct(p.away)}; esta doble oportunidad cubre el ${pp}.`;
    case 'dnb': {
      const home = s.side === 'home';
      return `Sin contar el empate (${pct(p.draw)}, se devuelve la apuesta), ${home ? H : A} gana el ${pp} de las veces: ${pct(home ? p.home : p.away)} frente a ${pct(home ? p.away : p.home)}.`;
    }
    case 'handicap': {
      const home = s.side === 'home';
      return `${home ? H : A} solo falla si pierde por 2 o más goles, algo que el modelo ve en el ${pct(1 - pick.prob)} de los casos (goles esperados ${es(lh, 2)}–${es(la, 2)}).`;
    }
    case 'total': {
      if (s.stat === 'goals') {
        const k = Math.floor(s.line);
        return `Goles esperados ${es(lh, 2)} + ${es(la, 2)} = ${es(lh + la, 2)}: el modelo da un ${pp} a que haya ${s.side === 'over' ? `${k + 1} o más` : `${k} o menos`}.`;
      }
      const proj = x.proj.get(s.stat);
      if (!proj) return undefined;
      const word = s.stat === 'corners' ? 'córners' : 'tarjetas';
      return `El modelo espera ${es(proj.total)} ${word} (${H} ${es(proj.home)} + ${A} ${es(proj.away)}${proj.leagueAvg ? `; media de la competición ${es(proj.leagueAvg)}` : ''}): ${pp} de que haya ${s.side === 'over' ? 'más' : 'menos'} de ${es(s.line)}.`;
    }
    case 'team-total': {
      const home = s.team === 'home';
      const k = Math.floor(s.line);
      const what = s.side === 'over' ? (k === 0 ? 'marca al menos un gol' : `marca ${k + 1} o más`) : `se queda en ${k} o menos`;
      return `${home ? H : A} tiene ${es(home ? lh : la, 2)} goles esperados frente a ${home ? A : H}: ${what} en el ${pp} de los casos.`;
    }
    case 'btts':
      return `Goles esperados ${es(lh, 2)} de ${H} y ${es(la, 2)} de ${A}: el modelo da un ${pp} a que ${s.yes ? 'marquen los dos' : 'alguno se quede sin marcar'}.`;
    case 'stat': {
      const proj = x.proj.get(s.stat);
      if (!proj) return undefined;
      const word = s.stat === 'shotsOnTarget' ? 'tiros a puerta' : s.stat === 'shots' ? 'tiros' : 'faltas';
      const avg = (r: SeasonRef | undefined, against = false): number | undefined => {
        if (!r) return undefined;
        const st = r.stats;
        if (s.stat === 'shotsOnTarget') return against ? st.shotsOnTargetAgainst.all : st.shotsOnTarget.all;
        if (s.stat === 'shots') return against ? st.shotsAgainst.all : st.shots.all;
        return against ? undefined : st.fouls.all;
      };
      if (s.team) {
        const home = s.team === 'home';
        const own = avg(home ? x.home : x.away);
        const opp = avg(home ? x.away : x.home, true);
        const season = own !== undefined && opp !== undefined ? `${home ? H : A} promedia ${es(own)} ${word} por partido ${(home ? x.home : x.away)!.where} y ${home ? A : H} concede ${es(opp)}; ` : '';
        return `${season}${season ? 'el' : 'El'} modelo espera ${es(home ? proj.home : proj.away)} ${word} de ${home ? H : A} (${pp} de superar ${es(s.line)}).`;
      }
      const ah = avg(x.home);
      const aa = avg(x.away);
      const season = ah !== undefined && aa !== undefined ? `; ${H} promedia ${es(ah)} por partido y ${A} ${es(aa)}` : '';
      return `El modelo espera ${es(proj.total)} ${word} (${H} ${es(proj.home)} + ${A} ${es(proj.away)}${season}): ${pp} de que haya ${s.side === 'over' ? 'más' : 'menos'} de ${es(s.line)}.`;
    }
    case 'player': {
      const pl = pick.player;
      if (!pl) return undefined;
      const tot = playerTotals(ctx, pl.teamId, pl.id, x.before);
      if (!(tot.minutes > 0)) return undefined;
      const per90 = (v: number) => es((v * 90) / tot.minutes, 2);
      const what =
        s.stat === 'goals'
          ? `${tot.goals} goles (${per90(tot.goals)} por 90')`
          : s.stat === 'shotsOnTarget'
            ? `${tot.sot} tiros a puerta (${per90(tot.sot)} por 90')`
            : `${tot.shots} tiros (${per90(tot.shots)} por 90'), ${tot.sot} a puerta`;
      return `${pl.name} suma ${what} en ${tot.minutes}' y ${tot.apps} partidos, con unos ${pl.expMinutes ?? 90}' esperados: el modelo le da un ${pp} si juega (si no juega, la casa suele anular la apuesta).`;
    }
  }
}

// ---------------------------------------------------------------------------
// Picks públicos
// ---------------------------------------------------------------------------

function publicDailyPick(p: DailyEnginePick, state: DailyState, hold: HoldoutByFamily, reason: string | undefined, result?: DailySettledPick['result']): DailyPick {
  const out: DailyPick = { ...publicPick(p, result, hold, state.validation ?? {}), category: p.theme as DailyCategory, score: p.score };
  // tasa base del apartado diario: la de la familia en los partidos del walk-forward (la que usa la puntuación), para
  // que lift = validationHitRate − baseRate. Los picks ya resueltos (reconstruidos con las cifras de su tramo) no
  // publican lift: sus campos de validación son los actuales, no los de entonces.
  const b = state.score?.baseRates[p.family as ConfidenceFamily];
  if (b && b.n > 0) out.baseRate = b.hitRate;
  if (!result && p.lift !== undefined && out.baseRate !== undefined && out.validationHitRate !== undefined) out.lift = out.validationHitRate - out.baseRate;
  if (reason) out.reason = reason;
  if (p.player) {
    out.player = { id: p.player.id, name: p.player.name, short: p.player.short, teamId: p.player.teamId };
    if (p.player.position) out.player.position = p.player.position;
    if (p.player.expMinutes !== undefined) out.player.expMinutes = p.player.expMinutes;
  }
  return out;
}

const cmpTop = (a: DailyPick, b: DailyPick) => (b.score ?? 0) - (a.score ?? 0) || (b.calibratedProb ?? b.prob) - (a.calibratedProb ?? a.prob);

function recordOf(g: HitStats & { picks: number }, extra: { from: string; to: string; matches: number }): ConfidenceRecord {
  return { picks: g.picks, n: g.n, hits: g.hits, hitRate: g.hitRate, wilsonLow: r4(g.wilsonLow), wilsonHigh: r4(g.wilsonHigh), voids: g.voids, ...extra };
}

function noteFor(state: DailyState, baseline: ConfidenceBaseline | undefined): string {
  const wf = state.wf;
  if (!wf || !(wf.overall.n > 0)) {
    return `${state.error ?? 'Todavía no hay partidos suficientes para medir el acierto fuera de muestra de los pronósticos del día.'} Alto acierto no es beneficio. Juego responsable, solo mayores de 18 años.`;
  }
  const o = wf.overall;
  const p1 = (x: number) => `${(x * 100).toFixed(1).replace('.', ',')} %`;
  const parts = [
    `Son selecciones muy probables y de cuota baja: la misma regla habría acertado ${o.hits} de ${o.n} (${p1(o.hitRate)}) fuera de muestra, pero ${
      baseline && baseline.n > 0 ? `una estrategia fija sin modelo acierta ${p1(baseline.hitRate)} en los mismos partidos` : 'casi todo ese acierto es estructural'
    }: alto acierto no es ventaja frente a la casa ni beneficio.`,
  ];
  const players = wf.byTheme.jugadores;
  if (players && players.picks > 0) {
    parts.push(
      `Los pronósticos de jugadores dependen de la alineación: si el jugador no juega, la casa suele anular la apuesta (pasó en ${players.voids} de ${players.picks}); compruébala antes de apostar.`,
    );
  } else parts.push('Los pronósticos de jugadores dependen de la alineación: compruébala antes de apostar.');
  const risky = wf.combos.find((c) => c.id === 'atrevida') ?? wf.combos[wf.combos.length - 1];
  if (risky && risky.days > 0) parts.push(`Las combinadas multiplican el riesgo: la ${risky.id} (${es(risky.avgLegs)} patas de media) habría fallado ${p1(1 - risky.hitRate)} de los días.`);
  parts.push('No garantiza nada. Juego responsable, solo mayores de 18 años.');
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// daily.json
// ---------------------------------------------------------------------------

interface BuiltMatch {
  m: MatchRecord;
  entry: DailyMatch;
  /** aún no ha empezado: entra en top y combinadas */
  open: boolean;
}

export function buildDailyFile(ctx: BuildContext, state: DailyState, confidence: ConfidenceState): DailyFile {
  const published = new Set(ctx.publish.map((c) => c.id));
  const today = localDay(ctx.now, HOME_TIMEZONE);
  const hold = confidence.holdout ?? {};
  const tierOf = (m: MatchRecord) => ctx.configById.get(m.compId)?.tier ?? 0;
  const byOrder = (a: MatchRecord, b: MatchRecord) => tierOf(b) - tierOf(a) || Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id);

  // partidos por día local: programados (próximos) y, solo hoy, terminados con picks reconstruidos walk-forward
  const scheduledByDay = new Map<string, MatchRecord[]>();
  for (const id of ctx.upcomingIds) {
    const m = ctx.matchById.get(id);
    if (!m || m.status !== 'scheduled' || !published.has(m.compId)) continue;
    const day = localDay(Date.parse(m.date), HOME_TIMEZONE);
    if (day < today) continue;
    const arr = scheduledByDay.get(day);
    if (arr) arr.push(m);
    else scheduledByDay.set(day, [m]);
  }
  const settledToday = new Map<string, DailySettledPick[]>();
  if (state.wf) {
    for (const p of state.wf.picks) {
      const t = Date.parse(p.date);
      if (!(t <= ctx.now) || t < ctx.now - 2 * DAY_MS || localDay(t, HOME_TIMEZONE) !== today) continue;
      const arr = settledToday.get(p.matchId);
      if (arr) arr.push(p);
      else settledToday.set(p.matchId, [p]);
    }
  }
  // en juego (hoy): sus picks se calculan como antes del saque; no entran en top ni en combinadas
  const liveToday: MatchRecord[] = [];
  for (const id of ctx.liveIds) {
    const m = ctx.matchById.get(id);
    if (m && m.status === 'live' && published.has(m.compId) && localDay(Date.parse(m.date), HOME_TIMEZONE) === today) liveToday.push(m);
  }
  const dayKeys = [...new Set([...scheduledByDay.keys(), ...(settledToday.size || liveToday.length ? [today] : [])])].sort().slice(0, DAILY_MAX_DAYS);

  const days: DailyDay[] = [];
  let broken = 0;
  for (const date of dayKeys) {
    const built: BuiltMatch[] = [];
    let analyzed = 0;
    for (const m of scheduledByDay.get(date) ?? []) {
      analyzed++;
      if (!state.rules || !state.score) continue;
      try {
        const picks = selectDailyPicks([...upcomingCandidates(ctx, m), ...upcomingExtraCandidates(ctx, m)], state.rules, state.score, {
          maxPerCategory: DAILY_MAX_PER_CATEGORY,
          maxPerMatch: DAILY_MAX_PER_MATCH,
        });
        if (!picks.length) continue;
        const x = matchTexts(ctx, m, true);
        built.push({
          m,
          open: Date.parse(m.date) > ctx.now,
          entry: { match: matchSummary(ctx, m), picks: picks.map((p) => publicDailyPick(p, state, hold, reasonOf(ctx, x, p))), expected: expectedOf(x), analysis: analysisOf(x) },
        });
      } catch {
        broken++; // partido anómalo: sin picks del día
      }
    }
    if (date === today && state.rules && state.score) {
      for (const m of liveToday) {
        analyzed++;
        try {
          const pre = preMatchCandidates(ctx, m);
          const picks = selectDailyPicks(pre.candidates, state.rules, state.score, { maxPerCategory: DAILY_MAX_PER_CATEGORY, maxPerMatch: DAILY_MAX_PER_MATCH });
          if (!picks.length) continue;
          const x = matchTexts(ctx, m, true, pre.fp);
          built.push({
            m,
            open: false,
            entry: { match: matchSummary(ctx, m), picks: picks.map((p) => publicDailyPick(p, state, hold, reasonOf(ctx, x, p))), expected: expectedOf(x), analysis: analysisOf(x) },
          });
        } catch {
          broken++;
        }
      }
    }
    if (date === today) {
      for (const [id, list] of settledToday) {
        const m = ctx.matchById.get(id);
        if (!m || !isFinishedRecord(m) || !published.has(m.compId)) continue;
        analyzed++;
        try {
          const x = matchTexts(ctx, m, false);
          const picks = list.slice().sort((a, b) => b.score - a.score || b.calibratedProb - a.calibratedProb || a.family.localeCompare(b.family));
          built.push({
            m,
            open: false,
            entry: { match: matchSummary(ctx, m), picks: picks.map((p) => publicDailyPick(p, state, hold, reasonOf(ctx, x, p), p.result)), expected: expectedOf(x), analysis: analysisOf(x) },
          });
        } catch {
          broken++;
        }
      }
    }
    built.sort((a, b) => byOrder(a.m, b.m));
    const open = built.filter((b) => b.open);
    const byId = new Map(open.map((b) => [b.m.id, b]));
    const top = bestPerMatch(
      open.map((b) => ({ matchId: b.m.id, picks: b.entry.picks })),
      cmpTop,
      DAILY_TOP_PER_FAMILY,
      DAILY_TOP,
    );
    const combos: DailyCombo[] = buildCombos(open.map((b) => ({ matchId: b.m.id, picks: b.entry.picks }))).map((c) => {
      const combo: DailyCombo = {
        id: c.id,
        label: c.label,
        legs: c.legs.map((l) => {
          const s = byId.get(l.matchId)!.entry.match;
          return { matchId: l.matchId, home: s.home.name, away: s.away.name, compName: s.compName, pick: l.pick };
        }),
        prob: r4(c.prob),
        fairOdds: r3(c.fairOdds),
      };
      if (c.marketOdds !== undefined) combo.marketOdds = r3(c.marketOdds);
      return combo;
    });
    days.push({
      date,
      matches: built.map((b) => b.entry),
      top,
      combos,
      counts: { matches: built.length, picks: built.reduce((n, b) => n + b.entry.picks.length, 0), matchesAnalyzed: analyzed },
    });
  }
  if (broken) ctx.log(`  aviso: ${broken} partidos sin pronósticos del día por datos anómalos`);

  const empty: ConfidenceRecord = { picks: 0, n: 0, hits: 0, hitRate: 0, from: '', to: '' };
  const track: DailyFile['track'] = { overall: empty, byCategory: [] };
  let baseline: ConfidenceBaseline | undefined;
  const wf = state.wf;
  if (wf) {
    track.overall = recordOf(wf.overall, { from: wf.from, to: wf.to, matches: wf.matches });
    for (const c of DAILY_CATEGORIES) {
      const g = wf.byTheme[c.id];
      if (!g || !(g.picks > 0)) continue;
      const row: DailyFile['track']['byCategory'][number] = {
        category: c.id,
        label: c.label,
        picks: g.picks,
        n: g.n,
        hits: g.hits,
        hitRate: g.hitRate,
        wilsonLow: r4(g.wilsonLow),
        wilsonHigh: r4(g.wilsonHigh),
        voids: g.voids,
      };
      if (g.baseRate !== undefined) row.baseRate = g.baseRate;
      track.byCategory.push(row);
    }
    if (wf.combos.length) {
      track.combos = wf.combos.map((c) => ({ id: c.id, label: c.label, days: c.days, hits: c.hits, hitRate: c.hitRate, avgLegs: r2(c.avgLegs), avgFairOdds: r3(c.avgFairOdds) }));
    }
    const fb = state.wfItems?.length ? fixedBaseline(state.wfItems) : undefined;
    if (fb && fb.n > 0) {
      baseline = { label: FIXED_BASELINE_LABEL, picks: fb.picks, n: fb.n, hits: fb.hits, hitRate: fb.hitRate, wilsonLow: r4(fb.wilsonLow), wilsonHigh: r4(fb.wilsonHigh), matches: fb.matches };
      track.baseline = baseline;
    }
  }
  return { generatedAt: ctx.refDate, days, categories: DAILY_CATEGORIES, track, note: noteFor(state, baseline) };
}

/** Resumen para la portada: el primer día (hoy o el siguiente con partidos) que tiene picks abiertos. */
export function homeDaily(file: DailyFile): HomeFile['daily'] | undefined {
  const day = file.days.find((d) => d.top.length > 0);
  if (!day) return undefined;
  const byId = new Map(day.matches.map((x) => [x.match.id, x.match]));
  const top = day.top
    .slice(0, HOME_DAILY_TOP)
    .filter((t) => byId.has(t.matchId))
    .map((t) => ({ match: slimSummary(byId.get(t.matchId)!), pick: t.pick }));
  return { date: day.date, matches: day.counts.matches, picks: day.counts.picks, top };
}

/**
 * Reglas de las familias adicionales para la metodología: publicadas (validadas y con franja oro), sin validar y
 * familias sin ninguna regla, con los picks fuera de muestra de cada una.
 */
export function dailyFamiliesSummary(state: DailyState): DailyFamiliesSummary | undefined {
  const ex = state.extras;
  if (!ex) return undefined;
  const label = (f: string) => DAILY_EXTRA_FAMILIES.find((x) => x.id === f)?.label ?? f;
  const src = (s: string | undefined) => (s === 'estadistico' ? 'sin cuotas' : 'con cuotas');
  const row = (family: string, segment: string | undefined) => {
    const v = ex.validation.get(`${family}|${segment ?? 'mercado'}`);
    return { label: label(family), source: src(segment), n: v?.n ?? 0, hits: v?.hits ?? 0 };
  };
  // una regla validada cuya franja no llega al oro no publica nada: se cuenta como sin publicar
  const gold = (r: ConfidenceRules['rules'][number]) => {
    const band = r.goldThreshold !== undefined && r.oro ? r.oro : (r.plata ?? r.tail);
    return band.n > 0 && band.hitRate >= GOLD_MIN_RATE - 1e-9;
  };
  const published = ex.rules.rules.filter(gold).map((r) => row(r.family, r.segment));
  const unvalidated = [...ex.rules.rules.filter((r) => !gold(r)).map((r) => row(r.family, r.segment)), ...ex.unvalidated.map((u) => row(u.family, u.segment))];
  const withRule = new Set([...ex.rules.rules.map((r) => r.family), ...ex.unvalidated.map((u) => u.family)]);
  const discarded = DAILY_EXTRA_FAMILIES.filter((f) => !withRule.has(f.id)).map((f) => f.label);
  return { published, unvalidated, discarded };
}

/** Resumen de una línea para el registro del build. */
export function dailySummaryLine(state: DailyState, file?: DailyFile): string {
  if (!state.wf) return state.error ?? 'no disponible';
  const o = state.wf.overall;
  const rules = dailyFamiliesSummary(state)?.published.length ?? 0;
  const day = file?.days[0];
  return `fuera de muestra ${o.hits}/${o.n} = ${o.n ? (o.hitRate * 100).toFixed(1) : '—'} % · ${rules} reglas propias publicadas (mín. ${VALIDATION_MIN_N} picks y ${Math.round(VALIDATION_MIN_RATE * 100)} % fuera de muestra)${
    day ? ` · ${day.date}: ${day.counts.picks} picks en ${day.counts.matches} partidos` : ''
  }`;
}

export { CATEGORY_LABEL };
