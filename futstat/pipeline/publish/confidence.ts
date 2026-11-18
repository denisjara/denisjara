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
 * Desde la revisión del 18 nov 2026: solo se publica el nivel oro (franja >= 85 % en el histórico de su regla), solo
 * reglas validadas fuera de muestra en el walk-forward mensual (>= 30 picks y >= 80 %), sin «más de 2,5 tarjetas», y
 * cada acierto va con su n y su intervalo de Wilson, la línea base sin modelo, la tasa base de la familia y el lift.
 *
 * Si el motor falla, el build NO se rechaza: se publica confidence.json vacío con una nota (degradar, no rechazar).
 */
import type {
  ConfidenceBaseline,
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
  FAMILY_BY_ID,
  FIXED_BASELINE_LABEL,
  GOLD_MIN_RATE,
  VALIDATION_MIN_N,
  VALIDATION_MIN_RATE,
  evaluateConfidence,
  ruleKey,
  selectConfidencePicks,
  upcomingCandidates,
  type ConfidenceEvaluation,
  type ConfidenceHistoryItem,
  type ConfidencePick as EnginePick,
  type ConfidenceFamily,
  type ConfidenceReport,
  type GroupReport,
  type HitStats,
  type SettledPick,
} from '../analytics/confidence';
import type { BuildContext } from './context';
import { matchSummary } from './matches';
import { DAY_MS } from './util';

/** Picks como mucho por partido (de temas distintos) y acierto histórico mínimo de la franja: solo nivel oro (motor). */
export const CONFIDENCE_MAX_PER_MATCH = 2;
export const CONFIDENCE_MIN_HIT_RATE = GOLD_MIN_RATE;
/** Días de picks resueltos recientes publicados. */
export const CONFIDENCE_RECENT_DAYS = 14;
/** Portada: picks de las próximas N horas, como mucho M (uno por partido). */
export const HOME_CONFIDENCE_HOURS = 72;
export const HOME_TOP_CONFIDENCE = 8;
/** Por debajo de esta muestra no se publica un acierto propio (la UI dice «muestra pequeña»). */
export const OWN_RATE_MIN_N = 50;

export interface ConfidenceState {
  /** evaluación del motor (undefined si falló o no hay historial) */
  ev?: ConfidenceEvaluation;
  /** motivo por el que no hay evaluación */
  error?: string;
  /** picks publicados de los partidos próximos */
  upcoming: number;
  /** acierto fuera de muestra por familia (holdout) y por regla (walk-forward) */
  holdout?: HoldoutByFamily;
  validation?: ValidationByRule;
  seconds: number;
}

// probabilidades y cuotas redondeadas; los aciertos (hits / n) se publican sin redondear aquí (el escritor JSON los deja
// en 5 decimales) para que «79,9 %» no se convierta en «79,8 %» por redondear dos veces
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

type OosRecord = { hitRate: number; n: number; wilsonLow: number; wilsonHigh: number };
/** Acierto FUERA DE MUESTRA (holdout) de cada familia y su tasa base: se adjunta a cada pick. */
export type HoldoutByFamily = Partial<Record<string, OosRecord & { baseRate?: number }>>;
/** Validación fuera de muestra (walk-forward) de cada regla familia|fuente. */
export type ValidationByRule = Partial<Record<string, OosRecord>>;

const oos = (g: HitStats): OosRecord => ({ hitRate: g.hitRate, n: g.n, wilsonLow: r4(g.wilsonLow), wilsonHigh: r4(g.wilsonHigh) });

export function holdoutByFamily(ev: ConfidenceEvaluation | undefined): HoldoutByFamily {
  const out: HoldoutByFamily = {};
  for (const f of ev?.byFamily ?? []) {
    const g = f.holdout;
    const b = f.holdoutBase;
    const rec: (OosRecord & { baseRate?: number }) | undefined = g && g.n > 0 ? oos(g) : undefined;
    if (rec && b && b.n > 0) rec.baseRate = b.hitRate;
    if (rec) out[f.family] = rec;
    else if (b && b.n > 0) out[f.family] = { hitRate: 0, n: 0, wilsonLow: 0, wilsonHigh: 1, baseRate: b.hitRate };
  }
  return out;
}

export function validationByRule(ev: ConfidenceEvaluation | undefined): ValidationByRule {
  const out: ValidationByRule = {};
  for (const v of ev?.validation ?? []) if (v.n > 0) out[v.key] = oos(v);
  return out;
}

/** Pick del motor → pick del contrato. */
export function publicPick(
  p: EnginePick,
  result?: SettledPick['result'],
  holdout: HoldoutByFamily = {},
  validation: ValidationByRule = {},
): ConfidencePick {
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
  const v = validation[ruleKey(p.family, p.segment)];
  if (v) {
    out.validationHitRate = v.hitRate;
    out.validationN = v.n;
    out.validationWilsonLow = v.wilsonLow;
    out.validationWilsonHigh = v.wilsonHigh;
  }
  const h = holdout[p.family];
  if (h && h.n > 0) {
    out.holdoutHitRate = h.hitRate;
    out.holdoutN = h.n;
    out.holdoutWilsonLow = h.wilsonLow;
    out.holdoutWilsonHigh = h.wilsonHigh;
  }
  if (h?.baseRate !== undefined) out.baseRate = h.baseRate;
  if (result) out.result = result;
  return out;
}

