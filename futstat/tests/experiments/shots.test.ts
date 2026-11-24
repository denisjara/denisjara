/**
 * Variantes «shots» (pipeline/experiments/shots/xg.ts): goles ajustados con xG aproximado por tiros para el ajuste
 * Dixon-Coles. Comprueba la fórmula, que w = 1 es exactamente producción, que el reescalado por liga solo usa partidos
 * anteriores al corte y que las variantes pasan la comprobación de fuga del banco y se cargan con el cargador oficial.
 */
import { describe, expect, it } from 'vitest';
import { Elo, mulberry32, sampleNegBin, samplePoisson } from '../../src/lib/models';
import type { CompetitionConfig } from '../../pipeline/config';
import type { CompetitionStore, MatchRecord } from '../../pipeline/types';
import { busiestDay, leakCheck, matchInfos, runVariant, type EvalData } from '../../pipeline/experiments/bench';
import { historyView } from '../../pipeline/experiments/history';
import { listVariants, loadVariant } from '../../pipeline/experiments/load';
import { PRODUCTION_VARIANT } from '../../pipeline/experiments/types';
import {
  K_BY_R,
  PEN_XG,
  adjustedGoals,
  leagueScale,
  makeShotsVariant,
  paramsFor,
  teamFinishing,
  xgProxy,
} from '../../pipeline/experiments/shots/xg';

const DAY = 86_400_000;
const LIGA: CompetitionConfig = { id: 'liga-s', slug: 'syns.1', name: 'Liga S', shortName: 'Liga S', country: 'Sintetia', flag: '🏳️', kind: 'league', tier: 6 };
const COPA: CompetitionConfig = { id: 'copa-s', slug: 'syns.copa', name: 'Copa S', shortName: 'Copa S', country: 'Sintetia', flag: '🏳️', kind: 'cup', tier: 4 };
const CONFIGS = [LIGA, COPA];

/** Liga de 10 equipos con tiros coherentes con la fuerza (2025-01 → 2026-10), copa los miércoles desde 2026-06. */
function shotsWorld(seed = 11): CompetitionStore[] {
  const rng = mulberry32(seed);
  const teams = Array.from({ length: 10 }, (_, i) => ({ id: `S${i}`, name: `Equipo ${i}`, short: `S${i}`, abbr: `S${i}`, att: 1.5 - 0.09 * i, def: 0.7 + 0.07 * i }));
  const ref = (t: (typeof teams)[number]) => ({ id: t.id, name: t.name, short: t.short, abbr: t.abbr });
  let id = 9000;
  const side = (lambda: number) => {
    const shots = sampleNegBin(9 * lambda, 25, rng);
    let sot = 0;
    for (let k = 0; k < shots; k++) if (rng() < 0.36) sot++;
    const goals = Math.min(sot, samplePoisson(lambda, rng));
    return { shots, sot, goals };
  };
  const play = (compId: string, date: number, h: (typeof teams)[number], a: (typeof teams)[number], withOdds: boolean): MatchRecord => {
    const sh = side(1.25 * h.att * a.def * 1.15);
    const sa = side(1.25 * a.att * h.def);
    const m: MatchRecord = {
      id: String(id++),
      compId,
      season: new Date(date).getUTCFullYear(),
      currentSeason: date >= Date.UTC(2026, 5, 1),
      date: new Date(date).toISOString(),
      status: 'finished',
      home: ref(h),
      away: ref(a),
      score: { home: sh.goals, away: sa.goals },
      // ~10 % de partidos sin estadísticas (se usan los goles)
      ...(rng() < 0.1
        ? {}
        : {
            stats: {
              home: { goals: sh.goals, shots: sh.shots, shotsOnTarget: sh.sot, corners: sampleNegBin(5, 12, rng), yellow: samplePoisson(2, rng) + 1, red: 0 },
              away: { goals: sa.goals, shots: sa.shots, shotsOnTarget: sa.sot, corners: sampleNegBin(4.4, 12, rng), yellow: samplePoisson(2.2, rng) + 1, red: 0 },
            },
          }),
    };
    if (withOdds) m.odds = { provider: 'Sintética', home: 2.2, draw: 3.4, away: 3.6, totalLine: 2.5, over: 1.95, under: 1.9 };
    return m;
  };
  const league: MatchRecord[] = [];
  const cup: MatchRecord[] = [];
  let w = 0;
  for (let t = Date.UTC(2025, 0, 4, 15); t < Date.UTC(2026, 9, 25); t += 7 * DAY, w++) {
    const order = teams.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let k = 0; k < 5; k++) league.push(play(LIGA.id, t + k * 3_600_000, order[2 * k], order[2 * k + 1], (w + k) % 3 !== 0));
    if (t >= Date.UTC(2026, 5, 1) && w % 2 === 0) cup.push(play(COPA.id, t + 4 * DAY, order[1], order[2], false));
  }
  return [
    { compId: COPA.id, slug: COPA.slug, updatedAt: '2026-11-01T00:00:00Z', matches: cup, players: [], standings: [] },
    { compId: LIGA.id, slug: LIGA.slug, updatedAt: '2026-11-01T00:00:00Z', matches: league, players: [], standings: [] },
  ];
}

