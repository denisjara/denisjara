/**
 * Pronósticos de ALTA CONFIANZA en el build (motor: pipeline/analytics/confidence.ts, que aquí NO se modifica).
 *
 *  1. prepareConfidence(ctx): evaluateConfidence(ctx) → reglas de producción (todo el historial walk-forward) y cifras
 *     honestas (calibración 60 % más antiguo → holdout, nunca usado para elegir nada). Para cada partido PRÓXIMO:
 *     selectConfidencePicks(upcomingCandidates(ctx, m), ev.rules). Para los terminados recientes: picks walk-forward
 *     del holdout ya resueltos (reglas ajustadas sin esos partidos). Rellena ctx.confidencePicks / ctx.confidenceSettled
 *     ANTES de construir cualquier MatchSummary (matchSummary los lee para `prediction.safe` y buildMatchFile para
 *     `confidence`).
 *  2. buildConfidenceFile(ctx, state) → public/data/confidence.json (ConfidenceFile).
 *  3. homeConfidence(ctx, state) → topConfidence (máx. 8 en 72 h, uno por partido) y confidenceHeadline de home.json.
 *
 * Si el motor falla, el build NO se rechaza: se publica confidence.json vacío con una nota (degradar, no rechazar).
 */
import type {
  ConfidenceFamilyRow,
  ConfidenceFile,
  ConfidencePick,
  ConfidenceRecord,
  ConfidenceSource,
  ConfidenceTier,
  HomeFile,
  MatchSummary,
} from '../../src/types/data';
import {
  CONFIDENCE_FAMILIES,
  evaluateConfidence,
  selectConfidencePicks,
  upcomingCandidates,
  type ConfidenceEvaluation,
  type ConfidenceHistoryItem,
  type ConfidencePick as EnginePick,
  type ConfidenceReport,
  type GroupReport,
  type SettledPick,
} from '../analytics/confidence';
import type { BuildContext } from './context';
import { matchSummary } from './matches';
import { DAY_MS } from './util';

/** Picks como mucho por partido (de temas distintos) y acierto histórico mínimo de la franja (motor). */
export const CONFIDENCE_MAX_PER_MATCH = 2;
export const CONFIDENCE_MIN_HIT_RATE = 0.8;
/** Días de picks resueltos recientes publicados. */
export const CONFIDENCE_RECENT_DAYS = 14;
/** Portada: picks de las próximas N horas, como mucho M (uno por partido). */
export const HOME_CONFIDENCE_HOURS = 72;
export const HOME_TOP_CONFIDENCE = 8;
/** Familias con al menos esta muestra fuera de muestra y acierto < 80 % llevan un aviso. */
const WARN_MIN_N = 20;

export interface ConfidenceState {
  /** evaluación del motor (undefined si falló o no hay historial) */
  ev?: ConfidenceEvaluation;
  /** motivo por el que no hay evaluación */
  error?: string;
  /** picks publicados de los partidos próximos */
  upcoming: number;
  /** acierto fuera de muestra por familia */
  holdout?: HoldoutByFamily;
  seconds: number;
}

// probabilidades y cuotas redondeadas; los aciertos (hits / n) se publican sin redondear aquí (el escritor JSON los deja
// en 5 decimales) para que «79,9 %» no se convierta en «79,8 %» por redondear dos veces
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Acierto FUERA DE MUESTRA (holdout) de cada familia: se adjunta a cada pick para que la UI lo muestre. */
export type HoldoutByFamily = Partial<Record<string, { hitRate: number; n: number }>>;

export function holdoutByFamily(ev: ConfidenceEvaluation | undefined): HoldoutByFamily {
  const out: HoldoutByFamily = {};
  for (const [family, g] of Object.entries(ev?.holdout.byFamily ?? {})) if (g && g.n > 0) out[family] = { hitRate: g.hitRate, n: g.n };
  return out;
}

