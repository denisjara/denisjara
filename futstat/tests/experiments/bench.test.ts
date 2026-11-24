/**
 * Banco de pruebas de modelos (pipeline/experiments): la variante vacía («production», y una con TODOS los ganchos en
 * los valores de producción) da exactamente las predicciones de producción; «baseline» es la producción anterior al
 * 22-nov-2026 (mismo 1X2; sin contracción del total ni priorN 40); el combinador solo ve filas anteriores a cada
 * reajuste; la comprobación de fuga (partidos «del futuro» envenenados) aprueba a producción, a la línea base y a un
 * rasgo legítimo y detecta un gancho que mira el futuro; el holdout no se muestra sin --final.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fitDixonColes, goalMultiplier, mulberry32, sampleNegBin, samplePoisson, type DCMatch } from '../../src/lib/models';
import { MODEL, type CompetitionConfig } from '../../pipeline/config';
import type { CompetitionStore, MatchRecord } from '../../pipeline/types';
import { kMultiplierFor } from '../../pipeline/analytics/ratings';
import { predictMatch } from '../../pipeline/analytics/predict';
import { PRIOR_N } from '../../pipeline/analytics/projections';
import { productionTotalFactor } from '../../pipeline/analytics/totals';
import { computeWalkForward, createContext, refitBoundaries, wfContext } from '../../pipeline/publish/context';
import {
  bootstrapByDay,
  busiestDay,
  compare,
  leakCheck,
  matchInfos,
  runVariant,
  type EvalData,
} from '../../pipeline/experiments/bench';
import { checkVariantSource, loadVariant, validateVariant } from '../../pipeline/experiments/load';
import { BASELINE_VARIANT, PRODUCTION_VARIANT, preMatchView, type ModelVariant, type WalkForwardRow } from '../../pipeline/experiments/types';
import example from '../../pipeline/experiments/example';
import { HOLDOUT_LOG, main as evalMain } from '../../scripts/eval-model';

const DAY = 86_400_000;

const LIGA: CompetitionConfig = { id: 'liga-x', slug: 'synx.1', name: 'Liga X', shortName: 'Liga X', country: 'Sintetia', flag: '🏳️', kind: 'league', tier: 8 };
const COPA: CompetitionConfig = { id: 'copa-x', slug: 'synx.copa', name: 'Copa X', shortName: 'Copa X', country: 'Sintetia', flag: '🏳️', kind: 'cup', tier: 5 };
const CONFIGS = [LIGA, COPA];

/**
 * Liga de 12 equipos (una jornada el sábado desde 2025-01 hasta 2026-10, temporada actual desde 2026-06-01, cuotas
 * de cierre en la mitad de los partidos) y una copa entre equipos de la liga los miércoles de la temporada actual.
 * La copa va PRIMERO en los stores: el walk-forward la procesa antes que la liga (orden no cronológico entre
 * competiciones, el caso en que un estado global de una variante filtraría el futuro).
 */