const stores = shotsWorld();
const data: EvalData = { stores, configs: CONFIGS, now: new Date('2026-11-01T00:00:00Z'), fingerprint: 'test-shots' };

function match(hg: number, ag: number, stats?: [number, number, number, number], date = '2026-03-01T15:00:00Z'): MatchRecord {
  return {
    id: `m-${date}-${hg}-${ag}`,
    compId: LIGA.id,
    season: 2026,
    currentSeason: true,
    date,
    status: 'finished',
    home: { id: 'A', name: 'A', short: 'A', abbr: 'A' },
    away: { id: 'B', name: 'B', short: 'B', abbr: 'B' },
    score: { home: hg, away: ag },
    ...(stats ? { stats: { home: { goals: hg, shots: stats[0], shotsOnTarget: stats[1] }, away: { goals: ag, shots: stats[2], shotsOnTarget: stats[3] } } } : {}),
  };
}

describe('xG por tiros y goles ajustados', () => {
  const o = { name: 'x', description: 'x', w: 0.5 };
  const p = paramsFor(o, LIGA.id);

  it('xG = k·(a puerta + r·fuera) con las constantes de 2025', () => {
    expect(p).toEqual({ w: 0.5, r: 0.2, k: K_BY_R['0.2'], pen: false });
    expect(xgProxy({ goals: 0, shots: 14, shotsOnTarget: 5 }, p)).toBeCloseTo(K_BY_R['0.2'] * (5 + 0.2 * 9), 12);
    // penaltis marcados a PEN_XG en modo pen
    const pp = paramsFor({ ...o, pen: true }, LIGA.id);
    expect(xgProxy({ goals: 1, shots: 10, shotsOnTarget: 4 }, pp, 1)).toBeCloseTo(pp.k * (3 + 0.2 * 6) + PEN_XG, 12);
  });

  it('mezcla w·goles + (1 − w)·xG; sin tiros válidos o con w = 1, los goles reales', () => {
    const m = match(3, 0, [10, 4, 12, 5]);
    const g = adjustedGoals(m, p);
    expect(g.hg).toBeCloseTo(0.5 * 3 + 0.5 * p.k * (4 + 0.2 * 6), 12);
    expect(g.ag).toBeCloseTo(0.5 * 0 + 0.5 * p.k * (5 + 0.2 * 7), 12);
    expect(adjustedGoals(m, { ...p, w: 1 })).toEqual({ hg: 3, ag: 0 });
    expect(adjustedGoals(match(2, 1), p)).toEqual({ hg: 2, ag: 1 });
    // a puerta > totales: dato incoherente ⇒ goles
    expect(adjustedGoals(match(2, 1, [3, 5, 8, 2]), p)).toEqual({ hg: 2, ag: 1 });
  });

  it('el reescalado por liga solo ve partidos anteriores al corte', () => {
    const past = [match(1, 0, [10, 3, 9, 2], '2026-02-01T15:00:00Z'), match(0, 0, [12, 4, 11, 3], '2026-02-08T15:00:00Z')];
    const future = [match(9, 9, [1, 0, 1, 0], '2026-03-10T15:00:00Z')];
    const src = (ms: MatchRecord[]) => ({ matchesByTeam: new Map([['A', ms], ['B', ms]]), matchesByComp: new Map([[LIGA.id, ms]]), elo: new Elo({ k: 20, homeAdv: 65, init: 1500 }) });
    const cutoff = Date.parse('2026-03-01T15:00:00Z');
    const a = leagueScale(historyView(src(past), cutoff), LIGA.id, o);
    const b = leagueScale(historyView(src([...past, ...future]), cutoff), LIGA.id, o);
    expect(b).toEqual(a);
    // pooled = Σ ω·goles / Σ ω·ajustados
    const xi = 0.0019;
    const wts = past.map((m) => Math.exp((-xi * (cutoff - Date.parse(m.date))) / DAY));
    const g = past.reduce((s, m, i) => s + wts[i] * (m.score!.home + m.score!.away), 0);
    const x = past.reduce((s, m, i) => s + wts[i] * (adjustedGoals(m, p).hg + adjustedGoals(m, p).ag), 0);
    expect(a.pooled).toBeCloseTo(Math.min(1.3, Math.max(1 / 1.3, g / x)), 12);
    const fa = teamFinishing(historyView(src(past), cutoff), 'A', LIGA.id, o, 20, a);
    const fb = teamFinishing(historyView(src([...past, ...future]), cutoff), 'A', LIGA.id, o, 20, a);
    expect(fb).toEqual(fa);
  });
});