/** Pick del motor → pick del contrato. */
export function publicPick(p: EnginePick, result?: SettledPick['result'], holdout: HoldoutByFamily = {}): ConfidencePick {
  const out: ConfidencePick = {
    family: p.family,
    marketId: p.marketId,
    market: p.market,
    selection: p.selection,
    prob: r4(p.prob),
    fairOdds: r3(Math.min(1000, 1 / Math.max(p.prob, 1e-9))),
    tier: p.tier,
    historicalHitRate: r4(p.historicalHitRate),
    historicalN: p.historicalN,
    threshold: r4(p.threshold),
    calibratedProb: r4(p.calibratedProb),
    source: p.segment,
  };
  if (typeof p.marketOdds === 'number' && Number.isFinite(p.marketOdds) && p.marketOdds > 1) {
    out.marketOdds = r3(p.marketOdds);
    if (p.oddsKind) out.oddsKind = p.oddsKind;
  }
  const h = holdout[p.family];
  if (h) {
    out.holdoutHitRate = h.hitRate;
    out.holdoutN = h.n;
  }
  if (result) out.result = result;
  return out;
}

/** Familia validada fuera de muestra: al menos WARN_MIN_N picks resueltos en el holdout con acierto >= 80 %. */
export function validatedOutOfSample(p: Pick<ConfidencePick, 'holdoutHitRate' | 'holdoutN'>): boolean {
  return (p.holdoutN ?? 0) >= WARN_MIN_N && (p.holdoutHitRate ?? 0) >= CONFIDENCE_MIN_HIT_RATE;
}

/**
 * Evalúa el motor y calcula los picks de los partidos próximos y los resueltos recientes (en ctx). Debe llamarse
 * después de computeWalkForward y antes de construir cualquier MatchSummary.
 */
export function prepareConfidence(ctx: BuildContext, opts: { history?: ConfidenceHistoryItem[] } = {}): ConfidenceState {
  const t0 = performance.now();
  ctx.confidencePicks = new Map();
  ctx.confidenceSettled = new Map();
  const state: ConfidenceState = { upcoming: 0, seconds: 0 };
  const hasHistory = !!opts.history?.length || ctx.allMatches.some((m) => m.currentSeason && m.status === 'finished' && !!m.score);
  if (!hasHistory) {
    state.error = 'Todavía no hay partidos terminados de la temporada actual para medir el acierto.';
    state.seconds = (performance.now() - t0) / 1000;
    return state;
  }
  try {
    state.ev = evaluateConfidence(ctx, {
      log: ctx.log,
      select: { maxPerMatch: CONFIDENCE_MAX_PER_MATCH, minHitRate: CONFIDENCE_MIN_HIT_RATE },
      ...(opts.history ? { history: opts.history } : {}),
    });
  } catch (e) {
    state.error = 'El cálculo de los pronósticos de alta confianza ha fallado en esta actualización.';
    ctx.log(`  aviso: alta confianza no disponible (${(e as Error)?.message ?? e}); se publica sin picks`);
  }
  const ev = state.ev;
  if (ev) {
    const select = { maxPerMatch: CONFIDENCE_MAX_PER_MATCH, minHitRate: CONFIDENCE_MIN_HIT_RATE };
    const hold = holdoutByFamily(ev);
    state.holdout = hold;
    let broken = 0;
    for (const id of ctx.upcomingIds) {
      const m = ctx.matchById.get(id);
      if (!m || m.status !== 'scheduled') continue;
      try {
        // orden del motor (probabilidad recalibrada), pero primero los de familias validadas fuera de muestra: el
        // primero es el que se destaca en las tarjetas (prediction.safe)
        const picks = selectConfidencePicks(upcomingCandidates(ctx, m), ev.rules, select)
          .map((p) => publicPick(p, undefined, hold))
          .sort((a, b) => Number(validatedOutOfSample(b)) - Number(validatedOutOfSample(a)));
        if (picks.length) {
          ctx.confidencePicks.set(id, picks);
          state.upcoming += picks.length;
        }
      } catch {
        broken++; // partido anómalo: sin picks (su ficha decide por su cuenta si se publica)
      }
    }
    if (broken) ctx.log(`  aviso: ${broken} partidos próximos sin candidatos de alta confianza por datos anómalos`);
    // resueltos del holdout (reglas ajustadas sin esos partidos): para las fichas de partidos terminados
    for (const sp of ev.recentSettled) {
      const list = ctx.confidenceSettled.get(sp.matchId) ?? [];
      list.push(publicPick(sp, sp.result, hold));
      ctx.confidenceSettled.set(sp.matchId, list);
    }
  }
  state.seconds = (performance.now() - t0) / 1000;
  return state;
}