function benchWorld(seed = 5): CompetitionStore[] {
  const rng = mulberry32(seed);
  const teams = Array.from({ length: 12 }, (_, i) => ({ id: `X${i}`, name: `Equipo ${i}`, short: `Eq${i}`, abbr: `E${i}`, att: 1.45 - 0.07 * i, def: 0.7 + 0.06 * i }));
  const ref = (t: (typeof teams)[number]) => ({ id: t.id, name: t.name, short: t.short, abbr: t.abbr });
  let id = 7000;
  const play = (compId: string, date: number, h: (typeof teams)[number], a: (typeof teams)[number], withOdds: boolean): MatchRecord => {
    const lh = 1.2 * h.att * a.def * 1.2;
    const la = 1.2 * a.att * h.def;
    const hg = samplePoisson(lh, rng);
    const ag = samplePoisson(la, rng);
    const m: MatchRecord = {
      id: String(id++),
      compId,
      season: new Date(date).getUTCFullYear(),
      currentSeason: date >= Date.UTC(2026, 5, 1),
      date: new Date(date).toISOString(),
      status: 'finished',
      home: ref(h),
      away: ref(a),
      score: { home: hg, away: ag },
      stats: {
        home: { goals: hg, corners: sampleNegBin(5.4, 12, rng), yellow: samplePoisson(1.9, rng) + 1, red: 0, shots: sampleNegBin(13, 20, rng), shotsOnTarget: 4 },
        away: { goals: ag, corners: sampleNegBin(4.4, 12, rng), yellow: samplePoisson(2.2, rng), red: 0, shots: sampleNegBin(11, 20, rng), shotsOnTarget: 3 },
      },
    };
    if (withOdds) {
      // cuotas con margen ~5 % alrededor de una probabilidad aproximada
      const ph = Math.min(0.8, Math.max(0.1, 0.45 + 0.25 * (lh - la)));
      const pd = 0.26;
      const pa = Math.max(0.05, 1 - ph - pd);
      m.odds = { provider: 'Sintética', home: 1 / (ph * 1.05), draw: 1 / (pd * 1.05), away: 1 / (pa * 1.05), totalLine: 2.5, over: 1.9, under: 1.9 };
    }
    return m;
  };
  const league: MatchRecord[] = [];
  const cup: MatchRecord[] = [];
  const start = Date.UTC(2025, 0, 4, 15);
  const end = Date.UTC(2026, 9, 25);
  let w = 0;
  for (let t = start; t < end; t += 7 * DAY, w++) {
    const order = teams.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let k = 0; k < 6; k++) league.push(play(LIGA.id, t + k * 3_600_000, order[2 * k], order[2 * k + 1], (w + k) % 2 === 0));
    if (t >= Date.UTC(2026, 5, 1) && w % 2 === 0) {
      for (let k = 0; k < 2; k++) cup.push(play(COPA.id, t + 4 * DAY + k * 3_600_000, order[4 * k + 1], order[4 * k + 2], false));
    }
  }
  return [
    { compId: COPA.id, slug: COPA.slug, updatedAt: '2026-11-01T00:00:00Z', matches: cup, players: [], standings: [] },
    { compId: LIGA.id, slug: LIGA.slug, updatedAt: '2026-11-01T00:00:00Z', matches: league, players: [], standings: [] },
  ];
}

const stores = benchWorld();
const data: EvalData = { stores, configs: CONFIGS, now: new Date('2026-11-01T00:00:00Z'), fingerprint: 'test' };

/** Todos los ganchos activos con los valores de producción: debe dar EXACTAMENTE producción. */
const identity: ModelVariant = {
  name: 'identidad',
  description: 'todos los ganchos con los valores de producción',
  dc: { xi: MODEL.dcXi, windowDays: MODEL.dcWindowDays, priorWeight: 2, fitGoals: (m) => ({ hg: m.score!.home, ag: m.score!.away }), weight: () => 1 },
  elo: { k: MODEL.eloK, homeAdv: MODEL.eloHomeAdv, tierOffset: MODEL.eloTierOffset, kMultiplier: (_m, c) => kMultiplierFor(c?.kind), goalMultiplier },
  eloProbs: { homeAdv: MODEL.eloProbHomeAdv },
  features: (_c, m, before) => ({ prev: before.teamMatches(m.home.id).length }),
  lambdaAdjust: ({ lambdaHome, lambdaAway }) => ({ lambdaHome, lambdaAway }),
  combine: { prepare: () => {}, blend: (r) => r.production },
  // el factor de producción del total, reproducido con lo que recibe el gancho
  totals: {
    adjustTotal: ({ ctx, match, lambdaHome, lambdaAway }) =>
      productionTotalFactor({ hasMarketTotal: ctx.market?.over25 !== undefined, kind: ctx.comp.kind, compId: match.compId, before: ctx.history, lambdaHome, lambdaAway }),
  },
  stats: { priorN: PRIOR_N, halfLifeDays: 150, dispersion: 'pooled', leaguePriorN: 20 },
};