/** Regla con acierto propio publicable: validación walk-forward con >= OWN_RATE_MIN_N picks y >= 80 %. */
export function validatedOutOfSample(p: Pick<ConfidencePick, 'validationHitRate' | 'validationN'>): boolean {
  return (p.validationN ?? 0) >= OWN_RATE_MIN_N && (p.validationHitRate ?? 0) >= VALIDATION_MIN_RATE;
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
    const val = validationByRule(ev);
    state.holdout = hold;
    state.validation = val;
    let broken = 0;
    for (const id of ctx.upcomingIds) {
      const m = ctx.matchById.get(id);
      if (!m || m.status !== 'scheduled') continue;
      try {
        // orden del motor (probabilidad recalibrada), pero primero los de reglas con validación amplia (n >= 50): el
        // primero es el que se destaca en las tarjetas (prediction.safe)
        const picks = selectConfidencePicks(upcomingCandidates(ctx, m), ev.rules, select)
          .map((p) => publicPick(p, undefined, hold, val))
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
    // resueltos del walk-forward (reglas ajustadas sin esos partidos): para las fichas de partidos terminados
    for (const sp of ev.recentSettled) {
      const list = ctx.confidenceSettled.get(sp.matchId) ?? [];
      list.push(publicPick(sp, sp.result, hold, val));
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
const ppEs = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1).replace('.', ',')} pp`;

/**
 * Filas por familia: reglas PUBLICADAS en producción (validadas en el walk-forward), reglas no publicadas, acierto
 * FUERA DE MUESTRA (holdout, reglas de calibración) con Wilson, tasa base, lift y cuota justa media.
 */
export function familyRows(ev: ConfidenceEvaluation): ConfidenceFamilyRow[] {
  const valByKey = new Map(ev.validation.map((v) => [v.key, v]));
  const excluded = new Map(ev.excluded.map((e) => [e.key, e.reason]));
  return CONFIDENCE_FAMILIES.map((f) => {
    const prod = ev.rules.rules.filter((r) => r.family === f.id);
    const thresholds = prod
      .map((r) => {
        const t: ConfidenceFamilyRow['thresholds'][number] = { source: (r.segment ?? 'mercado') as ConfidenceSource, threshold: r4(r.threshold) };
        if (r.goldThreshold !== undefined && r.goldThreshold > r.threshold + 1e-9) t.goldThreshold = r4(r.goldThreshold);
        const v = valByKey.get(ruleKey(r.family, r.segment));
        if (v) {
          t.validationN = v.n;
          t.validationHits = v.hits;
          t.validationHitRate = v.hitRate;
        }
        return t;
      })
      .sort((a, b) => (a.source === b.source ? 0 : a.source === 'mercado' ? -1 : 1));
    const unpublished = ev.unvalidated
      .filter((u) => u.family === f.id)
      .map((u) => {
        const x: NonNullable<ConfidenceFamilyRow['unpublished']>[number] = { source: (u.segment ?? 'mercado') as ConfidenceSource, n: u.n, hits: u.hits };
        if (u.n > 0) x.hitRate = u.hitRate;
        return x;
      });
    const h = ev.holdout.byFamily[f.id];
    const fam = ev.byFamily.find((x) => x.family === f.id);
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
    if (unpublished.length) row.unpublished = unpublished;
    const exReason = excluded.get(f.id);
    if (exReason) row.excluded = exReason;
    if (thresholds.length) row.threshold = Math.min(...thresholds.map((t) => t.threshold));
    if (h && h.n > 0) {
      row.hitRate = h.hits / h.n;
      row.wilsonLow = r4(h.wilsonLow);
      row.wilsonHigh = r4(h.wilsonHigh);
      row.avgFairOdds = r3(h.avgFairOdds);
    }
    const base = fam?.holdoutBase;
    if (base && base.n > 0) {
      row.baseRate = base.hitRate;
      row.baseN = base.n;
      if (row.hitRate !== undefined) row.lift = row.hitRate - base.hitRate;
    }
    const w = fam?.walkForward;
    if (w && w.n > 0) row.walkForward = { n: w.n, hits: w.hits, hitRate: w.hitRate, wilsonLow: r4(w.wilsonLow), wilsonHigh: r4(w.wilsonHigh) };
    const notes: string[] = [];
    if (exReason) notes.push('Excluida de antemano: falló fuera de muestra en el walk-forward (74,4 %).');
    else if (!row.active) {
      if (unpublished.length) {
        const u = unpublished.map((x) => `${x.n ? `${x.hits}/${x.n}` : 'sin picks'}${unpublished.length > 1 ? ` ${x.source === 'mercado' ? 'con cuotas' : 'sin cuotas'}` : ''}`).join(', ');
        notes.push(`No se publica: sin validación fuera de muestra suficiente (${u}; se exigen ${VALIDATION_MIN_N} picks y ${pctEs(VALIDATION_MIN_RATE, 0)}).`);
      } else {
        const dropped = ev.productionChoice.exclude.some((k) => k === f.id || k.startsWith(`${f.id}|`));
        notes.push(dropped ? 'No se publica: en la validación interna acertó menos del 78 %.' : 'No se publica: en el histórico no llega al 82 % de acierto con muestra suficiente.');
      }
    } else if (unpublished.length) {
      notes.push(`${unpublished.map((x) => (x.source === 'mercado' ? 'Con cuotas' : 'Sin cuotas')).join(' y ')}: sin validar fuera de muestra, no se publica.`);
    }
    if (row.active && !(h && h.n > 0)) notes.push('Sin picks en el holdout: su validación fuera de muestra se completó después del corte.');
    if (h && h.n > 0 && h.n < OWN_RATE_MIN_N) notes.push(`Holdout con muestra pequeña (${h.n}).`);
    if (notes.length) row.note = notes.join(' ');
    return row;
  });
}

function baselineOf(r: ConfidenceReport): ConfidenceBaseline {
  const b = r.fixedBaseline;
  return { label: FIXED_BASELINE_LABEL, picks: b.picks, n: b.n, hits: b.hits, hitRate: b.hitRate, wilsonLow: r4(b.wilsonLow), wilsonHigh: r4(b.wilsonHigh), matches: b.matches };
}

/** Nota corta para la UI con las cifras reales. */
function noteFor(ev: ConfidenceEvaluation | undefined, error?: string): string {
  if (!ev) return error ?? 'Pronósticos de alta confianza no disponibles en esta actualización.';
  const h = ev.holdout;
  if (!(h.n > 0)) {
    return 'Todavía no hay partidos suficientes para medir el acierto fuera de muestra: no se publican cifras de acierto. Alto acierto no es beneficio. Juego responsable, solo mayores de 18 años.';
  }
  const b = h.fixedBaseline;
  const parts = [
    `Son selecciones muy probables con cuota baja (cuota justa media ${h.avgFairOdds.toFixed(2).replace('.', ',')}), no una ventaja frente a la casa: ${
      b.n ? `una estrategia fija sin modelo acierta ${pctEs(b.hitRate)} en los mismos partidos` : 'el acierto alto es sobre todo estructural'
    }${h.lift !== undefined ? ` y, frente a la tasa base de sus familias, el lift es de ${ppEs(h.lift)}` : ''}.`,
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
      recent.push({ match: s, pick: publicPick(sp, sp.result, state.holdout, state.validation), hit: sp.result === 'hit' });
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
    if (h.fixedBaseline.n > 0) track.baseline = baselineOf(h);
    if (h.expectedBaseRate !== undefined) track.expectedBaseRate = h.expectedBaseRate;
    if (h.lift !== undefined) track.lift = h.lift;
    const wf = ev.walkForward;
    if (wf.n > 0) {
      track.walkForward = {
        ...record(wf),
        folds: wf.folds.map((f) => ({ start: f.start, end: f.end, matches: f.matches, picks: f.published.picks, n: f.published.n, hits: f.published.hits, hitRate: f.published.hitRate })),
      };
      if (wf.roi) {
        track.walkForward.roi = { bets: wf.roi.bets, roi: wf.roi.roi, profit: r3(wf.roi.profit), hitRate: wf.roi.hitRate, avgOdds: r3(wf.roi.avgOdds), synthetic: wf.roi.synthetic };
      }
    }
    if (ev.excluded.length) {
      track.excluded = ev.excluded.map((e) => ({ family: e.key, label: FAMILY_BY_ID.get(e.key.split('|')[0] as ConfidenceFamily)?.label ?? e.key, reason: e.reason }));
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
      unvalidated: ev?.unvalidated.length ?? 0,
      validation: { minN: VALIDATION_MIN_N, minRate: VALIDATION_MIN_RATE },
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
 * reglas con validación amplia: >= 50 picks y >= 80 % en el walk-forward). Los de validación justa (30–49 picks)
 * aparecen igualmente en confidence.json y en la ficha del partido, con «muestra pequeña».
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
  let headline: HomeFile['confidenceHeadline'];
  if (h && h.n > 0) {
    headline = { hitRate: h.hits / h.n, picks: h.n, hits: h.hits, wilsonLow: r4(h.wilsonLow), wilsonHigh: r4(h.wilsonHigh), from: h.from, to: h.to, upcoming: state.upcoming };
    if (h.fixedBaseline.n > 0) headline.baselineRate = h.fixedBaseline.hitRate;
    if (h.avgFairOdds > 0) headline.avgFairOdds = r3(h.avgFairOdds);
  }
  return { topConfidence: top, headline };
}