// ---------------------------------------------------------------------------
// confidence.json
// ---------------------------------------------------------------------------

/** Ficha compacta para las listas de confidence.json (sin predicción, cuotas ni forma: no se usan aquí). */
export function slimSummary(s: MatchSummary): MatchSummary {
  const out: MatchSummary = {
    id: s.id,
    compId: s.compId,
    compName: s.compName,
    date: s.date,
    status: s.status,
    home: s.home,
    away: s.away,
    hasDetail: s.hasDetail,
  };
  if (s.statusDetail) out.statusDetail = s.statusDetail;
  if (s.round) out.round = s.round;
  if (s.score) out.score = s.score;
  return out;
}

function record(r: ConfidenceReport): ConfidenceRecord {
  return {
    picks: r.picks,
    n: r.n,
    hits: r.hits,
    hitRate: r.hitRate,
    wilsonLow: r.wilsonLow,
    wilsonHigh: r.wilsonHigh,
    voids: r.voids,
    from: r.from,
    to: r.to,
    matches: r.matches,
  };
}

function groupRecord(g: GroupReport): Omit<ConfidenceRecord, 'from' | 'to' | 'matches'> {
  return { picks: g.picks, n: g.n, hits: g.hits, hitRate: g.hitRate, wilsonLow: g.wilsonLow, wilsonHigh: g.wilsonHigh, voids: g.voids };
}

const pctEs = (x: number, d = 1) => `${(x * 100).toFixed(d).replace('.', ',')} %`;

/** Filas por familia: umbrales de PRODUCCIÓN y acierto FUERA DE MUESTRA (holdout, reglas de calibración). */
export function familyRows(ev: ConfidenceEvaluation): ConfidenceFamilyRow[] {
  return CONFIDENCE_FAMILIES.map((f) => {
    const prod = ev.rules.rules.filter((r) => r.family === f.id);
    const thresholds = prod
      .map((r) => {
        const t: ConfidenceFamilyRow['thresholds'][number] = { source: (r.segment ?? 'mercado') as ConfidenceSource, threshold: r4(r.threshold) };
        if (r.goldThreshold !== undefined && r.goldThreshold > r.threshold + 1e-9) t.goldThreshold = r4(r.goldThreshold);
        return t;
      })
      .sort((a, b) => (a.source === b.source ? 0 : a.source === 'mercado' ? -1 : 1));
    const h = ev.holdout.byFamily[f.id];
    const row: ConfidenceFamilyRow = {
      family: f.id,
      label: f.label,
      theme: f.theme,
      active: prod.length > 0,
      thresholds,
      picks: h?.picks ?? 0,
      n: h?.n ?? 0,
      hits: h?.hits ?? 0,
    };
    if (thresholds.length) row.threshold = Math.min(...thresholds.map((t) => t.threshold));
    if (h && h.n > 0) row.hitRate = h.hits / h.n;
    const notes: string[] = [];
    if (!row.active) {
      const excluded = ev.productionChoice.exclude.some((k) => k === f.id || k.startsWith(`${f.id}|`));
      notes.push(
        excluded
          ? 'No se publica: en la validación interna acertó menos del 78 %.'
          : 'No se publica: en el histórico no llega al 82 % de acierto con muestra suficiente.',
      );
    }
    if (h && h.n >= WARN_MIN_N && h.hitRate < CONFIDENCE_MIN_HIT_RATE) {
      notes.push(`Fuera de muestra acierta ${pctEs(h.hitRate)} (${h.hits}/${h.n}): por debajo del 80 %.`);
    } else if (h && h.n > 0 && h.n < WARN_MIN_N) {
      notes.push(`Muestra fuera de muestra pequeña (${h.n}).`);
    } else if (row.active && (!h || h.n === 0)) {
      notes.push('Solo entra en las reglas ajustadas con todo el histórico: aún sin picks fuera de muestra.');
    }
    if (notes.length) row.note = notes.join(' ');
    return row;
  });
}