describe('variantes shots en el banco', () => {
  const base = runVariant(PRODUCTION_VARIANT, data);
  const infos = matchInfos(base.ctx!);
  const days = (['T1', 'T2'] as const).map((w) => busiestDay(infos, w, base.rows)!);

  it('con w = 1 las predicciones son exactamente las de producción', () => {
    const run = runVariant(makeShotsVariant({ name: 'shots-id', description: 'w = 1', w: 1, finishing: 20 }), data);
    expect(run.rows.size).toBe(base.rows.size);
    for (const [id, b] of base.rows) expect(run.rows.get(id)).toEqual(b);
  });

  it('con w < 1 cambian los λ del Dixon-Coles y no hay fuga (futuro envenenado)', () => {
    for (const v of [
      makeShotsVariant({ name: 'shots-t1', description: 'w 0,5', w: 0.5 }),
      makeShotsVariant({ name: 'shots-t2', description: 'w 0,5 calidad', w: 0.5, finishing: 20 }),
      makeShotsVariant({ name: 'shots-t3', description: 'w 0,5 split', w: 0.5, normalize: 'split' }),
    ]) {
      const run = runVariant(v, data, { reuse: base });
      let changed = 0;
      for (const [id, b] of base.rows) if (Math.abs(run.rows.get(id)!.gp[0] - b.gp[0]) > 1e-6) changed++;
      expect(changed).toBeGreaterThan(50);
      const r = leakCheck(v, data, run, days);
      expect(r.ok).toBe(true);
    }
  });

  it('todas las variantes shots-* del directorio se cargan con el cargador oficial', async () => {
    const names = listVariants().filter((n) => n.startsWith('shots'));
    expect(names.length).toBeGreaterThanOrEqual(5);
    for (const n of names) {
      const v = await loadVariant(n);
      expect(v.name).toBe(n);
      expect(typeof v.dc?.fitGoals).toBe('function');
    }
  });
});