describe('variante vacía = producción', () => {
  const prod = createContext({ stores, configs: CONFIGS, now: data.now });
  computeWalkForward(prod);
  const base = runVariant(PRODUCTION_VARIANT, data);

  it('el walk-forward del banco (variante vacía) es el del build', () => {
    expect(prod.wf.size).toBeGreaterThan(120);
    expect(base.rows.size).toBe(prod.wf.size);
    for (const [id, wf] of prod.wf) {
      const r = base.rows.get(id)!;
      expect(r.p).toEqual([wf.p.home, wf.p.draw, wf.p.away]);
      expect([r.over25, r.btts, r.lh, r.la]).toEqual([wf.over25, wf.btts, wf.lambdaHome, wf.lambdaAway]);
    }
  });

  it('una variante con TODOS los ganchos en los valores de producción da exactamente las mismas predicciones', () => {
    const run = runVariant(identity, data);
    expect(run.rows.size).toBe(base.rows.size);
    for (const [id, b] of base.rows) expect(run.rows.get(id)).toEqual(b);
  });

  it('predictMatch con la variante vacía en el contexto es idéntico a producción', () => {
    const withVariant = createContext({ stores, configs: CONFIGS, now: data.now, variant: { name: 'vacia', description: 'sin ganchos' } });
    computeWalkForward(withVariant);
    const m = prod.allMatches.filter((x) => x.currentSeason && x.status === 'finished')[40];
    expect(predictMatch(m, wfContext(withVariant, m))).toEqual(predictMatch(m, wfContext(prod, m)));
  });

  it('compare() de la base consigo misma: diferencias e intervalos nulos', () => {
    const infos = matchInfos(base.ctx!);
    const r = compare(base, base, infos, 'tuning', data);
    expect(r.n).toBeGreaterThan(100);
    expect(r.model).toEqual(r.baseline);
    expect([r.ci.rps.diff, r.ci.rps.lo, r.ci.rps.hi]).toEqual([0, 0, 0]);
    const t1 = compare(base, base, infos, 'T1', data);
    const t2 = compare(base, base, infos, 'T2', data);
    expect(t1.n + t2.n).toBe(r.n);
  });

  it('baseline = producción anterior: mismo 1X2; total contraído solo sin línea de goles y fuera de copas; córners distintos', () => {
    const legacy = runVariant(BASELINE_VARIANT, data, { reuse: base });
    const byId = new Map(prod.allMatches.map((m) => [m.id, m]));
    let shrunk = 0;
    let corners = 0;
    for (const [id, p] of base.rows) {
      const l = legacy.rows.get(id)!;
      const m = byId.get(id)!;
      for (let k = 0; k < 3; k++) expect(p.p[k]).toBeCloseTo(l.p[k], 12);
      expect(p.ep).toEqual(l.ep);
      if (m.odds?.totalLine !== undefined || m.compId === COPA.id) {
        expect([p.lh, p.la, p.over25]).toEqual([l.lh, l.la, l.over25]);
      } else if (Math.abs(p.lh + p.la - (l.lh + l.la)) > 1e-6) shrunk++;
      if (p.corners && l.corners && Math.abs(p.corners.exp - l.corners.exp) > 1e-6) corners++;
    }
    expect(shrunk).toBeGreaterThan(50);
    expect(corners).toBeGreaterThan(50);
  });
});