/** Nota corta para la UI con las cifras reales. */
function noteFor(ev: ConfidenceEvaluation | undefined, error?: string): string {
  if (!ev) return error ?? 'Pronósticos de alta confianza no disponibles en esta actualización.';
  const h = ev.holdout;
  if (!(h.n > 0)) {
    return 'Todavía no hay partidos suficientes para medir el acierto fuera de muestra: no se publican cifras de acierto. Alto acierto no es beneficio. Juego responsable, solo mayores de 18 años.';
  }
  const parts = [
    'Alto acierto no es beneficio: son selecciones de cuota baja' + (h.n ? ` (cuota justa media ${h.avgFairOdds.toFixed(2).replace('.', ',')})` : '') + ' y las casas cobran margen.',
  ];
  if (h.roi) {
    parts.push(
      `Con cuotas de cierre solo se pueden medir ${h.roi.bets} de ${h.picks} picks del holdout (${pctEs(h.picks ? h.roi.bets / h.picks : 0, 0)}): ROI ${h.roi.roi >= 0 ? '+' : '−'}${pctEs(Math.abs(h.roi.roi))}.`,
    );
  } else parts.push('Casi ninguno de estos mercados tiene cuota publicada en la fuente: su rentabilidad no se puede medir.');
  parts.push('No garantiza nada. Juego responsable, solo mayores de 18 años.');
  return parts.join(' ');
}

export function buildConfidenceFile(ctx: BuildContext, state: ConfidenceState): ConfidenceFile {
  const ev = state.ev;
  const published = new Set(ctx.publish.map((c) => c.id));
  const byDate = (a: { match: MatchSummary; pick: ConfidencePick }, b: { match: MatchSummary; pick: ConfidencePick }) =>
    Date.parse(a.match.date) - Date.parse(b.match.date) || a.match.id.localeCompare(b.match.id) || (b.pick.calibratedProb ?? b.pick.prob) - (a.pick.calibratedProb ?? a.pick.prob);

  const picks: ConfidenceFile['picks'] = [];
  for (const [id, list] of ctx.confidencePicks ?? []) {
    const m = ctx.matchById.get(id);
    if (!m || !published.has(m.compId)) continue;
    const s = slimSummary(matchSummary(ctx, m));
    for (const pick of list) picks.push({ match: s, pick });
  }
  picks.sort(byDate);

  const recent: ConfidenceFile['recent'] = [];
  if (ev) {
    const from = ctx.now - CONFIDENCE_RECENT_DAYS * DAY_MS;
    const summaries = new Map<string, MatchSummary>();
    for (const sp of ev.recentSettled) {
      const t = Date.parse(sp.date);
      if (!(t >= from && t <= ctx.now)) continue;
      const m = ctx.matchById.get(sp.matchId);
      if (!m || !published.has(m.compId) || m.status !== 'finished') continue;
      let s = summaries.get(m.id);
      if (!s) {
        s = slimSummary(matchSummary(ctx, m));
        summaries.set(m.id, s);
      }
      recent.push({ match: s, pick: publicPick(sp, sp.result, state.holdout), hit: sp.result === 'hit' });
    }
    recent.sort((a, b) => Date.parse(b.match.date) - Date.parse(a.match.date) || a.match.id.localeCompare(b.match.id));
  }

  const empty: ConfidenceRecord = { picks: 0, n: 0, hits: 0, hitRate: 0, from: '', to: '' };
  const h = ev?.holdout;
  const track: ConfidenceFile['track'] = {
    holdout: h ? record(h) : empty,
    byTier: [],
    byFamily: ev ? familyRows(ev) : [],
    coverage: { picksPerDay: h ? r3(h.picksPerDay) : 0 },
    avgFairOdds: h ? r3(h.avgFairOdds) : 0,
  };
  if (ev && h) {
    if (ev.virgin.matches > 0) track.virgin = record(ev.virgin);
    track.calibration = { ...ev.split.calibration };
    track.byTier = (['oro', 'plata'] as ConfidenceTier[]).filter((t) => h.byTier[t]).map((tier) => ({ tier, ...groupRecord(h.byTier[tier]!) }));
    track.bySource = (['mercado', 'estadistico'] as ConfidenceSource[])
      .filter((s) => h.bySegment[s])
      .map((source) => ({ source, ...groupRecord(h.bySegment[source]!) }));
    track.coverage = {
      picksPerDay: r3(h.picksPerDay),
      picksPerMatchDay: r3(h.picksPerMatchDay),
      matches: h.matches,
      matchesWithPick: h.matchesWithPick,
    };
    if (h.n > 0) track.avgProb = h.avgProb;
    if (h.roi) {
      track.roi = { bets: h.roi.bets, roi: h.roi.roi, profit: r3(h.roi.profit), hitRate: h.roi.hitRate, avgOdds: r3(h.roi.avgOdds), synthetic: h.roi.synthetic };
    }
  }

  return {
    generatedAt: ctx.refDate,
    picks,
    recent,
    track,
    rules: {
      level: ev?.productionChoice.level ?? 0,
      targetRate: ev?.productionChoice.options.targetRate ?? 0.82,
      from: ev?.rules.from ?? '',
      to: ev?.rules.to ?? '',
      matches: ev?.rules.matches ?? 0,
      active: ev?.rules.rules.length ?? 0,
      maxPerMatch: CONFIDENCE_MAX_PER_MATCH,
      minHitRate: CONFIDENCE_MIN_HIT_RATE,
    },
    note: noteFor(ev, state.error),
  };
}

// ---------------------------------------------------------------------------
// Portada
// ---------------------------------------------------------------------------

/**
 * Mejores picks de las próximas 72 h, cronológicos: uno por partido (el de mayor probabilidad recalibrada entre los de
 * familias validadas fuera de muestra, >= 20 picks y >= 80 % en el holdout). La portada no destaca familias sin validar
 * (aparecen igualmente en confidence.json y en la ficha del partido, con su aviso).
 */
export function homeConfidence(
  ctx: BuildContext,
  state: ConfidenceState,
): { topConfidence: NonNullable<HomeFile['topConfidence']>; headline?: HomeFile['confidenceHeadline'] } {
  const published = new Set(ctx.publish.map((c) => c.id));
  const until = ctx.now + HOME_CONFIDENCE_HOURS * 3_600_000;
  const cands: { match: MatchSummary; pick: ConfidencePick; popularity: number }[] = [];
  for (const [id, list] of ctx.confidencePicks ?? []) {
    const m = ctx.matchById.get(id);
    const t = m ? Date.parse(m.date) : NaN;
    const pick = list.find(validatedOutOfSample);
    if (!m || !pick || !published.has(m.compId) || !(t > ctx.now && t <= until)) continue;
    const full = matchSummary(ctx, m);
    cands.push({ match: slimSummary(full), pick, popularity: full.popularity ?? 0 });
  }
  const top = cands
    .sort(
      (a, b) =>
        Math.round((b.pick.calibratedProb ?? b.pick.prob) * 100) - Math.round((a.pick.calibratedProb ?? a.pick.prob) * 100) ||
        b.popularity - a.popularity ||
        Date.parse(a.match.date) - Date.parse(b.match.date),
    )
    .slice(0, HOME_TOP_CONFIDENCE)
    .sort((a, b) => Date.parse(a.match.date) - Date.parse(b.match.date) || a.match.id.localeCompare(b.match.id))
    .map(({ match, pick }) => ({ match, pick }));
  const h = state.ev?.holdout;
  const headline =
    h && h.n > 0 ? { hitRate: h.hits / h.n, picks: h.n, hits: h.hits, from: h.from, to: h.to, upcoming: state.upcoming } : undefined;
  return { topConfidence: top, headline };
}