describe('ganchos', () => {
  it('lambdaAdjust y adjustTotal cambian las predicciones en el sentido esperado', () => {
    const base = runVariant(BASELINE_VARIANT, data);
    const more: ModelVariant = { name: 'mas-goles', description: '+20 % de goles', totals: { adjustTotal: () => 1.2 } };
    const run = runVariant(more, data, { reuse: base });
    let higher = 0;
    for (const [id, b] of base.rows) if (run.rows.get(id)!.over25 > b.over25) higher++;
    expect(higher).toBe(base.rows.size);
  });

  it('el combinador solo recibe filas estrictamente anteriores a cada reajuste y su ensamble es el publicado', () => {
    const calls: { asOf: string; n: number; maxDate: number }[] = [];
    const learned: ModelVariant = {
      name: 'combinador',
      description: 'media de las fuentes con el empate observado',
      combine: {
        prepare(rows: readonly WalkForwardRow[], asOf: string) {
          calls.push({ asOf, n: rows.length, maxDate: rows.reduce((t, r) => Math.max(t, Date.parse(r.date)), 0) });
        },
        blend: (r) => ({ home: (r.elo.home + r.goal.home) / 2, draw: (r.elo.draw + r.goal.draw) / 2, away: (r.elo.away + r.goal.away) / 2 }),
      },
    };
    const ctx = createContext({ stores, configs: CONFIGS, now: data.now, variant: learned });
    computeWalkForward(ctx);
    expect(calls.length).toBeGreaterThanOrEqual(6); // junio..octubre + final
    for (const c of calls) expect(c.maxDate).toBeLessThan(Date.parse(c.asOf));
    expect(calls[0].n).toBe(0);
    expect(calls[calls.length - 1].asOf).toBe(data.now.toISOString());
    // la ficha de un partido terminado usa el ensamble del walk-forward (no el del reajuste final)
    const m = ctx.allMatches.filter((x) => x.currentSeason && x.status === 'finished')[10];
    const wf = ctx.wf.get(m.id)!;
    expect(predictMatch(m, wfContext(ctx, m)).quick.p.home).toBeCloseTo(wf.p.home, 4);
  });

  it('refitBoundaries: día 1 de cada mes o cada N días', () => {
    const b = refitBoundaries(Date.parse('2026-06-03T10:00:00Z'), Date.parse('2026-08-02T00:00:00Z'));
    expect(b.map((t) => new Date(t).toISOString().slice(0, 10))).toEqual(['2026-06-01', '2026-07-01', '2026-08-01']);
    expect(refitBoundaries(0, 20 * DAY, 7)).toEqual([0, 7 * DAY, 14 * DAY]);
  });

  it('preMatchView quita el resultado, las estadísticas, los eventos y la forma', () => {
    const m = stores[1].matches.at(-1)!;
    const p = preMatchView({ ...m, homeForm: 'WWW', events: [] });
    expect(p.status).toBe('scheduled');
    for (const k of ['score', 'stats', 'events', 'homeForm', 'awayForm']) expect(k in p).toBe(false);
    expect(p.odds).toEqual(m.odds);
  });

  it('Dixon-Coles con goles ajustados (no enteros) y marcador real para τ', () => {
    const ms: DCMatch[] = stores[1].matches.slice(0, 300).map((m) => ({ home: m.home.id, away: m.away.id, hg: m.score!.home, ag: m.score!.away, date: m.date }));
    const ref = '2025-12-01T00:00:00Z';
    const a = fitDixonColes(ms, { refDate: ref, xi: 0.002 });
    const same = fitDixonColes(ms.map((m) => ({ ...m, rawHg: m.hg, rawAg: m.ag })), { refDate: ref, xi: 0.002 });
    expect(same).toEqual(a);
    const adj = fitDixonColes(ms.map((m) => ({ ...m, hg: 0.5 * m.hg + 0.6, ag: 0.5 * m.ag + 0.5, rawHg: m.hg, rawAg: m.ag })), { refDate: ref, xi: 0.002 });
    expect(adj.nMatches).toBe(300);
    expect(Number.isFinite(adj.base) && Number.isFinite(adj.rho)).toBe(true);
    // sin marcador real, los goles no enteros se siguen descartando (comportamiento original)
    expect(fitDixonColes(ms.map((m) => ({ ...m, hg: m.hg + 0.5 })), { refDate: ref, xi: 0.002 }).nMatches).toBe(0);
  });
});

describe('comprobación de fuga (partidos «del futuro» envenenados)', () => {
  const base = runVariant(PRODUCTION_VARIANT, data);
  const infos = matchInfos(base.ctx!);
  const days = (['T1', 'T2'] as const).map((w) => busiestDay(infos, w, base.rows)!);

  it('producción (y la producción anterior) no miran el futuro', () => {
    const r = leakCheck(PRODUCTION_VARIANT, data, base, days);
    expect(r.days.length).toBe(2);
    expect(r.days.every((d) => d.matches > 0)).toBe(true);
    expect(r.ok).toBe(true);
    const legacy = runVariant(BASELINE_VARIANT, data);
    expect(leakCheck(BASELINE_VARIANT, data, legacy, days).ok).toBe(true);
  });

  it('un rasgo legítimo (días de descanso con la vista del pasado) tampoco', () => {
    const run = runVariant(example, data, { reuse: base });
    expect(leakCheck(example, data, run, days).ok).toBe(true);
  });

  it('un gancho que acumula estado global (y así ve partidos posteriores) se detecta', () => {
    const seen = new Map<string, MatchRecord>();
    const leaky: ModelVariant = {
      name: 'tramposa',
      description: 'recuerda el último partido visto de cada equipo en CUALQUIER llamada',
      features(_c, match, before) {
        for (const id of [match.home.id, match.away.id]) {
          const ms = before.teamMatches(id);
          const last = ms[ms.length - 1];
          const prev = seen.get(id);
          if (last && (!prev || Date.parse(last.date) > Date.parse(prev.date))) seen.set(id, last);
        }
        const gd = (id: string) => {
          const m = seen.get(id);
          return m ? (m.home.id === id ? m.score!.home - m.score!.away : m.score!.away - m.score!.home) : 0;
        };
        return { gdHome: gd(match.home.id), gdAway: gd(match.away.id) };
      },
      lambdaAdjust: ({ lambdaHome, lambdaAway, features }) => ({ lambdaHome: lambdaHome * (1 + 0.02 * features.gdHome), lambdaAway: lambdaAway * (1 + 0.02 * features.gdAway) }),
    };
    const run = runVariant(leaky, data, { reuse: base });
    seen.clear();
    const r = leakCheck(leaky, data, run, days);
    expect(r.ok).toBe(false);
    expect(r.days.some((d) => d.maxDiff > 1e-6)).toBe(true);
  });

  it('una variante que lee el data-store o el disco por su cuenta se rechaza al cargarla', () => {
    expect(() => checkVariantSource("import { loadAllStores } from '../store';\nexport default {}", 'x.ts')).toThrow(/data-store/);
    expect(() => checkVariantSource("import fs from 'node:fs';", 'x.ts')).toThrow(/fs/);
    expect(() => checkVariantSource('// leer data-store está prohibido\nexport default {}', 'x.ts')).not.toThrow();
  });
});

describe('carga de variantes y protección del holdout', () => {
  it('carga baseline, production y example; valida la forma', async () => {
    expect((await loadVariant('baseline')).name).toBe('baseline');
    expect(await loadVariant('production')).toBe(PRODUCTION_VARIANT);
    expect((await loadVariant('example')).name).toBe('example');
    await expect(loadVariant('../store')).rejects.toThrow(/no válido/);
    await expect(loadVariant('no-existe-xyz')).rejects.toThrow(/No existe/);
    expect(() => validateVariant({ name: 'a', description: 'b', combine: {} }, 't')).toThrow(/blend/);
    expect(() => validateVariant({ name: 'a', description: 'b', stats: { dispersion: 'rara' } }, 't')).toThrow(/dispersion/);
    expect(() => validateVariant({ name: 'a', description: 'b', eloProbs: { homeAdv: { 'XX-league': 50 } } }, 't')).toThrow(/grupo/);
    expect(validateVariant({ name: 'a', description: 'b', eloProbs: { homeAdv: { 'EU-league': 50 } } }, 't').name).toBe('a');
  });

  it('sin --final el holdout se niega y no se registra ninguna mirada', async () => {
    const before = fs.existsSync(HOLDOUT_LOG) ? fs.readFileSync(HOLDOUT_LOG, 'utf8') : undefined;
    expect(await evalMain(['--variant=baseline', '--window=holdout'])).toBe(1);
    expect(await evalMain(['--variant=baseline', '--final', '--window=tuning'])).toBe(1);
    const after = fs.existsSync(HOLDOUT_LOG) ? fs.readFileSync(HOLDOUT_LOG, 'utf8') : undefined;
    expect(after).toBe(before);
  });

  it('bootstrap por día: determinista y con el intervalo alrededor de la media', () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ day: `d${i % 30}`, diff: ((i * 7919) % 13) / 100 - 0.05 }));
    const a = bootstrapByDay(items);
    expect(bootstrapByDay(items)).toEqual(a);
    expect(a.lo).toBeLessThanOrEqual(a.diff);
    expect(a.hi).toBeGreaterThanOrEqual(a.diff);
    expect(a.days).toBe(30);
  });
});
